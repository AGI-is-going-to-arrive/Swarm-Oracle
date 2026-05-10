import asyncio
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class SimulationCancelToken:
    scenario_id: str
    event: asyncio.Event = field(default_factory=asyncio.Event)
    reason: str = 'user_cancelled'

_cancel_registry: dict[str, SimulationCancelToken] = {}

def get_cancel_token(scenario_id: str) -> Optional[SimulationCancelToken]:
    return _cancel_registry.get(scenario_id)

def create_cancel_token(scenario_id: str) -> SimulationCancelToken:
    token = SimulationCancelToken(scenario_id=scenario_id)
    _cancel_registry[scenario_id] = token
    return token

def get_or_create_cancel_token(scenario_id: str) -> SimulationCancelToken:
    """Idempotently fetch (or create) a cancel token.

    H2 fix: scenario creation registers the token before parse begins so that
    cancel requests landing during parse do not race the registry.
    run_sim_background reuses any pre-registered token instead of clobbering it.
    """
    existing = _cancel_registry.get(scenario_id)
    if existing is not None:
        return existing
    return create_cancel_token(scenario_id)

def request_cancel(scenario_id: str, reason: str = 'user_cancelled') -> bool:
    token = _cancel_registry.get(scenario_id)
    if token is None:
        return False
    token.reason = reason
    token.event.set()
    return True

def clear_cancel_token(scenario_id: str) -> None:
    _cancel_registry.pop(scenario_id, None)

def _db_cancelled(scenario_id: str) -> bool:
    try:
        from sqlmodel import Session

        from app.models.database import Scenario, ScenarioStatus, get_engine

        with Session(get_engine()) as session:
            scenario = session.get(Scenario, scenario_id)
            return scenario is not None and scenario.status == ScenarioStatus.CANCELLED
    except Exception:
        return False

def is_cancelled(scenario_id: str) -> bool:
    token = _cancel_registry.get(scenario_id)
    if token is not None and token.event.is_set():
        return True
    return _db_cancelled(scenario_id)
