"""Tests for Prometheus metrics exposure."""

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


def test_metrics_endpoint_available():
    """GET /metrics should expose Prometheus text output."""
    client = TestClient(app)

    response = client.get("/metrics")

    assert response.status_code == 200
    assert "text/plain" in response.headers.get("content-type", "")
    assert "# HELP" in response.text


def test_metrics_requires_session_token_when_session_secret_is_configured(monkeypatch):
    monkeypatch.setattr(settings, "SESSION_SECRET", "metrics-secret")
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "")
    client = TestClient(app)

    response = client.get("/metrics")

    assert response.status_code == 401


def test_metrics_accepts_session_token_when_session_secret_is_configured(monkeypatch):
    monkeypatch.setattr(settings, "SESSION_SECRET", "metrics-secret")
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "")
    client = TestClient(app)

    response = client.get("/metrics", headers={"X-Session-Token": "metrics-secret"})

    assert response.status_code == 200
    assert "# HELP" in response.text


def test_metrics_accepts_admin_token_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "metrics-admin-token")
    client = TestClient(app)

    response = client.get("/metrics", headers={"X-Admin-Token": "metrics-admin-token"})

    assert response.status_code == 200
    assert "# HELP" in response.text


def test_metrics_rejects_missing_admin_token_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "metrics-admin-token")
    client = TestClient(app)

    response = client.get("/metrics")

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "ADMIN_TOKEN_REQUIRED"


def test_metrics_rejects_wrong_admin_token_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "metrics-admin-token")
    client = TestClient(app)

    response = client.get("/metrics", headers={"X-Admin-Token": "wrong-token"})

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "ADMIN_TOKEN_REQUIRED"
