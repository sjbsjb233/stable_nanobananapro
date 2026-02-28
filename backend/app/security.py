from __future__ import annotations

import hashlib
import hmac
import re
import secrets

JOB_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
IMAGE_ID_PATTERN = re.compile(r"^image_[0-9]+$")


def new_job_id() -> str:
    return secrets.token_hex(16)


def validate_job_id(job_id: str) -> bool:
    return bool(JOB_ID_PATTERN.fullmatch(job_id))


def validate_image_id(image_id: str) -> bool:
    return bool(IMAGE_ID_PATTERN.fullmatch(image_id))


def new_job_access_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_token(token: str, token_hash: str) -> bool:
    computed = hash_token(token)
    return hmac.compare_digest(computed, token_hash)
