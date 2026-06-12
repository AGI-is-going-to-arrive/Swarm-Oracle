"""Tests for the Identity Memory Inspector endpoint (S5-4).

Endpoint: GET /api/agents/identities/{identity_id}/memories

Verifies:
* Owned identity returns 200 with memories + total.
* Missing identity returns 404.
* Other-user identity returns 404 (concealment, no info leak).
* Disabled FEATURE_AGENT_IDENTITY returns 404.
* Sensitive metadata keys (api_key/token/secret/email/password/auth) are
  stripped from the response before reaching the client.
* Empty identity returns ``{"memories": [], "total": 0}`` (not an error).
* Inspector caps results at 100 entries.
* Compacted vs raw entries are surfaced via ``is_compacted``.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

from app.api import agents as agents_api
from app.main import app
from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine
from app.services.vector_store import get_vector_store, store_identity_memory

OWNER_USER = "inspector-user"
OTHER_USER = "inspector-other-user"


@pytest.fixture(autouse=True)
def _feature_flags(monkeypatch):
    monkeypatch.setattr(agents_api.settings, "FEATURE_AGENT_IDENTITY", True)
    monkeypatch.setattr(agents_api.settings, "FEATURE_CUSTOM_AGENTS", True)
    yield


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _create_identity(
    identity_id: str,
    *,
    user_id: str = OWNER_USER,
) -> None:
    with Session(get_engine()) as session:
        session.add(
            AgentIdentity(
                id=identity_id,
                user_id=user_id,
                kind="generated",
                display_name=f"Agent {identity_id}",
                role="strategist",
                persona="Cross-scenario operative",
                continuity_key=f"{identity_id}-key",
            )
        )
        session.commit()


def _store_memory(
    identity_id: str,
    *,
    user_id: str = OWNER_USER,
    summary: str = "stance shift recorded",
    metadata: dict | None = None,
) -> None:
    """Write directly into ChromaDB via the public API surface."""
    store_identity_memory(
        user_id=user_id,
        identity_id=identity_id,
        scenario_id=(metadata or {}).get("scenario_id", "scenario-1"),
        summary=summary,
        metadata=metadata,
    )


def _store_raw_memory(
    identity_id: str,
    *,
    user_id: str = OWNER_USER,
    document: str,
    metadata: dict,
    doc_id: str | None = None,
) -> str:
    """Insert a raw memory document, bypassing redaction in store helper.

    Used to simulate memories with potentially sensitive metadata that
    arrived via legacy/external writers, so we can prove the inspector
    redacts before responding.
    """
    import uuid

    vs = get_vector_store()
    if not vs.available:
        pytest.skip("ChromaDB unavailable in this environment")
    collection_name = f"identity_{user_id.replace('-', '_')}"
    if len(collection_name) > 63:
        collection_name = collection_name[:63]
    collection = vs._client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )
    payload = {"identity_id": identity_id, **metadata}
    memory_id = doc_id or str(uuid.uuid4())
    collection.add(
        documents=[document],
        metadatas=[payload],
        ids=[memory_id],
    )
    return memory_id


# ── 200 path ────────────────────────────────────────────


async def test_endpoint_returns_200_with_memories_when_owned(client: AsyncClient):
    _create_identity("inspector-owned")
    _store_memory(
        "inspector-owned",
        summary="kept faith with the council",
        metadata={
            "scenario_id": "scenario-alpha",
            "created_at": "2026-05-10T10:00:00Z",
        },
    )

    resp = await client.get(
        "/api/agents/identities/inspector-owned/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert "memories" in body and "total" in body
    assert body["total"] == 1
    entry = body["memories"][0]
    assert entry["memory_id"]
    assert entry["document"] == "kept faith with the council"
    assert entry["source_scenario_id"] == "scenario-alpha"
    assert entry["timestamp"] == "2026-05-10T10:00:00Z"
    assert entry["is_compacted"] is False
    assert entry["pinned"] is False
    assert entry["remembered"] is False
    assert entry["metadata"]["scenario_id"] == "scenario-alpha"


async def test_endpoint_returns_empty_list_when_no_memories(client: AsyncClient):
    """Empty identity must return success, not error."""
    _create_identity("inspector-empty")

    resp = await client.get(
        "/api/agents/identities/inspector-empty/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body == {"memories": [], "total": 0}


async def test_endpoint_sorts_by_timestamp_descending(client: AsyncClient):
    _create_identity("inspector-sort")
    _store_memory(
        "inspector-sort",
        summary="oldest event",
        metadata={
            "scenario_id": "scenario-old",
            "created_at": "2026-01-01T00:00:00Z",
        },
    )
    _store_memory(
        "inspector-sort",
        summary="newest event",
        metadata={
            "scenario_id": "scenario-new",
            "created_at": "2026-05-01T00:00:00Z",
        },
    )
    _store_memory(
        "inspector-sort",
        summary="middle event",
        metadata={
            "scenario_id": "scenario-mid",
            "created_at": "2026-03-01T00:00:00Z",
        },
    )

    resp = await client.get(
        "/api/agents/identities/inspector-sort/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    docs = [entry["document"] for entry in resp.json()["memories"]]
    assert docs == ["newest event", "middle event", "oldest event"]


# ── 404 paths ───────────────────────────────────────────


async def test_endpoint_returns_404_when_identity_missing(client: AsyncClient):
    resp = await client.get(
        "/api/agents/identities/does-not-exist/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 404


async def test_endpoint_returns_404_for_other_users_identity_concealment(
    client: AsyncClient,
):
    """Other-user identity must look identical to "missing" to the caller."""
    _create_identity("inspector-foreign", user_id=OTHER_USER)
    _store_memory(
        "inspector-foreign",
        user_id=OTHER_USER,
        summary="confidential cross-scenario note",
        metadata={"scenario_id": "scenario-secret"},
    )

    resp = await client.get(
        "/api/agents/identities/inspector-foreign/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 404
    body = resp.json()
    # Must not leak the foreign memory document or metadata.
    assert "memories" not in body
    assert "scenario-secret" not in resp.text
    assert "confidential cross-scenario note" not in resp.text


async def test_endpoint_returns_404_when_feature_flag_disabled(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _create_identity("inspector-disabled")
    monkeypatch.setattr(agents_api.settings, "FEATURE_AGENT_IDENTITY", False)

    resp = await client.get(
        "/api/agents/identities/inspector-disabled/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 404
    body = resp.json()
    assert body["detail"]["code"] == "FEATURE_DISABLED"


async def test_endpoint_returns_400_when_user_id_missing(client: AsyncClient):
    _create_identity("inspector-no-user")

    resp = await client.get(
        "/api/agents/identities/inspector-no-user/memories",
    )

    assert resp.status_code == 400


# ── Redaction ───────────────────────────────────────────


async def test_redaction_strips_sensitive_metadata_keys(client: AsyncClient):
    """api_key/token/secret/email/password keys must never reach the response."""
    _create_identity("inspector-redact")
    _store_raw_memory(
        "inspector-redact",
        document="memory with sensitive metadata",
        metadata={
            "scenario_id": "scenario-redact",
            "created_at": "2026-05-10T12:00:00Z",
            # Sensitive — must be stripped:
            "api_key": "sk-leaked-byok-key-12345",
            "session_token": "session-leaked-1234",
            "user_email": "victim@example.com",
            "password": "hunter2",
            "secret_note": "ssh-rsa AAAA",
            "auth_header": "Bearer abc",
            "credential": "vault:abc",
        },
    )

    resp = await client.get(
        "/api/agents/identities/inspector-redact/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    entry = body["memories"][0]

    # Sensitive values must be absent from the entire response payload.
    raw_text = resp.text
    forbidden_values = (
        "sk-leaked-byok-key-12345",
        "session-leaked-1234",
        "victim@example.com",
        "hunter2",
        "ssh-rsa AAAA",
        "Bearer abc",
        "vault:abc",
    )
    for value in forbidden_values:
        assert value not in raw_text, f"leaked sensitive value: {value}"

    # Sensitive keys must be absent from the metadata dict.
    forbidden_keys = (
        "api_key",
        "session_token",
        "user_email",
        "password",
        "secret_note",
        "auth_header",
        "credential",
    )
    for key in forbidden_keys:
        assert key not in entry["metadata"], f"leaked sensitive key: {key}"

    # Safe metadata still present.
    assert entry["metadata"]["scenario_id"] == "scenario-redact"
    assert entry["source_scenario_id"] == "scenario-redact"


async def test_redaction_only_allowlisted_metadata_keys_are_returned(
    client: AsyncClient,
):
    """Even non-sensitive but unknown metadata keys must be filtered out."""
    _create_identity("inspector-allowlist")
    _store_raw_memory(
        "inspector-allowlist",
        document="memory with unknown metadata key",
        metadata={
            "scenario_id": "scenario-allow",
            "created_at": "2026-05-10T13:00:00Z",
            "round_number": 5,
            "internal_debug_note": "should_not_leak",
            "admin_only_flag": "yes",
        },
    )

    resp = await client.get(
        "/api/agents/identities/inspector-allowlist/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    entry = resp.json()["memories"][0]
    assert entry["metadata"]["scenario_id"] == "scenario-allow"
    assert entry["metadata"]["round_number"] == "5"
    assert "internal_debug_note" not in entry["metadata"]
    assert "admin_only_flag" not in entry["metadata"]
    assert "should_not_leak" not in resp.text


# ── Compaction + cap ────────────────────────────────────


async def test_endpoint_surfaces_compaction_status(client: AsyncClient):
    _create_identity("inspector-compaction")
    _store_raw_memory(
        "inspector-compaction",
        document="raw memory",
        metadata={
            "scenario_id": "scenario-raw",
            "created_at": "2026-05-10T10:00:00Z",
        },
    )
    _store_raw_memory(
        "inspector-compaction",
        document="compacted summary",
        metadata={
            "scenario_id": "scenario-compact",
            "created_at": "2026-05-10T11:00:00Z",
            "compacted": "true",
            "confidence_tier": "medium",
        },
    )

    resp = await client.get(
        "/api/agents/identities/inspector-compaction/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    by_doc = {entry["document"]: entry for entry in resp.json()["memories"]}
    assert by_doc["raw memory"]["is_compacted"] is False
    assert by_doc["compacted summary"]["is_compacted"] is True
    assert by_doc["compacted summary"]["confidence"] == "medium"


async def test_endpoint_projects_unknown_confidence_tier_to_unknown(
    client: AsyncClient,
):
    _create_identity("inspector-confidence")
    _store_raw_memory(
        "inspector-confidence",
        document="memory with injected confidence",
        metadata={
            "scenario_id": "scenario-confidence",
            "created_at": "2026-05-10T11:00:00Z",
            "confidence_tier": "admin_override",
        },
    )

    resp = await client.get(
        "/api/agents/identities/inspector-confidence/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    assert resp.json()["memories"][0]["confidence"] == "unknown"


async def test_endpoint_excludes_l2_profile_embeddings(client: AsyncClient):
    """identity_profile docs are matching aids — they must not appear here."""
    _create_identity("inspector-profile")
    _store_raw_memory(
        "inspector-profile",
        document="real memory",
        metadata={
            "scenario_id": "scenario-real",
            "created_at": "2026-05-10T10:00:00Z",
        },
    )
    _store_raw_memory(
        "inspector-profile",
        document="profile embedding text",
        metadata={
            "doc_type": "identity_profile",
            "created_at": "2026-05-10T11:00:00Z",
        },
    )

    resp = await client.get(
        "/api/agents/identities/inspector-profile/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    docs = [entry["document"] for entry in resp.json()["memories"]]
    assert docs == ["real memory"]


async def test_endpoint_caps_response_at_100_entries(client: AsyncClient):
    _create_identity("inspector-cap")
    for idx in range(120):
        _store_raw_memory(
            "inspector-cap",
            document=f"memory-{idx:03d}",
            metadata={
                "scenario_id": "scenario-cap",
                "created_at": f"2026-05-10T{idx // 60:02d}:{idx % 60:02d}:00Z",
            },
        )

    resp = await client.get(
        "/api/agents/identities/inspector-cap/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 100
    assert len(body["memories"]) == 100


async def test_endpoint_isolates_memories_to_target_identity(client: AsyncClient):
    """Memories from a different identity (same user) must not leak in."""
    _create_identity("inspector-iso-a")
    _create_identity("inspector-iso-b")

    _store_memory(
        "inspector-iso-a",
        summary="from identity A",
        metadata={"scenario_id": "scenario-a"},
    )
    _store_memory(
        "inspector-iso-b",
        summary="from identity B",
        metadata={"scenario_id": "scenario-b"},
    )

    resp = await client.get(
        "/api/agents/identities/inspector-iso-a/memories",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 200
    docs = [entry["document"] for entry in resp.json()["memories"]]
    assert docs == ["from identity A"]


# ── Retrieval-hit chips + pinning ───────────────────────


def test_loader_marks_retrieval_hits_from_query_results(monkeypatch: pytest.MonkeyPatch):
    class FakeCollection:
        def count(self) -> int:
            return 2

        def get(self, **_kwargs):
            return {
                "ids": ["mem-1", "mem-2"],
                "documents": ["budget cap memory", "privacy audit memory"],
                "metadatas": [
                    {
                        "identity_id": "inspector-query",
                        "scenario_id": "scenario-a",
                        "created_at": "2026-05-10T10:00:00Z",
                    },
                    {
                        "identity_id": "inspector-query",
                        "scenario_id": "scenario-b",
                        "created_at": "2026-05-10T11:00:00Z",
                    },
                ],
            }

        def query(self, **_kwargs):
            return {"ids": [["mem-2"]]}

    class FakeClient:
        def get_collection(self, *, name: str):
            assert name == "identity_inspector_user"
            return FakeCollection()

    class FakeStore:
        available = True
        _client = FakeClient()

    monkeypatch.setattr("app.services.vector_store.get_vector_store", lambda: FakeStore())

    entries, error_code = agents_api._load_identity_memory_entries(
        "inspector-query",
        OWNER_USER,
        query_text="audit",
    )

    assert error_code is None
    by_id = {entry["memory_id"]: entry for entry in entries}
    assert by_id["mem-1"]["remembered"] is False
    assert by_id["mem-2"]["remembered"] is True


async def test_pin_and_unpin_memory_persists_in_chroma_metadata(client: AsyncClient):
    _create_identity("inspector-pin")
    memory_id = _store_raw_memory(
        "inspector-pin",
        document="memory to pin",
        metadata={
            "scenario_id": "scenario-pin",
            "created_at": "2026-05-10T10:00:00Z",
        },
        doc_id="pin-target",
    )

    pin_resp = await client.post(
        f"/api/agents/identities/inspector-pin/memories/{memory_id}/pin",
        params={"user_id": OWNER_USER},
    )

    assert pin_resp.status_code == 200
    assert pin_resp.json() == {
        "identity_id": "inspector-pin",
        "memory_id": memory_id,
        "pinned": True,
        "pin_count": 1,
        "cap": 20,
    }

    list_resp = await client.get(
        "/api/agents/identities/inspector-pin/memories",
        params={"user_id": OWNER_USER},
    )
    assert list_resp.status_code == 200
    assert list_resp.json()["memories"][0]["pinned"] is True

    unpin_resp = await client.delete(
        f"/api/agents/identities/inspector-pin/memories/{memory_id}/pin",
        params={"user_id": OWNER_USER},
    )

    assert unpin_resp.status_code == 200
    assert unpin_resp.json()["pinned"] is False
    assert unpin_resp.json()["pin_count"] == 0


async def test_pin_endpoint_enforces_twenty_memory_cap(client: AsyncClient):
    _create_identity("inspector-pin-cap")
    for idx in range(20):
        _store_raw_memory(
            "inspector-pin-cap",
            document=f"pinned memory {idx}",
            metadata={
                "scenario_id": "scenario-pin-cap",
                "created_at": f"2026-05-10T00:{idx:02d}:00Z",
                "pinned": "true",
            },
            doc_id=f"pin-existing-{idx}",
        )
    memory_id = _store_raw_memory(
        "inspector-pin-cap",
        document="twenty first memory",
        metadata={
            "scenario_id": "scenario-pin-cap",
            "created_at": "2026-05-10T01:00:00Z",
        },
        doc_id="pin-over-cap",
    )

    resp = await client.post(
        f"/api/agents/identities/inspector-pin-cap/memories/{memory_id}/pin",
        params={"user_id": OWNER_USER},
    )

    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"]["code"] == "IDENTITY_MEMORY_PIN_LIMIT_REACHED"
    assert "20" in body["detail"]["message"]
