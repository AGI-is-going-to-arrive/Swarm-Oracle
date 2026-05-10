"""Tests for persona export/import service + API endpoints."""

from __future__ import annotations

import json

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine, init_db
from app.services.persona_export import (
    MAX_BULK_EXPORT,
    SCHEMA_VERSION,
    export_persona,
    export_personas_bulk,
    import_persona,
    validate_import_payload,
)
from app.services.persona_workshop import create_custom_agent


@pytest.fixture(autouse=True)
def _init():
    init_db()
    settings.FEATURE_CUSTOM_AGENTS = True
    settings.FEATURE_AGENT_IDENTITY = True
    settings.FEATURE_PERSONA_EXPORT = True
    yield
    settings.FEATURE_CUSTOM_AGENTS = False
    settings.FEATURE_AGENT_IDENTITY = False
    settings.FEATURE_PERSONA_EXPORT = False


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _seed_identity(
    user_id: str = "owner",
    *,
    display_name: str = "Test Agent",
    role: str = "analyst",
    persona: str = "A careful thinker",
    decision_bias: dict | None = None,
    knowledge_domains: list[str] | None = None,
) -> str:
    return create_custom_agent(
        user_id=user_id,
        display_name=display_name,
        role=role,
        persona=persona,
        decision_bias=decision_bias or {"caution": 0.7, "risk_tolerance": 0.2},
        knowledge_domains=knowledge_domains or ["economics", "politics"],
    )


# ── service tests ──────────────────────────────────────────────────────────


class TestExportPersona:
    def test_success_returns_portable_payload(self):
        identity_id = _seed_identity()

        payload = export_persona(identity_id, "owner")
        assert payload is not None
        assert payload["schema_version"] == SCHEMA_VERSION
        assert "exported_at" in payload
        persona = payload["persona"]
        assert persona["name"] == "Test Agent"
        assert persona["role"] == "analyst"
        # persona_text in DB is wrapped via format_untrusted_text_block
        assert "UNTRUSTED DATA" in persona["persona_text"]
        # decision_bias survives, 5-key shape backfilled by workshop validator
        assert persona["decision_bias"]["caution"] == 0.7
        assert persona["decision_bias"]["risk_tolerance"] == 0.2
        assert persona["tags"] == ["economics", "politics"]

        # internal fields must NOT leak.
        assert "id" not in persona
        assert "user_id" not in persona
        assert "continuity_key" not in persona
        assert "created_at" not in persona

    def test_not_owned_returns_none(self):
        identity_id = _seed_identity(user_id="alice")

        # Bob is not the owner — must look like a not-found.
        assert export_persona(identity_id, "bob") is None

    def test_not_found_returns_none(self):
        assert export_persona("missing-id", "owner") is None


class TestExportPersonasBulk:
    def test_filters_unowned(self):
        # Distinct roles avoid the (user_id, continuity_key) UniqueConstraint
        # collision when seeding two identities for the same user.
        a = _seed_identity(user_id="alice", display_name="A", role="role-a")
        _ = _seed_identity(user_id="bob", display_name="B", role="role-b")
        c = _seed_identity(user_id="alice", display_name="C", role="role-c")

        results = export_personas_bulk([a, "not-real", c], "alice")
        names = [r["persona"]["name"] for r in results]
        assert sorted(names) == ["A", "C"]

    def test_max_20_limit(self):
        with pytest.raises(ValueError, match="at most 20"):
            export_personas_bulk(
                [f"ident-{i}" for i in range(MAX_BULK_EXPORT + 1)],
                "owner",
            )


class TestImportPersona:
    def _payload(self, **overrides):
        persona = {
            "name": "Imported",
            "role": "strategist",
            "persona_text": "Patient and curious",
            "decision_bias": {"caution": 0.6, "optimism": 0.4},
            "tags": ["economics"],
        }
        persona.update(overrides.pop("persona_overrides", {}))
        out = {
            "schema_version": SCHEMA_VERSION,
            "exported_at": "2026-05-11T00:00:00+00:00",
            "persona": persona,
        }
        out.update(overrides)
        return out

    def test_success_creates_owned_identity(self):
        identity = import_persona(self._payload(), "newowner")
        assert identity is not None
        assert identity.user_id == "newowner"
        assert identity.kind == "custom"
        assert identity.display_name == "Imported"
        assert identity.role == "strategist"
        # decision_bias normalized via workshop validator → 5 keys.
        bias = json.loads(identity.decision_bias_json or "{}")
        assert set(bias.keys()) >= {
            "caution", "optimism", "conservatism", "risk_tolerance", "creativity",
        }
        assert bias["caution"] == 0.6
        assert json.loads(identity.knowledge_domain_json or "[]") == ["economics"]

    def test_invalid_schema_version_returns_none(self):
        assert import_persona(self._payload(schema_version=2), "u") is None

    def test_missing_persona_block_returns_none(self):
        assert import_persona({"schema_version": SCHEMA_VERSION}, "u") is None

    def test_missing_required_fields_returns_none(self):
        # Missing role.
        bad = self._payload(persona_overrides={"role": ""})
        assert import_persona(bad, "u") is None

    def test_clamps_out_of_range_decision_bias(self):
        bad_bias = {
            "caution": 5.0,
            "optimism": -1.0,
            "creativity": "not-a-number",
            "risk_tolerance": True,
        }
        identity = import_persona(
            self._payload(persona_overrides={"decision_bias": bad_bias}),
            "u",
        )
        assert identity is not None
        bias = json.loads(identity.decision_bias_json or "{}")
        assert bias["caution"] == 1.0
        assert bias["optimism"] == 0.0
        # non-numeric / bool → 0.5 default
        assert bias["creativity"] == 0.5
        assert bias["risk_tolerance"] == 0.5

    def test_truncates_overlong_text(self):
        long_persona = "x" * 5000
        long_role = "r" * 500
        long_name = "n" * 500
        identity = import_persona(
            self._payload(
                persona_overrides={
                    "name": long_name,
                    "role": long_role,
                    "persona_text": long_persona,
                },
            ),
            "u",
        )
        assert identity is not None
        # name + role are truncated by import; persona_text gets re-wrapped via
        # format_untrusted_text_block (max_chars=2000) inside create_custom_agent.
        assert len(identity.display_name) <= 100
        assert len(identity.role) <= 200
        # The wrapped block must still fit within ~2000 chars + a fixed wrapper.
        assert identity.persona is not None
        # Inner sanitized text should be at most 2000 chars (wrapper adds ~50).
        assert len(identity.persona) <= 2200

    def test_drops_tags_outside_allow_list(self):
        identity = import_persona(
            self._payload(
                persona_overrides={"tags": ["economics", "astrology", "politics"]},
            ),
            "u",
        )
        assert identity is not None
        assert json.loads(identity.knowledge_domain_json or "[]") == [
            "economics", "politics",
        ]

    def test_round_trip_preserves_core_fields(self):
        original_id = _seed_identity(user_id="alice", display_name="RoundTrip")
        payload = export_persona(original_id, "alice")
        assert payload is not None

        imported = import_persona(payload, "bob")
        assert imported is not None
        assert imported.user_id == "bob"
        assert imported.display_name == "RoundTrip"

        # Re-imported identity is a NEW row with a fresh id.
        with Session(get_engine()) as session:
            assert imported.id != original_id
            still_owned_by_alice = session.get(AgentIdentity, original_id)
            assert still_owned_by_alice is not None
            assert still_owned_by_alice.user_id == "alice"


class TestValidateImportPayload:
    def test_valid_payload(self):
        ok, err = validate_import_payload({
            "schema_version": SCHEMA_VERSION,
            "persona": {
                "name": "ok",
                "role": "ok",
                "persona_text": "",
                "decision_bias": {},
                "tags": [],
            },
        })
        assert ok is True
        assert err == ""

    def test_invalid_top_level_type(self):
        ok, err = validate_import_payload("not-a-dict")
        assert ok is False
        assert "object" in err

    def test_invalid_schema_version(self):
        ok, err = validate_import_payload({
            "schema_version": 99,
            "persona": {"name": "x", "role": "x"},
        })
        assert ok is False
        assert "schema_version" in err

    def test_missing_required_persona_field(self):
        ok, err = validate_import_payload({
            "schema_version": SCHEMA_VERSION,
            "persona": {"name": "x"},
        })
        assert ok is False
        assert "role" in err


# ── API tests ──────────────────────────────────────────────────────────────


class TestPersonaExportAPI:
    async def test_get_export_with_feature_disabled_returns_404(
        self, client: AsyncClient,
    ):
        identity_id = _seed_identity()
        settings.FEATURE_PERSONA_EXPORT = False
        try:
            resp = await client.get(
                f"/api/agents/identities/{identity_id}/export",
                params={"user_id": "owner"},
            )
            assert resp.status_code == 404
            body = resp.json()
            detail = body.get("detail")
            if isinstance(detail, dict):
                assert detail.get("code") == "FEATURE_DISABLED"
        finally:
            settings.FEATURE_PERSONA_EXPORT = True

    async def test_post_import_with_feature_disabled_returns_404(
        self, client: AsyncClient,
    ):
        settings.FEATURE_PERSONA_EXPORT = False
        try:
            resp = await client.post(
                "/api/agents/import",
                params={"user_id": "u"},
                json={
                    "schema_version": SCHEMA_VERSION,
                    "persona": {
                        "name": "x", "role": "y", "persona_text": "",
                        "decision_bias": {}, "tags": [],
                    },
                },
            )
            assert resp.status_code == 404
        finally:
            settings.FEATURE_PERSONA_EXPORT = True

    async def test_post_import_valid_payload_returns_201(
        self, client: AsyncClient,
    ):
        resp = await client.post(
            "/api/agents/import",
            params={"user_id": "newuser"},
            json={
                "schema_version": SCHEMA_VERSION,
                "exported_at": "2026-05-11T00:00:00+00:00",
                "persona": {
                    "name": "Imported via API",
                    "role": "strategist",
                    "persona_text": "Calm",
                    "decision_bias": {"caution": 0.8},
                    "tags": ["economics"],
                },
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["success"] is True
        assert body["identity_id"]

        with Session(get_engine()) as session:
            row = session.get(AgentIdentity, body["identity_id"])
            assert row is not None
            assert row.user_id == "newuser"
            assert row.display_name == "Imported via API"

    async def test_get_export_round_trip(self, client: AsyncClient):
        identity_id = _seed_identity(user_id="rt")
        resp = await client.get(
            f"/api/agents/identities/{identity_id}/export",
            params={"user_id": "rt"},
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["schema_version"] == SCHEMA_VERSION
        assert payload["persona"]["name"] == "Test Agent"

    async def test_get_export_not_owned_returns_404(self, client: AsyncClient):
        identity_id = _seed_identity(user_id="alice")
        resp = await client.get(
            f"/api/agents/identities/{identity_id}/export",
            params={"user_id": "bob"},
        )
        assert resp.status_code == 404

    async def test_post_export_bulk_max_limit(self, client: AsyncClient):
        too_many = [f"id-{i}" for i in range(MAX_BULK_EXPORT + 1)]
        resp = await client.post(
            "/api/agents/export-bulk",
            params={"user_id": "u"},
            json={"identity_ids": too_many},
        )
        assert resp.status_code == 422
        body = resp.json()
        detail = body.get("detail")
        if isinstance(detail, dict):
            assert detail.get("code") == "BULK_EXPORT_LIMIT_EXCEEDED"

    async def test_post_export_bulk_filters_unowned(self, client: AsyncClient):
        a = _seed_identity(user_id="alice", display_name="A", role="role-a")
        b = _seed_identity(user_id="bob", display_name="B", role="role-b")
        resp = await client.post(
            "/api/agents/export-bulk",
            params={"user_id": "alice"},
            json={"identity_ids": [a, b]},
        )
        assert resp.status_code == 200
        payload = resp.json()
        names = [p["persona"]["name"] for p in payload["personas"]]
        assert names == ["A"]

    async def test_post_import_invalid_payload_returns_422(
        self, client: AsyncClient,
    ):
        resp = await client.post(
            "/api/agents/import",
            params={"user_id": "u"},
            json={
                "schema_version": 999,
                "persona": {"name": "x", "role": "x"},
            },
        )
        assert resp.status_code == 422
