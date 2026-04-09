"""Tests for Agent Identity & Persona Workshop API endpoints."""

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.main import app
from app.models.database import init_db


@pytest.fixture(autouse=True)
def _init():
    init_db()
    # Enable Phase 3 feature flags for agent tests
    settings.FEATURE_CUSTOM_AGENTS = True
    settings.FEATURE_AGENT_IDENTITY = True
    yield
    settings.FEATURE_CUSTOM_AGENTS = False
    settings.FEATURE_AGENT_IDENTITY = False


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class TestWorkshopCRUD:
    """Full create → list → update → delete lifecycle."""

    async def test_create_agent(self, client: AsyncClient):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "api_user",
            "display_name": "API Agent",
            "role": "strategist",
            "persona": "Calm and rational",
            "knowledge_domains": ["economics", "politics"],
        })
        assert resp.status_code == 201
        data = resp.json()
        assert "id" in data

    async def test_create_agent_missing_fields(self, client: AsyncClient):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "api_user",
        })
        assert resp.status_code == 422  # Pydantic validation error

    async def test_create_agent_invalid_domains(self, client: AsyncClient):
        resp = await client.post("/api/agents/workshop", json={
            "user_id": "api_user",
            "display_name": "Bad",
            "role": "agent",
            "knowledge_domains": ["astrology"],
        })
        assert resp.status_code == 422

    async def test_list_identities(self, client: AsyncClient):
        # Create two agents
        await client.post("/api/agents/workshop", json={
            "user_id": "list_user",
            "display_name": "Agent1",
            "role": "role1",
        })
        await client.post("/api/agents/workshop", json={
            "user_id": "list_user",
            "display_name": "Agent2",
            "role": "role2",
        })

        resp = await client.get("/api/agents/identities", params={"user_id": "list_user"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2

    async def test_list_identities_no_user_id(self, client: AsyncClient):
        resp = await client.get("/api/agents/identities")
        assert resp.status_code == 400

    async def test_update_agent(self, client: AsyncClient):
        # Create
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "upd_user",
            "display_name": "Original",
            "role": "analyst",
        })
        identity_id = create_resp.json()["id"]

        # Update
        resp = await client.put(f"/api/agents/workshop/{identity_id}", json={
            "display_name": "Updated",
        })
        assert resp.status_code == 200
        assert resp.json()["detail"] == "updated"

        # Verify via list
        list_resp = await client.get("/api/agents/identities", params={"user_id": "upd_user"})
        agents = list_resp.json()
        assert any(a["display_name"] == "Updated" for a in agents)

    async def test_update_not_found(self, client: AsyncClient):
        resp = await client.put("/api/agents/workshop/nonexistent", json={
            "display_name": "X",
        })
        assert resp.status_code == 404

    async def test_update_empty_body(self, client: AsyncClient):
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "empty_upd",
            "display_name": "Agent",
            "role": "role",
        })
        identity_id = create_resp.json()["id"]

        resp = await client.put(f"/api/agents/workshop/{identity_id}", json={})
        assert resp.status_code == 400

    async def test_delete_agent(self, client: AsyncClient):
        # Create
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "del_user",
            "display_name": "ToDelete",
            "role": "role",
        })
        identity_id = create_resp.json()["id"]

        # Delete
        resp = await client.delete(f"/api/agents/workshop/{identity_id}")
        assert resp.status_code == 204

        # Verify gone
        list_resp = await client.get("/api/agents/identities", params={"user_id": "del_user"})
        assert len(list_resp.json()) == 0

    async def test_delete_not_found(self, client: AsyncClient):
        resp = await client.delete("/api/agents/workshop/nonexistent")
        assert resp.status_code == 404


class TestMemoryEndpoint:
    async def test_memory_requires_user_id(self, client: AsyncClient):
        resp = await client.get("/api/agents/identities/any-id/memory")
        assert resp.status_code == 400
        assert "user_id" in resp.json()["detail"]

    async def test_memory_returns_404_for_nonexistent_identity(
        self, client: AsyncClient,
    ):
        resp = await client.get(
            "/api/agents/identities/nonexistent-id/memory",
            params={"user_id": "test-user"},
        )
        assert resp.status_code == 404


class TestFullLifecycle:
    """End-to-end: create → list → update → delete → verify 404."""

    async def test_full_crud_cycle(self, client: AsyncClient):
        # 1. Create
        create_resp = await client.post("/api/agents/workshop", json={
            "user_id": "lifecycle_user",
            "display_name": "Lifecycle Agent",
            "role": "diplomat",
            "persona": "A careful negotiator",
            "decision_bias": {"cooperative": 0.9},
            "knowledge_domains": ["politics", "law"],
        })
        assert create_resp.status_code == 201
        identity_id = create_resp.json()["id"]

        # 2. List — should have 1
        list_resp = await client.get(
            "/api/agents/identities", params={"user_id": "lifecycle_user"},
        )
        assert len(list_resp.json()) == 1
        agent = list_resp.json()[0]
        assert agent["display_name"] == "Lifecycle Agent"
        assert agent["knowledge_domains"] == ["politics", "law"]

        # 3. Update
        upd_resp = await client.put(f"/api/agents/workshop/{identity_id}", json={
            "display_name": "Renamed Agent",
            "knowledge_domains": ["philosophy"],
        })
        assert upd_resp.status_code == 200

        # 4. Delete
        del_resp = await client.delete(f"/api/agents/workshop/{identity_id}")
        assert del_resp.status_code == 204

        # 5. Verify deleted — list empty
        list_resp2 = await client.get(
            "/api/agents/identities", params={"user_id": "lifecycle_user"},
        )
        assert len(list_resp2.json()) == 0

        # 6. Verify delete again returns 404
        del_resp2 = await client.delete(f"/api/agents/workshop/{identity_id}")
        assert del_resp2.status_code == 404
