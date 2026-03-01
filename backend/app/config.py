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
    default_model: str = Field(default=DEFAULT_MODEL_ID, alias="DEFAULT_MODEL")

    data_dir: Path = Field(default=Path("./data"), alias="DATA_DIR")
    max_images_per_job: int = Field(default=1, alias="MAX_IMAGES_PER_JOB")
    max_reference_images: int = Field(default=14, alias="MAX_REFERENCE_IMAGES")

    job_workers: int = Field(default=2, alias="JOB_WORKERS")
    job_queue_max: int = Field(default=100, alias="JOB_QUEUE_MAX")
    job_timeout_sec_default: int = Field(default=120, alias="JOB_TIMEOUT_SEC_DEFAULT")
    job_timeout_sec_min: int = Field(default=15, alias="JOB_TIMEOUT_SEC_MIN")
    job_timeout_sec_max: int = Field(default=600, alias="JOB_TIMEOUT_SEC_MAX")
    job_watchdog_grace_sec: int = Field(default=20, alias="JOB_WATCHDOG_GRACE_SEC")

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


settings = Settings()


def get_cors_origins() -> list[str]:
    raw = settings.cors_allow_origins.strip()
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def ensure_data_dirs() -> None:
    jobs_dir = settings.data_dir / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    settings.log_dir.mkdir(parents=True, exist_ok=True)
