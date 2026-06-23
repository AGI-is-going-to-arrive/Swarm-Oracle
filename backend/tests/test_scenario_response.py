"""Regression coverage for scenario API response assembly."""

from sqlmodel import Session

from app.api.helpers import load_scenario_response
from app.models.database import Branch, Round, Scenario, ScenarioStatus, get_engine


def _create_scenario(*, parsed_context: dict | None = None) -> str:
    engine = get_engine()
    scenario = Scenario(
        question="Will the progress bar use the real denominator?",
        status=ScenarioStatus.DONE,
        parsed_context=parsed_context,
    )
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        return scenario.id


def _create_branch_with_rounds(scenario_id: str, *round_numbers: int) -> str:
    engine = get_engine()
    branch = Branch(scenario_id=scenario_id, title="Main branch")
    with Session(engine) as session:
        session.add(branch)
        session.commit()
        branch_id = branch.id
        for round_number in round_numbers:
            session.add(Round(branch_id=branch_id, round_number=round_number))
        session.commit()
        return branch_id


def test_load_scenario_response_serializes_total_rounds_from_parsed_context():
    engine = get_engine()
    scenario_id = _create_scenario(parsed_context={"simulation_rounds": 7})

    response = load_scenario_response(engine, scenario_id)

    assert response is not None
    assert response.total_rounds == 7
    assert response.model_dump()["total_rounds"] == 7


def test_load_scenario_response_falls_back_to_actual_max_round_number():
    engine = get_engine()
    scenario_id = _create_scenario(parsed_context={})
    _create_branch_with_rounds(scenario_id, 1, 3)
    _create_branch_with_rounds(scenario_id, 2, 5)

    response = load_scenario_response(engine, scenario_id)

    assert response is not None
    assert response.total_rounds == 5
    assert response.model_dump()["total_rounds"] == 5


def test_load_scenario_response_uses_none_when_no_round_count_is_available():
    engine = get_engine()
    scenario_id = _create_scenario(parsed_context={})

    response = load_scenario_response(engine, scenario_id)

    assert response is not None
    assert response.total_rounds is None
    assert response.model_dump()["total_rounds"] is None
