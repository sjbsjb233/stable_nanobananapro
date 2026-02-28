from __future__ import annotations

import logging
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from .config import settings

_LOGGER_NAME = "nbp"
_INITIALIZED = False


def _safe_level(raw: str) -> int:
    value = (raw or "INFO").strip().upper()
    return getattr(logging, value, logging.INFO)


def setup_logging() -> logging.Logger:
    global _INITIALIZED
    logger = logging.getLogger(_LOGGER_NAME)
    if _INITIALIZED:
        return logger

    log_dir: Path = settings.log_dir
    log_dir.mkdir(parents=True, exist_ok=True)

    level = _safe_level(settings.log_level)
    fmt = logging.Formatter(
        fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )
    fmt.converter = time.gmtime

    file_handler = TimedRotatingFileHandler(
        filename=str(log_dir / "app.log"),
        when="midnight",
        interval=1,
        backupCount=max(1, int(settings.log_retention_days)),
        encoding="utf-8",
        utc=True,
    )
    file_handler.setFormatter(fmt)
    file_handler.setLevel(level)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(fmt)
    stream_handler.setLevel(level)

    logger.setLevel(level)
    logger.propagate = False
    logger.addHandler(file_handler)
    logger.addHandler(stream_handler)

    _INITIALIZED = True
    logger.info(
        "Logging initialized: dir=%s retention_days=%s level=%s",
        log_dir,
        settings.log_retention_days,
        settings.log_level,
    )
    return logger


def get_logger(name: str | None = None) -> logging.Logger:
    setup_logging()
    if not name:
        return logging.getLogger(_LOGGER_NAME)
    return logging.getLogger(f"{_LOGGER_NAME}.{name}")
