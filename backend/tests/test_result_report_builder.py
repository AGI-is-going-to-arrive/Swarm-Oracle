"""Sprint S2 tests for fail-soft result report generation."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import replace
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
from app.services.branch_lineage import BranchLineageError
from app.services.result_report import builder
from app.services.result_report.reducer import StatResult
from app.services.result_report.schema import (
    FullReport,
    I18nText,
    Likelihood,
    ReportSection,
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


def test_affect_proxy_is_not_promoted_to_any_causal_indicator():
    scenario_id = _seed_report_scenario()
    reducer_result = replace(
        builder.reduce_report(get_engine(), scenario_id),
        polarization=StatResult(status="available", value=0.82),
        agent_consensus=StatResult(status="available", value=0.64),
    )

    indicator = builder._stat_signal_indicator(
        reducer_result,
        allowed_evidence_ids=set(),
        language="en",
    )

    assert indicator is None


def test_indicators_prompt_discloses_the_noncausal_affect_proxy_semantics():
    scenario_id = _seed_report_scenario()
    reducer_result = replace(
        builder.reduce_report(get_engine(), scenario_id),
        polarization=StatResult(status="available", value=0.82),
        agent_consensus=StatResult(
            status="partial",
            value=0.64,
            reason="metadata_unavailable",
        ),
    )
    context = builder.BuilderContext(
        scenario_id=scenario_id,
        question="Should the city approve the AI transit plan?",
        language="en",
        parsed_context={},
        branch_id="branch-a",
        branch_title="Approval with safeguards",
        branch_story="The proposal passes with safeguards.",
        branch_insight="Safeguards unlock support.",
        web_context_blocks=[],
    )

    prompt = builder._build_indicators_prompt(context, reducer_result)

    assert '"simulated_affect_dispersion_proxy":0.82' in prompt
    assert '"simulated_affect_convergence_proxy_status":"partial"' in prompt
    assert '"simulated_affect_convergence_proxy_reason":"metadata_unavailable"' in prompt
    assert '"polarization"' not in prompt
    assert "not verified stance, trust, or real-world polarization" in prompt


def test_report_scope_kwargs_inherits_profile_runtime_fields():
    from app.services.result_report import builder

    context = builder.BuilderContext(
        scenario_id="scenario-report-scope",
        question="Can report scopes inherit profile runtime fields?",
        language="en",
        parsed_context={
            "user_id": "report-owner",
            "llm_requests_per_minute": 11,
            "llm_tokens_per_minute": 11000,
            "llm_concurrency": 2,
            "supports_structured_outputs": False,
            "supports_native_search": True,
        },
        branch_id="branch-a",
        branch_title="Branch A",
        branch_story="Story",
        branch_insight="Insight",
        web_context_blocks=[],
    )

    inherited = builder._report_llm_scope_kwargs(context, None)
    assert inherited["requests_per_minute"] == 11
    assert inherited["tokens_per_minute"] == 11000
    assert inherited["concurrency"] == 2
    assert inherited["supports_structured_outputs_override"] is False
    assert inherited["supports_native_search_override"] is True

    overrides = builder._normalize_overrides(
        {
            "concurrency": 4,
            "supports_structured_outputs_override": True,
            "supports_native_search_override": False,
        }
    )
    override_scope = builder._report_llm_scope_kwargs(context, overrides)
    assert override_scope["concurrency"] == 4
    assert override_scope["supports_structured_outputs_override"] is True
    assert override_scope["supports_native_search_override"] is False

    profile_only_context = builder.BuilderContext(
        scenario_id="scenario-report-profile-only-scope",
        question="Can profile-only reports keep their quota identity?",
        language="en",
        parsed_context={
            "_language": "English",
            "model_profile_id": "profile-only-report",
        },
        branch_id="branch-a",
        branch_title="Branch A",
        branch_story="Story",
        branch_insight="Insight",
        web_context_blocks=[],
    )
    profile_overrides = builder._normalize_overrides(
        {
            "quota_user_id": "report-owner",
            "concurrency": 3,
        }
    )
    profile_scope = builder._report_llm_scope_kwargs(
        profile_only_context,
        profile_overrides,
    )
    assert profile_scope["quota_key"] == "user:report-owner"
    assert profile_scope["concurrency"] == 3

    detached_overrides = builder._normalize_overrides(
        {
            "base_url": "https://provider-b.example/v1",
            "model": "provider-b-model",
            "inherit_context_policy": False,
        }
    )
    detached_scope = builder._report_llm_scope_kwargs(context, detached_overrides)
    assert detached_scope["requests_per_minute"] is None
    assert detached_scope["tokens_per_minute"] is None
    assert detached_scope["concurrency"] is None
    assert detached_scope["supports_structured_outputs_override"] is None
    assert detached_scope["supports_native_search_override"] is None
    assert detached_scope["native_search_upstream_override"] is None


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


def _builder_context() -> builder.BuilderContext:
    return builder.BuilderContext(
        scenario_id="scenario-report",
        question="Should the city approve the AI transit plan?",
        language="en",
        parsed_context={},
        branch_id="branch-a",
        branch_title="Approval with safeguards",
        branch_story="The proposal passes with safeguards.",
        branch_insight="Safeguards unlock support.",
        web_context_blocks=[],
    )


def _reducer_result_with_premortem_evidence():
    scenario_id = _seed_report_scenario()
    base = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="branch-a",
        max_evidence=2,
    )
    outcome = [
        item for item in base.evidence if item.id in set(base.outcome_evidence_ids)
    ]
    assert outcome
    next_index = len(outcome) + 1
    first = outcome[0].model_copy(
        update={
            "id": f"ev_{next_index:03d}",
            "round_id": "pm-round-a",
            "round_number": 3,
            "message_id": "pm-message-a",
            "quote": "The safeguards can fail if the amendment is withdrawn.",
        }
    )
    second = outcome[0].model_copy(
        update={
            "id": f"ev_{next_index + 1:03d}",
            "branch_id": "branch-b",
            "round_id": "pm-round-b",
            "round_number": 4,
            "agent_id": "agent-planner",
            "agent_name": "Transit Planner",
            "message_id": "pm-message-b",
            "quote": "Budget opposition can dissolve the coalition.",
        }
    )
    return replace(
        base,
        evidence=[*outcome, first, second],
        outcome_evidence_ids=tuple(item.id for item in outcome),
        premortem_evidence_ids=(first.id, second.id),
    )


def _premortem_payload(*evidence_refs: str) -> dict[str, Any]:
    return {
        "action": "premortem_analysis",
        "items": [
            {
                "failure_mode_i18n": {
                    "zh": "隐私与预算联盟瓦解",
                    "en": "The privacy and budget coalition collapses",
                },
                "mechanism_i18n": {
                    "zh": "保障条款撤回后，关键支持者退出。",
                    "en": "Key supporters exit after safeguards are withdrawn.",
                },
                "early_warning_i18n": {
                    "zh": "委员会停止承诺保障条款。",
                    "en": "The committee stops committing to safeguards.",
                },
                "uncertainty_i18n": {
                    "zh": "模拟只覆盖有限轮次。",
                    "en": "The simulation covers only bounded rounds.",
                },
                "evidence_chain": [
                    {
                        "evidence_ref": evidence_ref,
                        "role": (
                            "failure_signal" if index == 0 else "failure_mechanism"
                        ),
                        "rationale_i18n": {
                            "zh": f"证据 {evidence_ref} 标记失败路径。",
                            "en": f"Evidence {evidence_ref} marks the failure path.",
                        },
                    }
                    for index, evidence_ref in enumerate(evidence_refs)
                ],
            }
        ],
    }


def _assembled_report_with_partial_premortem(item_count: int = 2):
    reducer_result = _reducer_result_with_premortem_evidence()
    raw_items = [
        _premortem_payload(evidence_id)["items"][0]
        for evidence_id in reducer_result.premortem_evidence_ids[:item_count]
    ]
    analysis = builder._normalize_premortem_payload(
        {"action": "premortem_analysis", "items": raw_items},
        reducer_result,
    )
    context = _builder_context()
    outline = builder.ReportOutline(
        title_i18n={"zh": "标题", "en": "Title"},
        summary_i18n={"zh": "摘要", "en": "Summary"},
        sections=[],
    )
    section = builder.ReportSection(
        id="timeline",
        title="Timeline",
        title_i18n=I18nText(zh="关键转折", en="Timeline"),
        intent="Explain timeline.",
        body_md_i18n=I18nText(zh="短正文", en="Short body"),
        evidence_refs=[reducer_result.outcome_evidence_ids[0]],
        charts=[],
        tier="generation",
        failure_reason=None,
    )
    report = builder._assemble_report(
        context,
        reducer_result,
        outline,
        sections=[section],
        status="partial",
        tier="generation",
        premortem_analysis=analysis,
    )
    return report, reducer_result


def test_outline_prompt_requires_publication_voice_for_title_and_summary():
    scenario_id = _seed_report_scenario()
    reducer_result = builder.reduce_report(get_engine(), scenario_id)
    context = builder.BuilderContext(
        scenario_id=scenario_id,
        question="巴西能否夺得2026世界杯？",
        language="zh",
        parsed_context={},
        branch_id="branch-a",
        branch_title="巴西冲冠线",
        branch_story="淘汰赛一路走到决赛。",
        branch_insight="夺冠路径存在但不是确定结论。",
        web_context_blocks=[],
    )

    prompt = builder._build_outline_prompt(context, reducer_result)

    assert "final publication title" in prompt
    assert "提纲" in prompt
    assert "This report will" in prompt
    assert "completed voice" in prompt


def test_ordinary_report_views_expose_only_outcome_evidence_ids():
    reducer_result = _reducer_result_with_premortem_evidence()
    context = _builder_context()
    outcome_id = reducer_result.outcome_evidence_ids[0]
    premortem_ids = set(reducer_result.premortem_evidence_ids)
    section = builder.SectionPlan(
        section_id="timeline",
        title_i18n={"zh": "关键转折", "en": "Turning points"},
        intent="Explain the turning points.",
    )

    prompts = [
        builder._build_outline_prompt(context, reducer_result),
        builder._build_section_prompt(
            context,
            section,
            reducer_result,
            tier="generation",
            history=[],
        ),
        builder._build_indicators_prompt(context, reducer_result),
    ]
    tool_payload, _item_count = builder._tool_query_branch_messages(
        context,
        reducer_result,
        section,
    )
    ordinary_blob = "\n".join([*prompts, tool_payload])
    assert outcome_id in ordinary_blob
    assert all(evidence_id not in ordinary_blob for evidence_id in premortem_ids)

    section_result = builder._section_result_from_payload(
        section,
        {
            "action": "final_section",
            "body_md_i18n": {"zh": "正文", "en": "Body"},
            "evidence_refs": [
                reducer_result.premortem_evidence_ids[0],
                outcome_id,
            ],
        },
        reducer_result,
        tier="generation",
        trace=[],
    )
    static_result = builder._static_section_from_context(
        context,
        section,
        reducer_result,
    )
    indicators = builder._normalize_indicators_payload(
        {
            "action": "indicators_to_watch",
            "indicators": [
                {
                    "signal": "A binding amendment is published",
                    "direction": "up",
                    "note": "The amendment would preserve the coalition.",
                    "threshold": "A recorded vote adopts the safeguards.",
                    "evidence_refs": [
                        reducer_result.premortem_evidence_ids[0],
                        outcome_id,
                    ],
                }
            ],
        },
        context,
        reducer_result,
    )

    assert section_result.section.evidence_refs == [outcome_id]
    assert set(static_result.section.evidence_refs) <= set(
        reducer_result.outcome_evidence_ids
    )
    assert indicators[0].evidence_refs == [outcome_id]


def test_new_outline_filters_ordinary_premortem_section():
    outline = builder._normalize_outline_payload(
        _outline_payload(["premortem", "timeline"]),
        _builder_context(),
    )

    assert "premortem" not in {section.section_id for section in outline.sections}


@pytest.mark.asyncio
async def test_premortem_without_independent_evidence_skips_llm(monkeypatch):
    reducer_result = _reducer_result_with_premortem_evidence()
    reducer_result = replace(
        reducer_result,
        evidence=[
            item
            for item in reducer_result.evidence
            if item.id in set(reducer_result.outcome_evidence_ids)
        ],
        premortem_evidence_ids=(),
    )

    async def fail_llm(*_args: Any, **_kwargs: Any):
        raise AssertionError("premortem LLM must be skipped without independent ids")

    monkeypatch.setattr(builder, "llm_call_json", fail_llm)

    analysis = await builder._build_premortem_analysis(
        _builder_context(),
        reducer_result,
        overrides=None,
    )

    assert analysis.status == "missing"
    assert analysis.reason == "no_distinct_evidence"
    assert analysis.items == []


@pytest.mark.asyncio
async def test_premortem_llm_valid_payload_uses_only_independent_pool(monkeypatch):
    reducer_result = _reducer_result_with_premortem_evidence()
    fake_llm = QueuedLlm(
        [_premortem_payload(*reducer_result.premortem_evidence_ids)]
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    analysis = await builder._build_premortem_analysis(
        _builder_context(),
        reducer_result,
        overrides=None,
    )

    assert analysis.status == "available"
    assert analysis.reason is None
    assert [item.id for item in analysis.items] == ["pm_001"]
    assert [
        link.evidence_ref for link in analysis.items[0].evidence_chain
    ] == list(reducer_result.premortem_evidence_ids)
    assert reducer_result.outcome_evidence_ids[0] not in fake_llm.prompts[0]


@pytest.mark.asyncio
async def test_premortem_normalizer_filters_overlap_unknown_blank_and_duplicates(
    monkeypatch,
):
    reducer_result = _reducer_result_with_premortem_evidence()
    valid_pm_id = reducer_result.premortem_evidence_ids[0]
    payload = _premortem_payload(
        reducer_result.outcome_evidence_ids[0],
        "ev_unknown",
        "",
        valid_pm_id,
        valid_pm_id,
    )
    monkeypatch.setattr(builder, "llm_call_json", QueuedLlm([payload]))

    analysis = await builder._build_premortem_analysis(
        _builder_context(),
        reducer_result,
        overrides=None,
    )

    assert analysis.status == "partial"
    assert analysis.reason == "insufficient_source_diversity"
    assert [
        link.evidence_ref for link in analysis.items[0].evidence_chain
    ] == [valid_pm_id]


@pytest.mark.asyncio
async def test_premortem_normalizer_rejects_blank_i18n_and_rationale(monkeypatch):
    reducer_result = _reducer_result_with_premortem_evidence()
    evidence_ids = reducer_result.premortem_evidence_ids
    invalid_item = _premortem_payload(*evidence_ids)["items"][0]
    invalid_item["failure_mode_i18n"]["zh"] = "   "
    valid_item = _premortem_payload(*evidence_ids)["items"][0]
    valid_item["failure_mode_i18n"] = {
        "zh": "有效失败模式",
        "en": "Valid failure mode",
    }
    valid_item["evidence_chain"][0]["rationale_i18n"]["en"] = "   "
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm([
            {
                "action": "premortem_analysis",
                "items": [invalid_item, valid_item],
            }
        ]),
    )

    analysis = await builder._build_premortem_analysis(
        _builder_context(),
        reducer_result,
        overrides=None,
    )

    assert [item.failure_mode_i18n.en for item in analysis.items] == [
        "Valid failure mode"
    ]
    assert [
        link.evidence_ref for link in analysis.items[0].evidence_chain
    ] == [evidence_ids[1]]
    assert analysis.status == "partial"
    assert analysis.reason == "insufficient_source_diversity"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        RuntimeError("provider failed"),
        {"action": "premortem_analysis", "items": []},
    ],
)
async def test_premortem_failure_or_empty_normalization_is_missing(
    monkeypatch,
    response,
):
    reducer_result = _reducer_result_with_premortem_evidence()
    monkeypatch.setattr(builder, "llm_call_json", QueuedLlm([response]))

    analysis = await builder._build_premortem_analysis(
        _builder_context(),
        reducer_result,
        overrides=None,
    )

    assert analysis.status == "missing"
    assert analysis.reason == "generation_failed"
    assert analysis.items == []


@pytest.mark.asyncio
async def test_build_report_persists_structured_premortem_and_pool_boundaries(
    monkeypatch,
):
    reducer_result = _reducer_result_with_premortem_evidence()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline"),
            _section_payload("sources"),
            _premortem_payload(*reducer_result.premortem_evidence_ids),
        ]
    )
    monkeypatch.setattr(builder, "reduce_report", lambda *_args, **_kwargs: reducer_result)
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(
        "scenario-report",
        "branch-a",
        overrides=None,
    )
    persisted = validate_full_report_payload(_persisted_report("scenario-report"))

    assert report.premortem == []
    assert report.premortem_analysis is not None
    assert report.premortem_analysis.status == "available"
    assert persisted.premortem_analysis == report.premortem_analysis
    outcome_ids = set(reducer_result.outcome_evidence_ids)
    premortem_ids = set(reducer_result.premortem_evidence_ids)
    assert all(set(section.evidence_refs) <= outcome_ids for section in report.sections)
    assert all(
        set(indicator.evidence_refs) <= outcome_ids
        for indicator in report.indicators_to_watch
    )
    assert {
        link.evidence_ref
        for item in report.premortem_analysis.items
        for link in item.evidence_chain
    } <= premortem_ids


def test_failed_report_placeholder_persists_structured_terminal_reason():
    scenario_id = _seed_report_scenario()

    report = builder._persist_failed_report_if_absent(scenario_id, "branch-a")

    assert report.premortem_analysis is not None
    assert report.premortem_analysis.status == "missing"
    assert report.premortem_analysis.reason == "report_generation_failed"
    assert _persisted_report(scenario_id)["premortem_analysis"] == {
        "status": "missing",
        "reason": "report_generation_failed",
        "items": [],
    }


def test_failed_report_assembly_overrides_nonterminal_premortem_state():
    partial_report, reducer_result = _assembled_report_with_partial_premortem(1)
    assert partial_report.premortem_analysis is not None
    failed = builder._assemble_report(
        _builder_context(),
        reducer_result,
        builder.ReportOutline(
            title_i18n={"zh": "标题", "en": "Title"},
            summary_i18n={"zh": "摘要", "en": "Summary"},
            sections=[],
        ),
        sections=partial_report.sections,
        status="failed",
        tier="generation",
        premortem_analysis=partial_report.premortem_analysis,
    )

    assert failed.premortem_analysis is not None
    assert failed.premortem_analysis.status == "missing"
    assert failed.premortem_analysis.reason == "report_generation_failed"
    assert failed.premortem_analysis.items == []


def test_structured_premortem_reuse_requires_stable_evidence_coordinates():
    reducer_result = _reducer_result_with_premortem_evidence()
    analysis = builder._normalize_premortem_payload(
        _premortem_payload(*reducer_result.premortem_evidence_ids),
        reducer_result,
    )
    context = _builder_context()
    outline = builder.ReportOutline(
        title_i18n={"zh": "标题", "en": "Title"},
        summary_i18n={"zh": "摘要", "en": "Summary"},
        sections=[],
    )
    existing = builder._assemble_report(
        context,
        reducer_result,
        outline,
        sections=[],
        status="complete",
        tier="generation",
        premortem_analysis=analysis,
    )

    assert builder._reusable_existing_premortem(existing, reducer_result) == analysis

    rebound = replace(
        reducer_result,
        evidence=[
            item.model_copy(update={"message_id": "rebound-message"})
            if item.id == reducer_result.premortem_evidence_ids[0]
            else item
            for item in reducer_result.evidence
        ],
    )
    assert builder._reusable_existing_premortem(existing, rebound) is None


def test_structured_premortem_reuse_requires_same_target_branch():
    reducer_result = _reducer_result_with_premortem_evidence()
    analysis = builder._normalize_premortem_payload(
        _premortem_payload(*reducer_result.premortem_evidence_ids),
        reducer_result,
    )
    existing = builder._assemble_report(
        _builder_context(),
        reducer_result,
        builder.ReportOutline(
            title_i18n={"zh": "标题", "en": "Title"},
            summary_i18n={"zh": "摘要", "en": "Summary"},
            sections=[],
        ),
        sections=[],
        status="complete",
        tier="generation",
        premortem_analysis=analysis,
    )
    assert existing.target_branch_id == "branch-a"

    retargeted = replace(reducer_result, target_branch_id="branch-b")

    assert builder._reusable_existing_premortem(existing, retargeted) is None


def test_legacy_premortem_section_is_reused_but_never_newly_planned():
    from tests.test_result_report_contract import _legal_full_report

    reducer_result = _reducer_result_with_premortem_evidence()
    existing = _legal_full_report()
    existing["status"] = "partial"
    existing["target_branch_id"] = "branch-a"
    existing["sections"][0]["intent"] = "Explain timeline."
    existing["sections"][0]["evidence_refs"] = [
        reducer_result.outcome_evidence_ids[0]
    ]
    existing["sections"].append(
        {
            "id": "premortem",
            "title": "Legacy premortem",
            "title_i18n": {"zh": "旧失败预演", "en": "Legacy premortem"},
            "intent": "Render the persisted legacy premortem.",
            "body_md_i18n": {"zh": "旧内容", "en": "Legacy content"},
            "evidence_refs": [],
            "charts": [],
            "tier": "generation",
            "failure_reason": None,
        }
    )
    existing["evidence"] = [
        item.model_dump(mode="json")
        for item in reducer_result.evidence
        if item.id in set(reducer_result.outcome_evidence_ids)
    ]
    existing["indicators_to_watch"][0]["evidence_refs"] = [
        reducer_result.outcome_evidence_ids[0]
    ]
    builder._persist_report_payload("scenario-report", existing)
    outline = builder.ReportOutline(
        title_i18n={"zh": "标题", "en": "Title"},
        summary_i18n={"zh": "摘要", "en": "Summary"},
        sections=[
            builder.SectionPlan(
                section_id="timeline",
                title_i18n={"zh": "关键转折", "en": "Turning points"},
                intent="Explain timeline.",
            )
        ],
    )

    sections, _tiers = builder._reusable_existing_sections(
        "scenario-report",
        "branch-a",
        outline,
        current_evidence=[
            item
            for item in reducer_result.evidence
            if item.id in set(reducer_result.outcome_evidence_ids)
        ],
    )

    assert [section.id for section in sections] == ["timeline", "premortem"]


def test_polish_report_title_summary_removes_planning_voice_examples():
    title, summary = builder._polish_report_title_summary(
        I18nText(
            zh="巴西能否夺得2026世界杯：SwarmOracle报告大纲",
            en="Can Brazil win the 2026 World Cup: SwarmOracle Report Outline",
        ),
        I18nText(
            zh="本报告将评估：巴西队在不同世界线中夺得2026世界杯的可能性。",
            en="This report will examine whether Brazil can win the 2026 World Cup.",
        ),
    )
    assert title.zh == "巴西能否夺得2026世界杯"
    assert title.en == "Can Brazil win the 2026 World Cup"
    assert summary.zh == "本报告评估：巴西队在不同世界线中夺得2026世界杯的可能性。"
    assert summary.en == "This report examines whether Brazil can win the 2026 World Cup."

    title, summary = builder._polish_report_title_summary(
        I18nText(
            zh="巴西能否夺得2026年世界杯冠军：SwarmOracle分析报告提纲",
            en="GPT-5.6 Release Timing Report Outline",
        ),
        I18nText(
            zh="报告将核查GPT-5.6发布时间是否已经被确证。",
            en="This report will assess the release evidence.",
        ),
    )
    assert title.zh == "巴西能否夺得2026年世界杯冠军"
    assert title.en == "GPT-5.6 Release Timing"
    assert summary.zh == "报告核查GPT-5.6发布时间是否已经被确证。"
    assert summary.en == "This report assesses the release evidence."

    title, _summary = builder._polish_report_title_summary(
        I18nText(zh="GPT-5.6发布时间确证报告大纲", en="GPT-5.6 release confirmation"),
        I18nText(zh="本报告围绕证据链展开。", en="The report reviews the evidence."),
    )
    assert title.zh == "GPT-5.6发布时间确证"

    title, _summary = builder._polish_report_title_summary(
        I18nText(zh="隆中对策纲要", en="Strategic Outline"),
        I18nText(zh="本报告围绕原文展开。", en="The report reviews the source text."),
    )
    assert title.zh == "隆中对策纲要"
    assert title.en == "Strategic Outline"


class QueuedLlm:
    # Responses are consumed strictly FIFO, EXCEPT for the interview/indicators
    # success-path calls. Those two now run concurrently (M-2 asyncio.gather), so a
    # blind pop(0) would race and misroute their payloads. To keep these stubs
    # order-independent, a prompt tagged REPORT_INTERVIEWS / REPORT_INDICATORS is
    # served the queued payload whose ``action`` matches that call type (if present);
    # otherwise it falls back to the FIFO head, preserving the "queue exhausted →
    # fail-soft" semantics tests rely on for the non-served call.
    _PROMPT_ACTION = {
        "REPORT_INTERVIEWS": "interview_agents",
        "REPORT_INDICATORS": "indicators_to_watch",
        "REPORT_PREMORTEM": "premortem_analysis",
    }

    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.prompts: list[str] = []

    def _pop_for_prompt(self, prompt: str) -> Any:
        for marker, action in self._PROMPT_ACTION.items():
            if prompt.startswith(marker):
                for index, candidate in enumerate(self.responses):
                    if isinstance(candidate, dict) and candidate.get("action") == action:
                        return self.responses.pop(index)
                # No dict payload tagged for this concurrent call. If a callable is
                # queued it self-routes by prompt, so fall through to FIFO. Otherwise
                # behave as exhausted for this call (-> fail-soft) rather than stealing
                # the sibling call's tagged payload.
                if not any(callable(candidate) for candidate in self.responses):
                    raise AssertionError("unexpected LLM call")
                break
        return self.responses.pop(0)

    async def __call__(self, prompt: str, **_kwargs: Any) -> dict[str, Any]:
        self.prompts.append(prompt)
        if not self.responses:
            raise AssertionError("unexpected LLM call")
        response = self._pop_for_prompt(prompt)
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


def _cancellation_outline() -> builder.ReportOutline:
    return builder.ReportOutline(
        title_i18n={"zh": "取消报告", "en": "Cancellation report"},
        summary_i18n={"zh": "取消摘要", "en": "Cancellation summary"},
        sections=[
            builder.SectionPlan(
                section_id=section_id,
                title_i18n={"zh": section_id, "en": section_id.title()},
                intent=f"Explain {section_id}.",
            )
            for section_id in ("timeline", "sources")
        ],
    )


def _generated_cancellation_section(
    section_plan: builder.SectionPlan,
) -> builder.SectionBuildResult:
    return builder.SectionBuildResult(
        section=ReportSection(
            id=section_plan.section_id,
            title=section_plan.title_i18n["en"],
            title_i18n=I18nText.model_validate(section_plan.title_i18n),
            intent=section_plan.intent,
            body_md_i18n=I18nText(
                zh=f"{section_plan.section_id} 已完成。",
                en=f"{section_plan.section_id} completed.",
            ),
            evidence_refs=["ev_001"],
            tier="generation",
        ),
        tier="generation",
        tool_trace=[],
    )


def _seed_suppressed_likelihood_report_scenario() -> str:
    scenario_id = "scenario-report-suppressed-zh"
    with Session(get_engine()) as session:
        scenario = Scenario(
            id=scenario_id,
            question="这项政策会通过吗？",
            status=ScenarioStatus.DONE,
            parsed_context={"_language": "zh"},
        )
        session.add(scenario)
        session.add(
            Agent(
                id="agent-suppressed",
                scenario_id=scenario.id,
                name="政策分析员",
                role="Analyst",
            )
        )
        session.add_all(
            [
                Branch(
                    id="branch-suppressed-root",
                    scenario_id=scenario.id,
                    title="根分支聚合",
                    story="根分支只是聚合文本。",
                    insight="它不是直接回答问题的世界线。",
                    probability=1.0,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                ),
                Branch(
                    id="branch-suppressed-child",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-suppressed-root",
                    title="政策调整线",
                    story="政策仍在调整。",
                    insight="没有分支级答案。",
                    probability=0.42,
                    fork_round=2,
                    status=BranchStatus.PRUNED,
                ),
            ]
        )
        session.commit()
    return scenario_id


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
    assert "effective root-to-leaf lineage" in report.limitations

    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "complete"
    assert persisted.evidence[0].agent_name == "Privacy Advocate"


@pytest.mark.asyncio
async def test_build_report_resolves_lineage_once_and_passes_scope_to_reducer(
    monkeypatch,
):
    scenario_id = _seed_report_scenario()
    real_resolver = builder.resolve_report_lineage_scope
    real_reduce = builder.reduce_report
    resolved_scopes = []
    reducer_scopes = []

    def capture_resolver(*args: Any, **kwargs: Any):
        report_scope = real_resolver(*args, **kwargs)
        resolved_scopes.append(report_scope)
        return report_scope

    def capture_reduce(*args: Any, **kwargs: Any):
        reducer_scopes.append(kwargs.get("report_scope"))
        return real_reduce(*args, **kwargs)

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", capture_resolver)
    monkeypatch.setattr(builder, "reduce_report", capture_reduce)
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm(
            [
                _outline_payload(["timeline", "sources"]),
                _section_payload("timeline"),
                _section_payload("sources"),
            ]
        ),
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert len(resolved_scopes) == 1
    assert resolved_scopes[0] is not None
    assert reducer_scopes == [resolved_scopes[0]]
    assert report.target_branch_id == resolved_scopes[0].target_branch_id


@pytest.mark.asyncio
async def test_build_report_reuses_genuine_preflight_scope_without_resolving_again(
    monkeypatch,
):
    scenario_id = _seed_report_scenario()
    report_scope = builder.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="branch-a",
    )
    assert report_scope is not None
    real_reduce = builder.reduce_report
    reducer_scopes = []

    def fail_resolver(*_args: Any, **_kwargs: Any):
        raise AssertionError("genuine preflight scope must not resolve again")

    def capture_reduce(*args: Any, **kwargs: Any):
        reducer_scopes.append(kwargs.get("report_scope"))
        return real_reduce(*args, **kwargs)

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", fail_resolver)
    monkeypatch.setattr(builder, "reduce_report", capture_reduce)
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm(
            [
                _outline_payload(["timeline", "sources"]),
                _section_payload("timeline"),
                _section_payload("sources"),
            ]
        ),
    )

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
        report_scope=report_scope,
    )

    assert reducer_scopes == [report_scope]
    assert report.target_branch_id == report_scope.target_branch_id


@pytest.mark.asyncio
async def test_build_report_persists_bounded_section_tool_trace(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            {"action": "query_branch_messages", "params": {"query": "timeline"}},
            _section_payload("timeline"),
            _section_payload("sources"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert len(report.tool_trace) == 1
    assert report.tool_trace[0].section_id == "timeline"
    assert report.tool_trace[0].tool == "query_branch_messages"
    assert report.tool_trace[0].query == "timeline"
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.tool_trace == report.tool_trace


@pytest.mark.asyncio
async def test_build_report_persists_tools_run_before_both_llm_tiers_fail(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline"]),
            {"action": "query_branch_messages", "params": {"query": "timeline"}},
            builder.ResultReportBuilderError(
                "generation failed after the tool call",
                reason="json_parse_error",
            ),
            {"action": "query_branch_messages", "params": {"query": "timeline"}},
            builder.ResultReportBuilderError(
                "rewrite failed after the tool call",
                reason="json_parse_error",
            ),
        ],
    )
    monkeypatch.setattr(builder.settings, "REPORT_MIN_SECTIONS", 1)
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    timeline = next(section for section in report.sections if section.id == "timeline")
    assert timeline.tier == "static"
    assert timeline.failure_reason == "json_parse_error"
    assert [
        (item.section_id, item.tool, item.query)
        for item in report.tool_trace
    ] == [
        ("timeline", "query_branch_messages", "timeline"),
        ("timeline", "query_branch_messages", "timeline"),
    ]
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.tool_trace == report.tool_trace


@pytest.mark.asyncio
async def test_build_report_persists_polished_outline_title_and_summary(monkeypatch):
    scenario_id = _seed_report_scenario()
    dirty_outline = _outline_payload(["timeline", "sources"])
    dirty_outline["title_i18n"] = {
        "zh": "巴西能否夺得2026世界杯：SwarmOracle报告大纲",
        "en": "Can Brazil win the 2026 World Cup: SwarmOracle Report Outline",
    }
    dirty_outline["summary_i18n"] = {
        "zh": "本报告将评估：巴西队在不同世界线中夺得2026世界杯的可能性。",
        "en": "This report will examine whether Brazil can win the 2026 World Cup.",
    }
    fake_llm = QueuedLlm(
        [
            dirty_outline,
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

    assert report.title_i18n.zh == "巴西能否夺得2026世界杯"
    assert report.title_i18n.en == "Can Brazil win the 2026 World Cup"
    assert report.summary_i18n.zh.startswith("本报告评估")
    assert report.summary_i18n.en.startswith("This report examines")
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.title_i18n.zh == report.title_i18n.zh
    assert persisted.summary_i18n.en == report.summary_i18n.en


@pytest.mark.asyncio
async def test_build_report_localizes_suppressed_likelihood_disclaimer_for_zh_report(
    monkeypatch,
):
    scenario_id = _seed_suppressed_likelihood_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline"]),
            _section_payload("timeline"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(
        scenario_id,
        "branch-suppressed-root",
        overrides=None,
    )

    assert report.language == "zh"
    assert report.verdict.disclaimer is not None
    assert "统计区间" in report.verdict.disclaimer
    assert "The report suppresses" not in report.verdict.disclaimer
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.verdict.disclaimer == report.verdict.disclaimer


@pytest.mark.asyncio
async def test_build_report_ignores_inherited_remote_byok_url_when_request_has_no_key(
    monkeypatch,
):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        parsed_context = dict(scenario.parsed_context or {})
        parsed_context["llm_base_url"] = "https://api.openai.com/v1"
        parsed_context["llm_model"] = "byok-profile-model"
        scenario.parsed_context = parsed_context
        session.add(scenario)
        session.commit()
    calls: list[dict[str, Any]] = []

    async def fake_llm(prompt: str, **kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        if (
            kwargs.get("api_key") is not None
            or kwargs.get("base_url") is not None
            or kwargs.get("model") is not None
        ):
            raise AssertionError(f"expected server default provider, got {kwargs!r}")
        if "REPORT_OUTLINE" in prompt:
            return _outline_payload(["timeline"])
        if "REPORT_INTERVIEWS" in prompt:
            return {"action": "interview_agents", "interview_evidence": []}
        return _section_payload("timeline")

    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    assert report.status == "complete"
    assert calls
    assert all(call.get("base_url") is None for call in calls)


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
        "stance_center": pytest.approx(0.91),
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


def test_interview_candidates_follow_exact_effective_lineage_with_true_branch_indices():
    from tests.test_result_report_reducer import _seed_report_lineage_scope_scenario

    scenario_id = _seed_report_lineage_scope_scenario()
    reducer_result = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
        max_evidence=20,
    )
    context = builder._load_builder_context(scenario_id, "report-leaf")

    candidates = builder._load_interview_candidates(context, reducer_result)

    assert [
        (candidate.agent_name, candidate.branch_index, candidate.round_number)
        for candidate in candidates
    ] == [
        ("Root Analyst", 0, 1),
        ("Child Analyst", 1, 3),
        ("Leaf Analyst", 2, 5),
    ]
    assert all(candidate.agent_name != "Noise Analyst" for candidate in candidates)


def test_interview_candidates_for_replay_clone_use_only_clone_round_ids():
    from tests.test_result_report_reducer import _seed_report_lineage_scope_scenario

    scenario_id = _seed_report_lineage_scope_scenario()
    reducer_result = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-clone",
        max_evidence=20,
    )
    context = builder._load_builder_context(scenario_id, "report-clone")

    candidates = builder._load_interview_candidates(context, reducer_result)

    assert [
        (candidate.agent_name, candidate.branch_index, candidate.round_number)
        for candidate in candidates
    ] == [("Clone Analyst", 4, 1)]


def test_interview_candidates_require_exact_authority_round_triples():
    from tests.test_result_report_reducer import _seed_report_lineage_scope_scenario

    scenario_id = _seed_report_lineage_scope_scenario()
    report_scope = builder.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
    )
    assert report_scope is not None
    reducer_result = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
        max_evidence=20,
        report_scope=report_scope,
    )
    context = builder._load_builder_context(scenario_id, "report-leaf")
    with Session(get_engine()) as session:
        rebound_round = session.get(Round, "report-leaf-5")
        assert rebound_round is not None
        rebound_round.branch_id = "report-sibling"
        session.add(rebound_round)
        session.add(
            AgentMessage(
                id="sentinel-rebound-round-message",
                round_id=rebound_round.id,
                agent_id="agent-lineage-noise",
                content="SENTINEL must not enter interview candidates.",
            )
        )
        session.commit()

    candidates = builder._load_interview_candidates(context, reducer_result)

    assert [
        (candidate.agent_name, candidate.branch_index, candidate.round_number)
        for candidate in candidates
    ] == [
        ("Root Analyst", 0, 1),
        ("Child Analyst", 1, 3),
    ]
    assert all("SENTINEL" not in candidate.excerpt for candidate in candidates)


def test_report_limitations_distinguish_native_lineage_from_self_contained_replay():
    from tests.test_result_report_reducer import _seed_report_lineage_scope_scenario

    scenario_id = _seed_report_lineage_scope_scenario()

    def assemble_for(branch_id: str) -> FullReport:
        reducer_result = builder.reduce_report(
            get_engine(),
            scenario_id,
            dominant_branch_id=branch_id,
            max_evidence=20,
        )
        context = builder._load_builder_context(scenario_id, branch_id)
        outline = builder._fallback_outline(context, reducer_result)
        return builder._assemble_report(
            context,
            reducer_result,
            outline,
            sections=[],
            status="complete",
            tier="static",
        )

    native_report = assemble_for("report-leaf")
    replay_report = assemble_for("report-clone")

    assert "effective root-to-leaf lineage" in native_report.limitations
    assert "inherited pre-fork ancestor rounds" in native_report.limitations
    assert "self-contained replay" in replay_report.limitations.lower()
    assert "clone's own materialized rounds" in replay_report.limitations
    assert "source or ancestor branch transcripts are not merged" in (
        replay_report.limitations
    )


@pytest.mark.asyncio
async def test_build_report_persists_generating_until_all_sections_finish(monkeypatch):
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
    original_generate = builder.generate_section_react
    observed_statuses: list[str] = []

    async def capture_status_before_each_section(*args: Any, **kwargs: Any):
        observed_statuses.append(_persisted_report(scenario_id)["status"])
        return await original_generate(*args, **kwargs)

    monkeypatch.setattr(
        builder,
        "generate_section_react",
        capture_status_before_each_section,
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert observed_statuses == ["generating", "generating"]


@pytest.mark.asyncio
async def test_missing_section_keeps_loop_generating_then_finishes_failed(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("sources"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)
    original_generate = builder.generate_section_react
    status_before_second: list[str] = []

    async def fail_first_and_capture_second(*args: Any, **kwargs: Any):
        section_plan = args[1]
        if section_plan.section_id == "timeline":
            raise RuntimeError("timeline section missing")
        status_before_second.append(_persisted_report(scenario_id)["status"])
        return await original_generate(*args, **kwargs)

    monkeypatch.setattr(
        builder,
        "generate_section_react",
        fail_first_and_capture_second,
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert status_before_second == ["generating"]
    assert report.status == "failed"
    assert [section.id for section in report.sections] == ["sources"]
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "failed"
    assert [section.id for section in persisted.sections] == ["sources"]


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

    assert report.status == "failed"
    assert report.summary_i18n.en
    assert [section.id for section in report.sections] == ["timeline"]
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "failed"
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
            {
                "action": "interview_agents",
                "interview_evidence": [
                    {
                        "agent_name": "Privacy Advocate",
                        "excerpt": "Privacy safeguards make the approval defensible.",
                    }
                ],
            },
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
    assert report.interview_evidence == [
        {
            "branch_index": 0,
            "round": 1,
            "agent_name": "Privacy Advocate",
            "excerpt": "Privacy safeguards make the approval defensible.",
        }
    ]
    assert report.interview_status is not None
    assert report.interview_status.status == "partial"
    assert report.interview_status.requested_agents == 2
    assert report.interview_status.completed_agents == 1
    # outline + generation + rewrite + interview + indicators (S3 LLM tier, which
    # fail-softs to the template here because the queue is exhausted).
    assert len(fake_llm.prompts) == 5
    assert any("tier=generation" in prompt for prompt in fake_llm.prompts)
    assert any("tier=rewrite" in prompt for prompt in fake_llm.prompts)
    assert any("REPORT_INTERVIEWS" in prompt for prompt in fake_llm.prompts)
    assert any("REPORT_INDICATORS" in prompt for prompt in fake_llm.prompts)
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.generation_mode == "static"
    assert persisted.interview_evidence == report.interview_evidence


@pytest.mark.asyncio
async def test_all_static_sections_complete_and_emit_bounded_observability(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    monkeypatch.setattr(
        builder,
        "llm_call_json",
        QueuedLlm([_outline_payload(["timeline", "sources"])]),
    )
    progress_events: list[ResultReportSSEEvent] = []

    async def static_section(*args: Any, **_kwargs: Any):
        return builder._static_section_from_context(
            args[0],
            args[1],
            args[2],
            failure_reason="timeout",
        )

    async def capture_progress(event: ResultReportSSEEvent) -> None:
        progress_events.append(event)

    monkeypatch.setattr(builder, "generate_section_react", static_section)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
        progress=capture_progress,
    )

    assert report.status == "complete"
    assert report.tier == "static"
    assert [section.tier for section in report.sections] == ["static", "static"]
    section_events = [
        event for event in progress_events
        if event.event == "report_section_complete"
    ]
    assert [event.data.tier for event in section_events] == ["static", "static"]
    assert [event.data.failure_reason for event in section_events] == ["timeout", "timeout"]


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
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", 4096)

    report = await builder.build_report(
        scenario_id,
        "branch-a",
        overrides=None,
    )
    payload = report.model_dump(mode="json")

    assert report.status == "failed"
    assert utf8_json_size_bytes(payload) <= 4096
    assert validate_full_report_payload(payload, max_bytes=4096).status == "failed"


@pytest.mark.parametrize(
    ("status", "expected_status"),
    [
        ("generating", "generating"),
        ("complete", "failed"),
        ("failed", "failed"),
        ("cancelled", "cancelled"),
        ("skipped", "skipped"),
        ("partial", "partial"),
    ],
)
def test_byte_cap_preserves_terminal_authority_and_fails_closed_complete(
    monkeypatch,
    status,
    expected_status,
):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    payload = _legal_full_report()
    payload["status"] = status
    payload["summary"] = "summary " * 2_000
    payload["summary_i18n"] = {
        "zh": "摘要" * 4_000,
        "en": "summary " * 2_000,
    }
    payload["sections"][0]["body_md_i18n"] = {
        "zh": "章节" * 6_000,
        "en": "section " * 3_000,
    }
    payload["evidence"][0]["quote"] = "evidence " * 2_000
    payload["limitations"] = "unsafe-sized-limitations " * 1_000
    report = FullReport.model_validate(payload)
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", 4096)

    fitted = builder._fit_report_to_byte_cap(report)
    fitted_payload = fitted.model_dump(mode="json")

    assert fitted.status == expected_status
    assert utf8_json_size_bytes(fitted_payload) <= 4096
    assert validate_full_report_payload(fitted_payload, max_bytes=4096) == fitted
    assert fitted.limitations == (
        "Report was truncated to fit the configured UTF-8 byte budget."
    )
    evidence_ids = {item.id for item in fitted.evidence}
    assert all(set(section.evidence_refs) <= evidence_ids for section in fitted.sections)
    assert all(
        set(indicator.evidence_refs) <= evidence_ids
        for indicator in fitted.indicators_to_watch
    )


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
    expected_payload["status"] = "failed"
    expected_payload["premortem_analysis"] = {
        "status": "missing",
        "reason": "report_generation_failed",
        "items": [],
    }
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


def test_byte_cap_preserves_existing_missing_premortem_reason(monkeypatch):
    from tests.test_result_report_contract import _legal_full_report

    payload = _legal_full_report()
    payload["premortem_analysis"] = {
        "status": "missing",
        "reason": "no_distinct_evidence",
        "items": [],
    }
    payload["status"] = "partial"
    payload["summary"] = "summary " * 2_000
    payload["summary_i18n"] = {
        "zh": "摘要" * 4_000,
        "en": "summary " * 2_000,
    }
    report = FullReport.model_validate(payload)
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", 4096)

    fitted = builder._fit_report_to_byte_cap(report)

    assert fitted.premortem_analysis is not None
    assert fitted.premortem_analysis.status == "missing"
    assert fitted.premortem_analysis.reason == "no_distinct_evidence"


def test_byte_cap_complete_failure_uses_terminal_premortem_reason(monkeypatch):
    report, _reducer_result = _assembled_report_with_partial_premortem(1)
    report = report.model_copy(
        deep=True,
        update={
            "status": "complete",
            "summary": "summary " * 2_000,
            "summary_i18n": I18nText(
                zh="摘要" * 4_000,
                en="summary " * 2_000,
            ),
        },
    )
    bounded_payload = report.model_dump(mode="json")
    bounded_payload["status"] = "failed"
    bounded_payload["summary"] = builder._truncate_text(
        bounded_payload["summary"],
        180,
    )
    bounded_payload["summary_i18n"] = builder._truncate_i18n(
        bounded_payload["summary_i18n"],
        180,
    )
    bounded_payload["limitations"] = (
        "Report was truncated to fit the configured UTF-8 byte budget."
    )
    builder._bound_payload_premortem_text(bounded_payload)
    max_bytes = utf8_json_size_bytes(bounded_payload) + 64
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", max_bytes)

    fitted = builder._fit_report_to_byte_cap(report)

    assert fitted.status == "failed"
    assert fitted.premortem_analysis is not None
    assert fitted.premortem_analysis.status == "missing"
    assert fitted.premortem_analysis.reason == "report_generation_failed"
    assert fitted.premortem_analysis.items == []


def test_byte_cap_bounds_structured_premortem_text_before_dropping_item(monkeypatch):
    report, _reducer_result = _assembled_report_with_partial_premortem(1)
    assert report.premortem_analysis is not None
    item = report.premortem_analysis.items[0]
    item.failure_mode_i18n.zh = "失败模式" * 2_000
    item.failure_mode_i18n.en = "failure mode " * 2_000
    original_id = item.id

    bounded_payload = report.model_dump(mode="json")
    bounded_payload["limitations"] = (
        "Report was truncated to fit the configured UTF-8 byte budget."
    )
    bounded_item = bounded_payload["premortem_analysis"]["items"][0]
    bounded_item["failure_mode_i18n"] = {
        "zh": builder._truncate_text(
            bounded_item["failure_mode_i18n"]["zh"],
            builder._PREMORTEM_TEXT_MAX_CHARS,
        ),
        "en": builder._truncate_text(
            bounded_item["failure_mode_i18n"]["en"],
            builder._PREMORTEM_TEXT_MAX_CHARS,
        ),
    }
    max_bytes = utf8_json_size_bytes(bounded_payload) + 64
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", max_bytes)

    fitted = builder._fit_report_to_byte_cap(report)

    assert fitted.premortem_analysis is not None
    assert [item.id for item in fitted.premortem_analysis.items] == [original_id]
    assert len(fitted.premortem_analysis.items[0].failure_mode_i18n.zh) <= (
        builder._PREMORTEM_TEXT_MAX_CHARS
    )
    assert fitted.sections, "text bounding must precede general section pruning"


def test_byte_cap_drops_last_premortem_item_and_orphan_evidence_first(monkeypatch):
    report, reducer_result = _assembled_report_with_partial_premortem(2)
    assert report.premortem_analysis is not None
    first_item = report.premortem_analysis.items[0]
    dropped_item = report.premortem_analysis.items[1]
    kept_ref = first_item.evidence_chain[0].evidence_ref
    dropped_ref = dropped_item.evidence_chain[0].evidence_ref

    expected_payload = report.model_dump(mode="json")
    expected_payload["limitations"] = (
        "Report was truncated to fit the configured UTF-8 byte budget."
    )
    expected_payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "byte_budget_truncated",
        "items": [first_item.model_dump(mode="json")],
    }
    expected_payload["evidence"] = [
        item
        for item in expected_payload["evidence"]
        if item["id"] != dropped_ref
    ]
    max_bytes = utf8_json_size_bytes(expected_payload) + 64
    monkeypatch.setattr(builder.settings, "REPORT_FULL_REPORT_MAX_BYTES", max_bytes)

    fitted = builder._fit_report_to_byte_cap(report)

    assert fitted.premortem_analysis is not None
    assert fitted.premortem_analysis.status == "partial"
    assert fitted.premortem_analysis.reason == "byte_budget_truncated"
    assert [item.id for item in fitted.premortem_analysis.items] == [first_item.id]
    evidence_ids = {item.id for item in fitted.evidence}
    assert kept_ref in evidence_ids
    assert dropped_ref not in evidence_ids
    assert fitted.sections, "premortem pruning must run before general section pruning"
    assert all(
        set(section.evidence_refs) <= set(reducer_result.outcome_evidence_ids)
        for section in fitted.sections
    )


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


@pytest.mark.parametrize(
    ("source_status", "target_status", "transition_kwargs", "expected_copy"),
    [
        (
            "generating",
            "failed",
            {},
            {
                "title": "Full report unavailable",
                "summary": (
                    "Report generation failed; the simulation result remains available."
                ),
                "headline": (
                    "Report generation failed before renderable sections were produced."
                ),
                "limitations": (
                    "Report generation failed before any renderable section could be "
                    "produced. Existing simulation results remain available."
                ),
                "interview": "Report generation failed before interviews could run.",
            },
        ),
        (
            "generating",
            "cancelled",
            {},
            {
                "title": "Full report cancelled",
                "summary": (
                    "Report generation was cancelled; the simulation result remains "
                    "available."
                ),
                "headline": (
                    "Report generation was cancelled before renderable sections "
                    "were produced."
                ),
                "limitations": (
                    "Report generation was cancelled before any renderable section "
                    "was produced. Existing simulation results remain available."
                ),
                "interview": "Report generation was cancelled before interviews could run.",
            },
        ),
        (
            "failed",
            "generating",
            {"replace_failed": True},
            {
                "title": "Full report generating",
                "summary": (
                    "The full report is being generated; the simulation result is "
                    "available."
                ),
                "headline": (
                    "The full report is being generated and enhanced analysis will "
                    "appear shortly."
                ),
                "limitations": (
                    "Report generation is in progress. This placeholder preserves "
                    "the report contract until generated sections are persisted."
                ),
                "interview": "Report generation has not reached interview extraction yet.",
            },
        ),
        (
            "cancelled",
            "failed",
            {"replace_cancelled": True},
            {
                "title": "Full report unavailable",
                "summary": (
                    "Report generation failed; the simulation result remains available."
                ),
                "headline": (
                    "Report generation failed before renderable sections were produced."
                ),
                "limitations": (
                    "Report generation failed before any renderable section could be "
                    "produced. Existing simulation results remain available."
                ),
                "interview": "Report generation failed before interviews could run.",
            },
        ),
    ],
)
def test_placeholder_status_transitions_rebuild_all_canonical_status_copy(
    source_status,
    target_status,
    transition_kwargs,
    expected_copy,
):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    builder._persist_placeholder_report_if_absent(
        scenario_id,
        "branch-a",
        status=source_status,
    )

    transitioned = builder._persist_placeholder_report_if_absent(
        scenario_id,
        "branch-a",
        status=target_status,
        **transition_kwargs,
    )

    assert transitioned.status == target_status
    assert transitioned.title_i18n.en == expected_copy["title"]
    assert transitioned.summary_i18n.en == expected_copy["summary"]
    assert transitioned.verdict.headline_answer == expected_copy["headline"]
    assert transitioned.limitations == expected_copy["limitations"]
    assert transitioned.interview_status is not None
    assert transitioned.interview_status.message == expected_copy["interview"]
    assert validate_full_report_payload(_persisted_report(scenario_id)) == transitioned


def test_terminal_transition_preserves_real_sections_but_replaces_placeholder_copy():
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    generating = builder.persist_generating_report_placeholder_if_absent(
        scenario_id,
        "branch-a",
    )
    payload = generating.model_dump(mode="json")
    payload["sections"] = [
        ReportSection(
            id="timeline",
            title="Timeline",
            title_i18n=I18nText(zh="时间线", en="Timeline"),
            intent="Trace the simulation.",
            body_md_i18n=I18nText(zh="已保存章节。", en="Saved section."),
        ).model_dump(mode="json")
    ]
    builder._persist_report_payload(scenario_id, payload)

    transitioned = builder._persist_placeholder_report_if_absent(
        scenario_id,
        "branch-a",
        status="cancelled",
    )

    assert transitioned.status == "cancelled"
    assert [section.id for section in transitioned.sections] == ["timeline"]
    assert transitioned.sections[0].body_md_i18n.en == "Saved section."
    assert transitioned.title_i18n.en == "Full report cancelled"
    assert transitioned.summary_i18n.en.startswith("Report generation was cancelled")
    assert "being generated" not in transitioned.verdict.headline_answer
    assert "in progress" not in transitioned.limitations
    assert transitioned.interview_status is not None
    assert "cancelled" in (transitioned.interview_status.message or "").lower()


@pytest.mark.parametrize(
    ("source_status", "status", "transition_kwargs", "expected_en", "expected_zh"),
    [
        ("failed", "generating", {"replace_failed": True}, "retrying", "重试"),
        ("generating", "cancelled", {}, "cancelled", "取消"),
        ("generating", "failed", {}, "failed", "失败"),
    ],
)
def test_partial_section_transition_replaces_confidence_basis_in_both_languages(
    source_status,
    status,
    transition_kwargs,
    expected_en,
    expected_zh,
):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    existing = builder._persist_placeholder_report_if_absent(
        scenario_id,
        "branch-a",
        status=source_status,
    )
    payload = existing.model_dump(mode="json")
    payload["sections"] = [
        ReportSection(
            id="timeline",
            title="Timeline",
            title_i18n=I18nText(zh="时间线", en="Timeline"),
            intent="Trace the simulation.",
            body_md_i18n=I18nText(zh="已保存章节。", en="Saved section."),
        ).model_dump(mode="json")
    ]
    payload["verdict"]["analytic_confidence"]["basis_i18n"] = {
        "zh": "旧置信依据",
        "en": "stale confidence basis",
    }
    builder._persist_report_payload(scenario_id, payload)

    transitioned = builder._persist_placeholder_report_if_absent(
        scenario_id,
        "branch-a",
        status=status,
        **transition_kwargs,
    )

    basis_i18n = transitioned.verdict.analytic_confidence.basis_i18n
    assert basis_i18n is not None
    assert expected_en in basis_i18n.en.lower()
    assert expected_zh in basis_i18n.zh
    assert "stale" not in basis_i18n.en.lower()
    assert "旧置信" not in basis_i18n.zh


def test_persist_generating_report_placeholder_if_absent():
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()

    placeholder = builder.persist_generating_report_placeholder_if_absent(
        scenario_id,
        "branch-a",
    )

    assert placeholder.status == "generating"
    assert placeholder.generation_mode == "static"
    assert placeholder.tier == "static"
    assert placeholder.target_branch_id == "branch-a"
    assert placeholder.sections == []
    assert placeholder.interview_status is not None
    assert placeholder.interview_status.status == "skipped"
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "generating"


def test_retry_placeholder_does_not_reopen_failed_report_when_lock_unavailable(
    monkeypatch,
):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    builder._persist_failed_report_if_absent(scenario_id, "branch-a")
    monkeypatch.setattr(
        builder,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: None,
        raising=False,
    )

    report = builder._persist_generating_report_placeholder_for_retry(
        scenario_id,
        "branch-a",
    )

    assert report is not None
    assert report.status == "failed"
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "failed"


@pytest.mark.asyncio
async def test_build_report_safe_retries_failed_report_until_success(monkeypatch):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    attempts = 0

    def complete_payload() -> dict[str, Any]:
        payload = _legal_full_report()
        payload["target_branch_id"] = "branch-a"
        payload["evidence"][0]["branch_id"] = "branch-a"
        payload["sections"][0]["charts"][0]["data"]["branches"][0]["branch_id"] = "branch-a"
        return payload

    async def fail_then_success(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return builder._persist_failed_report_if_absent(scenario_id, "branch-a")
        payload = complete_payload()
        builder._persist_report_payload(scenario_id, payload)
        return validate_full_report_payload(payload)

    monkeypatch.setattr(builder, "build_report", fail_then_success)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert attempts == 2
    assert report is not None
    assert report.status == "complete"
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "complete"


@pytest.mark.asyncio
async def test_build_report_safe_resolves_once_and_reuses_scope_across_retries(
    monkeypatch,
):
    scenario_id = _seed_report_scenario()
    real_resolver = builder.resolve_report_lineage_scope
    resolver_calls = 0
    build_scopes = []
    retry_scopes = []
    attempts = 0

    class SuccessfulReport:
        status = "complete"

    successful_report = SuccessfulReport()

    def capture_resolver(*args: Any, **kwargs: Any):
        nonlocal resolver_calls
        resolver_calls += 1
        return real_resolver(*args, **kwargs)

    async def fail_twice_then_succeed(*_args: Any, **kwargs: Any):
        nonlocal attempts
        attempts += 1
        build_scopes.append(kwargs.get("report_scope"))
        if attempts < 3:
            raise RuntimeError("retryable report failure")
        return successful_report

    async def capture_retry(*_args: Any, **kwargs: Any) -> None:
        retry_scopes.append(kwargs.get("report_scope"))

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", capture_resolver)
    monkeypatch.setattr(builder, "build_report", fail_twice_then_succeed)
    monkeypatch.setattr(builder, "_prepare_auto_report_retry", capture_retry)
    monkeypatch.setattr(builder, "_auto_report_max_attempts", lambda: 3)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert report is successful_report
    assert resolver_calls == 1
    assert len(build_scopes) == 3
    assert build_scopes[0] is not None
    assert all(report_scope is build_scopes[0] for report_scope in build_scopes)
    assert retry_scopes == [build_scopes[0], build_scopes[0]]


@pytest.mark.asyncio
async def test_build_report_safe_retries_transient_resolver_then_caches_scope(
    monkeypatch,
):
    scenario_id = _seed_report_scenario()
    real_resolver = builder.resolve_report_lineage_scope
    resolver_calls = 0
    build_scopes = []
    retry_markers = []

    class SuccessfulReport:
        status = "complete"

    successful_report = SuccessfulReport()

    def transient_resolver(*args: Any, **kwargs: Any):
        nonlocal resolver_calls
        resolver_calls += 1
        if resolver_calls == 1:
            raise RuntimeError("transient resolver outage")
        return real_resolver(*args, **kwargs)

    async def fail_once_after_scope(*_args: Any, **kwargs: Any):
        build_scopes.append(kwargs.get("report_scope"))
        if len(build_scopes) == 1:
            raise RuntimeError("builder failed after scope resolution")
        return successful_report

    async def capture_retry(*_args: Any, **kwargs: Any) -> None:
        retry_markers.append(
            (
                kwargs.get("report_scope"),
                kwargs.get("known_target_branch_id"),
            )
        )

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", transient_resolver)
    monkeypatch.setattr(builder, "build_report", fail_once_after_scope)
    monkeypatch.setattr(builder, "_prepare_auto_report_retry", capture_retry)
    monkeypatch.setattr(builder, "_auto_report_max_attempts", lambda: 3)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert report is successful_report
    assert resolver_calls == 2
    assert len(build_scopes) == 2
    assert build_scopes[0] is not None
    assert build_scopes[1] is build_scopes[0]
    assert retry_markers == [
        (None, "branch-a"),
        (build_scopes[0], None),
    ]


@pytest.mark.asyncio
async def test_build_report_safe_permanent_resolver_error_returns_failed_marker(
    monkeypatch,
):
    scenario_id = _seed_report_scenario()
    resolver_calls = 0
    secret = "ordinary resolver failure sk-secret-123456"

    def permanent_resolver(*_args: Any, **_kwargs: Any):
        nonlocal resolver_calls
        resolver_calls += 1
        raise RuntimeError(secret)

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", permanent_resolver)
    monkeypatch.setattr(builder, "_auto_report_max_attempts", lambda: 2)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert resolver_calls == 2
    assert report is not None
    assert report.status == "failed"
    assert report.target_branch_id == "branch-a"
    assert secret not in json.dumps(report.model_dump(mode="json"), ensure_ascii=False)


@pytest.mark.asyncio
async def test_build_report_safe_does_not_retry_or_swallow_branch_lineage_error(
    monkeypatch,
):
    scenario_id = _seed_report_scenario()
    build_calls = 0
    resolver_calls = 0

    def invalid_lineage(*_args: Any, **_kwargs: Any):
        nonlocal resolver_calls
        resolver_calls += 1
        raise BranchLineageError("BRANCH_LINEAGE_CYCLE", "lineage cycle")

    async def unexpected_build(*_args: Any, **_kwargs: Any):
        nonlocal build_calls
        build_calls += 1
        raise AssertionError("build must not start after preflight lineage failure")

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", invalid_lineage)
    monkeypatch.setattr(builder, "build_report", unexpected_build)

    with pytest.raises(BranchLineageError, match="lineage cycle"):
        await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert build_calls == 0
    assert resolver_calls == 1


@pytest.mark.asyncio
async def test_build_report_safe_does_not_retry_lineage_error_from_build(monkeypatch):
    scenario_id = _seed_report_scenario()
    report_scope = builder.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="branch-a",
    )
    assert report_scope is not None
    build_calls = 0
    retry_calls = 0

    async def invalid_build(*_args: Any, **_kwargs: Any):
        nonlocal build_calls
        build_calls += 1
        raise BranchLineageError("BRANCH_LINEAGE_CYCLE", "lineage changed")

    async def unexpected_retry(*_args: Any, **_kwargs: Any) -> None:
        nonlocal retry_calls
        retry_calls += 1

    monkeypatch.setattr(builder, "build_report", invalid_build)
    monkeypatch.setattr(builder, "_prepare_auto_report_retry", unexpected_retry)

    with pytest.raises(BranchLineageError, match="lineage changed"):
        await builder.build_report_safe(
            scenario_id,
            "branch-a",
            overrides=None,
            report_scope=report_scope,
        )

    assert build_calls == 1
    assert retry_calls == 0


def test_failure_placeholder_reuses_known_scope_without_resolving_again(monkeypatch):
    scenario_id = _seed_report_scenario()
    report_scope = builder.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="branch-a",
    )
    assert report_scope is not None

    def fail_resolver(*_args: Any, **_kwargs: Any):
        raise AssertionError("known placeholder scope must not resolve again")

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", fail_resolver)

    failed = builder._persist_failed_report_if_absent(
        scenario_id,
        "branch-a",
        report_scope=report_scope,
    )

    assert failed.target_branch_id == report_scope.target_branch_id


@pytest.mark.asyncio
async def test_auto_retry_preserves_and_reuses_complementary_sections(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    outline = builder.ReportOutline(
        title_i18n={"zh": "重试报告", "en": "Retry report"},
        summary_i18n={"zh": "重试摘要", "en": "Retry summary"},
        sections=[
            builder.SectionPlan(
                section_id=section_id,
                title_i18n={"zh": section_id, "en": section_id.title()},
                intent=f"Explain {section_id}.",
            )
            for section_id in ("timeline", "sources")
        ],
    )
    attempt_number = 0
    generated: list[tuple[int, str]] = []
    failed_snapshots: list[FullReport] = []
    retry_snapshots: list[FullReport] = []

    async def fixed_outline(*_args: Any, **_kwargs: Any):
        nonlocal attempt_number
        attempt_number += 1
        if attempt_number == 2:
            retry_snapshots.append(
                validate_full_report_payload(_persisted_report(scenario_id)),
            )
        return outline

    async def complementary_sections(*args: Any, **_kwargs: Any):
        section_plan = args[1]
        generated.append((attempt_number, section_plan.section_id))
        if attempt_number == 1 and section_plan.section_id == "sources":
            raise RuntimeError("sources missing on first attempt")
        section = ReportSection(
            id=section_plan.section_id,
            title=section_plan.title_i18n["en"],
            title_i18n=I18nText.model_validate(section_plan.title_i18n),
            intent=section_plan.intent,
            body_md_i18n=I18nText(
                zh=f"{section_plan.section_id} 来自第 {attempt_number} 次尝试。",
                en=(
                    f"{section_plan.section_id} was generated on attempt "
                    f"{attempt_number}."
                ),
            ),
            evidence_refs=["ev_001"],
            tier="generation",
        )
        return builder.SectionBuildResult(
            section=section,
            tier="generation",
            tool_trace=[],
        )

    original_prepare = builder._prepare_auto_report_retry

    async def capture_failed_then_prepare(*args: Any, **kwargs: Any):
        failed_snapshots.append(
            validate_full_report_payload(_persisted_report(scenario_id)),
        )
        await original_prepare(*args, **kwargs)

    async def no_interviews(*_args: Any, **_kwargs: Any):
        return [], builder.InterviewStatus(
            status="skipped",
            requested_agents=0,
            completed_agents=0,
            truncated_agents=0,
        )

    async def no_indicators(*_args: Any, **_kwargs: Any):
        return None

    monkeypatch.setattr(builder, "plan_outline", fixed_outline)
    monkeypatch.setattr(builder, "generate_section_react", complementary_sections)
    monkeypatch.setattr(builder, "_prepare_auto_report_retry", capture_failed_then_prepare)
    monkeypatch.setattr(builder, "_build_interview_evidence", no_interviews)
    monkeypatch.setattr(builder, "_build_indicators_llm", no_indicators)
    monkeypatch.setattr(builder, "_auto_report_max_attempts", lambda: 2)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)

    report = await builder.build_report_safe(
        scenario_id,
        "branch-a",
        overrides=None,
    )

    assert report is not None
    assert attempt_number == 2
    assert failed_snapshots[0].status == "failed"
    assert [section.id for section in failed_snapshots[0].sections] == ["timeline"]
    assert retry_snapshots[0].status == "generating"
    assert [section.id for section in retry_snapshots[0].sections] == ["timeline"]
    assert retry_snapshots[0].tier == "generation"
    assert [item.id for item in retry_snapshots[0].evidence] == [
        item.id for item in failed_snapshots[0].evidence
    ]
    assert "retrying" in retry_snapshots[0].summary_i18n.en.lower()
    assert "failed" in failed_snapshots[0].summary_i18n.en.lower()
    assert generated.count((1, "timeline")) == 1
    assert (2, "timeline") not in generated
    assert report.status == "complete"
    assert [section.id for section in report.sections] == ["timeline", "sources"]
    assert "attempt 1" in report.sections[0].body_md_i18n.en


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("initial_status", "tier", "terminal_path"),
    [
        ("generating", "generation", "exception"),
        ("generating", "static", "exception"),
        ("failed", "generation", "retry_exhausted"),
        ("failed", "static", "retry_exhausted"),
    ],
)
async def test_auto_retry_terminal_markers_preserve_surviving_sections(
    monkeypatch,
    initial_status,
    tier,
    terminal_path,
):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    payload = _legal_full_report()
    payload["target_branch_id"] = "branch-a"
    payload["status"] = initial_status
    payload["generation_mode"] = tier
    payload["tier"] = tier
    payload["sections"][0]["tier"] = tier
    payload["sections"][0]["failure_reason"] = "other" if tier == "static" else None
    payload["premortem_analysis"] = {
        "status": "missing",
        "reason": "no_distinct_evidence",
        "items": [],
    }
    builder._persist_report_payload(scenario_id, payload)
    before = validate_full_report_payload(payload)

    if terminal_path == "exception":
        async def terminal_build(*_args: Any, **_kwargs: Any):
            raise RuntimeError("terminal provider failure")
    else:
        async def terminal_build(*_args: Any, **_kwargs: Any):
            return validate_full_report_payload(_persisted_report(scenario_id))

    monkeypatch.setattr(builder, "build_report", terminal_build)
    monkeypatch.setattr(builder, "_auto_report_max_attempts", lambda: 1)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert report is not None
    assert report.status == "failed"
    assert report.tier == before.tier
    assert report.sections == before.sections
    assert report.evidence == before.evidence
    assert report.premortem_analysis is not None
    assert report.premortem_analysis.status == "missing"
    assert report.premortem_analysis.reason == "report_generation_failed"
    assert "failed" in report.summary_i18n.en.lower()
    assert "failed" in report.verdict.analytic_confidence.basis.lower()
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.sections == before.sections
    assert persisted.evidence == before.evidence
    assert persisted.premortem_analysis == report.premortem_analysis


def test_retry_placeholder_does_not_reuse_sections_from_different_target_branch():
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    payload = _legal_full_report()
    payload["target_branch_id"] = "branch-a"
    payload["status"] = "failed"
    builder._persist_report_payload(scenario_id, payload)

    placeholder = builder._persist_generating_report_placeholder_for_retry(
        scenario_id,
        "branch-b",
    )
    outline = builder.ReportOutline(
        title_i18n={"zh": "新分支", "en": "New branch"},
        summary_i18n={"zh": "新分支摘要", "en": "New branch summary"},
        sections=[
            builder.SectionPlan(
                section_id="timeline",
                title_i18n={"zh": "时间线", "en": "Timeline"},
                intent="Explain why the dominant branch won.",
            ),
        ],
    )

    assert placeholder is not None
    assert placeholder.status == "generating"
    assert placeholder.target_branch_id == "branch-b"
    assert placeholder.sections == []
    assert placeholder.evidence == []
    assert builder._reusable_existing_sections(
        scenario_id,
        "branch-b",
        outline,
    ) == ([], [])


@pytest.mark.asyncio
async def test_build_report_safe_returns_complete_static_report_without_retry(monkeypatch):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    attempts = 0

    def payload_with_section_tier(tier: str) -> dict[str, Any]:
        payload = _legal_full_report()
        payload["target_branch_id"] = "branch-a"
        payload["sections"][0]["tier"] = tier
        if tier == "static":
            payload["generation_mode"] = "static"
            payload["tier"] = "static"
            payload["sections"][0]["failure_reason"] = "other"
        return payload

    async def static_then_success(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal attempts
        attempts += 1
        payload = payload_with_section_tier("static" if attempts == 1 else "generation")
        builder._persist_report_payload(scenario_id, payload)
        return validate_full_report_payload(payload)

    monkeypatch.setattr(builder, "build_report", static_then_success)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert attempts == 1
    assert report is not None
    assert report.status == "complete"
    assert report.sections[0].tier == "static"
    assert validate_full_report_payload(_persisted_report(scenario_id)).tier == "static"


@pytest.mark.asyncio
async def test_build_report_safe_retries_exception_until_success(monkeypatch):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    attempts = 0

    async def error_then_success(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("provider temporarily unavailable")
        payload = _legal_full_report()
        payload["target_branch_id"] = "branch-a"
        builder._persist_report_payload(scenario_id, payload)
        return validate_full_report_payload(payload)

    monkeypatch.setattr(builder, "build_report", error_then_success)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert attempts == 2
    assert report is not None
    assert report.status == "complete"
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "complete"


@pytest.mark.asyncio
async def test_build_report_safe_stops_after_retry_budget_and_returns_failed(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    attempts = 0

    async def always_failed(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal attempts
        attempts += 1
        return builder._persist_failed_report_if_absent(scenario_id, "branch-a")

    monkeypatch.setattr(builder, "build_report", always_failed)
    monkeypatch.setattr(builder, "_auto_report_max_attempts", lambda: 2)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert attempts == 2
    assert report is not None
    assert report.status == "failed"
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "failed"


@pytest.mark.asyncio
async def test_build_report_safe_does_not_mark_complete_static_failed_after_retry_budget(
    monkeypatch,
):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    attempts = 0

    async def always_static(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal attempts
        attempts += 1
        payload = _legal_full_report()
        payload["target_branch_id"] = "branch-a"
        payload["generation_mode"] = "static"
        payload["tier"] = "static"
        payload["sections"][0]["tier"] = "static"
        payload["sections"][0]["failure_reason"] = "other"
        builder._persist_report_payload(scenario_id, payload)
        return validate_full_report_payload(payload)

    monkeypatch.setattr(builder, "build_report", always_static)
    monkeypatch.setattr(builder, "_auto_report_max_attempts", lambda: 2)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert attempts == 1
    assert report is not None
    assert report.status == "complete"
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "complete"


@pytest.mark.parametrize(
    ("status", "tier", "expected"),
    [
        ("failed", "generation", True),
        ("complete", "static", False),
        ("generating", "generation", False),
        ("partial", "static", False),
        ("cancelled", "static", False),
        ("skipped", "static", False),
    ],
)
def test_auto_report_should_retry_only_none_or_failed(status, tier, expected):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    report = validate_full_report_payload(_legal_full_report())
    sections = [
        section.model_copy(
            update={
                "tier": tier,
                "failure_reason": "other" if tier == "static" else None,
            },
        )
        for section in report.sections
    ]
    report = report.model_copy(
        update={
            "status": status,
            "tier": tier,
            "generation_mode": tier,
            "sections": sections,
        },
    )

    assert builder._auto_report_should_retry(report) is expected


def test_auto_report_should_retry_none():
    from app.services.result_report import builder

    assert builder._auto_report_should_retry(None) is True


@pytest.mark.asyncio
async def test_build_report_safe_does_not_overwrite_live_generation_when_marker_lock_unavailable(
    monkeypatch,
):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    live_generation = _legal_full_report()
    live_generation["status"] = "generating"
    builder._persist_report_payload(scenario_id, live_generation)

    async def failing_build_report(*_args: Any, **_kwargs: Any) -> FullReport:
        raise RuntimeError("builder failed after another worker started")

    monkeypatch.setattr(builder, "build_report", failing_build_report)
    monkeypatch.setattr(builder, "_auto_report_retry_delay_seconds", lambda _attempt: 0.0)
    monkeypatch.setattr(
        builder,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: None,
        raising=False,
    )

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert report is not None
    assert report.status == "generating"
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "generating"


def test_report_sse_stall_timeout_covers_full_report_budget():
    from app.services.result_report import builder

    assert (
        builder._report_sse_stall_timeout_seconds()
        >= builder._report_runtime_lock_lease_seconds()
    )
    assert (
        builder._report_sse_stall_timeout_seconds()
        > builder.settings.REPORT_SECTION_TIMEOUT_SECONDS
    )


def test_report_sse_stall_timeout_covers_every_legal_section_call(monkeypatch):
    from app.services.result_report import builder

    monkeypatch.setattr(builder.settings, "REPORT_MAX_TOOL_CALLS_PER_SECTION", 3)
    monkeypatch.setattr(builder.settings, "REPORT_SECTION_TIMEOUT_SECONDS", 10.0)
    monkeypatch.setattr(builder.settings, "REPORT_PLAN_TIMEOUT_SECONDS", 2.0)
    monkeypatch.setattr(builder.settings, "REPORT_RUNTIME_LOCK_LEASE_SECONDS", 1.0)

    expected_minimum = 2.0 + (3 * 10.0 * 2) + 5.0
    assert builder._report_sse_stall_timeout_seconds() >= expected_minimum


def test_report_runtime_lock_short_ttl_expires_and_becomes_preemptible(monkeypatch):
    from app.services.result_report import builder
    from app.services.runtime_lock import acquire_runtime_lock, release_runtime_lock

    assert 90.0 <= builder._report_runtime_lock_lease_seconds() <= 120.0
    monkeypatch.setattr(builder.settings, "REPORT_RUNTIME_LOCK_LEASE_SECONDS", 0.01)
    lock_key = builder._report_runtime_lock_key("short-ttl")

    lease = acquire_runtime_lock(
        lock_key,
        lease_seconds=builder._report_runtime_lock_lease_seconds(),
    )
    assert lease is not None
    time.sleep(0.03)

    reclaimed = acquire_runtime_lock(
        lock_key,
        lease_seconds=builder._report_runtime_lock_lease_seconds(),
    )

    assert reclaimed is not None
    assert release_runtime_lock(reclaimed) is True


@pytest.mark.asyncio
async def test_build_report_cancel_preserves_persisted_sections_and_reraises(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    outline = _cancellation_outline()
    second_section_started = asyncio.Event()
    never_complete = asyncio.Event()

    async def fixed_outline(*_args: Any, **_kwargs: Any):
        return outline

    async def block_second_section(*args: Any, **_kwargs: Any):
        section_plan = args[1]
        if section_plan.section_id == "timeline":
            return _generated_cancellation_section(section_plan)
        second_section_started.set()
        await never_complete.wait()
        raise AssertionError("cancelled section unexpectedly resumed")

    monkeypatch.setattr(builder, "plan_outline", fixed_outline)
    monkeypatch.setattr(builder, "generate_section_react", block_second_section)

    task = asyncio.create_task(
        builder.build_report(scenario_id, "branch-a", overrides=None),
    )
    await asyncio.wait_for(second_section_started.wait(), timeout=1)
    before = validate_full_report_payload(_persisted_report(scenario_id))
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert before.status == "generating"
    assert persisted.status == "cancelled"
    assert persisted.target_branch_id == "branch-a"
    assert persisted.sections == before.sections
    assert persisted.evidence == before.evidence
    assert persisted.tier == before.tier == "generation"
    assert "cancelled" in persisted.summary_i18n.en.lower()
    assert "cancelled" in persisted.verdict.analytic_confidence.basis.lower()


@pytest.mark.asyncio
async def test_build_report_cancel_before_first_persist_creates_cancelled_marker(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    outline_started = asyncio.Event()
    never_complete = asyncio.Event()

    async def blocked_outline(*_args: Any, **_kwargs: Any):
        outline_started.set()
        await never_complete.wait()
        raise AssertionError("cancelled outline unexpectedly resumed")

    monkeypatch.setattr(builder, "plan_outline", blocked_outline)
    task = asyncio.create_task(
        builder.build_report(scenario_id, "branch-a", overrides=None),
    )
    await asyncio.wait_for(outline_started.wait(), timeout=1)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "cancelled"
    assert persisted.target_branch_id == "branch-a"
    assert persisted.sections == []
    assert persisted.evidence == []


@pytest.mark.asyncio
async def test_build_report_cancel_does_not_overwrite_after_runtime_lock_loss(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    outline = _cancellation_outline()
    second_section_started = asyncio.Event()
    never_complete = asyncio.Event()
    lease_is_authoritative = True
    original_is_alive = builder._report_runtime_lock_is_alive

    async def fixed_outline(*_args: Any, **_kwargs: Any):
        return outline

    async def block_second_section(*args: Any, **_kwargs: Any):
        section_plan = args[1]
        if section_plan.section_id == "timeline":
            return _generated_cancellation_section(section_plan)
        second_section_started.set()
        await never_complete.wait()
        raise AssertionError("cancelled section unexpectedly resumed")

    def controlled_lease_check(lease_holder):
        return lease_is_authoritative and original_is_alive(lease_holder)

    monkeypatch.setattr(builder, "plan_outline", fixed_outline)
    monkeypatch.setattr(builder, "generate_section_react", block_second_section)
    monkeypatch.setattr(builder, "_report_runtime_lock_is_alive", controlled_lease_check)

    task = asyncio.create_task(
        builder.build_report(scenario_id, "branch-a", overrides=None),
    )
    await asyncio.wait_for(second_section_started.wait(), timeout=1)
    before = _persisted_report(scenario_id)
    lease_is_authoritative = False
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert _persisted_report(scenario_id) == before
    assert validate_full_report_payload(before).status == "generating"


@pytest.mark.asyncio
async def test_build_report_refreshes_runtime_lock_during_generation(monkeypatch):
    from app.services.result_report import builder
    from app.services.runtime_lock import acquire_runtime_lock, release_runtime_lock

    scenario_id = _seed_report_scenario()
    lock_key = builder._report_runtime_lock_key(scenario_id)
    responses = [_outline_payload(["timeline"]), _section_payload("timeline")]
    competing_leases: list[Any] = []

    async def slow_llm(prompt: str, **_kwargs: Any) -> dict[str, Any]:
        if prompt.startswith(("REPORT_OUTLINE", "REPORT_SECTION_REACT")):
            await asyncio.sleep(0.08)
            competing = await asyncio.to_thread(
                acquire_runtime_lock,
                lock_key,
                lease_seconds=0.05,
            )
            competing_leases.append(competing)
            if competing is not None:
                await asyncio.to_thread(release_runtime_lock, competing)
            return responses.pop(0)
        if prompt.startswith("REPORT_INTERVIEWS"):
            return {"action": "interview_agents", "interview_evidence": []}
        raise builder.ResultReportBuilderError("force template indicators")

    monkeypatch.setattr(builder, "llm_call_json", slow_llm)
    monkeypatch.setattr(builder, "_report_runtime_lock_lease_seconds", lambda: 0.05)
    monkeypatch.setattr(
        builder,
        "_report_runtime_lock_refresh_interval",
        lambda *_args, **_kwargs: 0.01,
    )

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    assert competing_leases
    assert all(lease is None for lease in competing_leases)


@pytest.mark.asyncio
async def test_report_sse_stream_times_out_stalled_generation(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()

    async def stalled_build_report(*_args: Any, **_kwargs: Any):
        await asyncio.sleep(60)

    monkeypatch.setattr(builder, "build_report", stalled_build_report)
    monkeypatch.setattr(builder, "_report_sse_stall_timeout_seconds", lambda: 0.01)

    frames: list[str] = []
    async for frame in builder.build_report_sse_stream(
        scenario_id,
        "branch-a",
        overrides=None,
    ):
        frames.append(frame)

    payload = "".join(frames)
    assert "event: report_started" in payload
    assert "event: report_failed" in payload
    assert "REPORT_TIMEOUT" in payload
    assert "event: report_complete" in payload
    assert '"report_id": "scenario-report"' in payload
    assert '"status": "failed"' in payload
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "failed"


@pytest.mark.asyncio
async def test_report_sse_stall_timeout_forces_failed_story_authority(monkeypatch):
    import app.api.scenarios as scenarios_api
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    outline = _cancellation_outline()
    second_section_started = asyncio.Event()
    never_complete = asyncio.Event()

    async def fixed_outline(*_args: Any, **_kwargs: Any):
        return outline

    async def block_second_section(*args: Any, **_kwargs: Any):
        section_plan = args[1]
        if section_plan.section_id == "timeline":
            return _generated_cancellation_section(section_plan)
        second_section_started.set()
        await never_complete.wait()
        raise AssertionError("timed-out section unexpectedly resumed")

    monkeypatch.setattr(builder, "plan_outline", fixed_outline)
    monkeypatch.setattr(builder, "generate_section_react", block_second_section)
    monkeypatch.setattr(builder, "_report_sse_stall_timeout_seconds", lambda: 0.01)
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)

    frames: list[str] = []
    async for frame in builder.build_report_sse_stream(
        scenario_id,
        "branch-a",
        overrides=None,
    ):
        frames.append(frame)

    assert second_section_started.is_set()
    payload = "".join(frames)
    assert "event: report_failed" in payload
    assert "REPORT_TIMEOUT" in payload
    assert "event: report_complete" in payload
    assert '"status": "failed"' in payload
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "failed"
    assert [section.id for section in persisted.sections] == ["timeline"]
    story = await scenarios_api.get_story(scenario_id, principal=None)
    assert story["full_report"]["status"] == "failed"
    assert [section["id"] for section in story["full_report"]["sections"]] == [
        "timeline",
    ]


@pytest.mark.asyncio
async def test_report_sse_stream_does_not_auto_retry_failed_generation(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    attempts = 0

    async def failing_build_report(*_args: Any, **_kwargs: Any) -> FullReport:
        nonlocal attempts
        attempts += 1
        raise RuntimeError("manual report failed once")

    monkeypatch.setattr(builder, "build_report", failing_build_report)

    frames: list[str] = []
    async for frame in builder.build_report_sse_stream(
        scenario_id,
        "branch-a",
        overrides=None,
    ):
        frames.append(frame)

    payload = "".join(frames)
    assert attempts == 1
    assert "event: report_started" in payload
    assert "event: report_failed" in payload
    assert "REPORT_FAILED" in payload
    assert "event: report_complete" in payload


@pytest.mark.asyncio
async def test_report_sse_stream_reuses_genuine_preflight_scope(monkeypatch):
    scenario_id = _seed_report_scenario()
    report_scope = builder.resolve_report_lineage_scope(
        get_engine(),
        scenario_id,
        dominant_branch_id="branch-a",
    )
    assert report_scope is not None
    observed_scopes = []

    class CompleteReport:
        status = "complete"

    def fail_resolver(*_args: Any, **_kwargs: Any):
        raise AssertionError("SSE must not resolve a genuine preflight scope again")

    async def capture_build(*_args: Any, **kwargs: Any):
        observed_scopes.append(kwargs.get("report_scope"))
        return CompleteReport()

    monkeypatch.setattr(builder, "resolve_report_lineage_scope", fail_resolver)
    monkeypatch.setattr(builder, "build_report", capture_build)

    frames = [
        frame
        async for frame in builder.build_report_sse_stream(
            scenario_id,
            "branch-a",
            overrides=None,
            report_scope=report_scope,
        )
    ]

    assert observed_scopes == [report_scope]
    assert "event: report_complete" in "".join(frames)


@pytest.mark.asyncio
async def test_report_sse_timeout_does_not_overwrite_live_generation_when_lock_unavailable(
    monkeypatch,
):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    live_generation = _legal_full_report()
    live_generation["status"] = "generating"
    builder._persist_report_payload(scenario_id, live_generation)

    async def stalled_build_report(*_args: Any, **_kwargs: Any):
        await asyncio.sleep(60)

    monkeypatch.setattr(builder, "build_report", stalled_build_report)
    monkeypatch.setattr(builder, "_report_sse_stall_timeout_seconds", lambda: 0.01)
    monkeypatch.setattr(
        builder,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: None,
        raising=False,
    )

    frames: list[str] = []
    async for frame in builder.build_report_sse_stream(
        scenario_id,
        "branch-a",
        overrides=None,
    ):
        frames.append(frame)

    payload = "".join(frames)
    assert "event: report_failed" in payload
    assert "REPORT_TIMEOUT" in payload
    assert validate_full_report_payload(_persisted_report(scenario_id)).status == "generating"


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
async def test_build_report_safe_does_not_persist_failed_marker_after_lock_loss(monkeypatch):
    from app.services.result_report import builder
    from app.services.runtime_lock import RuntimeLockLease

    scenario_id = _seed_report_scenario()
    lease = RuntimeLockLease(
        lock_key=f"result-report:{scenario_id}",
        owner_id="owner-lost",
        db_path=None,
        expires_at=9999999999.0,
    )

    async def lose_lock_then_fail(*_args: Any, **kwargs: Any) -> FullReport:
        holder = kwargs["report_lock_holder"]
        holder[0] = None
        raise builder.ResultReportRuntimeLockLostError("lost lease")

    monkeypatch.setattr(
        builder,
        "acquire_runtime_lock",
        lambda *_args, **_kwargs: lease,
        raising=False,
    )
    monkeypatch.setattr(builder, "_build_report_unlocked", lose_lock_then_fail)

    report = await builder.build_report_safe(scenario_id, "branch-a", overrides=None)

    assert report is None
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert "full_report" not in (scenario.parsed_context or {})


@pytest.mark.asyncio
async def test_build_report_retry_reuses_matching_persisted_sections(monkeypatch):
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    current_reducer_result = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="branch-a",
    )
    existing = _legal_full_report()
    existing["status"] = "partial"
    existing["target_branch_id"] = "branch-a"
    existing["sections"][0]["intent"] = "Explain timeline."
    existing["sections"][0]["evidence_refs"] = ["ev_001"]
    existing["evidence"] = [
        evidence.model_dump(mode="json")
        for evidence in current_reducer_result.evidence
    ]
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


def test_reusable_sections_reject_rebound_evidence_id_after_lineage_expands():
    from tests.test_result_report_contract import _legal_full_report
    from tests.test_result_report_reducer import _seed_report_lineage_scope_scenario

    scenario_id = _seed_report_lineage_scope_scenario()
    reducer_result = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
        max_evidence=20,
    )
    current_ev_001 = next(item for item in reducer_result.evidence if item.id == "ev_001")
    old_leaf_evidence = next(
        item for item in reducer_result.evidence if item.message_id == "legal-leaf-5"
    ).model_copy(update={"id": "ev_001"})
    assert old_leaf_evidence.message_id != current_ev_001.message_id

    existing = _legal_full_report()
    existing["status"] = "partial"
    existing["target_branch_id"] = "report-leaf"
    existing["sections"][0]["intent"] = "Explain timeline."
    existing["sections"][0]["evidence_refs"] = ["ev_001"]
    existing["indicators_to_watch"][0]["evidence_refs"] = ["ev_001"]
    existing["evidence"] = [old_leaf_evidence.model_dump(mode="json")]
    builder._persist_report_payload(scenario_id, existing)
    outline = builder.ReportOutline(
        title_i18n={"zh": "标题", "en": "Title"},
        summary_i18n={"zh": "摘要", "en": "Summary"},
        sections=[
            builder.SectionPlan(
                section_id="timeline",
                title_i18n={"zh": "关键转折", "en": "Turning points"},
                intent="Explain timeline.",
            )
        ],
    )

    assert builder._reusable_existing_sections(
        scenario_id,
        "report-leaf",
        outline,
        current_evidence=reducer_result.evidence,
    ) == ([], [])


def test_reusable_sections_accept_stable_evidence_id_coordinate_identity():
    from tests.test_result_report_contract import _legal_full_report
    from tests.test_result_report_reducer import _seed_report_lineage_scope_scenario

    scenario_id = _seed_report_lineage_scope_scenario()
    reducer_result = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="report-leaf",
        max_evidence=20,
    )
    existing = _legal_full_report()
    existing["status"] = "partial"
    existing["target_branch_id"] = "report-leaf"
    existing["sections"][0]["intent"] = "Explain timeline."
    existing["sections"][0]["evidence_refs"] = ["ev_001"]
    existing["indicators_to_watch"][0]["evidence_refs"] = ["ev_001"]
    existing["evidence"] = [
        evidence.model_dump(mode="json") for evidence in reducer_result.evidence
    ]
    builder._persist_report_payload(scenario_id, existing)
    outline = builder.ReportOutline(
        title_i18n={"zh": "标题", "en": "Title"},
        summary_i18n={"zh": "摘要", "en": "Summary"},
        sections=[
            builder.SectionPlan(
                section_id="timeline",
                title_i18n={"zh": "关键转折", "en": "Turning points"},
                intent="Explain timeline.",
            )
        ],
    )

    reusable_sections, reusable_tiers = builder._reusable_existing_sections(
        scenario_id,
        "report-leaf",
        outline,
        current_evidence=reducer_result.evidence,
    )

    assert [section.id for section in reusable_sections] == ["timeline"]
    assert reusable_tiers == ["generation"]


@pytest.mark.asyncio
async def test_build_report_reuse_does_not_propagate_stale_static_top_tier(monkeypatch):
    """Regression (W1-1 S9 follow-up): reused sections must carry their OWN tier.

    ``_reusable_existing_sections`` once seeded ``section_tiers`` with the prior
    report's *top-level* tier for every reused section. When an earlier report had
    been forced to ``tier="static"`` (e.g. an empty ``_worst_tier([])`` fallback),
    every subsequent retry that reused a section re-imported that ``static`` tier,
    so ``_worst_tier(...)`` permanently reported ``static`` even though every
    surviving section was a healthy ``generation`` section. The front-end then
    mislabeled a complete, fully generated report as a "static degraded" report.
    Pin the contract: a reused ``generation`` section keeps ``generation``, and the
    stale ``static`` top tier must NOT bleed into the regenerated report.
    """
    from app.services.result_report import builder
    from tests.test_result_report_contract import _legal_full_report

    scenario_id = _seed_report_scenario()
    current_reducer_result = builder.reduce_report(
        get_engine(),
        scenario_id,
        dominant_branch_id="branch-a",
    )
    existing = _legal_full_report()
    # Simulate the poisoned prior report: top-level tier was clobbered to static
    # (the bug's amplifier), but the persisted section itself is a real
    # ``generation`` section that the retry is allowed to reuse.
    existing["status"] = "partial"
    existing["tier"] = "static"
    existing["target_branch_id"] = "branch-a"
    existing["sections"][0]["intent"] = "Explain timeline."
    existing["sections"][0]["tier"] = "generation"
    existing["sections"][0]["evidence_refs"] = ["ev_001"]
    existing["evidence"] = [
        evidence.model_dump(mode="json")
        for evidence in current_reducer_result.evidence
    ]
    existing["indicators_to_watch"][0]["evidence_refs"] = ["ev_001"]
    builder._persist_report_payload(scenario_id, existing)

    # Directly exercise the function the bug lived in: the reused tiers must
    # reflect each section's own tier, not the prior report's top-level tier.
    outline = builder.ReportOutline(
        title_i18n={"zh": "标题", "en": "Title"},
        summary_i18n={"zh": "摘要", "en": "Summary"},
        sections=[
            builder.SectionPlan(
                section_id="timeline",
                title_i18n={"zh": "关键转折", "en": "Turning points"},
                intent="Explain timeline.",
            ),
        ],
    )
    reusable_sections, reusable_tiers = builder._reusable_existing_sections(
        scenario_id,
        "branch-a",
        outline,
        current_evidence=current_reducer_result.evidence,
    )
    assert [section.id for section in reusable_sections] == ["timeline"]
    # The crux: reused tier is the SECTION's own tier (generation), never the
    # stale ``static`` top-level tier of the prior report.
    assert reusable_tiers == ["generation"]
    assert builder._worst_tier(reusable_tiers) == "generation"

    # End-to-end: a retry that reuses the generation section and regenerates the
    # rest must land on a ``generation`` top tier, not the inherited ``static``.
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
    assert generated_sections == ["sources"]
    assert [section.id for section in report.sections] == ["timeline", "sources"]
    assert all(section.tier == "generation" for section in report.sections)
    # Without the fix, the reused ``static`` top tier would have poisoned
    # ``_worst_tier`` here and this would be ``"static"``.
    assert report.tier == "generation"
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.tier == "generation"


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

    scenario_id = _seed_report_scenario()
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
        scenario_id,
        "branch-a",
        overrides={"api_key": "sk-request-key-123456"},
    ):
        frames.append(frame)
    body = "".join(frames)

    task = api_helpers.schedule_background_task(
        builder.build_report(scenario_id, "branch-a", overrides=None)
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

    scenario_id = _seed_report_scenario()

    async def already_running(*_args: Any, **_kwargs: Any) -> FullReport:
        raise builder.ResultReportAlreadyRunningError("already in progress")

    monkeypatch.setattr(builder, "build_report", already_running)

    frames = []
    async for frame in builder.build_report_sse_stream(
        scenario_id,
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

    scenario_id = _seed_report_scenario()
    started = asyncio.Event()

    async def slow_build_report(*_args: Any, **_kwargs: Any) -> FullReport:
        started.set()
        await asyncio.sleep(60)
        raise AssertionError("unreachable")

    monkeypatch.setattr(builder, "build_report", slow_build_report)
    monkeypatch.setattr(builder, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.01, raising=False)

    stream = builder.build_report_sse_stream(
        scenario_id,
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

    scenario_id = _seed_report_scenario()
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
        scenario_id,
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
async def test_report_sse_aclose_persists_cancelled_story_authority(monkeypatch):
    import app.api.scenarios as scenarios_api
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    outline = _cancellation_outline()
    second_section_started = asyncio.Event()
    never_complete = asyncio.Event()

    async def fixed_outline(*_args: Any, **_kwargs: Any):
        return outline

    async def block_second_section(*args: Any, **_kwargs: Any):
        section_plan = args[1]
        if section_plan.section_id == "timeline":
            return _generated_cancellation_section(section_plan)
        second_section_started.set()
        await never_complete.wait()
        raise AssertionError("cancelled section unexpectedly resumed")

    monkeypatch.setattr(builder, "plan_outline", fixed_outline)
    monkeypatch.setattr(builder, "generate_section_react", block_second_section)
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)

    stream = builder.build_report_sse_stream(
        scenario_id,
        "branch-a",
        overrides=None,
    )
    frames = [await anext(stream)]
    for _ in range(3):
        frames.append(await asyncio.wait_for(anext(stream), timeout=1))
    await asyncio.wait_for(second_section_started.wait(), timeout=1)

    await stream.aclose()

    payload = "".join(frames)
    assert "event: report_started" in payload
    assert "event: report_complete" not in payload
    persisted = validate_full_report_payload(_persisted_report(scenario_id))
    assert persisted.status == "cancelled"
    assert [section.id for section in persisted.sections] == ["timeline"]
    story = await scenarios_api.get_story(scenario_id, principal=None)
    assert story["full_report"]["status"] == "cancelled"
    assert [section["id"] for section in story["full_report"]["sections"]] == [
        "timeline",
    ]


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
    monkeypatch.setattr("app.services.simulator.llm_call", fake_llm_text)
    monkeypatch.setattr("app.services.simulator.llm_call_json", fake_llm_json)
    monkeypatch.setattr("app.services.simulator.narrate_branch", fake_narrate_branch)
    monkeypatch.setattr("app.services.simulator.retrieve_relevant_memories", lambda *a, **k: "")
    monkeypatch.setattr("app.services.simulator.store_memory", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.services.result_report.builder.build_report",
        failing_build_report,
    )
    monkeypatch.setattr(
        "app.services.result_report.builder._auto_report_retry_delay_seconds",
        lambda _attempt: 0.0,
    )

    await run_simulation(scenario_id, ws_callback=fake_ws_callback)
    await asyncio.sleep(0)

    await asyncio.wait_for(report_called.wait(), timeout=1)
    deadline = time.monotonic() + 1.0
    while report_call_count < 3 and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert report_call_count == 3
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
                if validate_full_report_payload(candidate).status == "failed":
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
async def test_report_auto_path_persists_placeholder_before_background_builder_runs(
    monkeypatch,
):
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

    scheduled_coroutines = []

    def fake_schedule_background_task(coro):
        scheduled_coroutines.append(coro)
        coro.close()
        return asyncio.create_task(asyncio.sleep(0))

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
        "app.api.helpers.schedule_background_task",
        fake_schedule_background_task,
    )

    await run_simulation(scenario_id)

    assert scheduled_coroutines
    with Session(engine) as session:
        persisted = session.get(Scenario, scenario_id)
        assert persisted is not None
        assert persisted.status == ScenarioStatus.DONE
        report = (persisted.parsed_context or {}).get("full_report")

    assert isinstance(report, dict)
    validated = validate_full_report_payload(report)
    assert validated.status == "generating"
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

    async def fake_llm_text(*_args: Any, **_kwargs: Any) -> str:
        return "Life support stays stable."

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
    monkeypatch.setattr("app.services.simulator.llm_call", fake_llm_text)
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
            "requests_per_minute": 17,
            "tokens_per_minute": 1700,
            "concurrency": 3,
            "supports_structured_outputs_override": False,
            "supports_native_search_override": True,
        },
    )
    await asyncio.sleep(0)

    assert captured_overrides["api_key"] is secret
    assert repr(captured_overrides) == (
        "{'api_key': ***, 'base_url': 'https://example.com/v1/chat/completions', "
        "'model': 'model-a', 'temperature': 0.2, 'requests_per_minute': 17, "
        "'tokens_per_minute': 1700, 'concurrency': 3, "
        "'supports_structured_outputs_override': False, "
        "'supports_native_search_override': True}"
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


def test_classify_section_failure_maps_known_exceptions():
    """S9: section failures are mapped to structured reasons for observability."""
    from app.services.result_report import builder

    assert builder._classify_section_failure(TimeoutError()) == "timeout"
    assert builder._classify_section_failure(asyncio.TimeoutError()) == "timeout"
    assert (
        builder._classify_section_failure(
            builder.ResultReportBuilderError(
                "Section payload must be an object",
                reason="json_parse_error",
            )
        )
        == "json_parse_error"
    )
    assert (
        builder._classify_section_failure(
            builder.ResultReportBuilderError(
                "Unsupported section action: <empty>",
                reason="unsupported_action",
            )
        )
        == "unsupported_action"
    )
    # An unclassified error falls back to ``other``; ``None`` too.
    assert builder._classify_section_failure(ValueError("boom")) == "other"
    assert builder._classify_section_failure(None) == "other"


def test_classify_section_failure_rejects_unknown_exception_reason():
    """S9: raw exception reasons must stay inside the public schema enum."""
    from app.services.result_report import builder

    error = builder.ResultReportBuilderError(
        "provider returned opaque failure",
        reason="upstream_provider_meltdown",
    )

    assert builder._classify_section_failure(error) == "other"


def test_report_section_observability_fields_default_and_roundtrip():
    """S9: ``tier``/``failure_reason`` default for legacy payloads and persist."""
    legacy = ReportSection(
        id="timeline",
        title="Timeline",
        title_i18n=I18nText(zh="时间线", en="Timeline"),
        intent="Lay out the timeline.",
        body_md_i18n=I18nText(zh="正文", en="Body"),
    )
    # Legacy reports (no tier/failure_reason persisted) deserialize unchanged.
    assert legacy.tier == "generation"
    assert legacy.failure_reason is None

    static_section = ReportSection(
        id="sources",
        title="Sources",
        title_i18n=I18nText(zh="来源", en="Sources"),
        intent="List the sources.",
        body_md_i18n=I18nText(zh="正文", en="Body"),
        tier="static",
        failure_reason="timeout",
    )
    dumped = static_section.model_dump(mode="json")
    assert dumped["tier"] == "static"
    assert dumped["failure_reason"] == "timeout"
    assert ReportSection.model_validate(dumped).failure_reason == "timeout"


def test_static_section_records_failure_reason():
    """S9: the static fallback records why the section dropped offline."""
    from app.services.result_report import builder

    reducer_result = builder.reduce_report(get_engine(), _seed_report_scenario())
    section_plan = builder.SectionPlan(
        section_id="timeline",
        title_i18n={"zh": "时间线", "en": "Timeline"},
        intent="Lay out the timeline.",
    )
    context = builder.BuilderContext(
        scenario_id="scenario-report",
        question="Question?",
        language="en",
        parsed_context={},
        branch_id="branch-a",
        branch_title="Branch A",
        branch_story="A populated story keeps the body non-empty.",
        branch_insight="A populated insight.",
        web_context_blocks=[],
    )
    result = builder._static_section_from_context(
        context,
        section_plan,
        reducer_result,
        failure_reason="timeout",
    )
    assert result.tier == "static"
    assert result.section.tier == "static"
    assert result.section.failure_reason == "timeout"

    # When there is no source body, the reason collapses to ``empty_body``.
    empty_context = builder.BuilderContext(
        scenario_id="scenario-report",
        question="Question?",
        language="en",
        parsed_context={},
        branch_id="branch-a",
        branch_title="Branch A",
        branch_story="",
        branch_insight="",
        web_context_blocks=[],
    )
    empty_result = builder._static_section_from_context(
        empty_context,
        section_plan,
        reducer_result,
        failure_reason="timeout",
    )
    assert empty_result.section.failure_reason == "empty_body"


def test_static_section_describes_single_missing_and_multi_branch_uncertainty_truthfully():
    reducer_result = builder.reduce_report(get_engine(), _seed_report_scenario())
    section_plan = builder.SectionPlan(
        section_id="timeline",
        title_i18n={"zh": "时间线", "en": "Timeline"},
        intent="Lay out the timeline.",
    )
    context = builder.BuilderContext(
        scenario_id="scenario-report",
        question="Question?",
        language="en",
        parsed_context={},
        branch_id="branch-a",
        branch_title="Branch A",
        branch_story="A populated story.",
        branch_insight="A populated insight.",
        web_context_blocks=[],
    )

    single_path = replace(
        reducer_result,
        branch_distribution=reducer_result.branch_distribution[:1],
        likelihood=Likelihood(
            probability=1.0,
            interval=(1.0, 1.0),
            wep="single_path",
        ),
    )
    single_section = builder._static_section_from_context(
        context,
        section_plan,
        single_path,
    ).section.body_md_i18n
    assert "只有一条模拟路径" in single_section.zh
    assert "无法比较" in single_section.zh
    assert "不代表现实发生率" in single_section.zh
    assert "Only one simulated path" in single_section.en
    assert "cannot compare" in single_section.en
    assert "does not represent a real-world occurrence rate" in single_section.en
    assert all(token not in single_section.zh for token in ("100%", "概率为", "路线概率"))
    assert all(
        token not in single_section.en.lower()
        for token in ("100%", "probability is", "route probability")
    )

    missing = replace(
        reducer_result,
        likelihood=Likelihood(
            probability=0.0,
            interval=(0.0, 0.0),
            wep="missing",
        ),
    )
    missing_section = builder._static_section_from_context(
        context,
        section_plan,
        missing,
    ).section.body_md_i18n
    assert "没有可比较的模拟分支占比" in missing_section.zh
    assert "不代表现实发生率" in missing_section.zh
    assert "No comparable simulated branch share" in missing_section.en
    assert "does not represent a real-world occurrence rate" in missing_section.en
    assert all(token not in missing_section.zh for token in ("0%", "概率为", "路线概率"))
    assert all(
        token not in missing_section.en.lower()
        for token in ("0%", "probability is", "route probability")
    )

    multi_branch = replace(
        reducer_result,
        likelihood=Likelihood(
            probability=1.0,
            interval=(0.9, 1.0),
            wep="almost_certain",
        ),
    )
    multi_section = builder._static_section_from_context(
        context,
        section_plan,
        multi_branch,
    ).section.body_md_i18n
    assert "主导模拟分支占比为 100%" in multi_section.zh
    assert "不代表现实发生概率" in multi_section.zh
    assert "dominant simulated branch share is 100%" in multi_section.en.lower()
    assert "not a real-world probability" in multi_section.en.lower()
    assert "路线概率" not in multi_section.zh
    assert "route probability" not in multi_section.en.lower()


def _seed_split_brain_scenario() -> str:
    """Dominant COMPLETED leaf with empty content + a content-bearing sibling leaf.

    M-1 (W1-1 follow-up): when the endpoint's dominant leaf has no story/insight,
    ``_pick_target`` rejects it and anchors evidence on the content-bearing sibling.
    The builder must follow the reducer's anchor (header/context/evidence on the same
    branch) instead of being dragged onto the empty dominant leaf.
    """

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            id="scenario-split-brain",
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
        session.add(
            Agent(
                id="sb-agent",
                scenario_id=scenario.id,
                name="Privacy Advocate",
                role="Civil society",
                persona="Civil-rights organizer",
            ),
        )
        session.add_all(
            [
                Branch(
                    id="branch-split-root",
                    scenario_id=scenario.id,
                    title="Root aggregate",
                    probability=1.0,
                    fork_round=0,
                    status=BranchStatus.COMPLETED,
                    story="",
                    insight="",
                ),
                # Higher-probability dominant leaf, COMPLETED but content-less
                # (empty story AND insight) — narration failed for this leaf.
                # ``fork_round=1`` so it is a terminal leaf (not a prologue root).
                Branch(
                    id="branch-empty-dominant",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-split-root",
                    title="Empty dominant leaf",
                    probability=0.70,
                    fork_round=1,
                    status=BranchStatus.COMPLETED,
                    story="",
                    insight="",
                ),
                # Lower-probability sibling leaf that actually has content +
                # message-level evidence.
                Branch(
                    id="branch-rich-sibling",
                    scenario_id=scenario.id,
                    parent_branch_id="branch-split-root",
                    title="Approval with safeguards",
                    probability=0.30,
                    fork_round=1,
                    status=BranchStatus.COMPLETED,
                    story="The proposal passes after council members accept privacy limits.",
                    insight="Privacy safeguards unlock a narrow coalition.",
                ),
            ],
        )
        session.add_all(
            [
                Round(id="sb-root-round-1", branch_id="branch-split-root", round_number=1),
                Round(id="sb-round-2", branch_id="branch-rich-sibling", round_number=2),
            ]
        )
        session.add(
            AgentMessage(
                id="sb-msg",
                round_id="sb-round-2",
                agent_id="sb-agent",
                content="Privacy safeguards make the approval defensible.",
                emotion="focused",
                diverge="privacy safeguards",
            ),
        )
        session.commit()
    return "scenario-split-brain"


def test_persist_failed_report_resolves_empty_dominant_to_reducer_anchor():
    from app.services.result_report import builder

    scenario_id = _seed_split_brain_scenario()

    failed = builder._persist_failed_report_if_absent(
        scenario_id,
        "branch-empty-dominant",
    )

    assert failed.status == "failed"
    assert failed.target_branch_id == "branch-rich-sibling"
    assert failed.verdict.likelihood.probability == 0.30


@pytest.mark.asyncio
async def test_build_report_target_follows_reducer_anchor_not_empty_dominant(monkeypatch):
    """M-1: an empty-content dominant leaf must not drag the report target away from
    the reducer's content-bearing anchor; header/context/evidence stay on the same
    branch the evidence is actually drawn from."""
    from app.services.result_report import builder

    scenario_id = _seed_split_brain_scenario()
    fake_llm = QueuedLlm(
        [
            _outline_payload(["timeline", "sources"]),
            _section_payload("timeline"),
            _section_payload("sources"),
            # interview tier
            {"action": "interview_agents", "interview_evidence": []},
            # indicators tier (LLM): fail-soft to the template tier so this test
            # stays focused on the target/evidence anchor.
            builder.ResultReportBuilderError("force template indicators"),
        ],
    )
    monkeypatch.setattr(builder, "llm_call_json", fake_llm)

    # Endpoint hands in the *empty* dominant leaf as the dominant branch id.
    report = await builder.build_report(
        scenario_id,
        "branch-empty-dominant",
        overrides=None,
    )

    assert isinstance(report, FullReport)
    # The report anchors on the content-bearing sibling chosen by the reducer,
    # NOT the empty dominant leaf the endpoint passed in.
    assert report.target_branch_id == "branch-rich-sibling"
    assert report.evidence, "expected evidence drawn from the content-bearing leaf"
    assert {item.branch_id for item in report.evidence} == {"branch-rich-sibling"}
    # No split-brain: the report target equals the branch the evidence comes from.
    assert all(item.branch_id == report.target_branch_id for item in report.evidence)


@pytest.mark.asyncio
async def test_build_report_uses_llm_indicators_grounded_on_real_evidence(monkeypatch):
    """S3: the LLM indicator tier replaces the static template, binds real evidence
    coordinates, and is rejected (fail-soft to template) if it emits blacklisted slop."""
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()

    def route(prompt: str):
        if prompt.startswith("REPORT_INDICATORS"):
            return {
                "action": "indicators_to_watch",
                "indicators": [
                    {
                        "signal": "Council privacy subcommittee publishes a binding amendment",
                        "direction": "up",
                        "note": (
                            "Whether the privacy safeguards Privacy Advocate flagged "
                            "get codified decides if the AI transit plan actually passes."
                        ),
                        "threshold": (
                            "Flip: the subcommittee tables the amendment for >2 cycles; "
                            "Reinforce: a recorded vote adopts the privacy limits verbatim."
                        ),
                        "observation": "Round 1 Privacy Advocate tied approval to safeguards.",
                        "time_horizon": "Next council session",
                        "rationale": "Bound to the privacy-safeguard evidence coordinate.",
                        "evidence_refs": ["ev_001"],
                    },
                ],
            }
        if prompt.startswith("REPORT_INTERVIEWS"):
            return {"action": "interview_agents", "interview_evidence": []}
        if prompt.startswith("REPORT_SECTION_REACT"):
            # Section id is embedded in the prompt; reuse the generic payload.
            return {
                "action": "final_section",
                "body_md_i18n": {"zh": "正文", "en": "Body explains safeguards."},
                "evidence_refs": ["ev_001"],
            }
        # outline
        return _outline_payload(["timeline", "sources"])

    monkeypatch.setattr(builder, "llm_call_json", QueuedLlm([route, route, route, route, route]))

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert isinstance(report, FullReport)
    assert report.indicators_to_watch, "expected indicators"
    first = report.indicators_to_watch[0]
    # LLM tier was used (its bespoke signal, not the template wording).
    assert "subcommittee" in first.signal
    # Grounded on a real reducer evidence id.
    assert first.evidence_refs == ["ev_001"]
    # No blacklisted slop anywhere in the indicators.
    for indicator in report.indicators_to_watch:
        blob = " ".join(
            [
                indicator.signal,
                indicator.note,
                indicator.threshold,
                indicator.observation,
                indicator.rationale,
            ]
        )
        assert not builder._indicator_text_is_slop(blob)


def test_normalize_indicators_payload_rejects_blacklisted_slop():
    """S3/AC-4: a slop-laden LLM batch is rejected so the template tier takes over."""
    from app.services.result_report import builder

    reducer_result = builder.reduce_report(get_engine(), _seed_report_scenario())
    context = builder.BuilderContext(
        scenario_id="scenario-report",
        question="Will the plan pass?",
        language="zh",
        parsed_context={},
        branch_id="branch-a",
        branch_title="Branch A",
        branch_story="Story",
        branch_insight="Insight",
        web_context_blocks=[],
    )
    slop_payload = {
        "action": "indicators_to_watch",
        "indicators": [
            {
                "signal": "继续观察",
                "direction": "up",
                "note": "如果这个信号持续出现，它会强化主导路线。",
                "threshold": "同一议题被另一位参与者再次提及。",
                "evidence_refs": ["ev_001"],
            },
        ],
    }
    with pytest.raises(builder.ResultReportBuilderError):
        builder._normalize_indicators_payload(slop_payload, context, reducer_result)


@pytest.mark.asyncio
async def test_interview_indicators_concurrent_citations_do_not_cross(monkeypatch):
    """M-2 correctness gate: ``_build_interview_evidence`` and ``_build_indicators_llm``
    run concurrently via ``asyncio.gather``. Each opens its own ``llm_request_scope`` and
    its LLM call writes the ``_last_native_citations`` ContextVar. asyncio copies the
    context per Task, so the two calls' citations / quota scope MUST stay isolated even
    when their set/read operations interleave. A regression to ``threading.local`` (or any
    module-level mutable) would let one call read the sibling's citations -> assertion red.
    """
    from app.services import llm_client
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()

    reducer_result = builder.reduce_report(get_engine(), scenario_id, dominant_branch_id="branch-a")
    assert reducer_result.evidence, "seed must yield evidence so the indicators LLM tier runs"
    context = builder.BuilderContext(
        scenario_id="scenario-report",
        question="Should the city approve the AI transit plan?",
        language="en",
        parsed_context={},
        branch_id="branch-a",
        branch_title="Branch A",
        branch_story="Story",
        branch_insight="Insight",
        web_context_blocks=[],
    )

    # What each concurrent call observed for its OWN citations after interleaving.
    observed: dict[str, list[Any]] = {}
    evidence_id = next(iter({item.id for item in reducer_result.evidence}))

    async def fake_llm_call_json(prompt: str, **_kwargs: Any) -> dict[str, Any]:
        if prompt.startswith("REPORT_INTERVIEWS"):
            tag, marker = "interview", "cite-interview"
        elif prompt.startswith("REPORT_INDICATORS"):
            tag, marker = "indicators", "cite-indicators"
        else:  # pragma: no cover - only the two concurrent calls reach this stub
            raise AssertionError(f"unexpected concurrent LLM call: {prompt[:40]!r}")
        # Write this call's marker into the citation ContextVar, then yield control
        # repeatedly so the sibling coroutine runs its own set() in between.
        llm_client._last_native_citations.set([marker])
        for _ in range(3):
            await asyncio.sleep(0)
        # After the interleave window, read back what WE see. Under correct ContextVar
        # isolation this is still our own marker; under cross-contamination it is the
        # sibling's (or a mix).
        observed[tag] = llm_client.get_last_native_citations()
        if tag == "interview":
            return {
                "action": "interview_agents",
                "interview_evidence": [
                    {
                        "agent_name": "Privacy Advocate",
                        "excerpt": "Privacy safeguards make the approval defensible.",
                    }
                ],
            }
        return {
            "action": "indicators_to_watch",
            "indicators": [
                {
                    "signal": "Council privacy subcommittee publishes a binding amendment",
                    "direction": "up",
                    "note": (
                        "Whether the privacy safeguards get codified decides if the "
                        "AI transit plan actually passes."
                    ),
                    "threshold": (
                        "Flip: the subcommittee tables the amendment for >2 cycles; "
                        "Reinforce: a recorded vote adopts the privacy limits verbatim."
                    ),
                    "observation": "Round 1 Privacy Advocate tied approval to safeguards.",
                    "time_horizon": "Next council session",
                    "rationale": "Bound to the privacy-safeguard evidence coordinate.",
                    "evidence_refs": [evidence_id],
                },
            ],
        }

    monkeypatch.setattr(builder, "llm_call_json", fake_llm_call_json)

    interview_result, indicators_result = await asyncio.gather(
        builder._build_interview_evidence(context, reducer_result, overrides=None),
        builder._build_indicators_llm(context, reducer_result, overrides=None),
    )

    # Both concurrent calls actually ran and each read back ONLY its own citation marker.
    assert observed == {
        "interview": ["cite-interview"],
        "indicators": ["cite-indicators"],
    }, f"native citations crossed between concurrent report calls: {observed}"

    # The two paths produced their own real results (the gather did not swap payloads).
    interview_evidence, interview_status = interview_result
    assert any(row["agent_name"] == "Privacy Advocate" for row in interview_evidence)
    assert interview_status.status in {"complete", "partial"}
    assert indicators_result and "subcommittee" in indicators_result[0].signal
    assert indicators_result[0].evidence_refs == [evidence_id]


_FORCE_FINAL_MARKER = "the query tool cannot return"


def _tool_action_payload() -> dict[str, Any]:
    return {"action": "query_branch_messages", "params": {"query": "more"}}


@pytest.mark.asyncio
async def test_section_no_progress_tool_call_forces_final_not_static(monkeypatch):
    """W1-3: when the model keeps calling the re-serve tool (no new evidence), the
    loop pivots to a forced final answer instead of spinning into a static tier."""
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    section_prompts: list[str] = []

    def route(prompt: str):
        if prompt.startswith("REPORT_OUTLINE"):
            return _outline_payload(["timeline"])
        if prompt.startswith("REPORT_SECTION_REACT"):
            section_prompts.append(prompt)
            # Disobey on the first pass (tool call), then honor the forced-final
            # directive once it appears in the prompt.
            if _FORCE_FINAL_MARKER in prompt:
                return _section_payload("timeline", body="Forced final on real evidence.")
            return _tool_action_payload()
        if prompt.startswith("REPORT_INTERVIEWS"):
            return {"action": "interview_agents", "interview_evidence": []}
        # Indicators fail-soft to the template tier.
        return builder.ResultReportBuilderError("force template indicators")

    monkeypatch.setattr(builder.settings, "REPORT_MIN_SECTIONS", 1)
    monkeypatch.setattr(builder, "llm_call_json", QueuedLlm([route] * 24))

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    assert report.status == "complete"
    timeline = next(section for section in report.sections if section.id == "timeline")
    # The section is grounded LLM output, NOT the static fallback.
    assert timeline.tier != "static"
    assert timeline.failure_reason is None
    assert timeline.body_md_i18n.en == "Forced final on real evidence."
    # The forced-final directive actually reached the model.
    assert any(_FORCE_FINAL_MARKER in prompt for prompt in section_prompts)
    # The no-progress guard bounds section calls to the per-tier ceiling (3) — it
    # never spins past the tool budget into static.
    assert len(section_prompts) <= builder.settings.REPORT_MAX_TOOL_CALLS_PER_SECTION


@pytest.mark.asyncio
async def test_first_empty_evidence_tool_call_forces_final_on_next_step(monkeypatch):
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    context = builder._load_builder_context(scenario_id, "branch-a")
    reducer_result = replace(
        builder.reduce_report(get_engine(), scenario_id),
        evidence=[],
    )
    section = builder.SectionPlan(
        section_id="timeline",
        title_i18n={"zh": "时间线", "en": "Timeline"},
        intent="Trace what happened.",
    )
    prompts: list[str] = []

    async def route(prompt: str, **_kwargs: Any) -> dict[str, Any]:
        prompts.append(prompt)
        if _FORCE_FINAL_MARKER in prompt:
            return _section_payload("timeline", body="Finalized with no evidence rows.")
        return _tool_action_payload()

    monkeypatch.setattr(builder, "llm_call_json", route)

    result = await builder._generate_section_tier(
        context,
        section,
        reducer_result,
        overrides=None,
        tier="generation",
    )

    assert result.section.body_md_i18n.en == "Finalized with no evidence rows."
    assert len(prompts) == 2
    assert _FORCE_FINAL_MARKER in prompts[1]


@pytest.mark.asyncio
async def test_section_ignoring_final_directive_is_bounded_then_static(monkeypatch):
    """W1-3: a model that refuses to ever emit a final (always calls the tool, even
    after the final-only directive) is bounded by the tool budget and degrades to
    the static tier rather than looping unbounded."""
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    section_prompts: list[str] = []

    def route(prompt: str):
        if prompt.startswith("REPORT_OUTLINE"):
            return _outline_payload(["timeline"])
        if prompt.startswith("REPORT_SECTION_REACT"):
            section_prompts.append(prompt)
            return _tool_action_payload()  # never finalizes
        if prompt.startswith("REPORT_INTERVIEWS"):
            return {"action": "interview_agents", "interview_evidence": []}
        return builder.ResultReportBuilderError("force template indicators")

    monkeypatch.setattr(builder.settings, "REPORT_MIN_SECTIONS", 1)
    monkeypatch.setattr(builder, "llm_call_json", QueuedLlm([route] * 24))

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    timeline = next(section for section in report.sections if section.id == "timeline")
    assert timeline.tier == "static"
    # Two tiers (generation + rewrite) each bounded by the tool ceiling — no runaway.
    assert len(section_prompts) <= builder.settings.REPORT_MAX_TOOL_CALLS_PER_SECTION * 2


def _slow_section_llm(delay: float):
    """Stub whose section call takes ``delay`` seconds before finalizing; outline is
    instant and interview/indicators fail-soft. Used to demonstrate that the per-call
    timeout (REPORT_SECTION_TIMEOUT_SECONDS) is what converts a slow response into a
    static fallback — the exact failure mode the W1-3 60→120s bump removes."""

    async def stub(prompt: str, **_kwargs: Any) -> dict[str, Any]:
        if prompt.startswith("REPORT_OUTLINE"):
            return _outline_payload(["timeline"])
        if prompt.startswith("REPORT_SECTION_REACT"):
            await asyncio.sleep(delay)
            return _section_payload("timeline", body="Generated despite slow response.")
        if prompt.startswith("REPORT_INTERVIEWS"):
            return {"action": "interview_agents", "interview_evidence": []}
        raise builder_module_error()

    return stub


def builder_module_error():
    from app.services.result_report import builder

    return builder.ResultReportBuilderError("force template indicators")


@pytest.mark.asyncio
async def test_slow_section_times_out_to_static_under_short_timeout(monkeypatch):
    """AC-11 mechanism (BEFORE): a section LLM response slower than the per-call
    timeout falls back to the static tier with failure_reason='timeout'."""
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    monkeypatch.setattr(builder.settings, "REPORT_MIN_SECTIONS", 1)
    monkeypatch.setattr(builder.settings, "REPORT_SECTION_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(builder, "llm_call_json", _slow_section_llm(0.25))

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    timeline = next(section for section in report.sections if section.id == "timeline")
    assert timeline.tier == "static"
    assert timeline.failure_reason == "timeout"


@pytest.mark.asyncio
async def test_slow_section_succeeds_under_longer_timeout(monkeypatch):
    """AC-11 mechanism (AFTER): the SAME slow response now finishes within the larger
    per-call timeout, so the section is real LLM output instead of a static fallback.
    This is the deterministic isolation of the 60→120s effect the noisy live LLM
    measurement cannot show cleanly."""
    from app.services.result_report import builder

    scenario_id = _seed_report_scenario()
    monkeypatch.setattr(builder.settings, "REPORT_MIN_SECTIONS", 1)
    monkeypatch.setattr(builder.settings, "REPORT_SECTION_TIMEOUT_SECONDS", 1.0)
    monkeypatch.setattr(builder, "llm_call_json", _slow_section_llm(0.25))

    report = await builder.build_report(scenario_id, "branch-a", overrides=None)

    timeline = next(section for section in report.sections if section.id == "timeline")
    assert timeline.tier != "static"
    assert timeline.failure_reason is None
    assert timeline.body_md_i18n.en == "Generated despite slow response."
