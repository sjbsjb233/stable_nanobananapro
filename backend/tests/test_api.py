from __future__ import annotations

import base64
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.storage import storage
from app.user_store import user_store


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7m6XQAAAAASUVORK5CYII="
)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "log_dir", tmp_path / "logs")
    monkeypatch.setattr(settings, "bootstrap_admin_username", "admin")
    monkeypatch.setattr(settings, "bootstrap_admin_password", "admin123456")
    monkeypatch.setattr(settings, "turnstile_secret_key", "test-secret")
    monkeypatch.setattr(settings, "turnstile_site_key", "test-site-key")
    monkeypatch.setattr(settings, "session_secret_key", "test-session-secret")

    storage.data_dir = tmp_path
    storage.jobs_dir = tmp_path / "jobs"
    storage.jobs_dir.mkdir(parents=True, exist_ok=True)
    user_store.path = tmp_path / "auth" / "users.json"

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


def test_auth_required_and_login(client: TestClient) -> None:
    unauthorized = client.get("/v1/models")
    assert unauthorized.status_code == 401

    session = login(client)
    assert session["user"]["username"] == "admin"
    assert session["user"]["role"] == "ADMIN"

    me = client.get("/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["authenticated"] is True


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

    deleted = client.delete(f"/v1/jobs/{job_id}")
    assert deleted.status_code == 200
    not_found = client.get(f"/v1/jobs/{job_id}")
    assert not_found.status_code == 404


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
                "daily_image_limit": 3,
                "concurrent_jobs_limit": 2,
                "turnstile_job_count_threshold": 1,
                "turnstile_daily_usage_threshold": 0,
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
        json={"default_user_daily_image_limit": 88},
    )
    assert updated_policy.status_code == 200
    assert updated_policy.json()["policy"]["default_user_daily_image_limit"] == 88

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
        json={"turnstile_token": "turnstile-ok"},
    )
    assert verified.status_code == 200
    assert verified.json()["generation_turnstile_verified_until"]

    created_after_verify = client.post(
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
    assert created_after_verify.status_code == 201

    client.post("/v1/auth/logout")
    login(client)
    reset = client.post(f"/v1/admin/users/{alice['user_id']}/reset-quota")
    assert reset.status_code == 200
    assert reset.json()["usage"]["quota_resets_today"] >= 1
