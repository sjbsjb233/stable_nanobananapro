from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings


@dataclass
class PricingTable:
    version: str
    model: str
    input_per_1m: float
    output_text_per_1m: float
    output_image_per_1m: float
    fallback_image_cost_usd: dict[str, float]


DEFAULT_PRICING = PricingTable(
    version="2026-01-12",
    model="gemini-3-pro-image-preview",
    input_per_1m=2.00,
    output_text_per_1m=12.00,
    output_image_per_1m=120.00,
    fallback_image_cost_usd={"1K": 0.134, "2K": 0.134, "4K": 0.24},
)


def load_pricing_table() -> PricingTable:
    if not settings.pricing_table_path:
        return DEFAULT_PRICING

    path = Path(settings.pricing_table_path)
    if not path.exists():
        return DEFAULT_PRICING
    data = json.loads(path.read_text(encoding="utf-8"))
    return PricingTable(
        version=data.get("version", DEFAULT_PRICING.version),
        model=data.get("model", DEFAULT_PRICING.model),
        input_per_1m=float(data.get("input_per_1m", DEFAULT_PRICING.input_per_1m)),
        output_text_per_1m=float(data.get("output_text_per_1m", DEFAULT_PRICING.output_text_per_1m)),
        output_image_per_1m=float(data.get("output_image_per_1m", DEFAULT_PRICING.output_image_per_1m)),
        fallback_image_cost_usd=data.get("fallback_image_cost_usd", DEFAULT_PRICING.fallback_image_cost_usd),
    )


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def normalize_usage(usage_metadata: dict[str, Any] | None) -> dict[str, int]:
    usage_metadata = usage_metadata or {}
    return {
        "prompt_token_count": _as_int(usage_metadata.get("promptTokenCount") or usage_metadata.get("prompt_token_count")),
        "cached_content_token_count": _as_int(
            usage_metadata.get("cachedContentTokenCount") or usage_metadata.get("cached_content_token_count")
        ),
        "candidates_token_count": _as_int(
            usage_metadata.get("candidatesTokenCount") or usage_metadata.get("candidates_token_count")
        ),
        "thoughts_token_count": _as_int(usage_metadata.get("thoughtsTokenCount") or usage_metadata.get("thoughts_token_count")),
        "total_token_count": _as_int(usage_metadata.get("totalTokenCount") or usage_metadata.get("total_token_count")),
    }


def estimate_job_cost(
    usage: dict[str, int],
    image_size: str,
    image_count: int,
    image_token_count: int | None = None,
) -> dict[str, Any]:
    pricing = load_pricing_table()

    text_input_cost = usage["prompt_token_count"] / 1_000_000 * pricing.input_per_1m
    text_output_tokens = usage["candidates_token_count"] + usage["thoughts_token_count"]
    text_output_cost = text_output_tokens / 1_000_000 * pricing.output_text_per_1m

    notes = "computed from official pricing table"
    if image_token_count is not None and image_token_count > 0:
        image_output_cost = image_token_count / 1_000_000 * pricing.output_image_per_1m
    else:
        per_image = float(pricing.fallback_image_cost_usd.get(image_size, pricing.fallback_image_cost_usd.get("1K", 0.134)))
        image_output_cost = per_image * max(0, image_count)
        notes = "fallback estimate from image_size fixed cost"

    estimated = text_input_cost + text_output_cost + image_output_cost

    return {
        "currency": "USD",
        "estimated_cost_usd": round(estimated, 6),
        "breakdown": {
            "text_input_cost_usd": round(text_input_cost, 6),
            "text_output_cost_usd": round(text_output_cost, 6),
            "image_output_cost_usd": round(image_output_cost, 6),
        },
        "pricing_version": pricing.version,
        "pricing_notes": notes,
    }


def current_month_period(now: datetime | None = None) -> dict[str, str]:
    now = now or datetime.now(timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    if now.month == 12:
        end = now.replace(year=now.year + 1, month=1, day=1)
    else:
        end = now.replace(month=now.month + 1, day=1)
    end = end.replace(hour=0, minute=0, second=0, microsecond=0)

    return {
        "type": "MONTHLY",
        "start": start.date().isoformat(),
        "end": (end.date()).isoformat(),
    }
