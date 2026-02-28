from __future__ import annotations

import base64
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .config import settings
from .model_catalog import MODE_TEXT_AND_IMAGE, get_model_spec


class GeminiError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, payload: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.payload = payload or {}


@dataclass
class ReferenceImage:
    mime_type: str
    data: bytes


class GeminiClient:
    def __init__(self) -> None:
        self.base_url = settings.gemini_api_base_url.rstrip("/")

    def generate_image(
        self,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
    ) -> dict[str, Any]:
        if not settings.gemini_api_key:
            raise GeminiError(code="AUTH", message="GEMINI_API_KEY is not configured", retryable=False)

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
        if not spec:
            raise GeminiError(code="INVALID_MODEL", message=f"Unsupported model: {model}", retryable=False)

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

        timeout = params["timeout_sec"]
        url = f"{self.base_url}/models/{model}:generateContent"
        start = time.perf_counter()

        try:
            client_kwargs: dict[str, Any] = {
                "timeout": timeout,
            }
            if settings.gemini_http_proxy:
                client_kwargs["proxy"] = settings.gemini_http_proxy
            with httpx.Client(**client_kwargs) as client:
                resp = client.post(url, params={"key": settings.gemini_api_key}, json=payload)
        except httpx.TimeoutException as exc:
            raise GeminiError(code="UPSTREAM_TIMEOUT", message="Gemini upstream timeout", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise GeminiError(code="UPSTREAM_HTTP", message=f"Gemini HTTP error: {exc}", retryable=True) from exc

        latency_ms = int((time.perf_counter() - start) * 1000)

        if resp.status_code == 429:
            raise GeminiError(code="UPSTREAM_RATE_LIMIT", message="Gemini rate limited", retryable=True, payload=resp.json())
        if resp.status_code >= 500:
            raise GeminiError(code="UPSTREAM_SERVER_ERROR", message="Gemini upstream server error", retryable=True, payload=resp.json())
        if resp.status_code >= 400:
            body = resp.json()
            message = body.get("error", {}).get("message", f"Gemini request failed: HTTP {resp.status_code}")
            raise GeminiError(code="UPSTREAM_BAD_REQUEST", message=message, retryable=False, payload=body)

        data = resp.json()

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

        images: list[dict[str, Any]] = []
        for item in image_parts[: settings.max_images_per_job]:
            mime = item.get("mimeType") or item.get("mime_type") or "image/png"
            raw = base64.b64decode(item["data"])
            images.append({"mime": mime, "bytes": raw})

        return {
            "raw": data,
            "images": images,
            "usage_metadata": data.get("usageMetadata") or data.get("usage_metadata") or {},
            "finish_reason": finish_reason or "OTHER",
            "safety_ratings": safety_ratings,
            "latency_ms": latency_ms,
        }


gemini_client = GeminiClient()
