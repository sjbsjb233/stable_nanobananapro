from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from .model_catalog import DEFAULT_MODEL_ID


JobMode = Literal["IMAGE_ONLY", "TEXT_AND_IMAGE"]
ModelId = Literal[
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image",
    "gemini-3.1-flash-image-preview",
]


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    CANCELLED = "CANCELLED"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    DELETED = "DELETED"


class ErrorCode(str, Enum):
    AUTH_REQUIRED = "AUTH_REQUIRED"
    FORBIDDEN = "FORBIDDEN"
    INVALID_INPUT = "INVALID_INPUT"
    INVALID_CREDENTIALS = "INVALID_CREDENTIALS"
    JOB_NOT_FOUND = "JOB_NOT_FOUND"
    JOB_TOKEN_INVALID = "JOB_TOKEN_INVALID"
    RATE_LIMITED = "RATE_LIMITED"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    UPSTREAM_RATE_LIMIT = "UPSTREAM_RATE_LIMIT"
    SAFETY_BLOCKED = "SAFETY_BLOCKED"
    NO_IMAGE_PART = "NO_IMAGE_PART"
    IMAGE_NOT_FOUND = "IMAGE_NOT_FOUND"
    BILLING_NOT_CONFIGURED = "BILLING_NOT_CONFIGURED"
    TURNSTILE_REQUIRED = "TURNSTILE_REQUIRED"
    USER_NOT_FOUND = "USER_NOT_FOUND"
    USERNAME_TAKEN = "USERNAME_TAKEN"


class UserRole(str, Enum):
    ADMIN = "ADMIN"
    USER = "USER"


class JobParams(BaseModel):
    aspect_ratio: str = "1:1"
    image_size: str = "1K"
    thinking_level: str | None = None
    temperature: float = 0.7
    timeout_sec: int = 120
    max_retries: int = 1

    @field_validator("aspect_ratio")
    @classmethod
    def validate_aspect_ratio(cls, value: str) -> str:
        raw = str(value).strip()
        if ":" not in raw:
            raise ValueError("aspect_ratio must be in W:H format")
        left, right = raw.split(":", 1)
        if not left.isdigit() or not right.isdigit():
            raise ValueError("aspect_ratio must be in W:H format")
        if int(left) <= 0 or int(right) <= 0:
            raise ValueError("aspect_ratio values must be > 0")
        return raw

    @field_validator("image_size")
    @classmethod
    def validate_image_size(cls, value: str) -> str:
        raw = str(value).strip().upper()
        if not raw:
            raise ValueError("image_size cannot be empty")
        return raw

    @field_validator("thinking_level")
    @classmethod
    def validate_thinking_level(cls, value: str | None) -> str | None:
        if value is None:
            return None
        raw = str(value).strip()
        if not raw:
            return None
        canonical = raw[:1].upper() + raw[1:].lower()
        return canonical

    @field_validator("temperature")
    @classmethod
    def validate_temperature(cls, value: float) -> float:
        if value < 0 or value > 2:
            raise ValueError("temperature must be between 0 and 2")
        return value

    @field_validator("max_retries")
    @classmethod
    def validate_max_retries(cls, value: int) -> int:
        if value < 0 or value > 3:
            raise ValueError("max_retries must be between 0 and 3")
        return value


class CreateJobRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    model: ModelId = DEFAULT_MODEL_ID
    params: JobParams = Field(default_factory=JobParams)
    mode: JobMode = "IMAGE_ONLY"


class RetryJobRequest(BaseModel):
    override_params: JobParams | None = None


class CreateJobResponse(BaseModel):
    job_id: str
    job_access_token: str | None = None
    status: JobStatus
    created_at: datetime


class ImageMeta(BaseModel):
    image_id: str
    filename: str
    mime: str
    width: int
    height: int
    sha256: str
    preview: dict[str, Any] | None = None


class UsageMeta(BaseModel):
    prompt_token_count: int = 0
    cached_content_token_count: int = 0
    candidates_token_count: int = 0
    thoughts_token_count: int = 0
    total_token_count: int = 0


class BillingBreakdown(BaseModel):
    text_input_cost_usd: float = 0.0
    text_output_cost_usd: float = 0.0
    image_output_cost_usd: float = 0.0


class BillingMeta(BaseModel):
    currency: str = "USD"
    estimated_cost_usd: float = 0.0
    breakdown: BillingBreakdown = Field(default_factory=BillingBreakdown)
    pricing_version: str = "2026-01-12"
    pricing_notes: str = "computed from official pricing table"


class JobResult(BaseModel):
    images: list[ImageMeta] = Field(default_factory=list)


class JobError(BaseModel):
    code: str | None = None
    type: str
    message: str
    retryable: bool
    debug_id: str
    details: dict[str, Any] = Field(default_factory=dict)


class JobMeta(BaseModel):
    job_id: str
    created_at: datetime
    updated_at: datetime
    status: JobStatus
    model: ModelId = DEFAULT_MODEL_ID
    mode: JobMode = "IMAGE_ONLY"
    params: JobParams
    result: JobResult = Field(default_factory=JobResult)
    usage: UsageMeta = Field(default_factory=UsageMeta)
    billing: BillingMeta = Field(default_factory=BillingMeta)
    error: JobError | None = None


class ErrorPayload(BaseModel):
    code: ErrorCode
    message: str
    debug_id: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    error: ErrorPayload


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    time: datetime
    version: str
    deployed_at: datetime


class BillingSummaryModelItem(BaseModel):
    model: str
    spent_usd: float
    jobs: int


class BillingSummaryResponse(BaseModel):
    currency: Literal["USD"] = "USD"
    mode: Literal["INTERNAL_ESTIMATE"] = "INTERNAL_ESTIMATE"
    budget_usd: float
    spent_usd: float
    remaining_usd: float
    period: dict[str, str]
    by_model: list[BillingSummaryModelItem]
    last_updated_at: datetime
    notes: str


class GoogleRemainingConfiguredResponse(BaseModel):
    supported: Literal[True] = True
    mode: Literal["INTERNAL_ESTIMATE", "BIGQUERY_BILLING_EXPORT"]
    currency: Literal["USD"] = "USD"
    google_remaining_usd: float
    google_spent_usd: float
    source: str
    notes: str
    as_of: datetime | None = None


class GoogleRemainingUnconfiguredResponse(BaseModel):
    supported: Literal[False] = False
    mode: Literal["UNCONFIGURED"] = "UNCONFIGURED"
    message: str


class ModelCapability(BaseModel):
    model_id: ModelId
    label: str
    description: str
    supports_text_output: bool
    supports_image_size: bool
    supports_thinking_level: bool
    supported_modes: list[JobMode]
    supported_aspect_ratios: list[str]
    supported_image_sizes: list[str]
    supported_thinking_levels: list[str]
    default_params: JobParams


class ModelsResponse(BaseModel):
    default_model: ModelId
    models: list[ModelCapability]


class JobAccessRef(BaseModel):
    job_id: str
    job_access_token: str | None = None


class PreviewImageRef(BaseModel):
    job_id: str
    image_id: str | None = None
    job_access_token: str | None = None


class BatchPreviewRequest(BaseModel):
    images: list[PreviewImageRef] = Field(default_factory=list)


class BatchMetaRequest(BaseModel):
    jobs: list[JobAccessRef] = Field(default_factory=list)
    fields: list[str] | None = None


class ActiveJobsRequest(BaseModel):
    jobs: list[JobAccessRef] = Field(default_factory=list)
    limit: int = Field(default=100, ge=1, le=500)


class DashboardSummaryRequest(BaseModel):
    jobs: list[JobAccessRef] = Field(default_factory=list)
    limit: int = Field(default=200, ge=1, le=500)


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=128)
    turnstile_token: str = Field(min_length=1, max_length=4096)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return str(value).strip().lower()


class TurnstileVerifyRequest(BaseModel):
    turnstile_token: str = Field(min_length=1, max_length=4096)
    requested_job_count: int | None = Field(default=None, ge=1, le=100)


class UserPolicyOverrideInput(BaseModel):
    daily_image_limit: int | None = Field(default=None, ge=0)
    concurrent_jobs_limit: int | None = Field(default=None, ge=0)
    turnstile_job_count_threshold: int | None = Field(default=None, ge=0)
    turnstile_daily_usage_threshold: int | None = Field(default=None, ge=0)
    daily_image_access_limit: int | None = Field(default=None, ge=0)
    image_access_turnstile_bonus_quota: int | None = Field(default=None, ge=0)
    daily_image_access_hard_limit: int | None = Field(default=None, ge=0)


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=128)
    role: UserRole = UserRole.USER
    enabled: bool = True
    policy_overrides: UserPolicyOverrideInput = Field(default_factory=UserPolicyOverrideInput)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return str(value).strip().lower()


class UpdateUserRequest(BaseModel):
    password: str | None = Field(default=None, min_length=8, max_length=128)
    role: UserRole | None = None
    enabled: bool | None = None
    policy_overrides: UserPolicyOverrideInput | None = None


class UpdateSystemPolicyRequest(BaseModel):
    default_user_daily_image_limit: int | None = Field(default=None, ge=0)
    default_user_extra_daily_image_limit: int | None = Field(default=None, ge=0)
    default_user_concurrent_jobs_limit: int | None = Field(default=None, ge=0)
    default_admin_concurrent_jobs_limit: int | None = Field(default=None, ge=0)
    default_user_turnstile_job_count_threshold: int | None = Field(default=None, ge=0)
    default_user_turnstile_daily_usage_threshold: int | None = Field(default=None, ge=0)
    default_user_daily_image_access_limit: int | None = Field(default=None, ge=0)
    default_user_image_access_turnstile_bonus_quota: int | None = Field(default=None, ge=0)
    default_user_daily_image_access_hard_limit: int | None = Field(default=None, ge=0)
