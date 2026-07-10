"""Tests for user-initiated simulation cancellation."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

import app.api.helpers as helpers
import app.services.simulator as simulator_module
from app.main import app
from app.models import Agent, Branch, Round, Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.simulation_cancel import (
    clear_cancel_token,
    create_cancel_token,
    get_cancel_token,
    is_cancelled,
    request_cancel,
)
from app.services.simulator import (
    _gather_agent_messages,
    handle_simulation_cancelled,
    run_simulation,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_cancel_state():
    helpers._running_simulations.clear()
    helpers._parse_phase_simulations.clear()
    helpers._task_registry.clear()
    yield
    helpers._running_simulations.clear()
    helpers._parse_phase_simulations.clear()
    helpers._task_registry.clear()


def _seed_scenario(*, status: ScenarioStatus = ScenarioStatus.SIMULATING) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(question="Cancel this simulation?", status=status)
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        return scenario.id


def test_cancel_token_lifecycle():
    scenario_id = "scenario-token"

    token = create_cancel_token(scenario_id)

    assert get_cancel_token(scenario_id) is token
    assert not is_cancelled(scenario_id)
    assert request_cancel(scenario_id) is True
    assert is_cancelled(scenario_id)
    assert request_cancel("missing") is False

    clear_cancel_token(scenario_id)
    assert get_cancel_token(scenario_id) is None
    assert not is_cancelled(scenario_id)


def test_request_cancel_sets_custom_reason():
    scenario_id = "scenario-reason"
    create_cancel_token(scenario_id)

    assert request_cancel(scenario_id, reason="operator_cancelled") is True

    token = get_cancel_token(scenario_id)
    assert token is not None
    assert token.reason == "operator_cancelled"

    clear_cancel_token(scenario_id)


def test_cancel_running_scenario_returns_cancel_requested(client: TestClient):
    scenario_id = _seed_scenario()
    helpers._running_simulations.add(scenario_id)
    create_cancel_token(scenario_id)

    response = client.post(f"/api/scenario/{scenario_id}/cancel")

    assert response.status_code == 200
    assert response.json() == {"status": "cancel_requested"}
    assert is_cancelled(scenario_id)


def test_cancel_missing_scenario_returns_404(client: TestClient):
    response = client.post("/api/scenario/missing/cancel")

    assert response.status_code == 404


def test_cancel_existing_non_running_scenario_returns_409(client: TestClient):
    scenario_id = _seed_scenario(status=ScenarioStatus.DONE)

    response = client.post(f"/api/scenario/{scenario_id}/cancel")

    assert response.status_code == 409


@pytest.mark.parametrize(
    "status",
    [ScenarioStatus.PARSING, ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING],
)
def test_cancel_running_db_status_without_local_task_marks_cancelled(
    client: TestClient,
    status: ScenarioStatus,
):
    scenario_id = _seed_scenario(status=status)

    response = client.post(f"/api/scenario/{scenario_id}/cancel")

    assert response.status_code == 200
    assert response.json() == {"status": "cancel_requested"}
    assert is_cancelled(scenario_id)
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert scenario.status == ScenarioStatus.CANCELLED


def test_is_cancelled_observes_db_cancelled_status_without_local_token():
    scenario_id = _seed_scenario(status=ScenarioStatus.CANCELLED)

    assert get_cancel_token(scenario_id) is None
    assert is_cancelled(scenario_id)


def test_is_cancelled_observes_db_cancelled_status_with_local_token():
    scenario_id = _seed_scenario(status=ScenarioStatus.CANCELLED)
    create_cancel_token(scenario_id)

    assert is_cancelled(scenario_id)


@pytest.mark.parametrize("status", [ScenarioStatus.DONE, ScenarioStatus.ERROR])
@pytest.mark.asyncio
async def test_cancel_handler_does_not_demote_terminal_status(status: ScenarioStatus):
    scenario_id = _seed_scenario(status=status)
    create_cancel_token(scenario_id)
    request_cancel(scenario_id)
    events: list[dict] = []

    async def _push(_scenario_id: str, event: dict) -> None:
        events.append(event)

    await handle_simulation_cancelled(scenario_id, ws_callback=_push)

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert scenario.status == status
    assert events == []


def test_repeat_cancel_is_idempotent_while_still_running(client: TestClient):
    """Repeat cancel returns 200 while the run-reentrance guard still marks it running."""
    scenario_id = _seed_scenario()
    helpers._running_simulations.add(scenario_id)
    create_cancel_token(scenario_id)

    first = client.post(f"/api/scenario/{scenario_id}/cancel")
    second = client.post(f"/api/scenario/{scenario_id}/cancel")

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json() == {"status": "cancel_requested"}


@pytest.mark.asyncio
async def test_run_simulation_persists_cancelled_terminal_state():
    scenario_id = _seed_scenario()
    create_cancel_token(scenario_id)
    request_cancel(scenario_id, reason="manual_stop")
    events: list[dict] = []

    async def _push(_scenario_id: str, event: dict) -> None:
        events.append(event)

    await run_simulation(scenario_id, ws_callback=_push)

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert scenario.status == ScenarioStatus.CANCELLED

    assert {"type": "simulation_cancelled", "reason": "manual_stop"} in events
    assert get_cancel_token(scenario_id) is None


@pytest.mark.asyncio
async def test_agent_speak_is_persisted_before_broadcast(monkeypatch):
    scenario_id = _seed_scenario()
    engine = get_engine()
    with Session(engine) as session:
        branch = Branch(scenario_id=scenario_id, title="root")
        agent = Agent(scenario_id=scenario_id, name="Analyst", role="Strategist")
        session.add(branch)
        session.add(agent)
        session.commit()
        session.refresh(branch)
        session.refresh(agent)
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.commit()
        session.refresh(round_row)
        branch_id = branch.id
        round_id = round_row.id
        agent_id = agent.id

    async def _fake_llm_call(*_args, **_kwargs):
        return "Persist me first"

    async def _fake_llm_call_json(*_args, **_kwargs):
        return {"content": "Persist me first", "emotion": "calm", "diverge": None}

    monkeypatch.setattr(simulator_module, "llm_call", _fake_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", _fake_llm_call_json)
    monkeypatch.setattr(simulator_module, "retrieve_relevant_memories", lambda *_a, **_k: "")
    monkeypatch.setattr(simulator_module, "store_memory", lambda **_kwargs: None)
    monkeypatch.setattr(simulator_module, "get_runtime_parallelism_limit", lambda: 1)

    persisted_counts_at_broadcast: list[int] = []

    async def _push(event: dict) -> None:
        if event.get("type") != "agent_speak":
            return
        with Session(engine) as session:
            persisted_counts_at_broadcast.append(
                len(session.get(Round, round_id).messages)  # type: ignore[union-attr]
            )

    await _gather_agent_messages(
        engine,
        scenario_id,
        branch_id,
        round_id,
        1,
        [{"id": agent_id, "name": "Analyst", "role": "Strategist", "tier": "IMPORTANT"}],
        "lab",
        "topic",
        push=_push,
        llm_overrides={},
    )

    assert persisted_counts_at_broadcast == [1]
