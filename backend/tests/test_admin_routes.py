"""Smoke tests for admin API routes."""

from fastapi.testclient import TestClient

import app.api.admin as admin_api
from app.config import settings
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


def test_admin_preflight_requires_admin_token_when_configured(monkeypatch):
    """When ADMIN_TOKEN is set, /preflight rejects requests missing the header."""
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "super-secret-token")
    client = TestClient(app)
    response = client.get("/api/admin/preflight")
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "ADMIN_TOKEN_REQUIRED"


def test_admin_test_llm_requires_admin_token_when_configured(monkeypatch):
    """When ADMIN_TOKEN is set, /test-llm rejects requests missing the header."""
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "super-secret-token")
    client = TestClient(app)
    response = client.post(
        "/api/admin/test-llm",
        json={"api_key": "sk-test", "base_url": "http://127.0.0.1:9000/v1"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "ADMIN_TOKEN_REQUIRED"


def test_admin_preflight_rejects_wrong_admin_token(monkeypatch):
    """An incorrect X-Admin-Token still returns 403, not a partial match."""
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "super-secret-token")
    client = TestClient(app)
    response = client.get(
        "/api/admin/preflight",
        headers={"X-Admin-Token": "wrong-token"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "ADMIN_TOKEN_REQUIRED"


def test_admin_preflight_accepts_valid_admin_token(monkeypatch):
    """A correct X-Admin-Token unlocks the endpoint."""
    async def _fake_run_preflight():
        return [PreflightCheckResult("sqlite", "pass", "ok")]

    monkeypatch.setattr(admin_api, "run_preflight", _fake_run_preflight)
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "super-secret-token")
    client = TestClient(app)
    response = client.get(
        "/api/admin/preflight",
        headers={"X-Admin-Token": "super-secret-token"},
    )
    assert response.status_code == 200
    assert response.json()[0]["name"] == "sqlite"


def test_admin_preflight_open_when_admin_token_unset(monkeypatch):
    """Default empty ADMIN_TOKEN keeps admin endpoints open for development."""
    async def _fake_run_preflight():
        return [PreflightCheckResult("sqlite", "pass", "ok")]

    monkeypatch.setattr(admin_api, "run_preflight", _fake_run_preflight)
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "")
    client = TestClient(app)
    response = client.get("/api/admin/preflight")
    assert response.status_code == 200
