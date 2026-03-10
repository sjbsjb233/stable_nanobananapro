from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path
from typing import Any

from .config import settings
from .logging_setup import get_logger
from .time_utils import now_local

logger = get_logger("storage")


class JobStorage:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.jobs_dir = data_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def job_dir(self, job_id: str) -> Path:
        return self.jobs_dir / job_id

    def create_job_dirs(self, job_id: str) -> Path:
        root = self.job_dir(job_id)
        (root / "result").mkdir(parents=True, exist_ok=True)
        (root / "preview").mkdir(parents=True, exist_ok=True)
        (root / "logs").mkdir(parents=True, exist_ok=True)
        (root / "input").mkdir(parents=True, exist_ok=True)
        return root

    def write_json(self, path: Path, payload: dict[str, Any]) -> None:
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)

    def read_json(self, path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))

    def write_job_log(self, job_id: str, message: str) -> None:
        line = f"[{now_local().isoformat()}] {message}\n"
        log_file = self.job_dir(job_id) / "logs" / "job.log"
        with self._lock:
            log_file.parent.mkdir(parents=True, exist_ok=True)
            with log_file.open("a", encoding="utf-8") as f:
                f.write(line)
        logger.info("Job event: job_id=%s message=%s", job_id, message)

    def save_request(self, job_id: str, payload: dict[str, Any]) -> None:
        self.write_json(self.job_dir(job_id) / "request.json", payload)

    def save_response(self, job_id: str, payload: dict[str, Any]) -> None:
        self.write_json(self.job_dir(job_id) / "response.json", payload)

    def save_meta(self, job_id: str, payload: dict[str, Any]) -> None:
        self.write_json(self.job_dir(job_id) / "meta.json", payload)

    def load_meta(self, job_id: str) -> dict[str, Any]:
        return self.read_json(self.job_dir(job_id) / "meta.json")

    def load_request(self, job_id: str) -> dict[str, Any]:
        return self.read_json(self.job_dir(job_id) / "request.json")

    def load_response(self, job_id: str) -> dict[str, Any]:
        return self.read_json(self.job_dir(job_id) / "response.json")

    def save_input_reference(self, job_id: str, index: int, mime: str, content: bytes) -> str:
        ext = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
        }.get(mime, "bin")
        relative = f"input/reference_{index}.{ext}"
        path = self.job_dir(job_id) / relative
        path.write_bytes(content)
        return relative

    def save_result_image(self, job_id: str, image_id: str, content: bytes, mime: str) -> str:
        ext = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
        }.get(mime, "png")
        relative = f"result/{image_id}.{ext}"
        path = self.job_dir(job_id) / relative
        path.write_bytes(content)
        return relative

    def save_preview_image(self, job_id: str, image_id: str, content: bytes, mime: str) -> str:
        ext = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
        }.get(mime, "webp")
        relative = f"preview/{image_id}.{ext}"
        path = self.job_dir(job_id) / relative
        path.write_bytes(content)
        return relative

    def load_result_image(self, job_id: str, filename: str) -> bytes:
        return (self.job_dir(job_id) / filename).read_bytes()

    def delete_job(self, job_id: str) -> None:
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    def job_exists(self, job_id: str) -> bool:
        return (self.job_dir(job_id) / "meta.json").exists()

    def iter_job_meta(self) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        for child in self.jobs_dir.iterdir():
            if not child.is_dir():
                continue
            meta_path = child / "meta.json"
            if not meta_path.exists():
                continue
            try:
                output.append(self.read_json(meta_path))
            except Exception:
                continue
        return output


storage = JobStorage(settings.data_dir)
