"""Tests for Prometheus metrics exposure."""

from fastapi.testclient import TestClient

from app.main import app


def test_metrics_endpoint_available():
    """GET /metrics should expose Prometheus text output."""
    client = TestClient(app)

    response = client.get("/metrics")

    assert response.status_code == 200
    assert "text/plain" in response.headers.get("content-type", "")
    assert "# HELP" in response.text
