"""Tests for personality_drift service — Big Five drift detection."""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models.agent_identity import AgentGrowthEvent, AgentIdentity
from app.models.database import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.services.personality_drift import (
    BIG_FIVE_DIMENSIONS,
    detect_personality_drift,
)

# ── Helpers ────────────────────────────────────────────────


def _seed_scenario(*, user_id: str | None = None) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="drift test",
            status=ScenarioStatus.DONE,
            user_id=user_id,
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def _seed_agent(
    scenario_id: str,
    *,
    name: str = "Alice",
    role: str = "diplomat",
    persona: str = "calm and cooperative diplomat",
    tier: AgentTier = AgentTier.IMPORTANT,
    identity_id: str | None = None,
) -> str:
    with Session(get_engine()) as session:
        agent = Agent(
            scenario_id=scenario_id,
            name=name,
            role=role,
            persona=persona,
            tier=tier,
            agent_identity_id=identity_id,
        )
        session.add(agent)
        session.commit()
        session.refresh(agent)
        return agent.id


def _seed_branch_with_round(scenario_id: str, *, round_number: int = 1) -> tuple[str, str]:
    with Session(get_engine()) as session:
        branch = Branch(scenario_id=scenario_id, title="main")
        session.add(branch)
        session.commit()
        session.refresh(branch)
        round_obj = Round(branch_id=branch.id, round_number=round_number)
        session.add(round_obj)
        session.commit()
        session.refresh(round_obj)
        return branch.id, round_obj.id


def _seed_messages(
    round_id: str,
    agent_id: str,
    emotions: list[str],
) -> None:
    with Session(get_engine()) as session:
        for emotion in emotions:
            session.add(
                AgentMessage(
                    round_id=round_id,
                    agent_id=agent_id,
                    content=f"msg with {emotion}",
                    emotion=emotion,
                )
            )
        session.commit()


def _seed_identity(
    user_id: str,
    *,
    role: str = "diplomat",
    persona: str | None = None,
    decision_bias: dict | None = None,
    continuity_key: str | None = None,
) -> str:
    with Session(get_engine()) as session:
        identity = AgentIdentity(
            user_id=user_id,
            kind="generated",
            display_name="Alice",
            role=role,
            persona=persona,
            decision_bias_json=json.dumps(decision_bias) if decision_bias else None,
            continuity_key=continuity_key or f"key-{uuid.uuid4().hex[:8]}",
        )
        session.add(identity)
        session.commit()
        session.refresh(identity)
        return identity.id


def _seed_growth_event(
    identity_id: str,
    scenario_id: str,
    branch_id: str,
    *,
    event_type: str = "stance_shift",
    summary: str = "agent flipped position",
    round_number: int = 2,
) -> None:
    with Session(get_engine()) as session:
        session.add(
            AgentGrowthEvent(
                identity_id=identity_id,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=round_number,
                event_type=event_type,
                summary=summary,
            )
        )
        session.commit()


# ── Service tests ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_returns_empty_list_when_no_agents():
    scenario_id = _seed_scenario()
    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)
    assert result == []


@pytest.mark.asyncio
async def test_world_event_source_is_not_reported_as_personality_drift_agent():
    scenario_id = _seed_scenario()
    participant_id = _seed_agent(scenario_id, name="Participant")
    with Session(get_engine()) as session:
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Initial Feed Source",
                role="world_event_source",
                persona="System-provided initial world event feed",
                tier=AgentTier.CROWD,
                source_type="world_event_source",
            )
        )
        session.commit()

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    assert [row["agent_id"] for row in result] == [participant_id]


@pytest.mark.asyncio
async def test_uses_persona_inference_when_identity_missing():
    scenario_id = _seed_scenario()
    agent_id = _seed_agent(
        scenario_id,
        persona="calm and cooperative diplomat with empathetic style",
    )
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    _seed_messages(round_id, agent_id, ["neutral"] * 5)

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    assert len(result) == 1
    report = result[0]
    assert report["agent_id"] == agent_id
    assert report["agent_name"] == "Alice"
    # persona pushed agreeableness above neutral, neuroticism below
    initial_by_dim = {row["dimension"]: row["initial"] for row in report["drift_dimensions"]}
    assert initial_by_dim["agreeableness"] > 0.5
    assert initial_by_dim["neuroticism"] < 0.5
    # neutral-only emotions → small drift
    assert report["drift_score"] < 0.3
    assert report["severity"] == "low"


@pytest.mark.asyncio
async def test_decision_bias_json_overrides_persona_baseline():
    user_id = "user-1"
    scenario_id = _seed_scenario(user_id=user_id)
    identity_id = _seed_identity(
        user_id,
        decision_bias={
            "openness": 0.9,
            "conscientiousness": 0.85,
            "extraversion": 0.7,
            "agreeableness": 0.4,
            "neuroticism": 0.2,
        },
    )
    agent_id = _seed_agent(scenario_id, identity_id=identity_id)
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    _seed_messages(round_id, agent_id, ["neutral"])

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    initial = {row["dimension"]: row["initial"] for row in result[0]["drift_dimensions"]}
    assert initial["openness"] == pytest.approx(0.9)
    assert initial["agreeableness"] == pytest.approx(0.4)
    assert initial["neuroticism"] == pytest.approx(0.2)


@pytest.mark.asyncio
async def test_uniform_neutral_yields_low_drift_score():
    scenario_id = _seed_scenario()
    agent_id = _seed_agent(scenario_id, persona="balanced observer")
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    _seed_messages(round_id, agent_id, ["neutral"] * 10)

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    assert result[0]["drift_score"] < 0.2


@pytest.mark.asyncio
async def test_metadata_unavailable_is_not_counted_as_emotion_or_volatility():
    scenario_id = _seed_scenario()
    agent_id = _seed_agent(scenario_id, persona="balanced observer")
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    _seed_messages(
        round_id,
        agent_id,
        [
            "calm",
            "__swarmoracle_metadata_unavailable__:LLM_TIMEOUT",
            "calm",
        ],
    )

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    report = result[0]
    assert report["drift_score"] < 0.2
    assert "__swarmoracle_metadata_unavailable__" not in " ".join(report["evidence"])


@pytest.mark.asyncio
async def test_extreme_emotion_shift_yields_high_drift_score():
    user_id = "user-2"
    scenario_id = _seed_scenario(user_id=user_id)
    # Identity says agent should be cooperative + calm
    identity_id = _seed_identity(
        user_id,
        decision_bias={
            "agreeableness": 0.95,
            "neuroticism": 0.05,
            "extraversion": 0.5,
            "conscientiousness": 0.5,
            "openness": 0.5,
        },
    )
    agent_id = _seed_agent(scenario_id, identity_id=identity_id)
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    # All messages aggressive/angry → drift away from baseline
    _seed_messages(round_id, agent_id, ["aggressive", "angry", "hostile"] * 4)

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    report = result[0]
    assert report["drift_score"] > 0.3
    diffs = {row["dimension"]: row["delta"] for row in report["drift_dimensions"]}
    # agreeableness should drop, neuroticism should rise
    assert diffs["agreeableness"] < 0
    assert diffs["neuroticism"] > 0
    # dominant emotions should appear in evidence
    evidence_blob = " ".join(report["evidence"])
    assert "aggressive" in evidence_blob or "angry" in evidence_blob


@pytest.mark.asyncio
async def test_severity_thresholds_classify_correctly():
    # We exercise the public API by varying the gap between baseline and emotions.
    user_id = "user-3"
    scenario_id = _seed_scenario(user_id=user_id)
    identity_id = _seed_identity(
        user_id,
        decision_bias={
            "agreeableness": 0.95,
            "neuroticism": 0.05,
            "extraversion": 0.5,
            "conscientiousness": 0.5,
            "openness": 0.5,
        },
    )
    agent_id = _seed_agent(scenario_id, identity_id=identity_id)
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    # Saturate with the most disagreeable emotion to push into high band.
    _seed_messages(round_id, agent_id, ["angry"] * 20)

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    report = result[0]
    assert report["severity"] in {"medium", "high"}
    assert report["drift_score"] > 0.3


@pytest.mark.asyncio
async def test_growth_events_populate_evidence():
    user_id = "user-4"
    scenario_id = _seed_scenario(user_id=user_id)
    identity_id = _seed_identity(user_id, persona="diplomat")
    agent_id = _seed_agent(scenario_id, identity_id=identity_id)
    branch_id, round_id = _seed_branch_with_round(scenario_id)
    _seed_messages(round_id, agent_id, ["confident", "anxious"])
    _seed_growth_event(
        identity_id,
        scenario_id,
        branch_id,
        event_type="betrayal",
        summary="agent abandoned previous ally",
        round_number=3,
    )

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    evidence = result[0]["evidence"]
    assert any("betrayal" in line and "abandoned" in line for line in evidence)


@pytest.mark.asyncio
async def test_drift_dimensions_cover_all_big_five():
    scenario_id = _seed_scenario()
    agent_id = _seed_agent(scenario_id)
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    _seed_messages(round_id, agent_id, ["neutral"])

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    dims = {row["dimension"] for row in result[0]["drift_dimensions"]}
    assert dims == set(BIG_FIVE_DIMENSIONS)


@pytest.mark.asyncio
async def test_reports_sorted_by_drift_score_descending():
    user_id = "user-5"
    scenario_id = _seed_scenario(user_id=user_id)
    calm_identity = _seed_identity(
        user_id,
        decision_bias={dim: 0.5 for dim in BIG_FIVE_DIMENSIONS},
    )
    drifted_identity = _seed_identity(
        user_id,
        decision_bias={
            "agreeableness": 0.95,
            "neuroticism": 0.05,
            "extraversion": 0.5,
            "conscientiousness": 0.5,
            "openness": 0.5,
        },
    )
    calm_id = _seed_agent(
        scenario_id, name="Calm", identity_id=calm_identity, persona="balanced",
    )
    drifted_id = _seed_agent(
        scenario_id, name="Drifted", identity_id=drifted_identity, persona="balanced",
    )
    _branch_id, round_id = _seed_branch_with_round(scenario_id)
    _seed_messages(round_id, calm_id, ["neutral"] * 10)
    _seed_messages(round_id, drifted_id, ["aggressive", "angry"] * 5)

    with Session(get_engine()) as session:
        result = await detect_personality_drift(scenario_id, session)

    assert [r["agent_name"] for r in result] == ["Drifted", "Calm"]
    assert result[0]["drift_score"] >= result[1]["drift_score"]


# ── Endpoint tests ─────────────────────────────────────────


class TestPersonalityDriftEndpoint:
    @pytest.fixture(autouse=True)
    def _isolate_session(self, monkeypatch):
        monkeypatch.setattr(settings, "SESSION_SECRET", "")
        yield

    def test_feature_disabled_returns_404(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", False)
        scenario_id = _seed_scenario()

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/personality-drift"
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "FEATURE_DISABLED"

    def test_feature_enabled_returns_200(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", True)
        scenario_id = _seed_scenario()
        agent_id = _seed_agent(scenario_id, persona="calm cooperative scholar")
        _branch_id, round_id = _seed_branch_with_round(scenario_id)
        _seed_messages(round_id, agent_id, ["neutral", "calm"])

        response = TestClient(app).get(
            f"/api/scenario/{scenario_id}/personality-drift"
        )

        assert response.status_code == 200
        body = response.json()
        assert isinstance(body, list)
        assert len(body) == 1
        report = body[0]
        assert report["agent_id"] == agent_id
        assert report["severity"] in {"low", "medium", "high"}
        assert {row["dimension"] for row in report["drift_dimensions"]} == set(
            BIG_FIVE_DIMENSIONS
        )

    def test_unknown_scenario_returns_404(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_AGENT_IDENTITY", True)

        response = TestClient(app).get(
            "/api/scenario/missing-scenario/personality-drift"
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"
