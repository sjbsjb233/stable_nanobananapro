from __future__ import annotations

import json
import math
import time
from datetime import datetime, timedelta
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, Request, Response, status
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from .billing import current_month_period
from .config import ensure_data_dirs, get_cors_origins, settings
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
from .schemas import (
    ActiveJobsRequest,
    BatchMetaRequest,
    BillingSummaryModelItem,
    CreateJobRequest,
    CreateJobResponse,
    DashboardSummaryRequest,
    ErrorCode,
    ErrorResponse,
    GoogleRemainingConfiguredResponse,
    GoogleRemainingUnconfiguredResponse,
    HealthResponse,
    ModelCapability,
    ModelsResponse,
    JobParams,
    RetryJobRequest,
)
from .security import validate_image_id, validate_job_id
from .storage import storage
from .time_utils import now_local

logger = get_logger("api")
app = FastAPI(title="Nano Banana API", version=settings.app_version)
APP_DEPLOYED_AT = now_local()
cors_origins = get_cors_origins()
allow_credentials = settings.cors_allow_credentials
if "*" in cors_origins:
    # Browsers do not allow wildcard origin together with credentials.
    allow_credentials = False

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=allow_credentials,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Job-Token",
        "X-Admin-Key",
        "Idempotency-Key",
    ],
)


@app.on_event("startup")
def _startup() -> None:
    setup_logging()
    ensure_data_dirs()
    logger.info(
        "Backend startup: version=%s deployed_at=%s data_dir=%s",
        settings.app_version,
        APP_DEPLOYED_AT.isoformat(),
        settings.data_dir,
    )
    job_manager.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    job_manager.stop()
    logger.info("Backend shutdown complete")


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    started = time.perf_counter()
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
            "debug_id": __import__("uuid").uuid4().hex,
            "details": details or {},
        }
    }
    return JSONResponse(status_code=status_code, content=payload)


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
    return {
        "job_id": meta.get("job_id"),
        "status": meta.get("status"),
        "model": meta.get("model"),
        "updated_at": meta.get("updated_at"),
        "timing": meta.get("timing") if isinstance(meta.get("timing"), dict) else {},
        "error": meta.get("error") if isinstance(meta.get("error"), dict) else None,
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
async def list_models() -> ModelsResponse:
    default_model = settings.default_model.strip()
    if not get_model_spec(default_model):
        default_model = DEFAULT_MODEL_ID
    payload = ModelsResponse(
        default_model=default_model,  # type: ignore[arg-type]
        models=[ModelCapability(**model_capability_payload(spec)) for spec in list_model_specs()],
    )
    return payload


@app.post(f"{settings.api_prefix}/jobs/batch-meta")
async def jobs_batch_meta(payload: BatchMetaRequest, request: Request) -> dict[str, Any]:
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
            meta = job_manager.get_meta(job_id, token)
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
async def jobs_active_snapshot(payload: ActiveJobsRequest, request: Request) -> dict[str, Any]:
    job_read_rate_limit(request)
    refs = _normalize_job_refs(payload.jobs, limit=500)

    active: list[dict[str, Any]] = []
    settled: list[dict[str, Any]] = []
    forbidden: list[str] = []
    not_found: list[str] = []
    failed: list[dict[str, str]] = []

    for job_id, token in refs:
        try:
            meta = job_manager.get_meta(job_id, token)
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
async def dashboard_summary(payload: DashboardSummaryRequest, request: Request) -> dict[str, Any]:
    job_read_rate_limit(request)
    refs = _normalize_job_refs(payload.jobs, limit=payload.limit)

    metas: list[dict[str, Any]] = []
    updates: list[dict[str, Any]] = []
    forbidden: list[str] = []
    not_found: list[str] = []
    failed: list[dict[str, str]] = []

    for job_id, token in refs:
        try:
            meta = job_manager.get_meta(job_id, token)
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
) -> CreateJobResponse:
    req, refs = await _parse_create_request(request)
    job_id, token, status_, created_at = job_manager.create_job(req, refs, idempotency_key=idempotency_key)
    return CreateJobResponse(job_id=job_id, job_access_token=token, status=status_, created_at=created_at)


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}", dependencies=[Depends(job_read_rate_limit)])
async def get_job(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    return job_manager.get_meta(job_id, x_job_token)


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/request", dependencies=[Depends(job_read_rate_limit)])
async def get_job_request(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    return {"job_id": job_id, "request": job_manager.get_request(job_id, x_job_token)}


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/response", dependencies=[Depends(job_read_rate_limit)])
async def get_job_response(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    return {"job_id": job_id, "response": job_manager.get_response(job_id, x_job_token)}


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/images/{{image_id}}", dependencies=[Depends(job_read_rate_limit)])
async def get_job_image(
    job_id: str,
    image_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
) -> Response:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    if not validate_image_id(image_id):
        raise api_error(ErrorCode.IMAGE_NOT_FOUND, "Image not found", http_status=404)

    image_bytes, mime = job_manager.get_image(job_id, x_job_token, image_id)
    return Response(content=image_bytes, media_type=mime)


async def _event_stream(job_id: str, token: str | None) -> AsyncIterator[bytes]:
    last_status = None
    while True:
        try:
            meta = job_manager.get_meta(job_id, token)
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

        if status_ in {"SUCCEEDED", "FAILED", "DELETED"}:
            return

        import asyncio

        await asyncio.sleep(1)


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}/events", dependencies=[Depends(job_read_rate_limit)])
async def get_job_events(
    job_id: str,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
) -> StreamingResponse:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    job_manager.get_meta(job_id, x_job_token)
    return StreamingResponse(_event_stream(job_id, x_job_token), media_type="text/event-stream")


@app.delete(f"{settings.api_prefix}/jobs/{{job_id}}")
async def delete_job(job_id: str, x_job_token: str | None = Header(default=None, alias="X-Job-Token")) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    job_manager.delete_job(job_id, x_job_token)
    return {"job_id": job_id, "deleted": True}


@app.post(f"{settings.api_prefix}/jobs/{{job_id}}/retry", status_code=status.HTTP_201_CREATED)
async def retry_job(
    job_id: str,
    payload: RetryJobRequest,
    x_job_token: str | None = Header(default=None, alias="X-Job-Token"),
) -> dict[str, Any]:
    if not validate_job_id(job_id):
        raise api_error(ErrorCode.JOB_NOT_FOUND, "Job not found", http_status=404)
    new_job_id, new_token, _ = job_manager.retry_job(job_id, x_job_token, payload.override_params)
    return {
        "new_job_id": new_job_id,
        "new_job_access_token": new_token,
    }


def _check_admin_key(x_admin_key: str | None) -> None:
    if not settings.admin_api_key:
        return
    if x_admin_key != settings.admin_api_key:
        raise api_error(ErrorCode.JOB_TOKEN_INVALID, "Invalid admin key", http_status=403)


def _billing_summary_payload() -> dict[str, Any]:
    metas = storage.iter_job_meta()
    spent = 0.0
    by_model: dict[str, dict[str, Any]] = {}

    for meta in metas:
        if meta.get("status") not in {"SUCCEEDED", "FAILED"}:
            continue
        model = meta.get("model", "unknown")
        cost = float(meta.get("billing", {}).get("estimated_cost_usd", 0.0))
        spent += cost

        if model not in by_model:
            by_model[model] = {"model": model, "spent_usd": 0.0, "jobs": 0}
        by_model[model]["spent_usd"] += cost
        by_model[model]["jobs"] += 1

    budget = float(settings.budget_usd)
    payload = {
        "currency": "USD",
        "mode": "INTERNAL_ESTIMATE",
        "budget_usd": round(budget, 6),
        "spent_usd": round(spent, 6),
        "remaining_usd": round(max(0.0, budget - spent), 6),
        "period": current_month_period(),
        "by_model": [BillingSummaryModelItem(**{**v, "spent_usd": round(v["spent_usd"], 6)}).model_dump() for v in by_model.values()],
        "last_updated_at": now_local().isoformat(),
        "notes": "Estimated from job-level usage + official pricing.",
    }
    return payload


@app.get(f"{settings.api_prefix}/billing/summary", response_model=None)
async def billing_summary(x_admin_key: str | None = Header(default=None, alias="X-Admin-Key")) -> dict[str, Any]:
    _check_admin_key(x_admin_key)
    return _billing_summary_payload()


@app.get(f"{settings.api_prefix}/billing/google/remaining")
async def billing_google_remaining(
    x_admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
) -> dict[str, Any]:
    _check_admin_key(x_admin_key)

    if settings.billing_mode == "INTERNAL":
        summary = _billing_summary_payload()
        payload = GoogleRemainingConfiguredResponse(
            mode="INTERNAL_ESTIMATE",
            google_remaining_usd=summary["remaining_usd"],
            google_spent_usd=summary["spent_usd"],
            source="This service internal ledger (estimated)",
            notes="Not an official Google balance. Configure BigQuery billing export for closer-to-official numbers.",
        )
        return payload.model_dump()

    if settings.billing_mode == "BIGQUERY":
        if settings.google_reported_spend_usd is None or settings.google_reported_remaining_usd is None:
            return JSONResponse(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                content=GoogleRemainingUnconfiguredResponse(
                    message="Google balance cannot be fetched directly via Gemini API. Configure INTERNAL budget or BIGQUERY export."
                ).model_dump(),
            )

        payload = GoogleRemainingConfiguredResponse(
            mode="BIGQUERY_BILLING_EXPORT",
            google_remaining_usd=settings.google_reported_remaining_usd,
            google_spent_usd=settings.google_reported_spend_usd,
            source="GCP Billing Export (BigQuery)",
            notes="Data may be delayed depending on export schedule.",
            as_of=now_local(),
        )
        return payload.model_dump()

    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content=GoogleRemainingUnconfiguredResponse(
            message="Google balance cannot be fetched directly via Gemini API. Configure INTERNAL budget or BIGQUERY export."
        ).model_dump(),
    )
