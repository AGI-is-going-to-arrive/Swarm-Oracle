"""API tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.debate as debate_api
import app.services.debate as debate_service
from app.main import app
from app.models import Debate, DebatePhase, DebateStatus
from app.models.database import get_engine
from app.services.debate import create_debate_record, run_debate_background
from app.services.debate_argument_map import extract_argument_units
from app.services.debate_scoring import DebatePlan, build_debate_plan


def _make_signed_session_token(secret: str, subject: str) -> str:
    import base64
    import hashlib
    import hmac
    import json

    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_create_debate_returns_immediately_and_schedules_background(
    client: TestClient,
    monkeypatch,
):
    scheduled = {"count": 0}

    def _capture_schedule(coro):
        scheduled["count"] += 1
        coro.close()
        return None

    monkeypatch.setattr(debate_api, "schedule_background_task", _capture_schedule)

    resp = client.post(
        "/api/debate",
        json={"question": "如果紧急委员会拥有最终否决权，国家会更安全吗？"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "live"
    assert data["language"] == "zh"
    assert data["current_phase"] == "opening"
    assert data["available_prediction_options"]["winner"] == ["proposition", "opposition"]
    assert data["scene_theme"] in {"debate_arena_judicial", "debate_arena_civic"}
    assert len(data["phase_insights"]) == 5
    assert data["phase_insights"][0]["commentary"]
    assert scheduled["count"] == 1


def test_get_argument_map_returns_snapshot_when_enabled(client: TestClient, monkeypatch):
    monkeypatch.setattr(debate_api.settings, "FEATURE_ARGUMENT_MAP", True)
    debate = create_debate_record("如果审计庭拥有最终否决权，会更稳定吗？")
    extract_argument_units(
        debate.id,
        "turn-1",
        "研究表明审计程序能降低错误。然而流程也会变慢。",
        "proposition",
    )

    resp = client.get(f"/api/debate/{debate.id}/argument-map")

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["snapshot_id"] is not None
    assert len(payload["nodes"]) == 2
    assert len(payload["units"]) == 2


@pytest.mark.asyncio
async def test_predict_then_fetch_result(client: TestClient):
    debate = create_debate_record(
        "Should a rotating external review board re-approve every critical city budget?"
    )

    predict = client.post(
        f"/api/debate/{debate.id}/predict",
        json={
            "kind": "winner",
            "target_value": "proposition",
            "confidence": 0.8,
            "user_id": "debate-user",
            "user_name": "Debate QA",
            "is_counterplay": True,
            "counterplay_phase": "crossfire",
            "counterplay_variant": "reversal",
        },
    )
    assert predict.status_code == 200
    assert predict.json()["kind"] == "winner"
    assert predict.json()["is_counterplay"] is True
    assert predict.json()["counterplay_phase"] == "crossfire"
    assert predict.json()["counterplay_variant"] == "reversal"

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    await run_debate_background(debate.id, ws_callback=_push)

    result = client.get(f"/api/debate/{debate.id}/result")
    assert result.status_code == 200
    payload = result.json()
    assert payload["result_ready"] is True
    assert payload["result"]["winner"] in {"proposition", "opposition"}
    assert payload["counterplay"]["kind"] == "winner"
    assert payload["counterplay"]["phase"] == "crossfire"
    assert payload["counterplay"]["variant"] == "reversal"
    assert payload["counterplay"]["outcome"] in {"hit", "miss"}
    assert payload["counterplay"]["phase_score"]["proposition"] >= 0
    assert payload["counterplay"]["explanation"]
    assert len(payload["predictions"]) == 1
    assert len(payload["phase_insights"]) == 5
    assert payload["phase_insights"][0]["stakes"]
    assert payload["phase_insights"][0]["judge_focus"]
    assert payload["phase_insights"][0]["confidence_drift"]["direction"] in {"balanced", "proposition", "opposition"}  # noqa: E501
    assert "hedge" in payload["phase_insights"][1]["commentary"].lower() or "反制" in payload["phase_insights"][1]["commentary"]  # noqa: E501
    assert payload["predictions"][0]["is_counterplay"] is True
    assert payload["predictions"][0]["counterplay_phase"] == "crossfire"
    assert payload["predictions"][0]["counterplay_variant"] == "reversal"
    assert payload["predictions"][0]["score"] is not None
    assert payload["result"]["judge_summary"]
    assert payload["result"]["judge_rationale"]["winner_reason"]
    assert payload["result"]["judge_rationale"]["dimension_rationales"]["coherence"]
    assert payload["result"]["judge_rationale"]["supporting_turns"]


def test_predict_rejects_invalid_target_value(client: TestClient):
    debate = create_debate_record("如果所有法院都采用量化量刑，会更公平吗？")

    resp = client.post(
        f"/api/debate/{debate.id}/predict",
        json={
            "kind": "winner",
            "target_value": "judge",
            "confidence": 0.4,
        },
    )

    assert resp.status_code == 422


def test_predict_rejects_counterplay_without_required_metadata(client: TestClient):
    debate = create_debate_record("如果所有法院都必须公开解释每一次紧急禁令，会更稳吗？")

    resp = client.post(
        f"/api/debate/{debate.id}/predict",
        json={
            "kind": "winner",
            "target_value": "proposition",
            "confidence": 0.4,
            "is_counterplay": True,
        },
    )

    assert resp.status_code == 422


def test_predict_rejects_when_closing_arguments_have_started(client: TestClient):
    debate = create_debate_record(
        "Should a wartime cabinet publish every mobilization debt before the next offensive?"
    )

    with Session(get_engine()) as session:
        stored = session.get(Debate, debate.id)
        assert stored is not None
        stored.current_phase = DebatePhase.CLOSING
        session.add(stored)
        session.commit()

    resp = client.post(
        f"/api/debate/{debate.id}/predict",
        json={
            "kind": "winner",
            "target_value": "proposition",
            "confidence": 0.6,
        },
    )

    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "DEBATE_PREDICTIONS_LOCKED"
    assert "closing arguments" in resp.json()["detail"]["message"]


def test_predict_rejects_when_debate_is_in_error_state(client: TestClient):
    debate = create_debate_record(
        "Should every sanctions council publish its broken escalation ladder?"
    )

    with Session(get_engine()) as session:
        stored = session.get(Debate, debate.id)
        assert stored is not None
        stored.status = DebateStatus.ERROR
        session.add(stored)
        session.commit()

    resp = client.post(
        f"/api/debate/{debate.id}/predict",
        json={
            "kind": "winner",
            "target_value": "proposition",
            "confidence": 0.6,
        },
    )

    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "DEBATE_PREDICTIONS_CLOSED"
    assert "not accepting predictions" in resp.json()["detail"]["message"]


def test_predict_counterplay_still_succeeds_when_broadcast_fails(monkeypatch):
    client = TestClient(app, raise_server_exceptions=False)
    debate = create_debate_record("Should every emergency tribunal expose its failed ruling chain?")

    monkeypatch.setattr(
        debate_api.debate_ws_manager,
        "broadcast",
        AsyncMock(side_effect=RuntimeError("broadcast failed")),
    )

    resp = client.post(
        f"/api/debate/{debate.id}/predict",
        json={
            "kind": "winner",
            "target_value": "proposition",
            "confidence": 0.8,
            "is_counterplay": True,
            "counterplay_phase": "crossfire",
            "counterplay_variant": "reversal",
        },
    )

    assert resp.status_code == 200
    assert resp.json()["is_counterplay"] is True


def test_get_result_distinguishes_error_terminal_state(client: TestClient):
    debate = create_debate_record("Should every emergency tribunal expose its failed ruling chain?")

    with Session(get_engine()) as session:
        stored = session.get(Debate, debate.id)
        assert stored is not None
        stored.status = DebateStatus.ERROR
        session.add(stored)
        session.commit()

    resp = client.get(f"/api/debate/{debate.id}/result")

    assert resp.status_code == 500
    assert resp.json()["detail"]["code"] == "DEBATE_RESULT_ERROR_STATE"
    assert "ended with an error" in resp.json()["detail"]["message"]


def test_judge_analysis_fallback_uses_nonempty_turn_placeholders():
    from app.services.debate import _build_judge_analysis_fallback, _empty_turn_fallback
    from app.services.debate_scoring import build_debate_plan

    debate = Debate(
        question="Should every emergency tribunal expose its failed ruling chain?",
        motion="Motion",
        language="en",
    )
    plan = build_debate_plan(debate.question)

    fallback = _build_judge_analysis_fallback(
        debate=debate,
        plan=plan,
        best_argument=_empty_turn_fallback("en", "argument"),
        best_rebuttal=_empty_turn_fallback("en", "rebuttal"),
        counterplay_context=None,
    )

    assert "No decisive argument was recorded." in fallback["summary"]
    assert "No decisive rebuttal was recorded." in fallback["summary"]
    assert "No decisive argument was recorded." in fallback["winner_reason"]
    assert "No decisive rebuttal was recorded." in fallback["loser_gap"]


@pytest.mark.asyncio
async def test_debate_websocket_disconnects_on_generic_exception(monkeypatch):
    debate = create_debate_record("Should a tribunal keep its audit websocket private?")
    websocket = AsyncMock()
    websocket.receive_text.side_effect = RuntimeError("boom")
    disconnect = MagicMock()

    monkeypatch.setattr(debate_api.debate_ws_manager, "disconnect", disconnect)

    with pytest.raises(RuntimeError, match="boom"):
        await debate_api.debate_websocket_endpoint(websocket, debate.id)

    websocket.accept.assert_awaited_once()
    disconnect.assert_called_once_with(debate.id, websocket)


@pytest.mark.asyncio
async def test_debate_websocket_disconnects_on_normal_close(monkeypatch):
    debate = create_debate_record("Should a tribunal keep its audit websocket private?")
    websocket = AsyncMock()
    websocket.receive_text.side_effect = WebSocketDisconnect()
    disconnect = MagicMock()

    monkeypatch.setattr(debate_api.debate_ws_manager, "disconnect", disconnect)

    await debate_api.debate_websocket_endpoint(websocket, debate.id)

    websocket.accept.assert_awaited_once()
    disconnect.assert_called_once_with(debate.id, websocket)


def test_debate_websocket_route_accepts_real_connections(client: TestClient, monkeypatch):
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")

    debate = create_debate_record(
        "Should the real websocket route stay reachable?",
        user_id="owner-a",
    )

    with client.websocket_connect(f"/ws/debate/{debate.id}") as websocket:
        websocket.send_json(
            {
                "type": "auth",
                "token": _make_signed_session_token("test-secret", "owner-a"),
            }
        )
        assert websocket.receive_json()["type"] == "auth_ok"


def test_import_replay_debate_persists_snapshot(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "id": "debate-replay-1",
            "question": "Should AI run every city?",
            "motion": "Motion",
            "language": "en",
            "profile_id": "governance",
            "scene_theme": "debate_arena_civic",
            "status": "done",
            "current_phase": "verdict",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "score": {"proposition": 80, "opposition": 72, "audience_meter": 8},
            "turns": [
                {
                    "id": "turn-1",
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                    "score_delta": {"proposition": 4, "opposition": 0},
                },
            ],
            "available_prediction_options": {"winner": ["proposition", "opposition"], "verdict_tone": ["order", "balance", "rupture"]},  # noqa: E501
            "phase_insights": [
                {
                    "phase": "opening",
                    "stakes": "Imported opening stakes",
                    "judge_focus": "Imported opening focus",
                    "commentary": "Imported opening commentary",
                    "pressure_side": "balanced",
                    "pressure_margin": 0,
                    "turn_count": 1,
                    "confidence_drift": {
                        "direction": "balanced",
                        "phase_margin": 0,
                        "cumulative_margin": 0,
                    },
                },
                {
                    "phase": "verdict",
                    "stakes": "Imported verdict stakes",
                    "judge_focus": "Imported verdict focus",
                    "commentary": "Imported verdict commentary",
                    "pressure_side": "proposition",
                    "pressure_margin": 8,
                    "turn_count": 1,
                    "confidence_drift": {
                        "direction": "proposition",
                        "phase_margin": 8,
                        "cumulative_margin": 8,
                    },
                },
            ],
            "result_ready": True,
            "result": {
                "winner": "proposition",
                "verdict_tone": "order",
                "adjudication_mode": "llm_hybrid",
                "score": {"proposition": 80, "opposition": 72, "audience_meter": 8},
                "breakdown": {
                    "coherence": {"proposition": 4, "opposition": 3},
                },
                "best_argument": "Best argument",
                "best_rebuttal": "Best rebuttal",
                "judge_summary": "Judge summary",
                "judge_rationale": {
                    "winner_reason": "Winner reason",
                    "loser_gap": "Loser gap",
                    "swing_factor": "Swing factor",
                    "closing_note": "Closing note",
                    "dimension_rationales": {"coherence": "Imported rationale"},
                },
                "replay": [],
            },
            "counterplay": {
                "debate_id": "debate-replay-1",
                "kind": "winner",
                "target_value": "opposition",
                "confidence": 0.6,
                "phase": "crossfire",
                "variant": "reversal",
                "outcome": "miss",
                "phase_score": {"proposition": 6, "opposition": 0},
                "explanation": "Counterplay explanation",
                "user_name": "Replay User",
                "created_at": "2026-03-19T00:00:00Z",
            },
            "predictions": [
                {
                    "id": "prediction-1",
                    "debate_id": "debate-replay-1",
                    "kind": "winner",
                    "target_value": "proposition",
                    "confidence": 0.8,
                    "user_id": "director-1",
                    "user_name": "Local Director",
                    "score": 88,
                    "score_reason": "Imported prediction score",
                    "created_at": "2026-03-19T00:00:00Z",
                    "scored_at": "2026-03-19T00:00:00Z",
                },
            ],
        },
    })

    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] != "debate-replay-1"
    assert data["status"] == "done"
    assert data["result_ready"] is True
    assert data["participants"][0]["name"] == "Proposition"
    assert data["turns"][0]["content"] == "Imported turn"
    assert data["phase_insights"][0]["commentary"] == "Imported opening commentary"
    assert data["phase_insights"][-1]["phase"] == "verdict"

    result = client.get(f"/api/debate/{data['id']}/result")
    assert result.status_code == 200
    result_payload = result.json()
    assert result_payload["phase_insights"][0]["commentary"] == "Imported opening commentary"
    assert result_payload["phase_insights"][-1]["judge_focus"] == "Imported verdict focus"


def _make_import_replay_payload() -> dict[str, object]:
    return {
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                },
            ],
            "predictions": [
                {
                    "kind": "winner",
                    "target_value": "proposition",
                    "confidence": 0.8,
                    "user_id": "director-1",
                    "user_name": "Director",
                },
            ],
            "counterplay": {
                "kind": "winner",
                "target_value": "opposition",
                "confidence": 0.6,
                "phase": "crossfire",
                "variant": "reversal",
                "outcome": "miss",
                "user_name": "Replay User",
            },
            "result": {
                "winner": "proposition",
                "verdict_tone": "balance",
            },
        },
    }


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("phase", "overture", "invalid turns.phase"),
        ("speaker_side", "moderator", "invalid turns.speaker_side"),
    ],
)
def test_import_replay_debate_rejects_invalid_turn_fields(
    client: TestClient,
    field: str,
    value: str,
    message: str,
):
    payload = _make_import_replay_payload()
    payload["debate"]["turns"][0][field] = value

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert message in resp.text


def test_import_replay_debate_rejects_non_object_turn_entry(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["turns"].append("bad-turn-entry")

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "turns entries must be objects" in resp.text


def test_import_replay_debate_rejects_invalid_prediction_kind(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["predictions"][0]["kind"] = "judge"

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "invalid predictions.kind" in resp.text


def test_import_replay_debate_rejects_invalid_prediction_confidence(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["predictions"][0]["confidence"] = "very-sure"

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "invalid predictions.confidence" in resp.text


def test_import_replay_debate_rejects_non_object_prediction_entry(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["predictions"].append("bad-prediction-entry")

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "predictions entries must be objects" in resp.text


def test_import_replay_debate_rejects_invalid_prediction_counterplay_phase(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["predictions"][0]["is_counterplay"] = True
    payload["debate"]["predictions"][0]["counterplay_phase"] = "finale"
    payload["debate"]["predictions"][0]["counterplay_variant"] = "reversal"

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "invalid predictions.counterplay_phase" in resp.text


def test_import_replay_debate_rejects_invalid_counterplay_phase(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["counterplay"]["phase"] = "finale"

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "invalid counterplay.phase" in resp.text


def test_import_replay_debate_rejects_invalid_counterplay_confidence(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["counterplay"]["confidence"] = "certain"

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "invalid counterplay.confidence" in resp.text


def test_import_replay_debate_is_idempotent_for_identical_payload(client: TestClient):
    payload = {
        "debate": {
            "id": "debate-replay-idempotent",
            "question": "Should an emergency audit board publish every sealed tariff exception?",
            "motion": "Motion",
            "language": "en",
            "profile_id": "trade",
            "scene_theme": "debate_arena_forum",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Audit Lead"},
                {"side": "opposition", "name": "Opposition", "role": "Trade Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn 1",
                },
                {
                    "sequence": 2,
                    "phase": "crossfire",
                    "speaker_side": "opposition",
                    "speaker_name": "Opposition",
                    "content": "Imported turn 2",
                },
            ],
            "result": {
                "winner": "proposition",
                "verdict_tone": "balance",
                "judge_summary": "Imported verdict",
                "adjudication_mode": "llm_hybrid",
            },
            "predictions": [
                {
                    "kind": "winner",
                    "target_value": "proposition",
                    "confidence": 0.8,
                    "user_id": "director-1",
                    "user_name": "Director",
                },
            ],
        },
    }

    first = client.post("/api/debate/import-replay", json=payload)
    second = client.post("/api/debate/import-replay", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    first_id = first.json()["id"]
    second_id = second.json()["id"]
    assert second_id == first_id

    with Session(get_engine()) as session:
        debates = session.exec(
            select(Debate).where(
                Debate.question == payload["debate"]["question"],
                Debate.motion == payload["debate"]["motion"],
            )
        ).all()
        assert len(debates) == 1


def test_import_replay_debate_rejects_oversized_payload(client: TestClient):
    oversized_content = "x" * (debate_api.MAX_IMPORT_REPLAY_DEBATE_BYTES + 1)

    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "id": "turn-1",
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": oversized_content,
                    "score_delta": {"proposition": 1, "opposition": 0},
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "payload too large" in resp.text


def test_import_replay_debate_rejects_excessive_turn_count(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": index + 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                }
                for index in range(debate_api.MAX_IMPORT_REPLAY_TURNS + 1)
            ],
        },
    })

    assert resp.status_code == 413
    assert "too many turns" in resp.text


def test_import_replay_debate_rejects_invalid_winner(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "result": {
                "winner": "judge",
                "verdict_tone": "order",
            },
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "invalid winner" in resp.text


def test_import_replay_debate_rejects_invalid_verdict_tone(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "result": {
                "winner": "proposition",
                "verdict_tone": "chaos",
            },
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "invalid verdict_tone" in resp.text


def test_import_replay_debate_rejects_non_contiguous_turn_sequence(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn 1",
                },
                {
                    "sequence": 3,
                    "phase": "crossfire",
                    "speaker_side": "opposition",
                    "speaker_name": "Opposition",
                    "content": "Imported turn 3",
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "contiguous and unique" in resp.text


def test_import_replay_debate_rejects_duplicate_turn_sequence(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn 1",
                },
                {
                    "sequence": 1,
                    "phase": "crossfire",
                    "speaker_side": "opposition",
                    "speaker_name": "Opposition",
                    "content": "Imported turn 1 duplicate",
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "contiguous and unique" in resp.text


def test_import_replay_debate_sorts_turns_by_sequence(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 2,
                    "phase": "crossfire",
                    "speaker_side": "opposition",
                    "speaker_name": "Opposition",
                    "content": "Imported turn 2",
                },
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn 1",
                },
            ],
        },
    })

    assert resp.status_code == 200
    payload = resp.json()
    assert [turn["sequence"] for turn in payload["turns"]] == [1, 2]
    assert payload["turns"][0]["content"] == "Imported turn 1"
    assert payload["turns"][1]["content"] == "Imported turn 2"


def test_import_replay_debate_rejects_invalid_phase_insight_phase(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                },
            ],
            "phase_insights": [
                {
                    "phase": "overture",
                    "commentary": "Bad phase",
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "invalid phase_insights.phase" in resp.text


def test_import_replay_debate_rejects_invalid_phase_insight_direction(client: TestClient):
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                },
            ],
            "phase_insights": [
                {
                    "phase": "opening",
                    "pressure_side": "judge",
                    "confidence_drift": {
                        "direction": "balanced",
                    },
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "invalid phase_insights.pressure_side" in resp.text


def test_import_replay_debate_rejects_invalid_phase_insight_confidence_drift_shape(client: TestClient):  # noqa: E501
    resp = client.post("/api/debate/import-replay", json={
        "debate": {
            "question": "Should AI run every city?",
            "motion": "Motion",
            "participants": [
                {"side": "proposition", "name": "Proposition", "role": "Governance Vanguard"},
                {"side": "opposition", "name": "Opposition", "role": "Governance Skeptic"},
                {"side": "judge", "name": "Judge", "role": "Structured Arbiter"},
            ],
            "turns": [
                {
                    "sequence": 1,
                    "phase": "opening",
                    "speaker_side": "proposition",
                    "speaker_name": "Proposition",
                    "content": "Imported turn",
                },
            ],
            "phase_insights": [
                {
                    "phase": "opening",
                    "confidence_drift": "bad-shape",
                },
            ],
        },
    })

    assert resp.status_code == 422
    assert "confidence_drift must be an object" in resp.text


def test_import_replay_debate_rejects_non_object_phase_insight_entry(client: TestClient):
    payload = _make_import_replay_payload()
    payload["debate"]["phase_insights"] = ["bad-phase-insight-entry"]

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "phase_insights entries must be objects" in resp.text


def test_import_replay_debate_accepts_negative_phase_insight_confidence_drift_margins(
    client: TestClient,
):
    payload = _make_import_replay_payload()
    payload["debate"]["phase_insights"] = [
        {
            "phase": "opening",
            "confidence_drift": {
                "direction": "opposition",
                "phase_margin": -1,
                "cumulative_margin": -3,
            },
        },
    ]

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 200
    assert resp.json()["phase_insights"][0]["confidence_drift"]["phase_margin"] == -1
    assert resp.json()["phase_insights"][0]["confidence_drift"]["cumulative_margin"] == -3


def test_import_replay_debate_accepts_null_counterplay_variant_for_regular_predictions(
    client: TestClient,
):
    payload = _make_import_replay_payload()
    payload["debate"]["predictions"] = [
        {
            "kind": "verdict_tone",
            "target_value": "balance",
            "confidence": 0.7,
            "user_id": "director-1",
            "user_name": "Director",
            "is_counterplay": False,
            "counterplay_phase": None,
            "counterplay_variant": None,
        },
    ]

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 200
    result = client.get(f"/api/debate/{resp.json()['id']}/result")

    assert result.status_code == 200
    assert result.json()["predictions"][0]["counterplay_variant"] is None


@pytest.mark.parametrize("field_name", ["pressure_margin", "turn_count"])
def test_import_replay_debate_rejects_negative_phase_insight_non_drift_counters(
    client: TestClient,
    field_name: str,
):
    payload = _make_import_replay_payload()
    payload["debate"]["phase_insights"] = [
        {
            "phase": "opening",
            field_name: -1,
            "confidence_drift": {
                "direction": "balanced",
            },
        },
    ]

    resp = client.post("/api/debate/import-replay", json=payload)

    assert resp.status_code == 422
    assert "pressure_margin and turn_count must be >= 0" in resp.text


def test_empty_turn_fallbacks_are_readable():
    from app.services import debate as debate_service

    best_argument = debate_service._empty_turn_fallback("en", "argument")
    best_rebuttal = debate_service._empty_turn_fallback("en", "rebuttal")

    assert debate_service._pick_best_turn(
        [],
        winner_side="proposition",
        fallback=best_argument,
    ) == best_argument

    summary = debate_service._build_judge_summary_fallback(
        debate=Debate(question="Should the council centralize trade?", motion="Motion", language="en"),  # noqa: E501
        plan=build_debate_plan("Should the council centralize trade?"),
        best_argument=best_argument,
        best_rebuttal=best_rebuttal,
    )

    assert "was: ." not in summary
    assert best_argument in summary
    assert best_rebuttal in summary


def test_build_hybrid_plan_uses_base_plan_winner_when_adjudication_winner_is_missing():
    template_plan = build_debate_plan(
        "Should a permanent audit chamber review every emergency budget?"
    )
    tied_breakdown = {
        dimension: {"proposition": 3, "opposition": 3}
        for dimension in template_plan.breakdown
    }
    base_plan = DebatePlan(
        winner="proposition",
        verdict_tone=template_plan.verdict_tone,
        score={"proposition": 60, "opposition": 55},
        breakdown=tied_breakdown,
        phase_deltas=template_plan.phase_deltas,
        audience_meter=template_plan.audience_meter,
    )

    hybrid_plan, mode = debate_service._build_hybrid_plan(
        base_plan,
        {
            "verdict_tone": "balance",
            "dimensions": tied_breakdown,
        },
    )

    assert mode == "llm_hybrid"
    assert hybrid_plan.winner == "proposition"
    assert hybrid_plan.score["proposition"] > hybrid_plan.score["opposition"]
