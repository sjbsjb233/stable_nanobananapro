from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .model_catalog import DEFAULT_MODEL_ID


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Nano Banana Pro Backend"
    app_version: str = "1.0.0"
    api_prefix: str = "/v1"

    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    gemini_api_base_url: str = Field(default="https://generativelanguage.googleapis.com/v1beta", alias="GEMINI_API_BASE_URL")
    gemini_http_proxy: str = Field(default="", alias="GEMINI_HTTP_PROXY")
    upstream_providers_json: str = Field(default="", alias="UPSTREAM_PROVIDERS_JSON")
    default_model: str = Field(default=DEFAULT_MODEL_ID, alias="DEFAULT_MODEL")

    data_dir: Path = Field(default=Path("./data"), alias="DATA_DIR")
    max_images_per_job: int = Field(default=1, alias="MAX_IMAGES_PER_JOB")
    max_reference_images: int = Field(default=14, alias="MAX_REFERENCE_IMAGES")

    job_workers: int = Field(default=2, alias="JOB_WORKERS")
    job_queue_max: int = Field(default=100, alias="JOB_QUEUE_MAX")
    job_timeout_sec_default: int = Field(default=120, alias="JOB_TIMEOUT_SEC_DEFAULT")
    job_timeout_sec_min: int = Field(default=15, alias="JOB_TIMEOUT_SEC_MIN")
    job_timeout_sec_max: int = Field(default=600, alias="JOB_TIMEOUT_SEC_MAX")
    job_watchdog_timeout_sec: int = Field(default=900, alias="JOB_WATCHDOG_TIMEOUT_SEC")

    job_auth_mode: Literal["TOKEN", "ID_ONLY"] = Field(default="TOKEN", alias="JOB_AUTH_MODE")

    admin_api_key: str = Field(default="", alias="ADMIN_API_KEY")
    billing_mode: Literal["INTERNAL", "BIGQUERY"] = Field(default="INTERNAL", alias="BILLING_MODE")
    budget_usd: float = Field(default=100.0, alias="BUDGET_USD")
    pricing_table_path: str = Field(default="", alias="PRICING_TABLE_PATH")

    rate_limit_per_minute: int = Field(default=60, alias="RATE_LIMIT_PER_MINUTE")

    job_ttl_days: int = Field(default=30, alias="JOB_TTL_DAYS")

    idempotency_ttl_sec: int = Field(default=24 * 3600, alias="IDEMPOTENCY_TTL_SEC")
    log_dir: Path = Field(default=Path("./data/logs"), alias="LOG_DIR")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_retention_days: int = Field(default=3, alias="LOG_RETENTION_DAYS")

    google_reported_spend_usd: float | None = Field(default=None, alias="GOOGLE_REPORTED_SPEND_USD")
    google_reported_remaining_usd: float | None = Field(default=None, alias="GOOGLE_REPORTED_REMAINING_USD")

    cors_allow_origins: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173",
        alias="CORS_ALLOW_ORIGINS",
    )
    cors_allow_credentials: bool = Field(default=True, alias="CORS_ALLOW_CREDENTIALS")

    session_secret_key: str = Field(default="change-me-session-secret", alias="SESSION_SECRET_KEY")
    session_cookie_name: str = Field(default="nbp_session", alias="SESSION_COOKIE_NAME")
    session_max_age_sec: int = Field(default=7 * 24 * 3600, alias="SESSION_MAX_AGE_SEC")
    session_https_only: bool = Field(default=False, alias="SESSION_HTTPS_ONLY")
    test_env_admin_bypass: bool = Field(default=False, alias="TEST_ENV_ADMIN_BYPASS")

    bootstrap_admin_username: str = Field(default="admin", alias="BOOTSTRAP_ADMIN_USERNAME")
    bootstrap_admin_password: str = Field(default="admin123456", alias="BOOTSTRAP_ADMIN_PASSWORD")

    turnstile_site_key: str = Field(default="", alias="TURNSTILE_SITE_KEY")
    turnstile_secret_key: str = Field(default="", alias="TURNSTILE_SECRET_KEY")
    generation_turnstile_ttl_sec: int = Field(default=600, alias="GENERATION_TURNSTILE_TTL_SEC")

    default_user_daily_image_limit: int = Field(default=100, alias="DEFAULT_USER_DAILY_IMAGE_LIMIT")
    default_user_extra_daily_image_limit: int = Field(default=50, alias="DEFAULT_USER_EXTRA_DAILY_IMAGE_LIMIT")
    default_user_concurrent_jobs_limit: int = Field(default=2, alias="DEFAULT_USER_CONCURRENT_JOBS_LIMIT")
    default_admin_concurrent_jobs_limit: int = Field(default=20, alias="DEFAULT_ADMIN_CONCURRENT_JOBS_LIMIT")
    default_user_turnstile_job_count_threshold: int = Field(default=5, alias="DEFAULT_USER_TURNSTILE_JOB_COUNT_THRESHOLD")
    default_user_turnstile_daily_usage_threshold: int = Field(default=50, alias="DEFAULT_USER_TURNSTILE_DAILY_USAGE_THRESHOLD")
    default_user_daily_image_access_limit: int = Field(default=200, alias="DEFAULT_USER_DAILY_IMAGE_ACCESS_LIMIT")
    default_user_image_access_turnstile_bonus_quota: int = Field(default=15, alias="DEFAULT_USER_IMAGE_ACCESS_TURNSTILE_BONUS_QUOTA")
    default_user_daily_image_access_hard_limit: int = Field(default=350, alias="DEFAULT_USER_DAILY_IMAGE_ACCESS_HARD_LIMIT")
    overquota_real_job_run_probability: float = Field(default=0.5, alias="OVERQUOTA_REAL_JOB_RUN_PROBABILITY")
    preview_image_max_px: int = Field(default=1400, alias="PREVIEW_IMAGE_MAX_PX")
    preview_image_quality: int = Field(default=78, alias="PREVIEW_IMAGE_QUALITY")
    preview_batch_limit: int = Field(default=72, alias="PREVIEW_BATCH_LIMIT")


settings = Settings()


def get_cors_origins() -> list[str]:
    raw = settings.cors_allow_origins.strip()
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def cors_allow_all_origins() -> bool:
    return "*" in get_cors_origins()


def ensure_data_dirs() -> None:
    jobs_dir = settings.data_dir / "jobs"
    auth_dir = settings.data_dir / "auth"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    auth_dir.mkdir(parents=True, exist_ok=True)
    settings.log_dir.mkdir(parents=True, exist_ok=True)
