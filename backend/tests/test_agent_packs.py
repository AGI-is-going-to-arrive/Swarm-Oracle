"""Agent Pack v1 service and API contracts."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import Session, select

import app.api.agents as agents_api
import app.services.agent_packs as agent_packs_service
import app.services.persona_workshop as persona_workshop_service
from app.config import settings
from app.main import app
from app.models.agent_identity import AgentIdentity, AgentIdentityCampaign
from app.models.database import get_engine
from app.services.agent_identity import build_continuity_key
from app.services.agent_packs import (
    AGENT_PACK_MAX_BYTES,
    AgentPackServiceError,
    export_agent_pack,
    import_agent_pack,
    parse_agent_pack_bytes,
)


def _seed_identity(
    user_id: str,
    *,
    identity_id: str,
    name: str,
    role: str,
    persona: str = "",
    decision_bias: dict[str, float] | None = None,
    tags: list[str] | None = None,
    continuity_key: str | None = None,
) -> str:
    identity = AgentIdentity(
        id=identity_id,
        user_id=user_id,
        kind="custom",
        display_name=name,
        role=role,
        persona=persona or None,
        decision_bias_json=(
            json.dumps(decision_bias) if decision_bias is not None else None
        ),
        knowledge_domain_json=json.dumps(tags) if tags is not None else None,
        continuity_key=continuity_key or f"key-{identity_id}",
    )
    with Session(get_engine()) as session:
        session.add(identity)
        session.commit()
    return identity_id


def _valid_pack(*, count: int = 1) -> dict[str, Any]:
    return {
        "format": "swarmoracle.agent_pack",
        "schema_version": 1,
        "exported_at": "2026-07-12T01:02:03Z",
        "title": "Research team",
        "agents": [
            {
                "name": f"Agent {index}",
                "role": f"Role {index}",
                "persona_text": f"Persona {index}",
                "decision_bias": {
                    "caution": 0.5,
                    "optimism": 0.5,
                    "conservatism": 0.5,
                    "risk_tolerance": 0.5,
                    "creativity": 0.5,
                },
                "tags": ["science"],
            }
            for index in range(count)
        ],
    }


def _raw_pack(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _signed_token(secret: str, subject: str) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": subject}, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    signature = hmac.new(
        secret.encode(),
        f"v1.{payload}".encode(),
        hashlib.sha256,
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return f"v1.{payload}.{encoded_signature}"


@pytest.fixture(autouse=True)
def _agent_pack_features(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PERSONA_EXPORT", True)
    monkeypatch.setattr(settings, "FEATURE_CUSTOM_AGENTS", True)
    monkeypatch.setattr(settings, "SESSION_SECRET", "")


@pytest.fixture
def client(monkeypatch) -> TestClient:
    def close_background(coro):
        coro.close()
        return None

    monkeypatch.setattr(agents_api, "schedule_background_task", close_background, raising=False)
    return TestClient(app)


class TestAgentPackExport:
    def test_export_preserves_requested_order_and_exact_schema(self):
        owner = "pack-export-owner"
        _seed_identity(
            owner,
            identity_id="identity-a",
            name="Ada",
            role="Forecaster",
            persona="Careful and concise.",
            decision_bias={"caution": 0.8},
            tags=["science"],
        )
        _seed_identity(
            owner,
            identity_id="identity-b",
            name="Grace",
            role="Risk analyst",
            tags=["technology", "law"],
        )

        result = export_agent_pack(
            user_id=owner,
            title="  Research team  ",
            identity_ids=["identity-b", "identity-a"],
        )

        assert set(result) == {
            "format",
            "schema_version",
            "exported_at",
            "title",
            "agents",
        }
        assert result["format"] == "swarmoracle.agent_pack"
        assert result["schema_version"] == 1
        assert result["title"] == "Research team"
        exported_at = datetime.fromisoformat(result["exported_at"].replace("Z", "+00:00"))
        assert exported_at.tzinfo is not None
        assert [agent["name"] for agent in result["agents"]] == ["Grace", "Ada"]
        assert all(
            set(agent) == {
                "name",
                "role",
                "persona_text",
                "decision_bias",
                "tags",
            }
            for agent in result["agents"]
        )
        assert result["agents"][0]["decision_bias"] == {
            "caution": 0.5,
            "optimism": 0.5,
            "conservatism": 0.5,
            "risk_tolerance": 0.5,
            "creativity": 0.5,
        }
        assert result["agents"][1]["decision_bias"]["caution"] == 0.8
        assert result["agents"][1]["decision_bias"]["optimism"] == 0.5

    @pytest.mark.parametrize("count", [1, 20])
    def test_export_accepts_agent_count_boundaries(self, count: int):
        owner = f"pack-export-boundary-{count}"
        ids = [
            _seed_identity(
                owner,
                identity_id=f"identity-{index}",
                name=f"Agent {index}",
                role=f"Role {index}",
            )
            for index in range(count)
        ]

        result = export_agent_pack(user_id=owner, title="Boundary", identity_ids=ids)

        assert len(result["agents"]) == count

    @pytest.mark.parametrize("identity_ids", [[], ["same", "same"], [str(i) for i in range(21)]])
    def test_export_rejects_invalid_identity_id_lists(self, identity_ids: list[str]):
        with pytest.raises(AgentPackServiceError) as error:
            export_agent_pack(
                user_id="pack-export-invalid",
                title="Invalid",
                identity_ids=identity_ids,
            )

        assert error.value.status_code == 422
        assert error.value.code == "AGENT_PACK_INVALID"

    @pytest.mark.parametrize("member_kind", ["missing", "foreign"])
    def test_export_missing_or_foreign_member_fails_whole_pack(self, member_kind: str):
        owner = f"pack-export-{member_kind}"
        owned_id = _seed_identity(
            owner,
            identity_id=f"owned-{member_kind}",
            name="Owned",
            role="Owner role",
        )
        denied_id = f"denied-{member_kind}"
        if member_kind == "foreign":
            _seed_identity(
                "other-owner",
                identity_id=denied_id,
                name="Foreign secret name",
                role="Foreign secret role",
            )

        with pytest.raises(AgentPackServiceError) as error:
            export_agent_pack(
                user_id=owner,
                title="No partial export",
                identity_ids=[owned_id, denied_id],
            )

        assert error.value.status_code == 404
        assert error.value.code == "AGENT_PACK_MEMBER_NOT_FOUND"
        assert denied_id not in str(error.value)

    def test_export_omits_owner_ids_continuity_and_structured_secrets(self):
        owner = "pack-secret-owner"
        identity_id = _seed_identity(
            owner,
            identity_id="pack-secret-identity",
            name="Public name",
            role="Public role",
            continuity_key="continuity-secret-value",
        )

        result = export_agent_pack(
            user_id=owner,
            title="Safe export",
            identity_ids=[identity_id],
        )
        encoded = json.dumps(result)

        for secret in (owner, identity_id, "continuity-secret-value", "user_id"):
            assert secret not in encoded

    def test_export_redacts_common_credentials_embedded_in_portable_text(self):
        owner = "pack-embedded-secret-owner"
        identity_id = _seed_identity(
            owner,
            identity_id="pack-embedded-secret-identity",
            name="Ada api_key=name-secret-123",
            role="Authorization: Bearer role-secret-456",
            persona=(
                "The bearer of bad news keeps natural prose. "
                "Provider sk-agent-secret-789 and "
                "https://example.test/v1?access_token=query-secret-321&model=local"
            ),
        )

        result = export_agent_pack(
            user_id=owner,
            title="Team OPENAI_API_KEY=title-secret-654",
            identity_ids=[identity_id],
        )
        encoded = json.dumps(result)

        for secret in (
            "name-secret-123",
            "role-secret-456",
            "sk-agent-secret-789",
            "query-secret-321",
            "title-secret-654",
        ):
            assert secret not in encoded
        assert "The bearer of bad news" in result["agents"][0]["persona_text"]
        assert "[redacted" in encoded.lower()


class TestAgentPackParsing:
    def test_parsing_normalizes_text_and_fills_missing_bias_keys(self):
        payload = _valid_pack()
        payload["title"] = "  Research team  "
        payload["agents"][0]["name"] = "  Ada  "
        payload["agents"][0]["role"] = "  Forecaster  "
        payload["agents"][0]["decision_bias"] = {"caution": 0.8}

        parsed = parse_agent_pack_bytes(_raw_pack(payload))

        assert parsed.title == "Research team"
        assert parsed.agents[0].name == "Ada"
        assert parsed.agents[0].role == "Forecaster"
        assert parsed.agents[0].decision_bias.model_dump() == {
            "caution": 0.8,
            "optimism": 0.5,
            "conservatism": 0.5,
            "risk_tolerance": 0.5,
            "creativity": 0.5,
        }

    @pytest.mark.parametrize(
        ("path", "value"),
        [
            (("format",), "other.pack"),
            (("schema_version",), 2),
            (("schema_version",), True),
            (("schema_version",), 1.0),
            (("exported_at",), "2026-07-12T01:02:03"),
            (("title",), ""),
            (("agents", 0, "name"), ""),
            (("agents", 0, "role"), ""),
            (("agents", 0, "persona_text"), "x" * 2001),
            (("agents", 0, "decision_bias", "caution"), True),
            (("agents", 0, "decision_bias", "caution"), "0.5"),
            (("agents", 0, "decision_bias", "caution"), float("nan")),
            (("agents", 0, "decision_bias", "caution"), 1.1),
            (("agents", 0, "tags"), ["science", "science"]),
            (("agents", 0, "tags"), ["unknown"]),
            (("agents", 0, "tags"), ["science"] * 16),
        ],
    )
    def test_rejects_invalid_fields(self, path: tuple[Any, ...], value: Any):
        payload = _valid_pack()
        target: Any = payload
        for segment in path[:-1]:
            target = target[segment]
        target[path[-1]] = value

        with pytest.raises(AgentPackServiceError) as error:
            parse_agent_pack_bytes(_raw_pack(payload))

        assert error.value.status_code == 422
        assert error.value.code == "AGENT_PACK_INVALID"

    @pytest.mark.parametrize("extra_path", ["root", "agent", "bias"])
    def test_rejects_extra_structured_fields(self, extra_path: str):
        payload = _valid_pack()
        if extra_path == "root":
            payload["user_id"] = "secret-owner"
        elif extra_path == "agent":
            payload["agents"][0]["continuity_key"] = "secret-key"
        else:
            payload["agents"][0]["decision_bias"]["api_key"] = "sk-secret"

        with pytest.raises(AgentPackServiceError) as error:
            parse_agent_pack_bytes(_raw_pack(payload))

        assert error.value.code == "AGENT_PACK_INVALID"

    @pytest.mark.parametrize("count", [0, 21])
    def test_rejects_invalid_pack_agent_counts(self, count: int):
        with pytest.raises(AgentPackServiceError) as error:
            parse_agent_pack_bytes(_raw_pack(_valid_pack(count=count)))

        assert error.value.code == "AGENT_PACK_INVALID"

    def test_rejects_oversized_invalid_utf8_and_invalid_json(self):
        probes = [
            (b"x" * (AGENT_PACK_MAX_BYTES + 1), 413, "AGENT_PACK_TOO_LARGE"),
            (b"\xff", 422, "AGENT_PACK_INVALID"),
            (b"{not-json", 422, "AGENT_PACK_INVALID"),
            (b"[" * 10_000 + b"0" + b"]" * 10_000, 422, "AGENT_PACK_INVALID"),
        ]

        for raw, status_code, code in probes:
            with pytest.raises(AgentPackServiceError) as error:
                parse_agent_pack_bytes(raw)
            assert error.value.status_code == status_code
            assert error.value.code == code

    def test_rejects_bias_integer_too_large_for_finite_float_conversion(self):
        raw = _raw_pack(_valid_pack()).replace(
            b'"caution": 0.5',
            b'"caution": ' + b"9" * 310,
        )

        with pytest.raises(AgentPackServiceError) as error:
            parse_agent_pack_bytes(raw)

        assert error.value.status_code == 422
        assert error.value.code == "AGENT_PACK_INVALID"


class TestAgentPackImport:
    @pytest.mark.parametrize("count", [2, 20])
    def test_import_is_one_transaction_and_returns_ordered_identities(
        self,
        count: int,
        monkeypatch,
    ):
        class TrackingSession(Session):
            commit_calls = 0
            flush_calls = 0

            def commit(self) -> None:
                type(self).commit_calls += 1
                super().commit()

            def flush(self, objects=None) -> None:
                type(self).flush_calls += 1
                super().flush(objects)

        session_ids: list[int] = []
        real_create = persona_workshop_service.create_custom_agent

        def tracked_create(*args, **kwargs):
            session_ids.append(id(kwargs["session"]))
            return real_create(*args, **kwargs)

        profile_calls: list[tuple] = []
        monkeypatch.setattr(agent_packs_service, "Session", TrackingSession)
        monkeypatch.setattr(agent_packs_service, "create_custom_agent", tracked_create)
        monkeypatch.setattr(
            persona_workshop_service,
            "store_identity_profile",
            lambda *args, **kwargs: profile_calls.append((args, kwargs)),
        )

        outcome = import_agent_pack(
            _raw_pack(_valid_pack(count=count)),
            user_id=f"pack-import-{count}",
        )

        assert outcome.response == {
            "success": True,
            "title": "Research team",
            "imported_count": count,
            "identities": [
                {
                    "slot_order": index,
                    "identity_id": outcome.response["identities"][index]["identity_id"],
                    "display_name": f"Agent {index}",
                    "role": f"Role {index}",
                }
                for index in range(count)
            ],
        }
        assert len(outcome.profiles) == count
        assert len(set(session_ids)) == 1
        assert TrackingSession.commit_calls == 1
        assert TrackingSession.flush_calls >= count
        assert profile_calls == []

        with Session(get_engine()) as session:
            identities = session.exec(
                select(AgentIdentity).where(
                    AgentIdentity.user_id == f"pack-import-{count}"
                )
            ).all()
            campaigns = session.exec(
                select(AgentIdentityCampaign).where(
                    AgentIdentityCampaign.user_id == f"pack-import-{count}"
                )
            ).all()
        assert len(identities) == count
        assert campaigns == []
        assert all(identity.kind == "custom" for identity in identities)
        assert all(identity.preferred_tier == "IMPORTANT" for identity in identities)
        assert all(
            set(json.loads(identity.decision_bias_json or "{}"))
            == {
                "caution",
                "optimism",
                "conservatism",
                "risk_tolerance",
                "creativity",
            }
            for identity in identities
        )

    def test_pack_duplicate_continuity_key_conflicts_before_writes(self):
        payload = _valid_pack(count=2)
        payload["agents"][1]["role"] = payload["agents"][0]["role"]
        payload["agents"][1]["persona_text"] = payload["agents"][0]["persona_text"]

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(payload), user_id="pack-duplicate-owner")

        assert error.value.status_code == 409
        assert error.value.code == "AGENT_PACK_CONFLICT"
        with Session(get_engine()) as session:
            assert session.exec(
                select(AgentIdentity).where(
                    AgentIdentity.user_id == "pack-duplicate-owner"
                )
            ).all() == []

    def test_existing_owner_continuity_conflict_has_zero_new_writes(self):
        payload = _valid_pack(count=2)
        conflict_agent = payload["agents"][1]
        _seed_identity(
            "pack-existing-owner",
            identity_id="existing-conflict",
            name="Existing",
            role=conflict_agent["role"],
            persona=conflict_agent["persona_text"],
            continuity_key=build_continuity_key(
                conflict_agent["role"],
                conflict_agent["persona_text"],
            ),
        )

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(payload), user_id="pack-existing-owner")

        assert error.value.status_code == 409
        assert error.value.code == "AGENT_PACK_CONFLICT"
        with Session(get_engine()) as session:
            identities = session.exec(
                select(AgentIdentity).where(
                    AgentIdentity.user_id == "pack-existing-owner"
                )
            ).all()
        assert [identity.id for identity in identities] == ["existing-conflict"]

    @pytest.mark.parametrize("legacy_version", ["pre_colon", "workshop"])
    def test_existing_owner_legacy_continuity_conflict_has_zero_new_writes(
        self,
        legacy_version: str,
    ):
        owner = "pack-existing-legacy-owner"
        payload = _valid_pack()
        agent = payload["agents"][0]
        if legacy_version == "pre_colon":
            legacy_raw = (
                agent["role"].lower().strip()
                + agent["persona_text"][:30].lower().strip()
            )
        else:
            legacy_raw = f"{agent['role']}:{agent['persona_text'][:30]}"
        _seed_identity(
            owner,
            identity_id="existing-legacy-conflict",
            name="Existing legacy identity",
            role=agent["role"],
            persona=agent["persona_text"],
            continuity_key=hashlib.sha256(legacy_raw.encode()).hexdigest()[:16],
        )

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(payload), user_id=owner)

        assert error.value.status_code == 409
        assert error.value.code == "AGENT_PACK_CONFLICT"
        with Session(get_engine()) as session:
            identities = session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == owner)
            ).all()
        assert [identity.id for identity in identities] == [
            "existing-legacy-conflict"
        ]

    def test_sanitized_persona_round_trip_conflicts_with_existing_identity(self):
        owner = "pack-sanitized-round-trip"
        payload = _valid_pack()
        payload["agents"][0]["persona_text"] = "prefix```\x01persona"
        first = import_agent_pack(_raw_pack(payload), user_id=owner)
        identity_id = first.response["identities"][0]["identity_id"]
        exported = export_agent_pack(
            user_id=owner,
            title="Round trip",
            identity_ids=[identity_id],
        )

        assert exported["agents"][0]["persona_text"] != payload["agents"][0][
            "persona_text"
        ]
        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(exported), user_id=owner)

        assert error.value.status_code == 409
        assert error.value.code == "AGENT_PACK_CONFLICT"
        with Session(get_engine()) as session:
            identities = session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == owner)
            ).all()
        assert len(identities) == 1

    def test_workshop_created_sanitized_persona_round_trip_conflicts(self):
        owner = "pack-workshop-created-sanitized-round-trip"
        raw_persona = "prefix```\x01persona"
        identity_id = persona_workshop_service.create_custom_agent(
            user_id=owner,
            display_name="Workshop Agent",
            role="analyst",
            persona=raw_persona,
            decision_bias=None,
            knowledge_domains=None,
        )
        with Session(get_engine()) as session:
            identity = session.get(AgentIdentity, identity_id)
            assert identity is not None
            assert identity.persona == "prefix` ` `persona"

        exported = export_agent_pack(
            user_id=owner,
            title="Workshop round trip",
            identity_ids=[identity_id],
        )

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(exported), user_id=owner)

        assert error.value.status_code == 409
        assert error.value.code == "AGENT_PACK_CONFLICT"
        with Session(get_engine()) as session:
            identities = session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == owner)
            ).all()
        assert len(identities) == 1

    def test_workshop_updated_sanitized_persona_round_trip_conflicts(self):
        owner = "pack-workshop-updated-sanitized-round-trip"
        identity_id = persona_workshop_service.create_custom_agent(
            user_id=owner,
            display_name="Workshop Agent",
            role="analyst",
            persona="Initial persona",
            decision_bias=None,
            knowledge_domains=None,
        )
        persona_workshop_service.update_custom_agent(
            identity_id,
            persona="prefix```\x01persona",
        )
        with Session(get_engine()) as session:
            identity = session.get(AgentIdentity, identity_id)
            assert identity is not None
            assert identity.persona == "prefix` ` `persona"

        exported = export_agent_pack(
            user_id=owner,
            title="Workshop update round trip",
            identity_ids=[identity_id],
        )

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(exported), user_id=owner)

        assert error.value.status_code == 409
        assert error.value.code == "AGENT_PACK_CONFLICT"
        with Session(get_engine()) as session:
            identities = session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == owner)
            ).all()
        assert len(identities) == 1

    def test_existing_workshop_raw_key_round_trip_conflicts(self):
        owner = "pack-existing-workshop-raw-key-round-trip"
        role = "analyst"
        raw_persona = "prefix```\x01persona"
        stored_persona = "prefix` ` `persona"
        identity_id = _seed_identity(
            owner,
            identity_id="existing-workshop-raw-key",
            name="Existing Workshop Agent",
            role=role,
            persona=stored_persona,
            continuity_key=build_continuity_key(role, raw_persona),
        )
        assert build_continuity_key(role, raw_persona) != build_continuity_key(
            role,
            stored_persona,
        )
        exported = export_agent_pack(
            user_id=owner,
            title="Existing workshop round trip",
            identity_ids=[identity_id],
        )

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(exported), user_id=owner)

        assert error.value.status_code == 409
        assert error.value.code == "AGENT_PACK_CONFLICT"
        with Session(get_engine()) as session:
            identities = session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == owner)
            ).all()
        assert [identity.id for identity in identities] == [identity_id]

    @pytest.mark.parametrize(
        ("failure", "expected_status", "expected_code"),
        [
            (
                IntegrityError("INSERT", {}, Exception("unique race")),
                409,
                "AGENT_PACK_CONFLICT",
            ),
            (
                OperationalError("INSERT", {}, Exception("database is locked")),
                503,
                "AGENT_PACK_IMPORT_UNAVAILABLE",
            ),
            (RuntimeError("unexpected write failure"), 500, "AGENT_PACK_IMPORT_FAILED"),
        ],
    )
    def test_second_flush_failure_rolls_back_whole_pack_and_maps_error(
        self,
        failure: Exception,
        expected_status: int,
        expected_code: str,
        monkeypatch,
    ):
        real_create = persona_workshop_service.create_custom_agent
        create_count = 0

        def fail_second_create(*args, **kwargs):
            nonlocal create_count
            create_count += 1
            if create_count == 2:
                raise failure
            return real_create(*args, **kwargs)

        monkeypatch.setattr(
            agent_packs_service,
            "create_custom_agent",
            fail_second_create,
        )

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(_raw_pack(_valid_pack(count=2)), user_id="pack-rollback")

        assert error.value.status_code == expected_status
        assert error.value.code == expected_code
        assert "unexpected write failure" not in str(error.value)
        with Session(get_engine()) as session:
            assert session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == "pack-rollback")
            ).all() == []

    def test_other_commit_failure_rolls_back_and_returns_generic_500(self, monkeypatch):
        class CommitFailureSession(Session):
            rollback_calls = 0

            def commit(self) -> None:
                raise RuntimeError("secret commit details")

            def rollback(self) -> None:
                type(self).rollback_calls += 1
                super().rollback()

        monkeypatch.setattr(agent_packs_service, "Session", CommitFailureSession)

        with pytest.raises(AgentPackServiceError) as error:
            import_agent_pack(
                _raw_pack(_valid_pack(count=2)),
                user_id="pack-commit-failure",
            )

        assert error.value.status_code == 500
        assert error.value.code == "AGENT_PACK_IMPORT_FAILED"
        assert "secret commit details" not in str(error.value)
        assert CommitFailureSession.rollback_calls == 1
        with Session(get_engine()) as session:
            assert session.exec(
                select(AgentIdentity).where(
                    AgentIdentity.user_id == "pack-commit-failure"
                )
            ).all() == []


class TestAgentPackApi:
    def test_export_and_import_endpoints_return_exact_contracts(self, client: TestClient):
        owner = "pack-api-owner"
        first_id = _seed_identity(
            owner,
            identity_id="pack-api-first",
            name="Ada",
            role="Forecaster",
            persona="Careful.",
        )
        second_id = _seed_identity(
            owner,
            identity_id="pack-api-second",
            name="Grace",
            role="Risk analyst",
            persona="Challenges assumptions.",
        )

        exported = client.post(
            f"/api/agents/packs/export?user_id={owner}",
            json={
                "title": "Research team",
                "identity_ids": [second_id, first_id],
            },
        )

        assert exported.status_code == 200
        pack = exported.json()
        assert set(pack) == {
            "format",
            "schema_version",
            "exported_at",
            "title",
            "agents",
        }
        assert [agent["name"] for agent in pack["agents"]] == ["Grace", "Ada"]

        imported = client.post(
            "/api/agents/packs/import?user_id=pack-api-importer",
            content=json.dumps(pack),
            headers={"Content-Type": "application/json"},
        )

        assert imported.status_code == 201
        body = imported.json()
        assert set(body) == {"success", "title", "imported_count", "identities"}
        assert body["success"] is True
        assert body["title"] == "Research team"
        assert body["imported_count"] == 2
        assert [item["slot_order"] for item in body["identities"]] == [0, 1]
        assert [item["display_name"] for item in body["identities"]] == ["Grace", "Ada"]
        assert all(
            set(item) == {"slot_order", "identity_id", "display_name", "role"}
            for item in body["identities"]
        )

    @pytest.mark.parametrize(
        ("disabled_feature", "path", "body"),
        [
            (
                "FEATURE_PERSONA_EXPORT",
                "/api/agents/packs/export?user_id=gate-owner",
                {"title": "Gate", "identity_ids": ["identity"]},
            ),
            (
                "FEATURE_CUSTOM_AGENTS",
                "/api/agents/packs/export?user_id=gate-owner",
                {"title": "Gate", "identity_ids": ["identity"]},
            ),
            (
                "FEATURE_PERSONA_EXPORT",
                "/api/agents/packs/import?user_id=gate-owner",
                _valid_pack(),
            ),
            (
                "FEATURE_CUSTOM_AGENTS",
                "/api/agents/packs/import?user_id=gate-owner",
                _valid_pack(),
            ),
        ],
    )
    def test_both_features_are_required(
        self,
        disabled_feature: str,
        path: str,
        body: dict[str, Any],
        client: TestClient,
        monkeypatch,
    ):
        monkeypatch.setattr(settings, disabled_feature, False)

        response = client.post(path, json=body)

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "FEATURE_DISABLED"

    @pytest.mark.parametrize("path", ["export", "import"])
    def test_missing_owner_is_rejected(self, path: str, client: TestClient):
        body: Any = (
            {"title": "Missing owner", "identity_ids": ["identity"]}
            if path == "export"
            else _valid_pack()
        )

        response = client.post(f"/api/agents/packs/{path}", json=body)

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "USER_ID_REQUIRED"

    @pytest.mark.parametrize("path", ["export", "import"])
    def test_signed_principal_query_mismatch_is_rejected(
        self,
        path: str,
        client: TestClient,
        monkeypatch,
    ):
        secret = "pack-auth-secret"
        monkeypatch.setattr(settings, "SESSION_SECRET", secret)
        body: Any = (
            {"title": "Mismatch", "identity_ids": ["identity"]}
            if path == "export"
            else _valid_pack()
        )

        response = client.post(
            f"/api/agents/packs/{path}?user_id=other-owner",
            json=body,
            headers={"X-Session-Token": _signed_token(secret, "signed-owner")},
        )

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_MISMATCH"

    def test_auth_enabled_requires_signed_principal(self, client: TestClient, monkeypatch):
        monkeypatch.setattr(settings, "SESSION_SECRET", "pack-auth-secret")

        response = client.post(
            "/api/agents/packs/import?user_id=owner",
            json=_valid_pack(),
            headers={"X-Session-Token": "pack-auth-secret"},
        )

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"

    def test_signed_principal_can_import_without_query_owner(
        self,
        client: TestClient,
        monkeypatch,
    ):
        secret = "pack-auth-secret"
        monkeypatch.setattr(settings, "SESSION_SECRET", secret)

        response = client.post(
            "/api/agents/packs/import",
            json=_valid_pack(),
            headers={"X-Session-Token": _signed_token(secret, "signed-owner")},
        )

        assert response.status_code == 201
        with Session(get_engine()) as session:
            imported = session.exec(
                select(AgentIdentity).where(AgentIdentity.user_id == "signed-owner")
            ).all()
        assert len(imported) == 1

    def test_import_accepts_exact_raw_byte_limit(self, client: TestClient):
        raw = _raw_pack(_valid_pack())
        raw += b" " * (AGENT_PACK_MAX_BYTES - len(raw))

        response = client.post(
            "/api/agents/packs/import?user_id=exact-limit-owner",
            content=raw,
            headers={"Content-Type": "application/json"},
        )

        assert len(raw) == AGENT_PACK_MAX_BYTES
        assert response.status_code == 201

    def test_import_stream_enforces_actual_bytes_not_content_length(self, client: TestClient):
        response = client.post(
            "/api/agents/packs/import?user_id=stream-owner",
            content=b"x" * (AGENT_PACK_MAX_BYTES + 1),
            headers={"Content-Type": "application/json", "Content-Length": "1"},
        )

        assert response.status_code == 413
        assert response.json()["detail"]["code"] == "AGENT_PACK_TOO_LARGE"

    def test_import_rejects_invalid_utf8_and_body_owner_field(self, client: TestClient):
        invalid_utf8 = client.post(
            "/api/agents/packs/import?user_id=utf8-owner",
            content=b"\xff",
            headers={"Content-Type": "application/json"},
        )
        with_owner = _valid_pack()
        with_owner["user_id"] = "body-owner"
        body_owner = client.post(
            "/api/agents/packs/import?user_id=query-owner",
            json=with_owner,
        )

        assert invalid_utf8.status_code == 422
        assert invalid_utf8.json()["detail"]["code"] == "AGENT_PACK_INVALID"
        assert body_owner.status_code == 422
        assert body_owner.json()["detail"]["code"] == "AGENT_PACK_INVALID"

    def test_import_uses_to_thread_and_schedules_profiles_after_commit(
        self,
        client: TestClient,
        monkeypatch,
    ):
        to_thread_calls: list[Any] = []
        scheduled_visibility: list[int] = []

        async def tracked_to_thread(func, *args, **kwargs):
            to_thread_calls.append(func)
            return func(*args, **kwargs)

        def assert_visible_then_close(coro):
            with Session(get_engine()) as session:
                scheduled_visibility.append(
                    len(
                        session.exec(
                            select(AgentIdentity).where(
                                AgentIdentity.user_id == "profile-owner"
                            )
                        ).all()
                    )
                )
            coro.close()
            return None

        monkeypatch.setattr(agents_api.asyncio, "to_thread", tracked_to_thread)
        monkeypatch.setattr(agents_api, "schedule_background_task", assert_visible_then_close)

        response = client.post(
            "/api/agents/packs/import?user_id=profile-owner",
            json=_valid_pack(count=2),
        )

        assert response.status_code == 201
        assert to_thread_calls == [agent_packs_service.import_agent_pack]
        assert scheduled_visibility == [2]

    def test_conflict_does_not_schedule_profiles(self, client: TestClient, monkeypatch):
        payload = _valid_pack(count=2)
        payload["agents"][1]["role"] = payload["agents"][0]["role"]
        payload["agents"][1]["persona_text"] = payload["agents"][0]["persona_text"]
        schedule_calls: list[Any] = []
        monkeypatch.setattr(
            agents_api,
            "schedule_background_task",
            lambda coro: schedule_calls.append(coro),
        )

        response = client.post(
            "/api/agents/packs/import?user_id=profile-conflict",
            json=payload,
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "AGENT_PACK_CONFLICT"
        assert schedule_calls == []

    def test_profile_schedule_failure_is_fail_soft(self, client: TestClient, monkeypatch):
        captured_coroutines: list[Any] = []

        def fail_schedule(coro):
            captured_coroutines.append(coro)
            raise RuntimeError("scheduler unavailable")

        monkeypatch.setattr(agents_api, "schedule_background_task", fail_schedule)

        response = client.post(
            "/api/agents/packs/import?user_id=profile-fail-soft",
            json=_valid_pack(),
        )

        assert response.status_code == 201
        assert len(captured_coroutines) == 1
        assert captured_coroutines[0].cr_frame is None
