"""M3: Session authentication tests — REST X-Session-Token + WS first-frame auth.

REST tests verify the existing verify_session() helper.
WS tests define the expected first-frame auth protocol (M2).

WS first-frame auth protocol:
  1. Server accepts WebSocket upgrade (no query-param token)
  2. If SESSION_SECRET is set, server waits for first frame:
     {"type": "auth", "token": "<secret>"}
  3. On success: server sends {"type": "auth_ok"}, THEN registers + starts heartbeat
  4. On failure: server closes with 4001 "Unauthorized", does NOT register
  5. If SESSION_SECRET is empty, skip auth — direct to register + heartbeat
"""

import asyncio
import base64
import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, WebSocketDisconnect
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

import app.api.debate as debate_api
import app.api.ending_rooms as ending_rooms_api
from app.api.helpers import verify_session
from app.api.ws import WSManager, run_websocket_session
from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    BranchStatus,
    Debate,
    DebatePhase,
    DebateStatus,
    EndingRoomType,
    Prediction,
)
from app.models.database import Branch, ReplayArtifact, Round, Scenario, ScenarioStatus, get_engine
from app.services.ending_room_service import (
    create_ending_room,
    create_ending_room_thread,
    run_ending_room_background,
)


async def _always_exists(_id: str) -> bool:
    return True


def _make_ws_mock(**kwargs):
    """Create a WebSocket mock using MagicMock base with explicit async methods.

    Avoids AsyncMock's implicit coroutine creation on attribute access,
    which causes 'coroutine was never awaited' RuntimeWarnings during GC.
    """
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.receive_text = AsyncMock(**kwargs)
    ws.close = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


def _make_signed_session_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


def _seed_owned_scenario(user_id: str, *, status: ScenarioStatus = ScenarioStatus.DONE) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(question=f"Scenario for {user_id}", status=status, user_id=user_id)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def _seed_owned_branch(scenario_id: str) -> str:
    with Session(get_engine()) as session:
        branch = Branch(scenario_id=scenario_id, title="Owned branch")
        session.add(branch)
        session.commit()
        session.refresh(branch)
        return branch.id


def _seed_round(branch_id: str, round_number: int) -> str:
    with Session(get_engine()) as session:
        round_row = Round(branch_id=branch_id, round_number=round_number)
        session.add(round_row)
        session.commit()
        session.refresh(round_row)
        return round_row.id


def _seed_owned_debate(
    user_id: str,
    *,
    status: DebateStatus = DebateStatus.LIVE,
    phase: DebatePhase = DebatePhase.OPENING,
) -> str:
    with Session(get_engine()) as session:
        debate = Debate(
            question=f"Debate for {user_id}",
            motion="Motion",
            user_id=user_id,
            status=status,
            current_phase=phase,
        )
        session.add(debate)
        session.commit()
        session.refresh(debate)
        return debate.id


async def _seed_owned_ending_room(user_id: str, *, complete: bool = False) -> dict[str, str]:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question=f"Ending room for {user_id}",
            status=ScenarioStatus.DONE,
            user_id=user_id,
        )
        session.add(scenario)
        session.flush()

        agent = Agent(
            scenario_id=scenario.id,
            name="Archivist",
            role="Tracks downstream consequences",
        )
        session.add(agent)
        session.flush()

        branch = Branch(
            scenario_id=scenario.id,
            title="Owned ending room branch",
            status=BranchStatus.COMPLETED,
            story="The branch stayed intact.",
            insight="Ownership should stay scoped.",
        )
        session.add(branch)
        session.flush()

        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        session.add(
            AgentMessage(
                round_id=round_row.id,
                agent_id=agent.id,
                content="Keep the room scoped to its owner.",
                emotion="steady",
            )
        )
        session.commit()
        session.refresh(scenario)
        session.refresh(branch)

    snapshot, _created = create_ending_room(
        scenario.id,
        room_type=EndingRoomType.ENDING_CHAMBER,
        anchor_branch_id=branch.id,
        selected_branch_ids=[branch.id],
        language="en",
    )

    if complete:
        await run_ending_room_background(snapshot["id"])

    return {
        "scenario_id": scenario.id,
        "branch_id": branch.id,
        "room_id": snapshot["id"],
    }


async def _seed_owned_ending_room_thread(user_id: str) -> dict[str, str]:
    fixture = await _seed_owned_ending_room(user_id, complete=True)
    thread = create_ending_room_thread(fixture["room_id"], title="Owner thread")
    return {**fixture, "thread_id": thread["id"]}


def _make_replay_artifact_payload(kind: str, scenario_id: str) -> dict:
    if kind in {"scenario_result_v1", "simulation_view_v1"}:
        return {"scenario": {"id": scenario_id}}
    if kind == "ending_room_v1":
        return {"roomSnapshot": {"scenario_id": scenario_id}}
    if kind == "worldline_roundtable_v1":
        return {
            "scenarioReplay": {"scenario": {"id": scenario_id}},
            "roomSnapshot": {"scenario_id": scenario_id},
        }
    raise ValueError(f"Unsupported replay artifact kind for test: {kind}")


def _campaign_director_state_payload() -> dict:
    return {
        "revision": 0,
        "objectives": {
            "generated_for_question": "test question",
            "generated_for_profile": "governance",
            "goals": [],
            "last_updated_at": "2026-03-18T00:00:00Z",
        },
        "commitment": {
            "active": False,
            "branch_id": None,
            "branch_title": None,
            "committed_at_round": None,
            "committed_at": None,
            "outcome": None,
        },
    }


def _campaign_gameplay_state_payload() -> dict:
    return {
        "revision": 0,
        "cards": {"usage_log": []},
        "betting": {"bets": []},
        "archive": {"key_moments": [], "branch_snapshots": []},
    }


def _campaign_finalize_payload(user_id: str) -> dict:
    return {
        "user_id": user_id,
        "user_name": "Owner",
        "profile_id": "governance",
        "archive_grade": "A",
        "profile_resonance": "aligned",
        "bet_count": 0,
        "completed_daily_challenge": False,
    }


def _debate_import_payload() -> dict:
    return {
        "debate": {
            "question": "Import question",
            "motion": "Import motion",
            "participants": [],
            "turns": [],
            "predictions": [],
            "result": {
                "winner": "proposition",
                "verdict_tone": "balance",
            },
        }
    }


def _prediction_submit_payload(user_id: str | None = None) -> dict:
    payload = {
        "prediction_text": "Outcome",
        "confidence": 0.6,
        "user_name": "Predictor",
    }
    if user_id is not None:
        payload["user_id"] = user_id
    return payload


# ── REST: verify_session (X-Session-Token header) ──────────────────────


class TestVerifySessionREST:
    """These tests pass against the existing implementation."""

    @pytest.mark.asyncio
    async def test_auth_disabled_returns_none(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "")
        request = MagicMock()
        request.headers.get.return_value = ""
        result = await verify_session(request)
        assert result is None

    @pytest.mark.asyncio
    async def test_correct_token_returns_token(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
        request = MagicMock()
        request.headers.get.return_value = "s3cret"
        result = await verify_session(request)
        assert result == "s3cret"

    @pytest.mark.asyncio
    async def test_wrong_token_raises_401(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
        request = MagicMock()
        request.headers.get.return_value = "wrong"
        with pytest.raises(HTTPException) as exc_info:
            await verify_session(request)
        assert exc_info.value.status_code == 401

    @pytest.mark.asyncio
    async def test_missing_token_raises_401(self, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
        request = MagicMock()
        request.headers.get.return_value = ""
        with pytest.raises(HTTPException) as exc_info:
            await verify_session(request)
        assert exc_info.value.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/api/scenarios", {}),
        (
            "post",
            "/api/scenario/nonexistent/intervene",
            {"json": {"branch_id": "b1", "text": "test"}},
        ),
        ("get", "/api/leaderboard", {}),
        ("post", "/api/scenario/nonexistent/social/x", {"json": {}}),
        ("get", "/api/agents/identities?user_id=u1", {}),
        ("get", "/api/scenario/nonexistent/checkpoints", {}),
        ("post", "/api/debate", {"json": {"question": "test question"}}),
        ("get", "/api/campaign/profile/u1", {}),
        ("get", "/api/ending-room/nonexistent", {}),
    ],
)
async def test_business_rest_routes_require_session_token(monkeypatch, method, path, kwargs):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await getattr(client, method)(path, **kwargs)

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_root_endpoint_remains_public_when_session_secret_enabled(monkeypatch):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_agent_routes_require_signed_principal_when_auth_enabled(monkeypatch):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.agents.settings.FEATURE_CUSTOM_AGENTS", True)
    monkeypatch.setattr("app.api.agents.settings.FEATURE_AGENT_IDENTITY", True)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": "s3cret"},
    ) as client:
        response = await client.get("/api/agents/identities?user_id=u1")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"


@pytest.mark.asyncio
async def test_agent_routes_accept_signed_principal(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "u1")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.agents.settings.FEATURE_CUSTOM_AGENTS", True)
    monkeypatch.setattr("app.api.agents.settings.FEATURE_AGENT_IDENTITY", True)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.get("/api/agents/identities?user_id=u1")

    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.asyncio
async def test_identity_bound_scenario_requests_require_signed_principal(monkeypatch):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": "s3cret"},
    ) as client:
        response = await client.post(
            "/api/scenario",
            json={
                "question": "test",
                "custom_agent_identity_ids": ["agent-1"],
            },
        )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"


@pytest.mark.asyncio
async def test_campaign_profile_rejects_mismatched_signed_principal(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "user-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.get("/api/campaign/profile/user-b")

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_MISMATCH"


@pytest.mark.asyncio
async def test_signed_principal_filters_scenario_list(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    _seed_owned_scenario("owner-a")
    _seed_owned_scenario("owner-b")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.get("/api/scenarios")

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert len(response.json()["scenarios"]) == 1


@pytest.mark.asyncio
async def test_cross_owner_scenario_get_returns_404(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    scenario_id = _seed_owned_scenario("owner-b")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.get(f"/api/scenario/{scenario_id}")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


@pytest.mark.asyncio
async def test_cross_owner_scenario_delete_returns_404(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    scenario_id = _seed_owned_scenario("owner-b")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.delete(f"/api/scenario/{scenario_id}")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


@pytest.mark.asyncio
async def test_cross_owner_checkpoints_returns_404(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.graphs.settings.FEATURE_COUNTERFACTUAL_REPLAY", True)

    scenario_id = _seed_owned_scenario("owner-b")
    _seed_owned_branch(scenario_id)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.get(f"/api/scenario/{scenario_id}/checkpoints")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path_template", "payload"),
    [
        ("get", "/api/campaign/scenario/{scenario_id}/summary", None),
        ("get", "/api/campaign/scenario/{scenario_id}/director-state", None),
        (
            "put",
            "/api/campaign/scenario/{scenario_id}/director-state",
            _campaign_director_state_payload(),
        ),
        ("get", "/api/campaign/scenario/{scenario_id}/gameplay-state", None),
        (
            "put",
            "/api/campaign/scenario/{scenario_id}/gameplay-state",
            _campaign_gameplay_state_payload(),
        ),
        (
            "post",
            "/api/campaign/scenario/{scenario_id}/finalize",
            _campaign_finalize_payload("owner-a"),
        ),
    ],
)
async def test_campaign_scenario_routes_reject_cross_owner_access(
    monkeypatch,
    method,
    path_template,
    payload,
):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    scenario_id = _seed_owned_scenario("owner-b", status=ScenarioStatus.DONE)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await getattr(client, method)(
            path_template.format(scenario_id=scenario_id),
            **({"json": payload} if payload is not None else {}),
        )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path_template", "payload"),
    [
        (
            "/api/scenario/{scenario_id}/intervene",
            lambda branch_id: {"branch_id": branch_id, "text": "owner test"},
        ),
        (
            "/api/scenario/{scenario_id}/intervene/retrospective",
            lambda branch_id: {"branch_id": branch_id, "round_number": 1, "text": "owner test"},
        ),
        (
            "/api/scenario/{scenario_id}/intervene/batch",
            lambda branch_id: {"interventions": [{"branch_id": branch_id, "text": "owner test"}]},
        ),
    ],
)
async def test_intervention_routes_require_signed_principal(
    monkeypatch,
    path_template,
    payload,
):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")

    scenario_id = _seed_owned_scenario("owner-a", status=ScenarioStatus.SIMULATING)
    branch_id = _seed_owned_branch(scenario_id)
    _seed_round(branch_id, 1)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": "s3cret"},
    ) as client:
        response = await client.post(
            path_template.format(scenario_id=scenario_id),
            json=payload(branch_id),
        )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path_template", "payload"),
    [
        (
            "/api/scenario/{scenario_id}/intervene",
            lambda branch_id: {"branch_id": branch_id, "text": "owner test"},
        ),
        (
            "/api/scenario/{scenario_id}/intervene/retrospective",
            lambda branch_id: {"branch_id": branch_id, "round_number": 1, "text": "owner test"},
        ),
        (
            "/api/scenario/{scenario_id}/intervene/batch",
            lambda branch_id: {"interventions": [{"branch_id": branch_id, "text": "owner test"}]},
        ),
    ],
)
async def test_intervention_routes_reject_cross_owner_access(
    monkeypatch,
    path_template,
    payload,
):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    scenario_id = _seed_owned_scenario("owner-b", status=ScenarioStatus.SIMULATING)
    branch_id = _seed_owned_branch(scenario_id)
    _seed_round(branch_id, 1)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.post(
            path_template.format(scenario_id=scenario_id),
            json=payload(branch_id),
        )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path_template", "payload"),
    [
        (
            "post",
            "/api/scenario/{scenario_id}/predict",
            _prediction_submit_payload("owner-a"),
        ),
        (
            "get",
            "/api/scenario/{scenario_id}/predictions",
            None,
        ),
        (
            "post",
            "/api/scenario/{scenario_id}/score-predictions",
            {"user_id": "owner-a"},
        ),
    ],
)
async def test_prediction_routes_require_signed_principal(
    monkeypatch,
    method,
    path_template,
    payload,
):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")

    scenario_id = _seed_owned_scenario("owner-a", status=ScenarioStatus.DONE)
    if "predict" in path_template and "score" not in path_template:
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            scenario.status = ScenarioStatus.SIMULATING
            session.add(scenario)
            session.commit()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": "s3cret"},
    ) as client:
        response = await getattr(client, method)(
            path_template.format(scenario_id=scenario_id),
            **({"json": payload} if payload is not None else {}),
        )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path_template", "payload", "status"),
    [
        (
            "post",
            "/api/scenario/{scenario_id}/predict",
            _prediction_submit_payload("owner-a"),
            ScenarioStatus.SIMULATING,
        ),
        (
            "get",
            "/api/scenario/{scenario_id}/predictions",
            None,
            ScenarioStatus.DONE,
        ),
        (
            "post",
            "/api/scenario/{scenario_id}/score-predictions",
            {"user_id": "owner-a"},
            ScenarioStatus.DONE,
        ),
    ],
)
async def test_prediction_routes_reject_cross_owner_access(
    monkeypatch,
    method,
    path_template,
    payload,
    status,
):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    scenario_id = _seed_owned_scenario("owner-b", status=status)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await getattr(client, method)(
            path_template.format(scenario_id=scenario_id),
            **({"json": payload} if payload is not None else {}),
        )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


@pytest.mark.asyncio
async def test_prediction_submit_rejects_mismatched_signed_principal(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    scenario_id = _seed_owned_scenario("owner-a", status=ScenarioStatus.SIMULATING)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.post(
            f"/api/scenario/{scenario_id}/predict",
            json=_prediction_submit_payload("owner-b"),
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_MISMATCH"


@pytest.mark.asyncio
async def test_prediction_submit_persists_principal_subject(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    scenario_id = _seed_owned_scenario("owner-a", status=ScenarioStatus.SIMULATING)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.post(
            f"/api/scenario/{scenario_id}/predict",
            json=_prediction_submit_payload("spoofed-user"),
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_MISMATCH"

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.post(
            f"/api/scenario/{scenario_id}/predict",
            json=_prediction_submit_payload(),
        )

    assert response.status_code == 200
    prediction_id = response.json()["id"]

    with Session(get_engine()) as session:
        prediction = session.get(Prediction, prediction_id)

    assert prediction is not None
    assert prediction.user_id == "owner-a"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path_template", "payload_factory", "status", "phase"),
    [
        (
            "post",
            "/api/debate",
            lambda _debate_id=None: {"question": "test question"},
            DebateStatus.LIVE,
            DebatePhase.OPENING,
        ),
        (
            "post",
            "/api/debate/import-replay",
            lambda _debate_id=None: _debate_import_payload(),
            DebateStatus.LIVE,
            DebatePhase.OPENING,
        ),
        ("get", "/api/debate/{debate_id}", None, DebateStatus.LIVE, DebatePhase.OPENING),
        ("get", "/api/debate/{debate_id}/result", None, DebateStatus.DONE, DebatePhase.VERDICT),
        (
            "get",
            "/api/debate/{debate_id}/argument-map",
            None,
            DebateStatus.LIVE,
            DebatePhase.OPENING,
        ),
        (
            "post",
            "/api/debate/{debate_id}/predict",
            lambda _debate_id=None: {
                "kind": "winner",
                "target_value": "proposition",
                "confidence": 0.6,
            },
            DebateStatus.LIVE,
            DebatePhase.OPENING,
        ),
    ],
)
async def test_debate_routes_require_signed_principal(
    monkeypatch,
    method,
    path_template,
    payload_factory,
    status,
    phase,
):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.debate.settings.FEATURE_ARGUMENT_MAP", True)

    debate_id = _seed_owned_debate("owner-a", status=status, phase=phase)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": "s3cret"},
    ) as client:
        response = await getattr(client, method)(
            path_template.format(debate_id=debate_id),
            **({"json": payload_factory(debate_id)} if payload_factory is not None else {}),
        )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path_template", "payload_factory", "status", "phase"),
    [
        ("get", "/api/debate/{debate_id}", None, DebateStatus.LIVE, DebatePhase.OPENING),
        ("get", "/api/debate/{debate_id}/result", None, DebateStatus.DONE, DebatePhase.VERDICT),
        (
            "get",
            "/api/debate/{debate_id}/argument-map",
            None,
            DebateStatus.LIVE,
            DebatePhase.OPENING,
        ),
        (
            "post",
            "/api/debate/{debate_id}/predict",
            lambda _debate_id=None: {
                "kind": "winner",
                "target_value": "proposition",
                "confidence": 0.6,
            },
            DebateStatus.LIVE,
            DebatePhase.OPENING,
        ),
    ],
)
async def test_debate_routes_reject_cross_owner_access(
    monkeypatch,
    method,
    path_template,
    payload_factory,
    status,
    phase,
):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.debate.settings.FEATURE_ARGUMENT_MAP", True)

    debate_id = _seed_owned_debate("owner-b", status=status, phase=phase)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await getattr(client, method)(
            path_template.format(debate_id=debate_id),
            **({"json": payload_factory(debate_id)} if payload_factory is not None else {}),
        )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "DEBATE_NOT_FOUND"


@pytest.mark.asyncio
async def test_replay_artifact_create_requires_signed_principal(monkeypatch):
    scenario_id = _seed_owned_scenario("owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": "s3cret"},
    ) as client:
        response = await client.post(
            "/api/replay-artifact",
            json={
                "kind": "scenario_result_v1",
                "payload": _make_replay_artifact_payload("scenario_result_v1", scenario_id),
            },
        )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "scenario_result_v1",
        "simulation_view_v1",
        "ending_room_v1",
        "worldline_roundtable_v1",
    ],
)
async def test_replay_artifact_create_rejects_cross_owner_source_scenario(monkeypatch, kind):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    scenario_id = _seed_owned_scenario("owner-b")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.post(
            "/api/replay-artifact",
            json={
                "kind": kind,
                "payload": _make_replay_artifact_payload(kind, scenario_id),
            },
        )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "scenario_result_v1",
        "simulation_view_v1",
        "ending_room_v1",
        "worldline_roundtable_v1",
    ],
)
async def test_replay_artifact_create_persists_owner_and_source_scenario(monkeypatch, kind):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    scenario_id = _seed_owned_scenario("owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        response = await client.post(
            "/api/replay-artifact",
            json={
                "kind": kind,
                "payload": _make_replay_artifact_payload(kind, scenario_id),
            },
        )

    assert response.status_code == 200
    artifact_id = response.json()["id"]

    with Session(get_engine()) as session:
        artifact = session.get(ReplayArtifact, artifact_id)

    assert artifact is not None
    assert artifact.owner_user_id == "owner-a"
    assert artifact.source_scenario_id == scenario_id


@pytest.mark.asyncio
async def test_replay_artifact_share_read_remains_capability_bound(monkeypatch):
    secret = "s3cret"
    owner_token = _make_signed_session_token(secret, "owner-a")
    reader_token = _make_signed_session_token(secret, "owner-b")
    scenario_id = _seed_owned_scenario("owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": owner_token},
    ) as owner_client:
        create_response = await owner_client.post(
            "/api/replay-artifact",
            json={
                "kind": "scenario_result_v1",
                "payload": _make_replay_artifact_payload("scenario_result_v1", scenario_id),
            },
        )

    artifact_id = create_response.json()["id"]

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": reader_token},
    ) as reader_client:
        read_response = await reader_client.get(f"/api/replay-artifact/{artifact_id}")

    assert read_response.status_code == 200
    assert read_response.json()["id"] == artifact_id
    assert read_response.json()["payload"] == _make_replay_artifact_payload(
        "scenario_result_v1",
        scenario_id,
    )


# ── WS: first-frame auth protocol ──────────────────────────────────────

class TestFirstFrameAuth:
    """WS first-frame auth protocol — acceptance tests for M2."""

    @pytest.mark.asyncio
    async def test_correct_token_sends_auth_ok(self, monkeypatch):
        """Correct auth frame → server sends auth_ok, connection registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        auth_frame = json.dumps({"type": "auth", "token": "test-secret"})
        ws = _make_ws_mock(side_effect=[auth_frame, WebSocketDisconnect()])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        auth_ok_msgs = [m for m in send_calls if '"auth_ok"' in m]
        assert len(auth_ok_msgs) == 1
        assert json.loads(auth_ok_msgs[0])["type"] == "auth_ok"

    @pytest.mark.asyncio
    async def test_signed_token_sends_auth_ok(self, monkeypatch):
        """Signed token → server sends auth_ok, connection registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        signed_token = _make_signed_session_token("test-secret", "owner-a")
        auth_frame = json.dumps({"type": "auth", "token": signed_token})
        ws = _make_ws_mock(side_effect=[auth_frame, WebSocketDisconnect()])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        auth_ok_msgs = [m for m in send_calls if '"auth_ok"' in m]
        assert len(auth_ok_msgs) == 1
        assert json.loads(auth_ok_msgs[0])["type"] == "auth_ok"

    @pytest.mark.asyncio
    async def test_wrong_token_closes_4001(self, monkeypatch):
        """Wrong token → 4001 close, socket NOT in manager._connections."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        auth_frame = json.dumps({"type": "auth", "token": "wrong"})
        ws = _make_ws_mock(side_effect=[auth_frame])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_wrong_token_does_not_check_resource_existence(self, monkeypatch):
        """Invalid auth must fail before any resource existence probe runs."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        exists_check = AsyncMock(return_value=False)
        auth_frame = json.dumps({"type": "auth", "token": "wrong"})
        ws = _make_ws_mock(side_effect=[auth_frame])

        await run_websocket_session(manager, "missing-s1", ws, exists_check=exists_check)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        exists_check.assert_not_awaited()
        assert ws not in manager._connections.get("missing-s1", [])
        await manager.broadcast("missing-s1", {"type": "probe"})
        ws.send_text.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_missing_token_field_closes_4001(self, monkeypatch):
        """Auth frame without token → accept first, then 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        auth_frame = json.dumps({"type": "auth"})
        ws = _make_ws_mock(side_effect=[auth_frame])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_invalid_json_closes_4001(self, monkeypatch):
        """Non-JSON first frame → 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=["not-json{"])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_wrong_message_type_closes_4001(self, monkeypatch):
        """Valid JSON but type != "auth" → accept first, then 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "subscribe"})])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")

    @pytest.mark.asyncio
    async def test_client_disconnect_during_auth_not_registered(self, monkeypatch):
        """Client disconnects before sending auth → socket NOT registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=WebSocketDisconnect())

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        assert ws not in manager._connections.get("s1", [])
        # Should NOT attempt to close an already-disconnected socket
        ws.close.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_auth_disabled_skips_auth_frame(self, monkeypatch):
        """SESSION_SECRET empty → no auth frame needed, direct register."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=WebSocketDisconnect())

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        # No auth_ok sent when auth disabled
        auth_ok_sent = any(
            '"auth_ok"' in c[0][0]
            for c in ws.send_text.call_args_list
            if c[0]
        )
        assert not auth_ok_sent

    @pytest.mark.asyncio
    async def test_no_query_param_token_in_new_protocol(self, monkeypatch):
        """New protocol must NOT read token from query params."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": "wrong"})])
        # Set query_params with correct token — should be IGNORED
        ws.query_params = {"token": "test-secret"}

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")

    @pytest.mark.asyncio
    async def test_register_happens_after_auth_not_before(self, monkeypatch):
        """Socket must NOT be in manager._connections until auth_ok is sent."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        ws = _make_ws_mock()
        registration_during_auth: list[bool] = []
        call_count = 0

        async def spy_receive():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                registration_during_auth.append(ws in manager._connections.get("s1", []))
                return json.dumps({"type": "auth", "token": "test-secret"})
            raise WebSocketDisconnect()

        ws.receive_text.side_effect = spy_receive

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        # During auth frame processing, socket should NOT have been registered
        assert registration_during_auth == [False]

    @pytest.mark.asyncio
    async def test_missing_resource_is_checked_after_auth_before_registration(self, monkeypatch):
        """Resource existence must be checked only after auth and before registration."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        observations: list[dict[str, int | bool]] = []

        async def missing_after_auth(_scenario_id: str) -> bool:
            observations.append(
                {
                    "registered": ws in manager._connections.get("missing-s1", []),
                    "pending": manager._pending_auth["missing-s1"],
                }
            )
            return False

        auth_frame = json.dumps({"type": "auth", "token": "test-secret"})
        ws = _make_ws_mock(side_effect=[auth_frame])

        await run_websocket_session(manager, "missing-s1", ws, exists_check=missing_after_auth)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4404, reason="scenario not found")
        assert observations == [{"registered": False, "pending": 1}]
        assert manager._pending_auth["missing-s1"] == 0
        assert ws not in manager._connections.get("missing-s1", [])
        assert not any('"auth_ok"' in c[0][0] for c in ws.send_text.call_args_list if c[0])

    @pytest.mark.asyncio
    async def test_auth_timeout_closes_4001(self, monkeypatch):
        """No auth frame within timeout → 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()

        async def hang_forever():
            await asyncio.sleep(999)

        ws = _make_ws_mock(side_effect=hang_forever)

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Auth timeout")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_oversized_auth_frame_closes_1009(self, monkeypatch):
        """Auth frame exceeding 64KB → 1009 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        manager = WSManager()
        # 21846 CJK chars × 3 bytes = 65538 bytes > 64KB
        oversized = json.dumps({"type": "auth", "token": "你" * 21846})
        ws = _make_ws_mock(side_effect=[oversized])

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=1009, reason="Auth frame too large")
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_non_dict_json_closes_4001(self, monkeypatch):
        """Valid JSON but not an object (list, string, number) → 4001 close."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        for payload in ['[]', '"hello"', '123', 'true']:
            manager = WSManager()
            ws = _make_ws_mock(side_effect=[payload])
            await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)
            ws.accept.assert_awaited_once()
            ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")


# ── Pending-auth limit hardening ─────────────────────────────────────


class TestPendingAuthLimit:
    """Pending-auth connections must count toward MAX_WS_PER_SCENARIO."""

    def test_active_count_includes_pending(self):
        """active_count = registered + pending_auth."""
        manager = WSManager()
        manager._connections["s1"].append(MagicMock())
        manager._connections["s1"].append(MagicMock())
        manager._pending_auth["s1"] = 3
        assert manager.active_count("s1") == 5

    def test_active_count_zero_for_unknown(self):
        """active_count returns 0 for unknown scenario."""
        manager = WSManager()
        assert manager.active_count("unknown") == 0

    @pytest.mark.asyncio
    async def test_pending_blocks_new_connections(self, monkeypatch):
        """Pending-auth sockets occupy slots — new connection gets 1013."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.ws.MAX_WS_PER_SCENARIO", 2)
        manager = WSManager()
        manager._connections["s1"].append(MagicMock())  # 1 registered
        manager._pending_auth["s1"] = 1                 # 1 pending

        ws = _make_ws_mock()
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        ws.close.assert_awaited_once_with(code=1013, reason="Too many connections")
        ws.accept.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_auth_failure_releases_pending_slot(self, monkeypatch):
        """After auth failure, pending slot is released (counter back to 0)."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": "wrong"})])
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_auth_success_clears_pending(self, monkeypatch):
        """Successful auth moves socket from pending to registered; pending is 0."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[
            json.dumps({"type": "auth", "token": "secret"}),
            WebSocketDisconnect(),
        ])
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0

    @pytest.mark.asyncio
    async def test_auth_timeout_releases_pending_slot(self, monkeypatch):
        """Auth timeout releases pending slot."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        async def hang():
            await asyncio.sleep(999)

        ws = _make_ws_mock(side_effect=hang)
        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        ws.close.assert_awaited_once_with(code=4001, reason="Auth timeout")

    @pytest.mark.asyncio
    async def test_auth_ok_send_error_releases_pending(self, monkeypatch):
        """send_text(auth_ok) raises RuntimeError → pending released, not registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[
            json.dumps({"type": "auth", "token": "secret"}),
        ])
        ws.send_text = AsyncMock(side_effect=RuntimeError("send boom"))

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_disconnect_during_auth_ok_releases_pending(self, monkeypatch):
        """Client disconnects while server sends auth_ok → pending released."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "secret")
        manager = WSManager()

        ws = _make_ws_mock(side_effect=[
            json.dumps({"type": "auth", "token": "secret"}),
        ])
        ws.send_text = AsyncMock(side_effect=WebSocketDisconnect())

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        assert ws not in manager._connections.get("s1", [])

    @pytest.mark.asyncio
    async def test_success_path_pending_to_registered(self, monkeypatch):
        """Full success: auth_ok sent, pending→0, socket was registered."""
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "secret")
        manager = WSManager()
        registered_during_loop: list[bool] = []

        ws = _make_ws_mock()
        call_count = 0

        async def receive_spy():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return json.dumps({"type": "auth", "token": "secret"})
            # Second call is in main loop — check registration before disconnecting
            registered_during_loop.append(ws in manager._connections.get("s1", []))
            raise WebSocketDisconnect()

        ws.receive_text.side_effect = receive_spy

        await run_websocket_session(manager, "s1", ws, exists_check=_always_exists)

        assert manager._pending_auth["s1"] == 0
        # Socket was registered before main-loop disconnect
        assert registered_during_loop == [True]
        # auth_ok was sent
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        assert any('"auth_ok"' in m for m in send_calls)


class TestDebateWebSocketOwnership:
    @pytest.mark.asyncio
    async def test_debate_websocket_requires_signed_principal(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        debate_id = _seed_owned_debate("owner-a")
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": "test-secret"})])

        await debate_api.debate_websocket_endpoint(ws, debate_id)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in debate_api.debate_ws_manager._connections.get(debate_id, [])

    @pytest.mark.asyncio
    async def test_debate_websocket_rejects_cross_owner_access(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        debate_id = _seed_owned_debate("owner-a")
        outsider_token = _make_signed_session_token("test-secret", "owner-b")
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": outsider_token})])

        await debate_api.debate_websocket_endpoint(ws, debate_id)

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4404, reason="debate not found")
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        assert not any('"auth_ok"' in m for m in send_calls)
        assert ws not in debate_api.debate_ws_manager._connections.get(debate_id, [])

    @pytest.mark.asyncio
    async def test_debate_websocket_accepts_owned_principal(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        debate_id = _seed_owned_debate("owner-a")
        owner_token = _make_signed_session_token("test-secret", "owner-a")
        ws = _make_ws_mock(
            side_effect=[
                json.dumps({"type": "auth", "token": owner_token}),
                WebSocketDisconnect(),
            ]
        )

        await debate_api.debate_websocket_endpoint(ws, debate_id)

        ws.accept.assert_awaited_once()
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        assert any('"auth_ok"' in m for m in send_calls)
        assert ws not in debate_api.debate_ws_manager._connections.get(debate_id, [])


@pytest.mark.asyncio
async def test_ending_room_routes_require_signed_principal(monkeypatch):
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "s3cret")

    create_scenario_id = _seed_owned_scenario("owner-a", status=ScenarioStatus.DONE)
    create_branch_id = _seed_owned_branch(create_scenario_id)
    room_fixture = await _seed_owned_ending_room("owner-a", complete=True)
    thread_fixture = await _seed_owned_ending_room_thread("owner-a")

    route_cases = [
        (
            "post",
            f"/api/scenario/{create_scenario_id}/ending-room",
            {
                "room_type": "ending_chamber",
                "anchor_branch_id": create_branch_id,
                "selected_branch_ids": [create_branch_id],
                "language": "en",
            },
        ),
        ("get", f"/api/ending-room/{room_fixture['room_id']}", None),
        ("get", f"/api/ending-room/{room_fixture['room_id']}/result", None),
        ("post", f"/api/ending-room/{room_fixture['room_id']}/thread", {"title": "Owner thread"}),
        ("get", f"/api/ending-room/thread/{thread_fixture['thread_id']}", None),
        (
            "post",
            f"/api/ending-room/{room_fixture['room_id']}/user-turn",
            {"content": "keep going"},
        ),
        (
            "post",
            f"/api/ending-room/thread/{thread_fixture['thread_id']}/user-turn",
            {"content": "thread follow-up"},
        ),
    ]

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": "s3cret"},
    ) as client:
        for method, path, payload in route_cases:
            response = await getattr(client, method)(
                path,
                **({"json": payload} if payload is not None else {}),
            )
            assert response.status_code == 401
            assert response.json()["detail"]["code"] == "SESSION_PRINCIPAL_REQUIRED"


@pytest.mark.asyncio
async def test_ending_room_routes_reject_cross_owner_access(monkeypatch):
    secret = "s3cret"
    token = _make_signed_session_token(secret, "owner-a")
    monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
    monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", secret)

    create_scenario_id = _seed_owned_scenario("owner-b", status=ScenarioStatus.DONE)
    create_branch_id = _seed_owned_branch(create_scenario_id)
    room_fixture = await _seed_owned_ending_room("owner-b", complete=True)
    thread_fixture = await _seed_owned_ending_room_thread("owner-b")

    route_cases = [
        (
            "post",
            f"/api/scenario/{create_scenario_id}/ending-room",
            {
                "room_type": "ending_chamber",
                "anchor_branch_id": create_branch_id,
                "selected_branch_ids": [create_branch_id],
                "language": "en",
            },
            "SCENARIO_NOT_FOUND",
        ),
        ("get", f"/api/ending-room/{room_fixture['room_id']}", None, "ENDING_ROOM_NOT_FOUND"),
        (
            "get",
            f"/api/ending-room/{room_fixture['room_id']}/result",
            None,
            "ENDING_ROOM_NOT_FOUND",
        ),
        (
            "post",
            f"/api/ending-room/{room_fixture['room_id']}/thread",
            {"title": "Outsider thread"},
            "ENDING_ROOM_NOT_FOUND",
        ),
        (
            "get",
            f"/api/ending-room/thread/{thread_fixture['thread_id']}",
            None,
            "ENDING_ROOM_THREAD_NOT_FOUND",
        ),
        (
            "post",
            f"/api/ending-room/{room_fixture['room_id']}/user-turn",
            {"content": "keep going"},
            "ENDING_ROOM_NOT_FOUND",
        ),
        (
            "post",
            f"/api/ending-room/thread/{thread_fixture['thread_id']}/user-turn",
            {"content": "thread follow-up"},
            "ENDING_ROOM_THREAD_NOT_FOUND",
        ),
    ]

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Session-Token": token},
    ) as client:
        for method, path, payload, error_code in route_cases:
            response = await getattr(client, method)(
                path,
                **({"json": payload} if payload is not None else {}),
            )
            assert response.status_code == 404
            assert response.json()["detail"]["code"] == error_code


class TestEndingRoomWebSocketOwnership:
    @pytest.mark.asyncio
    async def test_ending_room_websocket_requires_signed_principal(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        fixture = await _seed_owned_ending_room("owner-a")
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": "test-secret"})])

        await ending_rooms_api.ending_room_websocket_endpoint(ws, fixture["room_id"])

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4001, reason="Unauthorized")
        assert ws not in ending_rooms_api.ending_room_ws_manager._connections.get(
            fixture["room_id"],
            [],
        )

    @pytest.mark.asyncio
    async def test_ending_room_websocket_rejects_cross_owner_access(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        fixture = await _seed_owned_ending_room("owner-a")
        outsider_token = _make_signed_session_token("test-secret", "owner-b")
        ws = _make_ws_mock(side_effect=[json.dumps({"type": "auth", "token": outsider_token})])

        await ending_rooms_api.ending_room_websocket_endpoint(ws, fixture["room_id"])

        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4404, reason="ending room not found")
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        assert not any('"auth_ok"' in message for message in send_calls)
        assert ws not in ending_rooms_api.ending_room_ws_manager._connections.get(
            fixture["room_id"],
            [],
        )

    @pytest.mark.asyncio
    async def test_ending_room_websocket_accepts_owned_principal(self, monkeypatch):
        monkeypatch.setattr("app.api.ws.settings.SESSION_SECRET", "test-secret")
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "test-secret")
        fixture = await _seed_owned_ending_room("owner-a")
        owner_token = _make_signed_session_token("test-secret", "owner-a")
        ws = _make_ws_mock(
            side_effect=[
                json.dumps({"type": "auth", "token": owner_token}),
                WebSocketDisconnect(),
            ]
        )

        await ending_rooms_api.ending_room_websocket_endpoint(ws, fixture["room_id"])

        ws.accept.assert_awaited_once()
        send_calls = [c[0][0] for c in ws.send_text.call_args_list if c[0]]
        assert any('"auth_ok"' in message for message in send_calls)
        assert ws not in ending_rooms_api.ending_room_ws_manager._connections.get(
            fixture["room_id"],
            [],
        )
