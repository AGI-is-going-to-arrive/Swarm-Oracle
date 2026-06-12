"""Batch E Lane C8 backend contract tests."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models import Agent, Branch, BranchStatus, Prediction, Scenario, ScenarioStatus
from app.models.checkpoint import FactionEvent, FactionSnapshot
from app.models.database import get_engine


@pytest.fixture
def client():
    return TestClient(app)


def _seed_scenario(
    *,
    status: ScenarioStatus = ScenarioStatus.DONE,
    question: str = "What if Zheng He reached the Americas first?",
    parsed_context: dict | None = None,
    user_id: str | None = None,
) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question=question,
            status=status,
            parsed_context=parsed_context,
            user_id=user_id,
        )
        session.add(scenario)
        session.commit()
        return scenario.id


def _seed_branch(
    scenario_id: str,
    *,
    title: str = "Trade coalition holds",
    story: str = "Trade cities align behind the admiral.",
    insight: str = "Ports, not courts, decide the outcome.",
    probability: float = 0.7,
    status: BranchStatus = BranchStatus.COMPLETED,
) -> str:
    with Session(get_engine()) as session:
        branch = Branch(
            scenario_id=scenario_id,
            title=title,
            story=story,
            insight=insight,
            probability=probability,
            status=status,
            key_moments=json.dumps(["Harbor guilds coordinate supply lines"]),
        )
        session.add(branch)
        session.commit()
        return branch.id


def _seed_agent(scenario_id: str, *, name: str = "Harbor Envoy") -> str:
    with Session(get_engine()) as session:
        agent = Agent(
            scenario_id=scenario_id,
            name=name,
            role="Envoy",
            persona="visible persona should not be exported raw",
            stance="coalition",
            agent_identity_id="identity-hidden",
        )
        session.add(agent)
        session.commit()
        return agent.id


def test_multi_run_start_clamps_count_and_marks_group(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_MULTI_RUN", True, raising=False)
    monkeypatch.setattr(settings, "MULTI_RUN_MAX_COUNT", 3, raising=False)
    scheduled: list[object] = []

    monkeypatch.setattr(
        "app.api.scenarios.schedule_background_task",
        lambda coro: scheduled.append(coro),
    )

    resp = client.post(
        "/api/scenario/multi-run",
        json={
            "question": "What if Zheng He reached the Americas first?",
            "run_count": 99,
            "num_agents": 3,
            "rounds": 1,
            "verdict_only_runs": True,
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["requested_run_count"] == 99
    assert data["accepted_run_count"] == 3
    assert data["run_group_id"]
    assert data["reminder"]["estimated_llm_call_count"] == "3 worldline runs"
    assert "token" not in json.dumps(data).lower()
    assert [run["run_index"] for run in data["runs"]] == [1, 2, 3]
    assert [run["verdict_only"] for run in data["runs"]] == [False, True, True]

    with Session(get_engine()) as session:
        rows = session.exec(text("SELECT run_group_id, parsed_context FROM scenario")).all()
        assert len(rows) == 3
        assert {row[0] for row in rows} == {data["run_group_id"]}
        contexts = [json.loads(row[1]) for row in rows]
        assert [ctx["multi_run"]["verdict_only"] for ctx in contexts] == [False, True, True]

    for coro in scheduled:
        coro.close()


def test_multi_run_lower_bound_clamps_to_one(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_MULTI_RUN", True, raising=False)
    scheduled: list[object] = []
    monkeypatch.setattr(
        "app.api.scenarios.schedule_background_task",
        lambda coro: scheduled.append(coro),
    )

    resp = client.post(
        "/api/scenario/multi-run",
        json={"question": "Will the route survive?", "run_count": 0, "num_agents": 3},
    )

    assert resp.status_code == 200
    assert resp.json()["accepted_run_count"] == 1
    for coro in scheduled:
        coro.close()


def test_multi_run_group_aggregation_counts_verdicts_and_outcomes(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_MULTI_RUN", True, raising=False)
    group_id = "group-c8"
    contexts = [
        {"result_quality": {"verdict": "Likely succeeds", "confidence": "high"}},
        {"result_quality": {"verdict": "Likely succeeds", "confidence": "medium"}},
        {"result_quality": {"verdict": "Likely stalls", "confidence": "low"}},
    ]
    for index, context in enumerate(contexts, start=1):
        scenario_id = _seed_scenario(parsed_context=context)
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            scenario.run_group_id = group_id
            session.add(scenario)
            session.add(
                Branch(
                    scenario_id=scenario_id,
                    title="Harbor pact" if index < 3 else "Court blockade",
                    probability=0.8,
                    status=BranchStatus.COMPLETED,
                    insight="outcome",
                )
            )
            session.commit()

    resp = client.get(f"/api/scenario/run-groups/{group_id}")

    assert resp.status_code == 200
    data = resp.json()
    assert data["run_group_id"] == group_id
    assert data["run_count"] == 3
    assert data["histogram"]["verdict_counts"] == {
        "Likely succeeds": 2,
        "Likely stalls": 1,
    }
    assert data["histogram"]["outcome_counts"] == {
        "Harbor pact": 2,
        "Court blockade": 1,
    }
    assert "probability" not in data["histogram"]


@pytest.mark.asyncio
async def test_verdict_only_run_skips_narrative_and_persists_fail_soft_verdict(monkeypatch):
    from app.services import simulator as simulator_module

    engine = get_engine()
    scenario_id = _seed_scenario(
        status=ScenarioStatus.SIMULATING,
        parsed_context={"multi_run": {"verdict_only": True}},
    )
    _seed_branch(
        scenario_id,
        title="Trade coalition holds",
        story="Existing story remains.",
        insight="Existing insight remains.",
    )

    async def fail_narration(*_args, **_kwargs):
        raise AssertionError("verdict-only runs must skip narrative pass")

    async def fake_verdict(*_args, **_kwargs):
        return {
            "verdict": "The route probably survives.",
            "confidence": "medium",
            "question_answer": "It survives with constraints.",
        }

    monkeypatch.setattr(simulator_module, "_narrate_branch_data", fail_narration)
    monkeypatch.setattr(simulator_module, "_generate_verdict", fake_verdict)
    monkeypatch.setattr(simulator_module, "_maybe_build_result_report", AsyncMock(), raising=False)

    await simulator_module.run_simulation(scenario_id, ws_callback=None)

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario.status == ScenarioStatus.DONE
        assert (
            scenario.parsed_context["result_quality"]["verdict"]
            == "The route probably survives."
        )


def test_you_vs_oracle_prediction_lock_rejects_second_write(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", True, raising=False)
    scenario_id = _seed_scenario(status=ScenarioStatus.SIMULATING)

    first = client.post(
        f"/api/scenario/{scenario_id}/predict",
        json={
            "prediction_text": "The route succeeds",
            "confidence": 0.75,
            "user_id": "oracle-user",
            "user_name": "Oracle User",
        },
    )
    second = client.post(
        f"/api/scenario/{scenario_id}/predict",
        json={
            "prediction_text": "The route fails",
            "confidence": 0.25,
            "user_id": "oracle-user",
            "user_name": "Oracle User",
        },
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "PREDICTION_ALREADY_SUBMITTED"
    with Session(get_engine()) as session:
        rows = session.exec(text("SELECT confidence FROM prediction")).all()
        assert rows == [(0.75,)]


@pytest.mark.parametrize(
    ("probability", "actual", "expected"),
    [
        (0.0, False, 0.0),
        (0.0, True, 1.0),
        (1.0, True, 0.0),
        (1.0, False, 1.0),
        (0.5, True, 0.25),
        (0.5, False, 0.25),
        (0.25, False, 0.0625),
        (0.25, True, 0.5625),
    ],
)
def test_you_vs_oracle_brier_truth_table(probability, actual, expected):
    from app.services.scoring import calculate_brier_score

    assert calculate_brier_score(probability, actual) == pytest.approx(expected)


def test_score_predictions_returns_brier_against_ai_verdict(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", True, raising=False)
    scenario_id = _seed_scenario(
        status=ScenarioStatus.DONE,
        parsed_context={
            "result_quality": {
                "verdict": "Yes, the route succeeds.",
                "question_answer": "Yes.",
                "confidence": "high",
            }
        },
    )
    _seed_branch(scenario_id)
    with Session(get_engine()) as session:
        session.add(
            Prediction(
                scenario_id=scenario_id,
                user_id="oracle-user",
                user_name="Oracle User",
                prediction_text="The route succeeds",
                confidence=0.75,
            )
        )
        session.commit()

    async def fake_score_prediction(prediction_id: str, *, llm_overrides=None):
        return {"score": 80, "reason": "directionally right"}

    monkeypatch.setattr("app.services.scoring.score_prediction", fake_score_prediction)

    resp = client.post(f"/api/scenario/{scenario_id}/score-predictions")

    assert resp.status_code == 200
    result = resp.json()["results"][0]
    assert result["you_vs_oracle"]["ai_actual_outcome"] is True
    assert result["you_vs_oracle"]["predicted_probability"] == 0.75
    assert result["you_vs_oracle"]["brier_score"] == pytest.approx(0.0625)


def test_you_vs_oracle_capability_disabled_closes_predict_endpoint(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", False, raising=False)
    scenario_id = _seed_scenario(status=ScenarioStatus.SIMULATING)

    resp = client.post(
        f"/api/scenario/{scenario_id}/predict",
        json={"prediction_text": "yes", "confidence": 0.5, "user_id": "u1"},
    )

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "FEATURE_DISABLED"


def test_social_headline_fallback_and_display_safe(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_scenario(
        parsed_context={
            "llm_api_key": "sk-hidden",
            "llm_base_url": "https://hidden.example/v1",
            "user_id": "owner-hidden",
            "full_report": {"sections": [{"body": "hidden report payload"}]},
        },
    )
    branch_id = _seed_branch(
        scenario_id,
        title="Harbor pact api_key=sk-branch-secret",
        story="Authorization: Bearer branch-token",
        insight="base_url=https://hidden.example/v1",
    )
    agent_id = _seed_agent(scenario_id)
    with Session(get_engine()) as session:
        session.add(
            FactionSnapshot(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=1,
                faction_key="pro-trade",
                label="Trade coalition token=hidden",
                stance_center=0.8,
                member_agent_ids_json=json.dumps([agent_id]),
                confidence=0.9,
            )
        )
        session.add(
            FactionEvent(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=1,
                event_type="alliance_formed",
                actor_agent_id=agent_id,
                faction_key="pro-trade",
                payload_json=json.dumps({"api_key": "sk-event-secret", "visible": "kept"}),
            )
        )
        session.commit()

    async def fail_llm(*_args, **_kwargs):
        raise RuntimeError("Authorization: Bearer sk-provider-secret")

    monkeypatch.setattr("app.api.social.llm_call", fail_llm, raising=False)

    resp = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert resp.status_code == 200
    data = resp.json()
    assert data["generation_mode"] == "deterministic"
    assert data["headline_cards"]
    assert data["events"]
    payload = json.dumps(data, ensure_ascii=False)
    for forbidden in (
        "sk-",
        "api_key",
        "base_url",
        "Authorization",
        "token",
        "owner_user_id",
        "user_id",
        "full_report",
        "hidden report payload",
        agent_id,
    ):
        assert forbidden not in payload


def test_social_headlines_capability_disabled(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", False, raising=False)
    scenario_id = _seed_scenario()

    resp = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "FEATURE_DISABLED"


def test_batch_e_c8_capabilities_registered(client):
    resp = client.get("/api/capabilities")

    assert resp.status_code == 200
    data = resp.json()
    assert data["multi_run"]["enabled"] is settings.FEATURE_MULTI_RUN
    assert data["you_vs_oracle"]["enabled"] is settings.FEATURE_YOU_VS_ORACLE
    assert data["social_headlines"]["enabled"] is settings.FEATURE_SOCIAL_HEADLINES


def test_033_run_group_id_column_and_index_present():
    inspector = inspect(get_engine())
    columns = {column["name"] for column in inspector.get_columns("scenario")}
    indexes = {index["name"] for index in inspector.get_indexes("scenario")}

    assert "run_group_id" in columns
    assert "ix_scenario_run_group_id" in indexes
