"""Regression coverage for scenario API response assembly."""

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, SQLModel, create_engine

from app.api.helpers import load_scenario_response
from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import Branch, Round, Scenario, ScenarioStatus, get_engine
from app.models.graph import GraphSnapshot


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


def test_load_scenario_response_scopes_and_sorts_additive_graph_fields():
    engine = get_engine()
    scenario_id = _create_scenario(parsed_context={})
    other_scenario_id = _create_scenario(parsed_context={})
    now = datetime(2026, 7, 10, tzinfo=timezone.utc)

    with Session(engine) as session:
        session.add_all([
            GraphSnapshot(
                id="causal-main",
                owner_type="scenario",
                owner_id=scenario_id,
                graph_kind="causal_review",
                created_at=now,
            ),
            GraphSnapshot(
                id="argument-same-owner",
                owner_type="scenario",
                owner_id=scenario_id,
                graph_kind="argument_map",
                created_at=now + timedelta(minutes=1),
            ),
            GraphSnapshot(
                id="causal-other-owner",
                owner_type="scenario",
                owner_id=other_scenario_id,
                graph_kind="causal_review",
                created_at=now + timedelta(minutes=2),
            ),
            ScenarioCheckpoint(
                id="cp-round-2-b",
                scenario_id=scenario_id,
                branch_id="branch-b",
                round_number=2,
                compressed_summary="must not be embedded",
                blackboard_json='{"large":"private"}',
                created_at=now + timedelta(minutes=3),
            ),
            ScenarioCheckpoint(
                id="cp-round-1-z",
                scenario_id=scenario_id,
                branch_id="branch-z",
                round_number=1,
                created_at=now + timedelta(minutes=4),
            ),
            ScenarioCheckpoint(
                id="cp-round-1-a",
                scenario_id=scenario_id,
                branch_id="branch-a",
                round_number=1,
                created_at=now + timedelta(minutes=5),
            ),
            ScenarioCheckpoint(
                id="cp-other-scenario",
                scenario_id=other_scenario_id,
                branch_id="branch-other",
                round_number=0,
                created_at=now + timedelta(minutes=6),
            ),
        ])
        session.commit()

    response = load_scenario_response(engine, scenario_id)

    assert response is not None
    assert response.causal_graph_id == "causal-main"
    assert [checkpoint["id"] for checkpoint in response.checkpoints] == [
        "cp-round-1-a",
        "cp-round-1-z",
        "cp-round-2-b",
    ]
    assert all(checkpoint["scenario_id"] == scenario_id for checkpoint in response.checkpoints)
    assert set(response.checkpoints[0]) == {
        "id",
        "scenario_id",
        "branch_id",
        "round_number",
        "created_at",
    }


def test_load_scenario_response_uses_explicit_empty_additive_graph_values():
    engine = get_engine()
    scenario_id = _create_scenario(parsed_context={})

    response = load_scenario_response(engine, scenario_id)

    assert response is not None
    assert response.causal_graph_id is None
    assert response.checkpoints == []


def test_load_scenario_response_uses_latest_legacy_duplicate_causal_snapshot(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-scenario-response.db'}")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            """
            CREATE TABLE graph_snapshot (
                id TEXT NOT NULL PRIMARY KEY,
                owner_type TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                graph_kind TEXT NOT NULL,
                branch_id TEXT,
                round_number INTEGER,
                share_artifact_id TEXT,
                metadata_json TEXT,
                created_at DATETIME NOT NULL
            )
            """
        )
    SQLModel.metadata.create_all(engine)
    now = datetime(2026, 7, 10, tzinfo=timezone.utc)

    with Session(engine) as session:
        scenario = Scenario(
            question="Which legacy graph is current?",
            status=ScenarioStatus.DONE,
            parsed_context={},
        )
        session.add(scenario)
        session.flush()
        session.add_all([
            GraphSnapshot(
                id="old-snapshot",
                owner_type="scenario",
                owner_id=scenario.id,
                graph_kind="causal_review",
                created_at=now,
            ),
            GraphSnapshot(
                id="new-snapshot",
                owner_type="scenario",
                owner_id=scenario.id,
                graph_kind="causal_review",
                created_at=now + timedelta(seconds=1),
            ),
        ])
        session.commit()
        scenario_id = scenario.id

    response = load_scenario_response(engine, scenario_id)

    assert response is not None
    assert response.causal_graph_id == "new-snapshot"


def test_load_scenario_response_bounds_checkpoint_metadata():
    engine = get_engine()
    scenario_id = _create_scenario(parsed_context={})

    with Session(engine) as session:
        session.add_all([
            ScenarioCheckpoint(
                id=f"cp-{index:03d}",
                scenario_id=scenario_id,
                branch_id=f"branch-{index:03d}",
                round_number=1,
            )
            for index in range(205)
        ])
        session.commit()

    response = load_scenario_response(engine, scenario_id)

    assert response is not None
    assert len(response.checkpoints) == 200
    assert [checkpoint["id"] for checkpoint in response.checkpoints[:2]] == [
        "cp-000",
        "cp-001",
    ]
