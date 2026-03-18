from __future__ import annotations

import threading
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from .config import settings
from .logging_setup import get_logger
from .storage import storage
from .time_utils import now_local

logger = get_logger("storage_retention")

CLEANABLE_STATUSES = {"SUCCEEDED", "FAILED", "CANCELLED"}
ACTIVE_STATUSES = {"QUEUED", "RUNNING"}
SUGGESTED_RETENTION_DAYS = (7, 14, 30, 60, 90, 180, 365)
AUTO_CLEANUP_INTERVAL_SEC = 15 * 60
AUTO_CLEANUP_AFTER = time(hour=3, minute=0)


def _parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except Exception:
        return None
    if parsed.tzinfo is None:
        local_tz = now_local().tzinfo
        if local_tz is not None:
            parsed = parsed.replace(tzinfo=local_tz)
    return parsed


def _safe_positive_int(value: Any) -> int | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            if current.is_symlink():
                continue
            if current.is_file():
                total += int(current.stat().st_size)
                continue
            for child in current.iterdir():
                stack.append(child)
        except FileNotFoundError:
            continue
        except Exception:
            logger.exception("Failed to inspect size for path=%s", current)
    return total


def _local_job_date(meta: dict[str, Any]) -> date | None:
    created = _parse_iso(meta.get("created_at"))
    updated = _parse_iso(meta.get("updated_at"))
    dt = created or updated
    return dt.astimezone(now_local().tzinfo).date() if dt and dt.tzinfo else (dt.date() if dt else None)


@dataclass(frozen=True)
class _JobEntry:
    job_id: str
    status: str
    job_date: date
    size_bytes: int


class StorageRetentionStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "storage_retention.json"
        self._lock = threading.RLock()

    def _default_document(self) -> dict[str, Any]:
        return {
            "policy": {
                "enabled": False,
                "retention_days": None,
            },
            "runtime": {
                "last_run_at": None,
                "last_cutoff_date": None,
                "last_deleted_jobs": 0,
                "last_freed_bytes": 0,
                "last_error": None,
            },
        }

    def _normalize_policy(self, raw: Any) -> dict[str, Any]:
        policy = self._default_document()["policy"]
        if isinstance(raw, dict):
            policy["enabled"] = bool(raw.get("enabled", False))
            policy["retention_days"] = _safe_positive_int(raw.get("retention_days"))
        return policy

    def _normalize_runtime(self, raw: Any) -> dict[str, Any]:
        runtime = self._default_document()["runtime"]
        if not isinstance(raw, dict):
            return runtime
        runtime["last_run_at"] = str(raw.get("last_run_at") or "") or None
        runtime["last_cutoff_date"] = str(raw.get("last_cutoff_date") or "") or None
        runtime["last_deleted_jobs"] = max(0, int(raw.get("last_deleted_jobs") or 0))
        runtime["last_freed_bytes"] = max(0, int(raw.get("last_freed_bytes") or 0))
        runtime["last_error"] = str(raw.get("last_error") or "") or None
        return runtime

    def _normalize_document(self, raw: Any) -> dict[str, Any]:
        doc = self._default_document()
        if isinstance(raw, dict):
            doc["policy"] = self._normalize_policy(raw.get("policy"))
            doc["runtime"] = self._normalize_runtime(raw.get("runtime"))
        return doc

    def _load_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._default_document()
        try:
            raw = storage.read_json(self.path)
        except Exception:
            logger.exception("Failed to load storage retention document: path=%s", self.path)
            return self._default_document()
        return self._normalize_document(raw)

    def _save_locked(self, doc: dict[str, Any]) -> None:
        storage.write_json(self.path, doc)

    def ensure_initialized(self) -> None:
        with self._lock:
            doc = self._load_locked()
            if not self.path.exists():
                self._save_locked(doc)

    def get_policy(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._load_locked()["policy"])

    def get_runtime(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._load_locked()["runtime"])

    def update_policy(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            doc = self._load_locked()
            policy = doc["policy"]
            if "enabled" in patch:
                policy["enabled"] = bool(patch.get("enabled"))
            if "retention_days" in patch:
                policy["retention_days"] = _safe_positive_int(patch.get("retention_days"))
            self._save_locked(doc)
            return deepcopy(policy)

    def update_runtime(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            doc = self._load_locked()
            runtime = doc["runtime"]
            for key in runtime:
                if key not in patch:
                    continue
                value = patch.get(key)
                if key in {"last_deleted_jobs", "last_freed_bytes"}:
                    runtime[key] = max(0, int(value or 0))
                else:
                    runtime[key] = str(value).strip() if value not in (None, "") else None
            self._save_locked(doc)
            return deepcopy(runtime)


class StorageRetentionService:
    def __init__(self, store: StorageRetentionStore) -> None:
        self._store = store
        self._cleanup_lock = threading.Lock()
        self._thread_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def ensure_initialized(self) -> None:
        self._store.ensure_initialized()

    def start(self) -> None:
        with self._thread_lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._loop, name="storage-retention", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        with self._thread_lock:
            thread = self._thread
            self._stop_event.set()
        if thread:
            thread.join(timeout=3)
        with self._thread_lock:
            self._thread = None
            self._stop_event.clear()

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_automatic_cleanup_if_due()
            except Exception:
                logger.exception("Automatic storage cleanup loop failed")
            if self._stop_event.wait(AUTO_CLEANUP_INTERVAL_SEC):
                return

    def get_policy(self) -> dict[str, Any]:
        return self._store.get_policy()

    def update_policy(self, patch: dict[str, Any]) -> dict[str, Any]:
        return self._store.update_policy(patch)

    def get_runtime(self) -> dict[str, Any]:
        return self._store.get_runtime()

    def get_overview(self) -> dict[str, Any]:
        scan = self._scan()
        suggestions = self._build_suggestions(scan, now_local().date())
        return {
            "data_total_bytes": scan["data_total_bytes"],
            "jobs_total_bytes": scan["jobs_total_bytes"],
            "non_job_bytes": scan["non_job_bytes"],
            "deletable_jobs": scan["deletable_jobs"],
            "deletable_bytes": scan["deletable_bytes"],
            "oldest_job_date": scan["oldest_job_date"],
            "newest_job_date": scan["newest_job_date"],
            "buckets": scan["buckets"],
            "suggestions": suggestions["items"],
            "recommended_suggestion": suggestions["recommended"],
            "policy": self._store.get_policy(),
            "runtime": self._store.get_runtime(),
        }

    def preview_cleanup(self, cutoff_date: date) -> dict[str, Any]:
        scan = self._scan()
        return self._cleanup_summary(scan, cutoff_date)

    def execute_cleanup(self, cutoff_date: date, *, trigger: str) -> dict[str, Any]:
        with self._cleanup_lock:
            scan = self._scan()
            summary = self._cleanup_summary(scan, cutoff_date)
            deleted_jobs = 0
            freed_bytes = 0
            for entry in summary["_matched_entries"]:
                path = storage.job_dir(entry.job_id)
                before = _dir_size(path)
                if before <= 0 and not path.exists():
                    continue
                storage.delete_job(entry.job_id)
                after = _dir_size(path)
                delta = max(0, before - after)
                freed_bytes += delta
                if delta > 0 or (before > 0 and not path.exists()):
                    deleted_jobs += 1
            logger.info(
                "Storage cleanup completed: trigger=%s cutoff_date=%s deleted_jobs=%s freed_bytes=%s active_skipped=%s",
                trigger,
                cutoff_date.isoformat(),
                deleted_jobs,
                freed_bytes,
                summary["active_jobs_skipped"],
            )
            return {
                "cutoff_date": cutoff_date,
                "deleted_jobs": deleted_jobs,
                "freed_bytes": freed_bytes,
                "earliest_job_date": summary["earliest_job_date"],
                "latest_job_date": summary["latest_job_date"],
                "active_jobs_skipped": summary["active_jobs_skipped"],
            }

    def run_automatic_cleanup_if_due(self, *, now: datetime | None = None) -> dict[str, Any] | None:
        now = now or now_local()
        policy = self._store.get_policy()
        if not policy.get("enabled"):
            return None
        retention_days = _safe_positive_int(policy.get("retention_days"))
        if retention_days is None:
            return None
        if now.timetz().replace(tzinfo=None) < AUTO_CLEANUP_AFTER:
            return None
        runtime = self._store.get_runtime()
        last_run = _parse_iso(runtime.get("last_run_at"))
        if last_run is not None and last_run.astimezone(now.tzinfo).date() == now.date():
            return None
        cutoff_date = now.date() - timedelta(days=retention_days)
        try:
            result = self.execute_cleanup(cutoff_date, trigger="automatic")
            runtime_patch = {
                "last_run_at": now.isoformat(),
                "last_cutoff_date": cutoff_date.isoformat(),
                "last_deleted_jobs": result["deleted_jobs"],
                "last_freed_bytes": result["freed_bytes"],
                "last_error": None,
            }
            self._store.update_runtime(runtime_patch)
            return result
        except Exception as exc:
            logger.exception("Automatic storage cleanup failed: cutoff_date=%s", cutoff_date.isoformat())
            self._store.update_runtime(
                {
                    "last_run_at": now.isoformat(),
                    "last_cutoff_date": cutoff_date.isoformat(),
                    "last_deleted_jobs": 0,
                    "last_freed_bytes": 0,
                    "last_error": str(exc),
                }
            )
            raise

    def _scan(self) -> dict[str, Any]:
        data_total_bytes = _dir_size(storage.data_dir)
        jobs_total_bytes = _dir_size(storage.jobs_dir)
        non_job_bytes = max(0, data_total_bytes - jobs_total_bytes)
        entries: list[_JobEntry] = []
        for child in storage.jobs_dir.iterdir():
            if not child.is_dir():
                continue
            meta_path = child / "meta.json"
            if not meta_path.exists():
                continue
            try:
                meta = storage.read_json(meta_path)
            except Exception:
                logger.exception("Failed to parse job metadata during storage scan: job_dir=%s", child)
                continue
            job_date = _local_job_date(meta)
            if job_date is None:
                continue
            entries.append(
                _JobEntry(
                    job_id=str(meta.get("job_id") or child.name),
                    status=str(meta.get("status") or ""),
                    job_date=job_date,
                    size_bytes=_dir_size(child),
                )
            )

        deletable_entries = [entry for entry in entries if entry.status in CLEANABLE_STATUSES]
        deletable_entries.sort(key=lambda item: (item.job_date, item.job_id))
        buckets: list[dict[str, Any]] = []
        cumulative_jobs = 0
        cumulative_bytes = 0
        current_date: date | None = None
        current_jobs = 0
        current_bytes = 0
        for entry in deletable_entries:
            if current_date is None:
                current_date = entry.job_date
            if entry.job_date != current_date:
                cumulative_jobs += current_jobs
                cumulative_bytes += current_bytes
                buckets.append(
                    {
                        "job_date": current_date,
                        "job_count": current_jobs,
                        "total_bytes": current_bytes,
                        "cumulative_jobs": cumulative_jobs,
                        "cumulative_bytes": cumulative_bytes,
                    }
                )
                current_date = entry.job_date
                current_jobs = 0
                current_bytes = 0
            current_jobs += 1
            current_bytes += entry.size_bytes
        if current_date is not None:
            cumulative_jobs += current_jobs
            cumulative_bytes += current_bytes
            buckets.append(
                {
                    "job_date": current_date,
                    "job_count": current_jobs,
                    "total_bytes": current_bytes,
                    "cumulative_jobs": cumulative_jobs,
                    "cumulative_bytes": cumulative_bytes,
                }
            )

        return {
            "data_total_bytes": data_total_bytes,
            "jobs_total_bytes": jobs_total_bytes,
            "non_job_bytes": non_job_bytes,
            "entries": entries,
            "deletable_jobs": len(deletable_entries),
            "deletable_bytes": sum(entry.size_bytes for entry in deletable_entries),
            "oldest_job_date": deletable_entries[0].job_date if deletable_entries else None,
            "newest_job_date": deletable_entries[-1].job_date if deletable_entries else None,
            "buckets": buckets,
        }

    def _cleanup_summary(self, scan: dict[str, Any], cutoff_date: date) -> dict[str, Any]:
        matched = [
            entry
            for entry in scan["entries"]
            if entry.job_date < cutoff_date and entry.status in CLEANABLE_STATUSES
        ]
        active_skipped = sum(
            1
            for entry in scan["entries"]
            if entry.job_date < cutoff_date and entry.status in ACTIVE_STATUSES
        )
        matched.sort(key=lambda item: (item.job_date, item.job_id))
        return {
            "cutoff_date": cutoff_date,
            "matched_jobs": len(matched),
            "estimated_freed_bytes": sum(entry.size_bytes for entry in matched),
            "earliest_job_date": matched[0].job_date if matched else None,
            "latest_job_date": matched[-1].job_date if matched else None,
            "active_jobs_skipped": active_skipped,
            "_matched_entries": matched,
        }

    def _build_suggestions(self, scan: dict[str, Any], today: date) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        deletable_bytes = int(scan["deletable_bytes"])
        for retention_days in SUGGESTED_RETENTION_DAYS:
            cutoff_date = today - timedelta(days=retention_days)
            summary = self._cleanup_summary(scan, cutoff_date)
            if summary["matched_jobs"] <= 0:
                continue
            items.append(
                {
                    "retention_days": retention_days,
                    "cutoff_date": cutoff_date,
                    "matched_jobs": summary["matched_jobs"],
                    "estimated_freed_bytes": summary["estimated_freed_bytes"],
                    "estimated_freed_ratio_of_jobs": (
                        float(summary["estimated_freed_bytes"]) / float(deletable_bytes)
                        if deletable_bytes > 0
                        else 0.0
                    ),
                }
            )
        if not items:
            return {"items": [], "recommended": None}
        threshold = max(1024 * 1024 * 1024, int(deletable_bytes * 0.15))
        recommended = next(
            (item for item in items if int(item["estimated_freed_bytes"]) >= threshold),
            items[0],
        )
        return {"items": items, "recommended": recommended}


storage_retention_store = StorageRetentionStore(settings.data_dir)
storage_retention_service = StorageRetentionService(storage_retention_store)
