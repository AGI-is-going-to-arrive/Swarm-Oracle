"""Branch lineage authority tests."""

from __future__ import annotations

import importlib

import pytest
from sqlmodel import Session

from app.models.database import Branch, Round, Scenario, ScenarioStatus, get_engine


def _add_rounds(session: Session, branch_id: str, *round_numbers: int) -> None:
    session.add_all(
        [
            Round(
                branch_id=branch_id,
                round_number=round_number,
                compressed_summary=f"{branch_id}:{round_number}",
            )
            for round_number in round_numbers
        ]
    )


def test_replay_branch_is_self_contained_and_does_not_duplicate_parent_rounds():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="lineage", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()

        source = Branch(scenario_id=scenario.id, title="source")
        session.add(source)
        session.flush()
        session.add_all(
            [
                Round(branch_id=source.id, round_number=1, compressed_summary="source-1"),
                Round(branch_id=source.id, round_number=2, compressed_summary="source-2"),
            ]
        )

        replay = Branch(
            scenario_id=scenario.id,
            parent_branch_id=source.id,
            fork_round=2,
            replay_kind="counterfactual",
            replay_source_branch_id=source.id,
            replay_source_round=2,
            title="replay",
        )
        session.add(replay)
        session.flush()
        session.add_all(
            [
                Round(branch_id=replay.id, round_number=1, compressed_summary="replay-1"),
                Round(branch_id=replay.id, round_number=2, compressed_summary="replay-2"),
            ]
        )
        replay_id = replay.id
        session.commit()

        lineage_module = importlib.import_module("app.services.branch_lineage")
        selection = lineage_module.select_branch_rounds(
            session,
            scenario_id=scenario.id,
            branch_id=replay_id,
        )

    assert [round_.round_number for round_ in selection.rounds] == [1, 2]
    assert [round_.branch_id for round_ in selection.rounds] == [replay_id, replay_id]


def test_native_three_generation_lineage_uses_disjoint_fork_segments():
    from app.services.branch_lineage import select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="native lineage", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()

        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 2)

        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=2,
            title="child",
        )
        session.add(child)
        session.flush()
        _add_rounds(session, child.id, 3, 4)

        grandchild = Branch(
            scenario_id=scenario.id,
            parent_branch_id=child.id,
            fork_round=4,
            title="grandchild",
        )
        session.add(grandchild)
        session.flush()
        _add_rounds(session, grandchild.id, 5, 6)
        root_id = root.id
        child_id = child.id
        grandchild_id = grandchild.id
        session.commit()

        selection = select_branch_rounds(
            session,
            scenario_id=scenario.id,
            branch_id=grandchild_id,
        )

    assert [
        (segment.branch_id, segment.round_min, segment.round_max)
        for segment in selection.lineage.segments
    ] == [
        (root_id, 0, 2),
        (child_id, 3, 4),
        (grandchild_id, 5, None),
    ]
    assert [round_.round_number for round_ in selection.rounds] == [1, 2, 3, 4, 5, 6]
    assert [round_.branch_id for round_ in selection.rounds] == [
        root_id,
        root_id,
        child_id,
        child_id,
        grandchild_id,
        grandchild_id,
    ]


def test_native_child_pre_fork_cutoff_selects_only_truncated_ancestor_rounds():
    from app.services.branch_lineage import select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="cutoff", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 2)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=2,
            title="child",
        )
        session.add(child)
        session.flush()
        _add_rounds(session, child.id, 3)
        scenario_id = scenario.id
        root_id = root.id
        child_id = child.id
        session.commit()

        selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=child_id,
            requested_cutoff=1,
        )

    assert [
        (segment.branch_id, segment.round_min, segment.round_max)
        for segment in selection.lineage.segments
    ] == [(root_id, 0, 1), (child_id, 3, 1)]
    assert [(round_.branch_id, round_.round_number) for round_ in selection.rounds] == [
        (root_id, 1)
    ]


def test_missing_native_parent_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="missing parent", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id="missing-parent",
            fork_round=2,
            title="orphan",
        )
        session.add(child)
        session.commit()
        scenario_id = scenario.id
        child_id = child.id

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=child_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_MISSING_PARENT"


def test_native_parent_cycle_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="cycle", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        branch_a = Branch(scenario_id=scenario.id, fork_round=1, title="a")
        session.add(branch_a)
        session.flush()
        branch_b = Branch(
            scenario_id=scenario.id,
            parent_branch_id=branch_a.id,
            fork_round=2,
            title="b",
        )
        session.add(branch_b)
        session.flush()
        branch_a.parent_branch_id = branch_b.id
        session.add(branch_a)
        scenario_id = scenario.id
        branch_b_id = branch_b.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=branch_b_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_CYCLE"


def test_cross_scenario_native_parent_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="owner", status=ScenarioStatus.DONE)
        other_scenario = Scenario(question="other", status=ScenarioStatus.DONE)
        session.add_all([scenario, other_scenario])
        session.flush()
        foreign_parent = Branch(scenario_id=other_scenario.id, title="foreign")
        session.add(foreign_parent)
        session.flush()
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=foreign_parent.id,
            fork_round=1,
            title="child",
        )
        session.add(child)
        scenario_id = scenario.id
        child_id = child.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=child_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_CROSS_SCENARIO_PARENT"


def test_descending_native_fork_boundary_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="fork boundary", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 2, 3)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=3,
            title="child",
        )
        session.add(child)
        session.flush()
        grandchild = Branch(
            scenario_id=scenario.id,
            parent_branch_id=child.id,
            fork_round=2,
            title="grandchild",
        )
        session.add(grandchild)
        scenario_id = scenario.id
        grandchild_id = grandchild.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=grandchild_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY"


def test_missing_materialized_fork_round_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="missing boundary", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 2)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=3,
            title="child",
        )
        session.add(child)
        session.flush()
        _add_rounds(session, child.id, 4)
        scenario_id = scenario.id
        child_id = child.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=child_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY"


def test_equal_descendant_fork_boundary_cannot_reuse_grandparent_round():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="equal boundary", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 2, 3)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=3,
            title="child",
        )
        session.add(child)
        session.flush()
        grandchild = Branch(
            scenario_id=scenario.id,
            parent_branch_id=child.id,
            fork_round=3,
            title="grandchild",
        )
        session.add(grandchild)
        scenario_id = scenario.id
        grandchild_id = grandchild.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=grandchild_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY"


def test_negative_requested_cutoff_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="negative cutoff", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1)
        scenario_id = scenario.id
        root_id = root.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=root_id,
                requested_cutoff=-1,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_CUTOFF"


def test_negative_native_fork_boundary_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="negative fork", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=-1,
            title="invalid child",
        )
        session.add(child)
        scenario_id = scenario.id
        child_id = child.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=child_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY"


def test_duplicate_visible_round_number_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="duplicate round", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 1)
        scenario_id = scenario.id
        root_id = root.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=root_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_DUPLICATE_ROUND"


def test_missing_round_inside_root_segment_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="root round gap", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 3)
        scenario_id = scenario.id
        root_id = root.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=root_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_MISSING_ROUND"


def test_missing_round_across_native_segments_fails_closed():
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="cross-segment gap", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 2)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=2,
            title="child",
        )
        session.add(child)
        session.flush()
        _add_rounds(session, child.id, 4)
        scenario_id = scenario.id
        child_id = child.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=child_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_MISSING_ROUND"


def test_requested_cutoff_zero_allows_an_empty_selection():
    from app.services.branch_lineage import select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="zero cutoff", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1, 3)
        scenario_id = scenario.id
        root_id = root.id
        session.commit()

        selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=root_id,
            requested_cutoff=0,
        )

    assert selection.rounds == ()


def test_unstarted_empty_branch_without_cutoff_is_legal():
    from app.services.branch_lineage import select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="unstarted", status=ScenarioStatus.PARSING)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        scenario_id = scenario.id
        root_id = root.id
        session.commit()

        selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=root_id,
        )

    assert selection.rounds == ()


def test_empty_native_leaf_keeps_contiguous_ancestor_rounds():
    from app.services.branch_lineage import select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="empty leaf", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=1,
            title="empty child",
        )
        session.add(child)
        scenario_id = scenario.id
        root_id = root.id
        child_id = child.id
        session.commit()

        selection = select_branch_rounds(
            session,
            scenario_id=scenario_id,
            branch_id=child_id,
        )

    assert [
        (round_.branch_id, round_.round_number) for round_ in selection.rounds
    ] == [(root_id, 1)]


@pytest.mark.parametrize(
    "invalid_cutoff",
    [
        pytest.param(True, id="bool-true"),
        pytest.param(False, id="bool-false"),
        pytest.param(1.0, id="float-integral"),
        pytest.param(1.5, id="float-fractional"),
        pytest.param("1", id="string"),
    ],
)
def test_requested_cutoff_requires_a_strict_non_negative_int(invalid_cutoff):
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="strict cutoff", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1)
        scenario_id = scenario.id
        root_id = root.id
        session.commit()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=root_id,
                requested_cutoff=invalid_cutoff,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_CUTOFF"


@pytest.mark.parametrize(
    "invalid_fork",
    [
        pytest.param("bad", id="text"),
        pytest.param(1.5, id="real"),
    ],
)
def test_persisted_malformed_fork_boundary_fails_with_stable_code(invalid_fork):
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="legacy fork", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=1,
            title="child",
        )
        session.add(child)
        session.flush()
        _add_rounds(session, child.id, 2)
        scenario_id = scenario.id
        child_id = child.id
        session.commit()

        session.connection().exec_driver_sql(
            'UPDATE "branch" SET fork_round = ? WHERE id = ?',
            (invalid_fork, child_id),
        )
        session.commit()
        session.expire_all()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=child_id,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY"


@pytest.mark.parametrize(
    "invalid_fork",
    [
        pytest.param(None, id="null"),
        pytest.param(True, id="bool"),
    ],
)
def test_runtime_malformed_fork_boundary_fails_with_stable_code(invalid_fork):
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="runtime fork", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        _add_rounds(session, root.id, 1)
        child = Branch(
            scenario_id=scenario.id,
            parent_branch_id=root.id,
            fork_round=1,
            title="child",
        )
        session.add(child)
        session.flush()
        _add_rounds(session, child.id, 2)
        scenario_id = scenario.id
        child_id = child.id
        session.commit()

        child.fork_round = invalid_fork
        with session.no_autoflush:
            with pytest.raises(BranchLineageError) as exc_info:
                select_branch_rounds(
                    session,
                    scenario_id=scenario_id,
                    branch_id=child_id,
                )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY"


@pytest.mark.parametrize(
    "invalid_round_number",
    [
        pytest.param("bad", id="text"),
        pytest.param(1.5, id="real"),
        pytest.param(0, id="zero"),
        pytest.param(-1, id="negative"),
    ],
)
def test_persisted_malformed_round_number_fails_with_stable_code(
    invalid_round_number,
):
    from app.services.branch_lineage import BranchLineageError, select_branch_rounds

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="legacy round", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.flush()
        root = Branch(scenario_id=scenario.id, title="root")
        session.add(root)
        session.flush()
        round_row = Round(branch_id=root.id, round_number=1)
        session.add(round_row)
        session.flush()
        scenario_id = scenario.id
        root_id = root.id
        round_id = round_row.id
        session.commit()

        session.connection().exec_driver_sql(
            'UPDATE "round" SET round_number = ? WHERE id = ?',
            (invalid_round_number, round_id),
        )
        session.commit()
        session.expire_all()

        with pytest.raises(BranchLineageError) as exc_info:
            select_branch_rounds(
                session,
                scenario_id=scenario_id,
                branch_id=root_id,
                requested_cutoff=1,
            )

    assert exc_info.value.code == "BRANCH_LINEAGE_INVALID_ROUND_NUMBER"
