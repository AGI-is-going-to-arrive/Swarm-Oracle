"""Public artifact schema and sanitizer tests."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session, select

from app.config import settings
from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.public_artifacts import (
    MAX_AGENT_NAME_CHARS,
    MAX_EXCERPT_CHARS,
    MAX_QUESTION_CHARS,
    MAX_TITLE_CHARS,
    MAX_TRANSCRIPT_EXCERPTS,
    PUBLIC_ARTIFACT_SCHEMA_VERSION,
    build_public_artifact_for_scenario,
    build_public_artifact_from_mapping,
    scan_public_artifact_for_secrets,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _make_signed_token(secret: str, subject: str) -> str:
    payload = _b64url(json.dumps({"sub": subject}).encode("utf-8"))
    signing_input = f"v1.{payload}".encode("ascii")
    signature = _b64url(
        hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest(),
    )
    return f"v1.{payload}.{signature}"


def _dirty_mapping() -> dict[str, Any]:
    return {
        "id": "scenario-internal-id",
        "question": "Will the solar compact hold?",
        "language": "en",
        "user_id": "owner-secret-id",
        "owner_user_id": "owner-secret-id",
        "persona": "persona-secret-value",
        "agent_identity_id": "identity-secret-value",
        "api_key": "sk-publicartifact-secret",
        "base_url": "https://user:pass@provider.example/v1",
        "token": "Bearer public-artifact-token",
        "raw_report": "raw-report-secret-value",
        "private_memory": "private-memory-secret-value",
        "parsed_context": {
            "_language": "en",
            "full_report": {"summary": "raw-report-secret-value"},
            "private_memory": "private-memory-secret-value",
            "result_quality": {
                "verdict": "The compact likely holds.",
                "confidence": "high",
                "branch_question_answers": {
                    "branch-secret-id": "It likely holds with rationing.",
                },
            },
        },
        "agents": [
            {
                "id": "agent-secret-id",
                "name": "Archivist",
                "role": "Recorder",
                "persona": "persona-secret-value",
                "agent_identity_id": "identity-secret-value",
            }
        ],
        "branches": [
            {
                "id": "branch-secret-id",
                "title": "Rationed grid",
                "probability": 0.72,
                "insight": "Storage discipline keeps the compact alive.",
                "story": "raw branch story should not be copied wholesale",
            }
        ],
        "messages": [
            {
                "id": "message-secret-id",
                "branch": "branch-secret-id",
                "branch_title": "Rationed grid",
                "round": 2,
                "agent": "Archivist",
                "agent_id": "agent-secret-id",
                "message": "Publicly safe transcript excerpt.",
            }
        ],
        "web_search_context": {
            "query": "private raw query should not survive",
            "provider": "tavily",
            "snippets": [
                {
                    "text": "Evidence",
                    "source_url": (
                        "https://news.example.com/path?api_key=sk-url-secret"
                    ),
                }
            ],
            "family_context": {
                "finance": {
                    "state": "ready",
                    "items": [
                        {
                            "url": "https://markets.example.org/a?token=leak",
                        }
                    ],
                }
            },
        },
    }


def _seed_public_scenario(*, user_id: str = "owner-a") -> str:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="Will the solar compact hold?",
            status=ScenarioStatus.DONE,
            parsed_context={"_language": "en"},
            user_id=user_id,
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)

        agent = Agent(
            scenario_id=scenario.id,
            name="Archivist",
            role="Recorder",
            persona="persona-secret-value",
            tier=AgentTier.IMPORTANT,
            agent_identity_id="identity-secret-value",
        )
        branch = Branch(
            scenario_id=scenario.id,
            title="Rationed grid",
            probability=0.72,
            status=BranchStatus.COMPLETED,
            insight="Storage discipline keeps the compact alive.",
            story="raw branch story should not be copied wholesale",
        )
        session.add(agent)
        session.add(branch)
        session.commit()
        session.refresh(agent)
        session.refresh(branch)

        round_row = Round(branch_id=branch.id, round_number=2)
        session.add(round_row)
        session.commit()
        session.refresh(round_row)
        session.add(
            AgentMessage(
                round_id=round_row.id,
                agent_id=agent.id,
                content="Publicly safe transcript excerpt.",
            ),
        )
        scenario.parsed_context = {
            "_language": "en",
            "full_report": {"summary": "raw-report-secret-value"},
            "private_memory": "private-memory-secret-value",
            "result_quality": {
                "verdict": "The compact likely holds.",
                "confidence": "high",
                "branch_question_answers": {
                    branch.id: "It likely holds with rationing.",
                },
            },
        }
        scenario.web_context_json = json.dumps(
            {
                "query": "solar compact private query",
                "provider": "tavily",
                "snippets": [
                    {
                        "text": "Evidence",
                        "source_url": (
                            "https://news.example.com/path?api_key=sk-url-secret"
                        ),
                    }
                ],
            },
        )
        session.add(scenario)
        session.commit()
        return scenario.id


def _serialized(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def test_sanitizer_whitelist_excludes_each_forbidden_field() -> None:
    artifact = build_public_artifact_from_mapping(_dirty_mapping())
    payload = _serialized(artifact)

    assert artifact["schema_version"] == PUBLIC_ARTIFACT_SCHEMA_VERSION
    assert set(artifact) == {
        "schema_version",
        "question",
        "language",
        "display_agent_names",
        "branch_verdicts",
        "probability_bars",
        "transcript_excerpts",
        "source_summary",
    }
    assert "persona-secret-value" not in payload
    assert "identity-secret-value" not in payload
    assert "sk-publicartifact-secret" not in payload
    assert "provider.example" not in payload
    assert "public-artifact-token" not in payload
    assert "owner-secret-id" not in payload
    assert "raw-report-secret-value" not in payload
    assert "private-memory-secret-value" not in payload
    assert "persona" not in payload
    assert "agent_identity_id" not in payload
    assert "api_key" not in payload
    assert "base_url" not in payload
    assert "token" not in payload
    assert "owner_user_id" not in payload
    assert "raw_report" not in payload
    assert "private_memory" not in payload


def test_source_summary_keeps_domains_without_raw_urls_or_queries() -> None:
    artifact = build_public_artifact_from_mapping(_dirty_mapping())
    payload = _serialized(artifact)

    domains = {
        item["domain"]
        for item in artifact["source_summary"]["domains"]
    }
    assert domains == {"markets.example.org", "news.example.com"}
    assert "https://" not in payload
    assert "/path" not in payload
    assert "sk-url-secret" not in payload
    assert "token=leak" not in payload


def test_public_artifact_roundtrips_as_stable_json() -> None:
    artifact = build_public_artifact_from_mapping(_dirty_mapping())
    encoded = json.dumps(artifact, ensure_ascii=False, sort_keys=True)

    decoded = json.loads(encoded)

    assert decoded == artifact
    assert decoded["branch_verdicts"][0] == {
        "branch_index": 1,
        "title": "Rationed grid",
        "verdict": "It likely holds with rationing.",
        "confidence": "high",
    }
    assert decoded["probability_bars"][0] == {
        "branch_index": 1,
        "label": "Rationed grid",
        "probability": 0.72,
    }


def test_public_artifact_truncates_field_budgets() -> None:
    dirty = _dirty_mapping()
    dirty["question"] = "Q" * (MAX_QUESTION_CHARS + 50)
    dirty["agents"][0]["name"] = "A" * (MAX_AGENT_NAME_CHARS + 50)
    dirty["branches"][0]["title"] = "T" * (MAX_TITLE_CHARS + 50)
    dirty["messages"][0]["message"] = "M" * (MAX_EXCERPT_CHARS + 50)

    artifact = build_public_artifact_from_mapping(dirty)

    assert len(artifact["question"]) == MAX_QUESTION_CHARS
    assert len(artifact["display_agent_names"][0]) == MAX_AGENT_NAME_CHARS
    assert len(artifact["branch_verdicts"][0]["title"]) == MAX_TITLE_CHARS
    assert len(artifact["transcript_excerpts"][0]["excerpt"]) == MAX_EXCERPT_CHARS


def test_database_transcript_query_is_bounded() -> None:
    scenario_id = _seed_public_scenario()
    engine = get_engine()
    with Session(engine) as session:
        branch = session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).first()
        agent = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).first()
        assert branch is not None
        assert agent is not None
        for index in range(MAX_TRANSCRIPT_EXCERPTS + 5):
            round_row = Round(branch_id=branch.id, round_number=index + 10)
            session.add(round_row)
            session.commit()
            session.refresh(round_row)
            session.add(
                AgentMessage(
                    round_id=round_row.id,
                    agent_id=agent.id,
                    content=f"bounded excerpt {index}",
                ),
            )
        session.commit()

    statements: list[str] = []

    def capture_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
        if "agent_message" in statement.lower():
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture_statement)
    try:
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            artifact = build_public_artifact_for_scenario(session, scenario)
    finally:
        event.remove(engine, "before_cursor_execute", capture_statement)

    assert len(artifact["transcript_excerpts"]) == MAX_TRANSCRIPT_EXCERPTS
    assert any(" limit " in f" {statement.lower()} " for statement in statements), statements


def test_secret_scan_rejects_secret_shaped_allowed_text() -> None:
    artifact = build_public_artifact_from_mapping(_dirty_mapping())
    artifact["question"] = "Leaked sk-publicartifact-secret"

    with pytest.raises(ValueError, match="sensitive"):
        scan_public_artifact_for_secrets(artifact)


def test_endpoint_returns_public_artifact_for_signed_owner(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "public-artifact-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    monkeypatch.setattr(settings, "FEATURE_PUBLIC_ARTIFACTS", True)
    scenario_id = _seed_public_scenario(user_id="owner-a")

    response = client.post(
        f"/api/scenario/{scenario_id}/public-artifact",
        headers={"X-Session-Token": _make_signed_token(secret, "owner-a")},
    )

    assert response.status_code == 200, response.text
    artifact = response.json()
    payload = _serialized(artifact)
    assert artifact["schema_version"] == PUBLIC_ARTIFACT_SCHEMA_VERSION
    assert artifact["question"] == "Will the solar compact hold?"
    assert artifact["language"] == "en"
    assert artifact["display_agent_names"] == ["Archivist"]
    assert artifact["branch_verdicts"][0]["verdict"] == (
        "It likely holds with rationing."
    )
    assert "persona-secret-value" not in payload
    assert "identity-secret-value" not in payload
    assert "raw-report-secret-value" not in payload
    assert "private-memory-secret-value" not in payload


def test_endpoint_rejects_cross_owner_when_auth_enabled(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "public-artifact-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    monkeypatch.setattr(settings, "FEATURE_PUBLIC_ARTIFACTS", True)
    scenario_id = _seed_public_scenario(user_id="owner-a")

    response = client.post(
        f"/api/scenario/{scenario_id}/public-artifact",
        headers={"X-Session-Token": _make_signed_token(secret, "owner-b")},
    )

    assert response.status_code == 404
    assert response.json().get("detail", {}).get("code") == "SCENARIO_NOT_FOUND"


def test_endpoint_respects_public_artifacts_feature_gate(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "FEATURE_PUBLIC_ARTIFACTS", False)

    response = client.post("/api/scenario/fake-id/public-artifact")

    assert response.status_code == 404
    assert response.json().get("detail", {}).get("code") == "FEATURE_DISABLED"
