from __future__ import annotations

from dataclasses import dataclass
from typing import Any


MODEL_GEMINI_3_PRO_IMAGE = "gemini-3-pro-image-preview"
MODEL_GEMINI_2_5_FLASH_IMAGE = "gemini-2.5-flash-image"
MODEL_GEMINI_3_1_FLASH_IMAGE = "gemini-3.1-flash-image-preview"

MODE_IMAGE_ONLY = "IMAGE_ONLY"
MODE_TEXT_AND_IMAGE = "TEXT_AND_IMAGE"
_MODE_LEGACY_TEXT_IMAGE = "TEXT_IMAGE"


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    label: str
    description: str
    supports_text_output: bool
    supports_image_size: bool
    supports_thinking_level: bool
    supported_aspect_ratios: tuple[str, ...]
    supported_image_sizes: tuple[str, ...]
    supported_thinking_levels: tuple[str, ...]
    default_aspect_ratio: str
    default_image_size: str
    default_thinking_level: str | None = None
    default_temperature: float = 0.7
    default_timeout_sec: int = 120
    default_max_retries: int = 1

    @property
    def supported_modes(self) -> tuple[str, ...]:
        if self.supports_text_output:
            return (MODE_IMAGE_ONLY, MODE_TEXT_AND_IMAGE)
        return (MODE_IMAGE_ONLY,)


_MODEL_SPECS: dict[str, ModelSpec] = {
    MODEL_GEMINI_3_PRO_IMAGE: ModelSpec(
        model_id=MODEL_GEMINI_3_PRO_IMAGE,
        label="Nano Banana Pro",
        description="Gemini 3 Pro Image Preview",
        supports_text_output=True,
        supports_image_size=True,
        supports_thinking_level=False,
        supported_aspect_ratios=(
            "1:1",
            "1:4",
            "1:8",
            "2:3",
            "3:2",
            "3:4",
            "4:1",
            "4:3",
            "4:5",
            "5:4",
            "8:1",
            "9:16",
            "16:9",
            "21:9",
        ),
        supported_image_sizes=("1K", "2K", "4K"),
        supported_thinking_levels=(),
        default_aspect_ratio="1:1",
        default_image_size="1K",
    ),
    MODEL_GEMINI_2_5_FLASH_IMAGE: ModelSpec(
        model_id=MODEL_GEMINI_2_5_FLASH_IMAGE,
        label="Nano Banana",
        description="Gemini 2.5 Flash Image",
        supports_text_output=True,
        supports_image_size=False,
        supports_thinking_level=False,
        supported_aspect_ratios=(
            "1:1",
            "1:4",
            "1:8",
            "2:3",
            "3:2",
            "3:4",
            "4:1",
            "4:3",
            "4:5",
            "5:4",
            "8:1",
            "9:16",
            "16:9",
            "21:9",
        ),
        supported_image_sizes=(),
        supported_thinking_levels=(),
        default_aspect_ratio="1:1",
        default_image_size="AUTO",
    ),
    MODEL_GEMINI_3_1_FLASH_IMAGE: ModelSpec(
        model_id=MODEL_GEMINI_3_1_FLASH_IMAGE,
        label="Nano Banana 2",
        description="Gemini 3.1 Flash Image Preview",
        supports_text_output=False,
        supports_image_size=True,
        supports_thinking_level=True,
        supported_aspect_ratios=(
            "1:1",
            "1:4",
            "1:8",
            "2:3",
            "3:2",
            "3:4",
            "4:1",
            "4:3",
            "4:5",
            "5:4",
            "8:1",
            "9:16",
            "16:9",
            "21:9",
        ),
        supported_image_sizes=("512", "1K", "2K", "4K"),
        supported_thinking_levels=("Minimal", "High"),
        default_aspect_ratio="1:1",
        default_image_size="1K",
        default_thinking_level="High",
    ),
}

MODEL_DISPLAY_ORDER: tuple[str, ...] = (
    MODEL_GEMINI_3_1_FLASH_IMAGE,
    MODEL_GEMINI_2_5_FLASH_IMAGE,
    MODEL_GEMINI_3_PRO_IMAGE,
)

DEFAULT_MODEL_ID = MODEL_GEMINI_3_PRO_IMAGE
SUPPORTED_MODEL_IDS = tuple(_MODEL_SPECS.keys())
SUPPORTED_MODES = (MODE_IMAGE_ONLY, MODE_TEXT_AND_IMAGE)


def normalize_mode(value: str | None) -> str:
    mode = (value or MODE_IMAGE_ONLY).strip().upper()
    if mode == _MODE_LEGACY_TEXT_IMAGE:
        return MODE_TEXT_AND_IMAGE
    return mode


def get_model_spec(model_id: str) -> ModelSpec | None:
    return _MODEL_SPECS.get(model_id)


def list_model_specs() -> list[ModelSpec]:
    return [_MODEL_SPECS[mid] for mid in MODEL_DISPLAY_ORDER if mid in _MODEL_SPECS]


def normalize_params_for_model(model_id: str, params: dict[str, Any]) -> dict[str, Any]:
    spec = get_model_spec(model_id)
    if not spec:
        return dict(params)
    normalized = dict(params)
    if not spec.supports_image_size:
        normalized["image_size"] = "AUTO"
    elif not normalized.get("image_size"):
        normalized["image_size"] = spec.default_image_size

    if not spec.supports_thinking_level:
        normalized["thinking_level"] = None
    else:
        thinking_level = normalized.get("thinking_level")
        if not thinking_level:
            normalized["thinking_level"] = spec.default_thinking_level

    return normalized


def model_capability_payload(spec: ModelSpec) -> dict[str, Any]:
    return {
        "model_id": spec.model_id,
        "label": spec.label,
        "description": spec.description,
        "supports_text_output": spec.supports_text_output,
        "supports_image_size": spec.supports_image_size,
        "supports_thinking_level": spec.supports_thinking_level,
        "supported_modes": list(spec.supported_modes),
        "supported_aspect_ratios": list(spec.supported_aspect_ratios),
        "supported_image_sizes": list(spec.supported_image_sizes),
        "supported_thinking_levels": list(spec.supported_thinking_levels),
        "default_params": {
            "aspect_ratio": spec.default_aspect_ratio,
            "image_size": spec.default_image_size,
            "thinking_level": spec.default_thinking_level,
            "temperature": spec.default_temperature,
            "timeout_sec": spec.default_timeout_sec,
            "max_retries": spec.default_max_retries,
        },
    }
