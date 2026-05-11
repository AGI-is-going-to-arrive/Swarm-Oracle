"""Tests for custom Agent decision_bias schema validation."""

import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine

DECISION_BIAS_KEYS = [
    "caution",
    "optimism",
    "conservatism",
    "risk_tolerance",
    "creativity",
]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_CUSTOM_AGENTS", True)
    monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", True)
    with TestClient(app) as test_client:
        yield test_client


def _create_agent(client: TestClient, user_id: str = "bias-user") -> str:
    response = client.post(
        "/api/agents/workshop",
        json={
            "user_id": user_id,
            "display_name": "Bias Agent",
            "role": "strategist",
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def _stored_decision_bias(identity_id: str) -> dict:
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        assert identity is not None
        assert identity.decision_bias_json is not None
        return json.loads(identity.decision_bias_json)


def test_valid_bias_saves_successfully(client: TestClient):
    identity_id = _create_agent(client)
    bias = {
        "caution": 0.1,
        "optimism": 0.2,
        "conservatism": 0.3,
        "risk_tolerance": 0.4,
        "creativity": 0.5,
    }

    response = client.patch(
        f"/api/agents/workshop/{identity_id}",
        params={"user_id": "bias-user"},
        json={"decision_bias": bias},
    )

    assert response.status_code == 200
    assert _stored_decision_bias(identity_id) == bias


@pytest.mark.parametrize("value", [1.1, -0.1])
def test_out_of_range_values_rejected(client: TestClient, value: float):
    identity_id = _create_agent(client)

    response = client.patch(
        f"/api/agents/workshop/{identity_id}",
        params={"user_id": "bias-user"},
        json={"decision_bias": {"caution": value}},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "AGENT_UPDATE_INVALID"
    assert "decision_bias.caution must be 0-1" in response.json()["detail"]["message"]


def test_non_numeric_values_rejected(client: TestClient):
    identity_id = _create_agent(client)

    response = client.patch(
        f"/api/agents/workshop/{identity_id}",
        params={"user_id": "bias-user"},
        json={"decision_bias": {"optimism": "high"}},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "AGENT_UPDATE_INVALID"
    assert "decision_bias.optimism must be 0-1" in response.json()["detail"]["message"]


@pytest.mark.parametrize("raw_value", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_values_rejected(client: TestClient, raw_value: str):
    identity_id = _create_agent(client)

    response = client.patch(
        f"/api/agents/workshop/{identity_id}",
        params={"user_id": "bias-user"},
        content=f'{{"decision_bias": {{"caution": {raw_value}}}}}',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "AGENT_UPDATE_INVALID"
    assert "decision_bias.caution must be 0-1" in response.json()["detail"]["message"]


@pytest.mark.parametrize("raw_value", [True, False])
def test_boolean_values_rejected(client: TestClient, raw_value: bool):
    identity_id = _create_agent(client)

    response = client.patch(
        f"/api/agents/workshop/{identity_id}",
        params={"user_id": "bias-user"},
        json={"decision_bias": {"creativity": raw_value}},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "AGENT_UPDATE_INVALID"
    assert "decision_bias.creativity must be 0-1" in response.json()["detail"]["message"]


def test_missing_keys_auto_fill_default(client: TestClient):
    identity_id = _create_agent(client)

    response = client.patch(
        f"/api/agents/workshop/{identity_id}",
        params={"user_id": "bias-user"},
        json={"decision_bias": {"caution": 0.25}},
    )

    assert response.status_code == 200
    assert _stored_decision_bias(identity_id) == {
        "caution": 0.25,
        "optimism": 0.5,
        "conservatism": 0.5,
        "risk_tolerance": 0.5,
        "creativity": 0.5,
    }


def test_unknown_keys_are_ignored(client: TestClient):
    identity_id = _create_agent(client)
    bias = {key: 0.4 for key in DECISION_BIAS_KEYS}
    bias["aggression"] = 1.0

    response = client.patch(
        f"/api/agents/workshop/{identity_id}",
        params={"user_id": "bias-user"},
        json={"decision_bias": bias},
    )

    assert response.status_code == 200
    assert _stored_decision_bias(identity_id) == {
        "caution": 0.4,
        "optimism": 0.4,
        "conservatism": 0.4,
        "risk_tolerance": 0.4,
        "creativity": 0.4,
    }
