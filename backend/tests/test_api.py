from __future__ import annotations

import base64
import io
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import settings
from app.gemini_client import GeminiError, gemini_client
from app.job_manager import job_manager
from app.main import app
from app.announcement_store import announcement_store
from app.provider_store import provider_store
from app.rate_limiter import InMemoryRateLimiter
from app.storage import storage
from app.user_store import user_store


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7m6XQAAAAASUVORK5CYII="
)
UTC_PLUS_8 = timezone(timedelta(hours=8))


def make_png(width: int = 2200, height: int = 1600, color: tuple[int, int, int] = (52, 120, 210)) -> bytes:
    image = Image.new("RGB", (width, height), color)
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def make_webp(width: int = 1200, height: int = 900, color: tuple[int, int, int] = (52, 120, 210)) -> bytes:
    image = Image.new("RGB", (width, height), color)
    out = io.BytesIO()
    image.save(out, format="WEBP", quality=72, method=6)
    return out.getvalue()


def iso_at(offset: timedelta) -> str:
    return (datetime.now(UTC_PLUS_8) + offset).replace(microsecond=0).isoformat()


def configured_cors_origin() -> str:
    for middleware in app.user_middleware:
        allow_origins = getattr(middleware, "kwargs", {}).get("allow_origins")
        if allow_origins:
            return allow_origins[0]
    return "http://127.0.0.1:5173"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "log_dir", tmp_path / "logs")
    monkeypatch.setattr(settings, "cors_allow_origins", "http://127.0.0.1:5173,http://localhost:5173")
    monkeypatch.setattr(settings, "bootstrap_admin_username", "admin")
    monkeypatch.setattr(settings, "bootstrap_admin_password", "admin123456")
    monkeypatch.setattr(settings, "turnstile_secret_key", "test-secret")
    monkeypatch.setattr(settings, "turnstile_site_key", "test-site-key")
    monkeypatch.setattr(settings, "session_secret_key", "test-session-secret")
    monkeypatch.setattr(settings, "test_env_admin_bypass", False)

    storage.data_dir = tmp_path
    storage.jobs_dir = tmp_path / "jobs"
    storage.jobs_dir.mkdir(parents=True, exist_ok=True)
    user_store.path = tmp_path / "auth" / "users.json"
    provider_store.path = tmp_path / "providers.json"
    announcement_store.path = tmp_path / "announcements.json"
    provider_store.reset_runtime_state()

    async def fake_turnstile(token: str, remote_ip: str | None = None):
        assert token
        return {"success": True, "hostname": "test.local"}

    monkeypatch.setattr("app.main.verify_turnstile_token", fake_turnstile)

    with TestClient(app) as test_client:
        yield test_client


def login(client: TestClient, username: str = "admin", password: str = "admin123456") -> dict:
    resp = client.post(
        "/v1/auth/login",
        json={
            "username": username,
            "password": password,
            "turnstile_token": "turnstile-ok",
        },
    )
    assert resp.status_code == 200
    return resp.json()


def wait_for_job_terminal(client: TestClient, job_id: str, *, job_token: str | None = None, attempts: int = 40) -> dict:
    headers = {"X-Job-Token": job_token} if job_token else None
    meta = None
    for _ in range(attempts):
        resp = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert resp.status_code == 200
        meta = resp.json()
        if meta["status"] in {"SUCCEEDED", "FAILED"}:
            break
        time.sleep(0.1)
    assert meta is not None
    return meta


def test_auth_required_and_login(client: TestClient) -> None:
    unauthorized = client.get("/v1/models")
    assert unauthorized.status_code == 401

    session = login(client)
    assert session["user"]["username"] == "admin"
    assert session["user"]["role"] == "ADMIN"

    me = client.get("/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["authenticated"] is True


def test_invalid_session_cookie_does_not_crash(client: TestClient) -> None:
    client.cookies.set("nbp_session", "definitely-not-a-valid-session-cookie")
    me = client.get("/v1/auth/me")
    assert me.status_code == 401
    assert me.json()["error"]["code"] == "AUTH_REQUIRED"


def test_test_env_admin_bypass_authenticates_without_session(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "test_env_admin_bypass", True)
    client.cookies.clear()
    client.cookies.set("nbp_session", "definitely-not-a-valid-session-cookie")

    me = client.get("/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["authenticated"] is True
    assert me.json()["user"]["username"] == "admin"
    assert me.json()["user"]["role"] == "ADMIN"

    models = client.get("/v1/models")
    assert models.status_code == 200
    assert models.json()["default_model"]


def test_test_env_admin_bypass_login_ignores_credentials_and_turnstile(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "test_env_admin_bypass", True)

    resp = client.post(
        "/v1/auth/login",
        json={
            "username": "nobody",
            "password": "whatever123",
            "turnstile_token": "ignored-in-test-mode",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["authenticated"] is True
    assert body["user"]["username"] == "admin"
    assert body["user"]["role"] == "ADMIN"


def test_change_password_updates_hash_and_keeps_session(client: TestClient) -> None:
    login(client)

    resp = client.patch(
        "/v1/auth/password",
        json={
            "current_password": "admin123456",
            "new_password": "admin654321",
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["authenticated"] is True
    assert body["user"]["username"] == "admin"

    me = client.get("/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["authenticated"] is True

    client.post("/v1/auth/logout")

    old_login = client.post(
        "/v1/auth/login",
        json={
            "username": "admin",
            "password": "admin123456",
            "turnstile_token": "turnstile-ok",
        },
    )
    assert old_login.status_code == 401
    assert old_login.json()["error"]["code"] == "INVALID_CREDENTIALS"

    new_login = client.post(
        "/v1/auth/login",
        json={
            "username": "admin",
            "password": "admin654321",
            "turnstile_token": "turnstile-ok",
        },
    )
    assert new_login.status_code == 200
    assert new_login.json()["authenticated"] is True


def test_change_password_rejects_invalid_current_password(client: TestClient) -> None:
    login(client)

    resp = client.patch(
        "/v1/auth/password",
        json={
            "current_password": "wrongpass123",
            "new_password": "admin654321",
        },
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "INVALID_CREDENTIALS"

    client.post("/v1/auth/logout")
    relogin = client.post(
        "/v1/auth/login",
        json={
            "username": "admin",
            "password": "admin123456",
            "turnstile_token": "turnstile-ok",
        },
    )
    assert relogin.status_code == 200
    assert relogin.json()["authenticated"] is True


def test_change_password_requires_auth(client: TestClient) -> None:
    resp = client.patch(
        "/v1/auth/password",
        json={
            "current_password": "admin123456",
            "new_password": "admin654321",
        },
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "AUTH_REQUIRED"


def test_change_password_rejects_same_password(client: TestClient) -> None:
    login(client)

    resp = client.patch(
        "/v1/auth/password",
        json={
            "current_password": "admin123456",
            "new_password": "admin123456",
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_INPUT"


def test_cors_preflight_allows_patch_for_admin_endpoints(client: TestClient) -> None:
    resp = client.options(
        "/v1/admin/policy",
        headers={
            "Origin": configured_cors_origin(),
            "Access-Control-Request-Method": "PATCH",
        },
    )
    assert resp.status_code == 200
    allow_methods = resp.headers.get("access-control-allow-methods", "")
    assert "PATCH" in allow_methods


def test_announcements_require_auth_and_admin_management(client: TestClient) -> None:
    starts_at = iso_at(timedelta(hours=-2))
    ends_at = iso_at(timedelta(hours=12))
    invalid_starts_at = iso_at(timedelta(hours=2))
    invalid_ends_at = iso_at(timedelta(hours=1))

    unauthorized = client.get("/v1/announcements/active")
    assert unauthorized.status_code == 401

    login(client)

    admin_active = client.get("/v1/announcements/active")
    assert admin_active.status_code == 200
    assert admin_active.json()["items"] == []

    invalid = client.post(
        "/v1/admin/announcements",
        json={
            "title": "bad",
            "body": "bad",
            "status": "ACTIVE",
            "starts_at": invalid_starts_at,
            "ends_at": invalid_ends_at,
        },
    )
    assert invalid.status_code == 422

    created = client.post(
        "/v1/admin/announcements",
        json={
            "title": "maintenance",
            "body": "backend will restart tonight",
            "kind": "MAINTENANCE",
            "priority": "HIGH",
            "status": "ACTIVE",
            "dismissible": True,
            "starts_at": starts_at,
            "ends_at": ends_at,
            "target": {"roles": ["USER"], "enabled_only": True, "user_ids": [], "exclude_user_ids": []},
        },
    )
    assert created.status_code == 201
    announcement = created.json()
    assert announcement["title"] == "maintenance"
    assert announcement["status"] == "ACTIVE"

    listed = client.get("/v1/admin/announcements")
    assert listed.status_code == 200
    assert listed.json()["items"][0]["announcement_id"] == announcement["announcement_id"]

    updated = client.patch(
        f"/v1/admin/announcements/{announcement['announcement_id']}",
        json={"status": "PAUSED", "title": "maintenance paused"},
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "PAUSED"
    assert updated.json()["title"] == "maintenance paused"

    deleted = client.delete(f"/v1/admin/announcements/{announcement['announcement_id']}")
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True


def test_active_announcements_filter_dismiss_and_delete(client: TestClient) -> None:
    active_starts_at = iso_at(timedelta(days=-1))
    active_ends_at = iso_at(timedelta(days=1))
    future_starts_at = iso_at(timedelta(days=30))
    future_ends_at = iso_at(timedelta(days=31))
    expired_starts_at = iso_at(timedelta(days=-3))
    expired_ends_at = iso_at(timedelta(days=-2))

    login(client)
    create_user = client.post(
        "/v1/admin/users",
        json={
            "username": "alice",
            "password": "alice123456",
            "role": "USER",
            "enabled": True,
            "policy_overrides": {},
        },
    )
    assert create_user.status_code == 201
    alice = create_user.json()

    visible = client.post(
        "/v1/admin/announcements",
        json={
            "title": "welcome",
            "body": "hello alice",
                "kind": "INFO",
                "priority": "NORMAL",
                "status": "ACTIVE",
                "dismissible": True,
                "starts_at": active_starts_at,
                "ends_at": active_ends_at,
                "target": {"roles": ["USER"], "enabled_only": True, "user_ids": [], "exclude_user_ids": []},
            },
    )
    assert visible.status_code == 201
    visible_id = visible.json()["announcement_id"]

    targeted = client.post(
        "/v1/admin/announcements",
        json={
            "title": "targeted",
            "body": "only alice should see this",
                "kind": "TIP",
                "priority": "HIGH",
                "status": "ACTIVE",
                "dismissible": True,
                "starts_at": active_starts_at,
                "ends_at": active_ends_at,
                "target": {"roles": ["USER"], "enabled_only": True, "user_ids": [alice["user_id"]], "exclude_user_ids": []},
            },
    )
    assert targeted.status_code == 201
    targeted_id = targeted.json()["announcement_id"]

    excluded = client.post(
        "/v1/admin/announcements",
        json={
            "title": "excluded",
            "body": "alice must not see this",
                "kind": "WARNING",
                "priority": "HIGH",
                "status": "ACTIVE",
                "dismissible": True,
                "starts_at": active_starts_at,
                "ends_at": active_ends_at,
                "target": {"roles": ["USER"], "enabled_only": True, "user_ids": [], "exclude_user_ids": [alice["user_id"]]},
            },
    )
    assert excluded.status_code == 201

    future = client.post(
        "/v1/admin/announcements",
        json={
            "title": "future",
            "body": "not yet live",
            "status": "ACTIVE",
            "starts_at": future_starts_at,
            "ends_at": future_ends_at,
        },
    )
    assert future.status_code == 201

    expired = client.post(
        "/v1/admin/announcements",
        json={
            "title": "expired",
            "body": "already expired",
            "status": "ACTIVE",
            "starts_at": expired_starts_at,
            "ends_at": expired_ends_at,
        },
    )
    assert expired.status_code == 201

    paused = client.post(
        "/v1/admin/announcements",
        json={
                "title": "paused",
                "body": "paused item",
                "status": "PAUSED",
                "starts_at": active_starts_at,
                "ends_at": active_ends_at,
            },
        )
    assert paused.status_code == 201

    login(client, "alice", "alice123456")
    active = client.get("/v1/announcements/active")
    assert active.status_code == 200
    ids = [item["announcement_id"] for item in active.json()["items"]]
    assert ids == [targeted_id, visible_id]

    dismissed = client.post(f"/v1/announcements/{visible_id}/dismiss")
    assert dismissed.status_code == 200
    assert dismissed.json()["success"] is True

    dismissed_again = client.post(f"/v1/announcements/{visible_id}/dismiss")
    assert dismissed_again.status_code == 200

    after_dismiss = client.get("/v1/announcements/active")
    assert after_dismiss.status_code == 200
    ids_after_dismiss = [item["announcement_id"] for item in after_dismiss.json()["items"]]
    assert ids_after_dismiss == [targeted_id]

    login(client)
    updated = client.patch(
        f"/v1/admin/announcements/{visible_id}",
        json={"body": "hello alice, updated"},
    )
    assert updated.status_code == 200

    removed = client.delete(f"/v1/admin/announcements/{targeted_id}")
    assert removed.status_code == 200

    login(client, "alice", "alice123456")
    final_active = client.get("/v1/announcements/active")
    assert final_active.status_code == 200
    assert final_active.json()["items"] == []


def test_job_lifecycle(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "inlineData": {
                                        "mimeType": "image/png",
                                        "data": base64.b64encode(PNG_1X1).decode(),
                                    }
                                }
                            ]
                        }
                    }
                ]
            },
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {
                "promptTokenCount": 100,
                "cachedContentTokenCount": 0,
                "candidatesTokenCount": 50,
                "thoughtsTokenCount": 10,
                "totalTokenCount": 160,
            },
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 123,
            "upstream_model": "gemini-3.1-flash-image-4k",
            "upstream_response_model": "gemini-3.1-flash-image-4k",
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", fake_generate_image)
    login(client)

    r = client.post(
        "/v1/jobs",
        json={
            "prompt": "test prompt",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert r.status_code == 201
    body = r.json()
    job_id = body["job_id"]

    meta = None
    for _ in range(30):
        rr = client.get(f"/v1/jobs/{job_id}")
        assert rr.status_code == 200
        meta = rr.json()
        if meta["status"] in {"SUCCEEDED", "FAILED"}:
            break
        time.sleep(0.1)

    assert meta is not None
    assert meta["status"] == "SUCCEEDED"
    assert meta["owner"]["username"] == "admin"
    assert meta["usage"]["total_token_count"] == 160
    assert meta["billing"]["estimated_cost_usd"] > 0
    assert isinstance(meta.get("timing"), dict)
    assert meta["timing"].get("started_at")
    assert meta["timing"].get("finished_at")
    assert isinstance(meta["timing"].get("run_duration_ms"), int)
    assert meta["timing"]["run_duration_ms"] >= 0
    assert isinstance(meta["timing"].get("queue_wait_ms"), int)
    assert meta["timing"]["queue_wait_ms"] >= 0

    req = client.get(f"/v1/jobs/{job_id}/request")
    assert req.status_code == 200

    resp = client.get(f"/v1/jobs/{job_id}/response")
    assert resp.status_code == 200
    assert resp.json()["response"]["upstream_model"] == "gemini-3.1-flash-image-4k"
    assert resp.json()["response"]["upstream_response_model"] == "gemini-3.1-flash-image-4k"
    assert meta["response"]["upstream_model"] == "gemini-3.1-flash-image-4k"
    assert meta["response"]["upstream_response_model"] == "gemini-3.1-flash-image-4k"

    batch = client.post(
        "/v1/jobs/batch-meta",
        json={
            "jobs": [
                {"job_id": job_id, "job_access_token": body["job_access_token"]},
                {"job_id": "f" * 32, "job_access_token": "wrong-token"},
            ],
            "fields": ["status", "timing", "billing", "owner"],
        },
    )
    assert batch.status_code == 200
    batch_body = batch.json()
    assert batch_body["requested"] == 2
    assert batch_body["ok"] == 1
    assert batch_body["items"][0]["job_id"] == job_id
    assert batch_body["items"][0]["meta"]["owner"]["username"] == "admin"
    assert "f" * 32 in batch_body["not_found"]

    active = client.post(
        "/v1/jobs/active",
        json={"jobs": [{"job_id": job_id, "job_access_token": body["job_access_token"]}]},
    )
    assert active.status_code == 200
    active_body = active.json()
    assert active_body["requested"] == 1
    assert active_body["active_count"] == 0
    assert active_body["settled_count"] == 1

    summary_api = client.post(
        "/v1/dashboard/summary",
        json={"jobs": [{"job_id": job_id, "job_access_token": body["job_access_token"]}], "limit": 50},
    )
    assert summary_api.status_code == 200
    summary_body = summary_api.json()
    assert summary_body["requested"] == 1
    assert summary_body["ok"] == 1
    assert "today_count" in summary_body["stats"]

    img = client.get(f"/v1/jobs/{job_id}/images/image_0")
    assert img.status_code == 200
    assert img.headers["content-type"].startswith("image/")

    preview = client.get(f"/v1/jobs/{job_id}/images/image_0/preview")
    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("image/webp")
    assert preview.headers["cache-control"] == "private, max-age=86400"

    deleted = client.delete(f"/v1/jobs/{job_id}")
    assert deleted.status_code == 200
    not_found = client.get(f"/v1/jobs/{job_id}")
    assert not_found.status_code == 404


def test_multi_provider_prefers_cheaper_then_falls_back(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings,
        "upstream_providers_json",
        json.dumps(
            [
                {
                    "provider_id": "cheap-gemini",
                    "label": "Cheap Gemini",
                    "adapter_type": "gemini_v1beta",
                    "base_url": "http://cheap.example/v1beta",
                    "api_key": "cheap-key",
                    "cost_per_image_cny": 0.05,
                    "initial_balance_cny": 10,
                    "supported_models": ["gemini-3-pro-image-preview"],
                },
                {
                    "provider_id": "mmw-backup",
                    "label": "MMW Backup",
                    "adapter_type": "openai_chat_image",
                    "base_url": "https://api.example",
                    "api_key": "backup-key",
                    "cost_per_image_cny": 0.09,
                    "initial_balance_cny": 20,
                    "supported_models": ["gemini-3-pro-image-preview"],
                },
            ]
        ),
    )
    provider_store.ensure_initialized()

    def fail_cheap(*args, **kwargs):
        raise GeminiError(code="UPSTREAM_TIMEOUT", message="cheap timeout", retryable=True)

    def succeed_backup(*args, **kwargs):
        return {
            "raw": {
                "choices": [
                    {
                        "message": {
                            "content": "![Generated Image](https://example.invalid/image.png)",
                        },
                        "finish_reason": "stop",
                    }
                ]
            },
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"promptTokenCount": 12, "candidatesTokenCount": 4, "totalTokenCount": 16},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 234,
            "upstream_model": "[A]gemini-3-pro-image-preview",
        }

    monkeypatch.setattr(gemini_client, "_call_gemini_v1beta", fail_cheap)
    monkeypatch.setattr(gemini_client, "_call_openai_chat_image", succeed_backup)

    login(client)
    created = client.post(
        "/v1/jobs",
        json={
            "prompt": "fallback prompt",
            "model": "gemini-3-pro-image-preview",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.6,
                "timeout_sec": 60,
                "max_retries": 2,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created.status_code == 201
    job_id = created.json()["job_id"]

    meta = None
    for _ in range(40):
        resp = client.get(f"/v1/jobs/{job_id}")
        assert resp.status_code == 200
        meta = resp.json()
        if meta["status"] in {"SUCCEEDED", "FAILED"}:
            break
        time.sleep(0.1)

    assert meta is not None
    assert meta["status"] == "SUCCEEDED"
    assert meta["response"]["provider"]["provider_id"] == "mmw-backup"
    assert meta["response"]["provider_attempts"][0]["provider_id"] == "cheap-gemini"

    providers = client.get("/v1/admin/providers")
    assert providers.status_code == 200
    payload = providers.json()
    cheap = next(item for item in payload["providers"] if item["provider_id"] == "cheap-gemini")
    backup = next(item for item in payload["providers"] if item["provider_id"] == "mmw-backup")
    assert cheap["fail_count"] >= 1
    assert backup["success_count"] >= 1


def test_provider_chain_forces_cooldown_provider_when_no_standard_provider_is_available(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings,
        "upstream_providers_json",
        json.dumps(
            [
                {
                    "provider_id": "cooldown-only",
                    "label": "Cooldown Only",
                    "adapter_type": "gemini_v1beta",
                    "base_url": "http://cooldown.example/v1beta",
                    "api_key": "cooldown-key",
                    "cost_per_image_cny": 0.06,
                    "initial_balance_cny": 8,
                    "supported_models": ["gemini-3-pro-image-preview"],
                }
            ]
        ),
    )
    provider_store.ensure_initialized()
    provider_store.record_failure(
        "cooldown-only",
        error_code="UPSTREAM_TIMEOUT",
        latency_ms=18,
        open_circuit=True,
    )

    def succeed_provider(*args, **kwargs):
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 11},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 42,
        }

    monkeypatch.setattr(gemini_client, "_call_gemini_v1beta", succeed_provider)

    login(client)
    created = client.post(
        "/v1/jobs",
        json={
            "prompt": "cooldown retry prompt",
            "model": "gemini-3-pro-image-preview",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created.status_code == 201

    meta = wait_for_job_terminal(client, created.json()["job_id"])
    assert meta["status"] == "SUCCEEDED"
    assert meta["response"]["provider"]["provider_id"] == "cooldown-only"
    assert meta["response"]["provider"]["selection_mode"] == "forced_circuit_reactivation"
    assert meta["response"]["provider"]["forced_activation"] is True

    providers = client.get("/v1/admin/providers")
    assert providers.status_code == 200
    snapshot = providers.json()["providers"][0]
    assert snapshot["provider_id"] == "cooldown-only"
    assert snapshot["last_circuit_open_time"] is not None
    assert snapshot["last_circuit_open_reason"] == "UPSTREAM_TIMEOUT"
    assert snapshot["last_forced_activation_time"] is not None
    assert snapshot["last_forced_activation_mode"] == "forced_circuit_reactivation"
    assert snapshot["forced_activation_count"] >= 1


def test_admin_can_pin_disabled_or_cooldown_provider_for_single_job(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings,
        "upstream_providers_json",
        json.dumps(
            [
                {
                    "provider_id": "manual-off",
                    "label": "Manual Off",
                    "adapter_type": "gemini_v1beta",
                    "base_url": "http://manual-off.example/v1beta",
                    "api_key": "manual-off-key",
                    "cost_per_image_cny": 0.05,
                    "initial_balance_cny": 10,
                    "supported_models": ["gemini-3-pro-image-preview"],
                },
                {
                    "provider_id": "cooldown-picked",
                    "label": "Cooldown Picked",
                    "adapter_type": "gemini_v1beta",
                    "base_url": "http://cooldown-picked.example/v1beta",
                    "api_key": "cooldown-picked-key",
                    "cost_per_image_cny": 0.08,
                    "initial_balance_cny": 10,
                    "supported_models": ["gemini-3-pro-image-preview"],
                },
            ]
        ),
    )
    provider_store.ensure_initialized()
    provider_store.update_provider("manual-off", enabled=False)
    provider_store.record_failure(
        "cooldown-picked",
        error_code="UPSTREAM_TIMEOUT",
        latency_ms=20,
        open_circuit=True,
    )

    seen_provider_ids: list[str] = []

    def succeed_provider(*args, **kwargs):
        config = kwargs["config"]
        seen_provider_ids.append(config.provider_id)
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 9},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 31,
        }

    monkeypatch.setattr(gemini_client, "_call_gemini_v1beta", succeed_provider)

    login(client)

    for provider_id in ("manual-off", "cooldown-picked"):
        created = client.post(
            "/v1/jobs",
            json={
                "prompt": f"admin explicit provider {provider_id}",
                "model": "gemini-3-pro-image-preview",
                "params": {
                    "aspect_ratio": "1:1",
                    "image_size": "1K",
                    "provider_id": provider_id,
                    "temperature": 0.7,
                    "timeout_sec": 60,
                    "max_retries": 1,
                },
                "mode": "IMAGE_ONLY",
            },
        )
        assert created.status_code == 201
        meta = wait_for_job_terminal(client, created.json()["job_id"])
        assert meta["status"] == "SUCCEEDED"
        assert meta["response"]["provider"]["provider_id"] == provider_id
        assert meta["response"]["provider"]["selection_mode"] == "admin_override"
        assert meta["response"]["provider"]["forced_activation"] is True

    assert seen_provider_ids == ["manual-off", "cooldown-picked"]


def test_regular_user_cannot_specify_provider_id(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings,
        "upstream_providers_json",
        json.dumps(
            [
                {
                    "provider_id": "admin-only-provider",
                    "label": "Admin Only Provider",
                    "adapter_type": "gemini_v1beta",
                    "base_url": "http://admin-only.example/v1beta",
                    "api_key": "admin-only-key",
                    "cost_per_image_cny": 0.05,
                    "initial_balance_cny": 10,
                    "supported_models": ["gemini-3-pro-image-preview"],
                }
            ]
        ),
    )
    provider_store.ensure_initialized()

    login(client)
    created_user = client.post(
        "/v1/admin/users",
        json={
            "username": "plainuser",
            "password": "plainuser123",
            "role": "USER",
            "enabled": True,
        },
    )
    assert created_user.status_code == 201

    logout = client.post("/v1/auth/logout")
    assert logout.status_code == 200
    login(client, username="plainuser", password="plainuser123")

    created = client.post(
        "/v1/jobs",
        json={
            "prompt": "user should not pick provider",
            "model": "gemini-3-pro-image-preview",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "provider_id": "admin-only-provider",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created.status_code == 403
    assert created.json()["error"]["code"] == "FORBIDDEN"


def test_mmw_model_resolution_uses_size_specific_models() -> None:
    assert (
        gemini_client._resolve_openai_upstream_model(
            "gemini-3.1-flash-image-preview",
            {"image_size": "4K"},
            provider_profile="mmw",
        )
        == "gemini-3.1-flash-image-4k"
    )
    assert (
        gemini_client._resolve_openai_upstream_model(
            "gemini-3.1-flash-image-preview",
            {"image_size": "2K"},
            provider_profile="mmw",
        )
        == "gemini-3.1-flash-image-2k"
    )
    assert (
        gemini_client._resolve_openai_upstream_model(
            "gemini-3.1-flash-image-preview",
            {"image_size": "1K"},
            provider_profile="mmw",
        )
        == "gemini-3.1-flash-image"
    )
    assert (
        gemini_client._resolve_openai_upstream_model(
            "gemini-2.5-flash-image",
            {"image_size": "4K"},
            provider_profile="mmw",
        )
        == "gemini-2.5-flash-image-4k"
    )
    assert (
        gemini_client._resolve_openai_upstream_model(
            "gemini-2.5-flash-image",
            {"image_size": "1K"},
            provider_profile="mmw",
        )
        == "gemini-2.5-flash-image-2k"
    )


def test_http_client_kwargs_only_use_gemini_http_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://container-proxy:8080")
    monkeypatch.setenv("HTTPS_PROXY", "http://container-proxy:8080")
    monkeypatch.setenv("ALL_PROXY", "socks5://container-proxy:1080")

    monkeypatch.setattr(settings, "gemini_http_proxy", "")
    assert gemini_client._http_client_kwargs(12.5) == {
        "timeout": 12.5,
        "trust_env": False,
    }

    monkeypatch.setattr(settings, "gemini_http_proxy", "http://env-proxy:7890")
    assert gemini_client._http_client_kwargs(8.0) == {
        "timeout": 8.0,
        "trust_env": False,
        "proxy": "http://env-proxy:7890",
    }


def test_generate_image_stops_fallback_when_job_deadline_is_exhausted(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    provider_store.path = tmp_path / "providers.json"
    provider_store.reset_runtime_state()
    monkeypatch.setattr(
        settings,
        "upstream_providers_json",
        json.dumps(
            [
                {
                    "provider_id": "zx2",
                    "label": "ZX2",
                    "adapter_type": "gemini_v1beta",
                    "base_url": "http://cheap.example/v1beta",
                    "api_key": "cheap-key",
                    "cost_per_image_cny": 0.05,
                    "initial_balance_cny": 10,
                    "supported_models": ["gemini-3-pro-image-preview"],
                },
                {
                    "provider_id": "mmw",
                    "label": "MMW",
                    "adapter_type": "openai_chat_image",
                    "base_url": "https://api.example",
                    "api_key": "backup-key",
                    "cost_per_image_cny": 0.09,
                    "initial_balance_cny": 20,
                    "supported_models": ["gemini-3-pro-image-preview"],
                },
            ]
        ),
    )
    provider_store.ensure_initialized()

    fallback_called = False

    def fail_cheap(*args, **kwargs):
        time.sleep(0.06)
        raise GeminiError(code="UPSTREAM_TIMEOUT", message="cheap timeout", retryable=True)

    def should_not_run_backup(*args, **kwargs):
        nonlocal fallback_called
        fallback_called = True
        return {
            "raw": {},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 10,
        }

    monkeypatch.setattr(gemini_client, "_call_gemini_v1beta", fail_cheap)
    monkeypatch.setattr(gemini_client, "_call_openai_chat_image", should_not_run_backup)

    with pytest.raises(GeminiError) as exc_info:
        gemini_client.generate_image(
            prompt="deadline test",
            model="gemini-3-pro-image-preview",
            mode="IMAGE_ONLY",
            params={
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            reference_images=[],
            deadline_monotonic=time.monotonic() + 0.05,
        )

    err = exc_info.value
    assert err.code == "WORKER_WATCHDOG_TIMEOUT"
    assert fallback_called is False
    assert err.payload["attempts"][0]["provider_id"] == "zx2"


def test_admin_provider_management_and_balance_updates(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings,
        "upstream_providers_json",
        json.dumps(
            [
                {
                    "provider_id": "mmw",
                    "label": "MMW",
                    "adapter_type": "openai_chat_image",
                    "base_url": "https://api.mmw.ink",
                    "api_key": "k1",
                    "cost_per_image_cny": 0.09,
                    "initial_balance_cny": 21.5,
                    "supported_models": ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"],
                    "note": "main",
                },
                {
                    "provider_id": "zx2",
                    "label": "ZX2",
                    "adapter_type": "gemini_v1beta",
                    "base_url": "http://zx2.example/v1beta",
                    "api_key": "k2",
                    "cost_per_image_cny": 0.05,
                    "initial_balance_cny": 10,
                    "supported_models": ["gemini-3.1-flash-image-preview"],
                    "note": "cheap",
                },
            ]
        ),
    )
    provider_store.ensure_initialized()

    login(client)

    listed = client.get("/v1/admin/providers")
    assert listed.status_code == 200
    body = listed.json()
    assert body["providers_total"] == 2
    assert body["providers_enabled"] == 2

    updated = client.patch("/v1/admin/providers/zx2", json={"enabled": False, "note": "maintenance"})
    assert updated.status_code == 200
    assert updated.json()["provider"]["enabled"] is False
    assert updated.json()["provider"]["note"] == "maintenance"

    set_balance = client.post("/v1/admin/providers/mmw/balance/set", json={"amount_cny": 18.5})
    assert set_balance.status_code == 200
    assert set_balance.json()["provider"]["remaining_balance_cny"] == 18.5

    add_balance = client.post("/v1/admin/providers/mmw/balance/add", json={"delta_cny": 1.25})
    assert add_balance.status_code == 200
    assert add_balance.json()["provider"]["remaining_balance_cny"] == 19.75

    overview = client.get("/v1/admin/overview")
    assert overview.status_code == 200
    assert overview.json()["providers"]["providers_total"] == 2
    assert overview.json()["providers"]["providers_enabled"] == 1

    gone = client.get("/v1/billing/google/remaining")
    assert gone.status_code == 410


def test_preview_access_does_not_consume_original_image_quota_and_supports_batch_fetch(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    large_png = make_png()

    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": large_png}],
            "usage_metadata": {"totalTokenCount": 10},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 50,
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", fake_generate_image)
    login(client)

    updated_policy = client.patch(
        "/v1/admin/policy",
        json={
            "default_user_daily_image_access_limit": 0,
            "default_user_image_access_turnstile_bonus_quota": 0,
            "default_user_daily_image_access_hard_limit": 0,
        },
    )
    assert updated_policy.status_code == 200

    created = client.post(
        "/v1/admin/users",
        json={
            "username": "previewuser",
            "password": "previewpass123",
            "role": "USER",
            "enabled": True,
        },
    )
    assert created.status_code == 201

    client.post("/v1/auth/logout")
    login(client, username="previewuser", password="previewpass123")

    created_job = client.post(
        "/v1/jobs",
        json={
            "prompt": "preview prompt",
            "params": {
                "aspect_ratio": "16:9",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created_job.status_code == 201
    body = created_job.json()
    job_id = body["job_id"]
    job_token = body["job_access_token"]

    meta = None
    for _ in range(30):
        rr = client.get(f"/v1/jobs/{job_id}", headers={"X-Job-Token": job_token})
        assert rr.status_code == 200
        meta = rr.json()
        if meta["status"] == "SUCCEEDED":
            break
        time.sleep(0.1)
    assert meta is not None
    assert meta["status"] == "SUCCEEDED"
    assert meta["result"]["images"][0]["preview"]["mime"] == "image/webp"

    preview = client.get(f"/v1/jobs/{job_id}/images/image_0/preview", headers={"X-Job-Token": job_token})
    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("image/webp")

    preview_user = user_store.get_user_by_username("previewuser")
    assert preview_user is not None
    assert user_store.get_daily_usage(str(preview_user["user_id"]))["image_accesses"] == 0

    batch_preview = client.post(
        "/v1/jobs/previews/batch",
        json={
            "images": [
                {
                    "job_id": job_id,
                    "job_access_token": job_token,
                    "image_id": "image_0",
                }
            ]
        },
    )
    assert batch_preview.status_code == 200
    batch_body = batch_preview.json()
    assert batch_body["ok"] == 1
    assert batch_body["items"][0]["image_id"] == "image_0"
    assert batch_body["items"][0]["mime"] == "image/webp"
    assert batch_body["items"][0]["size_bytes"] <= len(large_png)

    raw = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": job_token})
    assert raw.status_code == 429
    assert raw.json()["error"]["code"] == "QUOTA_EXCEEDED"


def test_batch_preview_limit_caps_response_size(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "preview_batch_limit", 3)
    login(client)

    for idx in range(5):
        job_id = f"{idx + 1:032d}"
        storage.create_job_dirs(job_id)
        image_bytes = make_png(1200, 900, (40 + idx * 20, 80, 160))
        preview_bytes = make_webp(1200, 900, (40 + idx * 20, 80, 160))
        original_filename = storage.save_result_image(job_id, "image_0", image_bytes, "image/png")
        preview_filename = storage.save_preview_image(job_id, "image_0", preview_bytes, "image/webp")
        storage.save_request(job_id, {"prompt": f"prompt {idx}", "reference_images": []})
        storage.save_response(job_id, {"latency_ms": 10})
        storage.save_meta(
            job_id,
            {
                "job_id": job_id,
                "created_at": "2026-03-10T00:00:00+00:00",
                "updated_at": "2026-03-10T00:00:00+00:00",
                "status": "SUCCEEDED",
                "model": "gemini-3.1-flash-image-preview",
                "mode": "IMAGE_ONLY",
                "params": {
                    "aspect_ratio": "1:1",
                    "image_size": "1K",
                    "temperature": 0.7,
                    "timeout_sec": 60,
                    "max_retries": 0,
                },
                "timing": {},
                "result": {
                    "images": [
                        {
                            "image_id": "image_0",
                            "filename": original_filename,
                            "mime": "image/png",
                            "width": 1200,
                            "height": 900,
                            "sha256": f"hash-{idx}",
                            "preview": {
                                "filename": preview_filename,
                                "mime": "image/webp",
                                "width": 1200,
                                "height": 900,
                                "size_bytes": len(preview_bytes),
                            },
                        }
                    ]
                },
                "usage": {},
                "billing": {},
                "response": {},
                "error": None,
                "owner": {"user_id": "admin", "username": "admin", "role": "ADMIN"},
            },
        )

    resp = client.post(
        "/v1/jobs/previews/batch",
        json={"images": [{"job_id": f"{idx + 1:032d}", "image_id": "image_0"} for idx in range(5)]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["requested"] == 3
    assert body["ok"] == 3


def test_model_validation_after_login(client: TestClient) -> None:
    login(client)

    invalid_mode = client.post(
        "/v1/jobs",
        json={
            "prompt": "test prompt",
            "model": "gemini-3.1-flash-image-preview",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "TEXT_AND_IMAGE",
        },
    )
    assert invalid_mode.status_code == 400

    invalid_thinking = client.post(
        "/v1/jobs",
        json={
            "prompt": "test prompt",
            "model": "gemini-2.5-flash-image",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "thinking_level": "High",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert invalid_thinking.status_code == 400


def test_admin_user_management_and_turnstile_gate(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 10},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 50,
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", fake_generate_image)
    login(client)

    created = client.post(
        "/v1/admin/users",
        json={
            "username": "alice",
            "password": "alicepass123",
            "role": "USER",
            "enabled": True,
            "policy_overrides": {
                "daily_image_limit": 10,
                "concurrent_jobs_limit": 2,
                "turnstile_job_count_threshold": 1,
                "turnstile_daily_usage_threshold": 999,
                "daily_image_access_limit": 12,
                "image_access_turnstile_bonus_quota": 4,
                "daily_image_access_hard_limit": 20,
            },
        },
    )
    assert created.status_code == 201
    alice = created.json()
    assert alice["username"] == "alice"

    overview = client.get("/v1/admin/overview")
    assert overview.status_code == 200
    assert overview.json()["policy"]["default_user_daily_image_limit"] >= 0

    listed = client.get("/v1/admin/users")
    assert listed.status_code == 200
    usernames = {item["username"] for item in listed.json()["users"]}
    assert {"admin", "alice"} <= usernames

    updated_policy = client.patch(
        "/v1/admin/policy",
        json={
            "default_user_daily_image_limit": 88,
            "default_user_extra_daily_image_limit": 7,
            "default_user_daily_image_access_limit": 123,
            "default_user_image_access_turnstile_bonus_quota": 9,
            "default_user_daily_image_access_hard_limit": 150,
        },
    )
    assert updated_policy.status_code == 200
    assert updated_policy.json()["policy"]["default_user_daily_image_limit"] == 88
    assert updated_policy.json()["policy"]["default_user_extra_daily_image_limit"] == 7
    assert updated_policy.json()["policy"]["default_user_daily_image_access_limit"] == 123
    assert updated_policy.json()["policy"]["default_user_image_access_turnstile_bonus_quota"] == 9
    assert updated_policy.json()["policy"]["default_user_daily_image_access_hard_limit"] == 150

    client.post("/v1/auth/logout")
    login(client, username="alice", password="alicepass123")

    gated = client.post(
        "/v1/jobs",
        headers={"X-Requested-Job-Count": "2"},
        json={
            "prompt": "alice prompt",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert gated.status_code == 403
    assert gated.json()["error"]["code"] == "TURNSTILE_REQUIRED"

    verified = client.post(
        "/v1/auth/turnstile/generation",
        json={"turnstile_token": "turnstile-ok", "requested_job_count": 2},
    )
    assert verified.status_code == 200
    assert verified.json()["generation_turnstile_verified_until"]

    created_after_verify_first = client.post(
        "/v1/jobs",
        headers={"X-Requested-Job-Count": "2"},
        json={
            "prompt": "alice prompt",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created_after_verify_first.status_code == 201

    created_after_verify_second = client.post(
        "/v1/jobs",
        headers={"X-Requested-Job-Count": "2"},
        json={
            "prompt": "alice prompt follow-up",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created_after_verify_second.status_code == 201

    gated_again = client.post(
        "/v1/jobs",
        headers={"X-Requested-Job-Count": "2"},
        json={
            "prompt": "alice prompt again",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert gated_again.status_code == 403
    assert gated_again.json()["error"]["code"] == "TURNSTILE_REQUIRED"

    client.post("/v1/auth/logout")
    login(client)
    reset = client.post(f"/v1/admin/users/{alice['user_id']}/reset-quota")
    assert reset.status_code == 200
    assert reset.json()["usage"]["quota_resets_today"] >= 1


def test_running_concurrency_limit_queues_excess_jobs(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    lock = threading.Lock()
    active_calls = 0
    max_active_calls = 0

    def slow_generate_image(prompt, model, mode, params, reference_images):
        nonlocal active_calls, max_active_calls
        with lock:
            active_calls += 1
            max_active_calls = max(max_active_calls, active_calls)
        try:
            time.sleep(0.2)
            return {
                "raw": {"candidates": []},
                "images": [{"mime": "image/png", "bytes": PNG_1X1}],
                "usage_metadata": {"totalTokenCount": 10},
                "finish_reason": "STOP",
                "safety_ratings": [],
                "latency_ms": 50,
            }
        finally:
            with lock:
                active_calls -= 1

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", slow_generate_image)
    login(client)

    created = client.post(
        "/v1/admin/users",
        json={
            "username": "bob",
            "password": "bobpass123",
            "role": "USER",
            "enabled": True,
            "policy_overrides": {
                "daily_image_limit": 10,
                "concurrent_jobs_limit": 1,
                "turnstile_job_count_threshold": 99,
                "turnstile_daily_usage_threshold": 999,
            },
        },
    )
    assert created.status_code == 201

    client.post("/v1/auth/logout")
    login(client, username="bob", password="bobpass123")

    job_ids: list[str] = []
    for idx in range(3):
        resp = client.post(
            "/v1/jobs",
            json={
                "prompt": f"bob prompt {idx}",
                "params": {
                    "aspect_ratio": "1:1",
                    "image_size": "1K",
                    "temperature": 0.7,
                    "timeout_sec": 60,
                    "max_retries": 1,
                },
                "mode": "IMAGE_ONLY",
            },
        )
        assert resp.status_code == 201
        job_ids.append(resp.json()["job_id"])

    saw_running_and_queue = False
    for _ in range(20):
        statuses = [client.get(f"/v1/jobs/{job_id}").json()["status"] for job_id in job_ids]
        if statuses.count("RUNNING") == 1 and statuses.count("QUEUED") >= 1:
            saw_running_and_queue = True
            break
        time.sleep(0.05)

    assert saw_running_and_queue

    final_statuses: list[str] = []
    for _ in range(60):
        final_statuses = [client.get(f"/v1/jobs/{job_id}").json()["status"] for job_id in job_ids]
        if all(status == "SUCCEEDED" for status in final_statuses):
            break
        time.sleep(0.05)

    assert final_statuses == ["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]
    assert max_active_calls == 1


def test_job_watchdog_enforces_total_runtime_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "job_watchdog_timeout_sec", 1)

    def slow_generate_image(prompt, model, mode, params, reference_images, deadline_monotonic=None):
        time.sleep(1.2)
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 10},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 50,
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", slow_generate_image)
    login(client)

    created = client.post(
        "/v1/jobs",
        json={
            "prompt": "watchdog prompt",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created.status_code == 201
    job_id = created.json()["job_id"]

    meta = None
    for _ in range(40):
        resp = client.get(f"/v1/jobs/{job_id}")
        assert resp.status_code == 200
        meta = resp.json()
        if meta["status"] in {"SUCCEEDED", "FAILED"}:
            break
        time.sleep(0.05)

    assert meta is not None
    assert meta["status"] == "FAILED"
    assert meta["error"]["code"] == "WORKER_WATCHDOG_TIMEOUT"
    assert meta["error"]["details"]["watchdog_timeout_sec"] == 1
    assert meta["error"]["details"]["configured_timeout_sec"] == 60


def test_startup_recovery_marks_lingering_jobs_failed(client: TestClient) -> None:
    login(client)
    admin = user_store.get_user_by_username("admin")
    assert admin is not None

    created_at = "2026-03-09T10:00:00+08:00"
    queued_job_id = "a" * 32
    running_job_id = "b" * 32

    for job_id, status, started_at in (
        (queued_job_id, "QUEUED", None),
        (running_job_id, "RUNNING", "2026-03-09T10:00:05+08:00"),
    ):
        storage.create_job_dirs(job_id)
        storage.save_request(
            job_id,
            {
                "prompt": f"recover {job_id}",
                "reference_images": [],
            },
        )
        storage.save_meta(
            job_id,
            {
                "job_id": job_id,
                "created_at": created_at,
                "updated_at": started_at or created_at,
                "status": status,
                "model": settings.default_model,
                "mode": "IMAGE_ONLY",
                "params": {
                    "aspect_ratio": "1:1",
                    "image_size": "1K",
                    "thinking_level": None,
                    "temperature": 0.7,
                    "timeout_sec": 60,
                    "max_retries": 1,
                },
                "result": {"images": []},
                "usage": {
                    "prompt_token_count": 0,
                    "cached_content_token_count": 0,
                    "candidates_token_count": 0,
                    "thoughts_token_count": 0,
                    "total_token_count": 0,
                },
                "billing": {
                    "currency": "USD",
                    "estimated_cost_usd": 0.0,
                    "breakdown": {
                        "text_input_cost_usd": 0.0,
                        "text_output_cost_usd": 0.0,
                        "image_output_cost_usd": 0.0,
                    },
                    "pricing_version": "2026-01-12",
                    "pricing_notes": "computed from official pricing table",
                },
                "error": None,
                "owner": {
                    "user_id": admin["user_id"],
                    "username": admin["username"],
                    "role": admin["role"],
                },
                "timing": {
                    "queued_at": created_at,
                    "started_at": started_at,
                    "finished_at": None,
                    "queue_wait_ms": None,
                    "run_duration_ms": None,
                },
            },
        )

    recovered = job_manager.fail_incomplete_jobs_on_startup()
    assert recovered == 2

    queued_meta_resp = client.get(f"/v1/jobs/{queued_job_id}")
    running_meta_resp = client.get(f"/v1/jobs/{running_job_id}")
    assert queued_meta_resp.status_code == 200
    assert running_meta_resp.status_code == 200

    queued_meta = queued_meta_resp.json()
    running_meta = running_meta_resp.json()
    for meta, previous_status in ((queued_meta, "QUEUED"), (running_meta, "RUNNING")):
        assert meta["status"] == "FAILED"
        assert meta["error"]["code"] == "BACKEND_RESTART_RECOVERY"
        assert meta["error"]["type"] == "SYSTEM_RESTART"
        assert "backend restart" in meta["error"]["message"]
        assert meta["error"]["details"]["previous_status"] == previous_status
        assert meta["error"]["details"]["recovery_action"] == "MARK_AS_FAILED_ON_STARTUP"
        assert meta["timing"]["finished_at"] is not None


def test_created_jobs_consume_quota_and_trigger_daily_turnstile(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_generate_image(prompt, model, mode, params, reference_images):
        raise GeminiError(code="UPSTREAM_ERROR", message="forced failure", retryable=False)

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", failing_generate_image)
    login(client)

    policy_reset = client.patch(
        "/v1/admin/policy",
        json={"default_user_extra_daily_image_limit": 0},
    )
    assert policy_reset.status_code == 200

    created = client.post(
        "/v1/admin/users",
        json={
            "username": "test1",
            "password": "test1pass123",
            "role": "USER",
            "enabled": True,
            "policy_overrides": {
                "daily_image_limit": 2,
                "concurrent_jobs_limit": 2,
                "turnstile_job_count_threshold": 99,
                "turnstile_daily_usage_threshold": 1,
            },
        },
    )
    assert created.status_code == 201

    client.post("/v1/auth/logout")
    login(client, username="test1", password="test1pass123")

    first = client.post(
        "/v1/jobs",
        json={
            "prompt": "first",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert first.status_code == 201

    second = client.post(
        "/v1/jobs",
        json={
            "prompt": "second",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert second.status_code == 403
    assert second.json()["error"]["code"] == "TURNSTILE_REQUIRED"

    verified = client.post(
        "/v1/auth/turnstile/generation",
        json={"turnstile_token": "turnstile-ok", "requested_job_count": 1},
    )
    assert verified.status_code == 200

    second_after_verify = client.post(
        "/v1/jobs",
        json={
            "prompt": "second",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert second_after_verify.status_code == 201

    me = client.get("/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["usage"]["quota_consumed_today"] == 2
    assert me.json()["usage"]["remaining_images_today"] == 0

    third = client.post(
        "/v1/jobs",
        json={
            "prompt": "third",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert third.status_code == 429
    assert third.json()["error"]["code"] == "QUOTA_EXCEEDED"


def test_overquota_batch_creates_single_real_job_and_failed_placeholders(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 10},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 50,
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", fake_generate_image)
    monkeypatch.setattr("app.main.random.random", lambda: 0.0)
    login(client)

    updated_policy = client.patch(
        "/v1/admin/policy",
        json={
            "default_user_daily_image_limit": 1,
            "default_user_extra_daily_image_limit": 2,
            "default_user_turnstile_job_count_threshold": 99,
            "default_user_turnstile_daily_usage_threshold": 99,
        },
    )
    assert updated_policy.status_code == 200

    created = client.post(
        "/v1/admin/users",
        json={
            "username": "overflow",
            "password": "overflow123",
            "role": "USER",
            "enabled": True,
        },
    )
    assert created.status_code == 201

    client.post("/v1/auth/logout")
    login(client, username="overflow", password="overflow123")

    first_normal = client.post(
        "/v1/jobs",
        json={
            "prompt": "normal",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert first_normal.status_code == 201

    overflow_needs_turnstile = client.post(
        "/v1/jobs",
        headers={"X-Requested-Job-Count": "2"},
        json={
            "prompt": "overflow batch",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert overflow_needs_turnstile.status_code == 403
    assert overflow_needs_turnstile.json()["error"]["code"] == "TURNSTILE_REQUIRED"

    verified = client.post(
        "/v1/auth/turnstile/generation",
        json={"turnstile_token": "turnstile-ok", "requested_job_count": 2},
    )
    assert verified.status_code == 200

    overflow_first = client.post(
        "/v1/jobs",
        headers={"X-Requested-Job-Count": "2"},
        json={
            "prompt": "overflow batch",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert overflow_first.status_code == 201
    assert overflow_first.json()["status"] == "QUEUED"

    overflow_second = client.post(
        "/v1/jobs",
        headers={"X-Requested-Job-Count": "2"},
        json={
            "prompt": "overflow batch",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert overflow_second.status_code == 201
    assert overflow_second.json()["status"] == "FAILED"

    me = client.get("/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["usage"]["quota_consumed_today"] == 3
    assert me.json()["usage"]["remaining_images_today"] == 0

    blocked = client.post(
        "/v1/jobs",
        json={
            "prompt": "blocked",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 0,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "QUOTA_EXCEEDED"


def test_image_access_turnstile_and_hard_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 10},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 50,
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", fake_generate_image)
    login(client)

    created = client.post(
        "/v1/admin/users",
        json={
            "username": "viewer",
            "password": "viewerpass123",
            "role": "USER",
            "enabled": True,
            "policy_overrides": {
                "daily_image_limit": 10,
                "concurrent_jobs_limit": 2,
                "turnstile_job_count_threshold": 99,
                "turnstile_daily_usage_threshold": 999,
                "daily_image_access_limit": 1,
                "image_access_turnstile_bonus_quota": 1,
                "daily_image_access_hard_limit": 3,
            },
        },
    )
    assert created.status_code == 201
    viewer = created.json()

    client.post("/v1/auth/logout")
    login(client, username="viewer", password="viewerpass123")

    created_job = client.post(
        "/v1/jobs",
        json={
            "prompt": "viewer prompt",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert created_job.status_code == 201
    body = created_job.json()
    job_id = body["job_id"]
    job_token = body["job_access_token"]

    meta = None
    for _ in range(30):
        rr = client.get(f"/v1/jobs/{job_id}", headers={"X-Job-Token": job_token})
        assert rr.status_code == 200
        meta = rr.json()
        if meta["status"] == "SUCCEEDED":
            break
        time.sleep(0.1)
    assert meta is not None
    assert meta["status"] == "SUCCEEDED"

    first = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": job_token})
    assert first.status_code == 200

    second_needs_turnstile = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": job_token})
    assert second_needs_turnstile.status_code == 403
    assert second_needs_turnstile.json()["error"]["code"] == "TURNSTILE_REQUIRED"
    assert second_needs_turnstile.json()["error"]["details"]["turnstile_scope"] == "image_access"

    verified_1 = client.post(
        "/v1/auth/turnstile/image-access",
        json={"turnstile_token": "turnstile-ok"},
    )
    assert verified_1.status_code == 200
    assert verified_1.json()["verified"] is True

    second = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": job_token})
    assert second.status_code == 200

    third_needs_turnstile = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": job_token})
    assert third_needs_turnstile.status_code == 403
    assert third_needs_turnstile.json()["error"]["code"] == "TURNSTILE_REQUIRED"

    verified_2 = client.post(
        "/v1/auth/turnstile/image-access",
        json={"turnstile_token": "turnstile-ok"},
    )
    assert verified_2.status_code == 200

    third = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": job_token})
    assert third.status_code == 200

    hard_blocked = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": job_token})
    assert hard_blocked.status_code == 429
    assert hard_blocked.json()["error"]["code"] == "QUOTA_EXCEEDED"

    client.post("/v1/auth/logout")
    login(client)
    reset = client.post(f"/v1/admin/users/{viewer['user_id']}/reset-quota")
    assert reset.status_code == 200
    assert reset.json()["usage"]["image_accesses_today"] == 0
    assert reset.json()["usage"]["image_access_bonus_quota_today"] == 0


def test_job_read_rate_limit_is_scoped_by_user_id(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.rate_limiter.limiter", InMemoryRateLimiter(1))
    login(client)

    created_user_1 = client.post(
        "/v1/admin/users",
        json={
            "username": "reader1",
            "password": "reader1pass",
            "role": "USER",
            "enabled": True,
        },
    )
    assert created_user_1.status_code == 201

    created_user_2 = client.post(
        "/v1/admin/users",
        json={
            "username": "reader2",
            "password": "reader2pass",
            "role": "USER",
            "enabled": True,
        },
    )
    assert created_user_2.status_code == 201

    client.post("/v1/auth/logout")
    login(client, username="reader1", password="reader1pass")

    first = client.post("/v1/jobs/batch-meta", json={"jobs": []})
    assert first.status_code == 200

    second = client.post("/v1/jobs/batch-meta", json={"jobs": []})
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "RATE_LIMITED"

    client.post("/v1/auth/logout")
    login(client, username="reader2", password="reader2pass")

    third = client.post("/v1/jobs/batch-meta", json={"jobs": []})
    assert third.status_code == 200


def test_admin_user_jobs_list_filters_and_retry_preserves_owner(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 10},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 50,
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", fake_generate_image)
    login(client)

    alice_resp = client.post(
        "/v1/admin/users",
        json={"username": "alice_jobs", "password": "alicepass123", "role": "USER", "enabled": True},
    )
    assert alice_resp.status_code == 201
    alice = alice_resp.json()

    bob_resp = client.post(
        "/v1/admin/users",
        json={"username": "bob_jobs", "password": "bobpass123", "role": "USER", "enabled": True},
    )
    assert bob_resp.status_code == 201
    bob = bob_resp.json()

    client.post("/v1/auth/logout")
    login(client, username="alice_jobs", password="alicepass123")

    alice_job_ids: list[str] = []
    for prompt in ["sunrise cat", "moon dog", "storm eagle"]:
        created = client.post(
            "/v1/jobs",
            json={
                "prompt": prompt,
                "params": {
                    "aspect_ratio": "1:1",
                    "image_size": "1K",
                    "temperature": 0.7,
                    "timeout_sec": 60,
                    "max_retries": 1,
                },
                "mode": "IMAGE_ONLY",
            },
        )
        assert created.status_code == 201
        alice_job_ids.append(created.json()["job_id"])

    for job_id in alice_job_ids:
        wait_for_job_terminal(client, job_id)

    failed_meta = storage.load_meta(alice_job_ids[2])
    failed_meta["status"] = "FAILED"
    failed_meta["updated_at"] = failed_meta["created_at"]
    failed_meta["result"] = {"images": []}
    failed_meta["error"] = {"code": "UPSTREAM_TIMEOUT", "message": "storm failed"}
    failed_meta["timing"]["run_duration_ms"] = 321
    storage.save_meta(alice_job_ids[2], failed_meta)

    client.post("/v1/auth/logout")
    login(client, username="bob_jobs", password="bobpass123")
    bob_created = client.post(
        "/v1/jobs",
        json={
            "prompt": "bob private prompt",
            "params": {
                "aspect_ratio": "1:1",
                "image_size": "1K",
                "temperature": 0.7,
                "timeout_sec": 60,
                "max_retries": 1,
            },
            "mode": "IMAGE_ONLY",
        },
    )
    assert bob_created.status_code == 201
    wait_for_job_terminal(client, bob_created.json()["job_id"])

    client.post("/v1/auth/logout")
    login(client)

    listed = client.get(f"/v1/admin/users/{alice['user_id']}/jobs", params={"limit": 2})
    assert listed.status_code == 200
    body = listed.json()
    assert body["stats"]["total"] == 3
    assert body["stats"]["failed"] == 1
    assert body["next_cursor"] == "2"
    assert len(body["items"]) == 2
    assert all(item["owner"]["user_id"] == alice["user_id"] for item in body["items"])
    assert all(item["job_id"] != bob_created.json()["job_id"] for item in body["items"])

    searched = client.get(
        f"/v1/admin/users/{alice['user_id']}/jobs",
        params={"q": "moon", "status": "SUCCEEDED", "has_images": "true"},
    )
    assert searched.status_code == 200
    searched_items = searched.json()["items"]
    assert len(searched_items) == 1
    assert searched_items[0]["prompt_preview"] == "moon dog"
    assert searched_items[0]["image_count"] == 1
    assert searched_items[0]["first_image_id"]

    failed_only = client.get(
        f"/v1/admin/users/{alice['user_id']}/jobs",
        params={"failed_only": "true", "has_images": "false"},
    )
    assert failed_only.status_code == 200
    failed_items = failed_only.json()["items"]
    assert len(failed_items) == 1
    assert failed_items[0]["status"] == "FAILED"
    assert failed_items[0]["error"]["code"] == "UPSTREAM_TIMEOUT"
    assert failed_items[0]["image_count"] == 0

    retried = client.post(f"/v1/jobs/{alice_job_ids[0]}/retry", json={})
    assert retried.status_code == 201
    retry_meta = wait_for_job_terminal(client, retried.json()["new_job_id"])
    assert retry_meta["owner"]["user_id"] == alice["user_id"]


def test_admin_user_jobs_endpoint_requires_admin(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {"candidates": []},
            "images": [{"mime": "image/png", "bytes": PNG_1X1}],
            "usage_metadata": {"totalTokenCount": 10},
            "finish_reason": "STOP",
            "safety_ratings": [],
            "latency_ms": 50,
        }

    monkeypatch.setattr("app.gemini_client.gemini_client.generate_image", fake_generate_image)
    login(client)
    created = client.post(
        "/v1/admin/users",
        json={"username": "viewer_jobs", "password": "viewerpass123", "role": "USER", "enabled": True},
    )
    assert created.status_code == 201
    viewer = created.json()

    client.post("/v1/auth/logout")
    login(client, username="viewer_jobs", password="viewerpass123")

    denied = client.get(f"/v1/admin/users/{viewer['user_id']}/jobs")
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "FORBIDDEN"
