"""Authoritative materialization of effective branch round lineage."""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, select

from app.models.database import Branch, Round


class BranchLineageError(ValueError):
    """Fail-closed error for invalid or incomplete branch lineage."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class LineageSegment:
    """A materialized branch segment with inclusive round bounds."""

    branch_id: str
    round_min: int
    round_max: int | None


@dataclass(frozen=True)
class ResolvedBranchLineage:
    scenario_id: str
    leaf_branch_id: str
    segments: tuple[LineageSegment, ...]
    requested_cutoff: int | None
    is_self_contained_replay: bool


@dataclass(frozen=True)
class BranchRoundSelection:
    lineage: ResolvedBranchLineage
    rounds: tuple[Round, ...]

    @property
    def round_numbers(self) -> tuple[int, ...]:
        return tuple(round_.round_number for round_ in self.rounds)

    @property
    def max_round(self) -> int | None:
        return max(self.round_numbers, default=None)

    def contains(self, round_number: int) -> bool:
        return round_number in self.round_numbers


def _require_strict_int(
    value: object,
    *,
    code: str,
    label: str,
    minimum: int,
) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise BranchLineageError(
            code,
            f"{label} must be an integer greater than or equal to {minimum}",
        )
    return value


def _validate_materialized_fork_boundaries(
    lineage: ResolvedBranchLineage,
    rounds_by_branch: dict[str, list[Round]],
) -> None:
    segments = lineage.segments
    for child_index in range(1, len(segments)):
        boundary = segments[child_index].round_min - 1
        owner_segment = segments[child_index - 1]
        boundary_exists = any(
            round_.round_number == boundary
            for round_ in rounds_by_branch[owner_segment.branch_id]
        )
        if not boundary_exists:
            raise BranchLineageError(
                "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY",
                (
                    f"Branch lineage has no materialized source round "
                    f"at fork boundary {boundary}"
                ),
            )


def resolve_branch_lineage(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    requested_cutoff: int | None = None,
) -> ResolvedBranchLineage:
    """Resolve branch metadata into effective root-to-leaf segments."""
    branch = session.exec(
        select(Branch).where(
            Branch.id == branch_id,
            Branch.scenario_id == scenario_id,
        )
    ).first()
    if branch is None:
        raise BranchLineageError(
            "BRANCH_LINEAGE_BRANCH_NOT_FOUND",
            f"Branch {branch_id} not found in scenario {scenario_id}",
        )

    cutoff = (
        _require_strict_int(
            requested_cutoff,
            code="BRANCH_LINEAGE_INVALID_CUTOFF",
            label="requested_cutoff",
            minimum=0,
        )
        if requested_cutoff is not None
        else None
    )
    is_self_contained_replay = bool(str(branch.replay_kind or "").strip())
    branches_leaf_first = [branch]
    seen = {branch.id}
    current = branch
    while not bool(str(current.replay_kind or "").strip()) and current.parent_branch_id:
        parent = session.get(Branch, current.parent_branch_id)
        if parent is None:
            raise BranchLineageError(
                "BRANCH_LINEAGE_MISSING_PARENT",
                (
                    f"Branch {current.id} references missing parent "
                    f"{current.parent_branch_id}"
                ),
            )
        if parent.scenario_id != scenario_id:
            raise BranchLineageError(
                "BRANCH_LINEAGE_CROSS_SCENARIO_PARENT",
                (
                    f"Branch {current.id} references parent {parent.id} "
                    "from another scenario"
                ),
            )
        if parent.id in seen:
            raise BranchLineageError(
                "BRANCH_LINEAGE_CYCLE",
                f"Branch parent lineage contains a cycle at {parent.id}",
            )
        seen.add(parent.id)
        branches_leaf_first.append(parent)
        current = parent

    branches = list(reversed(branches_leaf_first))
    fork_boundaries = {
        lineage_branch.id: _require_strict_int(
            lineage_branch.fork_round,
            code="BRANCH_LINEAGE_INVALID_FORK_BOUNDARY",
            label=f"Branch {lineage_branch.id} fork_round",
            minimum=0,
        )
        for lineage_branch in branches
    }
    first_branch = branches[0]
    if (
        not bool(str(first_branch.replay_kind or "").strip())
        and fork_boundaries[first_branch.id] != 0
    ):
        raise BranchLineageError(
            "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY",
            f"Native root branch {first_branch.id} must have fork_round 0",
        )
    for parent, child in zip(branches, branches[1:], strict=False):
        parent_boundary = fork_boundaries[parent.id]
        child_boundary = fork_boundaries[child.id]
        if child_boundary <= parent_boundary:
            raise BranchLineageError(
                "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY",
                (
                    f"Branch {child.id} fork_round {child_boundary} must be "
                    f"greater than parent boundary {parent_boundary}"
                ),
            )
    segments: list[LineageSegment] = []
    for index, lineage_branch in enumerate(branches):
        round_min = 0 if index == 0 else fork_boundaries[lineage_branch.id] + 1
        natural_max = (
            fork_boundaries[branches[index + 1].id]
            if index + 1 < len(branches)
            else None
        )
        round_max = natural_max
        if cutoff is not None:
            round_max = cutoff if round_max is None else min(round_max, cutoff)
        segments.append(
            LineageSegment(
                branch_id=lineage_branch.id,
                round_min=round_min,
                round_max=round_max,
            )
        )
    return ResolvedBranchLineage(
        scenario_id=scenario_id,
        leaf_branch_id=branch.id,
        segments=tuple(segments),
        requested_cutoff=cutoff,
        is_self_contained_replay=is_self_contained_replay,
    )


def select_branch_rounds(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    requested_cutoff: int | None = None,
) -> BranchRoundSelection:
    """Return materialized rounds for the effective branch lineage."""
    lineage = resolve_branch_lineage(
        session,
        scenario_id=scenario_id,
        branch_id=branch_id,
        requested_cutoff=requested_cutoff,
    )
    lineage_branch_ids = tuple(segment.branch_id for segment in lineage.segments)
    rounds_by_branch: dict[str, list[Round]] = {
        branch_id: [] for branch_id in lineage_branch_ids
    }
    materialized_rounds = session.exec(
        select(Round).where(Round.branch_id.in_(lineage_branch_ids))
    ).all()
    for round_ in materialized_rounds:
        _require_strict_int(
            round_.round_number,
            code="BRANCH_LINEAGE_INVALID_ROUND_NUMBER",
            label=f"Round {round_.id} round_number",
            minimum=1,
        )
        rounds_by_branch[round_.branch_id].append(round_)
    _validate_materialized_fork_boundaries(lineage, rounds_by_branch)
    rounds: list[Round] = []
    for segment in lineage.segments:
        if segment.round_max is not None and segment.round_max < segment.round_min:
            continue
        for round_ in rounds_by_branch[segment.branch_id]:
            if round_.round_number < segment.round_min:
                continue
            if (
                segment.round_max is not None
                and round_.round_number > segment.round_max
            ):
                continue
            rounds.append(round_)
    rounds.sort(key=lambda round_: round_.round_number)
    seen_round_numbers: set[int] = set()
    for round_ in rounds:
        if round_.round_number in seen_round_numbers:
            raise BranchLineageError(
                "BRANCH_LINEAGE_DUPLICATE_ROUND",
                (
                    f"Branch lineage contains duplicate visible round "
                    f"{round_.round_number}"
                ),
            )
        seen_round_numbers.add(round_.round_number)
    for expected_round_number, round_ in enumerate(rounds, start=1):
        if round_.round_number != expected_round_number:
            raise BranchLineageError(
                "BRANCH_LINEAGE_MISSING_ROUND",
                (
                    "Branch lineage is missing visible round "
                    f"{expected_round_number}"
                ),
            )
    return BranchRoundSelection(lineage=lineage, rounds=tuple(rounds))
