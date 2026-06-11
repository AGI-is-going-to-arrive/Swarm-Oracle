"""Sprint S0 contract tests for the result report IR."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlmodel import Session

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
                        "data": {"branch_id": "branch-1", "probability": 0.68},
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
        "premortem": [],
        "language_status": {"zh": "available", "en": "available"},
    }


def test_full_report_schema_accepts_legal_payload_and_freezes_fields():
    from app.services.result_report.schema import FullReport, validate_full_report_payload

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
        "premortem",
        "language_status",
    }
    assert set(report.sections[0].model_fields) == {
        "id",
        "title",
        "title_i18n",
        "intent",
        "body_md_i18n",
        "evidence_refs",
        "charts",
    }
    assert set(report.evidence[0].model_fields) == {
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
    assert set(report.indicators_to_watch[0].model_fields) == {
        "signal",
        "direction",
        "note",
        "threshold",
        "observation",
        "time_horizon",
        "rationale",
        "evidence_refs",
    }


def test_full_report_schema_accepts_generating_status():
    from app.services.result_report.schema import validate_full_report_payload

    payload = _legal_full_report()
    payload["status"] = "generating"

    report = validate_full_report_payload(payload)

    assert report.status == "generating"


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
        "premortem",
        "language_status",
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
    assert raw_size == 1222
    assert response_size == 1370

    with pytest.raises(ValueError, match="byte budget"):
        validate_full_report_payload(payload, max_bytes=raw_size)


def test_result_report_sse_event_schema_freezes_shape_and_blocks_secrets():
    from app.services.result_report.schema import ResultReportSSEEvent

    event = ResultReportSSEEvent.model_validate(
        {
            "event": "report_section_complete",
            "data": {
                "report_id": "report-1",
                "section_id": "timeline",
                "status": "complete",
                "tool_trace": [
                    {
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
    assert event.data.tool_trace[0].tool == "reducer"

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
    result = await scenarios_api.get_story(sid, principal=None)

    assert result["full_report"] == {"status": "partial", "truncated": True}
    assert len(json.dumps(result["full_report"]).encode("utf-8")) < 80


@pytest.mark.asyncio
async def test_story_full_report_downgrades_stale_generating_without_runtime_lease(
    monkeypatch,
):
    import app.api.scenarios as scenarios_api

    payload = _legal_full_report()
    payload["status"] = "generating"
    sid = _seed_scenario_with_branch(full_report=payload)

    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "report_generation_is_active",
        lambda _scenario_id: False,
        raising=False,
    )

    result = await scenarios_api.get_story(sid, principal=None)

    assert result["full_report"]["status"] == "partial"
    assert result["full_report"]["version"] == "1.0"


def test_report_generate_sse_endpoint_contract(monkeypatch):
    import app.api.scenarios as scenarios_api
    from app.services.result_report.schema import ResultReportSSEEvent, encode_sse_event

    sid = _seed_scenario_with_branch()
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    stream_called = False

    async def fake_report_stream(
        scenario_id: str,
        dominant_branch_id: str,
        *,
        overrides: dict,
    ):
        nonlocal stream_called
        stream_called = True
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
    assert "event: report_started" in body
    assert "event: report_complete" in body
    assert "api_key" not in body
    assert "Bearer " not in body
