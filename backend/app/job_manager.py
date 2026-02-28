from __future__ import annotations

import hashlib
import io
import queue
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .billing import estimate_job_cost, normalize_usage
from .config import settings
from .errors import api_error
from .gemini_client import GeminiError, ReferenceImage, gemini_client
from .model_catalog import MODE_TEXT_AND_IMAGE, get_model_spec, normalize_params_for_model
from .schemas import CreateJobRequest, ErrorCode, JobParams, JobStatus
from .security import hash_token, new_job_access_token, new_job_id, validate_job_id, verify_token
from .storage import storage


@dataclass
class IdempotencyRecord:
    job_id: str
    job_access_token: str | None
    created_ts: float


class JobManager:
    def __init__(self) -> None:
        self._queue: queue.Queue[str] = queue.Queue(maxsize=settings.job_queue_max)
        self._stop_event = threading.Event()
        self._workers: list[threading.Thread] = []
        self._idempotency_lock = threading.Lock()
        self._idempotency: dict[str, IdempotencyRecord] = {}

    def start(self) -> None:
        if self._workers:
            return
        for idx in range(settings.job_workers):
            t = threading.Thread(target=self._worker_loop, name=f"job-worker-{idx}", daemon=True)
            t.start()
            self._workers.append(t)

    def stop(self) -> None:
        self._stop_event.set()
        for _ in self._workers:
            self._queue.put_nowait("__STOP__")
        for t in self._workers:
            t.join(timeout=1)
        self._workers.clear()
        self._stop_event.clear()

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                job_id = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue

            if job_id == "__STOP__":
                return

            try:
                self._run_job(job_id)
            finally:
                self._queue.task_done()

    def _utcnow(self) -> datetime:
        return datetime.now(timezone.utc)

    def _parse_iso_dt(self, value: Any) -> datetime | None:
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    def _hydrate_running_timing(self, meta: dict[str, Any], started_at: datetime) -> None:
        timing = meta.get("timing") if isinstance(meta.get("timing"), dict) else {}
        queued_at_iso = str(timing.get("queued_at") or meta.get("created_at") or started_at.isoformat())
        queued_at_dt = self._parse_iso_dt(queued_at_iso)
        queue_wait_ms = None
        if queued_at_dt is not None:
            queue_wait_ms = max(0, int((started_at - queued_at_dt).total_seconds() * 1000))

        timing.update(
            {
                "queued_at": queued_at_iso,
                "started_at": started_at.isoformat(),
                "finished_at": None,
                "queue_wait_ms": queue_wait_ms,
                "run_duration_ms": None,
            }
        )
        meta["timing"] = timing

    def _hydrate_finished_timing(self, meta: dict[str, Any], finished_at: datetime, upstream_latency_ms: Any = None) -> None:
        timing = meta.get("timing") if isinstance(meta.get("timing"), dict) else {}
        queued_at_iso = str(timing.get("queued_at") or meta.get("created_at") or finished_at.isoformat())
        started_at_dt = self._parse_iso_dt(timing.get("started_at"))
        if started_at_dt is None:
            started_at_dt = self._parse_iso_dt(meta.get("updated_at")) or finished_at
        queued_at_dt = self._parse_iso_dt(queued_at_iso)

        queue_wait_ms = None
        if queued_at_dt is not None:
            queue_wait_ms = max(0, int((started_at_dt - queued_at_dt).total_seconds() * 1000))
        run_duration_ms = max(0, int((finished_at - started_at_dt).total_seconds() * 1000))

        timing.update(
            {
                "queued_at": queued_at_iso,
                "started_at": started_at_dt.isoformat(),
                "finished_at": finished_at.isoformat(),
                "queue_wait_ms": queue_wait_ms,
                "run_duration_ms": run_duration_ms,
            }
        )
        if isinstance(upstream_latency_ms, (int, float)):
            timing["upstream_latency_ms"] = max(0, int(upstream_latency_ms))
        meta["timing"] = timing

    def _load_or_404(self, job_id: str) -> dict[str, Any]:
        if not validate_job_id(job_id):
            raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
        if not storage.job_exists(job_id):
            raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
        return storage.load_meta(job_id)

    def _check_job_token(self, meta: dict[str, Any], token: str | None) -> None:
        if settings.job_auth_mode != "TOKEN":
            return
        token_hash = meta.get("auth", {}).get("token_hash")
        if not token_hash or not token or not verify_token(token, token_hash):
            raise api_error(ErrorCode.JOB_TOKEN_INVALID, "Invalid job token", http_status=403)

    def get_meta(self, job_id: str, token: str | None) -> dict[str, Any]:
        meta = self._load_or_404(job_id)
        self._check_job_token(meta, token)
        return meta

    def get_request(self, job_id: str, token: str | None) -> dict[str, Any]:
        meta = self._load_or_404(job_id)
        self._check_job_token(meta, token)
        return storage.load_request(job_id)

    def get_response(self, job_id: str, token: str | None) -> dict[str, Any]:
        meta = self._load_or_404(job_id)
        self._check_job_token(meta, token)
        return storage.load_response(job_id)

    def get_image(self, job_id: str, token: str | None, image_id: str) -> tuple[bytes, str]:
        meta = self._load_or_404(job_id)
        self._check_job_token(meta, token)

        for image in meta.get("result", {}).get("images", []):
            if image.get("image_id") == image_id:
                return storage.load_result_image(job_id, image["filename"]), image.get("mime", "image/png")
        raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Image not found", http_status=404)

    def delete_job(self, job_id: str, token: str | None) -> None:
        meta = self._load_or_404(job_id)
        self._check_job_token(meta, token)
        storage.delete_job(job_id)

    def _clean_idempotency(self) -> None:
        now = time.time()
        ttl = settings.idempotency_ttl_sec
        expired = [k for k, v in self._idempotency.items() if now - v.created_ts > ttl]
        for key in expired:
            del self._idempotency[key]

    def _canonical_request_payload(
        self,
        req: CreateJobRequest,
        reference_paths: list[dict[str, str]],
    ) -> dict[str, Any]:
        spec = get_model_spec(req.model)
        response_modalities = ["Image"]
        if req.mode == MODE_TEXT_AND_IMAGE and spec and spec.supports_text_output:
            response_modalities = ["Text", "Image"]

        image_config: dict[str, Any] = {
            "aspect_ratio": req.params.aspect_ratio,
        }
        if spec and spec.supports_image_size and req.params.image_size and req.params.image_size != "AUTO":
            image_config["image_size"] = req.params.image_size

        generation_config: dict[str, Any] = {
            "response_modalities": response_modalities,
            "temperature": req.params.temperature,
            "image_config": image_config,
        }
        if spec and spec.supports_thinking_level and req.params.thinking_level:
            generation_config["thinking_config"] = {"thinking_level": req.params.thinking_level}

        return {
            "prompt": req.prompt,
            "model": req.model,
            "negative_prompt": None,
            "generation_config": generation_config,
            "reference_images": reference_paths,
        }

    def create_job(
        self,
        req: CreateJobRequest,
        reference_images: list[ReferenceImage],
        idempotency_key: str | None = None,
    ) -> tuple[str, str | None, JobStatus, datetime]:
        if len(reference_images) > settings.max_reference_images:
            raise api_error(
                ErrorCode.INVALID_INPUT,
                f"Too many reference images. max={settings.max_reference_images}",
                http_status=400,
            )

        spec = get_model_spec(req.model)
        if not spec:
            raise api_error(ErrorCode.INVALID_INPUT, f"Unsupported model: {req.model}", http_status=400)
        req = req.model_copy(
            update={
                "params": JobParams(**normalize_params_for_model(req.model, req.params.model_dump())),
            }
        )

        if idempotency_key:
            with self._idempotency_lock:
                self._clean_idempotency()
                found = self._idempotency.get(idempotency_key)
                if found and storage.job_exists(found.job_id):
                    meta = storage.load_meta(found.job_id)
                    return found.job_id, found.job_access_token, JobStatus(meta["status"]), datetime.fromisoformat(meta["created_at"])

        job_id = new_job_id()
        created_at = self._utcnow()
        access_token: str | None = None

        storage.create_job_dirs(job_id)

        ref_payload: list[dict[str, str]] = []
        for idx, ref in enumerate(reference_images):
            path = storage.save_input_reference(job_id, idx, ref.mime_type, ref.data)
            ref_payload.append({"filename": path, "mime": ref.mime_type})

        request_payload = self._canonical_request_payload(req, ref_payload)
        storage.save_request(job_id, request_payload)

        auth_payload: dict[str, str] = {}
        if settings.job_auth_mode == "TOKEN":
            access_token = new_job_access_token()
            auth_payload = {"token_hash": hash_token(access_token)}

        meta = {
            "job_id": job_id,
            "created_at": created_at.isoformat(),
            "updated_at": created_at.isoformat(),
            "status": JobStatus.QUEUED,
            "model": req.model,
            "mode": req.mode,
            "params": req.params.model_dump(),
            "result": {"images": []},
            "usage": {
                "prompt_token_count": 0,
                "cached_content_token_count": 0,
                "candidates_token_count": 0,
                "thoughts_token_count": 0,
                "total_token_count": 0,
            },
            "billing": {
                "currency": "USD",
                "estimated_cost_usd": 0.0,
                "breakdown": {
                    "text_input_cost_usd": 0.0,
                    "text_output_cost_usd": 0.0,
                    "image_output_cost_usd": 0.0,
                },
                "pricing_version": "2026-01-12",
                "pricing_notes": "computed from official pricing table",
            },
            "timing": {
                "queued_at": created_at.isoformat(),
                "started_at": None,
                "finished_at": None,
                "queue_wait_ms": None,
                "run_duration_ms": None,
            },
            "response": {
                "latency_ms": 0,
                "finish_reason": "OTHER",
                "safety_ratings": [],
            },
            "error": None,
            "auth": auth_payload,
        }
        storage.save_meta(job_id, meta)
        storage.save_response(
            job_id,
            {
                "latency_ms": 0,
                "finish_reason": "OTHER",
                "safety_ratings": [],
                "raw_summary": {
                    "parts_count": 0,
                    "has_inline_image": False,
                },
            },
        )

        try:
            self._queue.put_nowait(job_id)
        except queue.Full:
            storage.delete_job(job_id)
            raise api_error(ErrorCode.RATE_LIMITED, "Job queue is full", http_status=429)

        storage.write_job_log(job_id, "Job created and enqueued")

        if idempotency_key:
            with self._idempotency_lock:
                self._idempotency[idempotency_key] = IdempotencyRecord(
                    job_id=job_id,
                    job_access_token=access_token,
                    created_ts=time.time(),
                )

        return job_id, access_token, JobStatus.QUEUED, created_at

    def retry_job(
        self,
        job_id: str,
        token: str | None,
        override_params: JobParams | None,
    ) -> tuple[str, str | None, datetime]:
        meta = self._load_or_404(job_id)
        self._check_job_token(meta, token)

        request_data = storage.load_request(job_id)
        params = JobParams(**meta["params"])
        if override_params is not None:
            params = override_params

        req = CreateJobRequest(
            prompt=request_data["prompt"],
            model=meta.get("model") if get_model_spec(meta.get("model", "")) else settings.default_model,
            params=params,
            mode=meta["mode"],
        )

        refs: list[ReferenceImage] = []
        for idx, item in enumerate(request_data.get("reference_images", [])):
            rel = item.get("filename")
            mime = item.get("mime", "image/png")
            if not rel:
                continue
            path = storage.job_dir(job_id) / rel
            if path.exists():
                refs.append(ReferenceImage(mime_type=mime, data=path.read_bytes()))
            if idx >= settings.max_reference_images - 1:
                break

        new_job_id, new_token, _, created_at = self.create_job(req, refs)
        return new_job_id, new_token, created_at

    def _run_job(self, job_id: str) -> None:
        meta = storage.load_meta(job_id)
        params = meta["params"]

        started_at = self._utcnow()
        meta["status"] = JobStatus.RUNNING
        meta["updated_at"] = started_at.isoformat()
        self._hydrate_running_timing(meta, started_at)
        storage.save_meta(job_id, meta)
        storage.write_job_log(job_id, "Job started")

        request_data = storage.load_request(job_id)
        refs: list[ReferenceImage] = []
        for item in request_data.get("reference_images", []):
            rel = item.get("filename")
            mime = item.get("mime", "image/png")
            if rel:
                file_path = storage.job_dir(job_id) / rel
                if file_path.exists():
                    refs.append(ReferenceImage(mime_type=mime, data=file_path.read_bytes()))

        attempts = 1 + int(params.get("max_retries", 0))
        last_error: GeminiError | None = None

        for attempt in range(attempts):
            try:
                output = gemini_client.generate_image(
                    prompt=request_data["prompt"],
                    model=meta.get("model", settings.default_model),
                    mode=meta["mode"],
                    params=params,
                    reference_images=refs,
                )
                self._finalize_success(job_id, meta, output)
                return
            except GeminiError as exc:
                last_error = exc
                storage.write_job_log(job_id, f"Attempt {attempt + 1}/{attempts} failed: {exc.code} - {exc.message}")
                if not exc.retryable or attempt == attempts - 1:
                    break
                time.sleep(0.8)

        self._finalize_failure(job_id, meta, last_error)

    def _finalize_success(self, job_id: str, meta: dict[str, Any], output: dict[str, Any]) -> None:
        image_metas: list[dict[str, Any]] = []
        for idx, image in enumerate(output["images"]):
            image_id = f"image_{idx}"
            image_bytes, width, height = self._to_png(image["bytes"])
            mime = "image/png"
            filename = storage.save_result_image(job_id, image_id, image_bytes, mime)

            digest = hashlib.sha256(image_bytes).hexdigest()

            image_metas.append(
                {
                    "image_id": image_id,
                    "filename": filename,
                    "mime": mime,
                    "width": width,
                    "height": height,
                    "sha256": digest,
                }
            )

        usage = normalize_usage(output.get("usage_metadata"))
        billing = estimate_job_cost(
            usage=usage,
            image_size=meta["params"]["image_size"],
            image_count=len(image_metas),
            image_token_count=None,
        )

        raw = output.get("raw", {})
        parts_count = 0
        for c in raw.get("candidates", []):
            parts_count += len(c.get("content", {}).get("parts", []))

        response_payload = {
            "latency_ms": output.get("latency_ms", 0),
            "finish_reason": output.get("finish_reason", "OTHER"),
            "safety_ratings": output.get("safety_ratings", []),
            "raw_summary": {
                "parts_count": parts_count,
                "has_inline_image": bool(image_metas),
            },
        }
        storage.save_response(job_id, response_payload)

        finished_at = self._utcnow()
        self._hydrate_finished_timing(meta, finished_at, output.get("latency_ms"))
        meta["status"] = JobStatus.SUCCEEDED
        meta["updated_at"] = finished_at.isoformat()
        meta["result"] = {"images": image_metas}
        meta["usage"] = usage
        meta["billing"] = billing
        meta["response"] = {
            "latency_ms": output.get("latency_ms", 0),
            "finish_reason": output.get("finish_reason", "OTHER"),
            "safety_ratings": output.get("safety_ratings", []),
        }
        meta["error"] = None
        storage.save_meta(job_id, meta)
        storage.write_job_log(job_id, "Job succeeded")

    def _error_code_to_meta(self, code: str) -> tuple[str, bool]:
        if code == "UPSTREAM_TIMEOUT":
            return ErrorCode.UPSTREAM_TIMEOUT.value, True
        if code == "UPSTREAM_RATE_LIMIT":
            return ErrorCode.UPSTREAM_RATE_LIMIT.value, True
        if code == "NO_IMAGE_PART":
            return ErrorCode.NO_IMAGE_PART.value, False
        return "UPSTREAM_ERROR", False

    def _finalize_failure(self, job_id: str, meta: dict[str, Any], err: GeminiError | None) -> None:
        err = err or GeminiError(code="UNKNOWN", message="Unknown failure", retryable=False)
        error_type, retryable = self._error_code_to_meta(err.code)
        usage = {
            "prompt_token_count": 0,
            "cached_content_token_count": 0,
            "candidates_token_count": 0,
            "thoughts_token_count": 0,
            "total_token_count": 0,
        }
        billing = estimate_job_cost(
            usage=usage,
            image_size=meta["params"]["image_size"],
            image_count=0,
            image_token_count=None,
        )

        response_payload = {
            "latency_ms": 0,
            "finish_reason": "OTHER",
            "safety_ratings": [],
            "raw_summary": {
                "parts_count": 0,
                "has_inline_image": False,
            },
            "upstream_error": err.payload,
        }
        storage.save_response(job_id, response_payload)

        finished_at = self._utcnow()
        self._hydrate_finished_timing(meta, finished_at, 0)
        meta["status"] = JobStatus.FAILED
        meta["updated_at"] = finished_at.isoformat()
        meta["usage"] = usage
        meta["billing"] = billing
        meta["response"] = {
            "latency_ms": 0,
            "finish_reason": "OTHER",
            "safety_ratings": [],
        }
        meta["error"] = {
            "type": error_type,
            "message": err.message,
            "retryable": retryable,
            "debug_id": str(uuid.uuid4()),
        }
        storage.save_meta(job_id, meta)
        storage.write_job_log(job_id, f"Job failed: {error_type} - {err.message}")

    def _to_png(self, raw: bytes) -> tuple[bytes, int, int]:
        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
            out = io.BytesIO()
            img.save(out, format="PNG")
            return out.getvalue(), width, height


job_manager = JobManager()
