from __future__ import annotations

import json
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

from .logging_setup import get_logger
from .schemas import EmergencySwitchKey
from .storage import storage
from .time_utils import now_local
from .config import settings

logger = get_logger("emergency_state_store")


class EmergencyStateStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        return settings.data_dir / "emergency_state.json"

    def _default_document(self) -> dict[str, Any]:
        return {
            "active_switches": [],
            "operator_reason": "",
            "public_message": "",
            "updated_at": None,
            "updated_by_user_id": None,
            "updated_by_username": None,
        }

    def _normalize_switches(self, raw: Any) -> list[str]:
        if not isinstance(raw, list):
            return []
        seen: set[str] = set()
        normalized: list[str] = []
        allowed = {item.value for item in EmergencySwitchKey}
        for item in raw:
            value = str(item or "").strip()
            if not value or value not in allowed or value in seen:
                continue
            normalized.append(value)
            seen.add(value)
        return normalized

    def _normalize_document(self, raw: Any) -> dict[str, Any]:
        doc = self._default_document()
        if not isinstance(raw, dict):
            return doc
        doc["active_switches"] = self._normalize_switches(raw.get("active_switches"))
        doc["operator_reason"] = str(raw.get("operator_reason") or "").strip()
        doc["public_message"] = str(raw.get("public_message") or "").strip()
        updated_at = raw.get("updated_at")
        doc["updated_at"] = str(updated_at).strip() if updated_at else None
        updated_by_user_id = raw.get("updated_by_user_id")
        doc["updated_by_user_id"] = str(updated_by_user_id).strip() if updated_by_user_id else None
        updated_by_username = raw.get("updated_by_username")
        doc["updated_by_username"] = str(updated_by_username).strip() if updated_by_username else None
        return doc

    def _load_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._default_document()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            logger.exception("Failed to load emergency state, falling back to defaults: path=%s", self.path)
            return self._default_document()
        return self._normalize_document(raw)

    def _save_locked(self, doc: dict[str, Any]) -> None:
        storage.write_json(self.path, doc)

    def ensure_initialized(self) -> None:
        with self._lock:
            doc = self._load_locked()
            if not self.path.exists():
                self._save_locked(doc)

    def get_state(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._load_locked())

    def is_active(self, switch: EmergencySwitchKey | str) -> bool:
        switch_key = switch.value if isinstance(switch, EmergencySwitchKey) else str(switch or "")
        with self._lock:
            doc = self._load_locked()
            return switch_key in set(doc.get("active_switches") or [])

    def update_state(
        self,
        *,
        active_switches: list[str],
        operator_reason: str,
        public_message: str,
        updated_by_user_id: str,
        updated_by_username: str,
    ) -> dict[str, Any]:
        with self._lock:
            doc = self._load_locked()
            doc["active_switches"] = self._normalize_switches(active_switches)
            doc["operator_reason"] = str(operator_reason or "").strip()
            doc["public_message"] = str(public_message or "").strip()
            doc["updated_at"] = now_local().isoformat()
            doc["updated_by_user_id"] = str(updated_by_user_id or "").strip() or None
            doc["updated_by_username"] = str(updated_by_username or "").strip() or None
            self._save_locked(doc)
            return deepcopy(doc)


emergency_state_store = EmergencyStateStore()
