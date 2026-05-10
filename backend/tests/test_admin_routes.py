"""Smoke tests for admin API routes."""

from fastapi.testclient import TestClient

import app.api.admin as admin_api
from app.main import app
from app.services.preflight import PreflightCheckResult


def test_preflight_route_returns_all_checks(monkeypatch):
    async def _fake_run_preflight():
        return [
            PreflightCheckResult("sqlite", "pass", "ok"),
            PreflightCheckResult("chromadb", "pass", "ok"),
            PreflightCheckResult("llm", "warn", "skipped"),
            PreflightCheckResult("web_search", "warn", "disabled"),
            PreflightCheckResult("cors", "pass", "configured"),
            PreflightCheckResult("volume", "pass", "writable"),
        ]

    monkeypatch.setattr(admin_api, "run_preflight", _fake_run_preflight)

    client = TestClient(app)
    response = client.get("/api/admin/preflight")

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert {item["name"] for item in data} == {
        "sqlite",
        "chromadb",
        "llm",
        "web_search",
        "cors",
        "volume",
    }
    assert all({"name", "status", "message"} <= set(item) for item in data)


def test_test_llm_route_uses_allowed_base_url(monkeypatch):
    seen = {}

    async def _fake_health_check(**kwargs):
        seen.update(kwargs)
        return {"status": "ok", "model": kwargs.get("model") or "test-model", "response": "OK"}

    monkeypatch.setattr(admin_api, "health_check", _fake_health_check)

    client = TestClient(app)
    response = client.post(
        "/api/admin/test-llm",
        json={
            "api_key": "sk-test",
            "base_url": "http://127.0.0.1:9000/v1",
            "model": "test-model",
        },
    )

    assert response.status_code == 200
    assert response.json()["llm"]["status"] == "ok"
    assert seen == {
        "api_key": "sk-test",
        "base_url": "http://127.0.0.1:9000/v1",
        "model": "test-model",
    }


def test_test_llm_route_rejects_disallowed_base_url():
    client = TestClient(app)
    response = client.post(
        "/api/admin/test-llm",
        json={
            "api_key": "sk-test",
            "base_url": "http://api.openai.com/v1",
            "model": "test-model",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"
