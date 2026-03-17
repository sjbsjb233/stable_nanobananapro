from __future__ import annotations

import secrets
import threading
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import settings
from .logging_setup import get_logger
from .storage import storage
from .time_utils import now_local

logger = get_logger("announcement_store")

ANNOUNCEMENT_KINDS = {"INFO", "UPDATE", "MAINTENANCE", "PROMO", "TIP", "WARNING"}
ANNOUNCEMENT_PRIORITIES = {"LOW", "NORMAL", "HIGH"}
ANNOUNCEMENT_STATUSES = {"DRAFT", "ACTIVE", "PAUSED", "EXPIRED"}
USER_ROLES = {"ADMIN", "USER"}


def _parse_iso(value: Any):
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


class AnnouncementStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "announcements.json"
        self._lock = threading.RLock()

    def _default_target(self) -> dict[str, Any]:
        return {
            "roles": ["USER"],
            "enabled_only": True,
            "user_ids": [],
            "exclude_user_ids": [],
        }

    def _default_document(self) -> dict[str, Any]:
        return {
            "announcements": [],
            "dismissals": {},
        }

    def _normalize_target(self, raw: Any) -> dict[str, Any]:
        target = self._default_target()
        if not isinstance(raw, dict):
            return target
        roles: list[str] = []
        seen_roles: set[str] = set()
        for item in raw.get("roles") or []:
            value = str(item or "").strip().upper()
            if value not in USER_ROLES or value in seen_roles:
                continue
            roles.append(value)
            seen_roles.add(value)
        if roles:
            target["roles"] = roles
        target["enabled_only"] = bool(raw.get("enabled_only", True))

        for key in ("user_ids", "exclude_user_ids"):
            values: list[str] = []
            seen: set[str] = set()
            source = raw.get(key)
            if isinstance(source, str):
                iterable = source.split(",")
            elif isinstance(source, list):
                iterable = source
            else:
                iterable = []
            for item in iterable:
                value = str(item or "").strip()
                if not value or value in seen:
                    continue
                values.append(value)
                seen.add(value)
            target[key] = values
        return target

    def _normalize_announcement(self, raw: Any) -> dict[str, Any] | None:
        if not isinstance(raw, dict):
            return None
        announcement_id = str(raw.get("announcement_id") or "").strip()
        if not announcement_id:
            return None
        title = str(raw.get("title") or "").strip()
        body = str(raw.get("body") or "").strip()
        kind = str(raw.get("kind") or "INFO").strip().upper()
        if kind not in ANNOUNCEMENT_KINDS:
            kind = "INFO"
        priority = str(raw.get("priority") or "NORMAL").strip().upper()
        if priority not in ANNOUNCEMENT_PRIORITIES:
            priority = "NORMAL"
        status = str(raw.get("status") or "DRAFT").strip().upper()
        if status not in ANNOUNCEMENT_STATUSES:
            status = "DRAFT"
        now_iso = now_local().isoformat()
        return {
            "announcement_id": announcement_id,
            "title": title,
            "body": body,
            "kind": kind,
            "priority": priority,
            "status": status,
            "dismissible": bool(raw.get("dismissible", True)),
            "starts_at": str(raw.get("starts_at") or "") or None,
            "ends_at": str(raw.get("ends_at") or "") or None,
            "target": self._normalize_target(raw.get("target")),
            "created_at": str(raw.get("created_at") or now_iso),
            "updated_at": str(raw.get("updated_at") or now_iso),
            "created_by_user_id": str(raw.get("created_by_user_id") or ""),
            "created_by_username": str(raw.get("created_by_username") or ""),
        }

    def _normalize_dismissals(self, raw: Any) -> dict[str, dict[str, str]]:
        output: dict[str, dict[str, str]] = {}
        if not isinstance(raw, dict):
            return output
        for user_id, value in raw.items():
            if not isinstance(value, dict):
                continue
            bucket: dict[str, str] = {}
            for announcement_id, ts in value.items():
                ann_id = str(announcement_id or "").strip()
                if not ann_id:
                    continue
                bucket[ann_id] = str(ts or now_local().isoformat())
            output[str(user_id)] = bucket
        return output

    def _normalize_document(self, raw: Any) -> dict[str, Any]:
        doc = self._default_document()
        if isinstance(raw, dict):
            announcements: list[dict[str, Any]] = []
            seen_ids: set[str] = set()
            for item in raw.get("announcements") or []:
                normalized = self._normalize_announcement(item)
                if not normalized or normalized["announcement_id"] in seen_ids:
                    continue
                announcements.append(normalized)
                seen_ids.add(normalized["announcement_id"])
            doc["announcements"] = announcements
            doc["dismissals"] = self._normalize_dismissals(raw.get("dismissals"))
        return doc

    def _load_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._default_document()
        try:
            raw = storage.read_json(self.path)
        except Exception:
            logger.exception("Failed to load announcement store: path=%s", self.path)
            return self._default_document()
        return self._normalize_document(raw)

    def _save_locked(self, doc: dict[str, Any]) -> None:
        storage.write_json(self.path, doc)

    def ensure_initialized(self) -> None:
        with self._lock:
            doc = self._load_locked()
            if not self.path.exists():
                self._save_locked(doc)

    def _dismissed_count_locked(self, doc: dict[str, Any], announcement_id: str) -> int:
        count = 0
        for dismissed in doc["dismissals"].values():
            if announcement_id in dismissed:
                count += 1
        return count

    def _effective_status(self, item: dict[str, Any]) -> str:
        status = str(item.get("status") or "DRAFT").upper()
        ends_at = _parse_iso(item.get("ends_at"))
        if ends_at is not None and ends_at <= now_local():
            return "EXPIRED"
        return status if status in ANNOUNCEMENT_STATUSES else "DRAFT"

    def get_announcement(self, announcement_id: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self._load_locked()
            for item in doc["announcements"]:
                if item["announcement_id"] == announcement_id:
                    return self._serialize_locked(doc, item)
        return None

    def _serialize_locked(self, doc: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
        payload = deepcopy(item)
        payload["status"] = self._effective_status(item)
        payload["dismissed_count"] = self._dismissed_count_locked(doc, item["announcement_id"])
        return payload

    def list_announcements(self) -> list[dict[str, Any]]:
        with self._lock:
            doc = self._load_locked()
            items = [self._serialize_locked(doc, item) for item in doc["announcements"]]
        items.sort(
            key=lambda item: (
                _parse_iso(item.get("updated_at")) or now_local(),
                _parse_iso(item.get("created_at")) or now_local(),
            ),
            reverse=True,
        )
        return items

    def create_announcement(self, payload: dict[str, Any], actor: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            doc = self._load_locked()
            now_iso = now_local().isoformat()
            item = self._normalize_announcement(
                {
                    "announcement_id": secrets.token_hex(12),
                    "title": payload.get("title"),
                    "body": payload.get("body"),
                    "kind": payload.get("kind"),
                    "priority": payload.get("priority"),
                    "status": payload.get("status"),
                    "dismissible": payload.get("dismissible", True),
                    "starts_at": payload.get("starts_at"),
                    "ends_at": payload.get("ends_at"),
                    "target": payload.get("target") or {},
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "created_by_user_id": str(actor.get("user_id") or ""),
                    "created_by_username": str(actor.get("username") or ""),
                }
            )
            assert item is not None
            doc["announcements"].append(item)
            self._save_locked(doc)
            return self._serialize_locked(doc, item)

    def update_announcement(self, announcement_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            doc = self._load_locked()
            for idx, item in enumerate(doc["announcements"]):
                if item["announcement_id"] != announcement_id:
                    continue
                merged = {
                    **item,
                    **{key: value for key, value in patch.items() if value is not None or key in {"starts_at", "ends_at", "target"}},
                    "updated_at": now_local().isoformat(),
                }
                if "target" in patch:
                    merged["target"] = patch.get("target") or self._default_target()
                normalized = self._normalize_announcement(merged)
                if normalized is None:
                    return None
                doc["announcements"][idx] = normalized
                self._save_locked(doc)
                return self._serialize_locked(doc, normalized)
        return None

    def delete_announcement(self, announcement_id: str) -> bool:
        with self._lock:
            doc = self._load_locked()
            before = len(doc["announcements"])
            doc["announcements"] = [item for item in doc["announcements"] if item["announcement_id"] != announcement_id]
            if len(doc["announcements"]) == before:
                return False
            self._save_locked(doc)
            return True

    def dismiss_announcement(self, user_id: str, announcement_id: str) -> None:
        with self._lock:
            doc = self._load_locked()
            bucket = doc["dismissals"].setdefault(str(user_id), {})
            bucket[str(announcement_id)] = now_local().isoformat()
            self._save_locked(doc)

    def _matches_target(self, item: dict[str, Any], user: dict[str, Any]) -> bool:
        target = self._normalize_target(item.get("target"))
        user_id = str(user.get("user_id") or "")
        role = str(user.get("role") or "").upper()
        if target["enabled_only"] and not bool(user.get("enabled", True)):
            return False
        if target["roles"] and role not in set(target["roles"]):
            return False
        if target["user_ids"] and user_id not in set(target["user_ids"]):
            return False
        if user_id and user_id in set(target["exclude_user_ids"]):
            return False
        return True

    def list_active_for_user(self, user: dict[str, Any]) -> list[dict[str, Any]]:
        role = str(user.get("role") or "").upper()
        if role == "ADMIN":
            return []
        with self._lock:
            doc = self._load_locked()
            dismissed = doc["dismissals"].get(str(user.get("user_id") or ""), {})
            items: list[dict[str, Any]] = []
            now = now_local()
            for item in doc["announcements"]:
                if item["announcement_id"] in dismissed:
                    continue
                if self._effective_status(item) != "ACTIVE":
                    continue
                starts_at = _parse_iso(item.get("starts_at"))
                ends_at = _parse_iso(item.get("ends_at"))
                if starts_at is not None and starts_at > now:
                    continue
                if ends_at is not None and ends_at <= now:
                    continue
                if not self._matches_target(item, user):
                    continue
                items.append(self._serialize_locked(doc, item))
        priority_order = {"HIGH": 2, "NORMAL": 1, "LOW": 0}
        items.sort(
            key=lambda item: (
                priority_order.get(str(item.get("priority") or "NORMAL").upper(), 1),
                _parse_iso(item.get("starts_at")) or _parse_iso(item.get("created_at")) or now_local(),
                _parse_iso(item.get("created_at")) or now_local(),
            ),
            reverse=True,
        )
        return items


announcement_store = AnnouncementStore(settings.data_dir)
