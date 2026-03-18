"""API tests for Debate Arena Track D / Phase D1."""

from __future__ import annotations

import pytest
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
        },
    )
    assert predict.status_code == 200
    assert predict.json()["kind"] == "winner"

    async def _push(_debate_id: str, _event: dict) -> None:
        return None

    await run_debate_background(debate.id, ws_callback=_push)

    result = client.get(f"/api/debate/{debate.id}/result")
    assert result.status_code == 200
    payload = result.json()
    assert payload["result_ready"] is True
    assert payload["result"]["winner"] in {"proposition", "opposition"}
    assert len(payload["predictions"]) == 1
    assert payload["predictions"][0]["score"] is not None


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
