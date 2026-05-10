"""Tests for scenario-scoped Agent Conversation thread listing."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

import app.api.scenarios as scenarios_api
from app.main import app
from app.models.agent_conversation import AgentConversationThread
from app.models.database import Scenario, ScenarioStatus, get_engine


@pytest.fixture(autouse=True)
def _enable_conversation_list(monkeypatch):
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_AGENT_CONVERSATION", True)
    monkeypatch.setattr(scenarios_api.settings, "SESSION_SECRET", "")
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _seed_scenario(*, user_id: str | None = None) -> str:
    engine = get_engine()
    scenario = Scenario(
        question="scenario conversation list",
        status=ScenarioStatus.DONE,
        user_id=user_id,
    )
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def _make_signed_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


def _seed_thread(
    scenario_id: str,
    *,
    thread_id: str,
    created_at: datetime,
    owner_user_id: str = "",
) -> str:
    engine = get_engine()
    thread = AgentConversationThread(
        id=thread_id,
        scenario_id=scenario_id,
        owner_user_id=owner_user_id,
        origin_round_number=1,
        origin_node_id=f"node-{thread_id}",
        origin_node_type="event",
        latest_status="idle",
        created_at=created_at,
        updated_at=created_at,
    )
    with Session(engine) as session:
        session.add(thread)
        session.commit()
        return thread.id


def _thread_ids(body: dict) -> list[str]:
    return [item["thread_id"] for item in body["items"]]


def test_list_scenario_conversations_smoke(client: TestClient):
    scenario_id = _seed_scenario()
    now = datetime(2026, 5, 10, tzinfo=timezone.utc)
    _seed_thread(scenario_id, thread_id="thread-smoke", created_at=now)

    response = client.get(f"/api/scenario/{scenario_id}/conversations")

    assert response.status_code == 200
    body = response.json()
    assert _thread_ids(body) == ["thread-smoke"]
    assert body["items"][0]["scenario_id"] == scenario_id
    assert body["items"][0]["origin_node_type"] == "event"
    assert body["items"][0]["turns"] == []
    assert body["cursor"] == 0
    assert body["has_more"] is False


def test_list_scenario_conversations_paginates_by_cursor_and_limit(client: TestClient):
    scenario_id = _seed_scenario()
    base = datetime(2026, 5, 10, tzinfo=timezone.utc)
    for index in range(3):
        _seed_thread(
            scenario_id,
            thread_id=f"thread-{index + 1}",
            created_at=base + timedelta(minutes=index),
        )

    page_1 = client.get(
        f"/api/scenario/{scenario_id}/conversations",
        params={"cursor": 0, "limit": 2},
    )

    assert page_1.status_code == 200
    body_1 = page_1.json()
    assert _thread_ids(body_1) == ["thread-3", "thread-2"]
    assert body_1["cursor"] == 2
    assert body_1["has_more"] is True

    page_2 = client.get(
        f"/api/scenario/{scenario_id}/conversations",
        params={"cursor": body_1["cursor"], "limit": 2},
    )

    assert page_2.status_code == 200
    body_2 = page_2.json()
    assert _thread_ids(body_2) == ["thread-1"]
    assert body_2["cursor"] == 0
    assert body_2["has_more"] is False

    limit_response = client.get(
        f"/api/scenario/{scenario_id}/conversations",
        params={"limit": 51},
    )
    cursor_response = client.get(
        f"/api/scenario/{scenario_id}/conversations",
        params={"cursor": -1},
    )

    assert limit_response.status_code == 422
    assert cursor_response.status_code == 422


def test_list_scenario_conversations_feature_off_returns_404(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    scenario_id = _seed_scenario()
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_AGENT_CONVERSATION", False)

    response = client.get(f"/api/scenario/{scenario_id}/conversations")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"


def test_list_scenario_conversations_enforces_scenario_ownership(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    secret = "conversation-list-secret"
    monkeypatch.setattr(scenarios_api.settings, "SESSION_SECRET", secret)
    scenario_id = _seed_scenario(user_id="alice")
    token = _make_signed_token(secret, "bob")

    response = client.get(
        f"/api/scenario/{scenario_id}/conversations",
        headers={"X-Session-Token": token},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


def test_list_scenario_conversations_empty_page(client: TestClient):
    scenario_id = _seed_scenario()

    response = client.get(f"/api/scenario/{scenario_id}/conversations")

    assert response.status_code == 200
    assert response.json() == {"items": [], "cursor": 0, "has_more": False}
