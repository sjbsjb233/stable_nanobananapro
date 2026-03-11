from __future__ import annotations

import json
import math
import threading
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .config import settings
from .logging_setup import get_logger
from .storage import storage
from .time_utils import now_local

logger = get_logger("provider_store")

QUOTA_HAS = "HAS_QUOTA"
QUOTA_NO = "NO_QUOTA"
QUOTA_UNKNOWN = "UNKNOWN"

_RECENT_HISTORY_LIMIT = 50
_FAILURE_COOLDOWNS_SEC = (60, 180, 600, 1800)


@dataclass(frozen=True)
class ProviderConfig:
    provider_id: str
    label: str
    adapter_type: str
    base_url: str
    api_key: str
    cost_per_image_cny: float
    initial_balance_cny: float | None
    enabled_by_default: bool
    note: str
    supported_models: tuple[str, ...]
    max_concurrency: int


def _safe_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except Exception:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _default_state(config: ProviderConfig) -> dict[str, Any]:
    return {
        "note": config.note,
        "enabled": bool(config.enabled_by_default),
        "remaining_balance_cny": config.initial_balance_cny,
        "balance_updated_at": now_local().isoformat() if config.initial_balance_cny is not None else None,
        "success_count": 0,
        "fail_count": 0,
        "consecutive_failures": 0,
        "last_fail_reason": None,
        "last_success_time": None,
        "last_fail_time": None,
        "cooldown_until": None,
        "circuit_open_count": 0,
        "recent_calls": [],
        "total_spent_cny": 0.0,
        "total_generated_images": 0,
        "last_selected_time": None,
    }


class ProviderStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "providers.json"
        self._lock = threading.RLock()
        self._active_requests: dict[str, int] = {}

    def _legacy_provider_config(self) -> list[ProviderConfig]:
        if not settings.gemini_api_key:
            return []
        return [
            ProviderConfig(
                provider_id="legacy_gemini",
                label="Legacy Gemini",
                adapter_type="gemini_v1beta",
                base_url=settings.gemini_api_base_url.rstrip("/"),
                api_key=settings.gemini_api_key,
                cost_per_image_cny=0.0,
                initial_balance_cny=None,
                enabled_by_default=True,
                note="Fallback provider derived from GEMINI_API_* settings.",
                supported_models=(
                    "gemini-3-pro-image-preview",
                    "gemini-2.5-flash-image",
                    "gemini-3.1-flash-image-preview",
                ),
                max_concurrency=1,
            )
        ]

    def _load_configs(self) -> list[ProviderConfig]:
        raw = (settings.upstream_providers_json or "").strip()
        if not raw:
            return self._legacy_provider_config()
        try:
            payload = json.loads(raw)
        except Exception:
            logger.exception("Failed to parse UPSTREAM_PROVIDERS_JSON")
            return self._legacy_provider_config()
        if not isinstance(payload, list):
            logger.warning("UPSTREAM_PROVIDERS_JSON must be a list")
            return self._legacy_provider_config()

        configs: list[ProviderConfig] = []
        seen: set[str] = set()
        for item in payload:
            if not isinstance(item, dict):
                continue
            provider_id = str(item.get("provider_id") or "").strip()
            if not provider_id or provider_id in seen:
                continue
            base_url = str(item.get("base_url") or "").strip().rstrip("/")
            api_key = str(item.get("api_key") or "").strip()
            adapter_type = str(item.get("adapter_type") or "").strip()
            if not base_url or not api_key or not adapter_type:
                continue
            supported_raw = item.get("supported_models") or []
            supported_models = tuple(
                model
                for model in (
                    str(model_id or "").strip()
                    for model_id in (supported_raw if isinstance(supported_raw, list) else [])
                )
                if model
            )
            if not supported_models:
                supported_models = (
                    "gemini-3-pro-image-preview",
                    "gemini-2.5-flash-image",
                    "gemini-3.1-flash-image-preview",
                )
            configs.append(
                ProviderConfig(
                    provider_id=provider_id,
                    label=str(item.get("label") or provider_id),
                    adapter_type=adapter_type,
                    base_url=base_url,
                    api_key=api_key,
                    cost_per_image_cny=max(0.0, float(item.get("cost_per_image_cny") or 0.0)),
                    initial_balance_cny=_safe_float(item.get("initial_balance_cny")),
                    enabled_by_default=bool(item.get("enabled", True)),
                    note=str(item.get("note") or "").strip(),
                    supported_models=supported_models,
                    max_concurrency=max(1, int(item.get("max_concurrency") or 1)),
                )
            )
            seen.add(provider_id)
        return configs or self._legacy_provider_config()

    def _load_state_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"providers": {}}
        try:
            raw = storage.read_json(self.path)
        except Exception:
            logger.exception("Failed to load provider state: path=%s", self.path)
            return {"providers": {}}
        providers = raw.get("providers") if isinstance(raw, dict) else {}
        return {"providers": providers if isinstance(providers, dict) else {}}

    def _save_state_locked(self, doc: dict[str, Any]) -> None:
        storage.write_json(self.path, doc)

    def _merged_locked(self) -> tuple[list[ProviderConfig], dict[str, Any]]:
        configs = self._load_configs()
        state_doc = self._load_state_locked()
        providers_state = state_doc["providers"]
        changed = False
        known_ids = {cfg.provider_id for cfg in configs}

        for cfg in configs:
            current = providers_state.get(cfg.provider_id)
            if not isinstance(current, dict):
                providers_state[cfg.provider_id] = _default_state(cfg)
                changed = True
                continue
            normalized = _default_state(cfg)
            normalized.update({k: v for k, v in current.items() if k in normalized})
            if normalized != current:
                providers_state[cfg.provider_id] = normalized
                changed = True

        for provider_id in list(providers_state.keys()):
            if provider_id not in known_ids:
                providers_state.pop(provider_id, None)
                self._active_requests.pop(provider_id, None)
                changed = True

        if changed:
            self._save_state_locked(state_doc)
        return configs, state_doc

    def ensure_initialized(self) -> None:
        with self._lock:
            self._merged_locked()

    def reset_runtime_state(self) -> None:
        with self._lock:
            self._active_requests = {}

    def _append_recent_call(self, state: dict[str, Any], payload: dict[str, Any]) -> None:
        recent = state.get("recent_calls")
        if not isinstance(recent, list):
            recent = []
        recent.append(payload)
        state["recent_calls"] = recent[-_RECENT_HISTORY_LIMIT:]

    def _current_active_locked(self, provider_id: str) -> int:
        return int(self._active_requests.get(provider_id, 0))

    def acquire_slot(self, provider_id: str) -> None:
        with self._lock:
            self._active_requests[provider_id] = self._current_active_locked(provider_id) + 1

    def release_slot(self, provider_id: str) -> None:
        with self._lock:
            current = max(0, self._current_active_locked(provider_id) - 1)
            if current <= 0:
                self._active_requests.pop(provider_id, None)
            else:
                self._active_requests[provider_id] = current

    def list_provider_snapshots(self) -> list[dict[str, Any]]:
        with self._lock:
            configs, state_doc = self._merged_locked()
            providers_state = state_doc["providers"]
            return [
                self._snapshot_locked(cfg, providers_state.get(cfg.provider_id) or _default_state(cfg))
                for cfg in configs
            ]

    def get_provider_config(self, provider_id: str) -> ProviderConfig | None:
        with self._lock:
            configs, _ = self._merged_locked()
            for cfg in configs:
                if cfg.provider_id == provider_id:
                    return cfg
        return None

    def get_provider_snapshot(self, provider_id: str) -> dict[str, Any] | None:
        with self._lock:
            configs, state_doc = self._merged_locked()
            providers_state = state_doc["providers"]
            for cfg in configs:
                if cfg.provider_id == provider_id:
                    return self._snapshot_locked(cfg, providers_state.get(cfg.provider_id) or _default_state(cfg))
        return None

    def update_provider(self, provider_id: str, *, enabled: bool | None = None, note: str | None = None) -> dict[str, Any] | None:
        with self._lock:
            configs, state_doc = self._merged_locked()
            cfg = next((item for item in configs if item.provider_id == provider_id), None)
            if cfg is None:
                return None
            state = state_doc["providers"].setdefault(provider_id, _default_state(cfg))
            if enabled is not None:
                state["enabled"] = bool(enabled)
            if note is not None:
                state["note"] = str(note).strip()
            self._save_state_locked(state_doc)
            return self._snapshot_locked(cfg, state)

    def set_balance(self, provider_id: str, amount_cny: float | None) -> dict[str, Any] | None:
        with self._lock:
            configs, state_doc = self._merged_locked()
            cfg = next((item for item in configs if item.provider_id == provider_id), None)
            if cfg is None:
                return None
            state = state_doc["providers"].setdefault(provider_id, _default_state(cfg))
            state["remaining_balance_cny"] = None if amount_cny is None else round(max(0.0, float(amount_cny)), 4)
            state["balance_updated_at"] = now_local().isoformat()
            if state["remaining_balance_cny"] == 0:
                state["last_fail_reason"] = "NO_QUOTA"
            self._save_state_locked(state_doc)
            return self._snapshot_locked(cfg, state)

    def add_balance(self, provider_id: str, delta_cny: float) -> dict[str, Any] | None:
        with self._lock:
            snapshot = self.get_provider_snapshot(provider_id)
            if snapshot is None:
                return None
            current = snapshot.get("remaining_balance_cny")
            if current is None:
                current = 0.0
            return self.set_balance(provider_id, float(current) + float(delta_cny))

    def record_selection(self, provider_id: str) -> None:
        with self._lock:
            configs, state_doc = self._merged_locked()
            cfg = next((item for item in configs if item.provider_id == provider_id), None)
            if cfg is None:
                return
            state = state_doc["providers"].setdefault(provider_id, _default_state(cfg))
            state["last_selected_time"] = now_local().isoformat()
            self._save_state_locked(state_doc)

    def record_success(self, provider_id: str, *, latency_ms: int, image_count: int, cost_cny: float) -> None:
        with self._lock:
            configs, state_doc = self._merged_locked()
            cfg = next((item for item in configs if item.provider_id == provider_id), None)
            if cfg is None:
                return
            state = state_doc["providers"].setdefault(provider_id, _default_state(cfg))
            state["success_count"] = int(state.get("success_count") or 0) + 1
            state["consecutive_failures"] = 0
            state["last_success_time"] = now_local().isoformat()
            state["cooldown_until"] = None
            state["circuit_open_count"] = 0
            state["total_generated_images"] = int(state.get("total_generated_images") or 0) + max(0, int(image_count))
            state["total_spent_cny"] = round(float(state.get("total_spent_cny") or 0.0) + max(0.0, float(cost_cny)), 4)
            remaining = _safe_float(state.get("remaining_balance_cny"))
            if remaining is not None:
                state["remaining_balance_cny"] = round(max(0.0, remaining - max(0.0, float(cost_cny))), 4)
                state["balance_updated_at"] = now_local().isoformat()
            self._append_recent_call(
                state,
                {
                    "ts": now_local().isoformat(),
                    "success": True,
                    "latency_ms": max(0, int(latency_ms)),
                    "error_code": None,
                },
            )
            self._save_state_locked(state_doc)

    def record_failure(
        self,
        provider_id: str,
        *,
        error_code: str,
        latency_ms: int,
        quota_exceeded: bool = False,
        open_circuit: bool = False,
    ) -> None:
        with self._lock:
            configs, state_doc = self._merged_locked()
            cfg = next((item for item in configs if item.provider_id == provider_id), None)
            if cfg is None:
                return
            state = state_doc["providers"].setdefault(provider_id, _default_state(cfg))
            state["fail_count"] = int(state.get("fail_count") or 0) + 1
            state["consecutive_failures"] = int(state.get("consecutive_failures") or 0) + 1
            state["last_fail_reason"] = error_code
            state["last_fail_time"] = now_local().isoformat()
            if quota_exceeded:
                state["remaining_balance_cny"] = 0.0
                state["balance_updated_at"] = now_local().isoformat()
            if open_circuit:
                open_count = int(state.get("circuit_open_count") or 0) + 1
                state["circuit_open_count"] = open_count
                idx = min(open_count - 1, len(_FAILURE_COOLDOWNS_SEC) - 1)
                state["cooldown_until"] = (now_local() + timedelta(seconds=_FAILURE_COOLDOWNS_SEC[idx])).isoformat()
            self._append_recent_call(
                state,
                {
                    "ts": now_local().isoformat(),
                    "success": False,
                    "latency_ms": max(0, int(latency_ms)),
                    "error_code": error_code,
                },
            )
            self._save_state_locked(state_doc)

    def candidate_chain(self, model: str) -> list[dict[str, Any]]:
        with self._lock:
            configs, state_doc = self._merged_locked()
            states = state_doc["providers"]
            candidates: list[dict[str, Any]] = []
            for cfg in configs:
                if model not in cfg.supported_models:
                    continue
                state = states.get(cfg.provider_id) or _default_state(cfg)
                snap = self._snapshot_locked(cfg, state)
                if not snap["enabled"]:
                    continue
                if snap["cooldown_active"]:
                    continue
                if snap["quota_state"] == QUOTA_NO:
                    continue
                if snap["active_requests"] >= snap["max_concurrency"]:
                    continue
                candidates.append(snap)
            if not candidates:
                return []

            candidates.sort(key=lambda item: (item["cost_per_image_cny"], item["provider_id"]))
            current_tier = 0
            previous_cost = None
            for item in candidates:
                cost = float(item["cost_per_image_cny"])
                if previous_cost is None:
                    current_tier = 0
                elif previous_cost <= 0:
                    current_tier += 1
                elif cost > previous_cost * 1.05:
                    current_tier += 1
                item["cost_tier"] = current_tier
                previous_cost = cost

            ordered: list[dict[str, Any]] = []
            tiers = sorted({int(item["cost_tier"]) for item in candidates})
            for tier in tiers:
                tier_items = [item for item in candidates if int(item["cost_tier"]) == tier]
                tier_items.sort(
                    key=lambda item: (
                        -float(item["quota_score"]),
                        -float(item["health_score"]),
                        float(item["effective_cost"]),
                        item["provider_id"],
                    )
                )
                ordered.extend(tier_items)
            return ordered

    def _snapshot_locked(self, cfg: ProviderConfig, state: dict[str, Any]) -> dict[str, Any]:
        success_count = int(state.get("success_count") or 0)
        fail_count = int(state.get("fail_count") or 0)
        smoothed_success = (success_count + 7.0) / (success_count + fail_count + 10.0)
        recent = state.get("recent_calls") if isinstance(state.get("recent_calls"), list) else []
        recent_successes = sum(1 for item in recent if isinstance(item, dict) and item.get("success") is True)
        recent_total = sum(1 for item in recent if isinstance(item, dict))
        recent_success_rate = ((recent_successes + 3.5) / (recent_total + 5.0)) if recent_total else smoothed_success
        final_success = round((0.4 * smoothed_success) + (0.6 * recent_success_rate), 4)

        latencies = [
            int(item.get("latency_ms") or 0)
            for item in recent
            if isinstance(item, dict) and item.get("success") is True and isinstance(item.get("latency_ms"), (int, float))
        ]
        timeout_rate = 0.0
        if recent_total:
            timeout_rate = sum(
                1
                for item in recent
                if isinstance(item, dict) and str(item.get("error_code") or "").upper() in {"UPSTREAM_TIMEOUT", "WORKER_WATCHDOG_TIMEOUT"}
            ) / recent_total

        balance = _safe_float(state.get("remaining_balance_cny"))
        if balance is None:
            quota_state = QUOTA_UNKNOWN
            quota_confidence = 0.7 if state.get("last_success_time") else 0.4
        elif balance <= 0:
            quota_state = QUOTA_NO
            quota_confidence = 1.0
        else:
            quota_state = QUOTA_HAS
            quota_confidence = 1.0

        if quota_state == QUOTA_HAS:
            if cfg.cost_per_image_cny <= 0:
                quota_score = 1.0
            elif balance >= cfg.cost_per_image_cny * 20:
                quota_score = 1.0
            elif balance >= cfg.cost_per_image_cny * 5:
                quota_score = 0.8
            else:
                quota_score = 0.55
        elif quota_state == QUOTA_UNKNOWN:
            quota_score = round(0.5 * quota_confidence, 4)
        else:
            quota_score = 0.0

        recent_penalty = min(0.5, int(state.get("consecutive_failures") or 0) * 0.1 + timeout_rate * 0.2)
        cooldown_until = str(state.get("cooldown_until") or "") or None
        cooldown_active = False
        if cooldown_until:
            try:
                cooldown_active = now_local() < datetime.fromisoformat(cooldown_until)
            except Exception:
                cooldown_active = False

        health_score = round(max(0.0, final_success - recent_penalty), 4)
        effective_cost = cfg.cost_per_image_cny / max(final_success, 0.05)

        def _percentile(values: list[int], ratio: float) -> float | None:
            if not values:
                return None
            arr = sorted(values)
            idx = ratio * (len(arr) - 1)
            lo = int(math.floor(idx))
            hi = int(math.ceil(idx))
            if lo == hi:
                return float(arr[lo])
            weight = idx - lo
            return float(arr[lo] * (1 - weight) + arr[hi] * weight)

        return {
            "provider_id": cfg.provider_id,
            "label": cfg.label,
            "adapter_type": cfg.adapter_type,
            "base_url": cfg.base_url,
            "enabled": bool(state.get("enabled", cfg.enabled_by_default)),
            "note": str(state.get("note") or ""),
            "supported_models": list(cfg.supported_models),
            "cost_per_image_cny": round(cfg.cost_per_image_cny, 4),
            "remaining_balance_cny": balance,
            "quota_state": quota_state,
            "quota_confidence": round(quota_confidence, 4),
            "quota_score": round(quota_score, 4),
            "success_count": success_count,
            "fail_count": fail_count,
            "consecutive_failures": int(state.get("consecutive_failures") or 0),
            "last_fail_reason": state.get("last_fail_reason"),
            "last_success_time": state.get("last_success_time"),
            "last_fail_time": state.get("last_fail_time"),
            "cooldown_until": cooldown_until,
            "cooldown_active": cooldown_active,
            "circuit_open_count": int(state.get("circuit_open_count") or 0),
            "success_rate_estimated": round(smoothed_success, 4),
            "recent_success_rate": round(recent_success_rate, 4),
            "final_success_rate": round(final_success, 4),
            "health_score": health_score,
            "effective_cost": round(effective_cost, 4),
            "active_requests": self._current_active_locked(cfg.provider_id),
            "max_concurrency": int(cfg.max_concurrency),
            "latency_p50_ms": _percentile(latencies, 0.5),
            "latency_p95_ms": _percentile(latencies, 0.95),
            "timeout_rate": round(timeout_rate, 4),
            "total_spent_cny": round(float(state.get("total_spent_cny") or 0.0), 4),
            "total_generated_images": int(state.get("total_generated_images") or 0),
            "balance_updated_at": state.get("balance_updated_at"),
            "last_selected_time": state.get("last_selected_time"),
            "recent_calls": deepcopy(recent[-10:]),
        }


provider_store = ProviderStore(settings.data_dir)
