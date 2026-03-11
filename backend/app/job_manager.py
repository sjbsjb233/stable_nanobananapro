from __future__ import annotations

import hashlib
import io
import queue
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image

from .billing import estimate_job_cost, normalize_usage
from .config import settings
from .errors import api_error
from .gemini_client import GeminiError, ReferenceImage, gemini_client
from .logging_setup import get_logger
from .model_catalog import MODE_TEXT_AND_IMAGE, get_model_spec, normalize_params_for_model
from .schemas import CreateJobRequest, ErrorCode, JobParams, JobStatus
from .security import hash_token, new_job_access_token, new_job_id, validate_job_id, verify_token
from .storage import storage
from .time_utils import APP_TZ, now_local
from .user_store import user_store

logger = get_logger("job_manager")


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
        self._dispatch_lock = threading.Lock()
        self._idempotency_lock = threading.Lock()
        self._idempotency: dict[str, IdempotencyRecord] = {}

    def start(self) -> None:
        if self._workers:
            return
        for idx in range(settings.job_workers):
            t = threading.Thread(target=self._worker_loop, name=f"job-worker-{idx}", daemon=True)
            t.start()
            self._workers.append(t)

    def fail_incomplete_jobs_on_startup(self) -> int:
        recovered = 0
        for summary in storage.iter_job_meta():
            job_id = str(summary.get("job_id") or "")
            previous_status = str(summary.get("status") or "")
            if not job_id or previous_status not in {JobStatus.QUEUED.value, JobStatus.RUNNING.value}:
                continue
            try:
                meta = storage.load_meta(job_id)
            except Exception:
                logger.exception("Failed to load lingering job during startup recovery: job_id=%s", job_id)
                continue

            current_status = str(meta.get("status") or "")
            if current_status not in {JobStatus.QUEUED.value, JobStatus.RUNNING.value}:
                continue

            finished_at = self._utcnow()
            debug_id = str(uuid.uuid4())
            message = (
                "Job was interrupted by backend restart before completion and has been marked as failed. "
                "Please retry."
            )
            usage = {
                "prompt_token_count": 0,
                "cached_content_token_count": 0,
                "candidates_token_count": 0,
                "thoughts_token_count": 0,
                "total_token_count": 0,
            }
            billing = estimate_job_cost(
                usage=usage,
                image_size=str((meta.get("params") or {}).get("image_size") or "1K"),
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
                "upstream_error": {
                    "reason": "BACKEND_RESTART_RECOVERY",
                    "previous_status": current_status,
                },
            }
            storage.save_response(job_id, response_payload)

            self._hydrate_finished_timing(meta, finished_at, 0)
            meta["status"] = JobStatus.FAILED
            meta["updated_at"] = finished_at.isoformat()
            meta["result"] = {"images": []}
            meta["usage"] = usage
            meta["billing"] = billing
            meta["response"] = {
                "latency_ms": 0,
                "finish_reason": "OTHER",
                "safety_ratings": [],
            }
            meta["error"] = {
                "code": "BACKEND_RESTART_RECOVERY",
                "type": "SYSTEM_RESTART",
                "message": message,
                "retryable": True,
                "debug_id": debug_id,
                "details": {
                    "previous_status": current_status,
                    "recovery_action": "MARK_AS_FAILED_ON_STARTUP",
                },
            }
            storage.save_meta(job_id, meta)
            storage.write_job_log(job_id, f"Job recovered as failed after backend restart (previous_status={current_status})")

            owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
            if owner.get("user_id"):
                user_store.record_job_failure(str(owner["user_id"]))
            recovered += 1

        if recovered:
            logger.warning("Recovered lingering jobs on startup: count=%s", recovered)
        return recovered

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
                claim_state = self._claim_job_for_execution(job_id)
                if claim_state is None:
                    continue
                if claim_state is False:
                    self._requeue_job(job_id)
                    time.sleep(0.05)
                    continue
                self._run_job(job_id)
            except Exception as exc:
                logger.exception("Unhandled worker exception: job_id=%s", job_id)
                self._finalize_unhandled_exception(job_id, exc)
            finally:
                self._queue.task_done()

    def _utcnow(self) -> datetime:
        return now_local()

    def _parse_iso_dt(self, value: Any) -> datetime | None:
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=APP_TZ)
        return dt.astimezone(APP_TZ)

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

    def _owner_running_limit(self, owner: dict[str, Any]) -> int:
        owner_id = str(owner.get("user_id") or "")
        policy_user = user_store.get_user_by_id(owner_id) if owner_id else None
        effective_policy = user_store.get_effective_policy(policy_user or owner)
        return max(0, int(effective_policy.get("concurrent_jobs_limit") or 0))

    def _running_jobs_for_owner(self, owner_user_id: str, *, exclude_job_id: str | None = None) -> int:
        running = 0
        for meta in storage.iter_job_meta():
            if exclude_job_id and str(meta.get("job_id") or "") == exclude_job_id:
                continue
            if meta.get("status") != JobStatus.RUNNING:
                continue
            owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
            if str(owner.get("user_id") or "") == owner_user_id:
                running += 1
        return running

    def _claim_job_for_execution(self, job_id: str) -> bool | None:
        with self._dispatch_lock:
            try:
                meta = storage.load_meta(job_id)
            except Exception:
                return None

            if meta.get("status") != JobStatus.QUEUED:
                return None

            owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
            owner_user_id = str(owner.get("user_id") or "")
            if owner_user_id:
                running_limit = self._owner_running_limit(owner)
                if running_limit and self._running_jobs_for_owner(owner_user_id, exclude_job_id=job_id) >= running_limit:
                    return False

            started_at = self._utcnow()
            meta["status"] = JobStatus.RUNNING
            meta["updated_at"] = started_at.isoformat()
            self._hydrate_running_timing(meta, started_at)
            storage.save_meta(job_id, meta)
            storage.write_job_log(job_id, "Job started")
            return True

    def _requeue_job(self, job_id: str) -> None:
        try:
            self._queue.put(job_id, timeout=0.5)
        except queue.Full:
            logger.warning("Failed to requeue job while waiting for running slot: job_id=%s", job_id)

    def _check_job_token(self, meta: dict[str, Any], token: str | None) -> None:
        if settings.job_auth_mode != "TOKEN":
            return
        token_hash = meta.get("auth", {}).get("token_hash")
        if not token_hash or not token or not verify_token(token, token_hash):
            raise api_error(ErrorCode.JOB_TOKEN_INVALID, "Invalid job token", http_status=403)

    def _check_job_access(self, meta: dict[str, Any], token: str | None, user: dict[str, Any] | None) -> None:
        owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
        owner_id = str(owner.get("user_id") or "")
        user_id = str((user or {}).get("user_id") or "")
        is_admin = str((user or {}).get("role") or "").upper() == "ADMIN"

        if owner_id:
            if is_admin or owner_id == user_id:
                return
            raise api_error(ErrorCode.FORBIDDEN, "You do not have access to this job", http_status=403)

        if is_admin:
            return
        if settings.job_auth_mode != "TOKEN":
            raise api_error(ErrorCode.FORBIDDEN, "You do not have access to this job", http_status=403)
        self._check_job_token(meta, token)

    def get_meta(self, job_id: str, token: str | None, user: dict[str, Any] | None = None) -> dict[str, Any]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)
        return meta

    def get_request(self, job_id: str, token: str | None, user: dict[str, Any] | None = None) -> dict[str, Any]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)
        return storage.load_request(job_id)

    def get_response(self, job_id: str, token: str | None, user: dict[str, Any] | None = None) -> dict[str, Any]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)
        return storage.load_response(job_id)

    def get_image(self, job_id: str, token: str | None, image_id: str, user: dict[str, Any] | None = None) -> tuple[bytes, str]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)

        for image in meta.get("result", {}).get("images", []):
            if image.get("image_id") == image_id:
                return storage.load_result_image(job_id, image["filename"]), image.get("mime", "image/png")
        raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Image not found", http_status=404)

    def get_preview_image(self, job_id: str, token: str | None, image_id: str, user: dict[str, Any] | None = None) -> tuple[bytes, str]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)

        images = meta.get("result", {}).get("images", [])
        for image in images:
            if image.get("image_id") != image_id:
                continue
            preview = image.get("preview") if isinstance(image.get("preview"), dict) else {}
            preview_filename = str(preview.get("filename") or "")
            preview_mime = str(preview.get("mime") or "image/webp")
            preview_path = storage.job_dir(job_id) / preview_filename if preview_filename else None
            if preview_filename and preview_path and preview_path.exists():
                return storage.load_result_image(job_id, preview_filename), preview_mime

            original = storage.load_result_image(job_id, image["filename"])
            preview_bytes, preview_width, preview_height = self._to_preview(original)
            saved_filename = storage.save_preview_image(job_id, image_id, preview_bytes, "image/webp")
            image["preview"] = {
                "filename": saved_filename,
                "mime": "image/webp",
                "width": preview_width,
                "height": preview_height,
                "size_bytes": len(preview_bytes),
            }
            storage.save_meta(job_id, meta)
            return preview_bytes, "image/webp"

        raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Image not found", http_status=404)

    def get_input_reference(self, job_id: str, token: str | None, ref_filename: str, user: dict[str, Any] | None = None) -> tuple[bytes, str]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)
        request_data = storage.load_request(job_id)
        refs = request_data.get("reference_images") if isinstance(request_data.get("reference_images"), list) else []
        allowed = {
            str(item.get("filename")): str(item.get("mime") or "application/octet-stream")
            for item in refs
            if isinstance(item, dict) and item.get("filename")
        }
        mime = allowed.get(ref_filename)
        if not mime:
            raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Reference image not found", http_status=404)

        path = (storage.job_dir(job_id) / ref_filename).resolve()
        job_root = storage.job_dir(job_id).resolve()
        if job_root not in path.parents:
            raise api_error(ErrorCode.FORBIDDEN, "Invalid reference path", http_status=403)
        if not path.exists() or not path.is_file():
            raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Reference image not found", http_status=404)
        return path.read_bytes(), mime

    def delete_job(self, job_id: str, token: str | None, user: dict[str, Any] | None = None) -> None:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)
        storage.delete_job(job_id)

    def cancel_job(self, job_id: str, token: str | None, user: dict[str, Any] | None = None) -> dict[str, Any]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)
        current_status = str(meta.get("status") or "")
        if current_status != JobStatus.RUNNING.value:
            raise api_error(ErrorCode.INVALID_INPUT, "Only RUNNING jobs can be cancelled", http_status=400)

        finished_at = self._utcnow()
        self._hydrate_finished_timing(meta, finished_at, 0)
        debug_id = str(uuid.uuid4())
        message = "Job was cancelled by user while running. Any later worker result will be discarded."
        meta["status"] = JobStatus.CANCELLED
        meta["updated_at"] = finished_at.isoformat()
        meta["result"] = {"images": []}
        meta["response"] = {
            "latency_ms": 0,
            "finish_reason": "CANCELLED",
            "safety_ratings": [],
        }
        meta["error"] = {
            "code": "JOB_CANCELLED",
            "type": "USER_CANCELLED",
            "message": message,
            "retryable": False,
            "debug_id": debug_id,
            "details": {
                "cancelled_at": finished_at.isoformat(),
                "previous_status": current_status,
            },
        }
        storage.save_response(
            job_id,
            {
                "latency_ms": 0,
                "finish_reason": "CANCELLED",
                "safety_ratings": [],
                "raw_summary": {
                    "parts_count": 0,
                    "has_inline_image": False,
                },
                "upstream_error": {
                    "reason": "USER_CANCELLED",
                },
            },
        )
        storage.save_meta(job_id, meta)
        storage.write_job_log(job_id, "Job cancelled by user")
        return {"job_id": job_id, "cancelled": True, "status": JobStatus.CANCELLED.value}

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

    def _initialize_job(
        self,
        req: CreateJobRequest,
        reference_images: list[ReferenceImage],
        owner: dict[str, Any],
        requested_job_count: int,
    ) -> tuple[str, str | None, datetime, dict[str, Any]]:
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
            "owner": {
                "user_id": owner.get("user_id"),
                "username": owner.get("username"),
                "role": owner.get("role"),
            },
            "model": req.model,
            "mode": req.mode,
            "params": req.params.model_dump(),
            "requested_job_count": max(1, int(requested_job_count)),
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
        return job_id, access_token, created_at, meta

    def create_job(
        self,
        req: CreateJobRequest,
        reference_images: list[ReferenceImage],
        owner: dict[str, Any],
        requested_job_count: int = 1,
        idempotency_key: str | None = None,
    ) -> tuple[str, str | None, JobStatus, datetime]:
        if idempotency_key:
            with self._idempotency_lock:
                self._clean_idempotency()
                found = self._idempotency.get(idempotency_key)
                if found and storage.job_exists(found.job_id):
                    meta = storage.load_meta(found.job_id)
                    return found.job_id, found.job_access_token, JobStatus(meta["status"]), datetime.fromisoformat(meta["created_at"])

        job_id, access_token, created_at, _ = self._initialize_job(req, reference_images, owner, requested_job_count)

        try:
            self._queue.put_nowait(job_id)
        except queue.Full:
            storage.delete_job(job_id)
            raise api_error(ErrorCode.RATE_LIMITED, "Job queue is full", http_status=429)

        storage.write_job_log(job_id, "Job created and enqueued")
        if owner.get("user_id"):
            user_store.record_job_created(str(owner["user_id"]))

        if idempotency_key:
            with self._idempotency_lock:
                self._idempotency[idempotency_key] = IdempotencyRecord(
                    job_id=job_id,
                    job_access_token=access_token,
                    created_ts=time.time(),
                )

        return job_id, access_token, JobStatus.QUEUED, created_at

    def create_failed_job(
        self,
        req: CreateJobRequest,
        reference_images: list[ReferenceImage],
        owner: dict[str, Any],
        *,
        requested_job_count: int = 1,
        failure_message: str = "Job failed before execution",
    ) -> tuple[str, str | None, JobStatus, datetime]:
        job_id, access_token, created_at, meta = self._initialize_job(req, reference_images, owner, requested_job_count)
        debug_id = str(uuid.uuid4())
        meta["status"] = JobStatus.FAILED
        meta["updated_at"] = created_at.isoformat()
        meta["timing"] = {
            "queued_at": created_at.isoformat(),
            "started_at": None,
            "finished_at": created_at.isoformat(),
            "queue_wait_ms": 0,
            "run_duration_ms": 0,
        }
        meta["error"] = {
            "code": "DEGRADED_FAILURE",
            "type": "UPSTREAM_ERROR",
            "message": failure_message,
            "retryable": False,
            "debug_id": debug_id,
            "details": {},
        }
        storage.save_meta(job_id, meta)
        storage.write_job_log(job_id, failure_message)
        if owner.get("user_id"):
            user_store.record_job_created(str(owner["user_id"]))
            user_store.record_job_failure(str(owner["user_id"]))
        return job_id, access_token, JobStatus.FAILED, created_at

    def retry_job(
        self,
        job_id: str,
        token: str | None,
        user: dict[str, Any],
        override_params: JobParams | None,
    ) -> tuple[str, str | None, datetime]:
        meta = self._load_or_404(job_id)
        self._check_job_access(meta, token, user)

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

        new_job_id, new_token, _, created_at = self.create_job(req, refs, user)
        return new_job_id, new_token, created_at

    def _run_job(self, job_id: str) -> None:
        meta = storage.load_meta(job_id)
        params = meta["params"]

        request_data = storage.load_request(job_id)
        refs: list[ReferenceImage] = []
        for item in request_data.get("reference_images", []):
            rel = item.get("filename")
            mime = item.get("mime", "image/png")
            if rel:
                file_path = storage.job_dir(job_id) / rel
                if file_path.exists():
                    refs.append(ReferenceImage(mime_type=mime, data=file_path.read_bytes()))

        attempts = 1
        last_error: GeminiError | None = None

        for attempt in range(attempts):
            try:
                storage.write_job_log(job_id, f"Attempt {attempt + 1}/{attempts} started")
                logger.info(
                    "Gemini run start: job_id=%s attempt=%s/%s model=%s mode=%s timeout_sec=%s",
                    job_id,
                    attempt + 1,
                    attempts,
                    meta.get("model", settings.default_model),
                    meta["mode"],
                    params.get("timeout_sec"),
                )
                output = self._generate_image_with_watchdog(
                    job_id=job_id,
                    attempt=attempt + 1,
                    attempts=attempts,
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
                logger.warning(
                    "Gemini run failed: job_id=%s attempt=%s/%s code=%s retryable=%s message=%s",
                    job_id,
                    attempt + 1,
                    attempts,
                    exc.code,
                    exc.retryable,
                    exc.message,
                )
                if not exc.retryable or attempt == attempts - 1:
                    break
                time.sleep(0.8)

        self._finalize_failure(job_id, meta, last_error)

    def _generate_image_with_watchdog(
        self,
        *,
        job_id: str,
        attempt: int,
        attempts: int,
        prompt: str,
        model: str,
        mode: str,
        params: dict[str, Any],
        reference_images: list[ReferenceImage],
    ) -> dict[str, Any]:
        watchdog_timeout_sec = max(
            int(params.get("timeout_sec", settings.job_timeout_sec_default)) + int(settings.job_watchdog_grace_sec),
            1,
        )
        result_queue: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

        def _target() -> None:
            try:
                output = gemini_client.generate_image(
                    prompt=prompt,
                    model=model,
                    mode=mode,
                    params=params,
                    reference_images=reference_images,
                )
                result_queue.put(("ok", output))
            except Exception as exc:  # noqa: BLE001
                result_queue.put(("err", exc))

        thread = threading.Thread(
            target=_target,
            name=f"gemini-call-{job_id[:8]}-{attempt}",
            daemon=True,
        )
        thread.start()

        try:
            kind, payload = result_queue.get(timeout=watchdog_timeout_sec)
        except queue.Empty as exc:
            raise GeminiError(
                code="WORKER_WATCHDOG_TIMEOUT",
                message=(
                    "Worker watchdog timeout while waiting Gemini response "
                    f"(attempt {attempt}/{attempts}, watchdog={watchdog_timeout_sec}s)"
                ),
                retryable=True,
                payload={
                    "job_id": job_id,
                    "attempt": attempt,
                    "attempts": attempts,
                    "watchdog_timeout_sec": watchdog_timeout_sec,
                    "configured_timeout_sec": int(params.get("timeout_sec", settings.job_timeout_sec_default)),
                },
            ) from exc

        if kind == "ok":
            return payload
        if isinstance(payload, GeminiError):
            raise payload
        raise GeminiError(
            code="UPSTREAM_UNCAUGHT_EXCEPTION",
            message=f"Unhandled exception while calling Gemini: {type(payload).__name__}: {payload}",
            retryable=True,
            payload={
                "job_id": job_id,
                "attempt": attempt,
                "attempts": attempts,
                "exception_type": type(payload).__name__,
                "exception": str(payload),
            },
        ) from payload

    def _finalize_success(self, job_id: str, meta: dict[str, Any], output: dict[str, Any]) -> None:
        try:
            latest_meta = storage.load_meta(job_id)
        except Exception:
            return
        if str(latest_meta.get("status") or "") == JobStatus.CANCELLED.value:
            storage.write_job_log(job_id, "Worker result discarded because job was already cancelled")
            return
        meta = latest_meta
        image_metas: list[dict[str, Any]] = []
        for idx, image in enumerate(output["images"]):
            image_id = f"image_{idx}"
            image_bytes, width, height = self._to_png(image["bytes"])
            mime = "image/png"
            filename = storage.save_result_image(job_id, image_id, image_bytes, mime)
            preview_bytes, preview_width, preview_height = self._to_preview(image_bytes)
            preview_filename = storage.save_preview_image(job_id, image_id, preview_bytes, "image/webp")

            digest = hashlib.sha256(image_bytes).hexdigest()

            image_metas.append(
                {
                    "image_id": image_id,
                    "filename": filename,
                    "mime": mime,
                    "width": width,
                    "height": height,
                    "sha256": digest,
                    "preview": {
                        "filename": preview_filename,
                        "mime": "image/webp",
                        "width": preview_width,
                        "height": preview_height,
                        "size_bytes": len(preview_bytes),
                    },
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
            "provider": output.get("provider"),
            "provider_attempts": output.get("provider_attempts", []),
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
            "provider": output.get("provider"),
            "provider_attempts": output.get("provider_attempts", []),
        }
        meta["error"] = None
        storage.save_meta(job_id, meta)
        storage.write_job_log(job_id, "Job succeeded")
        owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
        if owner.get("user_id"):
            user_store.record_job_success(str(owner["user_id"]), len(image_metas))

    def _error_code_to_meta(self, code: str) -> tuple[str, bool]:
        if code in {"UPSTREAM_TIMEOUT", "WORKER_WATCHDOG_TIMEOUT"}:
            return ErrorCode.UPSTREAM_TIMEOUT.value, True
        if code == "UPSTREAM_RATE_LIMIT":
            return ErrorCode.UPSTREAM_RATE_LIMIT.value, True
        if code == "NO_IMAGE_PART":
            return ErrorCode.NO_IMAGE_PART.value, False
        return "UPSTREAM_ERROR", False

    def _finalize_failure(self, job_id: str, meta: dict[str, Any], err: GeminiError | None) -> None:
        try:
            latest_meta = storage.load_meta(job_id)
        except Exception:
            return
        if str(latest_meta.get("status") or "") == JobStatus.CANCELLED.value:
            storage.write_job_log(job_id, "Worker failure ignored because job was already cancelled")
            return
        meta = latest_meta
        err = err or GeminiError(code="UNKNOWN", message="Unknown failure", retryable=False)
        error_type, retryable = self._error_code_to_meta(err.code)
        debug_id = str(uuid.uuid4())
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
            "code": err.code,
            "type": error_type,
            "message": err.message,
            "retryable": retryable,
            "debug_id": debug_id,
            "details": err.payload or {},
        }
        storage.save_meta(job_id, meta)
        storage.write_job_log(job_id, f"Job failed: {error_type} - {err.message} (debug_id={debug_id})")
        owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
        if owner.get("user_id"):
            user_store.record_job_failure(str(owner["user_id"]))
        logger.error(
            "Job failed: job_id=%s type=%s code=%s retryable=%s debug_id=%s message=%s details=%s",
            job_id,
            error_type,
            err.code,
            retryable,
            debug_id,
            err.message,
            err.payload or {},
        )

    def _finalize_unhandled_exception(self, job_id: str, exc: Exception) -> None:
        try:
            meta = storage.load_meta(job_id)
        except Exception:
            logger.exception("Failed to load meta while handling worker exception: job_id=%s", job_id)
            return

        if meta.get("status") not in {JobStatus.QUEUED, JobStatus.RUNNING}:
            return

        wrapped = GeminiError(
            code="WORKER_UNHANDLED_EXCEPTION",
            message=f"Unhandled worker exception: {type(exc).__name__}: {exc}",
            retryable=False,
            payload={"exception_type": type(exc).__name__, "exception": str(exc)},
        )
        try:
            self._finalize_failure(job_id, meta, wrapped)
        except Exception:
            logger.exception("Failed to finalize unhandled worker exception: job_id=%s", job_id)

    def _to_png(self, raw: bytes) -> tuple[bytes, int, int]:
        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
            out = io.BytesIO()
            img.save(out, format="PNG")
            return out.getvalue(), width, height

    def _to_preview(self, raw: bytes) -> tuple[bytes, int, int]:
        with Image.open(io.BytesIO(raw)) as img:
            preview = img.copy()
            max_px = max(256, int(settings.preview_image_max_px))
            preview.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
            width, height = preview.size
            out = io.BytesIO()
            if preview.mode not in {"RGB", "RGBA"}:
                preview = preview.convert("RGBA" if "A" in preview.getbands() else "RGB")
            preview.save(
                out,
                format="WEBP",
                quality=max(20, min(100, int(settings.preview_image_quality))),
                method=6,
            )
            return out.getvalue(), width, height

    def queue_size(self) -> int:
        return self._queue.qsize()

    def worker_count(self) -> int:
        return len(self._workers)


job_manager = JobManager()
