from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException, status

from .schemas import ErrorCode


def api_error(
    code: ErrorCode,
    message: str,
    http_status: int = status.HTTP_400_BAD_REQUEST,
    details: dict[str, Any] | None = None,
) -> HTTPException:
    return HTTPException(
        status_code=http_status,
        detail={
            "error": {
                "code": code,
                "message": message,
                "debug_id": str(uuid.uuid4()),
                "details": details or {},
            }
        },
    )
