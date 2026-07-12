"""Sprint S0 contract tests for the result report IR."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlmodel import Session, select

from app.main import app
from app.models import Branch, BranchStatus, Scenario, ScenarioStatus
from app.models.database import get_engine


def _seed_scenario_with_branch(*, full_report: dict | None = None) -> str:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="Should the city approve the AI transit plan?",
            status=ScenarioStatus.DONE,
            parsed_context={"full_report": full_report} if full_report is not None else {},
        )
        session.add(scenario)
        session.commit()
        branch = Branch(
            scenario_id=scenario.id,
            title="Approval with safeguards",
            probability=0.68,
            status=BranchStatus.COMPLETED,
            story="The plan passes after privacy concessions.",
            insight="Privacy safeguards unlock a narrow coalition.",
        )
        session.add(branch)
        session.commit()
        return scenario.id


def _legal_full_report() -> dict:
    return {
        "version": "1.0",
        "generated_at": "2026-06-08T00:00:00Z",
        "generation_mode": "generation",
        "target_branch_id": "branch-1",
        "target_branch_sort": ["probability_desc", "fork_round_asc", "id_asc"],
        "language": "zh",
        "available_languages": ["zh", "en"],
        "title": "AI transit plan report",
        "title_i18n": {"zh": "AI 公交计划报告", "en": "AI transit plan report"},
        "summary": "The proposal likely passes after privacy safeguards.",
        "summary_i18n": {
            "zh": "加入隐私保护后，方案更可能通过。",
            "en": "The proposal likely passes after privacy safeguards.",
        },
        "status": "complete",
        "tier": "generation",
        "verdict": {
            "headline_answer": "The plan is likely to pass with safeguards.",
            "likelihood": {
                "probability": 0.68,
                "interval": [0.55, 0.76],
                "wep": "likely",
            },
            "analytic_confidence": {
                "level": "medium",
                "basis": "Several agents converged on the privacy compromise.",
            },
            "disclaimer": "This is a narrative simulation probability, not a real-world forecast.",
        },
        "sections": [
            {
                "id": "timeline",
                "title": "Turning points",
                "title_i18n": {"zh": "关键转折", "en": "Turning points"},
                "intent": "Explain why the dominant branch won.",
                "body_md_i18n": {
                    "zh": "**隐私让步**把反对方拉回谈判桌。",
                    "en": "**Privacy concessions** brought skeptics back to the table.",
                },
                "evidence_refs": ["ev-1"],
                "charts": [
                    {
                        "kind": "probability_bar",
                        "type": "probability_bar",
                        "data": {
                            "status": "available",
                            "sort": [
                                "probability_desc",
                                "fork_round_asc",
                                "id_asc",
                            ],
                            "branches": [
                                {
                                    "branch_id": "branch-1",
                                    "label": "Approval with safeguards",
                                    "probability": 0.68,
                                    "dominant": True,
                                    "status": "COMPLETED",
                                },
                            ],
                        },
                    },
                ],
            },
        ],
        "evidence": [
            {
                "id": "ev-1",
                "branch_id": "branch-1",
                "round_id": "round-1",
                "round_number": 3,
                "agent_id": "agent-1",
                "agent_name": "Transit Advocate",
                "message_id": "msg-1",
                "quote": "Privacy concessions make the plan defensible.",
                "kind": "utterance",
            },
        ],
        "indicators_to_watch": [
            {
                "signal": "Privacy amendment adoption",
                "direction": "up",
                "note": "Adoption would raise the odds of passage.",
                "threshold": "The amendment is accepted before the final vote.",
                "observation": "Council members repeat the privacy safeguard condition.",
                "time_horizon": "next vote cycle",
                "rationale": "Supported by evidence ev-1.",
                "evidence_refs": ["ev-1"],
            },
        ],
        "dissenting": {
            "runner_up_branch_id": "branch-2",
            "why_verdict_could_be_wrong": "Labor opposition could harden.",
            "what_almost_won": "A delay coalition nearly forced a committee review.",
        },
        "key_participants": [
            {
                "agent_name": "Transit Advocate",
                "impact_score": 0.82,
                "key_moment_hits": 2,
            },
        ],
        "follow_ups": ["Which safeguard matters most?"],
        "limitations": "The result depends on simulated stakeholder behavior.",
        "interview_evidence": [],
        "interview_status": {
            "status": "skipped",
            "requested_agents": 0,
            "completed_agents": 0,
            "truncated_agents": 0,
            "error_code": None,
            "message": "No interview candidates were available.",
        },
        "premortem": [],
        "language_status": {"zh": "available", "en": "available"},
    }


def _premortem_item(*evidence_refs: str, item_id: str = "pm_001") -> dict:
    return {
        "id": item_id,
        "failure_mode_i18n": {
            "zh": "隐私联盟瓦解",
            "en": "Privacy coalition collapses",
        },
        "mechanism_i18n": {
            "zh": "保障条款被削弱后，关键支持者退出。",
            "en": "Key supporters exit after safeguards are weakened.",
        },
        "early_warning_i18n": {
            "zh": "支持者停止重复隐私条件。",
            "en": "Supporters stop repeating the privacy condition.",
        },
        "uncertainty_i18n": {
            "zh": "模拟未覆盖最终修正案文本。",
            "en": "The simulation does not cover the final amendment text.",
        },
        "evidence_chain": [
            {
                "evidence_ref": evidence_ref,
                "role": "failure_signal" if index == 0 else "failure_mechanism",
                "rationale_i18n": {
                    "zh": f"证据 {evidence_ref} 提供失败链坐标。",
                    "en": f"Evidence {evidence_ref} supplies a failure-chain coordinate.",
                },
            }
            for index, evidence_ref in enumerate(evidence_refs)
        ],
    }


def _add_second_premortem_evidence(payload: dict) -> None:
    payload["evidence"].append(
        {
            "id": "ev-2",
            "branch_id": "branch-1",
            "round_id": "round-2",
            "round_number": 4,
            "agent_id": "agent-2",
            "agent_name": "Privacy Skeptic",
            "message_id": "msg-2",
            "quote": "Removing the safeguard would dissolve the coalition.",
            "kind": "utterance",
        }
    )


def test_full_report_schema_accepts_legal_payload_and_freezes_fields():
    from app.services.result_report.schema import (
        Chart,
        EvidenceRef,
        FullReport,
        IndicatorToWatch,
        ReportSection,
        validate_full_report_payload,
    )

    report = validate_full_report_payload(_legal_full_report())

    assert isinstance(report, FullReport)
    assert set(FullReport.model_fields) == {
        "version",
        "generated_at",
        "generation_mode",
        "target_branch_id",
        "target_branch_sort",
        "language",
        "available_languages",
        "title",
        "title_i18n",
        "summary",
        "summary_i18n",
        "status",
        "tier",
        "verdict",
        "sections",
        "evidence",
        "indicators_to_watch",
        "dissenting",
        "key_participants",
        "follow_ups",
        "limitations",
        "interview_evidence",
        "interview_status",
        "premortem",
        "premortem_analysis",
        "language_status",
        "tool_trace",
    }
    assert set(ReportSection.model_fields) == {
        "id",
        "title",
        "title_i18n",
        "intent",
        "body_md_i18n",
        "evidence_refs",
        "charts",
        "tier",
        "failure_reason",
    }
    assert set(Chart.model_fields) == {
        "kind",
        "type",
        "data",
    }
    assert set(EvidenceRef.model_fields) == {
        "id",
        "branch_id",
        "round_id",
        "round_number",
        "agent_id",
        "agent_name",
        "message_id",
        "quote",
        "kind",
    }
    assert set(IndicatorToWatch.model_fields) == {
        "signal",
        "direction",
        "note",
        "threshold",
        "observation",
        "time_horizon",
        "rationale",
        "evidence_refs",
    }


def test_opaque_legacy_premortem_remains_when_structured_analysis_is_unimplemented():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    legacy_premortem = [{"legacy_shape": {"remains": ["opaque", 7]}}]
    payload["premortem"] = legacy_premortem

    report = validate_full_report_payload(payload)

    assert report.premortem == legacy_premortem
    assert report.premortem_analysis is None


def test_premortem_analysis_coexists_with_nonempty_opaque_legacy_premortem():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    _add_second_premortem_evidence(payload)
    legacy_premortem = [{"legacy_shape": {"remains": ["opaque", 7]}}]
    payload["premortem"] = legacy_premortem
    payload["premortem_analysis"] = {
        "status": "available",
        "reason": None,
        "items": [_premortem_item("ev-1", "ev-2")],
    }

    report = validate_full_report_payload(payload)

    assert report.premortem == legacy_premortem
    assert report.premortem_analysis is not None
    assert report.premortem_analysis.status == "available"


@pytest.mark.parametrize(
    "reason",
    [
        "no_distinct_evidence",
        "insufficient_source_diversity",
        "generation_failed",
        "lineage_unavailable",
        "report_generation_failed",
        "byte_budget_truncated",
    ],
)
def test_premortem_analysis_accepts_each_frozen_missing_reason(reason):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["premortem_analysis"] = {
        "status": "missing",
        "reason": reason,
        "items": [],
    }

    assert validate_full_report_payload(payload).premortem_analysis.reason == reason


def test_premortem_analysis_accepts_available_diverse_evidence_chain():
    from app.services.result_report.schema import (
        PremortemAnalysis,
        PremortemEvidenceLink,
        PremortemFailureMode,
        validate_full_report_payload,
    )

    payload = _legal_full_report()
    _add_second_premortem_evidence(payload)
    payload["premortem_analysis"] = {
        "status": "available",
        "reason": None,
        "items": [_premortem_item("ev-1", "ev-2")],
    }

    report = validate_full_report_payload(payload)

    assert isinstance(report.premortem_analysis, PremortemAnalysis)
    assert set(PremortemAnalysis.model_fields) == {"status", "reason", "items"}
    assert set(PremortemFailureMode.model_fields) == {
        "id",
        "failure_mode_i18n",
        "mechanism_i18n",
        "early_warning_i18n",
        "uncertainty_i18n",
        "evidence_chain",
    }
    assert set(PremortemEvidenceLink.model_fields) == {
        "evidence_ref",
        "role",
        "rationale_i18n",
    }
    assert report.premortem_analysis.status == "available"


@pytest.mark.parametrize(
    "mutation",
    [
        lambda analysis: analysis.__setitem__("extra", "forbidden"),
        lambda analysis: analysis["items"][0].__setitem__("extra", "forbidden"),
        lambda analysis: analysis["items"][0]["evidence_chain"][0].__setitem__(
            "extra", "forbidden"
        ),
        lambda analysis: analysis["items"][0]["evidence_chain"][0].__setitem__(
            "role", "statistical_independence"
        ),
        lambda analysis: analysis["items"][0]["evidence_chain"][0].__setitem__(
            "evidence_ref", "   "
        ),
        lambda analysis: analysis["items"][0]["evidence_chain"][0][
            "rationale_i18n"
        ].__setitem__("en", "   "),
        lambda analysis: analysis.__setitem__("reason", "unbounded_free_text"),
    ],
)
def test_premortem_analysis_rejects_extra_fields_and_unbounded_enums(mutation):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    _add_second_premortem_evidence(payload)
    analysis = {
        "status": "available",
        "reason": None,
        "items": [_premortem_item("ev-1", "ev-2")],
    }
    mutation(analysis)
    payload["premortem_analysis"] = analysis

    with pytest.raises((ValidationError, ValueError)):
        validate_full_report_payload(payload)


@pytest.mark.parametrize(
    "analysis",
    [
        {"status": "missing", "reason": None, "items": []},
        {
            "status": "missing",
            "reason": "no_distinct_evidence",
            "items": [_premortem_item()],
        },
        {"status": "partial", "reason": "no_distinct_evidence", "items": []},
        {"status": "partial", "reason": None, "items": [_premortem_item("ev-1")]},
        {"status": "available", "reason": None, "items": []},
        {
            "status": "available",
            "reason": "insufficient_source_diversity",
            "items": [_premortem_item("ev-1", "ev-2")],
        },
    ],
)
def test_premortem_analysis_rejects_invalid_status_invariants(analysis):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    _add_second_premortem_evidence(payload)
    payload["premortem_analysis"] = analysis

    with pytest.raises((ValidationError, ValueError)):
        validate_full_report_payload(payload)


def test_premortem_analysis_accepts_missing_and_partial_states():
    from app.services.result_report.schema import validate_full_report_payload

    missing_payload = _legal_full_report()
    missing_payload["premortem_analysis"] = {
        "status": "missing",
        "reason": "no_distinct_evidence",
        "items": [],
    }
    missing = validate_full_report_payload(missing_payload)

    partial_payload = _legal_full_report()
    partial_payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "insufficient_source_diversity",
        "items": [_premortem_item("ev-1")],
    }
    partial = validate_full_report_payload(partial_payload)

    assert missing.premortem_analysis is not None
    assert missing.premortem_analysis.items == []
    assert partial.premortem_analysis is not None
    assert partial.premortem_analysis.items[0].uncertainty_i18n.zh


@pytest.mark.parametrize("evidence_ids", [("ev-1", "ev-1"), ("ev-1", "ev-missing")])
def test_premortem_analysis_rejects_duplicate_or_dangling_chain_refs(evidence_ids):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    _add_second_premortem_evidence(payload)
    payload["premortem_analysis"] = {
        "status": "available",
        "reason": None,
        "items": [_premortem_item(*evidence_ids)],
    }

    with pytest.raises(ValueError):
        validate_full_report_payload(payload)


def test_premortem_available_rejects_insufficient_source_diversity():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    duplicate_coordinate = dict(payload["evidence"][0])
    duplicate_coordinate["id"] = "ev-2"
    payload["evidence"].append(duplicate_coordinate)
    payload["premortem_analysis"] = {
        "status": "available",
        "reason": None,
        "items": [_premortem_item("ev-1", "ev-2")],
    }

    with pytest.raises(ValueError, match="divers"):
        validate_full_report_payload(payload)


def test_premortem_available_rejects_two_coordinates_from_same_agent_and_branch():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    second_coordinate = dict(payload["evidence"][0])
    second_coordinate.update(
        id="ev-2",
        round_id="round-2",
        round_number=4,
        message_id="msg-2",
    )
    payload["evidence"].append(second_coordinate)
    payload["premortem_analysis"] = {
        "status": "available",
        "reason": None,
        "items": [_premortem_item("ev-1", "ev-2")],
    }

    with pytest.raises(ValueError, match="divers"):
        validate_full_report_payload(payload)


def test_premortem_available_accepts_one_agent_across_two_branches():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    second_branch = dict(payload["evidence"][0])
    second_branch.update(
        id="ev-2",
        branch_id="branch-2",
        round_id="round-2",
        round_number=4,
        message_id="msg-2",
    )
    payload["evidence"].append(second_branch)
    payload["premortem_analysis"] = {
        "status": "available",
        "reason": None,
        "items": [_premortem_item("ev-1", "ev-2")],
    }

    assert validate_full_report_payload(payload).premortem_analysis.status == "available"


def test_premortem_partial_rejects_dangling_evidence_ref():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "no_distinct_evidence",
        "items": [_premortem_item("ev-missing")],
    }

    with pytest.raises(ValueError, match="reference"):
        validate_full_report_payload(payload)


@pytest.mark.parametrize(
    "field",
    [
        "failure_mode_i18n",
        "mechanism_i18n",
        "early_warning_i18n",
        "uncertainty_i18n",
    ],
)
def test_premortem_failure_mode_rejects_blank_bilingual_leaf(field):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    item = _premortem_item("ev-1")
    item[field]["zh"] = "   "
    payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "no_distinct_evidence",
        "items": [item],
    }

    with pytest.raises(ValueError, match="nonblank"):
        validate_full_report_payload(payload)


@pytest.mark.parametrize("item_ids", [["pm_01"], ["pm_001", "pm_001"]])
def test_premortem_analysis_rejects_invalid_or_duplicate_failure_mode_ids(item_ids):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "insufficient_source_diversity",
        "items": [
            _premortem_item("ev-1", item_id=item_id)
            for item_id in item_ids
        ],
    }

    with pytest.raises((ValidationError, ValueError)):
        validate_full_report_payload(payload)


def test_premortem_analysis_allows_cross_item_evidence_reuse():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "insufficient_source_diversity",
        "items": [
            _premortem_item("ev-1", item_id="pm_001"),
            _premortem_item("ev-1", item_id="pm_002"),
        ],
    }

    report = validate_full_report_payload(payload)
    assert [item.id for item in report.premortem_analysis.items] == [
        "pm_001",
        "pm_002",
    ]


def test_structured_premortem_rejects_duplicate_top_level_evidence_ids_only_when_present():
    from app.services.result_report.schema import validate_full_report_payload

    legacy_payload = _legal_full_report()
    duplicate = dict(legacy_payload["evidence"][0])
    duplicate["message_id"] = "legacy-duplicate-coordinate"
    legacy_payload["evidence"].append(duplicate)
    assert validate_full_report_payload(legacy_payload).premortem_analysis is None

    structured_payload = _legal_full_report()
    structured_payload["evidence"].append(duplicate)
    structured_payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "insufficient_source_diversity",
        "items": [_premortem_item("ev-1")],
    }
    with pytest.raises(ValueError, match="unique"):
        validate_full_report_payload(structured_payload)


def test_premortem_analysis_rejects_more_than_three_items():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["premortem_analysis"] = {
        "status": "partial",
        "reason": "no_distinct_evidence",
        "items": [
            _premortem_item("ev-1", item_id=f"pm_{index:03d}")
            for index in range(1, 5)
        ],
    }

    with pytest.raises((ValidationError, ValueError)):
        validate_full_report_payload(payload)


def test_full_report_schema_accepts_generating_status():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["status"] = "generating"

    report = validate_full_report_payload(payload)

    assert report.status == "generating"


@pytest.mark.parametrize("status", ["cancelled", "partial"])
def test_full_report_schema_accepts_cancelled_and_legacy_partial_status(status):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["status"] = status

    report = validate_full_report_payload(payload)

    assert report.status == status


@pytest.mark.parametrize(
    ("interval", "expected"),
    [
        ([1.95, 1.0], (1.0, 1.0)),
        ([0.8, 0.3], (0.3, 0.8)),
        ([1.2, 1.5], (1.0, 1.0)),
        ([math.nan, 0.7], (0.7, 0.7)),
        (["not-a-number"], (0.0, 1.0)),
    ],
)
def test_likelihood_schema_normalizes_dirty_intervals(interval, expected):
    from app.services.result_report.schema import Likelihood

    likelihood = Likelihood.model_validate(
        {"probability": 0.42, "interval": interval, "wep": "about_even"}
    )

    assert likelihood.interval == expected


@pytest.mark.parametrize(
    ("probability", "expected"),
    [
        (1.95, 1.0),
        (-0.25, 0.0),
        (math.nan, 0.0),
        (math.inf, 0.0),
    ],
)
def test_likelihood_schema_normalizes_dirty_probability(probability, expected):
    from app.services.result_report.schema import Likelihood

    likelihood = Likelihood.model_validate(
        {"probability": probability, "interval": [0.2, 0.4], "wep": "about_even"}
    )

    assert likelihood.probability == expected


def test_full_report_schema_preserves_stale_report_after_likelihood_normalization():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["verdict"]["likelihood"]["probability"] = 1.95
    payload["verdict"]["likelihood"]["interval"] = [1.95, 1.0]

    report = validate_full_report_payload(payload)

    assert report.verdict.likelihood.probability == 1.0
    assert report.verdict.likelihood.interval == (1.0, 1.0)


def test_full_report_for_story_preserves_legacy_likelihood_without_wep():
    from app.services.result_report.schema import full_report_for_story

    payload = _legal_full_report()
    del payload["verdict"]["likelihood"]["wep"]

    report = full_report_for_story(payload)

    assert report is not None
    assert report["verdict"]["likelihood"]["probability"] == 0.68
    assert report["verdict"]["likelihood"]["interval"] == [0.55, 0.76]
    assert report["verdict"]["likelihood"]["wep"] == "likely"


def test_chart_schema_freezes_known_payload_shapes_and_unknown_passthrough():
    from app.services.result_report.schema import (
        KNOWN_CHART_TYPES,
        Chart,
        FactionShareData,
        ProbabilityBarData,
    )

    assert KNOWN_CHART_TYPES == ("probability_bar", "faction_share")
    assert set(ProbabilityBarData.model_fields) == {
        "status",
        "reason",
        "sort",
        "branches",
    }
    assert set(FactionShareData.model_fields) == {
        "status",
        "reason",
        "factions",
        "relation_edge_count",
        "avg_opposition",
    }

    probability_chart = Chart.model_validate(
        {
            "kind": "probability_bar",
            "data": {
                "status": "available",
                "sort": ["probability_desc", "fork_round_asc", "id_asc"],
                "branches": [
                    {
                        "branch_id": "branch-1",
                        "label": "Approval with safeguards",
                        "probability": 0.68,
                        "dominant": True,
                        "status": "COMPLETED",
                    },
                ],
            },
        }
    )
    assert probability_chart.kind == "probability_bar"
    assert probability_chart.type == "probability_bar"
    assert isinstance(probability_chart.data["branches"], list)
    assert set(probability_chart.data["branches"][0]) == {
        "branch_id",
        "label",
        "probability",
        "dominant",
        "status",
    }
    assert isinstance(probability_chart.data["branches"][0]["label"], str)
    assert isinstance(probability_chart.data["branches"][0]["probability"], float)
    assert isinstance(probability_chart.data["branches"][0]["dominant"], bool)

    faction_chart = Chart.model_validate(
        {
            "kind": "faction_share",
            "type": "faction_share",
            "data": {
                "status": "partial",
                "reason": "relation_edges_missing",
                "factions": [
                    {
                        "faction_key": "pro",
                        "label": "Pro approval",
                        "member_count": 2,
                        "share": 0.6667,
                        "stance_center": 0.8,
                        "confidence": 0.9,
                    },
                ],
                "relation_edge_count": 0,
                "avg_opposition": None,
            },
        }
    )
    assert faction_chart.type == "faction_share"
    assert isinstance(faction_chart.data["factions"], list)
    assert set(faction_chart.data["factions"][0]) == {
        "faction_key",
        "label",
        "member_count",
        "share",
        "stance_center",
        "confidence",
    }
    assert isinstance(faction_chart.data["factions"][0]["member_count"], int)
    assert isinstance(faction_chart.data["relation_edge_count"], int)
    assert faction_chart.data["avg_opposition"] is None

    unknown_chart = Chart.model_validate(
        {
            "kind": "experimental_heatmap",
            "data": {"cells": [], "source": "future-renderer"},
        }
    )
    assert unknown_chart.kind == "experimental_heatmap"
    assert unknown_chart.type == "experimental_heatmap"
    assert unknown_chart.data == {"cells": [], "source": "future-renderer"}


def test_full_report_schema_accepts_nullable_dissenting_without_changing_field_set():
    from app.services.result_report.schema import FullReport, validate_full_report_payload

    payload = _legal_full_report()
    payload["dissenting"] = None

    report = validate_full_report_payload(payload)

    assert report.dissenting is None
    assert "dissenting" in FullReport.model_fields
    assert set(FullReport.model_fields) == {
        "version",
        "generated_at",
        "generation_mode",
        "target_branch_id",
        "target_branch_sort",
        "language",
        "available_languages",
        "title",
        "title_i18n",
        "summary",
        "summary_i18n",
        "status",
        "tier",
        "verdict",
        "sections",
        "evidence",
        "indicators_to_watch",
        "dissenting",
        "key_participants",
        "follow_ups",
        "limitations",
        "interview_evidence",
        "interview_status",
        "premortem",
        "premortem_analysis",
        "language_status",
        "tool_trace",
    }
    assert {
        name
        for name, field in FullReport.model_fields.items()
        if field.is_required()
    } == {
        "version",
        "generated_at",
        "generation_mode",
        "target_branch_id",
        "target_branch_sort",
        "language",
        "available_languages",
        "title",
        "title_i18n",
        "summary",
        "summary_i18n",
        "status",
        "tier",
        "verdict",
        "limitations",
    }


def test_full_report_schema_rejects_section_refs_to_missing_evidence():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["sections"][0]["evidence_refs"] = ["ev-missing"]

    with pytest.raises(ValueError, match="section evidence_refs"):
        validate_full_report_payload(payload)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda payload: payload.pop("verdict"),
        lambda payload: payload.__setitem__("generation_mode", "template"),
        lambda payload: payload["evidence"][0].__setitem__("kind", "raw_secret"),
        lambda payload: payload["evidence"][0].pop("message_id"),
        lambda payload: payload.__setitem__("api_key", "sk-test-secret"),
    ],
)
def test_full_report_schema_rejects_illegal_payloads(mutate):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    mutate(payload)

    with pytest.raises((ValidationError, ValueError)):
        validate_full_report_payload(payload)


def test_full_report_schema_rejects_utf8_oversize_payload():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["summary"] = "汉" * 40

    with pytest.raises(ValueError, match="byte budget"):
        validate_full_report_payload(payload, max_bytes=80)


@pytest.mark.parametrize("secret_key", ["x-api-key", "API-Key", "authorization-header"])
@pytest.mark.parametrize("placement", ["top_level", "chart_data"])
def test_full_report_schema_rejects_header_style_secret_keys_everywhere(
    secret_key: str,
    placement: str,
):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    if placement == "top_level":
        payload[secret_key] = "plainsecret123"
    else:
        payload["sections"][0]["charts"][0]["data"][secret_key] = "plainsecret123"

    with pytest.raises(ValueError, match="sensitive key"):
        validate_full_report_payload(payload)


@pytest.mark.parametrize(
    "secret_value",
    [
        "https://user:pass@example.com/v1",
        "xai-secretSecret123456",
        "sk-ant-secretSecret123456",
    ],
)
def test_full_report_schema_rejects_provider_secret_values_everywhere(secret_value: str):
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["sections"][0]["body_md_i18n"]["en"] = f"Do not leak {secret_value}"

    with pytest.raises(ValueError, match="sensitive value"):
        validate_full_report_payload(payload)


def test_full_report_schema_rejects_post_default_byte_cap_overflow():
    from app.services.result_report.schema import (
        FullReport,
        utf8_json_size_bytes,
        validate_full_report_payload,
    )

    payload = _legal_full_report()
    for default_list_key in [
        "sections",
        "evidence",
        "indicators_to_watch",
        "key_participants",
        "follow_ups",
        "interview_evidence",
        "premortem",
    ]:
        payload.pop(default_list_key)

    raw_size = utf8_json_size_bytes(payload)
    response_size = utf8_json_size_bytes(
        FullReport.model_validate(payload).model_dump(mode="json"),
    )
    assert raw_size == 1395
    assert response_size == 1585

    with pytest.raises(ValueError, match="byte budget"):
        validate_full_report_payload(payload, max_bytes=raw_size)


def test_result_report_sse_event_schema_freezes_shape_and_blocks_secrets():
    from app.services.result_report.schema import (
        ResultReportSSEData,
        ResultReportSSEEvent,
        ToolTraceSummary,
    )

    assert set(ToolTraceSummary.model_fields) == {
        "section_id",
        "tool",
        "query",
        "item_count",
        "elapsed_ms",
    }
    assert set(ResultReportSSEData.model_fields) == {
        "report_id",
        "section_id",
        "status",
        "message",
        "tool_trace",
        "error_code",
        "tier",
        "failure_reason",
    }

    event = ResultReportSSEEvent.model_validate(
        {
            "event": "report_section_complete",
            "data": {
                "report_id": "report-1",
                "section_id": "timeline",
                "status": "complete",
                "tier": "static",
                "failure_reason": "timeout",
                "tool_trace": [
                    {
                        "section_id": "timeline",
                        "tool": "reducer",
                        "query": "dominant branch",
                        "item_count": 3,
                        "elapsed_ms": 4,
                    }
                ],
            },
        }
    )
    assert event.event == "report_section_complete"
    assert event.data.tier == "static"
    assert event.data.failure_reason == "timeout"
    assert event.data.tool_trace[0].section_id == "timeline"
    assert event.data.tool_trace[0].tool == "reducer"
    assert isinstance(event.data.tool_trace[0].tool, str)
    assert isinstance(event.data.tool_trace[0].query, str)
    assert isinstance(event.data.tool_trace[0].item_count, int)
    assert isinstance(event.data.tool_trace[0].elapsed_ms, int)

    no_tool_calls = ResultReportSSEEvent.model_validate(
        {
            "event": "report_started",
            "data": {"report_id": "report-1", "status": "generating"},
        }
    )
    assert no_tool_calls.data.tool_trace == []
    assert no_tool_calls.data.tier is None
    assert no_tool_calls.data.failure_reason is None

    cancelled = ResultReportSSEEvent.model_validate(
        {
            "event": "report_failed",
            "data": {"report_id": "report-1", "status": "cancelled"},
        }
    )
    assert cancelled.data.status == "cancelled"

    for field, value in (
        ("tier", "unsafe-tier"),
        ("failure_reason", "provider-secret-detail"),
    ):
        with pytest.raises((ValidationError, ValueError)):
            ResultReportSSEEvent.model_validate(
                {
                    "event": "report_section_complete",
                    "data": {
                        "report_id": "report-1",
                        "section_id": "timeline",
                        "status": "complete",
                        field: value,
                    },
                }
            )

    with pytest.raises((ValidationError, ValueError)):
        ResultReportSSEEvent.model_validate(
            {
                "event": "report_started",
                "data": {
                    "report_id": "report-1",
                    "status": "generating",
                    "message": "Authorization: Bearer sk-test-secret",
                },
            }
        )


@pytest.mark.asyncio
async def test_capabilities_result_report_gate(monkeypatch):
    import app.api.scenarios as scenarios_api

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", False)
    disabled = await scenarios_api.api_capabilities()
    assert disabled["result_report"]["enabled"] is False
    assert disabled["result_report"]["version"] == "0.0"

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    enabled = await scenarios_api.api_capabilities()
    assert enabled["result_report"]["enabled"] is True
    assert enabled["result_report"]["version"] == "1.0"


@pytest.mark.asyncio
async def test_story_full_report_is_gated(monkeypatch):
    import app.api.scenarios as scenarios_api

    sid = _seed_scenario_with_branch(full_report=_legal_full_report())

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", False)
    disabled = await scenarios_api.get_story(sid, principal=None)
    assert disabled["full_report"] is None

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    enabled = await scenarios_api.get_story(sid, principal=None)
    assert enabled["full_report"]["version"] == "1.0"
    assert enabled["full_report"]["evidence"][0]["message_id"] == "msg-1"


@pytest.mark.asyncio
async def test_story_full_report_does_not_return_header_style_secret(monkeypatch):
    import app.api.scenarios as scenarios_api

    payload = _legal_full_report()
    payload["sections"][0]["charts"][0]["data"]["x-api-key"] = "plainsecret123"
    sid = _seed_scenario_with_branch(full_report=payload)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    result = await scenarios_api.get_story(sid, principal=None)

    serialized = json.dumps(result["full_report"], ensure_ascii=False)
    assert "x-api-key" not in serialized
    assert "plainsecret123" not in serialized


@pytest.mark.asyncio
async def test_story_full_report_oversize_returns_partial_metadata(monkeypatch):
    import app.api.scenarios as scenarios_api

    payload = _legal_full_report()
    payload["summary"] = "x" * 200
    sid = _seed_scenario_with_branch(full_report=payload)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(scenarios_api.settings, "REPORT_FULL_REPORT_MAX_BYTES", 80)
    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "report_generation_is_active",
        lambda _scenario_id: True,
    )
    result = await scenarios_api.get_story(sid, principal=None)

    assert result["full_report"] == {"status": "partial", "truncated": True}
    assert len(json.dumps(result["full_report"]).encode("utf-8")) < 80


@pytest.mark.asyncio
async def test_story_full_report_keeps_generating_with_active_runtime_lease(monkeypatch):
    import app.api.scenarios as scenarios_api

    payload = _legal_full_report()
    payload["status"] = "generating"
    payload["generated_at"] = "invalid-but-lease-is-authoritative"
    sid = _seed_scenario_with_branch(full_report=payload)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "report_generation_is_active",
        lambda _scenario_id: True,
    )

    result = await scenarios_api.get_story(sid, principal=None)

    assert result["full_report"]["status"] == "generating"
    assert result["full_report"]["version"] == "1.0"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("timestamp_case", "expected_status"),
    [
        ("age_0_z", "generating"),
        ("age_29_9_z", "generating"),
        ("age_30_offset", "generating"),
        ("age_31_z", "failed"),
        ("invalid", "failed"),
        ("naive", "failed"),
        ("future", "failed"),
    ],
)
async def test_story_full_report_applies_fixed_grace_without_runtime_lease(
    monkeypatch,
    timestamp_case,
    expected_status,
):
    import app.api.scenarios as scenarios_api
    from app.services.result_report.schema import full_report_for_story

    now = datetime(2026, 6, 8, 12, 0, 0, tzinfo=UTC)
    timestamps = {
        "age_0_z": now.isoformat().replace("+00:00", "Z"),
        "age_29_9_z": (now - timedelta(seconds=29.9)).isoformat().replace(
            "+00:00",
            "Z",
        ),
        "age_30_offset": (now - timedelta(seconds=30))
        .astimezone(timezone(timedelta(hours=10)))
        .isoformat(),
        "age_31_z": (now - timedelta(seconds=31)).isoformat().replace(
            "+00:00",
            "Z",
        ),
        "invalid": "not-a-timestamp",
        "naive": "2026-06-08T11:59:59",
        "future": (now + timedelta(microseconds=1)).isoformat().replace(
            "+00:00",
            "Z",
        ),
    }
    payload = _legal_full_report()
    payload["status"] = "generating"
    payload["generated_at"] = timestamps[timestamp_case]
    sid = _seed_scenario_with_branch(full_report=payload)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "report_generation_is_active",
        lambda _scenario_id: False,
    )
    monkeypatch.setattr(scenarios_api, "_report_story_utc_now", lambda: now, raising=False)

    result = await scenarios_api.get_story(sid, principal=None)
    normalized = full_report_for_story(payload)

    assert result["full_report"]["status"] == expected_status
    assert result["full_report"]["version"] == payload["version"]
    assert normalized is not None
    assert result["full_report"]["sections"] == normalized["sections"]
    with Session(get_engine()) as session:
        persisted = session.get(Scenario, sid)
        assert persisted is not None
        assert persisted.parsed_context["full_report"]["status"] == "generating"
        assert persisted.parsed_context["full_report"]["generated_at"] == payload["generated_at"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("lease_active", "expected_status"),
    [(True, "generating"), (False, "partial")],
)
async def test_story_legacy_partial_report_only_rotates_with_active_lease(
    monkeypatch,
    lease_active,
    expected_status,
):
    import app.api.scenarios as scenarios_api
    from app.services.result_report.schema import full_report_for_story

    payload = _legal_full_report()
    payload["status"] = "partial"
    payload["generated_at"] = "legacy-timestamp"
    sid = _seed_scenario_with_branch(full_report=payload)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "report_generation_is_active",
        lambda _scenario_id: lease_active,
    )

    result = await scenarios_api.get_story(sid, principal=None)
    normalized = full_report_for_story(payload)

    assert result["full_report"]["status"] == expected_status
    assert result["full_report"]["version"] == payload["version"]
    assert normalized is not None
    assert result["full_report"]["sections"] == normalized["sections"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["complete", "failed", "cancelled", "skipped"])
@pytest.mark.parametrize("lease_active", [True, False])
async def test_story_terminal_report_status_ignores_lease_and_grace(
    monkeypatch,
    status,
    lease_active,
):
    import app.api.scenarios as scenarios_api
    from app.services.result_report.schema import full_report_for_story

    payload = _legal_full_report()
    payload["status"] = status
    payload["generated_at"] = "invalid-terminal-timestamp"
    sid = _seed_scenario_with_branch(full_report=payload)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "report_generation_is_active",
        lambda _scenario_id: lease_active,
    )
    monkeypatch.setattr(
        scenarios_api,
        "_report_story_utc_now",
        lambda: datetime(2026, 6, 8, 12, 0, 0, tzinfo=UTC),
        raising=False,
    )

    result = await scenarios_api.get_story(sid, principal=None)
    normalized = full_report_for_story(payload)

    assert result["full_report"]["status"] == status
    assert result["full_report"]["version"] == payload["version"]
    assert normalized is not None
    assert result["full_report"]["sections"] == normalized["sections"]


def test_report_generate_sse_endpoint_contract(monkeypatch):
    import app.api.scenarios as scenarios_api
    from app.services.result_report.reducer import (
        resolve_report_lineage_scope as real_resolve_report_lineage_scope,
    )
    from app.services.result_report.schema import ResultReportSSEEvent, encode_sse_event

    sid = _seed_scenario_with_branch()
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    resolver_calls = []
    stream_called = False
    streamed_scope = None

    def tracked_resolver(engine, scenario_id: str, *, dominant_branch_id: str):
        scope = real_resolve_report_lineage_scope(
            engine,
            scenario_id,
            dominant_branch_id=dominant_branch_id,
        )
        resolver_calls.append((engine, scenario_id, dominant_branch_id, scope))
        return scope

    monkeypatch.setattr(scenarios_api, "resolve_report_lineage_scope", tracked_resolver)

    async def fake_report_stream(
        scenario_id: str,
        dominant_branch_id: str,
        *,
        overrides: dict,
        report_scope,
    ):
        nonlocal stream_called, streamed_scope
        stream_called = True
        streamed_scope = report_scope
        assert scenario_id == sid
        assert dominant_branch_id
        assert overrides["api_key"] is None
        yield encode_sse_event(
            ResultReportSSEEvent(
                event="report_started",
                data={"report_id": scenario_id, "status": "generating"},
            )
        )
        yield encode_sse_event(
            ResultReportSSEEvent(
                event="report_complete",
                data={"report_id": scenario_id, "status": "complete"},
            )
        )

    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "build_report_sse_stream",
        fake_report_stream,
    )
    client = TestClient(app)

    with client.stream("POST", f"/api/scenario/{sid}/report:generate") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join(response.iter_text())

    assert stream_called
    assert len(resolver_calls) == 1
    engine, resolved_scenario_id, dominant_branch_id, resolved_scope = resolver_calls[0]
    assert engine is get_engine()
    assert resolved_scenario_id == sid
    assert resolved_scope is not None
    assert resolved_scope.scenario_id == sid
    assert resolved_scope.target_branch_id == dominant_branch_id
    assert streamed_scope is resolved_scope
    assert "event: report_started" in body
    assert "event: report_complete" in body
    assert "api_key" not in body
    assert "Bearer " not in body


@pytest.mark.parametrize(
    ("corruption", "expected_code"),
    [
        ("missing_parent", "BRANCH_LINEAGE_MISSING_PARENT"),
        ("cross_scenario_parent", "BRANCH_LINEAGE_CROSS_SCENARIO_PARENT"),
        ("cycle", "BRANCH_LINEAGE_CYCLE"),
    ],
)
def test_report_generate_rejects_corrupt_lineage_before_stream(
    monkeypatch,
    corruption: str,
    expected_code: str,
):
    import app.api.scenarios as scenarios_api

    engine = get_engine()
    leaked_ids: list[str] = []
    with Session(engine) as session:
        scenario = Scenario(
            question="Should this corrupt lineage generate a report?",
            status=ScenarioStatus.DONE,
        )
        session.add(scenario)
        session.flush()
        leaf = Branch(
            scenario_id=scenario.id,
            title="Corrupt report leaf",
            probability=0.9,
            status=BranchStatus.COMPLETED,
        )
        if corruption == "cross_scenario_parent":
            foreign_scenario = Scenario(
                question="Foreign scenario",
                status=ScenarioStatus.DONE,
            )
            session.add(foreign_scenario)
            session.flush()
            foreign_parent = Branch(
                scenario_id=foreign_scenario.id,
                title="Foreign parent",
                status=BranchStatus.COMPLETED,
            )
            session.add(foreign_parent)
            session.flush()
            leaf.parent_branch_id = foreign_parent.id
            leaf.fork_round = 1
            leaked_ids.append(foreign_parent.id)
        session.add(leaf)
        session.flush()
        if corruption == "cycle":
            other = Branch(
                scenario_id=scenario.id,
                parent_branch_id=leaf.id,
                fork_round=1,
                title="Other cycle branch",
                probability=0.8,
                status=BranchStatus.COMPLETED,
            )
            session.add(other)
            session.flush()
            leaf.parent_branch_id = other.id
            session.add(leaf)
            leaked_ids.append(other.id)
        session.commit()
        scenario_id = scenario.id
        leaf_id = leaf.id
    leaked_ids.extend([scenario_id, leaf_id])

    if corruption == "missing_parent":
        missing_parent_id = "missing-parent-sensitive-id"
        with engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            connection.exec_driver_sql(
                "UPDATE branch SET parent_branch_id = ? WHERE id = ?",
                (missing_parent_id, leaf_id),
            )
            connection.commit()
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        leaked_ids.append(missing_parent_id)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    stream_started = False

    async def fake_report_stream(*_args, **_kwargs):
        nonlocal stream_started
        stream_started = True
        yield b"should-not-start"

    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "build_report_sse_stream",
        fake_report_stream,
    )

    response = TestClient(app).post(f"/api/scenario/{scenario_id}/report:generate")

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": expected_code,
        "message": "Branch lineage is invalid",
    }
    assert stream_started is False
    for leaked_id in leaked_ids:
        assert leaked_id not in response.text


@pytest.mark.parametrize("resolver_outcome", ["none", "branch_not_found"])
def test_report_generate_maps_preflight_delete_race_to_safe_not_found(
    monkeypatch,
    resolver_outcome: str,
):
    import app.api.scenarios as scenarios_api
    from app.services.branch_lineage import BranchLineageError
    from app.services.result_report.reducer import (
        resolve_report_lineage_scope as real_resolve_report_lineage_scope,
    )

    scenario_id = _seed_scenario_with_branch()
    with Session(get_engine()) as session:
        branch = session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).one()
        deleted_branch_id = branch.id

    resolver_calls = 0

    def delete_then_resolve(engine, requested_scenario_id, *, dominant_branch_id):
        nonlocal resolver_calls
        resolver_calls += 1
        assert dominant_branch_id == deleted_branch_id
        with Session(engine) as session:
            branch = session.get(Branch, dominant_branch_id)
            assert branch is not None
            session.delete(branch)
            session.commit()
        resolved_scope = real_resolve_report_lineage_scope(
            engine,
            requested_scenario_id,
            dominant_branch_id=dominant_branch_id,
        )
        assert resolved_scope is None
        if resolver_outcome == "branch_not_found":
            raise BranchLineageError(
                "BRANCH_LINEAGE_BRANCH_NOT_FOUND",
                f"Branch {dominant_branch_id} disappeared from {requested_scenario_id}",
            )
        return resolved_scope

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(scenarios_api, "resolve_report_lineage_scope", delete_then_resolve)
    stream_started = False

    async def fake_report_stream(*_args, **_kwargs):
        nonlocal stream_started
        stream_started = True
        yield b"should-not-start"

    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "build_report_sse_stream",
        fake_report_stream,
    )

    response = TestClient(app).post(f"/api/scenario/{scenario_id}/report:generate")

    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "BRANCH_NOT_FOUND",
        "message": "Branch not found",
    }
    assert resolver_calls == 1
    assert stream_started is False
    assert scenario_id not in response.text
    assert deleted_branch_id not in response.text
