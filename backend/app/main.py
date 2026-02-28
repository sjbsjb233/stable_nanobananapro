from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, Request, Response, status
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
    BillingSummaryModelItem,
    CreateJobRequest,
    CreateJobResponse,
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

logger = get_logger("api")
app = FastAPI(title="Nano Banana API", version=settings.app_version)
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
    logger.info("Backend startup: version=%s data_dir=%s", settings.app_version, settings.data_dir)
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
    return HealthResponse(time=datetime.now(timezone.utc), version=settings.app_version)


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
        "last_updated_at": datetime.now(timezone.utc).isoformat(),
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
            as_of=datetime.now(timezone.utc),
        )
        return payload.model_dump()

    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content=GoogleRemainingUnconfiguredResponse(
            message="Google balance cannot be fetched directly via Gemini API. Configure INTERNAL budget or BIGQUERY export."
        ).model_dump(),
    )
