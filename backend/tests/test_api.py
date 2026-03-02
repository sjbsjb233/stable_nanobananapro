from __future__ import annotations

import base64
import time

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7m6XQAAAAASUVORK5CYII="
)


def test_job_lifecycle(monkeypatch):
    def fake_generate_image(prompt, model, mode, params, reference_images):
        return {
            "raw": {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(PNG_1X1).decode()}}]}}]},
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

    with TestClient(app) as client:
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
        token = body["job_access_token"]

        unauthorized = client.get(f"/v1/jobs/{job_id}")
        assert unauthorized.status_code == 403

        meta = None
        for _ in range(30):
            rr = client.get(f"/v1/jobs/{job_id}", headers={"X-Job-Token": token})
            assert rr.status_code == 200
            meta = rr.json()
            if meta["status"] in {"SUCCEEDED", "FAILED"}:
                break
            time.sleep(0.1)

        assert meta is not None
        assert meta["status"] == "SUCCEEDED"
        assert meta["usage"]["total_token_count"] == 160
        assert meta["billing"]["estimated_cost_usd"] > 0
        assert isinstance(meta.get("timing"), dict)
        assert meta["timing"].get("started_at")
        assert meta["timing"].get("finished_at")
        assert isinstance(meta["timing"].get("run_duration_ms"), int)
        assert meta["timing"]["run_duration_ms"] >= 0
        assert isinstance(meta["timing"].get("queue_wait_ms"), int)
        assert meta["timing"]["queue_wait_ms"] >= 0
        assert isinstance(meta.get("response"), dict)
        assert meta["response"]["latency_ms"] == 123

        req = client.get(f"/v1/jobs/{job_id}/request", headers={"X-Job-Token": token})
        assert req.status_code == 200

        resp = client.get(f"/v1/jobs/{job_id}/response", headers={"X-Job-Token": token})
        assert resp.status_code == 200

        batch = client.post(
            "/v1/jobs/batch-meta",
            json={
                "jobs": [
                    {"job_id": job_id, "job_access_token": token},
                    {"job_id": "f" * 32, "job_access_token": "wrong-token"},
                ],
                "fields": ["status", "timing", "billing"],
            },
        )
        assert batch.status_code == 200
        batch_body = batch.json()
        assert batch_body["requested"] == 2
        assert batch_body["ok"] == 1
        assert batch_body["items"][0]["job_id"] == job_id
        assert "status" in batch_body["items"][0]["meta"]
        assert "f" * 32 in batch_body["not_found"]

        active = client.post(
            "/v1/jobs/active",
            json={"jobs": [{"job_id": job_id, "job_access_token": token}]},
        )
        assert active.status_code == 200
        active_body = active.json()
        assert active_body["requested"] == 1
        assert active_body["active_count"] == 0
        assert active_body["settled_count"] == 1

        summary_api = client.post(
            "/v1/dashboard/summary",
            json={"jobs": [{"job_id": job_id, "job_access_token": token}], "limit": 50},
        )
        assert summary_api.status_code == 200
        summary_body = summary_api.json()
        assert summary_body["requested"] == 1
        assert summary_body["ok"] == 1
        assert isinstance(summary_body.get("stats"), dict)
        assert "today_count" in summary_body["stats"]

        img = client.get(f"/v1/jobs/{job_id}/images/image_0", headers={"X-Job-Token": token})
        assert img.status_code == 200
        assert img.headers["content-type"].startswith("image/")

        no_list = client.get("/v1/jobs")
        assert no_list.status_code in {404, 405}

        admin_headers = {"X-Admin-Key": settings.admin_api_key} if settings.admin_api_key else {}
        summary = client.get("/v1/billing/summary", headers=admin_headers)
        assert summary.status_code == 200

        remaining = client.get("/v1/billing/google/remaining", headers=admin_headers)
        assert remaining.status_code == 200

        deleted = client.delete(f"/v1/jobs/{job_id}", headers={"X-Job-Token": token})
        assert deleted.status_code == 200
        not_found = client.get(f"/v1/jobs/{job_id}", headers={"X-Job-Token": token})
        assert not_found.status_code == 404


def test_models_endpoint():
    with TestClient(app) as client:
        r = client.get("/v1/models")
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body.get("models"), list)
        assert body["models"]
        ids = {m["model_id"] for m in body["models"]}
        assert "gemini-3-pro-image-preview" in ids
        assert "gemini-2.5-flash-image" in ids
        assert "gemini-3.1-flash-image-preview" in ids


def test_model_mode_validation():
    with TestClient(app) as client:
        r = client.post(
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
        assert r.status_code == 400


def test_thinking_level_validation():
    with TestClient(app) as client:
        r = client.post(
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
        assert r.status_code == 400
