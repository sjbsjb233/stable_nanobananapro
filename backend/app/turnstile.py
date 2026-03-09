from __future__ import annotations

from typing import Any

import httpx

from .config import settings

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


async def verify_turnstile_token(token: str, remote_ip: str | None = None) -> dict[str, Any]:
    payload = {
        "secret": settings.turnstile_secret_key,
        "response": token,
    }
    if remote_ip:
        payload["remoteip"] = remote_ip

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(TURNSTILE_VERIFY_URL, data=payload)
        response.raise_for_status()
        body = response.json()

    if isinstance(body, dict):
        return body
    return {"success": False, "error-codes": ["invalid-json"]}
