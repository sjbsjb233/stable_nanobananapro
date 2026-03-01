from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

APP_TZ = ZoneInfo("Asia/Shanghai")


def now_local() -> datetime:
    return datetime.now(APP_TZ)

