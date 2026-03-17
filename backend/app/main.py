from __future__ import annotations

import json
import math
import random
import time
import uuid
import base64
from datetime import datetime, timedelta
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, Query, Request, Response, status
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import cors_allow_all_origins, ensure_data_dirs, get_cors_origins, settings
from .announcement_store import announcement_store
from .errors import api_error
from .gemini_client import ReferenceImage
from .job_manager import job_manager
from .model_catalog import (
    DEFAULT_MODEL_ID,
    MODE_IMAGE_ONLY,
    MODE_TEXT_AND_IMAGE,
    get_model_spec,
    list_model_specs,
    model_capability_payload,
    normalize_mode,
    normalize_params_for_model,
)
from .rate_limiter import job_read_rate_limit
from .logging_setup import get_logger, setup_logging
from .provider_store import provider_store
from .schemas import (
    ActiveJobsRequest,
    AnnouncementItem,
    AnnouncementListResponse,
    AddProviderBalanceRequest,
    BatchPreviewRequest,
    BatchMetaRequest,
    CreateJobRequest,
    CreateJobResponse,
    CreateAnnouncementRequest,
    CreateUserRequest,
    DashboardSummaryRequest,
    DismissAnnouncementResponse,
    ErrorCode,
    ErrorResponse,
    GoogleRemainingConfiguredResponse,
    GoogleRemainingUnconfiguredResponse,
    HealthResponse,
    LoginRequest,
    ModelCapability,
    ModelsResponse,
    JobParams,
    JobStatus,
    RetryJobRequest,
    SetProviderBalanceRequest,
    TurnstileVerifyRequest,
    UpdateAnnouncementRequest,
    UpdateProviderRequest,
    UpdateSystemPolicyRequest,
    UpdateUserRequest,
)
from .safe_session import SafeSessionMiddleware
from .security import validate_image_id, validate_job_id
from .storage import storage
from .time_utils import now_local
from .turnstile import verify_turnstile_token
from .user_store import user_store, validate_username

logger = get_logger("api")
app = FastAPI(title="Nano Banana API", version=settings.app_version)
APP_DEPLOYED_AT = now_local()
cors_origins = get_cors_origins()
allow_credentials = settings.cors_allow_credentials
allow_origin_regex = ".*" if cors_allow_all_origins() else None

app.add_middleware(
    CORSMiddleware,
    allow_origins=[] if allow_origin_regex else cors_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=allow_credentials,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Job-Token",
        "X-Admin-Key",
        "Idempotency-Key",
        "X-Requested-Job-Count",
    ],
)
app.add_middleware(
    SafeSessionMiddleware,
    secret_key=settings.session_secret_key,
    session_cookie=settings.session_cookie_name,
    max_age=settings.session_max_age_sec,
    same_site="lax",
    https_only=settings.session_https_only,
)


@app.on_event("startup")
def _startup() -> None:
    setup_logging()
    ensure_data_dirs()
    user_store.ensure_initialized()
    provider_store.ensure_initialized()
    announcement_store.ensure_initialized()
    recovered_jobs = job_manager.fail_incomplete_jobs_on_startup()
    logger.info(
        "Backend startup: version=%s deployed_at=%s data_dir=%s recovered_jobs=%s",
        settings.app_version,
        APP_DEPLOYED_AT.isoformat(),
        settings.data_dir,
        recovered_jobs,
    )
    job_manager.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    job_manager.stop()
    logger.info("Backend shutdown complete")


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    started = time.perf_counter()
    request.state.current_user = None
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        logger.exception(
            "Unhandled exception: method=%s path=%s elapsed_ms=%s",
            request.method,
            request.url.path,
            elapsed_ms,
        )
        raise

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "Request: method=%s path=%s status=%s elapsed_ms=%s",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response


def _error_json(status_code: int, code: ErrorCode, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    payload = {
        "error": {
            "code": code,
            "message": message,
            "debug_id": uuid.uuid4().hex,
            "details": details or {},
        }
    }
    return JSONResponse(status_code=status_code, content=payload)


def _parse_session_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except Exception:
        return None


def _get_test_env_admin_user_or_none() -> dict[str, Any] | None:
    if not settings.test_env_admin_bypass:
        return None

    user_store.ensure_initialized()

    preferred_username = str(settings.bootstrap_admin_username or "").strip()
    if preferred_username:
        preferred = user_store.get_user_by_username(preferred_username)
        if preferred and preferred.get("enabled") and str(preferred.get("role") or "").upper() == "ADMIN":
            return preferred

    for user in user_store.list_users():
        if user.get("enabled") and str(user.get("role") or "").upper() == "ADMIN":
            return user
    return None


def _get_authenticated_user_or_none(request: Request) -> dict[str, Any] | None:
    bypass_user = _get_test_env_admin_user_or_none()
    if bypass_user:
        request.state.current_user = bypass_user
        return bypass_user

    session = request.scope.get("session")
    user_id = session.get("user_id") if isinstance(session, dict) else None
    if not user_id:
        return None
    user = user_store.get_user_by_id(str(user_id))
    if not user or not user.get("enabled"):
        if isinstance(session, dict):
            session.clear()
        return None
    return user


def get_current_user(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "current_user", None) or _get_authenticated_user_or_none(request)
    if not user:
        raise api_error(ErrorCode.AUTH_REQUIRED, "Authentication required", http_status=401)
    request.state.current_user = user
    return user


def get_admin_user(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if str(current_user.get("role") or "").upper() != "ADMIN":
        raise api_error(ErrorCode.FORBIDDEN, "Admin access required", http_status=403)
    return current_user


def _generation_turnstile_valid_until(request: Request) -> datetime | None:
    session = request.scope.get("session")
    value = session.get("generation_turnstile_verified_until") if isinstance(session, dict) else None
    dt = _parse_session_datetime(value)
    if dt and dt >= now_local():
        return dt
    if isinstance(session, dict):
        session.pop("generation_turnstile_verified_until", None)
    return None


def _generation_turnstile_single_use_valid_until(request: Request) -> datetime | None:
    session = request.scope.get("session")
    value = session.get("generation_turnstile_single_use_until") if isinstance(session, dict) else None
    dt = _parse_session_datetime(value)
    if dt and dt >= now_local():
        return dt
    if isinstance(session, dict):
        session.pop("generation_turnstile_single_use_until", None)
    return None


def _mark_generation_turnstile_verified(request: Request) -> datetime:
    valid_until = now_local() + timedelta(seconds=settings.generation_turnstile_ttl_sec)
    request.session["generation_turnstile_verified_until"] = valid_until.isoformat()
    return valid_until


def _mark_generation_turnstile_single_use(request: Request) -> datetime:
    valid_until = now_local() + timedelta(seconds=settings.generation_turnstile_ttl_sec)
    request.session["generation_turnstile_single_use_until"] = valid_until.isoformat()
    return valid_until


def _clear_generation_turnstile_batch_allowance(request: Request) -> None:
    request.session.pop("generation_turnstile_single_use_until", None)
    request.session.pop("generation_turnstile_batch_job_count", None)
    request.session.pop("generation_turnstile_batch_remaining_uses", None)


def _set_generation_turnstile_batch_allowance(request: Request, requested_job_count: int) -> None:
    valid_until = _mark_generation_turnstile_single_use(request)
    request.session["generation_turnstile_batch_job_count"] = int(requested_job_count)
    request.session["generation_turnstile_batch_remaining_uses"] = int(requested_job_count)
    request.session["generation_turnstile_single_use_until"] = valid_until.isoformat()


def _get_generation_turnstile_batch_allowance(request: Request) -> dict[str, int] | None:
    if _generation_turnstile_single_use_valid_until(request) is None:
        _clear_generation_turnstile_batch_allowance(request)
        return None
    try:
        requested_job_count = int(request.session.get("generation_turnstile_batch_job_count") or 0)
        remaining_uses = int(request.session.get("generation_turnstile_batch_remaining_uses") or 0)
    except Exception:
        _clear_generation_turnstile_batch_allowance(request)
        return None
    if requested_job_count <= 0 or remaining_uses <= 0:
        _clear_generation_turnstile_batch_allowance(request)
        return None
    return {
        "requested_job_count": requested_job_count,
        "remaining_uses": remaining_uses,
    }


def _consume_generation_turnstile_batch_allowance(request: Request, requested_job_count: int) -> None:
    allowance = _get_generation_turnstile_batch_allowance(request)
    if not allowance or allowance["requested_job_count"] != int(requested_job_count):
        _clear_generation_turnstile_batch_allowance(request)
        return
    remaining = allowance["remaining_uses"] - 1
    if remaining <= 0:
        _clear_generation_turnstile_batch_allowance(request)
        return
    request.session["generation_turnstile_batch_remaining_uses"] = remaining


def _clear_overquota_pending_batch(request: Request) -> None:
    request.session.pop("overquota_pending_user_id", None)
    request.session.pop("overquota_pending_requested_job_count", None)
    request.session.pop("overquota_pending_jobs", None)


def _store_overquota_pending_batch(
    request: Request,
    *,
    user_id: str,
    requested_job_count: int,
    jobs: list[dict[str, Any]],
) -> None:
    if not jobs:
        _clear_overquota_pending_batch(request)
        return
    request.session["overquota_pending_user_id"] = str(user_id)
    request.session["overquota_pending_requested_job_count"] = int(requested_job_count)
    request.session["overquota_pending_jobs"] = jobs


def _pop_overquota_pending_job(
    request: Request,
    *,
    user_id: str,
    requested_job_count: int,
) -> dict[str, Any] | None:
    session = request.scope.get("session")
    if not isinstance(session, dict):
        return None
    if str(session.get("overquota_pending_user_id") or "") != str(user_id):
        return None
    if int(session.get("overquota_pending_requested_job_count") or 0) != int(requested_job_count):
        return None
    jobs = session.get("overquota_pending_jobs")
    if not isinstance(jobs, list) or not jobs:
        _clear_overquota_pending_batch(request)
        return None
    item = jobs.pop(0)
    if jobs:
        session["overquota_pending_jobs"] = jobs
    else:
        _clear_overquota_pending_batch(request)
    return item if isinstance(item, dict) else None


def _job_activity_counts_for_user(user_id: str) -> dict[str, int]:
    counts = {"queued_jobs": 0, "running_jobs": 0, "active_jobs": 0}
    for meta in storage.iter_job_meta():
        owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
        if str(owner.get("user_id") or "") != str(user_id):
            continue
        status_value = str(meta.get("status") or "")
        if status_value == "QUEUED":
            counts["queued_jobs"] += 1
            counts["active_jobs"] += 1
        elif status_value == "RUNNING":
            counts["running_jobs"] += 1
            counts["active_jobs"] += 1
    return counts


def _usage_payload(user: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or user_store.get_effective_policy(user)
    usage = user_store.get_daily_usage(str(user["user_id"]))
    activity = _job_activity_counts_for_user(str(user["user_id"]))
    daily_limit = policy.get("daily_image_limit")
    quota_consumed = int(usage["jobs_created"])
    remaining = None if daily_limit is None else max(0, int(daily_limit) - quota_consumed)
    return {
        "date": now_local().date().isoformat(),
        "jobs_created_today": int(usage["jobs_created"]),
        "jobs_succeeded_today": int(usage["jobs_succeeded"]),
        "jobs_failed_today": int(usage["jobs_failed"]),
        "images_generated_today": int(usage["images_generated"]),
        "quota_consumed_today": quota_consumed,
        "quota_resets_today": int(usage["quota_resets"]),
        "active_jobs": int(activity["active_jobs"]),
        "running_jobs": int(activity["running_jobs"]),
        "queued_jobs": int(activity["queued_jobs"]),
        "remaining_images_today": remaining,
    }


def _image_access_usage_payload(user: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = policy or user_store.get_effective_policy(user)
    usage = user_store.get_daily_usage(str(user["user_id"]))
    base_limit = policy.get("daily_image_access_limit")
    hard_limit = policy.get("daily_image_access_hard_limit")
    bonus_quota = int(usage.get("image_access_bonus_quota", 0))
    accesses = int(usage.get("image_accesses", 0))
    effective_limit = None if base_limit is None else int(base_limit) + max(0, bonus_quota)
    return {
        "image_accesses_today": accesses,
        "image_access_bonus_quota_today": bonus_quota,
        "image_access_limit_today": effective_limit,
        "image_access_hard_limit_today": hard_limit,
    }


def _session_payload(request: Request, user: dict[str, Any]) -> dict[str, Any]:
    policy = user_store.get_effective_policy(user)
    verified_until = _generation_turnstile_valid_until(request)
    return {
        "authenticated": True,
        "user": {
            **user,
            "policy": policy,
        },
        "usage": _usage_payload(user, policy),
        "generation_turnstile_verified_until": verified_until.isoformat() if verified_until is not None else None,
    }


async def _verify_turnstile_or_raise(request: Request, token: str) -> dict[str, Any]:
    if settings.test_env_admin_bypass:
        bypass_user = _get_test_env_admin_user_or_none()
        if bypass_user:
            request.state.current_user = bypass_user
            return {"success": True, "hostname": "test-env-admin-bypass"}

    if not settings.turnstile_secret_key:
        raise api_error(
            ErrorCode.INVALID_INPUT,
            "Turnstile secret is not configured",
            http_status=503,
        )

    remote_ip = request.client.host if request.client else None
    try:
        payload = await verify_turnstile_token(token, remote_ip)
    except Exception as exc:
        logger.exception("Turnstile verification request failed: %s", exc)
        raise api_error(
            ErrorCode.INVALID_INPUT,
            "Turnstile verification failed",
            http_status=502,
        ) from exc

    if not payload.get("success"):
        raise api_error(
            ErrorCode.FORBIDDEN,
            "Turnstile verification failed",
            http_status=403,
            details={"error_codes": payload.get("error-codes") or []},
        )
    return payload


def _image_access_verification_required(user: dict[str, Any]) -> dict[str, Any] | None:
    if str(user.get("role") or "").upper() == "ADMIN":
        return None

    policy = user_store.get_effective_policy(user)
    usage = user_store.get_daily_usage(str(user["user_id"]))
    accesses = int(usage.get("image_accesses", 0))
    base_limit = policy.get("daily_image_access_limit")
    hard_limit = policy.get("daily_image_access_hard_limit")

    if hard_limit is not None and accesses >= int(hard_limit):
        raise api_error(
            ErrorCode.QUOTA_EXCEEDED,
            "Image access limit reached for today",
            http_status=429,
            details={
                "turnstile_scope": "image_access",
                "image_accesses_today": accesses,
                "daily_image_access_hard_limit": int(hard_limit),
            },
        )

    if base_limit is None:
        return None

    granted_bonus = int(usage.get("image_access_bonus_quota", 0))
    allowed_without_new_verification = int(base_limit) + granted_bonus
    if accesses < allowed_without_new_verification:
        return None

    return {
        "turnstile_scope": "image_access",
        "image_accesses_today": accesses,
        "daily_image_access_limit": int(base_limit),
        "image_access_bonus_quota_today": granted_bonus,
        "daily_image_access_hard_limit": int(hard_limit) if hard_limit is not None else None,
    }


def _requested_job_count_from_header(value: str | None) -> int:
    try:
        parsed = int(str(value or "1"))
    except Exception:
        return 1
    return max(1, min(parsed, 100))


def _assert_generation_allowed(
    request: Request,
    user: dict[str, Any],
    *,
    requested_job_count: int,
) -> dict[str, Any]:
    policy = user_store.get_effective_policy(user)
    policy_doc = user_store.get_policy()
    usage = _usage_payload(user, policy)
    quota_consumed = int(usage["quota_consumed_today"])

    daily_limit = policy.get("daily_image_limit")
    overflow_quota_mode = False
    if daily_limit is not None:
        normal_limit = int(daily_limit)
        extra_limit = int(policy_doc.get("default_user_extra_daily_image_limit") or 0)
        requested_total = quota_consumed + requested_job_count
        if requested_total > normal_limit + extra_limit:
            raise api_error(
                ErrorCode.QUOTA_EXCEEDED,
                f"Daily image limit exceeded ({daily_limit})",
                http_status=429,
                details={
                    "quota_consumed_today": quota_consumed,
                    "jobs_created_today": usage["jobs_created_today"],
                    "requested_job_count": requested_job_count,
                    "requested_total": requested_total,
                    "daily_image_limit": daily_limit,
                },
            )
        overflow_quota_mode = requested_total > normal_limit

    if str(user.get("role") or "").upper() == "ADMIN":
        return {
            "policy": policy,
            "consume_turnstile_batch_allowance": False,
            "overflow_quota_mode": False,
        }

    trigger_reasons: dict[str, Any] = {}
    requires_batch_turnstile = overflow_quota_mode
    job_threshold = policy.get("turnstile_job_count_threshold")
    if not overflow_quota_mode and job_threshold is not None and requested_job_count > int(job_threshold):
        trigger_reasons["job_count_threshold"] = int(job_threshold)
        requires_batch_turnstile = True

    daily_threshold = policy.get("turnstile_daily_usage_threshold")
    if not overflow_quota_mode and daily_threshold is not None and quota_consumed >= int(daily_threshold):
        trigger_reasons["daily_usage_threshold"] = int(daily_threshold)
    if overflow_quota_mode:
        trigger_reasons["requested_job_count"] = requested_job_count

    has_session_turnstile = _generation_turnstile_valid_until(request) is not None
    batch_allowance = _get_generation_turnstile_batch_allowance(request)
    has_batch_turnstile = (
        batch_allowance is not None
        and batch_allowance["requested_job_count"] == int(requested_job_count)
        and batch_allowance["remaining_uses"] > 0
    )
    if trigger_reasons and (
        not has_session_turnstile or (requires_batch_turnstile and not has_batch_turnstile)
    ):
        raise api_error(
            ErrorCode.TURNSTILE_REQUIRED,
            "Extra Turnstile verification is required before generating images",
            http_status=403,
            details={
                **trigger_reasons,
                "requested_job_count": requested_job_count,
                "quota_consumed_today": quota_consumed,
                "jobs_created_today": usage["jobs_created_today"],
                "images_generated_today": usage["images_generated_today"],
            },
        )

    return {
        "policy": policy,
        "consume_turnstile_batch_allowance": requires_batch_turnstile,
        "overflow_quota_mode": overflow_quota_mode,
    }


def _daily_user_payload(
    user: dict[str, Any],
    policy: dict[str, Any],
    usage_by_user: dict[str, dict[str, int]],
    job_counts: dict[str, dict[str, int]],
) -> dict[str, Any]:
    usage = usage_by_user.get(str(user["user_id"])) or {
        "jobs_created": 0,
        "jobs_succeeded": 0,
        "jobs_failed": 0,
        "images_generated": 0,
        "image_accesses": 0,
        "image_access_bonus_quota": 0,
        "quota_resets": 0,
    }
    counts = job_counts.get(str(user["user_id"])) or {"total_jobs": 0, "active_jobs": 0}
    daily_limit = policy.get("daily_image_limit")
    quota_consumed = int(usage["jobs_created"])
    remaining = None if daily_limit is None else max(0, int(daily_limit) - quota_consumed)
    return {
        **user,
        "policy": policy,
        "usage": {
            "date": now_local().date().isoformat(),
            "jobs_created_today": int(usage["jobs_created"]),
            "jobs_succeeded_today": int(usage["jobs_succeeded"]),
            "jobs_failed_today": int(usage["jobs_failed"]),
            "images_generated_today": int(usage["images_generated"]),
            "image_accesses_today": int(usage.get("image_accesses", 0)),
            "image_access_bonus_quota_today": int(usage.get("image_access_bonus_quota", 0)),
            "quota_consumed_today": quota_consumed,
            "quota_resets_today": int(usage["quota_resets"]),
            "active_jobs": int(counts["active_jobs"]),
            "remaining_images_today": remaining,
            **_image_access_usage_payload(user, policy),
        },
        "total_jobs": int(counts["total_jobs"]),
    }


def _parse_admin_time_bound(value: str | None, *, end_of_day: bool = False) -> datetime | None:
    dt = _parse_iso(value)
    if dt is None or not value:
        return None
    raw = str(value).strip()
    if "T" not in raw and " " not in raw and end_of_day:
        dt = dt + timedelta(days=1) - timedelta(microseconds=1)
    return dt


def _validate_announcement_time_window(starts_at: datetime | None, ends_at: datetime | None) -> None:
    if starts_at is not None and starts_at.tzinfo is None:
        local_tz = now_local().tzinfo
        if local_tz is not None:
            starts_at = starts_at.replace(tzinfo=local_tz)
    if ends_at is not None and ends_at.tzinfo is None:
        local_tz = now_local().tzinfo
        if local_tz is not None:
            ends_at = ends_at.replace(tzinfo=local_tz)
    if starts_at is not None and ends_at is not None and ends_at <= starts_at:
        raise api_error(ErrorCode.INVALID_INPUT, "Announcement ends_at must be later than starts_at", http_status=422)


def _request_prompt_preview(job_id: str, max_len: int = 120) -> str:
    try:
        request_payload = storage.load_request(job_id)
    except Exception:
        return ""
    prompt = str(request_payload.get("prompt") or "").strip()
    if not prompt:
        return ""
    prompt = " ".join(prompt.split())
    if len(prompt) <= max_len:
        return prompt
    return prompt[:max_len] + "…"


def _admin_job_summary(meta: dict[str, Any]) -> dict[str, Any]:
    result = meta.get("result") if isinstance(meta.get("result"), dict) else {}
    images = result.get("images") if isinstance(result.get("images"), list) else []
    first_image_id = None
    for item in images:
        if isinstance(item, dict):
            first_image_id = item.get("image_id") or item.get("id") or item.get("imageId")
            if first_image_id:
                break
        elif isinstance(item, str) and item:
            first_image_id = item
            break
    timing = meta.get("timing") if isinstance(meta.get("timing"), dict) else {}
    error = meta.get("error") if isinstance(meta.get("error"), dict) else {}
    owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
    return {
        "job_id": str(meta.get("job_id") or ""),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
        "status": str(meta.get("status") or "UNKNOWN"),
        "model": meta.get("model"),
        "prompt_preview": _request_prompt_preview(str(meta.get("job_id") or "")),
        "batch_id": meta.get("batch_id"),
        "batch_name": meta.get("batch_name"),
        "batch_note": meta.get("batch_note"),
        "batch_size": meta.get("batch_size"),
        "batch_index": meta.get("batch_index"),
        "section_index": meta.get("section_index"),
        "section_title": meta.get("section_title"),
        "timing": {
            "queued_at": timing.get("queued_at"),
            "started_at": timing.get("started_at"),
            "finished_at": timing.get("finished_at"),
            "queue_wait_ms": timing.get("queue_wait_ms"),
            "run_duration_ms": timing.get("run_duration_ms"),
        },
        "error": {
            "code": error.get("code"),
            "message": error.get("message"),
        }
        if error
        else None,
        "first_image_id": first_image_id,
        "image_count": len(images),
        "owner": {
            "user_id": owner.get("user_id"),
            "username": owner.get("username"),
            "role": owner.get("role"),
        },
    }


def _admin_job_sort_value(summary: dict[str, Any], sort: str) -> tuple[Any, ...]:
    created = _parse_iso(summary.get("created_at"))
    updated = _parse_iso(summary.get("updated_at"))
    duration = summary.get("timing", {}).get("run_duration_ms") if isinstance(summary.get("timing"), dict) else None
    created_ts = created.timestamp() if created else 0.0
    updated_ts = updated.timestamp() if updated else created_ts
    duration_ms = int(duration) if isinstance(duration, (int, float)) and math.isfinite(duration) else -1
    job_id = str(summary.get("job_id") or "")
    if sort == "created_asc":
        return (created_ts, job_id)
    if sort == "updated_desc":
        return (-updated_ts, job_id)
    if sort == "updated_asc":
        return (updated_ts, job_id)
    if sort == "duration_desc":
        return (-duration_ms, -created_ts, job_id)
    return (-created_ts, job_id)


def _admin_filtered_job_stats(items: list[dict[str, Any]]) -> dict[str, int]:
    stats = {
        "total": len(items),
        "active": 0,
        "running": 0,
        "queued": 0,
        "succeeded": 0,
        "failed": 0,
        "cancelled": 0,
    }
    for item in items:
        status_value = str(item.get("status") or "")
        if status_value in {"RUNNING", "QUEUED"}:
            stats["active"] += 1
        if status_value == "RUNNING":
            stats["running"] += 1
        elif status_value == "QUEUED":
            stats["queued"] += 1
        elif status_value == "SUCCEEDED":
            stats["succeeded"] += 1
        elif status_value == "FAILED":
            stats["failed"] += 1
        elif status_value == "CANCELLED":
            stats["cancelled"] += 1
    return stats


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    logger.warning("HTTP exception: status=%s detail=%s", exc.status_code, exc.detail)
    if isinstance(exc.detail, dict) and "error" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return _error_json(exc.status_code, ErrorCode.INVALID_INPUT, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    logger.warning("Validation error: %s", exc.errors())
    return _error_json(
        status.HTTP_400_BAD_REQUEST,
        ErrorCode.INVALID_INPUT,
        "Request validation failed",
        {"issues": exc.errors()},
    )


@app.get(f"{settings.api_prefix}/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(time=now_local(), version=settings.app_version, deployed_at=APP_DEPLOYED_AT)


@app.post(f"{settings.api_prefix}/auth/login")
async def login(payload: LoginRequest, request: Request) -> dict[str, Any]:
    bypass_user = _get_test_env_admin_user_or_none()
    if bypass_user:
        request.state.current_user = bypass_user
        request.session.clear()
        return _session_payload(request, bypass_user)

    await _verify_turnstile_or_raise(request, payload.turnstile_token)

    user = user_store.authenticate(payload.username, payload.password)
    if not user:
        raise api_error(
            ErrorCode.INVALID_CREDENTIALS,
            "Invalid username or password",
            http_status=401,
        )

    request.session.clear()
    request.session["user_id"] = user["user_id"]
    request.session["login_turnstile_verified_at"] = now_local().isoformat()
    if str(user.get("role") or "").upper() == "ADMIN":
        request.session["generation_turnstile_verified_until"] = (
            now_local() + timedelta(seconds=settings.session_max_age_sec)
        ).isoformat()
    return _session_payload(request, user)


@app.post(f"{settings.api_prefix}/auth/logout")
async def logout(request: Request, _: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    request.session.clear()
    return {"logged_out": True}


@app.get(f"{settings.api_prefix}/auth/me")
async def auth_me(request: Request, current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return _session_payload(request, current_user)


@app.get(f"{settings.api_prefix}/announcements/active", response_model=AnnouncementListResponse)
async def active_announcements(current_user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    items = announcement_store.list_active_for_user(current_user)
    return {
        "server_time": now_local(),
        "items": items,
    }


@app.post(
    f"{settings.api_prefix}/announcements/{{announcement_id}}/dismiss",
    response_model=DismissAnnouncementResponse,
)
async def dismiss_announcement(
    announcement_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if str(current_user.get("role") or "").upper() == "ADMIN":
        return {"success": True, "announcement_id": announcement_id}
    announcement_store.dismiss_announcement(str(current_user.get("user_id") or ""), announcement_id)
    return {"success": True, "announcement_id": announcement_id}


@app.post(f"{settings.api_prefix}/auth/turnstile/generation")
async def verify_generation_turnstile(
    payload: TurnstileVerifyRequest,
    request: Request,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if str(current_user.get("role") or "").upper() != "ADMIN":
        await _verify_turnstile_or_raise(request, payload.turnstile_token)
        _mark_generation_turnstile_verified(request)
        _clear_generation_turnstile_batch_allowance(request)
        _clear_overquota_pending_batch(request)
        if payload.requested_job_count is not None:
            _set_generation_turnstile_batch_allowance(request, int(payload.requested_job_count))
    return _session_payload(request, current_user)


@app.post(f"{settings.api_prefix}/auth/turnstile/image-access")
async def verify_image_access_turnstile(
    payload: TurnstileVerifyRequest,
    request: Request,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if str(current_user.get("role") or "").upper() != "ADMIN":
        await _verify_turnstile_or_raise(request, payload.turnstile_token)
        policy = user_store.get_effective_policy(current_user)
        bonus_quota = int(policy.get("image_access_turnstile_bonus_quota") or 0)
        if bonus_quota > 0:
            user_store.grant_image_access_bonus(str(current_user["user_id"]), bonus_quota)
    return {
        "verified": True,
        "scope": "image_access",
    }


def _parse_job_params(raw: dict[str, Any]) -> JobParams:
    params = JobParams(**raw)
    if params.timeout_sec < settings.job_timeout_sec_min or params.timeout_sec > settings.job_timeout_sec_max:
        raise api_error(
            ErrorCode.INVALID_INPUT,
            f"timeout_sec must be between {settings.job_timeout_sec_min} and {settings.job_timeout_sec_max}",
            http_status=400,
        )
    return params


def _validate_and_normalize_request(req: CreateJobRequest) -> CreateJobRequest:
    model = (req.model or settings.default_model).strip()
    spec = get_model_spec(model)
    if not spec:
        allowed = ", ".join(s.model_id for s in list_model_specs())
        raise api_error(
            ErrorCode.INVALID_INPUT,
            f"Unsupported model '{model}'. allowed=[{allowed}]",
            http_status=400,
        )

    mode = normalize_mode(req.mode)
    if mode not in {MODE_IMAGE_ONLY, MODE_TEXT_AND_IMAGE}:
        raise api_error(
            ErrorCode.INVALID_INPUT,
            f"Unsupported mode '{mode}'. allowed=[{MODE_IMAGE_ONLY}, {MODE_TEXT_AND_IMAGE}]",
            http_status=400,
        )
    if mode not in spec.supported_modes:
        raise api_error(
            ErrorCode.INVALID_INPUT,
            f"mode '{mode}' is not supported by model '{model}'. allowed={list(spec.supported_modes)}",
            http_status=400,
        )

    raw_thinking_level = req.params.thinking_level
    params = _parse_job_params(normalize_params_for_model(model, req.params.model_dump()))
    if params.aspect_ratio not in spec.supported_aspect_ratios:
        raise api_error(
            ErrorCode.INVALID_INPUT,
            f"aspect_ratio '{params.aspect_ratio}' is not supported by model '{model}'. "
            f"allowed={list(spec.supported_aspect_ratios)}",
            http_status=400,
        )
    if spec.supports_image_size:
        if params.image_size not in spec.supported_image_sizes:
            raise api_error(
                ErrorCode.INVALID_INPUT,
                f"image_size '{params.image_size}' is not supported by model '{model}'. "
                f"allowed={list(spec.supported_image_sizes)}",
                http_status=400,
            )
    else:
        params = params.model_copy(update={"image_size": "AUTO"})

    if spec.supports_thinking_level:
        thinking_level = params.thinking_level
        if thinking_level and thinking_level not in spec.supported_thinking_levels:
            raise api_error(
                ErrorCode.INVALID_INPUT,
                f"thinking_level '{thinking_level}' is not supported by model '{model}'. "
                f"allowed={list(spec.supported_thinking_levels)}",
                http_status=400,
            )
    elif raw_thinking_level:
        raise api_error(
            ErrorCode.INVALID_INPUT,
            f"thinking_level is not supported by model '{model}'",
            http_status=400,
        )

    return CreateJobRequest(
        prompt=req.prompt,
        model=model,  # type: ignore[arg-type]
        params=params,
        mode=mode,  # type: ignore[arg-type]
    )


def _assert_provider_override_allowed(req: CreateJobRequest, current_user: dict[str, Any]) -> None:
    provider_id = req.params.provider_id
    if not provider_id:
        return
    if str(current_user.get("role") or "").upper() != "ADMIN":
        raise api_error(ErrorCode.FORBIDDEN, "Only admins can specify provider_id", http_status=403)
    config = provider_store.get_provider_config(provider_id)
    if config is None:
        raise api_error(ErrorCode.INVALID_INPUT, f"Unknown provider_id '{provider_id}'", http_status=400)
    if req.model not in config.supported_models:
        raise api_error(
            ErrorCode.INVALID_INPUT,
            f"Provider '{provider_id}' does not support model '{req.model}'",
            http_status=400,
        )


def _build_overquota_batch(
    request: Request,
    *,
    req: CreateJobRequest,
    refs: list[ReferenceImage],
    current_user: dict[str, Any],
    requested_job_count: int,
) -> dict[str, Any]:
    jobs: list[dict[str, Any]] = []
    should_run_real_job = random.random() < float(settings.overquota_real_job_run_probability)

    if should_run_real_job:
        real_job_id, real_token, real_status, real_created_at = job_manager.create_job(
            req,
            refs,
            current_user,
            requested_job_count=requested_job_count,
        )
    else:
        real_job_id, real_token, real_status, real_created_at = job_manager.create_failed_job(
            req,
            refs,
            current_user,
            requested_job_count=requested_job_count,
        )
    jobs.append(
        {
            "job_id": real_job_id,
            "job_access_token": real_token,
            "status": real_status.value if isinstance(real_status, JobStatus) else str(real_status),
            "created_at": real_created_at.isoformat(),
        }
    )

    for _ in range(max(0, requested_job_count - 1)):
        failed_job_id, failed_token, failed_status, failed_created_at = job_manager.create_failed_job(
            req,
            refs,
            current_user,
            requested_job_count=requested_job_count,
        )
        jobs.append(
            {
                "job_id": failed_job_id,
                "job_access_token": failed_token,
                "status": failed_status.value if isinstance(failed_status, JobStatus) else str(failed_status),
                "created_at": failed_created_at.isoformat(),
            }
        )

    _clear_generation_turnstile_batch_allowance(request)
    first, rest = jobs[0], jobs[1:]
    if rest:
        _store_overquota_pending_batch(
            request,
            user_id=str(current_user["user_id"]),
            requested_job_count=requested_job_count,
            jobs=rest,
        )
    else:
        _clear_overquota_pending_batch(request)
    return first


async def _parse_create_request(request: Request) -> tuple[CreateJobRequest, list[ReferenceImage]]:
    content_type = (request.headers.get("content-type") or "").lower()
    default_model = settings.default_model if get_model_spec(settings.default_model) else DEFAULT_MODEL_ID

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        prompt = str(form.get("prompt", "")).strip()
        model = str(form.get("model", default_model)).strip()
        mode = normalize_mode(str(form.get("mode", MODE_IMAGE_ONLY)))
        params_raw: dict[str, Any] = {}
        if form.get("params"):
            params_raw = json.loads(str(form.get("params")))
        else:
            params_raw = {
                "aspect_ratio": form.get("aspect_ratio", "1:1"),
                "image_size": form.get("image_size", "1K"),
                "thinking_level": form.get("thinking_level"),
                "provider_id": form.get("provider_id"),
                "temperature": float(form.get("temperature", 0.7)),
                "timeout_sec": int(form.get("timeout_sec", settings.job_timeout_sec_default)),
                "max_retries": int(form.get("max_retries", 1)),
            }
        req = CreateJobRequest(prompt=prompt, model=model, params=_parse_job_params(params_raw), mode=mode)

        refs: list[ReferenceImage] = []
        files = form.getlist("reference_images")
        for file in files:
            if not getattr(file, "filename", None):
                continue
            content = await file.read()
            mime = file.content_type or "application/octet-stream"
            if not mime.startswith("image/"):
                raise api_error(ErrorCode.INVALID_INPUT, "reference_images must be image files", http_status=400)
            refs.append(ReferenceImage(mime_type=mime, data=content))
        return _validate_and_normalize_request(req), refs

    data = await request.json()
    params = _parse_job_params(data.get("params") or {})
    req = CreateJobRequest(
        prompt=data.get("prompt", ""),
        model=data.get("model", default_model),
        params=params,
        mode=normalize_mode(data.get("mode", MODE_IMAGE_ONLY)),
    )

    refs: list[ReferenceImage] = []
    for item in data.get("reference_images", []):
        mime = item.get("mime") or "image/png"
        b64 = item.get("data_base64")
        if not b64:
            continue
        import base64

        refs.append(ReferenceImage(mime_type=mime, data=base64.b64decode(b64)))

    return _validate_and_normalize_request(req), refs


def _normalize_job_refs(raw_refs: list[Any], *, limit: int) -> list[tuple[str, str | None]]:
    refs: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    for item in raw_refs:
        if len(refs) >= limit:
            break
        job_id = str(getattr(item, "job_id", "") or "").strip()
        if not job_id or job_id in seen:
            continue
        token = getattr(item, "job_access_token", None)
        token_value = str(token).strip() if isinstance(token, str) else None
        refs.append((job_id, token_value or None))
        seen.add(job_id)
    return refs


def _as_int(value: Any, default: int = 0) -> int:
    try:
        n = int(value)
    except Exception:
        return default
    return n


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        n = float(value)
    except Exception:
        return default
    if not math.isfinite(n):
        return default
    return n


def _parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value))
    except Exception:
        return None
    if dt.tzinfo is None:
        local_tz = now_local().tzinfo
        if local_tz is not None:
            dt = dt.replace(tzinfo=local_tz)
    return dt


def _status_snapshot(meta: dict[str, Any]) -> dict[str, Any]:
    result = meta.get("result") if isinstance(meta.get("result"), dict) else {}
    images = result.get("images") if isinstance(result.get("images"), list) else []
    first_image_id = None
    if images:
        first = images[0]
        if isinstance(first, dict):
            first_image_id = first.get("image_id") or first.get("id") or first.get("imageId")
    return {
        "job_id": meta.get("job_id"),
        "status": meta.get("status"),
        "model": meta.get("model"),
        "updated_at": meta.get("updated_at"),
        "timing": meta.get("timing") if isinstance(meta.get("timing"), dict) else {},
        "error": meta.get("error") if isinstance(meta.get("error"), dict) else None,
        "first_image_id": first_image_id,
        "image_count": len(images),
    }


def _meta_with_fields(meta: dict[str, Any], fields: set[str] | None) -> dict[str, Any]:
    if not fields:
        return meta
    view: dict[str, Any] = {}
    for key in fields:
        if key in meta:
            view[key] = meta[key]
    if "job_id" not in view and "job_id" in meta:
        view["job_id"] = meta["job_id"]
    return view


def _extract_latency_ms(meta: dict[str, Any]) -> int | None:
    timing = meta.get("timing") if isinstance(meta.get("timing"), dict) else {}
    run_duration = timing.get("run_duration_ms")
    if isinstance(run_duration, (int, float)) and math.isfinite(run_duration) and run_duration >= 0:
        return int(run_duration)
    response = meta.get("response") if isinstance(meta.get("response"), dict) else {}
    latency = response.get("latency_ms")
    if isinstance(latency, (int, float)) and math.isfinite(latency) and latency >= 0:
        return int(latency)
    return None


def _percentile(values: list[int], p: float) -> float:
    if not values:
        return 0.0
    arr = sorted(values)
    idx = (p / 100.0) * (len(arr) - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return float(arr[lo])
    w = idx - lo
    return float(arr[lo] * (1 - w) + arr[hi] * w)


def _safe_mean(values: list[int] | list[float]) -> float:
    if not values:
        return 0.0
    return float(sum(values) / len(values))


def _compute_dashboard_stats(metas: list[dict[str, Any]]) -> dict[str, Any]:
    now = now_local()
    today = now.date()
    cutoff = now - timedelta(days=7)

    def sort_ts(meta: dict[str, Any]) -> float:
        dt = _parse_iso(meta.get("created_at")) or _parse_iso(meta.get("updated_at"))
        return dt.timestamp() if dt else 0.0

    sorted_metas = sorted(metas, key=sort_ts, reverse=True)
    today_jobs: list[dict[str, Any]] = []
    for meta in sorted_metas:
        created = _parse_iso(meta.get("created_at"))
        if created and created.date() == today:
            today_jobs.append(meta)

    recent_jobs = sorted_metas[:10]

    def status_of(meta: dict[str, Any]) -> str:
        return str(meta.get("status") or "UNKNOWN")

    today_count = len(today_jobs)
    today_success = sum(1 for m in today_jobs if status_of(m) == "SUCCEEDED")
    today_failed = sum(1 for m in today_jobs if status_of(m) == "FAILED")
    today_success_rate = (today_success / today_count) if today_count else 0.0

    today_total_tokens = sum(
        _as_int((m.get("usage") or {}).get("total_token_count"), 0)
        for m in today_jobs
    )
    today_total_cost_usd = sum(
        _as_float((m.get("billing") or {}).get("estimated_cost_usd"), 0.0)
        for m in today_jobs
    )

    today_latencies = [v for v in (_extract_latency_ms(m) for m in today_jobs) if isinstance(v, int)]
    today_avg_latency_ms = _safe_mean(today_latencies)
    today_p95_latency_ms = _percentile(today_latencies, 95)

    recent_success = sum(1 for m in recent_jobs if status_of(m) == "SUCCEEDED")
    recent10_success_rate = (recent_success / len(recent_jobs)) if recent_jobs else 0.0

    recent_lat = [v for v in (_extract_latency_ms(m) for m in recent_jobs) if isinstance(v, int)]
    recent10_avg_latency_ms = _safe_mean(recent_lat)

    recent_cost = [
        _as_float((m.get("billing") or {}).get("estimated_cost_usd"), float("nan"))
        for m in recent_jobs
    ]
    recent_cost = [v for v in recent_cost if math.isfinite(v) and v >= 0]
    recent10_avg_cost_usd = _safe_mean(recent_cost)

    recent_img_cost = [
        _as_float((m.get("billing") or {}).get("image_output_cost_usd"), float("nan"))
        for m in recent_jobs
    ]
    recent_img_cost = [v for v in recent_img_cost if math.isfinite(v) and v >= 0]
    recent10_avg_image_cost_usd = _safe_mean(recent_img_cost)

    failure_count: dict[str, int] = {}
    for meta in sorted_metas[:30]:
        created = _parse_iso(meta.get("created_at"))
        if not created or created < cutoff:
            continue
        if status_of(meta) != "FAILED":
            continue
        error = meta.get("error") if isinstance(meta.get("error"), dict) else {}
        name = str(error.get("type") or "UNKNOWN_ERROR")
        failure_count[name] = failure_count.get(name, 0) + 1
    failure_top = [
        {"name": name, "value": value}
        for name, value in sorted(failure_count.items(), key=lambda x: x[1], reverse=True)[:5]
    ]

    def _dist(key: str) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for meta in sorted_metas[:200]:
            params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
            value = params.get(key)
            if value is None:
                continue
            name = str(value)
            if not name:
                continue
            counts[name] = counts.get(name, 0) + 1
        return [
            {"name": name, "value": value}
            for name, value in sorted(counts.items(), key=lambda x: x[1], reverse=True)
        ]

    image_size_dist = _dist("image_size")
    aspect_ratio_dist = _dist("aspect_ratio")

    temp_counts: dict[str, int] = {}
    for meta in sorted_metas[:200]:
        params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
        temp = params.get("temperature")
        if not isinstance(temp, (int, float)) or not math.isfinite(temp):
            continue
        if temp < 0.3:
            bucket = "<0.3"
        elif temp < 0.7:
            bucket = "0.3~0.7"
        elif temp < 1.0:
            bucket = "0.7~1.0"
        else:
            bucket = ">=1.0"
        temp_counts[bucket] = temp_counts.get(bucket, 0) + 1
    temperature_dist = [{"name": k, "value": v} for k, v in temp_counts.items()]

    bucket_tokens: dict[str, int] = {}
    bucket_cost: dict[str, float] = {}
    for meta in today_jobs:
        created = _parse_iso(meta.get("created_at"))
        if not created:
            continue
        h = f"{created.hour:02d}:00"
        bucket_tokens[h] = bucket_tokens.get(h, 0) + _as_int((meta.get("usage") or {}).get("total_token_count"), 0)
        bucket_cost[h] = bucket_cost.get(h, 0.0) + _as_float((meta.get("billing") or {}).get("estimated_cost_usd"), 0.0)
    hours = [f"{idx:02d}:00" for idx in range(24)]
    trend_tokens = [{"t": h, "tokens": bucket_tokens.get(h, 0)} for h in hours]
    trend_cost = [{"t": h, "cost": bucket_cost.get(h, 0.0)} for h in hours]

    return {
        "today_count": today_count,
        "today_success": today_success,
        "today_failed": today_failed,
        "today_success_rate": today_success_rate,
        "today_total_tokens": today_total_tokens,
        "today_total_cost_usd": today_total_cost_usd,
        "today_avg_latency_ms": today_avg_latency_ms,
        "today_p95_latency_ms": today_p95_latency_ms,
        "recent10_success_rate": recent10_success_rate,
        "recent10_avg_latency_ms": recent10_avg_latency_ms,
        "recent10_avg_cost_usd": recent10_avg_cost_usd,
        "recent10_avg_image_cost_usd": recent10_avg_image_cost_usd,
        "failure_top": failure_top,
        "image_size_dist": image_size_dist,
        "aspect_ratio_dist": aspect_ratio_dist,
        "temperature_dist": temperature_dist,
        "trend_tokens": trend_tokens,
        "trend_cost": trend_cost,
    }


@app.get(f"{settings.api_prefix}/models", response_model=ModelsResponse)
async def list_models(_: dict[str, Any] = Depends(get_current_user)) -> ModelsResponse:
    default_model = settings.default_model.strip()
    if not get_model_spec(default_model):
        default_model = DEFAULT_MODEL_ID
    payload = ModelsResponse(
        default_model=default_model,  # type: ignore[arg-type]
        models=[ModelCapability(**model_capability_payload(spec)) for spec in list_model_specs()],
    )
    return payload


@app.post(f"{settings.api_prefix}/jobs/batch-meta")
async def jobs_batch_meta(
    payload: BatchMetaRequest,
    request: Request,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    job_read_rate_limit(request)
    refs = _normalize_job_refs(payload.jobs, limit=500)

    allowed_fields = {
        "job_id",
        "created_at",
        "updated_at",
        "status",
        "model",
        "mode",
        "params",
        "timing",
        "usage",
        "billing",
        "result",
        "response",
        "error",
        "auth",
        "owner",
    }
    fields = None
    if payload.fields:
        fields = {x for x in payload.fields if x in allowed_fields}

    items: list[dict[str, Any]] = []
    forbidden: list[str] = []
    not_found: list[str] = []
    failed: list[dict[str, str]] = []

    for job_id, token in refs:
        try:
            meta = job_manager.get_meta(job_id, token, current_user)
        except HTTPException as exc:
            if exc.status_code == 403:
                forbidden.append(job_id)
            elif exc.status_code == 404:
                not_found.append(job_id)
            else:
                failed.append({"job_id": job_id, "message": str(exc.detail)})
            continue
        items.append({"job_id": job_id, "meta": _meta_with_fields(meta, fields)})

    return {
        "items": items,
        "forbidden": forbidden,
        "not_found": not_found,
        "failed": failed,
        "requested": len(refs),
        "ok": len(items),
    }


@app.post(f"{settings.api_prefix}/jobs/active")
async def jobs_active_snapshot(
    payload: ActiveJobsRequest,
    request: Request,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    job_read_rate_limit(request)
    refs = _normalize_job_refs(payload.jobs, limit=500)

    active: list[dict[str, Any]] = []
    settled: list[dict[str, Any]] = []
    forbidden: list[str] = []
    not_found: list[str] = []
    failed: list[dict[str, str]] = []

    for job_id, token in refs:
        try:
            meta = job_manager.get_meta(job_id, token, current_user)
        except HTTPException as exc:
            if exc.status_code == 403:
                forbidden.append(job_id)
            elif exc.status_code == 404:
                not_found.append(job_id)
            else:
                failed.append({"job_id": job_id, "message": str(exc.detail)})
            continue

        snap = _status_snapshot(meta)
        status_ = str(meta.get("status") or "UNKNOWN")
        if status_ in {"RUNNING", "QUEUED"}:
            active.append(snap)
        else:
            settled.append(snap)

    def _sort_key(item: dict[str, Any]) -> float:
        dt = _parse_iso(item.get("updated_at"))
        return dt.timestamp() if dt else 0.0

    active = sorted(active, key=_sort_key, reverse=True)[: payload.limit]
    settled = sorted(settled, key=_sort_key, reverse=True)[: payload.limit]

    return {
        "active": active,
        "settled": settled,
        "forbidden": forbidden,
        "not_found": not_found,
        "failed": failed,
        "requested": len(refs),
        "active_count": len(active),
        "settled_count": len(settled),
    }


@app.post(f"{settings.api_prefix}/dashboard/summary")
async def dashboard_summary(
    payload: DashboardSummaryRequest,
    request: Request,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    job_read_rate_limit(request)
    refs = _normalize_job_refs(payload.jobs, limit=payload.limit)

    metas: list[dict[str, Any]] = []
    updates: list[dict[str, Any]] = []
    forbidden: list[str] = []
    not_found: list[str] = []
    failed: list[dict[str, str]] = []

    for job_id, token in refs:
        try:
            meta = job_manager.get_meta(job_id, token, current_user)
        except HTTPException as exc:
            if exc.status_code == 403:
                forbidden.append(job_id)
            elif exc.status_code == 404:
                not_found.append(job_id)
            else:
                failed.append({"job_id": job_id, "message": str(exc.detail)})
            continue
        metas.append(meta)
        updates.append(_status_snapshot(meta))

    stats = _compute_dashboard_stats(metas)
    return {
        "stats": stats,
        "updates": updates,
        "forbidden": forbidden,
        "not_found": not_found,
        "failed": failed,
        "requested": len(refs),
        "ok": len(metas),
    }


@app.post(f"{settings.api_prefix}/jobs", response_model=CreateJobResponse, status_code=status.HTTP_201_CREATED)
async def create_job(
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    x_requested_job_count: str | None = Header(default=None, alias="X-Requested-Job-Count"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> CreateJobResponse:
    requested_job_count = _requested_job_count_from_header(x_requested_job_count)
    pending_job = _pop_overquota_pending_job(
        request,
        user_id=str(current_user["user_id"]),
        requested_job_count=requested_job_count,
    )
    if pending_job is not None:
        return CreateJobResponse(
            job_id=str(pending_job["job_id"]),
            job_access_token=pending_job.get("job_access_token"),
            status=JobStatus(str(pending_job.get("status") or JobStatus.FAILED.value)),
            created_at=datetime.fromisoformat(str(pending_job["created_at"])),
        )

    gate = _assert_generation_allowed(request, current_user, requested_job_count=requested_job_count)
    req, refs = await _parse_create_request(request)
    _assert_provider_override_allowed(req, current_user)
    if gate["overflow_quota_mode"]:
        batch_job = _build_overquota_batch(
            request,
            req=req,
            refs=refs,
            current_user=current_user,
            requested_job_count=requested_job_count,
        )
        return CreateJobResponse(
            job_id=str(batch_job["job_id"]),
            job_access_token=batch_job.get("job_access_token"),
            status=JobStatus(str(batch_job.get("status") or JobStatus.FAILED.value)),
            created_at=datetime.fromisoformat(str(batch_job["created_at"])),
        )

    job_id, token, status_, created_at = job_manager.create_job(
        req,
        refs,
        current_user,
        requested_job_count=requested_job_count,
        idempotency_key=idempotency_key,
    )
    if gate["consume_turnstile_batch_allowance"]:
        _consume_generation_turnstile_batch_allowance(request, requested_job_count)
    return CreateJobResponse(job_id=job_id, job_access_token=token, status=status_, created_at=created_at)


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}", dependencies=[Depends(job_read_rate_limit)])
async def get_job(
    job_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    return job_manager.get_meta(job_id, x_job_token, current_user)


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/request", dependencies=[Depends(job_read_rate_limit)])
async def get_job_request(
    job_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    return {"job_id": job_id, "request": job_manager.get_request(job_id, x_job_token, current_user)}


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/response", dependencies=[Depends(job_read_rate_limit)])
async def get_job_response(
    job_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    return {"job_id": job_id, "response": job_manager.get_response(job_id, x_job_token, current_user)}


@app.post(f"{settings.api_prefix}/jobs/previews/batch")
async def jobs_batch_previews(
    payload: BatchPreviewRequest,
    request: Request,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    job_read_rate_limit(request)
    raw_images = payload.images[: max(1, int(settings.preview_batch_limit))]

    items: list[dict[str, Any]] = []
    forbidden: list[dict[str, str]] = []
    not_found: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []

    for item in raw_images:
        job_id = str(item.job_id or "")
        image_id = str(item.image_id or "")
        token = item.job_access_token
        if not validate_job_id(job_id) or not validate_image_id(image_id):
            not_found.append({"job_id": job_id, "image_id": image_id})
            continue
        try:
            image_bytes, mime = job_manager.get_preview_image(job_id, token, image_id, current_user)
        except HTTPException as exc:
            if exc.status_code == 403:
                forbidden.append({"job_id": job_id, "image_id": image_id})
            elif exc.status_code == 404:
                not_found.append({"job_id": job_id, "image_id": image_id})
            else:
                failed.append({"job_id": job_id, "image_id": image_id, "message": str(exc.detail)})
            continue
        items.append(
            {
                "job_id": job_id,
                "image_id": image_id,
                "mime": mime,
                "size_bytes": len(image_bytes),
                "data_base64": base64.b64encode(image_bytes).decode("ascii"),
            }
        )

    return {
        "items": items,
        "forbidden": forbidden,
        "not_found": not_found,
        "failed": failed,
        "requested": len(raw_images),
        "ok": len(items),
        "limit": int(settings.preview_batch_limit),
    }


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/images/{{image_id}}", dependencies=[Depends(job_read_rate_limit)])
async def get_job_image(
    job_id: str,
    image_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> Response:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    if not validate_image_id(image_id):
        raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Image not found", http_status=404)

    image_access_gate = _image_access_verification_required(current_user)
    if image_access_gate is not None:
        raise api_error(
            ErrorCode.TURNSTILE_REQUIRED,
            "Extra Turnstile verification is required before viewing images",
            http_status=403,
            details=image_access_gate,
        )

    image_bytes, mime = job_manager.get_image(job_id, x_job_token, image_id, current_user)
    if str(current_user.get("role") or "").upper() != "ADMIN":
        user_store.record_image_access(str(current_user["user_id"]), 1)
    return Response(content=image_bytes, media_type=mime)


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/images/{{image_id}}/preview", dependencies=[Depends(job_read_rate_limit)])
async def get_job_preview_image(
    job_id: str,
    image_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> Response:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    if not validate_image_id(image_id):
        raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Image not found", http_status=404)

    image_bytes, mime = job_manager.get_preview_image(job_id, x_job_token, image_id, current_user)
    return Response(
        content=image_bytes,
        media_type=mime,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/references/{{ref_path:path}}", dependencies=[Depends(job_read_rate_limit)])
async def get_job_reference_image(
    job_id: str,
    ref_path: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> Response:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    image_bytes, mime = job_manager.get_input_reference(job_id, x_job_token, ref_path, current_user)
    return Response(content=image_bytes, media_type=mime)


async def _event_stream(job_id: str, token: str | None, user: dict[str, Any]) -> AsyncIterator[bytes]:
    last_status = None
    while True:
        try:
            meta = job_manager.get_meta(job_id, token, user)
        except Exception:
            payload = {"status": "FAILED", "error": "Job stream unavailable"}
            yield f"event: error\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")
            return

        status_ = meta.get("status")
        if status_ != last_status:
            payload = {
                "job_id": job_id,
                "status": status_,
                "usage": meta.get("usage"),
                "billing": meta.get("billing"),
                "result": meta.get("result"),
            }
            yield f"event: status\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")
            last_status = status_

        if status_ in {"SUCCEEDED", "FAILED", "CANCELLED", "DELETED"}:
            return

        import asyncio

        await asyncio.sleep(1)


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/events", dependencies=[Depends(job_read_rate_limit)])
async def get_job_events(
    job_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    job_manager.get_meta(job_id, x_job_token, current_user)
    return StreamingResponse(_event_stream(job_id, x_job_token, current_user), media_type="text/event-stream")


@app.delete(f"{settings.api_prefix}/jobs/{{job_id}}")
async def delete_job(
    job_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    job_manager.delete_job(job_id, x_job_token, current_user)
    return {"job_id": job_id, "deleted": True}


@app.post(f"{settings.api_prefix}/jobs/{{job_id}}/cancel")
async def cancel_job(
    job_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    return job_manager.cancel_job(job_id, x_job_token, current_user)


@app.post(f"{settings.api_prefix}/jobs/{{job_id}}/retry", status_code=status.HTTP_201_CREATED)
async def retry_job(
    request: Request,
    job_id: str,
    payload: RetryJobRequest,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    gate = _assert_generation_allowed(request, current_user, requested_job_count=1)
    if payload.override_params and payload.override_params.provider_id:
        current_meta = job_manager.get_meta(job_id, x_job_token, current_user)
        _assert_provider_override_allowed(
            CreateJobRequest(
                prompt="retry",
                model=current_meta.get("model", settings.default_model),
                params=payload.override_params,
                mode=current_meta.get("mode", MODE_IMAGE_ONLY),
            ),
            current_user,
        )
    new_job_id, new_token, _ = job_manager.retry_job(job_id, x_job_token, current_user, payload.override_params)
    if gate["consume_turnstile_batch_allowance"]:
        _consume_generation_turnstile_batch_allowance(request, 1)
    return {
        "new_job_id": new_job_id,
        "new_job_access_token": new_token,
    }


def _job_counts_by_user(metas: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for meta in metas:
        owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
        user_id = str(owner.get("user_id") or "")
        if not user_id:
            continue
        bucket = counts.setdefault(user_id, {"total_jobs": 0, "active_jobs": 0})
        bucket["total_jobs"] += 1
        if meta.get("status") in {"QUEUED", "RUNNING"}:
            bucket["active_jobs"] += 1
    return counts


def _provider_summary_payload() -> dict[str, Any]:
    providers = provider_store.list_provider_snapshots()
    enabled = sum(1 for item in providers if item.get("enabled"))
    healthy = sum(
        1
        for item in providers
        if item.get("enabled")
        and not item.get("cooldown_active")
        and item.get("quota_state") != "NO_QUOTA"
        and int(item.get("consecutive_failures") or 0) < 3
    )
    total_remaining = sum(float(item.get("remaining_balance_cny") or 0.0) for item in providers if item.get("remaining_balance_cny") is not None)
    total_spent = sum(float(item.get("total_spent_cny") or 0.0) for item in providers)
    return {
        "currency": "CNY",
        "providers_total": len(providers),
        "providers_enabled": enabled,
        "providers_healthy": healthy,
        "providers_cooldown": sum(1 for item in providers if item.get("cooldown_active")),
        "remaining_balance_cny": round(total_remaining, 4),
        "spent_cny": round(total_spent, 4),
        "last_updated_at": now_local().isoformat(),
        "providers": providers,
    }


def _admin_overview_payload() -> dict[str, Any]:
    now = now_local()
    metas = storage.iter_job_meta()
    users = user_store.list_users()
    usage_by_user = user_store.get_daily_usage_for_all()
    today = now.date()
    queued_jobs = 0
    running_jobs = 0
    active_jobs = 0
    succeeded_today = 0
    failed_today = 0
    images_generated_today = 0
    image_accesses_today = 0

    for meta in metas:
        status_value = str(meta.get("status") or "")
        if status_value == "QUEUED":
            queued_jobs += 1
            active_jobs += 1
        elif status_value == "RUNNING":
            running_jobs += 1
            active_jobs += 1

        created = _parse_iso(meta.get("created_at")) or _parse_iso(meta.get("updated_at"))
        if not created or created.date() != today:
            continue
        if status_value == "SUCCEEDED":
            succeeded_today += 1
            result = meta.get("result") if isinstance(meta.get("result"), dict) else {}
            images_generated_today += len(result.get("images") or [])
        elif status_value == "FAILED":
            failed_today += 1

    enabled_users = sum(1 for user in users if user.get("enabled"))
    image_accesses_today = sum(int(stats.get("image_accesses", 0)) for stats in usage_by_user.values())
    return {
        "system": {
            "app_version": settings.app_version,
            "deployed_at": APP_DEPLOYED_AT.isoformat(),
            "now": now.isoformat(),
            "uptime_sec": max(0, int((now - APP_DEPLOYED_AT).total_seconds())),
            "queue_size": job_manager.queue_size(),
            "worker_count": job_manager.worker_count(),
            "users_total": len(users),
            "users_enabled": enabled_users,
            "jobs_total": len(metas),
            "queued_jobs": queued_jobs,
            "running_jobs": running_jobs,
            "active_jobs": active_jobs,
            "succeeded_today": succeeded_today,
            "failed_today": failed_today,
            "images_generated_today": images_generated_today,
            "image_accesses_today": image_accesses_today,
        },
        "policy": user_store.get_policy(),
        "providers": _provider_summary_payload(),
    }


@app.get(f"{settings.api_prefix}/admin/overview")
async def admin_overview(_: dict[str, Any] = Depends(get_admin_user)) -> dict[str, Any]:
    return _admin_overview_payload()


@app.get(f"{settings.api_prefix}/admin/announcements", response_model=AnnouncementListResponse)
async def admin_announcements(_: dict[str, Any] = Depends(get_admin_user)) -> dict[str, Any]:
    return {
        "server_time": now_local(),
        "items": announcement_store.list_announcements(),
    }


@app.post(
    f"{settings.api_prefix}/admin/announcements",
    response_model=AnnouncementItem,
    status_code=status.HTTP_201_CREATED,
)
async def admin_create_announcement(
    payload: CreateAnnouncementRequest,
    current_user: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    _validate_announcement_time_window(payload.starts_at, payload.ends_at)
    return announcement_store.create_announcement(payload.model_dump(mode="json"), current_user)


@app.patch(
    f"{settings.api_prefix}/admin/announcements/{{announcement_id}}",
    response_model=AnnouncementItem,
)
async def admin_update_announcement(
    announcement_id: str,
    payload: UpdateAnnouncementRequest,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    patch = payload.model_dump(exclude_unset=True, mode="json")
    existing = announcement_store.get_announcement(announcement_id)
    if existing is None:
        raise api_error(ErrorCode.INVALID_INPUT, "Announcement not found", http_status=404)
    _validate_announcement_time_window(
        _parse_iso(patch.get("starts_at")) if "starts_at" in patch else _parse_iso(existing.get("starts_at")),
        _parse_iso(patch.get("ends_at")) if "ends_at" in patch else _parse_iso(existing.get("ends_at")),
    )
    updated = announcement_store.update_announcement(announcement_id, patch)
    if updated is None:
        raise api_error(ErrorCode.INVALID_INPUT, "Announcement not found", http_status=404)
    return updated


@app.delete(f"{settings.api_prefix}/admin/announcements/{{announcement_id}}")
async def admin_delete_announcement(
    announcement_id: str,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    deleted = announcement_store.delete_announcement(announcement_id)
    if not deleted:
        raise api_error(ErrorCode.INVALID_INPUT, "Announcement not found", http_status=404)
    return {"deleted": True, "announcement_id": announcement_id}


@app.get(f"{settings.api_prefix}/admin/users")
async def admin_users(_: dict[str, Any] = Depends(get_admin_user)) -> dict[str, Any]:
    users = user_store.list_users()
    policy_doc = user_store.get_policy()
    usage_by_user = user_store.get_daily_usage_for_all()
    job_counts = _job_counts_by_user(storage.iter_job_meta())
    items = [
        _daily_user_payload(user, user_store.get_effective_policy(user, policy_doc), usage_by_user, job_counts)
        for user in users
    ]
    return {"users": items}


@app.get(f"{settings.api_prefix}/admin/users/{{user_id}}/jobs")
async def admin_user_jobs(
    user_id: str,
    q: str = Query(default=""),
    status_value: str = Query(default="", alias="status"),
    model: str = Query(default=""),
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    batch_name: str = Query(default=""),
    has_images: bool | None = Query(default=None),
    failed_only: bool = Query(default=False),
    sort: str = Query(default="created_desc"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=24, ge=1, le=120),
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    user = user_store.get_user_by_id(user_id)
    if not user:
        raise api_error(ErrorCode.USER_NOT_FOUND, "User not found", http_status=404)

    query = str(q or "").strip().lower()
    status_filter = str(status_value or "").strip().upper()
    model_filter = str(model or "").strip()
    batch_filter = str(batch_name or "").strip().lower()
    from_dt = _parse_admin_time_bound(from_value)
    to_dt = _parse_admin_time_bound(to_value, end_of_day=True)

    summaries: list[dict[str, Any]] = []
    for meta in storage.iter_job_meta():
        owner = meta.get("owner") if isinstance(meta.get("owner"), dict) else {}
        if str(owner.get("user_id") or "") != str(user_id):
            continue
        summary = _admin_job_summary(meta)
        created_dt = _parse_iso(summary.get("created_at")) or _parse_iso(summary.get("updated_at"))
        if from_dt and (created_dt is None or created_dt < from_dt):
            continue
        if to_dt and (created_dt is None or created_dt > to_dt):
            continue
        if status_filter and str(summary.get("status") or "").upper() != status_filter:
            continue
        if failed_only and str(summary.get("status") or "").upper() not in {"FAILED", "CANCELLED"}:
            continue
        if model_filter and str(summary.get("model") or "") != model_filter:
            continue
        if has_images is not None:
            image_count = int(summary.get("image_count") or 0)
            if has_images and image_count <= 0:
                continue
            if has_images is False and image_count > 0:
                continue
        if batch_filter and batch_filter not in str(summary.get("batch_name") or "").lower():
            continue
        if query:
            haystack = " ".join(
                [
                    str(summary.get("job_id") or ""),
                    str(summary.get("prompt_preview") or ""),
                    str(summary.get("model") or ""),
                    str(summary.get("batch_name") or ""),
                    str(summary.get("section_title") or ""),
                    str((summary.get("error") or {}).get("message") or ""),
                    str((summary.get("error") or {}).get("code") or ""),
                ]
            ).lower()
            if query not in haystack:
                continue
        summaries.append(summary)

    summaries.sort(key=lambda item: _admin_job_sort_value(item, sort))
    stats = _admin_filtered_job_stats(summaries)
    offset = max(0, int(cursor or "0")) if str(cursor or "").strip().isdigit() else 0
    page_items = summaries[offset : offset + limit]
    next_cursor = str(offset + limit) if offset + limit < len(summaries) else None
    return {
        "user": {
            "user_id": user["user_id"],
            "username": user["username"],
            "role": user["role"],
            "enabled": user["enabled"],
        },
        "items": page_items,
        "next_cursor": next_cursor,
        "stats": stats,
        "requested_limit": limit,
    }


@app.post(f"{settings.api_prefix}/admin/users", status_code=status.HTTP_201_CREATED)
async def admin_create_user(
    payload: CreateUserRequest,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    if not validate_username(payload.username):
        raise api_error(ErrorCode.INVALID_INPUT, "username must be 3-32 chars: letters, numbers, _ . -", http_status=400)
    try:
        user = user_store.create_user(
            username=payload.username,
            password=payload.password,
            role=payload.role.value,
            enabled=payload.enabled,
            policy_overrides=payload.policy_overrides.model_dump(),
        )
    except ValueError as exc:
        if str(exc) == "USERNAME_TAKEN":
            raise api_error(ErrorCode.USERNAME_TAKEN, "Username already exists", http_status=409) from exc
        raise

    policy = user_store.get_effective_policy(user)
    return _daily_user_payload(user, policy, user_store.get_daily_usage_for_all(), {})


@app.patch(f"{settings.api_prefix}/admin/users/{{user_id}}")
async def admin_update_user(
    user_id: str,
    payload: UpdateUserRequest,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    user = user_store.update_user(
        user_id,
        password=payload.password,
        role=payload.role.value if payload.role is not None else None,
        enabled=payload.enabled,
        policy_overrides=payload.policy_overrides.model_dump() if payload.policy_overrides is not None else None,
    )
    if not user:
        raise api_error(ErrorCode.USER_NOT_FOUND, "User not found", http_status=404)

    policy_doc = user_store.get_policy()
    usage_by_user = user_store.get_daily_usage_for_all()
    job_counts = _job_counts_by_user(storage.iter_job_meta())
    return _daily_user_payload(user, user_store.get_effective_policy(user, policy_doc), usage_by_user, job_counts)


@app.post(f"{settings.api_prefix}/admin/users/{{user_id}}/reset-quota")
async def admin_reset_user_quota(
    user_id: str,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    user = user_store.get_user_by_id(user_id)
    if not user:
        raise api_error(ErrorCode.USER_NOT_FOUND, "User not found", http_status=404)
    user_store.reset_daily_usage(user_id)
    policy_doc = user_store.get_policy()
    usage_by_user = user_store.get_daily_usage_for_all()
    job_counts = _job_counts_by_user(storage.iter_job_meta())
    return _daily_user_payload(user, user_store.get_effective_policy(user, policy_doc), usage_by_user, job_counts)


@app.patch(f"{settings.api_prefix}/admin/policy")
async def admin_update_policy(
    payload: UpdateSystemPolicyRequest,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    policy = user_store.update_policy(payload.model_dump())
    return {"policy": policy}


@app.get(f"{settings.api_prefix}/admin/providers")
async def admin_providers(_: dict[str, Any] = Depends(get_admin_user)) -> dict[str, Any]:
    return _provider_summary_payload()


@app.get(f"{settings.api_prefix}/billing/summary", response_model=None)
async def billing_summary(_: dict[str, Any] = Depends(get_admin_user)) -> dict[str, Any]:
    return _provider_summary_payload()


@app.patch(f"{settings.api_prefix}/admin/providers/{{provider_id}}")
async def admin_update_provider(
    provider_id: str,
    payload: UpdateProviderRequest,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    updated = provider_store.update_provider(provider_id, enabled=payload.enabled, note=payload.note)
    if updated is None:
        raise api_error(ErrorCode.INVALID_INPUT, "Provider not found", http_status=404)
    return {"provider": updated}


@app.post(f"{settings.api_prefix}/admin/providers/{{provider_id}}/balance/set")
async def admin_set_provider_balance(
    provider_id: str,
    payload: SetProviderBalanceRequest,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    updated = provider_store.set_balance(provider_id, payload.amount_cny)
    if updated is None:
        raise api_error(ErrorCode.INVALID_INPUT, "Provider not found", http_status=404)
    return {"provider": updated}


@app.post(f"{settings.api_prefix}/admin/providers/{{provider_id}}/balance/add")
async def admin_add_provider_balance(
    provider_id: str,
    payload: AddProviderBalanceRequest,
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    updated = provider_store.add_balance(provider_id, payload.delta_cny)
    if updated is None:
        raise api_error(ErrorCode.INVALID_INPUT, "Provider not found", http_status=404)
    return {"provider": updated}


@app.get(f"{settings.api_prefix}/billing/google/remaining")
async def billing_google_remaining(
    _: dict[str, Any] = Depends(get_admin_user),
) -> dict[str, Any]:
    return JSONResponse(
        status_code=status.HTTP_410_GONE,
        content=GoogleRemainingUnconfiguredResponse(
            message="Legacy Google remaining endpoint has been removed. Use /v1/admin/providers instead."
        ).model_dump(),
    )
