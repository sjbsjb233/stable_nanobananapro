from __future__ import annotations

import base64
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.gemini_client import GeminiError
from app.main import app
from app.rate_limiter import InMemoryRateLimiter
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


def test_invalid_session_cookie_does_not_crash(client: TestClient) -> None:
    client.cookies.set("nbp_session", "definitely-not-a-valid-session-cookie")
    me = client.get("/v1/auth/me")
    assert me.status_code == 401
    assert me.json()["error"]["code"] == "AUTH_REQUIRED"


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
