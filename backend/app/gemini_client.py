from __future__ import annotations

import base64
import hashlib
import io
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx
from PIL import Image, ImageDraw

from .config import settings
from .logging_setup import get_logger
from .model_catalog import (
    MODE_TEXT_AND_IMAGE,
    MODEL_GEMINI_2_5_FLASH_IMAGE,
    MODEL_GEMINI_3_1_FLASH_IMAGE,
    MODEL_GEMINI_3_PRO_IMAGE,
    get_model_spec,
)
from .provider_store import provider_store

logger = get_logger("gemini_client")

_URL_RE = re.compile(r"https?://[^)\s]+")
_DATA_URI_RE = re.compile(r"data:(image/[^;]+);base64,([A-Za-z0-9+/=]+)")
_CI_SLOW_PREFIX_RE = re.compile(r"^\[ci:slow(?::(?P<ms>\d+))?\]")
_TRANSIENT_CODES = {
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_HTTP",
    "UPSTREAM_SERVER_ERROR",
    "UPSTREAM_RATE_LIMIT",
    "UPSTREAM_CLIENT_EXCEPTION",
}


class GeminiError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        retryable: bool = False,
        payload: dict[str, Any] | None = None,
        retry_other_providers: bool = True,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.payload = payload or {}
        self.retry_other_providers = retry_other_providers


@dataclass
class ReferenceImage:
    mime_type: str
    data: bytes


class GeminiClient:
    def _http_client_kwargs(self, timeout: float) -> dict[str, Any]:
        client_kwargs: dict[str, Any] = {
            "timeout": timeout,
            # Upstream proxying must be controlled only via GEMINI_HTTP_PROXY.
            "trust_env": False,
        }
        if settings.gemini_http_proxy:
            client_kwargs["proxy"] = settings.gemini_http_proxy
        return client_kwargs

    def generate_image(
        self,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        spec = get_model_spec(model)
        if not spec:
            raise GeminiError(code="INVALID_MODEL", message=f"Unsupported model: {model}", retryable=False, retry_other_providers=False)
        if settings.test_fake_generator:
            return self._generate_test_fake_image(
                prompt=prompt,
                model=model,
                mode=mode,
                params=params,
                reference_images=reference_images,
                deadline_monotonic=deadline_monotonic,
            )

        requested_provider_id = str(params.get("provider_id") or "").strip() or None
        if requested_provider_id:
            candidate = provider_store.admin_override_candidate(model, requested_provider_id)
            chain = [candidate] if candidate else []
        else:
            chain = provider_store.candidate_chain(model)
        if not chain:
            if requested_provider_id:
                message = f"Selected provider '{requested_provider_id}' is not currently available for model '{model}'"
                payload = {"model": model, "provider_id": requested_provider_id}
            else:
                message = f"No enabled provider is currently available for model '{model}'"
                payload = {"model": model}
            raise GeminiError(
                code="NO_PROVIDER_AVAILABLE",
                message=message,
                retryable=False,
                payload=payload,
            )

        attempts: list[dict[str, Any]] = []
        last_error: GeminiError | None = None

        for candidate in chain:
            try:
                self._ensure_within_deadline(
                    deadline_monotonic,
                    configured_timeout_sec=params.get("timeout_sec"),
                    provider_id=str(candidate.get("provider_id") or ""),
                )
            except GeminiError as exc:
                last_error = exc
                break
            provider_id = str(candidate["provider_id"])
            provider_store.record_selection(provider_id)
            selection_mode = str(candidate.get("selection_mode") or "standard")
            selection_reason = str(candidate.get("selection_reason") or selection_mode)
            forced_activation = bool(candidate.get("forced_activation"))
            if selection_mode != "standard" or forced_activation:
                provider_store.record_forced_activation(
                    provider_id,
                    reason=selection_reason,
                    selection_mode=selection_mode,
                )
            provider_store.acquire_slot(provider_id)
            started = time.perf_counter()
            try:
                config = provider_store.get_provider_config(provider_id)
                if config is None:
                    raise GeminiError(code="NO_PROVIDER_CONFIG", message=f"Provider '{provider_id}' is not configured", retryable=False)
                logger.info(
                    "Provider request: provider=%s adapter=%s model=%s mode=%s timeout_sec=%s refs=%s",
                    provider_id,
                    config.adapter_type,
                    model,
                    mode,
                    params.get("timeout_sec"),
                    len(reference_images),
                )
                output = self._call_provider(
                    config=config,
                    prompt=prompt,
                    model=model,
                    mode=mode,
                    params=params,
                    reference_images=reference_images,
                    deadline_monotonic=deadline_monotonic,
                )
                latency_ms = int(output.get("latency_ms") or max(0, int((time.perf_counter() - started) * 1000)))
                cost_cny = max(0.0, float(config.cost_per_image_cny) * max(1, len(output.get("images") or [])))
                provider_store.record_success(
                    provider_id,
                    latency_ms=latency_ms,
                    image_count=len(output.get("images") or []),
                    cost_cny=cost_cny,
                )
                output["provider"] = {
                    "provider_id": provider_id,
                    "label": config.label,
                    "adapter_type": config.adapter_type,
                    "base_url": config.base_url,
                    "cost_per_image_cny": round(float(config.cost_per_image_cny), 4),
                    "selection_mode": selection_mode,
                    "forced_activation": forced_activation,
                }
                if attempts:
                    output["provider_attempts"] = attempts
                return output
            except GeminiError as exc:
                latency_ms = max(0, int((time.perf_counter() - started) * 1000))
                snapshot = provider_store.get_provider_snapshot(provider_id) or {}
                next_consecutive = int(snapshot.get("consecutive_failures") or 0) + 1
                quota_exceeded = exc.code == "UPSTREAM_NO_QUOTA"
                open_circuit = quota_exceeded or (exc.code in _TRANSIENT_CODES and next_consecutive >= 3)
                provider_store.record_failure(
                    provider_id,
                    error_code=exc.code,
                    latency_ms=latency_ms,
                    quota_exceeded=quota_exceeded,
                    open_circuit=open_circuit,
                )
                attempt_payload = {
                    "provider_id": provider_id,
                    "adapter_type": snapshot.get("adapter_type"),
                    "latency_ms": latency_ms,
                    "error_code": exc.code,
                    "message": exc.message,
                    "retryable": exc.retryable,
                    "selection_mode": selection_mode,
                    "forced_activation": forced_activation,
                }
                attempts.append(attempt_payload)
                logger.warning(
                    "Provider request failed: provider=%s model=%s code=%s retryable=%s retry_other=%s message=%s",
                    provider_id,
                    model,
                    exc.code,
                    exc.retryable,
                    exc.retry_other_providers,
                    exc.message,
                )
                last_error = exc
                if not exc.retry_other_providers:
                    break
            finally:
                provider_store.release_slot(provider_id)

        if last_error is None:
            raise GeminiError(code="UPSTREAM_ERROR", message="All providers failed", retryable=False, payload={"attempts": attempts})
        raise GeminiError(
            code=last_error.code,
            message=last_error.message,
            retryable=last_error.retryable,
            payload={**last_error.payload, "attempts": attempts},
            retry_other_providers=last_error.retry_other_providers,
        )

    def _generate_test_fake_image(
        self,
        *,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        stripped_prompt = prompt.lstrip()
        if stripped_prompt.startswith("[ci:fail]"):
            raise GeminiError(
                code="UPSTREAM_ERROR",
                message="CI fake generator requested a deterministic failure",
                retryable=False,
                retry_other_providers=False,
            )

        slow_match = _CI_SLOW_PREFIX_RE.match(stripped_prompt)
        if slow_match:
            requested_ms = int(slow_match.group("ms") or 1500)
            if deadline_monotonic is not None and deadline_monotonic <= time.monotonic():
                raise GeminiError(
                    code="UPSTREAM_TIMEOUT",
                    message="CI fake generator timed out before work started",
                    retryable=True,
                )
            time.sleep(max(requested_ms, 0) / 1000)

        started = time.perf_counter()
        digest = hashlib.sha256(f"{prompt}|{model}|{mode}|{len(reference_images)}".encode("utf-8")).digest()
        background = tuple(64 + (value % 128) for value in digest[:3])
        accent = tuple(96 + (value % 96) for value in digest[3:6])

        image = Image.new("RGB", (512, 512), background)
        draw = ImageDraw.Draw(image)
        draw.rectangle((48, 48, 464, 464), outline=accent, width=18)
        draw.rectangle((96, 96, 416, 176), fill=accent)
        for idx in range(max(1, len(reference_images))):
            top = 228 + idx * 46
            draw.rectangle((96, top, 416, top + 20), fill=accent[::-1])

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        image_bytes = buf.getvalue()
        inline_data = base64.b64encode(image_bytes).decode("ascii")

        requested_provider_id = str(params.get("provider_id") or "").strip() or None
        latency_ms = max(int(settings.test_fake_generator_latency_ms), int((time.perf_counter() - started) * 1000))
        prompt_token_count = max(8, len(prompt.strip()) // 2)
        reference_token_count = len(reference_images) * 12
        total_token_count = prompt_token_count + reference_token_count + 24

        return {
            "raw": {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "inlineData": {
                                        "mimeType": "image/png",
                                        "data": inline_data,
                                    }
                                }
                            ]
                        }
                    }
                ]
            },
            "images": [{"mime": "image/png", "bytes": image_bytes}],
            "usage_metadata": {
                "promptTokenCount": prompt_token_count,
                "cachedContentTokenCount": 0,
                "candidatesTokenCount": 12,
                "thoughtsTokenCount": reference_token_count,
                "totalTokenCount": total_token_count,
            },
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": latency_ms,
            "provider": {
                "provider_id": requested_provider_id or "ci-fake",
                "label": "CI Fake Generator",
                "adapter_type": "ci_fake",
                "base_url": "test://ci-fake-generator",
                "cost_per_image_cny": 0.0,
                "selection_mode": "admin_override" if requested_provider_id else "test_fake_generator",
                "forced_activation": bool(requested_provider_id),
            },
            "provider_attempts": [],
            "upstream_model": f"ci-fake::{model}",
            "upstream_response_model": f"ci-fake::{model}",
        }

    def _call_provider(
        self,
        *,
        config: Any,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        if config.adapter_type == "gemini_v1beta":
            return self._call_gemini_v1beta(
                config=config,
                prompt=prompt,
                model=model,
                mode=mode,
                params=params,
                reference_images=reference_images,
                deadline_monotonic=deadline_monotonic,
            )
        if config.adapter_type == "openai_chat_image":
            return self._call_openai_chat_image(
                config=config,
                prompt=prompt,
                model=model,
                mode=mode,
                params=params,
                reference_images=reference_images,
                deadline_monotonic=deadline_monotonic,
            )
        if config.adapter_type == "mmw_openai_chat_image":
            return self._call_mmw_openai_chat_image(
                config=config,
                prompt=prompt,
                model=model,
                mode=mode,
                params=params,
                reference_images=reference_images,
                deadline_monotonic=deadline_monotonic,
            )
        if config.adapter_type == "novart_gemini_image":
            return self._call_novart_gemini_image(
                config=config,
                prompt=prompt,
                model=model,
                mode=mode,
                params=params,
                reference_images=reference_images,
                deadline_monotonic=deadline_monotonic,
            )
        raise GeminiError(
            code="UNSUPPORTED_ADAPTER",
            message=f"Unsupported adapter_type '{config.adapter_type}' for provider '{config.provider_id}'",
            retryable=False,
        )

    def _call_gemini_v1beta(
        self,
        *,
        config: Any,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        upstream_model = self._resolve_gemini_upstream_model(model)
        if upstream_model is None:
            raise GeminiError(
                code="UPSTREAM_MODEL_UNAVAILABLE",
                message=f"Provider '{config.provider_id}' does not support model '{model}'",
                retryable=False,
            )

        parts: list[dict[str, Any]] = [{"text": prompt}]
        for ref in reference_images:
            parts.append(
                {
                    "inlineData": {
                        "mimeType": ref.mime_type,
                        "data": base64.b64encode(ref.data).decode("utf-8"),
                    }
                }
            )

        spec = get_model_spec(model)
        if spec is None:
            raise GeminiError(code="INVALID_MODEL", message=f"Unsupported model: {model}", retryable=False, retry_other_providers=False)

        response_modalities = ["IMAGE"]
        if mode == MODE_TEXT_AND_IMAGE and spec.supports_text_output:
            response_modalities = ["TEXT", "IMAGE"]

        image_config: dict[str, Any] = {"aspectRatio": params["aspect_ratio"]}
        image_size = params.get("image_size")
        if spec.supports_image_size and image_size and image_size != "AUTO":
            image_config["imageSize"] = image_size

        payload = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "responseModalities": response_modalities,
                "temperature": params["temperature"],
                "imageConfig": image_config,
            },
        }
        thinking_level = params.get("thinking_level")
        if spec.supports_thinking_level and thinking_level:
            payload["generationConfig"]["thinkingConfig"] = {"thinkingLevel": thinking_level}

        timeout, deadline_capped = self._effective_timeout_sec(
            params["timeout_sec"],
            deadline_monotonic=deadline_monotonic,
            configured_timeout_sec=params.get("timeout_sec"),
            provider_id=config.provider_id,
        )
        url = f"{config.base_url.rstrip('/')}/models/{upstream_model}:generateContent"
        start = time.perf_counter()
        try:
            with httpx.Client(**self._http_client_kwargs(timeout)) as client:
                resp = client.post(url, params={"key": config.api_key}, json=payload)
        except httpx.TimeoutException as exc:
            if deadline_capped:
                raise GeminiError(
                    code="WORKER_WATCHDOG_TIMEOUT",
                    message="Job exceeded maximum runtime while waiting for Gemini upstream response",
                    retryable=False,
                    payload={
                        "provider_id": config.provider_id,
                        "configured_timeout_sec": int(params.get("timeout_sec", settings.job_timeout_sec_default)),
                        "effective_timeout_sec": round(timeout, 3),
                    },
                    retry_other_providers=False,
                ) from exc
            raise GeminiError(code="UPSTREAM_TIMEOUT", message="Gemini upstream timeout", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise GeminiError(code="UPSTREAM_HTTP", message=f"Gemini HTTP error: {exc}", retryable=True) from exc
        except Exception as exc:  # noqa: BLE001
            raise GeminiError(
                code="UPSTREAM_CLIENT_EXCEPTION",
                message=f"Unexpected Gemini client error: {type(exc).__name__}: {exc}",
                retryable=True,
                payload={"exception_type": type(exc).__name__, "exception": str(exc)},
            ) from exc

        latency_ms = int((time.perf_counter() - start) * 1000)
        data = self._safe_json_response(resp, provider_id=config.provider_id, model=upstream_model)
        self._raise_for_status(
            status_code=resp.status_code,
            body=data,
            provider_id=config.provider_id,
            upstream_model=upstream_model,
        )

        candidates = data.get("candidates", [])
        image_parts: list[dict[str, Any]] = []
        finish_reason = None
        safety_ratings: list[dict[str, Any]] = []

        for cand in candidates:
            finish_reason = finish_reason or cand.get("finishReason") or cand.get("finish_reason")
            if cand.get("safetyRatings"):
                safety_ratings.extend(cand["safetyRatings"])
            if cand.get("safety_ratings"):
                safety_ratings.extend(cand["safety_ratings"])
            content = cand.get("content", {})
            for part in content.get("parts", []):
                inline = part.get("inlineData") or part.get("inline_data")
                if inline and inline.get("data"):
                    image_parts.append(inline)

        if not image_parts:
            raise GeminiError(
                code="NO_IMAGE_PART",
                message="Model response has no inline image part",
                retryable=False,
                payload={"response": data},
            )

        images = [
            {
                "mime": item.get("mimeType") or item.get("mime_type") or "image/png",
                "bytes": base64.b64decode(item["data"]),
            }
            for item in image_parts[: settings.max_images_per_job]
        ]

        return {
            "raw": data,
            "images": images,
            "usage_metadata": data.get("usageMetadata") or data.get("usage_metadata") or {},
            "finish_reason": finish_reason or "OTHER",
            "safety_ratings": safety_ratings,
            "latency_ms": latency_ms,
            "upstream_model": upstream_model,
        }

    def _call_novart_gemini_image(
        self,
        *,
        config: Any,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        upstream_model = self._resolve_novart_upstream_model(model)
        if upstream_model is None:
            raise GeminiError(
                code="UPSTREAM_MODEL_UNAVAILABLE",
                message=f"Provider '{config.provider_id}' does not support model '{model}'",
                retryable=False,
            )

        parts: list[dict[str, Any]] = [{"text": prompt}]
        for ref in reference_images:
            parts.append(
                {
                    "inlineData": {
                        "mimeType": ref.mime_type,
                        "data": base64.b64encode(ref.data).decode("utf-8"),
                    }
                }
            )

        payload = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                # NOVART documents TEXT+IMAGE even for image generation and returns
                # a short text part before inlineData.
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {
                    "aspectRatio": params["aspect_ratio"],
                    "novartResolution": self._novart_resolution(params.get("image_size")),
                },
                "novart": {"includeResultUrls": True},
            },
        }

        timeout, deadline_capped = self._effective_timeout_sec(
            params["timeout_sec"],
            deadline_monotonic=deadline_monotonic,
            configured_timeout_sec=params.get("timeout_sec"),
            provider_id=config.provider_id,
        )
        url = f"{self._novart_v1beta_base_url(config.base_url)}/models/{upstream_model}:generateContent"
        start = time.perf_counter()
        try:
            with httpx.Client(**self._http_client_kwargs(timeout)) as client:
                resp = client.post(
                    url,
                    headers={
                        "x-goog-api-key": config.api_key,
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            if deadline_capped:
                raise GeminiError(
                    code="WORKER_WATCHDOG_TIMEOUT",
                    message="Job exceeded maximum runtime while waiting for NOVART upstream response",
                    retryable=False,
                    payload={
                        "provider_id": config.provider_id,
                        "configured_timeout_sec": int(params.get("timeout_sec", settings.job_timeout_sec_default)),
                        "effective_timeout_sec": round(timeout, 3),
                    },
                    retry_other_providers=False,
                ) from exc
            raise GeminiError(code="UPSTREAM_TIMEOUT", message="NOVART upstream timeout", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise GeminiError(code="UPSTREAM_HTTP", message=f"NOVART HTTP error: {exc}", retryable=True) from exc
        except Exception as exc:  # noqa: BLE001
            raise GeminiError(
                code="UPSTREAM_CLIENT_EXCEPTION",
                message=f"Unexpected NOVART client error: {type(exc).__name__}: {exc}",
                retryable=True,
                payload={"exception_type": type(exc).__name__, "exception": str(exc)},
            ) from exc

        latency_ms = int((time.perf_counter() - start) * 1000)
        data = self._safe_json_response(resp, provider_id=config.provider_id, model=upstream_model)
        self._raise_for_status(
            status_code=resp.status_code,
            body=data,
            provider_id=config.provider_id,
            upstream_model=upstream_model,
        )

        candidates = data.get("candidates", [])
        image_parts: list[dict[str, Any]] = []
        finish_reason = None
        safety_ratings: list[dict[str, Any]] = []

        for cand in candidates:
            finish_reason = finish_reason or cand.get("finishReason") or cand.get("finish_reason")
            if cand.get("safetyRatings"):
                safety_ratings.extend(cand["safetyRatings"])
            if cand.get("safety_ratings"):
                safety_ratings.extend(cand["safety_ratings"])
            content = cand.get("content", {})
            for part in content.get("parts", []):
                inline = part.get("inlineData") or part.get("inline_data")
                if inline and inline.get("data"):
                    image_parts.append(inline)

        if not image_parts:
            raise GeminiError(
                code="NO_IMAGE_PART",
                message="NOVART response has no inline image part",
                retryable=False,
                payload={"response": data},
            )

        images = [
            {
                "mime": item.get("mimeType") or item.get("mime_type") or "image/png",
                "bytes": base64.b64decode(item["data"]),
            }
            for item in image_parts[: settings.max_images_per_job]
        ]

        return {
            "raw": data,
            "images": images,
            "usage_metadata": data.get("usageMetadata") or data.get("usage_metadata") or {},
            "finish_reason": finish_reason or "OTHER",
            "safety_ratings": safety_ratings,
            "latency_ms": latency_ms,
            "upstream_model": upstream_model,
            "upstream_response_model": data.get("modelVersion") or data.get("model_version"),
        }

    def _call_openai_chat_image(
        self,
        *,
        config: Any,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        return self._call_openai_chat_image_common(
            config=config,
            prompt=prompt,
            model=model,
            mode=mode,
            params=params,
            reference_images=reference_images,
            deadline_monotonic=deadline_monotonic,
            provider_profile="generic",
        )

    def _call_mmw_openai_chat_image(
        self,
        *,
        config: Any,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        return self._call_openai_chat_image_common(
            config=config,
            prompt=prompt,
            model=model,
            mode=mode,
            params=params,
            reference_images=reference_images,
            deadline_monotonic=deadline_monotonic,
            provider_profile="mmw",
        )

    def _call_openai_chat_image_common(
        self,
        *,
        config: Any,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
        deadline_monotonic: float | None = None,
        provider_profile: str,
    ) -> dict[str, Any]:
        upstream_model = self._resolve_openai_upstream_model(model, params, provider_profile=provider_profile)
        if upstream_model is None:
            raise GeminiError(
                code="UPSTREAM_MODEL_UNAVAILABLE",
                message=f"Provider '{config.provider_id}' does not support model '{model}'",
                retryable=False,
            )

        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for ref in reference_images:
            data_uri = f"data:{ref.mime_type};base64,{base64.b64encode(ref.data).decode('ascii')}"
            content.append({"type": "image_url", "image_url": {"url": data_uri}})

        payload = {
            "model": upstream_model,
            "messages": [{"role": "user", "content": content}],
            "temperature": params.get("temperature", 0.7),
            "stream": False,
        }
        url = self._openai_endpoint(config.base_url, "chat/completions")
        timeout, deadline_capped = self._effective_timeout_sec(
            params["timeout_sec"],
            deadline_monotonic=deadline_monotonic,
            configured_timeout_sec=params.get("timeout_sec"),
            provider_id=config.provider_id,
        )
        start = time.perf_counter()

        try:
            with httpx.Client(**self._http_client_kwargs(timeout)) as client:
                resp = client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {config.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            if deadline_capped:
                raise GeminiError(
                    code="WORKER_WATCHDOG_TIMEOUT",
                    message="Job exceeded maximum runtime while waiting for provider response",
                    retryable=False,
                    payload={
                        "provider_id": config.provider_id,
                        "configured_timeout_sec": int(params.get("timeout_sec", settings.job_timeout_sec_default)),
                        "effective_timeout_sec": round(timeout, 3),
                    },
                    retry_other_providers=False,
                ) from exc
            raise GeminiError(code="UPSTREAM_TIMEOUT", message="OpenAI-compatible upstream timeout", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise GeminiError(code="UPSTREAM_HTTP", message=f"OpenAI-compatible HTTP error: {exc}", retryable=True) from exc
        except Exception as exc:  # noqa: BLE001
            raise GeminiError(
                code="UPSTREAM_CLIENT_EXCEPTION",
                message=f"Unexpected provider client error: {type(exc).__name__}: {exc}",
                retryable=True,
                payload={"exception_type": type(exc).__name__, "exception": str(exc)},
            ) from exc

        latency_ms = int((time.perf_counter() - start) * 1000)
        data = self._safe_json_response(resp, provider_id=config.provider_id, model=upstream_model)
        self._raise_for_status(
            status_code=resp.status_code,
            body=data,
            provider_id=config.provider_id,
            upstream_model=upstream_model,
        )

        choice = ((data.get("choices") or [{}])[0]) if isinstance(data, dict) else {}
        message = choice.get("message") if isinstance(choice, dict) else {}
        raw_content = (message or {}).get("content") if isinstance(message, dict) else ""
        content_str = raw_content if isinstance(raw_content, str) else str(raw_content)

        images: list[dict[str, Any]] = []
        for mime, b64_data in _DATA_URI_RE.findall(content_str):
            images.append({"mime": mime, "bytes": base64.b64decode(b64_data)})
            if len(images) >= settings.max_images_per_job:
                break

        if len(images) < settings.max_images_per_job:
            download_timeout, _ = self._effective_timeout_sec(
                30,
                deadline_monotonic=deadline_monotonic,
                configured_timeout_sec=params.get("timeout_sec"),
                provider_id=config.provider_id,
            )
            with httpx.Client(**self._http_client_kwargs(download_timeout)) as client:
                for url_match in _URL_RE.findall(content_str):
                    if len(images) >= settings.max_images_per_job:
                        break
                    img_resp = client.get(url_match)
                    if img_resp.status_code >= 400:
                        continue
                    images.append(
                        {
                            "mime": img_resp.headers.get("content-type") or "image/jpeg",
                            "bytes": img_resp.content,
                        }
                    )

        if not images:
            raise GeminiError(
                code="NO_IMAGE_PART",
                message="OpenAI-compatible response has no image payload",
                retryable=False,
                payload={"response": data},
            )

        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        usage_metadata = {
            "promptTokenCount": int(usage.get("prompt_tokens") or 0),
            "candidatesTokenCount": int(usage.get("completion_tokens") or 0),
            "totalTokenCount": int(usage.get("total_tokens") or 0),
        }
        response_model = data.get("model") if isinstance(data, dict) else None

        return {
            "raw": data,
            "images": images,
            "usage_metadata": usage_metadata,
            "finish_reason": choice.get("finish_reason") if isinstance(choice, dict) else "OTHER",
            "safety_ratings": [],
            "latency_ms": latency_ms,
            "upstream_model": upstream_model,
            "upstream_response_model": response_model,
            "raw_text": content_str[:1000],
        }

    def _safe_json_response(self, resp: httpx.Response, *, provider_id: str, model: str) -> dict[str, Any]:
        try:
            data = resp.json()
            return data if isinstance(data, dict) else {"raw": data}
        except Exception:
            snippet = (resp.text or "")[:1000]
            logger.warning(
                "Provider non-JSON response: provider=%s model=%s status=%s snippet=%s",
                provider_id,
                model,
                resp.status_code,
                snippet,
            )
            return {"raw_text_snippet": snippet}

    def _ensure_within_deadline(
        self,
        deadline_monotonic: float | None,
        *,
        configured_timeout_sec: Any,
        provider_id: str | None = None,
    ) -> None:
        if deadline_monotonic is None:
            return
        remaining_sec = deadline_monotonic - time.monotonic()
        if remaining_sec > 0:
            return
        payload = {
            "configured_timeout_sec": int(configured_timeout_sec or settings.job_timeout_sec_default),
            "effective_timeout_sec": 0,
        }
        if provider_id:
            payload["provider_id"] = provider_id
        raise GeminiError(
            code="WORKER_WATCHDOG_TIMEOUT",
            message="Job exceeded maximum runtime before the next provider attempt could start",
            retryable=False,
            payload=payload,
            retry_other_providers=False,
        )

    def _effective_timeout_sec(
        self,
        requested_timeout_sec: Any,
        *,
        deadline_monotonic: float | None,
        configured_timeout_sec: Any,
        provider_id: str | None = None,
    ) -> tuple[float, bool]:
        requested = max(float(requested_timeout_sec), 0.001)
        if deadline_monotonic is None:
            return requested, False
        remaining_sec = deadline_monotonic - time.monotonic()
        if remaining_sec <= 0:
            self._ensure_within_deadline(
                deadline_monotonic,
                configured_timeout_sec=configured_timeout_sec,
                provider_id=provider_id,
            )
        return max(min(requested, remaining_sec), 0.001), remaining_sec < requested

    def _raise_for_status(self, *, status_code: int, body: dict[str, Any], provider_id: str, upstream_model: str) -> None:
        message = self._extract_error_message(body, fallback=f"Provider request failed: HTTP {status_code}")
        upper_message = message.upper()
        if status_code == 429:
            raise GeminiError(
                code="UPSTREAM_RATE_LIMIT",
                message=message or "Provider rate limited",
                retryable=True,
                payload=body,
            )
        if status_code >= 500:
            if self._looks_like_model_unavailable(message):
                raise GeminiError(
                    code="UPSTREAM_MODEL_UNAVAILABLE",
                    message=message,
                    retryable=False,
                    payload=body,
                )
            raise GeminiError(
                code="UPSTREAM_SERVER_ERROR",
                message=f"{message} (provider={provider_id}, model={upstream_model})",
                retryable=True,
                payload=body,
            )
        if status_code >= 400:
            if self._looks_like_no_quota(message):
                raise GeminiError(
                    code="UPSTREAM_NO_QUOTA",
                    message=message,
                    retryable=False,
                    payload=body,
                )
            if self._looks_like_model_unavailable(message):
                raise GeminiError(
                    code="UPSTREAM_MODEL_UNAVAILABLE",
                    message=message,
                    retryable=False,
                    payload=body,
                )
            if "INVALID" in upper_message or "UNSUPPORTED" in upper_message:
                raise GeminiError(
                    code="UPSTREAM_INVALID_REQUEST",
                    message=message,
                    retryable=False,
                    payload=body,
                    retry_other_providers=False,
                )
            if "SAFETY" in upper_message or "POLICY" in upper_message or "BLOCKED" in upper_message:
                raise GeminiError(
                    code="UPSTREAM_POLICY_BLOCK",
                    message=message,
                    retryable=False,
                    payload=body,
                    retry_other_providers=False,
                )
            raise GeminiError(
                code="UPSTREAM_BAD_REQUEST",
                message=message,
                retryable=False,
                payload=body,
            )

    def _extract_error_message(self, body: dict[str, Any], fallback: str) -> str:
        error = body.get("error") if isinstance(body.get("error"), dict) else {}
        message = error.get("message") or body.get("message")
        code = error.get("code") or body.get("code")
        if code and message:
            return f"{message} ({code})"
        return str(message or fallback)

    def _looks_like_no_quota(self, message: str) -> bool:
        upper = message.upper()
        return any(token in upper for token in ("QUOTA", "BALANCE", "INSUFFICIENT", "余额", "额度", "NO_QUOTA"))

    def _looks_like_model_unavailable(self, message: str) -> bool:
        upper = message.upper()
        return any(
            token in upper
            for token in ("MODEL_NOT_FOUND", "NO AVAILABLE CHANNEL", "UNSUPPORTED MODEL", "MODEL NOT FOUND", "无可用渠道", "模型不存在")
        )

    def _resolve_gemini_upstream_model(self, canonical_model: str) -> str | None:
        if canonical_model == MODEL_GEMINI_3_PRO_IMAGE:
            return "gemini-3-pro-image-preview"
        if canonical_model == MODEL_GEMINI_2_5_FLASH_IMAGE:
            return "gemini-2.5-flash-image"
        if canonical_model == MODEL_GEMINI_3_1_FLASH_IMAGE:
            return "gemini-3.1-flash-image-preview"
        return None

    def _resolve_novart_upstream_model(self, canonical_model: str) -> str | None:
        if canonical_model == MODEL_GEMINI_3_PRO_IMAGE:
            return "nova-image-pro"
        if canonical_model in {MODEL_GEMINI_2_5_FLASH_IMAGE, MODEL_GEMINI_3_1_FLASH_IMAGE}:
            return "nova-image-2"
        return None

    def _novart_resolution(self, image_size: Any) -> str:
        normalized = str(image_size or "").strip().upper()
        if normalized == "4K":
            return "4k"
        if normalized == "2K":
            return "2k"
        return "1k"

    def _novart_v1beta_base_url(self, base_url: str) -> str:
        trimmed = base_url.rstrip("/")
        if trimmed.endswith("/v1beta"):
            return trimmed
        return f"{trimmed}/v1beta"

    def _resolve_openai_upstream_model(
        self,
        canonical_model: str,
        params: dict[str, Any],
        *,
        provider_profile: str = "generic",
    ) -> str | None:
        if provider_profile == "mmw":
            return self._resolve_mmw_openai_upstream_model(canonical_model, params)

        image_size = str(params.get("image_size") or "").upper()
        if canonical_model == MODEL_GEMINI_2_5_FLASH_IMAGE:
            return "gemini-2.5-flash-image-2k"
        if canonical_model == MODEL_GEMINI_3_1_FLASH_IMAGE:
            if image_size == "4K":
                return "gemini-3.1-flash-image-4k"
            if image_size == "2K":
                return "gemini-3.1-flash-image-2k"
            return "gemini-3.1-flash-image"
        if canonical_model == MODEL_GEMINI_3_PRO_IMAGE:
            if image_size == "4K":
                return "[A]gemini-3-pro-image-preview-4k"
            if image_size == "2K":
                return "[A]gemini-3-pro-image-preview-2k"
            return "[A]gemini-3-pro-image-preview"
        return None

    def _resolve_mmw_openai_upstream_model(self, canonical_model: str, params: dict[str, Any]) -> str | None:
        image_size = str(params.get("image_size") or "").upper()
        if canonical_model == MODEL_GEMINI_2_5_FLASH_IMAGE:
            if image_size == "4K":
                return "gemini-2.5-flash-image-4k"
            return "gemini-2.5-flash-image-2k"
        if canonical_model == MODEL_GEMINI_3_1_FLASH_IMAGE:
            if image_size == "4K":
                return "gemini-3.1-flash-image-4k"
            if image_size == "2K":
                return "gemini-3.1-flash-image-2k"
            return "gemini-3.1-flash-image"
        if canonical_model == MODEL_GEMINI_3_PRO_IMAGE:
            if image_size == "4K":
                return "[A]gemini-3-pro-image-preview-4k"
            if image_size == "2K":
                return "[A]gemini-3-pro-image-preview-2k"
            return "[A]gemini-3-pro-image-preview"
        return None

    def _openai_endpoint(self, base_url: str, path: str) -> str:
        trimmed = base_url.rstrip("/")
        if trimmed.endswith("/v1"):
            return f"{trimmed}/{path}"
        return f"{trimmed}/v1/{path}"


gemini_client = GeminiClient()
