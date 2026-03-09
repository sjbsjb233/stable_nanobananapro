from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Deque

from fastapi import Request, status

from .config import settings
from .errors import api_error
from .schemas import ErrorCode
from .user_store import user_store


class InMemoryRateLimiter:
    def __init__(self, max_per_minute: int) -> None:
        self.max_per_minute = max_per_minute
        self._events: dict[str, Deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        now = time.time()
        cutoff = now - 60
        with self._lock:
            bucket = self._events[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self.max_per_minute:
                return False
            bucket.append(now)
            return True


limiter = InMemoryRateLimiter(settings.rate_limit_per_minute)


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def job_read_rate_limit(request: Request) -> None:
    session = request.scope.get("session")
    user_id = session.get("user_id") if isinstance(session, dict) else None
    if user_id and user_store.get_user_by_id(str(user_id)):
        key = f"user:{user_id}:job-read"
    else:
        key = f"ip:{get_client_ip(request)}:job-read"
    if not limiter.hit(key):
        raise api_error(
            ErrorCode.RATE_LIMITED,
            "Too many requests",
            http_status=status.HTTP_429_TOO_MANY_REQUESTS,
        )
