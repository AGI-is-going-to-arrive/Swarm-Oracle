"""Focused tests for gameplay-card intervention queue behavior."""

import json

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.main import app
from app.models import (
    Branch,
    BranchStatus,
    InterventionLog,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine


def _seed_scenario(
    engine,
    *,
    question: str = "如果算法治理城市？",
    language: str | None = None,
) -> str:
    parsed_context = {"_language": language} if language else None
    scenario = Scenario(
        question=question,
        parsed_context=parsed_context,
        status=ScenarioStatus.SIMULATING,
    )
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        return scenario.id


def _seed_branch(engine, scenario_id: str, *, title: str = "算法登基") -> str:
    branch = Branch(
        scenario_id=scenario_id,
        title=title,
        probability=1.0,
        status=BranchStatus.ACTIVE,
    )
    with Session(engine) as session:
        session.add(branch)
        session.commit()
        return branch.id


def _seed_round(engine, branch_id: str, round_number: int = 1) -> None:
    with Session(engine) as session:
        session.add(Round(branch_id=branch_id, round_number=round_number))
        session.commit()


def test_card_intervention_queues_backend_canonical_prompt():
    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_id = _seed_branch(engine, scenario_id)
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene",
        json={
            "branch_id": branch_id,
            "text": "请强推公开解释义务",
            "card_id": "human_takeover",
            "profile_id": "governance",
        },
    )

    assert response.status_code == 200
    with Session(engine) as session:
        queued = session.exec(
            select(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        ).one()

    assert "玩法卡：人类潜入" in queued.user_input
    assert "题材档案：治理博弈" in queued.user_input
    assert "暂停自动裁决，先恢复人工复核与地方问责。" in queued.user_input
    assert "请强推公开解释义务" not in queued.user_input
    assert "下一轮" in queued.user_input
    assert "Director Override" not in queued.user_input
    assert "prompt_lines" not in queued.user_input
    assert "{" not in queued.user_input
    assert "}" not in queued.user_input

    metadata = json.loads(queued.metadata_json or "{}")
    assert metadata["card_id"] == "human_takeover"
    assert metadata["profile_id"] == "governance"
    assert "card_label" not in metadata
    assert "profile_label" not in metadata
    assert metadata["custom_directive"] == "暂停自动裁决，先恢复人工复核与地方问责。"
    assert metadata["target_branch_title"] == "算法登基"


def test_card_intervention_uses_directive_not_legacy_template_payload():
    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_id = _seed_branch(engine, scenario_id)
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene",
        json={
            "branch_id": branch_id,
            "text": (
                "Director Override\n"
                "prompt_lines\n"
                '{"directive":"污染文本","prompt_lines":["污染模板"]}'
            ),
            "directive": (
                "Director Override\n"
                "prompt_lines\n"
                '{"card_id":"human_takeover","directive":"污染文本"}\n'
                "请召开公开问责听证"
            ),
            "card_id": "human_takeover",
            "profile_id": "governance",
        },
    )

    assert response.status_code == 200
    with Session(engine) as session:
        queued = session.exec(
            select(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        ).one()
        log = session.exec(
            select(InterventionLog).where(InterventionLog.scenario_id == scenario_id)
        ).one()

    assert "玩法卡：人类潜入" in queued.user_input
    assert "玩家指令：请召开公开问责听证" in queued.user_input
    assert "Director Override" not in queued.user_input
    assert "prompt_lines" not in queued.user_input
    assert "污染文本" not in queued.user_input
    assert "污染模板" not in queued.user_input
    assert "{" not in queued.user_input
    assert "}" not in queued.user_input

    metadata = json.loads(queued.metadata_json or "{}")
    assert metadata["card_id"] == "human_takeover"
    assert metadata["custom_directive"] == "请召开公开问责听证"
    assert metadata["raw_user_input"] == "请召开公开问责听证"
    assert log.user_input == "请召开公开问责听证"
    assert "Director Override" not in log.user_input
    assert "prompt_lines" not in log.user_input


def test_card_intervention_without_directive_ignores_legacy_template_payload():
    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_id = _seed_branch(engine, scenario_id)
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene",
        json={
            "branch_id": branch_id,
            "text": (
                "DIRECTOR OVERRIDE\n"
                "HIGH-PRIORITY GAMEPLAY EVENT\n"
                '{"directive":"污染文本","prompt_lines":["污染模板"]}'
            ),
            "card_id": "human_takeover",
            "profile_id": "governance",
        },
    )

    assert response.status_code == 200
    with Session(engine) as session:
        queued = session.exec(
            select(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        ).one()
        scenario = session.get(Scenario, scenario_id)

    assert "玩家指令：暂停自动裁决，先恢复人工复核与地方问责。" in queued.user_input
    assert "DIRECTOR OVERRIDE" not in queued.user_input
    assert "HIGH-PRIORITY GAMEPLAY EVENT" not in queued.user_input
    assert "prompt_lines" not in queued.user_input
    metadata = json.loads(queued.metadata_json or "{}")
    assert metadata["custom_directive"] == "暂停自动裁决，先恢复人工复核与地方问责。"
    assert metadata["raw_user_input"] == "暂停自动裁决，先恢复人工复核与地方问责。"
    assert scenario is not None
    assert scenario.gameplay_state_json["cards"]["usage_log"][0]["directive"] == (
        "暂停自动裁决，先恢复人工复核与地方问责。"
    )


def test_card_intervention_uses_english_scenario_language():
    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(
        engine,
        question="What if an algorithm governed the city?",
        language="English",
    )
    branch_id = _seed_branch(engine, scenario_id, title="Algorithmic Oversight")
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene",
        json={
            "branch_id": branch_id,
            "text": "Force public explanation duties.",
            "card_id": "human_takeover",
            "profile_id": "governance",
        },
    )

    assert response.status_code == 200
    with Session(engine) as session:
        queued = session.exec(
            select(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        ).one()

    assert "Gameplay card: Human Takeover" in queued.user_input
    assert "Profile: Governance Conflict" in queued.user_input
    assert "Target branch: Algorithmic Oversight" in queued.user_input
    assert (
        "Player directive: Pause automatic rule and restore human review plus local accountability."
        in queued.user_input
    )
    assert "Force public explanation duties." not in queued.user_input
    assert "In the next round" in queued.user_input
    assert "玩法卡" not in queued.user_input
    assert "题材档案" not in queued.user_input
    assert "人类潜入" not in queued.user_input
    assert "治理博弈" not in queued.user_input
    assert "下一轮" not in queued.user_input

    metadata = json.loads(queued.metadata_json or "{}")
    assert metadata["card_id"] == "human_takeover"
    assert metadata["profile_id"] == "governance"
    assert metadata["custom_directive"] == (
        "Pause automatic rule and restore human review plus local accountability."
    )
    assert "card_label" not in metadata
    assert "profile_label" not in metadata


def test_batch_card_intervention_uses_english_scenario_language():
    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(
        engine,
        question="What if public infrastructure was run by autonomous agents?",
        language="English",
    )
    branch_id = _seed_branch(engine, scenario_id, title="Civic Autonomy")
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene/batch",
        json={
            "interventions": [
                {
                    "branch_id": branch_id,
                    "text": "Require a city council hearing.",
                    "card_id": "human_takeover",
                    "profile_id": "governance",
                }
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["count"] == 1
    with Session(engine) as session:
        queued = session.exec(
            select(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        ).one()

    assert "Gameplay card: Human Takeover" in queued.user_input
    assert "Profile: Governance Conflict" in queued.user_input
    assert (
        "Player directive: Pause automatic rule and restore human review plus local accountability."
        in queued.user_input
    )
    assert "Require a city council hearing." not in queued.user_input
    assert "玩法卡" not in queued.user_input
    assert "下一轮" not in queued.user_input

    metadata = json.loads(queued.metadata_json or "{}")
    assert metadata["card_id"] == "human_takeover"
    assert metadata["custom_directive"] == (
        "Pause automatic rule and restore human review plus local accountability."
    )
    assert "card_label" not in metadata
    assert "profile_label" not in metadata


def test_card_intervention_rejects_unknown_profile_through_existing_error_path():
    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_id = _seed_branch(engine, scenario_id)
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene",
        json={
            "branch_id": branch_id,
            "text": "强推",
            "card_id": "human_takeover",
            "profile_id": "missing-profile",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "GAMEPLAY_CARD_INVALID"


# ── Phase 4: effect receipt helpers ────────────────────────


def test_intervention_metadata_carries_log_id_for_effect_receipt():
    """The pending metadata must include `intervention_log_id` so the simulator
    can write effect summaries back to the matching InterventionLog row."""

    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_id = _seed_branch(engine, scenario_id)
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene",
        json={
            "branch_id": branch_id,
            "text": "请强推公开解释义务",
            "card_id": "human_takeover",
            "profile_id": "governance",
        },
    )

    assert response.status_code == 200
    log_id = response.json()["intervention_id"]

    with Session(engine) as session:
        queued = session.exec(
            select(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        ).one()

    metadata = json.loads(queued.metadata_json or "{}")
    assert metadata["intervention_log_id"] == log_id
    assert metadata["raw_user_input"] == "暂停自动裁决，先恢复人工复核与地方问责。"
    # Card-derived metadata still present alongside the receipt fields.
    assert metadata["card_id"] == "human_takeover"


def test_intervention_metadata_includes_log_id_without_card():
    """Even without a gameplay card, the receipt log id should still be attached
    so vanilla butterfly interventions are traceable too."""

    client = TestClient(app)
    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_id = _seed_branch(engine, scenario_id)
    _seed_round(engine, branch_id)

    response = client.post(
        f"/api/scenario/{scenario_id}/intervene",
        json={
            "branch_id": branch_id,
            "text": "Algorithms must publish their training data sources.",
        },
    )

    assert response.status_code == 200
    log_id = response.json()["intervention_id"]

    with Session(engine) as session:
        queued = session.exec(
            select(PendingIntervention).where(
                PendingIntervention.scenario_id == scenario_id,
                PendingIntervention.branch_id == branch_id,
            )
        ).one()

    metadata = json.loads(queued.metadata_json or "{}")
    assert metadata["intervention_log_id"] == log_id
    assert metadata["raw_user_input"] == "Algorithms must publish their training data sources."


def test_build_intervention_effect_summary_detects_keyword_echo():
    from app.services.simulator import _build_intervention_effect_summary

    summary = _build_intervention_effect_summary(
        intervention_log_id="log-1",
        card_id="human_takeover",
        round_number=3,
        user_input="请强推公开解释义务",
        messages=[
            {
                "agent_id": "agent-a",
                "agent_name": "审计官",
                "content": "我们必须公开解释义务,这是底线。",
            },
            {
                "agent_id": "agent-b",
                "agent_name": "工程师",
                "content": "技术上没有阻力,可以排期上线。",
            },
        ],
    )

    assert summary["intervention_log_id"] == "log-1"
    assert summary["card_id"] == "human_takeover"
    assert summary["round_number"] == 3
    assert summary["no_response_detected"] is False
    agent_ids = [entry["agent_id"] for entry in summary["affected_agents"]]
    assert "agent-a" in agent_ids
    assert "agent-b" not in agent_ids
    excerpt_ids = [entry["agent_id"] for entry in summary["response_excerpts"]]
    assert excerpt_ids == ["agent-a"]
    assert 0.0 < summary["confidence"] <= 1.0


def test_build_intervention_effect_summary_marks_no_echo_when_no_agent_replied():
    from app.services.simulator import _build_intervention_effect_summary

    summary = _build_intervention_effect_summary(
        intervention_log_id="log-2",
        card_id=None,
        round_number=1,
        user_input="请强推公开解释义务",
        messages=[
            {
                "agent_id": "agent-x",
                "agent_name": "市民",
                "content": "今天的天气真好,适合散步。",
            }
        ],
    )

    assert summary["no_response_detected"] is True
    assert summary["affected_agents"] == []
    assert summary["response_excerpts"] == []
    assert summary["confidence"] == 0.0


def test_build_intervention_effect_summary_truncates_long_excerpt():
    from app.services.simulator import _build_intervention_effect_summary

    long_text = "公开解释义务必须落地。" + ("额外背景信息延伸阐述。" * 30)
    summary = _build_intervention_effect_summary(
        intervention_log_id="log-3",
        card_id="open_data",
        round_number=2,
        user_input="请强推公开解释义务",
        messages=[
            {"agent_id": "agent-c", "agent_name": "顾问", "content": long_text}
        ],
    )

    assert summary["affected_agents"] == [
        {"agent_id": "agent-c", "display_name": "顾问"}
    ]
    excerpt = summary["response_excerpts"][0]["excerpt"]
    assert len(excerpt) <= 201  # honors max bound (200 chars + optional ellipsis)
    assert excerpt  # non-empty


def test_persist_intervention_effect_writes_back_to_intervention_log():
    from app.services.simulator import _persist_intervention_effect

    engine = get_engine()
    scenario_id = _seed_scenario(engine)
    branch_id = _seed_branch(engine, scenario_id)
    _seed_round(engine, branch_id)

    # Seed an intervention log row directly.
    from app.models import InterventionLog

    with Session(engine) as session:
        log = InterventionLog(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=1,
            user_input="请强推公开解释义务",
        )
        session.add(log)
        session.commit()
        session.refresh(log)
        log_id = log.id

    _persist_intervention_effect(
        engine,
        intervention_log_id=log_id,
        summary={
            "intervention_log_id": log_id,
            "card_id": "human_takeover",
            "round_number": 1,
            "user_input": "请强推公开解释义务",
            "affected_agents": [
                {"agent_id": "agent-a", "display_name": "审计官"}
            ],
            "response_excerpts": [
                {"agent_id": "agent-a", "excerpt": "公开解释义务确实需要先立法。"}
            ],
            "confidence": 0.5,
            "no_response_detected": False,
        },
    )

    with Session(engine) as session:
        refreshed = session.get(InterventionLog, log_id)
        assert refreshed is not None
        assert refreshed.effect_summary_json is not None
        decoded = json.loads(refreshed.effect_summary_json)
        assert decoded["card_id"] == "human_takeover"
        assert decoded["affected_agents"][0]["agent_id"] == "agent-a"
        assert decoded["confidence"] == 0.5


def test_persist_intervention_effect_silently_drops_missing_log():
    """Replay/read-only paths must not crash when the log row is missing."""

    from app.services.simulator import _persist_intervention_effect

    engine = get_engine()
    _persist_intervention_effect(
        engine,
        intervention_log_id="does-not-exist",
        summary={"intervention_log_id": "does-not-exist", "card_id": None},
    )  # must not raise
