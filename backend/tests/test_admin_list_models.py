"""Tests for admin model enumeration route."""

import httpx
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


def test_list_models_enumerates_openai_compatible_models(monkeypatch):
    seen: dict[str, object] = {}

    class _FakeAsyncClient:
        def __init__(self, *, timeout):
            seen["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, *, headers=None):
            seen["url"] = url
            seen["headers"] = headers
            return httpx.Response(
                200,
                json={"data": [{"id": "gpt-4.1-mini"}, {"id": "gpt-4.1"}]},
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    client = TestClient(app)
    response = client.post(
        "/api/admin/list-models",
        json={"base_url": "https://api.openai.com/v1/", "api_key": "sk-test"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "models": ["gpt-4.1-mini", "gpt-4.1"],
        "provider": "openai",
        "supported": True,
    }
    assert seen == {
        "timeout": 10.0,
        "url": "https://api.openai.com/v1/models",
        "headers": {"Authorization": "Bearer sk-test"},
    }
    assert "api_key" not in httpx.URL(str(seen["url"])).query.decode()


def test_list_models_requires_admin_token_before_enumerating_models(
    monkeypatch,
):
    class _UnexpectedAsyncClient:
        def __init__(self, *args, **kwargs):
            raise AssertionError("admin token rejection must happen before outbound requests")

    monkeypatch.setattr(httpx, "AsyncClient", _UnexpectedAsyncClient)
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "super-secret-token")

    client = TestClient(app)
    response = client.post(
        "/api/admin/list-models",
        json={"base_url": "https://api.anthropic.com/v1", "api_key": "sk-test"},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "ADMIN_TOKEN_REQUIRED"


def test_list_models_rejects_disallowed_base_url():
    client = TestClient(app)
    response = client.post(
        "/api/admin/list-models",
        json={"base_url": "http://api.openai.com/v1", "api_key": "sk-test"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "LLM_BASE_URL_NOT_ALLOWED"


def test_list_models_timeout_returns_fail_soft(monkeypatch):
    class _FakeAsyncClient:
        def __init__(self, *, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, *, headers=None):
            raise httpx.TimeoutException("timed out", request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    client = TestClient(app)
    response = client.post(
        "/api/admin/list-models",
        json={"base_url": "https://api.openai.com/v1", "api_key": "sk-test"},
    )

    assert response.status_code == 200
    assert response.json()["models"] == []
    assert response.json()["provider"] == "openai"
    assert response.json()["supported"] is False
    assert "timed out" in response.json()["reason"]


def test_list_models_caps_returned_model_count(monkeypatch):
    class _FakeAsyncClient:
        def __init__(self, *, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url, *, headers=None):
            return httpx.Response(
                200,
                json={"data": [{"id": f"model-{idx}"} for idx in range(205)]},
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    client = TestClient(app)
    response = client.post(
        "/api/admin/list-models",
        json={"base_url": "https://api.openai.com/v1", "api_key": "sk-test"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["supported"] is True
    assert len(body["models"]) == 200
    assert body["models"][0] == "model-0"
    assert body["models"][-1] == "model-199"
