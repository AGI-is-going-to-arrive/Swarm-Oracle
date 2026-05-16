from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.api import quota as quota_module
from app.main import app
from app.models.agent_conversation import AgentConversationQuotaLedger
from app.models.database import Branch, Scenario, ScenarioStatus, get_engine


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _make_signed_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


def _seed_scenario(*, user_id: str | None = None) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(question="quota?", status=ScenarioStatus.DONE, user_id=user_id)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def _seed_quota_hit(
    scenario_id: str,
    *,
    delta: int,
    owner_user_id: str | None = None,
    created_at: datetime | None = None,
) -> None:
    with Session(get_engine()) as session:
        session.add(
            AgentConversationQuotaLedger(
                owner_user_id=owner_user_id,
                scenario_id=scenario_id,
                thread_id=f"thread-{scenario_id}-{delta}",
                turn_delta=delta,
                created_at=created_at or datetime.now(timezone.utc),
            )
        )
        session.commit()


def _seed_branch(scenario_id: str, *, replay_kind: str | None = None) -> None:
    with Session(get_engine()) as session:
        session.add(
            Branch(
                scenario_id=scenario_id,
                title=f"branch-{replay_kind or 'live'}",
                replay_kind=replay_kind,
            )
        )
        session.commit()


def test_quota_summary_route_reachable_and_returns_shape(client: TestClient):
    response = client.get("/api/quota/summary")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"conversation", "replay"}
    for key in ("conversation", "replay"):
        assert set(body[key]) == {
            "used",
            "limit",
            "remaining",
            "enforced",
            "scope",
            "window_seconds",
        }
        assert all(isinstance(body[key][field], int) for field in ("used", "limit", "remaining"))
        assert isinstance(body[key]["enforced"], bool)
    assert body["conversation"]["scope"] == "local"
    assert body["conversation"]["enforced"] is False
    assert body["conversation"]["window_seconds"] == 86400
    assert body["replay"]["scope"] == "scenario"
    assert body["replay"]["enforced"] is True
    assert body["replay"]["window_seconds"] is None


def test_quota_summary_aggregates_scenario_usage(client: TestClient, monkeypatch):
    monkeypatch.setattr(quota_module.settings, "CONVERSATION_TURNS_PER_USER_PER_DAY", 10)
    scenario_id = _seed_scenario()
    other_scenario_id = _seed_scenario()
    old_hit_at = datetime.now(timezone.utc) - timedelta(hours=25)

    _seed_quota_hit(scenario_id, delta=4)
    _seed_quota_hit(scenario_id, delta=3)
    _seed_quota_hit(scenario_id, delta=99, created_at=old_hit_at)
    _seed_quota_hit(other_scenario_id, delta=5)
    _seed_branch(scenario_id, replay_kind="counterfactual")
    _seed_branch(scenario_id, replay_kind="resume")
    _seed_branch(scenario_id, replay_kind="retrospective")
    _seed_branch(scenario_id)
    _seed_branch(other_scenario_id, replay_kind="counterfactual")

    response = client.get("/api/quota/summary", params={"scenario_id": scenario_id})

    assert response.status_code == 200
    body = response.json()
    assert body["conversation"] == {
        "used": 7,
        "limit": 10,
        "remaining": 3,
        "enforced": False,
        "scope": "local",
        "window_seconds": 86400,
    }
    assert body["replay"] == {
        "used": 2,
        "limit": 3,
        "remaining": 1,
        "enforced": True,
        "scope": "scenario",
        "window_seconds": None,
    }


def test_quota_summary_global_usage_follows_signed_principal(client: TestClient, monkeypatch):
    secret = "quota-secret"
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr(quota_module.settings, "CONVERSATION_TURNS_PER_USER_PER_DAY", 10)
    owner_scenario_id = _seed_scenario(user_id="owner")
    other_scenario_id = _seed_scenario(user_id="other")
    _seed_quota_hit(owner_scenario_id, delta=4, owner_user_id="owner")
    _seed_quota_hit(other_scenario_id, delta=5, owner_user_id="other")

    response = client.get(
        "/api/quota/summary",
        headers={"X-Session-Token": _make_signed_token(secret, "owner")},
    )

    assert response.status_code == 200
    assert response.json()["conversation"] == {
        "used": 4,
        "limit": 10,
        "remaining": 6,
        "enforced": True,
        "scope": "user",
        "window_seconds": 86400,
    }
    assert response.json()["replay"] == {
        "used": 0,
        "limit": 3,
        "remaining": 3,
        "enforced": True,
        "scope": "scenario",
        "window_seconds": None,
    }


def test_quota_summary_global_usage_can_follow_org_scope(client: TestClient, monkeypatch):
    monkeypatch.setattr(quota_module.settings, "CONVERSATION_TURNS_PER_USER_PER_DAY", 10)
    scenario_id = _seed_scenario()
    _seed_quota_hit(scenario_id, delta=4, owner_user_id=None)
    with Session(get_engine()) as session:
        hit = session.exec(select(AgentConversationQuotaLedger)).first()
        assert hit is not None
        hit.organization_id = "local-org"
        session.add(hit)
        session.commit()

    response = client.get("/api/quota/summary", headers={"X-Org-Id": "local-org"})

    assert response.status_code == 200
    assert response.json()["conversation"] == {
        "used": 4,
        "limit": 10,
        "remaining": 6,
        "enforced": True,
        "scope": "org",
        "window_seconds": 86400,
    }


def test_quota_summary_session_validation(client: TestClient, monkeypatch):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")

    missing = client.get("/api/quota/summary")
    wrong = client.get("/api/quota/summary", headers={"X-Session-Token": "wrong"})
    raw_secret = client.get("/api/quota/summary", headers={"X-Session-Token": "s3cret"})
    signed = client.get(
        "/api/quota/summary",
        headers={"X-Session-Token": _make_signed_token("s3cret", "owner")},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert raw_secret.status_code == 401
    assert signed.status_code == 200


def test_quota_summary_hides_foreign_scenario(client: TestClient, monkeypatch):
    secret = "quota-owner-secret"
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    scenario_id = _seed_scenario(user_id="other")

    response = client.get(
        "/api/quota/summary",
        params={"scenario_id": scenario_id},
        headers={"X-Session-Token": _make_signed_token(secret, "owner")},
    )

    assert response.status_code == 404
