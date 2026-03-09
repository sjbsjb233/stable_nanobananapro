from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

from .config import settings
from .logging_setup import get_logger
from .storage import storage
from .time_utils import now_local

logger = get_logger("user_store")

USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]{3,32}$")
PASSWORD_HASH_PREFIX = "pbkdf2_sha256"
PASSWORD_HASH_ITERATIONS = 600_000
USER_POLICY_KEYS = {
    "daily_image_limit",
    "concurrent_jobs_limit",
    "turnstile_job_count_threshold",
    "turnstile_daily_usage_threshold",
}


def normalize_username(value: str) -> str:
    return str(value or "").strip().lower()


def validate_username(value: str) -> bool:
    return bool(USERNAME_PATTERN.fullmatch(normalize_username(value)))


def _hash_password(password: str, salt_hex: str | None = None) -> str:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_HASH_ITERATIONS,
    )
    return f"{PASSWORD_HASH_PREFIX}${PASSWORD_HASH_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        prefix, iterations_raw, salt_hex, digest_hex = encoded.split("$", 3)
        iterations = int(iterations_raw)
        if prefix != PASSWORD_HASH_PREFIX or iterations <= 0:
            return False
    except Exception:
        return False

    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt_hex),
        iterations,
    ).hex()
    return hmac.compare_digest(digest, digest_hex)


def _default_daily_usage() -> dict[str, int]:
    return {
        "jobs_created": 0,
        "jobs_succeeded": 0,
        "jobs_failed": 0,
        "images_generated": 0,
        "quota_resets": 0,
    }


class UserStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "auth" / "users.json"
        self._lock = threading.RLock()

    def _default_policy(self) -> dict[str, int]:
        return {
            "default_user_daily_image_limit": int(settings.default_user_daily_image_limit),
            "default_user_concurrent_jobs_limit": int(settings.default_user_concurrent_jobs_limit),
            "default_admin_concurrent_jobs_limit": int(settings.default_admin_concurrent_jobs_limit),
            "default_user_turnstile_job_count_threshold": int(settings.default_user_turnstile_job_count_threshold),
            "default_user_turnstile_daily_usage_threshold": int(settings.default_user_turnstile_daily_usage_threshold),
        }

    def _default_document(self) -> dict[str, Any]:
        return {
            "policy": self._default_policy(),
            "users": [],
            "daily_usage": {},
        }

    def _normalize_policy(self, raw: Any) -> dict[str, int]:
        policy = self._default_policy()
        if isinstance(raw, dict):
            for key in policy:
                value = raw.get(key)
                if isinstance(value, bool):
                    continue
                if isinstance(value, (int, float)):
                    policy[key] = max(0, int(value))
        return policy

    def _normalize_overrides(self, raw: Any) -> dict[str, int | None]:
        overrides: dict[str, int | None] = {}
        if not isinstance(raw, dict):
            return overrides
        for key in USER_POLICY_KEYS:
            value = raw.get(key)
            if value is None or value == "":
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                overrides[key] = max(0, int(value))
        return overrides

    def _normalize_user(self, raw: Any) -> dict[str, Any] | None:
        if not isinstance(raw, dict):
            return None

        username = normalize_username(raw.get("username"))
        if not validate_username(username):
            return None

        role = str(raw.get("role") or "USER").upper()
        if role not in {"ADMIN", "USER"}:
            role = "USER"

        now_iso = now_local().isoformat()
        password_hash = str(raw.get("password_hash") or "")
        if not password_hash:
            return None

        return {
            "user_id": str(raw.get("user_id") or secrets.token_hex(12)),
            "username": username,
            "role": role,
            "enabled": bool(raw.get("enabled", True)),
            "password_hash": password_hash,
            "policy_overrides": self._normalize_overrides(raw.get("policy_overrides")),
            "created_at": str(raw.get("created_at") or now_iso),
            "updated_at": str(raw.get("updated_at") or now_iso),
            "last_login_at": raw.get("last_login_at"),
        }

    def _normalize_document(self, raw: Any) -> dict[str, Any]:
        doc = self._default_document()
        if isinstance(raw, dict):
            doc["policy"] = self._normalize_policy(raw.get("policy"))

            users: list[dict[str, Any]] = []
            seen: set[str] = set()
            for item in raw.get("users") or []:
                user = self._normalize_user(item)
                if not user or user["username"] in seen:
                    continue
                users.append(user)
                seen.add(user["username"])
            doc["users"] = users

            daily_usage: dict[str, dict[str, dict[str, int]]] = {}
            raw_usage = raw.get("daily_usage") if isinstance(raw.get("daily_usage"), dict) else {}
            for date_key, per_user in raw_usage.items():
                if not isinstance(per_user, dict):
                    continue
                bucket: dict[str, dict[str, int]] = {}
                for user_id, stats in per_user.items():
                    normalized = _default_daily_usage()
                    if isinstance(stats, dict):
                        for metric in normalized:
                            value = stats.get(metric)
                            if isinstance(value, bool):
                                continue
                            if isinstance(value, (int, float)):
                                normalized[metric] = max(0, int(value))
                    bucket[str(user_id)] = normalized
                daily_usage[str(date_key)] = bucket
            doc["daily_usage"] = daily_usage
        return doc

    def _load_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._default_document()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            logger.exception("Failed to load user store, falling back to defaults: path=%s", self.path)
            return self._default_document()
        return self._normalize_document(raw)

    def _save_locked(self, doc: dict[str, Any]) -> None:
        storage.write_json(self.path, doc)

    def _find_user_locked(self, doc: dict[str, Any], *, user_id: str | None = None, username: str | None = None) -> dict[str, Any] | None:
        lookup_username = normalize_username(username) if username is not None else None
        for user in doc["users"]:
            if user_id and user["user_id"] == user_id:
                return user
            if lookup_username is not None and user["username"] == lookup_username:
                return user
        return None

    def sanitize_user(self, user: dict[str, Any]) -> dict[str, Any]:
        clean = deepcopy(user)
        clean.pop("password_hash", None)
        return clean

    def ensure_initialized(self) -> None:
        with self._lock:
            doc = self._load_locked()
            changed = False

            has_admin = any(str(user.get("role") or "").upper() == "ADMIN" for user in doc["users"])
            bootstrap_username = normalize_username(settings.bootstrap_admin_username)
            bootstrap_user = self._find_user_locked(doc, username=bootstrap_username) if bootstrap_username else None

            if not has_admin:
                username = normalize_username(settings.bootstrap_admin_username)
                if validate_username(username) and settings.bootstrap_admin_password and not bootstrap_user:
                    now_iso = now_local().isoformat()
                    doc["users"].append(
                        {
                            "user_id": secrets.token_hex(12),
                            "username": username,
                            "role": "ADMIN",
                            "enabled": True,
                            "password_hash": _hash_password(settings.bootstrap_admin_password),
                            "policy_overrides": {},
                            "created_at": now_iso,
                            "updated_at": now_iso,
                            "last_login_at": None,
                        }
                    )
                    changed = True
                    logger.warning("Bootstrapped admin user created: username=%s", username)
                elif bootstrap_user:
                    logger.warning("Bootstrap admin was not created because username=%s already exists", username)

            if changed or not self.path.exists():
                self._save_locked(doc)

    def get_policy(self) -> dict[str, int]:
        with self._lock:
            doc = self._load_locked()
            return deepcopy(doc["policy"])

    def update_policy(self, patch: dict[str, Any]) -> dict[str, int]:
        with self._lock:
            doc = self._load_locked()
            policy = doc["policy"]
            for key in self._default_policy():
                value = patch.get(key)
                if value is None or isinstance(value, bool):
                    continue
                if isinstance(value, (int, float)):
                    policy[key] = max(0, int(value))
            self._save_locked(doc)
            return deepcopy(policy)

    def get_effective_policy(self, user: dict[str, Any], policy: dict[str, int] | None = None) -> dict[str, int | None]:
        policy = deepcopy(policy or self.get_policy())
        role = str(user.get("role") or "USER").upper()
        overrides = self._normalize_overrides(user.get("policy_overrides"))

        if role == "ADMIN":
            effective: dict[str, int | None] = {
                "daily_image_limit": None,
                "concurrent_jobs_limit": policy["default_admin_concurrent_jobs_limit"],
                "turnstile_job_count_threshold": None,
                "turnstile_daily_usage_threshold": None,
            }
        else:
            effective = {
                "daily_image_limit": policy["default_user_daily_image_limit"],
                "concurrent_jobs_limit": policy["default_user_concurrent_jobs_limit"],
                "turnstile_job_count_threshold": policy["default_user_turnstile_job_count_threshold"],
                "turnstile_daily_usage_threshold": policy["default_user_turnstile_daily_usage_threshold"],
            }

        for key, value in overrides.items():
            effective[key] = value
        return effective

    def list_users(self) -> list[dict[str, Any]]:
        with self._lock:
            doc = self._load_locked()
            users = [self.sanitize_user(user) for user in doc["users"]]
        return sorted(users, key=lambda item: (item["role"] != "ADMIN", item["username"]))

    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self._load_locked()
            user = self._find_user_locked(doc, user_id=user_id)
            return self.sanitize_user(user) if user else None

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self._load_locked()
            user = self._find_user_locked(doc, username=username)
            return self.sanitize_user(user) if user else None

    def authenticate(self, username: str, password: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self._load_locked()
            user = self._find_user_locked(doc, username=username)
            if not user or not user.get("enabled"):
                return None
            if not verify_password(password, str(user.get("password_hash") or "")):
                return None
            now_iso = now_local().isoformat()
            user["last_login_at"] = now_iso
            user["updated_at"] = now_iso
            self._save_locked(doc)
            return self.sanitize_user(user)

    def create_user(
        self,
        *,
        username: str,
        password: str,
        role: str,
        enabled: bool = True,
        policy_overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not validate_username(normalized_username):
            raise ValueError("INVALID_USERNAME")
        now_iso = now_local().isoformat()
        user = {
            "user_id": secrets.token_hex(12),
            "username": normalized_username,
            "role": "ADMIN" if str(role or "USER").upper() == "ADMIN" else "USER",
            "enabled": bool(enabled),
            "password_hash": _hash_password(password),
            "policy_overrides": self._normalize_overrides(policy_overrides),
            "created_at": now_iso,
            "updated_at": now_iso,
            "last_login_at": None,
        }

        with self._lock:
            doc = self._load_locked()
            if self._find_user_locked(doc, username=normalized_username):
                raise ValueError("USERNAME_TAKEN")
            doc["users"].append(user)
            self._save_locked(doc)
        return self.sanitize_user(user)

    def update_user(
        self,
        user_id: str,
        *,
        password: str | None = None,
        role: str | None = None,
        enabled: bool | None = None,
        policy_overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            doc = self._load_locked()
            user = self._find_user_locked(doc, user_id=user_id)
            if not user:
                return None

            if password:
                user["password_hash"] = _hash_password(password)
            if role in {"ADMIN", "USER"}:
                user["role"] = role
            if enabled is not None:
                user["enabled"] = bool(enabled)
            if policy_overrides is not None:
                overrides = dict(user.get("policy_overrides") or {})
                for key in USER_POLICY_KEYS:
                    if key not in policy_overrides:
                        continue
                    value = policy_overrides.get(key)
                    if value is None or value == "":
                        overrides.pop(key, None)
                        continue
                    if isinstance(value, bool):
                        continue
                    if isinstance(value, (int, float)):
                        overrides[key] = max(0, int(value))
                user["policy_overrides"] = overrides

            user["updated_at"] = now_local().isoformat()
            self._save_locked(doc)
            return self.sanitize_user(user)

    def _usage_bucket_locked(self, doc: dict[str, Any], user_id: str, date_key: str | None = None) -> dict[str, int]:
        date_key = date_key or now_local().date().isoformat()
        per_day = doc["daily_usage"].setdefault(date_key, {})
        return per_day.setdefault(str(user_id), _default_daily_usage())

    def get_daily_usage(self, user_id: str, date_key: str | None = None) -> dict[str, int]:
        with self._lock:
            doc = self._load_locked()
            usage = deepcopy(self._usage_bucket_locked(doc, user_id, date_key))
        return usage

    def get_daily_usage_for_all(self, date_key: str | None = None) -> dict[str, dict[str, int]]:
        target_date = date_key or now_local().date().isoformat()
        with self._lock:
            doc = self._load_locked()
            raw = doc["daily_usage"].get(target_date, {})
            return {str(user_id): deepcopy(stats) for user_id, stats in raw.items()}

    def record_job_created(self, user_id: str) -> None:
        with self._lock:
            doc = self._load_locked()
            bucket = self._usage_bucket_locked(doc, user_id)
            bucket["jobs_created"] += 1
            self._save_locked(doc)

    def record_job_success(self, user_id: str, image_count: int) -> None:
        with self._lock:
            doc = self._load_locked()
            bucket = self._usage_bucket_locked(doc, user_id)
            bucket["jobs_succeeded"] += 1
            bucket["images_generated"] += max(0, int(image_count))
            self._save_locked(doc)

    def record_job_failure(self, user_id: str) -> None:
        with self._lock:
            doc = self._load_locked()
            bucket = self._usage_bucket_locked(doc, user_id)
            bucket["jobs_failed"] += 1
            self._save_locked(doc)

    def reset_daily_usage(self, user_id: str, date_key: str | None = None) -> dict[str, int]:
        with self._lock:
            doc = self._load_locked()
            bucket = self._usage_bucket_locked(doc, user_id, date_key)
            resets = bucket.get("quota_resets", 0) + 1
            bucket.clear()
            bucket.update(_default_daily_usage())
            bucket["quota_resets"] = resets
            self._save_locked(doc)
            return deepcopy(bucket)


user_store = UserStore(settings.data_dir)
