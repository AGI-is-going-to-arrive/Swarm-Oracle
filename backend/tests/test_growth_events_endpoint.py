"""Tests for GET /api/agents/identities/{identity_id}/growth-events endpoint."""

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

from app.main import app
from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import get_engine, init_db

TEST_USER = "test-user-ge"


@pytest.fixture(autouse=True)
def _init(monkeypatch):
    from app.api import agents as agents_api

    init_db()
    monkeypatch.setattr(agents_api.settings, "FEATURE_CUSTOM_AGENTS", True)
    monkeypatch.setattr(agents_api.settings, "FEATURE_AGENT_IDENTITY", True)
    yield


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _create_identity(identity_id: str, user_id: str = TEST_USER) -> None:
    with Session(get_engine()) as session:
        session.add(AgentIdentity(
            id=identity_id,
            user_id=user_id,
            kind="generated",
            display_name="Test Agent",
            role="analyst",
            continuity_key="ck-test",
        ))
        session.commit()


class TestGrowthEventsEndpoint:
    """Tests for the growth-events read endpoint with ownership."""

    async def test_returns_events_for_identity(self, client: AsyncClient):
        """Insert identity + events and verify the endpoint returns them."""
        identity_id = "test-identity-ge-001"
        _create_identity(identity_id)
        with Session(get_engine()) as session:
            session.add(AgentGrowthEvent(
                identity_id=identity_id,
                scenario_id="scenario-1",
                branch_id="branch-1",
                round_number=3,
                event_type="stance_shift",
                summary="Shifted from hawkish to dovish",
                metrics_json='{"confidence": 0.8}',
            ))
            session.add(AgentGrowthEvent(
                identity_id=identity_id,
                scenario_id="scenario-2",
                branch_id="branch-2",
                round_number=5,
                event_type="alliance",
                summary="Formed alliance with Agent B",
            ))
            session.commit()

        resp = await client.get(
            f"/api/agents/identities/{identity_id}/growth-events",
            params={"user_id": TEST_USER},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["identity_id"] == identity_id
        assert len(data["events"]) == 2

        first = data["events"][0]
        assert first["event_type"] == "stance_shift"
        assert first["summary"] == "Shifted from hawkish to dovish"
        assert first["metrics_json"] == '{"confidence": 0.8}'
        assert first["scenario_id"] == "scenario-1"
        assert first["branch_id"] == "branch-1"
        assert first["round_number"] == 3
        assert first["created_at"] is not None

        second = data["events"][1]
        assert second["event_type"] == "alliance"
        assert second["metrics_json"] is None

    async def test_returns_404_wrong_user(self, client: AsyncClient):
        """Different user_id cannot read another user's identity events."""
        identity_id = "test-identity-ge-002"
        _create_identity(identity_id, user_id="owner-a")

        resp = await client.get(
            f"/api/agents/identities/{identity_id}/growth-events",
            params={"user_id": "attacker-b"},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "AGENT_IDENTITY_NOT_FOUND"

    async def test_returns_400_missing_user_id(self, client: AsyncClient):
        """Missing user_id returns 400."""
        resp = await client.get(
            "/api/agents/identities/any-id/growth-events"
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "USER_ID_REQUIRED"

    async def test_returns_404_nonexistent_identity(self, client: AsyncClient):
        """Non-existent identity returns 404."""
        resp = await client.get(
            "/api/agents/identities/nonexistent-id/growth-events",
            params={"user_id": TEST_USER},
        )
        assert resp.status_code == 404

    async def test_returns_404_when_feature_disabled(self, client: AsyncClient):
        """Endpoint returns 404 when FEATURE_AGENT_IDENTITY is off."""
        from app.api import agents as agents_api

        agents_api.settings.FEATURE_AGENT_IDENTITY = False
        resp = await client.get(
            "/api/agents/identities/any-id/growth-events",
            params={"user_id": TEST_USER},
        )
        assert resp.status_code == 404
        data = resp.json()
        assert data["detail"]["code"] == "FEATURE_DISABLED"
