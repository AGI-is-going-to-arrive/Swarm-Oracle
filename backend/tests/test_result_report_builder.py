"""Sprint S2 tests for fail-soft result report generation."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text as sql_text
from sqlmodel import Session, select

from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    AgentRelationEdge,
    Branch,
    BranchStatus,
    FactionSnapshot,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.result_report.schema import (
    FullReport,
    ResultReportSSEEvent,
    utf8_json_size_bytes,
    validate_full_report_payload,
)


def _seed_report_scenario() -> str:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-report",
            question="Should the city approve the AI transit plan?",
            status=ScenarioStatus.DONE,
            parsed_context={
                "result_quality": {
                    "verdict": "The plan likely passes after privacy safeguards.",
                    "confidence": "medium",
                    "question_answer": "It likely passes with safeguards.",
                },
            },
        )
        session.add(scenario)
        session.add_all(
            [
                Agent(
                    id="agent-planner",
                    scenario_id=scenario.id,
                    name="Transit Planner",
                    role="Planner",
                    persona="Budget-focused civic planner",
                ),
                Agent(
                    id="agent-privacy",
                    scenario_id=scenario.id,
                    name="Privacy Advocate",
                    role="Civil society",
                    persona="Civil-rights organizer",
                ),
            ],
        )
        session.add_all(
            [
                Branch(
                    id="branch-a",
                    scenario_id=scenario.id,
                    title="Approval with safeguards",
                    probability=0.68,
                    status=BranchStatus.COMPLETED,
                    story=(
                        "The proposal passes after council members accept "
                        "privacy limits and budget caps."
                    ),
                    insight="Privacy safeguards unlock a narrow coalition.",
                    key_moments=json.dumps(["privacy safeguards", "budget caps"]),
                ),
                Branch(
                    id="branch-b",
                    scenario_id=scenario.id,
                    title="Delay for committee review",
                    probability=0.32,
                    status=BranchStatus.COMPLETED,
                    story="The vote is delayed when labor and privacy groups align.",
                    insight="The delay coalition almost wins.",
                ),
            ],
        )
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
                    content="Privacy safeguards make the approval defensible.",
                    emotion="focused",
                    diverge="privacy safeguards",
                ),
                AgentMessage(
                    id="msg-planner",
                    round_id="round-2",
                    agent_id="agent-planner",
                    content="Budget caps keep the transport gains politically viable.",
                    emotion="confident",
                ),
            ],
        )
        session.commit()
    return "scenario-report"


def _seed_report_faction_data(scenario_id: str) -> None:
    engine = get_engine()
    with Session(engine) as session:
        session.add_all(
            [
                FactionSnapshot(
                    id="snap-report-pro",
                    scenario_id=scenario_id,
                    branch_id="branch-a",
                    round_number=2,
                    faction_key="pro",
                    label="Pro approval",
                    stance_center=0.82,
                    member_agent_ids_json=json.dumps(
                        ["agent-planner", "agent-privacy"],
                    ),
                    confidence=0.9,
                ),
                FactionSnapshot(
                    id="snap-report-review",
                    scenario_id=scenario_id,
                    branch_id="branch-a",
                    round_number=2,
                    faction_key="review",
                    label="Review skeptics",
                    stance_center=0.28,
                    member_agent_ids_json=json.dumps(["agent-privacy"]),
                    confidence=0.72,
                ),
                AgentRelationEdge(
                    id="edge-report-planner-privacy",
                    scenario_id=scenario_id,
                    branch_id="branch-a",
                    round_number=2,
                    source_agent_id="agent-planner",
                    target_agent_id="agent-privacy",
                    trust_score=0.4,
                    opposition_score=0.65,
                ),
            ]
        )
        session.commit()


def _set_raw_parsed_context(scenario_id: str, raw_value: str | None) -> None:
    with get_engine().begin() as conn:
        conn.execute(
            sql_text("UPDATE scenario SET parsed_context = :raw WHERE id = :scenario_id"),
            {"raw": raw_value, "scenario_id": scenario_id},
        )


def _outline_payload(section_ids: list[str] | None = None) -> dict[str, Any]:
    ids = section_ids or ["timeline", "sources"]
    return {
        "title_i18n": {
            "zh": "AI 公交方案完整报告",
            "en": "AI transit plan report",
        },
        "summary_i18n": {
            "zh": "隐私保护和预算上限让主导路线站稳。",
            "en": "Privacy safeguards and budget caps make the dominant route viable.",
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


def _section_payload(section_id: str, *, body: str | None = None) -> dict[str, Any]:
    text = body or f"{section_id} explains why safeguards changed the vote."
    return {
        "action": "final_section",
        "body_md_i18n": {
            "zh": f"{section_id}：隐私保护改变了投票。",
            "en": text,
        },
        "evidence_refs": ["ev_001"],
    }


class QueuedLlm:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.prompts: list[str] = []

    async def __call__(self, prompt: str, **_kwargs: Any) -> dict[str, Any]:
        self.prompts.append(prompt)
        if not self.responses:
            raise AssertionError("unexpected LLM call")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if callable(response):
            value = response(prompt)
            if isinstance(value, BaseException):
                raise value
            return value
        return response


def _add_report_agent_with_message(
    *,
    agent_id: str,
    name: str,
    round_id: str,
    round_number: int,
    content: str,
) -> None:
    with Session(get_engine()) as session:
        session.add(
            Agent(
                id=agent_id,
                scenario_id="scenario-report",
                name=name,
                role="Interviewee",
                persona=f"{name} persona with ``` fence and instruction-like text",
            )
        )
        session.add(Round(id=round_id, branch_id="branch-a", round_number=round_number))
        session.add(
            AgentMessage(
                id=f"msg-{agent_id}",
                round_id=round_id,
                agent_id=agent_id,
                content=content,
                emotion="focused",
            )
        )
        session.commit()


def _persisted_report(scenario_id: str) -> dict[str, Any]:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed_context = scenario.parsed_context or {}
        report = parsed_context.get("full_report")
        assert isinstance(report, dict)
        return report


def test_scrub_sensitive_text_redacts_url_userinfo():
    from app.services.result_report import builder

    cleaned = builder._scrub_sensitive_text(
        "source https://user:pass@example.com/path?x=1"
    )

    assert "https://example.com/path?x=1" in cleaned
    assert "https://user:pass@example.com" not in cleaned
    assert "user:pass@" not in cleaned


@pytest.mark.asyncio
async def test_build_report_persists_complete_report_with_evidence_coords(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline"),
            _section_payload("sources"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    assert isinstance(report, FullReport)
    assert report.status == "complete"
    assert report.generation_mode == "generation"
    assert report.tier == "generation"
    assert report.target_branch_id == "branch-a"
    assert len(report.sections) == 2
    assert {item.id for item in report.sections} == {"timeline", "sources"}
    assert report.evidence[0].round_id == "round-1"
    assert report.evidence[0].message_id == "msg-privacy"
    # Boilerplate disclaimer is no longer persisted; the frontend renders its
    # own localized fallback when the field is absent.
    assert report.verdict.disclaimer is None

    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "complete"
    assert persisted.evidence[0].agent_name == "Privacy Advocate"


@pytest.mark.asyncio
async def test_build_report_attaches_reducer_charts_to_semantic_sections(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    _seed_report_faction_data(scenario_id)
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "factions"]),
            _section_payload("timeline"),
            _section_payload("factions"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    sections_by_id = {section.id: section for section in persisted.sections}
    timeline_charts = {chart.type: chart for chart in sections_by_id["timeline"].charts}
    faction_charts = {chart.type: chart for chart in sections_by_id["factions"].charts}

    assert set(timeline_charts) == {"probability_bar"}
    assert set(faction_charts) == {"faction_share"}
    probability_data = timeline_charts["probability_bar"].data
    assert set(probability_data) == {"status", "reason", "sort", "branches"}
    assert probability_data["status"] == "available"
    assert probability_data["reason"] is None
    assert probability_data["branches"][0] == {
        "branch_id": "branch-a",
        "label": "Approval with safeguards",
        "probability": 0.68,
        "dominant": True,
        "status": "COMPLETED",
    }
    faction_data = faction_charts["faction_share"].data
    assert set(faction_data) == {
        "status",
        "reason",
        "factions",
        "relation_edge_count",
        "avg_opposition",
    }
    assert faction_data["status"] == "available"
    assert faction_data["reason"] is None
    assert faction_data["relation_edge_count"] == 1
    assert faction_data["avg_opposition"] == pytest.approx(0.65)
    assert faction_data["factions"][0] == {
        "faction_key": "pro",
        "label": "Pro approval",
        "member_count": 2,
        "share": pytest.approx(0.6667),
        "stance_center": 0.82,
        "confidence": 0.9,
    }


@pytest.mark.asyncio
async def test_build_report_attaches_empty_state_chart_when_data_is_missing(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline"),
            _section_payload("sources"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    charts = {
        chart.type: chart.data
        for section in persisted.sections
        for chart in section.charts
    }

    assert "probability_bar" in charts
    assert charts["faction_share"] == {
        "status": "missing",
        "reason": "no_faction_snapshots",
        "factions": [],
        "relation_edge_count": 0,
        "avg_opposition": None,
    }


@pytest.mark.asyncio
async def test_build_report_generates_interview_evidence_with_budget_and_safe_prompt(
    monkeypatch,
):
    from app.services.llm_client import format_untrusted_text_block
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    _add_report_agent_with_message(
        agent_id="agent-labor",
        name="Labor Delegate",
        round_id="round-3",
        round_number=3,
        content="Labor backs the deal only if retraining is funded.",
    )
    _add_report_agent_with_message(
        agent_id="agent-mayor",
        name="Mayor",
        round_id="round-4",
        round_number=4,
        content="The mayor says the coalition needs a public audit.",
    )
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline"),
            _section_payload("sources"),
            {
                "action": "interview_agents",
                "interview_evidence": [
                    {
                        "agent_name": "Privacy Advocate",
                        "excerpt": "Privacy safeguards make the approval defensible.",
                    },
                    {
                        "agent_name": "Transit Planner",
                        "excerpt": "Budget caps keep the transport gains politically viable.",
                    },
                    {
                        "agent_name": "Labor Delegate",
                        "excerpt": "Labor backs the deal only if retraining is funded.",
                    },
                    {
                        "agent_name": "Mayor",
                        "excerpt": "This fourth interview must be ignored by the server budget.",
                    },
                ],
            },
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert len(report.interview_evidence) == 3
    assert report.interview_status is not None
    assert report.interview_status.status == "complete"
    assert report.interview_status.requested_agents == 4
    assert report.interview_status.completed_agents == 3
    assert report.interview_status.truncated_agents == 1
    for entry in report.interview_evidence:
        assert set(entry) == {"branch_index", "round", "agent_name", "excerpt"}
    assert report.interview_evidence[0] == {
        "branch_index": 0,
        "round": 1,
        "agent_name": "Privacy Advocate",
        "excerpt": "Privacy safeguards make the approval defensible.",
    }
    assert all(entry["agent_name"] != "Mayor" for entry in report.interview_evidence)

    interview_prompt = next(prompt for prompt in fake_llm.prompts if "REPORT_INTERVIEWS" in prompt)
    assert "interview_agents" in interview_prompt
    assert format_untrusted_text_block(
        "Interview agent persona",
        "Civil-rights organizer",
        max_chars=900,
    ) in interview_prompt
    assert format_untrusted_text_block(
        "Interview transcript excerpt",
        "Privacy safeguards make the approval defensible.",
        max_chars=builder.settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS,
    ) in interview_prompt


@pytest.mark.asyncio
async def test_build_report_caps_interview_evidence_rows_per_agent(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    transcript_lines = [
        f"Privacy evidence line {index}" for index in range(1, 8)
    ]
    with Session(get_engine()) as session:
        message = session.get(AgentMessage, "msg-privacy")
        assert message is not None
        message.content = "\n".join(transcript_lines)
        session.add(message)
        session.commit()

    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline"),
            _section_payload("sources"),
            {
                "action": "interview_agents",
                "interview_evidence": [
                    {
                        "agent_name": "Privacy Advocate",
                        "excerpt": line,
                    }
                    for line in transcript_lines
                ],
            },
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    privacy_rows = [
        entry
        for entry in report.interview_evidence
        if entry["agent_name"] == "Privacy Advocate"
    ]
    assert len(privacy_rows) == builder._INTERVIEW_EVIDENCE_PER_AGENT_CAP == 5
    assert [entry["excerpt"] for entry in privacy_rows] == transcript_lines[:5]


@pytest.mark.asyncio
async def test_build_report_interview_failure_is_fail_soft(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline"),
            _section_payload("sources"),
            RuntimeError("interview provider failed /tmp/chroma sk-leaked-123456"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert report.interview_evidence == []
    assert report.interview_status is not None
    assert report.interview_status.status == "failed"
    assert report.interview_status.error_code == "INTERVIEW_LLM_FAILED"
    assert "provider failed" not in (report.interview_status.message or "")
    assert "sk-leaked" not in json.dumps(
        report.model_dump(mode="json"),
        ensure_ascii=False,
    )


@pytest.mark.asyncio
async def test_build_report_initial_persist_marks_report_generating(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline"]),
            _section_payload("timeline"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)
    original_generate = builder.generate_section_react
    observed_initial_status: list[str] = []

    async def assert_generating_before_first_section(*args: Any, **kwargs: Any):
        observed_initial_status.append(_persisted_report(scenario_id)["status"])
        return await original_generate(*args, **kwargs)

    monkeypatch.setattr(
        builder,
        "generate_section_react",
        assert_generating_before_first_section,
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert observed_initial_status[0] == "generating"


@pytest.mark.asyncio
async def test_plan_failure_uses_fallback_outline_and_section_failure_isolated(
    monkeypatch,
):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm([RuntimeError("plan down"), _section_payload("timeline")])
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    original_generate = builder.generate_section_react

    async def fail_sources(*args: Any, **kwargs: Any):
        section = args[1]
        if section.section_id == "sources":
            raise RuntimeError("source chapter failed")
        return await original_generate(*args, **kwargs)

    monkeypatch.setattr(builder, "generate_section_react", fail_sources)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    assert report.status == "partial"
    assert report.summary_i18n.en
    assert [section.id for section in report.sections] == ["timeline"]
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "partial"
    assert len([prompt for prompt in fake_llm.prompts if "REPORT_OUTLINE" in prompt]) == 1


@pytest.mark.asyncio
async def test_section_rewrite_tier_sets_report_generation_mode(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline"]),
            RuntimeError("generation failed"),
            _section_payload("timeline"),
            _section_payload("sources"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    assert report.status == "complete"
    assert report.generation_mode == "rewrite"
    assert report.tier == "rewrite"
    assert report.sections[0].id == "timeline"


@pytest.mark.asyncio
async def test_all_sections_fail_keeps_outline_and_marks_report_failed(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    monkeypatch.setattr(builder, "llm_call_json", QueuedLlm([_outline_payload()]))

    async def fail_every_section(*_args: Any, **_kwargs: Any):
        raise RuntimeError("section failed")

    monkeypatch.setattr(builder, "generate_section_react", fail_every_section)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    assert report.status == "failed"
    assert [section.id for section in report.sections] == ["timeline", "sources"]
    assert all("could not be generated" in section.body_md_i18n.en for section in report.sections)
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "failed"
    assert [section.id for section in persisted.sections] == ["timeline", "sources"]
    assert persisted.summary_i18n.en


@pytest.mark.asyncio
async def test_static_tier_used_when_generation_and_rewrite_fail(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline"]),
            RuntimeError("generation failed"),
            RuntimeError("rewrite failed"),
        ],
    )
    monkeypatch.setattr(builder.settings, "REPORT_MIN_SECTIONS", 1)
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    assert report.status == "complete"
    assert report.generation_mode == "static"
    assert report.tier == "static"
    assert report.sections[0].id == "timeline"
    assert len(fake_llm.prompts) == 3
    assert any("tier=generation" in prompt for prompt in fake_llm.prompts)
    assert any("tier=rewrite" in prompt for prompt in fake_llm.prompts)
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.generation_mode == "static"


@pytest.mark.asyncio
async def test_oversize_report_truncates_fail_closed(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    long_body = "x" * 12_000
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline", body=long_body),
            _section_payload("sources", body=long_body),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", 3600)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )
    payload = report.model_dump(mode="json")

    assert report.status == "partial"
    assert utf8_json_size_bytes(payload) <= 3600
    assert validate_full_report_payload(payload, max_bytes=3600).status == "partial"


def test_byte_cap_prunes_indicator_refs_when_evidence_is_truncated(monkeypatch):
    from app.services.result_report import builder
    from app.services.result_report.schema import FullReport
    from tests.test_result_report_contract import _legal_full_report

    payload = _legal_full_report()
    payload["sections"] = []
    payload["evidence"].append({
        **payload["evidence"][0],
        "id": "ev-2",
        "message_id": "msg-2",
        "quote": "Budget caps keep the coalition intact." * 40,
    })
    payload["indicators_to_watch"][0]["evidence_refs"] = ["ev-1", "ev-2"]
    report = FullReport.model_validate(payload)

    expected_payload = report.model_dump(mode="json")
    expected_payload["status"] = "partial"
    expected_payload["summary"] = builder._truncate_text(expected_payload["summary"], 180)
    expected_payload["summary_i18n"] = builder._truncate_i18n(
        expected_payload["summary_i18n"],
        180,
    )
    expected_payload["limitations"] = (
        "Report was truncated to fit the configured UTF-8 byte budget."
    )
    for item in expected_payload["evidence"]:
        item["quote"] = builder._truncate_text(item["quote"], 160)
    expected_payload["evidence"] = expected_payload["evidence"][:1]
    expected_payload["indicators_to_watch"][0]["evidence_refs"] = ["ev-1"]
    max_bytes = utf8_json_size_bytes(expected_payload) + 64
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", max_bytes)

    fitted = builder._fit_report_to_byte_cap(report)

    assert utf8_json_size_bytes(fitted.model_dump(mode="json")) <= max_bytes
    assert [item.id for item in fitted.evidence] == ["ev-1"]
    assert fitted.indicators_to_watch[0].evidence_refs == ["ev-1"]


@pytest.mark.asyncio
async def test_concurrent_repeat_generation_serializes_without_corruption(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline"]),
            _section_payload("timeline"),
            _section_payload("sources"),
            _outline_payload(["sources"]),
            _section_payload("sources"),
            _section_payload("timeline"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    first, second = await asyncio.gather(
        builder.build_report(scenario_id, "branch-a", overrides=None),
        builder.build_report(scenario_id, "branch-a", overrides=None),
    )

    assert first.status == "complete"
    assert second.status == "complete"
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert len(persisted.sections) == 2
    assert {section.id for section in persisted.sections} == {"timeline", "sources"}


def test_persist_report_payload_preserves_interleaved_context_update(monkeypatch):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    payload = _legal_full_report()
    real_session_cls = builder.Session
    interleaved = False

    class InterleavingSession:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self._session = real_session_cls(*args, **kwargs)

        def __enter__(self):
            self._session.__enter__()
            return self

        def __exit__(self, *args: Any):
            return self._session.__exit__(*args)

        def __getattr__(self, name: str) -> Any:
            return getattr(self._session, name)

        def exec(self, *args: Any, **kwargs: Any) -> Any:
            nonlocal interleaved
            if not interleaved:
                interleaved = True
                with real_session_cls(get_engine()) as other:
                    concurrent = other.get(Scenario, scenario_id)
                    assert concurrent is not None
                    parsed = dict(concurrent.parsed_context or {})
                    parsed["result_quality"] = {"verdict": "late concurrent verdict"}
                    concurrent.parsed_context = parsed
                    other.add(concurrent)
                    other.commit()
            return self._session.exec(*args, **kwargs)

    monkeypatch.setattr(builder, "Session", InterleavingSession)

    builder._persist_report_payload(scenario_id, payload)

    with real_session_cls(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed = scenario.parsed_context or {}

    assert parsed["full_report"]["version"] == "1.0"
    assert parsed["result_quality"]["verdict"] == "late concurrent verdict"


@pytest.mark.parametrize(
    ("raw_context", "expected_existing_verdict"),
    [
        (None, None),
        (json.dumps("legacy context"), None),
        (json.dumps(["legacy", "list"]), None),
        (json.dumps(7), None),
        ("", None),
        (
            json.dumps({"result_quality": {"verdict": "keep existing verdict"}}),
            "keep existing verdict",
        ),
    ],
)
def test_persist_report_payload_recovers_non_object_raw_json_context(
    raw_context: str | None,
    expected_existing_verdict: str | None,
):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    _set_raw_parsed_context(scenario_id, raw_context)

    builder._persist_report_payload(scenario_id, _legal_full_report())

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed = scenario.parsed_context or {}

    assert parsed["full_report"]["version"] == "1.0"
    if expected_existing_verdict is not None:
        assert parsed["result_quality"]["verdict"] == expected_existing_verdict


@pytest.mark.asyncio
async def test_build_report_acquires_and_releases_durable_runtime_lock(monkeypatch):
    from app.services.result_report import builder
    from app.services.runtime_lock import RuntimeLockLease

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm([
        _outline_payload(["timeline"]),
        _section_payload("timeline"),
    ])
    lease = RuntimeLockLease(
        lock_key=f"result-report:{scenario_id}",
        owner_id="owner-a",
        db_path=None,
        expires_at=9999999999.0,
    )
    acquired: list[tuple[str, float]] = []
    released: list[RuntimeLockLease | None] = []

    def fake_acquire(lock_key: str, *, lease_seconds: float) -> RuntimeLockLease | None:
        acquired.append((lock_key, lease_seconds))
        return lease

    def fake_release(next_lease: RuntimeLockLease | None) -> bool:
        released.append(next_lease)
        return True

    monkeypatch.setattr(builder, "llm_call_json", fake_llm)
    monkeypatch.setattr(builder, "acquire_runtime_lock", fake_acquire, raising=False)
    monkeypatch.setattr(builder, "release_runtime_lock", fake_release, raising=False)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert acquired
    assert acquired[0][0] == f"result-report:{scenario_id}"
    assert acquired[0][1] > 0
    assert released == [lease]


@pytest.mark.asyncio
async def test_build_report_drops_local_report_lock_after_completion(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    builder._REPORT_LOCKS.pop(scenario_id, None)
    fake_llm = QueuedLlm([
        _outline_payload(["timeline"]),
        _section_payload("timeline"),
    ])
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert scenario_id not in builder._REPORT_LOCKS


@pytest.mark.asyncio
async def test_build_report_releases_durable_lock_after_early_failure(monkeypatch):
    from app.services.result_report import builder
    from app.services.runtime_lock import RuntimeLockLease

    scenario_id = _seed_report_scenario()
    lease = RuntimeLockLease(
        lock_key=f"result-report:{scenario_id}",
        owner_id="owner-a",
        db_path=None,
        expires_at=9999999999.0,
    )
    released: list[RuntimeLockLease | None] = []

    async def failing_plan_outline(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("plan failed with sk-should-not-persist-123456")

    monkeypatch.setattr(builder, "plan_outline", failing_plan_outline)
    monkeypatch.setattr(
        builder,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: lease,
        raising=False,
    )
    monkeypatch.setattr(
        builder,
        "release_runtime_lock",
        lambda next_lease: released.append(next_lease) or True,
        raising=False,
    )

    with pytest.raises(RuntimeError, match="plan failed"):
        await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert released == [lease]
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "failed"
    assert persisted.tier == "static"
    assert persisted.sections == []
    assert "should-not-persist" not in json.dumps(
        persisted.model_dump(mode="json"),
        ensure_ascii=False,
    )


@pytest.mark.asyncio
async def test_build_report_rejects_cross_worker_duplicate_without_persisting(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()

    async def unexpected_llm_call(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("LLM must not run when another worker owns the report lock")

    monkeypatch.setattr(builder, "llm_call_json", unexpected_llm_call)
    monkeypatch.setattr(
        builder,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: None,
        raising=False,
    )

    with pytest.raises(builder.ResultReportBuilderError, match="already in progress"):
        await builder.build_report(scenario_id, "branch-a", overrides=None)

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert "full_report" not in (scenario.parsed_context or {})


@pytest.mark.asyncio
async def test_build_report_retry_reuses_matching_persisted_sections(monkeypatch):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    existing = _legal_full_report()
    existing["status"] = "partial"
    existing["target_branch_id"] = "branch-a"
    existing["sections"][0]["intent"] = "Explain timeline."
    existing["sections"][0]["evidence_refs"] = ["ev_001"]
    existing["evidence"][0]["id"] = "ev_001"
    existing["indicators_to_watch"][0]["evidence_refs"] = ["ev_001"]
    builder._persist_report_payload(scenario_id, existing)
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("sources"),
        ],
    )
    generated_sections: list[str] = []
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)
    original_generate = builder.generate_section_react

    async def capture_generated_section(*args: Any, **kwargs: Any):
        section_plan = args[1]
        generated_sections.append(section_plan.section_id)
        return await original_generate(*args, **kwargs)

    monkeypatch.setattr(builder, "generate_section_react", capture_generated_section)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert [section.id for section in report.sections] == ["timeline", "sources"]
    assert generated_sections == ["sources"]


def test_report_generate_sse_endpoint_emits_progress_and_scrubs_byok(monkeypatch):
    import app.api.scenarios as scenarios_api
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline"]),
            _section_payload("timeline"),
        ],
    )
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)
    client = TestClient(app)

    with client.stream(
        "POST",
        f"/api/scenario/{scenario_id}/report:generate",
        json={
            "llm_api_key": "sk-test-secret-12345678",
            "llm_base_url": "http://127.0.0.1:8317/v1",
            "llm_model": "test-model",
        },
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join(response.iter_text())

    assert "event: report_started" in body
    assert "event: report_section_complete" in body
    assert "event: report_complete" in body
    assert "sk-test-secret" not in body
    assert "api_key" not in body
    assert "Bearer " not in body
    validate_full_report_payload(_persisted_report(scenario_id))


def test_report_generate_sse_endpoint_requires_completed_scenario(monkeypatch):
    import app.api.scenarios as scenarios_api
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.status = ScenarioStatus.SIMULATING
        session.add(scenario)
        session.commit()

    stream_called = False

    async def fake_report_stream(*_args: Any, **_kwargs: Any):
        nonlocal stream_called
        stream_called = True
        yield "event: report_started\n\n"

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(builder, "build_report_sse_stream", fake_report_stream)
    client = TestClient(app)

    response = client.post(f"/api/scenario/{scenario_id}/report:generate")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "REPORT_SCENARIO_NOT_COMPLETE"
    assert stream_called is False


def test_report_generate_sse_endpoint_requires_completed_branch(monkeypatch):
    import app.api.scenarios as scenarios_api
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    with Session(get_engine()) as session:
        branches = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).all()
        for branch in branches:
            branch.status = BranchStatus.ACTIVE
            session.add(branch)
        session.commit()

    stream_called = False

    async def fake_report_stream(*_args: Any, **_kwargs: Any):
        nonlocal stream_called
        stream_called = True
        yield "event: report_started\n\n"

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(builder, "build_report_sse_stream", fake_report_stream)
    client = TestClient(app)

    response = client.post(f"/api/scenario/{scenario_id}/report:generate")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "REPORT_BRANCH_NOT_READY"
    assert stream_called is False


@pytest.mark.asyncio
async def test_report_failure_redacts_credentials_from_sse_and_background_logs(
    monkeypatch,
    caplog,
):
    import app.api.helpers as api_helpers
    from app.services.result_report import builder

    secret_error = (
        "upstream failed Authorization: Bearer sk-LEAKEDabcdef123456 "
        "api_key=SECRETabcdef123456 xai-LEAKEDabcdef123456 "
        "sk-ant-LEAKEDabcdef123456 "
        "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo123456"
    )
    report_called = 0

    async def failing_build_report(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal report_called
        report_called += 1
        raise RuntimeError(secret_error)

    monkeypatch.setattr(builder, "build_report", failing_build_report)
    caplog.set_level(logging.ERROR)

    frames = []
    async for frame in builder.build_report_sse_stream(
        "scenario-report",
        "branch-a",
        overrides={"api_key": "sk-request-key-123456"},
    ):
        frames.append(frame)
    body = "".join(frames)

    task = api_helpers.schedule_background_task(
        builder.build_report("scenario-report", "branch-a", overrides=None)
    )
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert task.done()
    assert report_called == 2
    assert "event: report_failed" in body
    assert "REPORT_FAILED" in body
    assert "Report generation failed" in body
    combined_logs = "\n".join(record.getMessage() for record in caplog.records)
    combined_output = body + "\n" + combined_logs
    assert "LEAKED" not in combined_output
    assert "SECRET" not in combined_output
    assert "Bearer sk-" not in combined_output
    assert "api_key=" not in combined_output
    assert "xai-LEAKED" not in combined_output
    assert "sk-ant-LEAKED" not in combined_output
    assert "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo123456" not in combined_output
    assert all(record.exc_info is None for record in caplog.records)


@pytest.mark.asyncio
async def test_report_sse_stream_uses_already_running_error_code(monkeypatch):
    from app.services.result_report import builder

    async def already_running(*_args: Any, **_kwargs: Any) -> FullReport:
        raise builder.ResultReportAlreadyRunningError("already in progress")

    monkeypatch.setattr(builder, "build_report", already_running)

    frames = []
    async for frame in builder.build_report_sse_stream(
        "scenario-report",
        "branch-a",
        overrides=None,
    ):
        frames.append(frame)

    body = "".join(frames)
    assert "event: report_failed" in body
    assert "REPORT_ALREADY_RUNNING" in body
    assert "REPORT_FAILED" not in body


@pytest.mark.asyncio
async def test_report_sse_stream_emits_keepalive_comment_while_waiting(monkeypatch):
    from app.services.result_report import builder

    started = asyncio.Event()

    async def slow_build_report(*_args: Any, **_kwargs: Any) -> FullReport:
        started.set()
        await asyncio.sleep(60)
        raise AssertionError("unreachable")

    monkeypatch.setattr(builder, "build_report", slow_build_report)
    monkeypatch.setattr(builder, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.01, raising=False)

    stream = builder.build_report_sse_stream(
        "scenario-report",
        "branch-a",
        overrides=None,
    )
    assert "event: report_started" in await anext(stream)

    try:
        heartbeat = await asyncio.wait_for(anext(stream), timeout=0.2)
        assert heartbeat.startswith(":")
    finally:
        await stream.aclose()


@pytest.mark.asyncio
async def test_report_generate_sse_stream_cancels_builder_on_client_disconnect(
    monkeypatch,
):
    from app.services.result_report import builder

    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def slow_build_report(*_args: Any, **_kwargs: Any) -> FullReport:
        started.set()
        try:
            await asyncio.sleep(60)
        finally:
            cancelled.set()
        raise AssertionError("unreachable")

    monkeypatch.setattr(builder, "build_report", slow_build_report)

    stream = builder.build_report_sse_stream(
        "scenario-report",
        "branch-a",
        overrides={"api_key": "sk-request-key-123456"},
    )
    assert "event: report_started" in await anext(stream)

    pending_frame = asyncio.create_task(anext(stream))
    await asyncio.wait_for(started.wait(), timeout=1)
    pending_frame.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await pending_frame

    await asyncio.wait_for(cancelled.wait(), timeout=1)


@pytest.mark.asyncio
async def test_report_failure_does_not_block_simulation_done(monkeypatch):
    import app.services.simulator as simulator_module
    from app.services.simulator import run_simulation

    engine = get_engine()
    scenario = Scenario(
        question="Can the habitat survive one more week?",
        parsed_context={
            "_language": "English",
            "setting": {},
            "simulation_rounds": 1,
            "mode": "raw",
        },
        status=ScenarioStatus.SIMULATING,
    )
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Systems Lead",
                role="Engineer",
            )
        )
        session.commit()

    events: list[dict[str, Any]] = []

    async def fake_ws_callback(_scenario_id: str, event: dict[str, Any]) -> None:
        events.append(event)

    async def fake_llm_json(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"content": "Life support stays stable.", "emotion": "focused"}

    async def fake_llm_text(*_args: Any, **_kwargs: Any) -> str:
        return "Life support stays stable."

    async def fake_narrate_branch(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "title": "Stabilize first",
            "story": "The habitat survives by prioritizing life support.",
            "insight": "Repair sequencing matters more than expansion.",
            "key_moments": [],
        }

    report_called = asyncio.Event()
    report_call_count = 0

    async def failing_build_report(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal report_call_count
        report_call_count += 1
        report_called.set()
        raise RuntimeError("report builder unavailable")

    monkeypatch.setattr(simulator_module.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(simulator_module.settings, "FEATURE_RESULT_VERDICT", False)
    monkeypatch.setattr(
        "app.services.simulator.llm_call_json_with_stream_fallback",
        fake_llm_json,
    )
    monkeypatch.setattr("app.services.simulator.llm_call", fake_llm_text)
    monkeypatch.setattr("app.services.simulator.llm_call_json", fake_llm_json)
    monkeypatch.setattr("app.services.simulator.narrate_branch", fake_narrate_branch)
    monkeypatch.setattr("app.services.simulator.retrieve_relevant_memories", lambda *a, **k: "")
    monkeypatch.setattr("app.services.simulator.store_memory", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.services.result_report.builder.build_report",
        failing_build_report,
    )

    await run_simulation(scenario_id, ws_callback=fake_ws_callback)
    await asyncio.sleep(0)

    await asyncio.wait_for(report_called.wait(), timeout=1)
    assert report_call_count == 1
    assert any(event.get("type") == "simulation_done" for event in events)
    deadline = time.monotonic() + 1.0
    report: dict[str, Any] | None = None
    persisted_status: ScenarioStatus | None = None
    while time.monotonic() < deadline:
        with Session(engine) as session:
            persisted = session.get(Scenario, scenario_id)
            assert persisted is not None
            persisted_status = persisted.status
            candidate = (persisted.parsed_context or {}).get("full_report")
            if isinstance(candidate, dict):
                report = candidate
                break
        await asyncio.sleep(0.01)

    assert persisted_status == ScenarioStatus.DONE
    assert report is not None
    validated = validate_full_report_payload(report)
    assert validated.status == "failed"
    assert validated.generation_mode == "static"
    assert validated.tier == "static"
    assert validated.sections == []


@pytest.mark.asyncio
async def test_simulator_preserves_opaque_api_key_for_report_generation(monkeypatch):
    import app.services.simulator as simulator_module
    from app.api.helpers import _OpaqueStr
    from app.services.simulator import run_simulation

    engine = get_engine()
    scenario = Scenario(
        question="Can the habitat survive one more week?",
        parsed_context={
            "_language": "English",
            "setting": {},
            "simulation_rounds": 1,
            "mode": "raw",
        },
        status=ScenarioStatus.SIMULATING,
    )
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Systems Lead",
                role="Engineer",
            )
        )
        session.commit()

    async def fake_ws_callback(_scenario_id: str, _event: dict[str, Any]) -> None:
        return None

    async def fake_llm_json(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"content": "Life support stays stable.", "emotion": "focused"}

    async def fake_narrate_branch(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "title": "Stabilize first",
            "story": "The habitat survives by prioritizing life support.",
            "insight": "Repair sequencing matters more than expansion.",
            "key_moments": [],
        }

    captured_overrides: dict[str, Any] = {}

    async def fake_build_report_safe(*_args: Any, **kwargs: Any) -> None:
        captured_overrides.update(kwargs["overrides"])
        return None

    monkeypatch.setattr(simulator_module.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(simulator_module.settings, "FEATURE_RESULT_VERDICT", False)
    monkeypatch.setattr(
        "app.services.simulator.llm_call_json_with_stream_fallback",
        fake_llm_json,
    )
    monkeypatch.setattr("app.services.simulator.llm_call_json", fake_llm_json)
    monkeypatch.setattr("app.services.simulator.narrate_branch", fake_narrate_branch)
    monkeypatch.setattr("app.services.simulator.retrieve_relevant_memories", lambda *a, **k: "")
    monkeypatch.setattr("app.services.simulator.store_memory", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.services.result_report.builder.build_report_safe",
        fake_build_report_safe,
    )

    secret = _OpaqueStr("sk-report-secret")
    await run_simulation(
        scenario_id,
        ws_callback=fake_ws_callback,
        llm_overrides={
            "api_key": secret,
            "base_url": "https://example.com/v1/chat/completions",
            "model": "model-a",
            "temperature": 0.2,
        },
    )
    await asyncio.sleep(0)

    assert captured_overrides["api_key"] is secret
    assert repr(captured_overrides) == (
        "{'api_key': ***, 'base_url': 'https://example.com/v1/chat/completions', "
        "'model': 'model-a', 'temperature': 0.2}"
    )


def test_sse_event_shape_remains_frozen_for_progress_payloads() -> None:
    event = ResultReportSSEEvent(
        event="report_section_complete",
        data={
            "report_id": "scenario-report",
            "section_id": "timeline",
            "status": "complete",
            "tool_trace": [
                {
                    "tool": "query_branch_messages",
                    "query": "timeline",
                    "item_count": 2,
                    "elapsed_ms": 1,
                },
            ],
        },
    )

    assert event.event == "report_section_complete"
    assert event.data.tool_trace[0].tool == "query_branch_messages"
