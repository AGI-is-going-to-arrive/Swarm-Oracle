"""API tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlmodel import Session

import app.api.debate as debate_api
from app.main import app
from app.models import Debate, DebatePhase, DebateStatus
from app.models.database import get_engine
from app.services.debate import create_debate_record, run_debate_background


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_create_debate_returns_immediately_and_schedules_background(client: TestClient, monkeypatch):
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


@pytest.mark.asyncio
async def test_predict_then_fetch_result(client: TestClient):
    debate = create_debate_record("Should a rotating external review board re-approve every critical city budget?")

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
    assert payload["phase_insights"][0]["confidence_drift"]["direction"] in {"balanced", "proposition", "opposition"}
    assert "hedge" in payload["phase_insights"][1]["commentary"].lower() or "反制" in payload["phase_insights"][1]["commentary"]
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
    debate = create_debate_record("Should a wartime cabinet publish every mobilization debt before the next offensive?")

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
    assert "closing arguments" in resp.json()["detail"]


def test_predict_rejects_when_debate_is_in_error_state(client: TestClient):
    debate = create_debate_record("Should every sanctions council publish its broken escalation ladder?")

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
    assert "not accepting predictions" in resp.json()["detail"]


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
    assert "ended with an error" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_debate_websocket_disconnects_on_generic_exception(monkeypatch):
    websocket = AsyncMock()
    websocket.receive_text.side_effect = RuntimeError("boom")
    connect = AsyncMock(return_value=True)
    disconnect = MagicMock()

    monkeypatch.setattr(debate_api.debate_ws_manager, "connect", connect)
    monkeypatch.setattr(debate_api.debate_ws_manager, "disconnect", disconnect)

    with pytest.raises(RuntimeError, match="boom"):
        await debate_api.debate_websocket_endpoint(websocket, "debate-1")

    connect.assert_awaited_once_with("debate-1", websocket)
    disconnect.assert_called_once_with("debate-1", websocket)


@pytest.mark.asyncio
async def test_debate_websocket_disconnects_on_normal_close(monkeypatch):
    websocket = AsyncMock()
    websocket.receive_text.side_effect = WebSocketDisconnect()
    connect = AsyncMock(return_value=True)
    disconnect = MagicMock()

    monkeypatch.setattr(debate_api.debate_ws_manager, "connect", connect)
    monkeypatch.setattr(debate_api.debate_ws_manager, "disconnect", disconnect)

    await debate_api.debate_websocket_endpoint(websocket, "debate-2")

    connect.assert_awaited_once_with("debate-2", websocket)
    disconnect.assert_called_once_with("debate-2", websocket)


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
            "available_prediction_options": {"winner": ["proposition", "opposition"], "verdict_tone": ["order", "balance", "rupture"]},
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
