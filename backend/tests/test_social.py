from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models import Agent, Branch, BranchStatus, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.llm_client import LLMError


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _seed_social_scenario(*, parsed_context: dict | None = None) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="What if Zheng He reached the Americas first?",
            status=ScenarioStatus.DONE,
            parsed_context=parsed_context or {"_language": "English"},
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Harbor Envoy",
                role="Envoy",
                stance="coalition",
            )
        )
        session.add(
            Branch(
                scenario_id=scenario_id,
                title="Harbor coalition holds",
                probability=0.72,
                status=BranchStatus.COMPLETED,
                story="Trade cities coordinate supply and keep the route open.",
                insight="Ports, not courts, decide the outcome.",
            )
        )
        session.commit()
        return scenario_id


def _request_social_copy(
    client: TestClient,
    method: str,
    scenario_id: str,
    *,
    body: dict | None = None,
):
    url = f"/api/scenario/{scenario_id}/social/x"
    if method == "GET":
        return client.get(url)
    return client.post(url, json=body or {})


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_inherited_remote_byok_url_uses_server_default(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-server-default", raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "byok-profile-model",
            "user_id": "owner-1",
        }
    )

    async def fake_llm(_prompt: str, **kwargs):
        if (
            kwargs.get("api_key") is not None
            or kwargs.get("base_url") is not None
            or kwargs.get("model") is not None
        ):
            raise LLMError(f"expected server default provider, got {kwargs!r}")
        return "server default social copy"

    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(client, method, scenario_id)

    assert response.status_code == 200
    assert response.json()["copy"] == "server default social copy"


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_per_platform_endpoints_honor_feature_gate(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", False, raising=False)
    scenario_id = _seed_social_scenario()
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("feature gate should block before LLM work")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(client, method, scenario_id)

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"
    assert called is False


def test_social_copy_explicit_base_url_without_key_still_requires_key(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario()

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"llm_base_url": "https://api.openai.com/v1"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


def test_social_copy_inherited_remote_byok_url_without_server_key_is_400(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "", raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
        }
    )
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("LLM should not be called without a server default key")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(client, "GET", scenario_id)

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    assert called is False
