"""Campaign API for Track A / Phase A1."""

from __future__ import annotations

import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.api.errors import api_error_from_exception
from app.api.helpers import (
    SessionPrincipal,
    require_owned_scenario,
    require_session_principal,
    resolve_authenticated_user_id,
    verify_session,
)
from app.models import InterventionLog, Scenario
from app.models.database import get_engine
from app.services.campaign import (
    CampaignBetValidationError,
    CampaignConflictError,
    CampaignError,
    CampaignNotFoundError,
    CampaignStateError,
    finalize_scenario_campaign,
    get_campaign_profile_summary,
    get_daily_challenge_summary,
    get_scenario_campaign_summary,
    get_scenario_director_state,
    get_scenario_gameplay_state,
    get_weekly_campaign_summary,
    list_campaign_badge_summaries,
    list_campaign_mastery_summaries,
    save_scenario_director_state,
    save_scenario_gameplay_state,
)
from app.services.daily_challenges import get_challenge_rotation
from app.services.gameplay_contract import load_gameplay_contract

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/campaign",
    tags=["campaign"],
    dependencies=[Depends(verify_session)],
)


# Phase 4: intervention-effects sub-router lives outside the /api/campaign prefix
# because consumers expect /api/scenario/{scenario_id}/intervention-effects.
scenario_intervention_effects_router = APIRouter(
    prefix="/api",
    tags=["interventions"],
    dependencies=[Depends(verify_session)],
)

VALID_ARCHIVE_GRADES = {"S", "A", "B", "C"}
VALID_PROFILE_RESONANCES = {"signature", "aligned", "offbeat"}
VALID_COMMITMENT_OUTCOMES = {"hit", "miss", "pending"}
VALID_GAMEPLAY_BET_KINDS = {"branch_winner", "ending_tone", "profile_resonance"}


def _require_owned_campaign_scenario(
    scenario_id: str,
    principal: SessionPrincipal | None,
) -> None:
    if principal is None:
        return
    with Session(get_engine()) as session:
        require_owned_scenario(session, scenario_id, principal)


def _campaign_scenario_exists(scenario_id: str) -> bool:
    with Session(get_engine()) as session:
        return session.get(Scenario, scenario_id) is not None


class CampaignProfileResponse(BaseModel):
    id: str
    user_id: str
    user_name: str
    total_runs: int
    completed_challenges: int
    total_bets: int
    hit_bets: int
    highest_archive_grade: str | None = None
    created_at: str
    updated_at: str
    last_daily_challenge_completed_at: str | None = None
    last_daily_challenge_profile_id: str | None = None
    last_daily_challenge_scenario_id: str | None = None


class CampaignMasteryResponse(BaseModel):
    id: str
    director_profile_id: str
    profile_id: str
    runs: int
    challenge_completions: int
    signature_hits: int
    aligned_hits: int
    campaign_score: int
    level: int
    best_archive_grade: str | None = None
    favorite_card_id: str | None = None
    updated_at: str
    next_level_score: int
    score_to_next_level: int


class CampaignBadgeResponse(BaseModel):
    id: str
    badge_id: str
    unlocked_at: str
    source_profile_id: str | None = None
    source_scenario_id: str | None = None


class CampaignBadgeDefinitionResponse(BaseModel):
    """Phase 3: static badge registry entry (definition, not unlock)."""

    id: str
    name_key: str
    description_key: str
    category: str
    one_time: bool = True


class CampaignScoreBreakdownItem(BaseModel):
    id: str
    label_key: str
    points: int
    applied: bool


class CampaignDailyChallengeResponse(BaseModel):
    user_id: str
    profile_id: str
    local_date: str
    timezone_offset_minutes: int
    completed: bool
    scenario_id: str | None = None
    completed_at: str | None = None
    most_used_card: str | None = None
    betting_hit: bool | None = None
    profile_resonance: str | None = None
    campaign_score_delta: int | None = None
    # Campaign Phase 1: durable challenge fields
    challenge_id: str | None = None
    challenge_local_date: str | None = None
    difficulty_tier: str | None = None
    streak_after: int | None = None
    campaign_context_source: str | None = None
    # Campaign Phase 2a: streak / activity envelope
    current_streak: int = 0
    recent_daily_completion_days: int = 0
    next_refresh_at: str | None = None


class CampaignLeaderboardEntryResponse(BaseModel):
    """One row in a weekly leaderboard.

    Privacy-by-design: ``user_name`` is masked (first 3 chars + ``***``) and
    no user_id is exposed. Rank is 1-indexed.
    """

    rank: int
    user_name: str
    score: int


class CampaignWeeklySummaryResponse(BaseModel):
    user_id: str
    week_start: str
    week_end: str
    timezone_offset_minutes: int
    total_runs: int
    completed_daily_challenges: int
    hit_bets: int
    campaign_score_delta: int
    best_archive_grade: str | None = None
    top_profile_id: str | None = None
    profile_runs: dict[str, int] = Field(default_factory=dict)
    # Campaign Phase 1: durable week + weekly-track aggregates
    week_key: str | None = None
    weekly_bonus_total: int = 0
    weekly_track_runs: dict[str, int] = Field(default_factory=dict)
    # Campaign Phase 2b: active weekly track + leaderboard preview
    weekly_track_id: str | None = None
    rank: int | None = None
    leaderboard_entries: list[CampaignLeaderboardEntryResponse] = Field(
        default_factory=list
    )


class CampaignChallengeDefinitionResponse(BaseModel):
    id: str
    question: str
    question_en: str | None = None
    subtitle_zh: str
    subtitle_en: str
    profile_id: str
    rounds: int
    num_agents: int
    mode: Literal["blackboard", "raw"]
    visualization_enabled: bool
    # Campaign Phase 2a: per-challenge difficulty + hierarchical hint
    hierarchical: bool = False
    difficulty_tier: str | None = None


class CampaignChallengeRecommendedParamsResponse(BaseModel):
    num_agents: int | None = None
    rounds: int | None = None
    mode: Literal["blackboard", "raw"] | None = None
    hierarchical: bool = False
    visualization_enabled: bool = True
    difficulty_tier: str | None = None


class CampaignWeeklyTrackResponse(BaseModel):
    id: str
    week_key: str
    title_zh: str
    title_en: str
    subtitle_zh: str
    subtitle_en: str
    profile_ids: list[str]
    recommended_params: dict[str, object] = Field(default_factory=dict)
    bonus_rules: str
    bonus_rules_zh: str | None = None
    bonus_rules_en: str | None = None


class CampaignChallengeRotationResponse(BaseModel):
    local_date: str
    week_key: str
    iso_week_key: str | None = None
    next_refresh_at: str | None = None
    today_challenge: CampaignChallengeDefinitionResponse
    today_recommended_params: (
        CampaignChallengeRecommendedParamsResponse | None
    ) = None
    weekly_challenges: list[CampaignChallengeDefinitionResponse]
    weekly_track: CampaignWeeklyTrackResponse | None = None


class CampaignFinalizeRequest(BaseModel):
    user_id: str
    user_name: str = ""
    profile_id: str
    archive_grade: str = "C"
    profile_resonance: str = "offbeat"
    betting_hit: bool | None = None
    bet_count: int = 0
    most_used_card: str | None = None
    completed_daily_challenge: bool = False
    objective_completed_count: int = 0
    objective_total_count: int = 0
    commitment_outcome: str | None = None

    @field_validator("user_id", "profile_id")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Field cannot be empty")
        return normalized

    @field_validator("user_name")
    @classmethod
    def validate_user_name(cls, value: str) -> str:
        return value.strip()

    @field_validator("archive_grade")
    @classmethod
    def validate_archive_grade(cls, value: str) -> str:
        normalized = value.strip().upper()
        if normalized not in VALID_ARCHIVE_GRADES:
            raise ValueError(f"archive_grade must be one of {sorted(VALID_ARCHIVE_GRADES)}")
        return normalized

    @field_validator("profile_resonance")
    @classmethod
    def validate_profile_resonance(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in VALID_PROFILE_RESONANCES:
            raise ValueError(
                f"profile_resonance must be one of {sorted(VALID_PROFILE_RESONANCES)}"
            )
        return normalized

    @field_validator("bet_count")
    @classmethod
    def validate_bet_count(cls, value: int) -> int:
        if value < 0:
            raise ValueError("bet_count must be >= 0")
        return value

    @field_validator("objective_completed_count", "objective_total_count")
    @classmethod
    def validate_objective_counts(cls, value: int) -> int:
        if value < 0:
            raise ValueError("objective counts must be >= 0")
        return value

    @field_validator("most_used_card")
    @classmethod
    def validate_most_used_card(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("commitment_outcome")
    @classmethod
    def validate_commitment_outcome(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().lower()
        if normalized not in VALID_COMMITMENT_OUTCOMES:
            raise ValueError(
                f"commitment_outcome must be one of {sorted(VALID_COMMITMENT_OUTCOMES)}"
            )
        return normalized

    @field_validator("objective_total_count")
    @classmethod
    def validate_objective_total_count(cls, value: int, info) -> int:
        completed = info.data.get("objective_completed_count", 0)
        if completed > value:
            raise ValueError("objective_total_count must be >= objective_completed_count")
        return value


class CampaignFinalizeResponse(BaseModel):
    scenario_id: str
    already_finalized: bool
    campaign_score_delta: int
    score_breakdown: list[CampaignScoreBreakdownItem]
    profile: CampaignProfileResponse
    mastery: CampaignMasteryResponse
    badges: list[CampaignBadgeResponse]
    newly_unlocked_badges: list[CampaignBadgeResponse]
    # Campaign Phase 1: durable challenge/track provenance + dedupe + streak
    campaign_context_source: str | None = None
    challenge_id: str | None = None
    challenge_local_date: str | None = None
    week_key: str | None = None
    weekly_track_id: str | None = None
    difficulty_tier: str | None = None
    weekly_bonus_delta: int = 0
    streak_after: int | None = None
    already_counted_daily_challenge: bool = False


class CampaignlessScenarioSummaryResponse(BaseModel):
    has_campaign: Literal[False] = False


class CampaignScenarioSummaryResponse(BaseModel):
    has_campaign: Literal[True] = True
    scenario_id: str
    profile_id: str
    archive_grade: str
    profile_resonance: str
    betting_hit: bool | None = None
    most_used_card: str | None = None
    completed_daily_challenge: bool
    objective_completed_count: int = 0
    objective_total_count: int = 0
    commitment_outcome: str | None = None
    campaign_score_delta: int
    score_breakdown: list[CampaignScoreBreakdownItem] = Field(default_factory=list)
    finalized_at: str | None = None
    # Campaign Phase 1: durable challenge/track provenance
    challenge_id: str | None = None
    challenge_local_date: str | None = None
    week_key: str | None = None
    weekly_track_id: str | None = None
    difficulty_tier: str | None = None
    weekly_bonus_delta: int = 0
    streak_after: int | None = None
    campaign_context_source: str | None = None


class ScenarioDirectorObjectiveResponse(BaseModel):
    id: str
    kind: Literal["signature_arc_step", "branch_commitment"]
    target_card_id: str | None = None
    reward_label: str | None = None
    created_at: str

    @field_validator("id", "created_at")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Field cannot be empty")
        return normalized

    @field_validator("target_card_id", "reward_label")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class ScenarioDirectorObjectivesResponse(BaseModel):
    generated_for_question: str | None = None
    generated_for_profile: str | None = None
    goals: list[ScenarioDirectorObjectiveResponse] = Field(default_factory=list)
    last_updated_at: str | None = None

    @field_validator("generated_for_question", "generated_for_profile", "last_updated_at")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class ScenarioDirectorCommitmentResponse(BaseModel):
    active: bool = False
    branch_id: str | None = None
    branch_title: str | None = None
    committed_at_round: int | None = None
    committed_at: str | None = None
    outcome: str | None = None

    @field_validator("branch_id", "branch_title", "committed_at")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("outcome")
    @classmethod
    def validate_commitment_outcome(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().lower()
        if normalized not in VALID_COMMITMENT_OUTCOMES:
            raise ValueError(
                f"outcome must be one of {sorted(VALID_COMMITMENT_OUTCOMES)}"
            )
        return normalized

    @field_validator("committed_at_round")
    @classmethod
    def validate_committed_at_round(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("committed_at_round must be >= 0")
        return value

    @model_validator(mode="after")
    def validate_active_commitment(self) -> "ScenarioDirectorCommitmentResponse":
        if not self.active:
            self.branch_id = None
            self.branch_title = None
            self.committed_at_round = None
            self.committed_at = None
            self.outcome = None
            return self

        if not self.branch_id or not self.branch_title:
            raise ValueError("active commitment requires branch_id and branch_title")
        return self


class ScenarioDirectorStateRequest(BaseModel):
    revision: int = 0
    objectives: ScenarioDirectorObjectivesResponse = Field(
        default_factory=ScenarioDirectorObjectivesResponse
    )
    commitment: ScenarioDirectorCommitmentResponse = Field(
        default_factory=ScenarioDirectorCommitmentResponse
    )

    @field_validator("revision")
    @classmethod
    def validate_revision(cls, value: int) -> int:
        if value < 0:
            raise ValueError("revision must be >= 0")
        return value


class ScenarioDirectorStateResponse(ScenarioDirectorStateRequest):
    scenario_id: str


class ScenarioGameplayCardUsageResponse(BaseModel):
    card_id: str
    profile_id: str
    branch_id: str
    branch_title: str
    round: int
    cost: int = 0
    directive: str = ""
    used_at: str

    @field_validator("card_id", "profile_id", "branch_id", "branch_title", "used_at")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Field cannot be empty")
        return normalized

    @field_validator("directive")
    @classmethod
    def normalize_directive(cls, value: str) -> str:
        return value.strip()

    @field_validator("round")
    @classmethod
    def validate_round(cls, value: int) -> int:
        if value < 1:
            raise ValueError("round must be >= 1")
        return value

    @field_validator("cost")
    @classmethod
    def validate_cost(cls, value: int) -> int:
        if value < 0:
            raise ValueError("cost must be >= 0")
        return value


class ScenarioGameplayCardsStateResponse(BaseModel):
    usage_log: list[ScenarioGameplayCardUsageResponse] = Field(default_factory=list, max_length=200)


class ScenarioGameplayBetResponse(BaseModel):
    bet_id: str
    kind: str
    target_id: str | None = None
    target_label: str
    confidence: float = 0
    user_name: str | None = None
    placed_at_round: int
    placed_at: str
    resolved: bool = False

    @field_validator("bet_id", "target_label", "placed_at")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Field cannot be empty")
        return normalized

    @field_validator("kind")
    @classmethod
    def validate_kind(cls, value: str) -> str:
        normalized = value.strip()
        if normalized not in VALID_GAMEPLAY_BET_KINDS:
            raise ValueError(f"kind must be one of {sorted(VALID_GAMEPLAY_BET_KINDS)}")
        return normalized

    @field_validator("target_id", "user_name")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, value: float) -> float:
        if value < 0 or value > 1:
            raise ValueError("confidence must be between 0 and 1")
        return value

    @field_validator("placed_at_round")
    @classmethod
    def validate_placed_at_round(cls, value: int) -> int:
        if value < 1:
            raise ValueError("placed_at_round must be >= 1")
        return value


class ScenarioGameplayBettingStateResponse(BaseModel):
    bets: list[ScenarioGameplayBetResponse] = Field(default_factory=list, max_length=100)


class ScenarioGameplayArchiveBranchSnapshotResponse(BaseModel):
    branch_id: str
    title: str
    probability: float = 0

    @field_validator("branch_id", "title")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Field cannot be empty")
        return normalized

    @field_validator("probability")
    @classmethod
    def validate_probability(cls, value: float) -> float:
        if value < 0:
            raise ValueError("probability must be >= 0")
        return value


class ScenarioGameplayArchiveStateResponse(BaseModel):
    key_moments: list[str] = Field(default_factory=list, max_length=100)
    branch_snapshots: list[ScenarioGameplayArchiveBranchSnapshotResponse] = Field(default_factory=list, max_length=50)  # noqa: E501

    @field_validator("key_moments")
    @classmethod
    def normalize_key_moments(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for moment in value:
            trimmed = moment.strip()
            if not trimmed or trimmed in seen:
                continue
            seen.add(trimmed)
            normalized.append(trimmed)
        return normalized


class ScenarioGameplayStateRequest(BaseModel):
    revision: int = 0
    cards: ScenarioGameplayCardsStateResponse = Field(default_factory=ScenarioGameplayCardsStateResponse)  # noqa: E501
    betting: ScenarioGameplayBettingStateResponse = Field(default_factory=ScenarioGameplayBettingStateResponse)  # noqa: E501
    archive: ScenarioGameplayArchiveStateResponse = Field(default_factory=ScenarioGameplayArchiveStateResponse)  # noqa: E501

    @field_validator("revision")
    @classmethod
    def validate_revision(cls, value: int) -> int:
        if value < 0:
            raise ValueError("revision must be >= 0")
        return value


class ScenarioGameplayStateResponse(ScenarioGameplayStateRequest):
    scenario_id: str


@router.get("/profile/{user_id}", response_model=CampaignProfileResponse)
async def get_profile(
    user_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> CampaignProfileResponse:
    user_id = resolve_authenticated_user_id(user_id, principal) or user_id
    profile = get_campaign_profile_summary(user_id)
    return CampaignProfileResponse(**profile)


@router.get("/profile/{user_id}/mastery", response_model=list[CampaignMasteryResponse])
async def get_mastery(
    user_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> list[CampaignMasteryResponse]:
    user_id = resolve_authenticated_user_id(user_id, principal) or user_id
    masteries = list_campaign_mastery_summaries(user_id)
    return [CampaignMasteryResponse(**mastery) for mastery in masteries]


@router.get("/profile/{user_id}/badges", response_model=list[CampaignBadgeResponse])
async def get_badges(
    user_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> list[CampaignBadgeResponse]:
    user_id = resolve_authenticated_user_id(user_id, principal) or user_id
    badges = list_campaign_badge_summaries(user_id)
    return [CampaignBadgeResponse(**badge) for badge in badges]


@router.get(
    "/badge-definitions",
    response_model=list[CampaignBadgeDefinitionResponse],
)
async def get_badge_definitions() -> list[CampaignBadgeDefinitionResponse]:
    """Phase 3: return the static badge registry, without user progress."""
    from app.services.badge_registry import get_all_badge_definitions

    return [
        CampaignBadgeDefinitionResponse(
            id=badge.id,
            name_key=badge.name_key,
            description_key=badge.description_key,
            category=badge.category,
            one_time=badge.one_time,
        )
        for badge in get_all_badge_definitions()
    ]


@router.get(
    "/profile/{user_id}/unlocks",
    response_model=list[CampaignBadgeResponse],
)
async def get_user_unlocks(
    user_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> list[CampaignBadgeResponse]:
    """Phase 3 alias of /badges that explicitly conveys 'badge unlocks for X'.

    Kept as a separate route so future per-unlock metadata (notification read
    flag, surfaced_at, etc.) can extend this endpoint without disturbing the
    legacy /badges contract.
    """
    user_id = resolve_authenticated_user_id(user_id, principal) or user_id
    badges = list_campaign_badge_summaries(user_id)
    return [CampaignBadgeResponse(**badge) for badge in badges]


@router.get(
    "/scenario/{scenario_id}/summary",
    response_model=CampaignScenarioSummaryResponse | CampaignlessScenarioSummaryResponse,
)
async def get_scenario_summary(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> CampaignScenarioSummaryResponse | CampaignlessScenarioSummaryResponse:
    _require_owned_campaign_scenario(scenario_id, principal)
    try:
        summary = get_scenario_campaign_summary(scenario_id)
    except CampaignNotFoundError as exc:
        if _campaign_scenario_exists(scenario_id):
            return CampaignlessScenarioSummaryResponse()
        raise api_error_from_exception(404, "CAMPAIGN_SCENARIO_SUMMARY_NOT_FOUND", exc) from exc

    return CampaignScenarioSummaryResponse(**summary)


@router.get(
    "/scenario/{scenario_id}/director-state",
    response_model=ScenarioDirectorStateResponse,
)
async def get_director_state(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ScenarioDirectorStateResponse:
    _require_owned_campaign_scenario(scenario_id, principal)
    try:
        state = get_scenario_director_state(scenario_id)
    except CampaignNotFoundError as exc:
        raise api_error_from_exception(404, "DIRECTOR_STATE_NOT_FOUND", exc) from exc

    return ScenarioDirectorStateResponse(scenario_id=scenario_id, **state)


@router.put(
    "/scenario/{scenario_id}/director-state",
    response_model=ScenarioDirectorStateResponse,
)
async def put_director_state(
    scenario_id: str,
    req: ScenarioDirectorStateRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ScenarioDirectorStateResponse:
    _require_owned_campaign_scenario(scenario_id, principal)
    try:
        state = save_scenario_director_state(scenario_id, req.model_dump())
    except CampaignNotFoundError as exc:
        raise api_error_from_exception(404, "DIRECTOR_STATE_NOT_FOUND", exc) from exc
    except CampaignStateError as exc:
        raise api_error_from_exception(409, "DIRECTOR_STATE_CLOSED", exc) from exc
    except CampaignConflictError as exc:
        raise api_error_from_exception(409, "DIRECTOR_STATE_CONFLICT", exc) from exc
    except CampaignError as exc:
        raise api_error_from_exception(400, "DIRECTOR_STATE_INVALID", exc) from exc

    return ScenarioDirectorStateResponse(scenario_id=scenario_id, **state)


@router.get(
    "/scenario/{scenario_id}/gameplay-state",
    response_model=ScenarioGameplayStateResponse,
)
async def get_gameplay_state(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ScenarioGameplayStateResponse:
    _require_owned_campaign_scenario(scenario_id, principal)
    try:
        state = get_scenario_gameplay_state(scenario_id)
    except CampaignNotFoundError as exc:
        raise api_error_from_exception(404, "GAMEPLAY_STATE_NOT_FOUND", exc) from exc

    return ScenarioGameplayStateResponse(scenario_id=scenario_id, **state)


@router.put(
    "/scenario/{scenario_id}/gameplay-state",
    response_model=ScenarioGameplayStateResponse,
)
async def put_gameplay_state(
    scenario_id: str,
    req: ScenarioGameplayStateRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> ScenarioGameplayStateResponse:
    _require_owned_campaign_scenario(scenario_id, principal)
    try:
        state = save_scenario_gameplay_state(scenario_id, req.model_dump())
    except CampaignNotFoundError as exc:
        raise api_error_from_exception(404, "GAMEPLAY_STATE_NOT_FOUND", exc) from exc
    except CampaignStateError as exc:
        raise api_error_from_exception(409, "GAMEPLAY_STATE_CLOSED", exc) from exc
    except CampaignConflictError as exc:
        raise api_error_from_exception(409, "GAMEPLAY_STATE_CONFLICT", exc) from exc
    except CampaignBetValidationError as exc:
        raise api_error_from_exception(422, exc.code, exc) from exc
    except CampaignError as exc:
        raise api_error_from_exception(400, "GAMEPLAY_STATE_INVALID", exc) from exc

    return ScenarioGameplayStateResponse(scenario_id=scenario_id, **state)


@router.get(
    "/challenges/rotation",
    response_model=CampaignChallengeRotationResponse,
)
async def get_challenge_rotation_endpoint(
    local_date: str,
    weekly_count: int = 3,
) -> CampaignChallengeRotationResponse:
    try:
        rotation = get_challenge_rotation(local_date, weekly_count=weekly_count)
    except ValueError as exc:
        raise api_error_from_exception(400, "CHALLENGE_ROTATION_INVALID", exc) from exc

    return CampaignChallengeRotationResponse(**rotation)


@router.get(
    "/profile/{user_id}/daily-status",
    response_model=CampaignDailyChallengeResponse,
)
async def get_daily_status(
    user_id: str,
    profile_id: str,
    local_date: str,
    timezone_offset_minutes: int = 0,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> CampaignDailyChallengeResponse:
    user_id = resolve_authenticated_user_id(user_id, principal) or user_id
    try:
        summary = get_daily_challenge_summary(
            user_id,
            profile_id=profile_id,
            local_date=local_date,
            timezone_offset_minutes=timezone_offset_minutes,
        )
    except CampaignError as exc:
        raise api_error_from_exception(400, "DAILY_STATUS_INVALID", exc) from exc

    return CampaignDailyChallengeResponse(**summary)


@router.get(
    "/profile/{user_id}/weekly-summary",
    response_model=CampaignWeeklySummaryResponse,
)
async def get_weekly_summary(
    user_id: str,
    local_date: str,
    timezone_offset_minutes: int = 0,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> CampaignWeeklySummaryResponse:
    user_id = resolve_authenticated_user_id(user_id, principal) or user_id
    try:
        summary = get_weekly_campaign_summary(
            user_id,
            local_date=local_date,
            timezone_offset_minutes=timezone_offset_minutes,
        )
    except CampaignError as exc:
        raise api_error_from_exception(400, "WEEKLY_SUMMARY_INVALID", exc) from exc

    return CampaignWeeklySummaryResponse(**summary)


@router.post(
    "/scenario/{scenario_id}/finalize",
    response_model=CampaignFinalizeResponse,
)
async def finalize_campaign(
    scenario_id: str,
    req: CampaignFinalizeRequest,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> CampaignFinalizeResponse:
    _require_owned_campaign_scenario(scenario_id, principal)
    user_id = resolve_authenticated_user_id(req.user_id, principal) or req.user_id
    try:
        result = finalize_scenario_campaign(
            scenario_id,
            user_id=user_id,
            user_name=req.user_name,
            profile_id=req.profile_id,
            archive_grade=req.archive_grade,
            profile_resonance=req.profile_resonance,
            betting_hit=req.betting_hit,
            bet_count=req.bet_count,
            most_used_card=req.most_used_card,
            completed_daily_challenge=req.completed_daily_challenge,
            objective_completed_count=req.objective_completed_count,
            objective_total_count=req.objective_total_count,
            commitment_outcome=req.commitment_outcome,
        )
    except CampaignNotFoundError as exc:
        raise api_error_from_exception(404, "CAMPAIGN_FINALIZE_NOT_FOUND", exc) from exc
    except CampaignStateError as exc:
        raise api_error_from_exception(400, "CAMPAIGN_FINALIZE_STATE_INVALID", exc) from exc
    except CampaignConflictError as exc:
        raise api_error_from_exception(409, "CAMPAIGN_FINALIZE_CONFLICT", exc) from exc
    except CampaignError as exc:
        raise api_error_from_exception(400, "CAMPAIGN_FINALIZE_INVALID", exc) from exc

    return CampaignFinalizeResponse(**result)


# ── Phase 4: intervention effect receipts ──────────────────


class InterventionEffectAffectedAgent(BaseModel):
    agent_id: str
    display_name: str


class InterventionEffectExcerpt(BaseModel):
    agent_id: str
    excerpt: str


class InterventionEffectResponse(BaseModel):
    intervention_log_id: str
    card_id: str | None = None
    card_label: str | None = None
    round_number: int
    affected_agents: list[InterventionEffectAffectedAgent] = Field(default_factory=list)
    response_excerpts: list[InterventionEffectExcerpt] = Field(default_factory=list)
    confidence: float = 0.0
    no_response_detected: bool = False
    created_at: str


class InterventionEffectsResponse(BaseModel):
    effects: list[InterventionEffectResponse] = Field(default_factory=list)


def _card_label_lookup() -> dict[str, dict[str, str]]:
    """Map gameplay card id → localized labels for the receipt response.

    Cached at module import in `_CARD_LABELS` below; we recompute lazily so
    contract reloads in tests pick up changes.
    """

    try:
        contract = load_gameplay_contract()
    except Exception:  # pragma: no cover - contract is bundled
        logger.debug("intervention effects: gameplay contract load failed", exc_info=True)
        return {}
    mapping: dict[str, dict[str, str]] = {}
    for card in contract.get("cards", []) or []:
        if not isinstance(card, dict):
            continue
        card_id = card.get("id")
        if not card_id:
            continue
        labels = card.get("labels", {})
        if not isinstance(labels, dict):
            labels = {}
        mapping[str(card_id)] = {
            "zh": str(labels.get("zh") or labels.get("en") or card_id),
            "en": str(labels.get("en") or labels.get("zh") or card_id),
        }
    return mapping


def _resolve_card_label(card_id: str | None) -> str | None:
    if not card_id:
        return None
    entry = _card_label_lookup().get(str(card_id))
    if not entry:
        return None
    # Prefer Chinese label by default; callers localize as needed.
    return entry.get("zh") or entry.get("en")


def _decode_effect_summary(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _coerce_str_list(value: object) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, str]] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        agent_id = str(entry.get("agent_id") or "").strip()
        if not agent_id:
            continue
        out.append(
            {
                "agent_id": agent_id,
                "display_name": str(entry.get("display_name") or "").strip() or agent_id,
                "excerpt": str(entry.get("excerpt") or ""),
            }
        )
    return out


@scenario_intervention_effects_router.get(
    "/scenario/{scenario_id}/intervention-effects",
    response_model=InterventionEffectsResponse,
)
async def get_intervention_effects(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> InterventionEffectsResponse:
    """Return persisted intervention effect receipts for the scenario, newest first.

    Read-only / replay path: this endpoint inspects already-persisted
    `InterventionLog.effect_summary_json` rows. It never enqueues new
    interventions and never mutates state.
    """

    engine = get_engine()
    effects: list[InterventionEffectResponse] = []
    try:
        with Session(engine) as session:
            # Ownership guard — raises 404 when principal doesn't own scenario.
            require_owned_scenario(session, scenario_id, principal)
            rows = session.exec(
                select(InterventionLog)
                .where(InterventionLog.scenario_id == scenario_id)
                .order_by(InterventionLog.created_at.desc())
            ).all()
    except SQLAlchemyError:
        logger.debug("intervention effects: DB read failed", exc_info=True)
        return InterventionEffectsResponse(effects=[])

    for row in rows:
        summary = _decode_effect_summary(row.effect_summary_json)
        if summary is None:
            # Older scenarios have no receipt — skip rather than fabricate.
            continue
        card_id = summary.get("card_id")
        card_id_str = str(card_id) if card_id else None
        affected_raw = _coerce_str_list(summary.get("affected_agents"))
        excerpt_raw = _coerce_str_list(summary.get("response_excerpts"))
        try:
            confidence_value = float(summary.get("confidence", 0.0) or 0.0)
        except (TypeError, ValueError):
            confidence_value = 0.0
        try:
            round_number_value = int(summary.get("round_number", row.round_number) or 0)
        except (TypeError, ValueError):
            round_number_value = int(row.round_number or 0)
        effects.append(
            InterventionEffectResponse(
                intervention_log_id=str(row.id),
                card_id=card_id_str,
                card_label=_resolve_card_label(card_id_str),
                round_number=round_number_value,
                affected_agents=[
                    InterventionEffectAffectedAgent(
                        agent_id=entry["agent_id"],
                        display_name=entry["display_name"],
                    )
                    for entry in affected_raw
                ],
                response_excerpts=[
                    InterventionEffectExcerpt(
                        agent_id=entry["agent_id"],
                        excerpt=entry["excerpt"],
                    )
                    for entry in excerpt_raw
                ],
                confidence=max(0.0, min(1.0, confidence_value)),
                no_response_detected=bool(summary.get("no_response_detected", False)),
                created_at=row.created_at.isoformat() if row.created_at else "",
            )
        )

    return InterventionEffectsResponse(effects=effects)
