"""Sprint S4 tests for indicators-to-watch enrichment."""

from __future__ import annotations

import json
from typing import Any

import pytest
from sqlmodel import Session

from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.result_report.schema import IndicatorToWatch, validate_full_report_payload


class QueuedLlm:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)

    async def __call__(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        if not self.responses:
            raise AssertionError("unexpected LLM call")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def _outline_payload(section_ids: list[str] | None = None) -> dict[str, Any]:
    ids = section_ids or ["timeline", "sources"]
    return {
        "title_i18n": {"zh": "指标测试报告", "en": "Indicator test report"},
        "summary_i18n": {
            "zh": "隐私让步让主导路线更稳。",
            "en": "Privacy concessions strengthen the dominant route.",
        },
        "sections": [
            {
                "id": section_id,
                "title_i18n": {
                    "zh": f"{section_id} 章节",
                    "en": f"{section_id.title()} section",
                },
                "intent": f"Explain {section_id}.",
            }
            for section_id in ids
        ],
    }


def _section_payload(section_id: str) -> dict[str, Any]:
    return {
        "action": "final_section",
        "body_md_i18n": {
            "zh": f"{section_id}：隐私保护改变了投票。",
            "en": f"{section_id} explains why safeguards changed the vote.",
        },
        "evidence_refs": ["ev_001"],
    }


def _seed_indicator_scenario(*, with_messages: bool = True, language: str = "en") -> str:
    is_zh = language == "zh"
    question = (
        "这座城市是否应该批准 AI 公交方案？"
        if is_zh
        else "Should the city approve the AI transit plan?"
    )
    result_quality = (
        {
            "verdict": "方案很可能在隐私保护条件下通过。",
            "question_answer": "它很可能会在加入隐私保护后通过。",
        }
        if is_zh
        else {
            "verdict": "The plan likely passes after privacy safeguards.",
            "question_answer": "It likely passes with safeguards.",
        }
    )
    privacy_agent_name = "隐私倡议者" if is_zh else "Privacy Advocate"
    planner_agent_name = "交通规划师" if is_zh else "Transit Planner"
    branch_a = (
        {
            "title": "加入隐私保护后批准",
            "story": "方案在加入隐私保护和预算上限后获得通过。",
            "insight": "隐私保护打开了狭窄联盟。",
            "key_moments": ["隐私保护", "预算上限"],
        }
        if is_zh
        else {
            "title": "Approval with privacy safeguards",
            "story": "The plan passes after privacy safeguards and budget caps.",
            "insight": "Privacy safeguards unlock a narrow coalition.",
            "key_moments": ["privacy safeguards", "budget caps"],
        }
    )
    branch_b = (
        {
            "title": "推迟到委员会复审",
            "story": "委员会复审导致投票推迟。",
            "insight": "要求推迟的联盟几乎胜出。",
        }
        if is_zh
        else {
            "title": "Delay for committee review",
            "story": "The vote is delayed by a committee review.",
            "insight": "The delay coalition almost wins.",
        }
    )
    privacy_message = (
        "隐私保护让批准更有说服力。"
        if is_zh
        else "Privacy safeguards make approval defensible."
    )
    planner_message = (
        "预算上限让交通收益保持政治可行。"
        if is_zh
        else "Budget caps keep the transport gains politically viable."
    )
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-indicators",
            question=question,
            status=ScenarioStatus.DONE,
            parsed_context={
                "_language": language,
                "result_quality": result_quality,
            },
        )
        session.add(scenario)
        session.add_all(
            [
                Agent(
                    id="agent-privacy",
                    scenario_id=scenario.id,
                    name=privacy_agent_name,
                    role="Civil society",
                ),
                Agent(
                    id="agent-planner",
                    scenario_id=scenario.id,
                    name=planner_agent_name,
                    role="Planner",
                ),
            ],
        )
        session.add_all(
            [
                Branch(
                    id="branch-a",
                    scenario_id=scenario.id,
                    title=branch_a["title"],
                    probability=0.68,
                    fork_round=1,
                    status=BranchStatus.COMPLETED,
                    story=branch_a["story"],
                    insight=branch_a["insight"],
                    key_moments=json.dumps(branch_a["key_moments"], ensure_ascii=False),
                ),
                Branch(
                    id="branch-b",
                    scenario_id=scenario.id,
                    title=branch_b["title"],
                    probability=0.32,
                    fork_round=2,
                    status=BranchStatus.COMPLETED,
                    story=branch_b["story"],
                    insight=branch_b["insight"],
                ),
            ],
        )
        if with_messages:
            session.add_all(
                [
                    Round(id="round-1", branch_id="branch-a", round_number=1),
                    Round(id="round-2", branch_id="branch-a", round_number=2),
                ],
            )
            session.add_all(
                [
                    AgentMessage(
                        id="msg-privacy",
                        round_id="round-1",
                        agent_id="agent-privacy",
                        content=privacy_message,
                        emotion="focused",
                        diverge="隐私保护" if is_zh else "privacy safeguards",
                    ),
                    AgentMessage(
                        id="msg-budget",
                        round_id="round-2",
                        agent_id="agent-planner",
                        content=planner_message,
                        emotion="confident",
                    ),
                ],
            )
        session.commit()
    return "scenario-indicators"


def _indicator_text(indicators: list[IndicatorToWatch]) -> str:
    return "\n".join(
        "\n".join(
            [
                indicator.signal,
                indicator.note,
                indicator.threshold,
                indicator.observation,
                indicator.time_horizon,
                indicator.rationale,
            ]
        )
        for indicator in indicators
    )


def _persisted_report(scenario_id: str) -> dict[str, Any]:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        report = (scenario.parsed_context or {}).get("full_report")
        assert isinstance(report, dict)
        return report


@pytest.mark.asyncio
async def test_indicator_enrichment_populates_s4_fields_and_real_evidence_refs(
    monkeypatch,
):
    from app.services.result_report import builder

    scenario_id = _seed_indicator_scenario(with_messages=True)
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm(
            [
                _outline_payload(["timeline", "sources"]),
                _section_payload("timeline"),
                _section_payload("sources"),
            ],
        ),
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert 2 <= len(report.indicators_to_watch) <= 5
    evidence_ids = {item.id for item in report.evidence}
    assert evidence_ids
    assert any(item.evidence_refs for item in report.indicators_to_watch)
    for indicator in report.indicators_to_watch:
        assert indicator.signal
        assert indicator.direction in {"up", "down"}
        assert indicator.note
        assert indicator.threshold
        assert indicator.observation
        assert indicator.time_horizon
        assert indicator.rationale
        assert set(indicator.evidence_refs).issubset(evidence_ids)
    assert report.interview_evidence == []
    assert report.premortem == []

    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.indicators_to_watch[0].threshold


@pytest.mark.asyncio
async def test_indicator_scaffolding_localizes_to_zh_with_real_evidence(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_indicator_scenario(with_messages=True, language="zh")
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm(
            [
                _outline_payload(["timeline", "sources"]),
                _section_payload("timeline"),
                _section_payload("sources"),
            ],
        ),
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    text = _indicator_text(report.indicators_to_watch)
    assert report.language == "zh"
    assert "第 1 轮信号" in text
    assert "主导路线" in text
    assert "后续" in text
    assert "证据 ev_001" in text
    assert "隐私保护让批准更有说服力。" in text
    assert "UNTRUSTED DATA" not in text
    assert "```" not in text
    for forbidden in [
        "Round ",
        "signal from",
        "If this signal persists",
        "dominant branch",
        "follow-up cycle",
        "Supported by evidence",
        "Probability gap",
        "percentage points",
        "Reducer ",
        "report refresh",
        "message-level evidence coordinate",
        "insufficient evidence",
    ]:
        assert forbidden not in text


@pytest.mark.asyncio
async def test_indicator_no_evidence_rationale_localizes_to_zh(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_indicator_scenario(with_messages=False, language="zh")
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm(
            [
                _outline_payload(["timeline"]),
                _section_payload("timeline"),
            ],
        ),
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    text = _indicator_text(report.indicators_to_watch)
    assert report.language == "zh"
    assert report.evidence == []
    assert 2 <= len(report.indicators_to_watch) <= 5
    for indicator in report.indicators_to_watch:
        assert indicator.evidence_refs == []
        assert "证据不足" in indicator.rationale
    for forbidden in [
        "insufficient evidence",
        "Watch whether",
        "dominant branch",
        "real coordinate",
        "No message-level evidence",
        "next follow-up cycle",
    ]:
        assert forbidden not in text


@pytest.mark.asyncio
async def test_indicator_missing_evidence_never_fabricates_evidence_refs(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_indicator_scenario(with_messages=False)
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm(
            [
                _outline_payload(["timeline"]),
                _section_payload("timeline"),
            ],
        ),
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.evidence == []
    assert 2 <= len(report.indicators_to_watch) <= 5
    for indicator in report.indicators_to_watch:
        assert indicator.evidence_refs == []
        assert "insufficient evidence" in indicator.rationale.lower()
        assert "证据不足" not in indicator.rationale


@pytest.mark.asyncio
async def test_indicator_generation_failure_isolated_from_report_status(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_indicator_scenario(with_messages=True)
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm(
            [
                _outline_payload(["timeline"]),
                _section_payload("timeline"),
            ],
        ),
    )

    def fail_indicators(*_args: Any, **_kwargs: Any):
        raise RuntimeError("indicator builder failed")

    monkeypatch.setattr(builder, "_build_indicators_to_watch", fail_indicators)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert report.indicators_to_watch == []
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "complete"


def test_indicator_model_accepts_s0_payload_with_s4_defaults() -> None:
    indicator = IndicatorToWatch.model_validate(
        {
            "signal": "Privacy amendment adoption",
            "direction": "up",
            "note": "Adoption would raise the odds of passage.",
        }
    )

    assert indicator.threshold == ""
    assert indicator.observation == ""
    assert indicator.time_horizon == ""
    assert indicator.rationale == ""
    assert indicator.evidence_refs == []
