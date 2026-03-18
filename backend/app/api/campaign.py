"""Campaign API for Track A / Phase A1."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from app.services.campaign import (
    CampaignConflictError,
    CampaignError,
    CampaignNotFoundError,
    CampaignStateError,
    finalize_scenario_campaign,
    get_daily_challenge_summary,
    get_campaign_profile_summary,
    get_scenario_gameplay_state,
    get_scenario_director_state,
    get_scenario_campaign_summary,
    list_campaign_badge_summaries,
    list_campaign_mastery_summaries,
    save_scenario_gameplay_state,
    save_scenario_director_state,
)

router = APIRouter(prefix="/api/campaign", tags=["campaign"])

VALID_ARCHIVE_GRADES = {"S", "A", "B", "C"}
VALID_PROFILE_RESONANCES = {"signature", "aligned", "offbeat"}
VALID_COMMITMENT_OUTCOMES = {"hit", "miss", "pending"}


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


class CampaignFinalizeRequest(BaseModel):
    user_id: str
    user_name: str = "匿名导演"
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
        normalized = value.strip()
        return normalized or "匿名导演"

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
    profile: CampaignProfileResponse
    mastery: CampaignMasteryResponse
    badges: list[CampaignBadgeResponse]
    newly_unlocked_badges: list[CampaignBadgeResponse]


class CampaignScenarioSummaryResponse(BaseModel):
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
    finalized_at: str | None = None


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
    objectives: ScenarioDirectorObjectivesResponse = Field(
        default_factory=ScenarioDirectorObjectivesResponse
    )
    commitment: ScenarioDirectorCommitmentResponse = Field(
        default_factory=ScenarioDirectorCommitmentResponse
    )


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
    usage_log: list[ScenarioGameplayCardUsageResponse] = Field(default_factory=list)


class ScenarioGameplayStateRequest(BaseModel):
    cards: ScenarioGameplayCardsStateResponse = Field(default_factory=ScenarioGameplayCardsStateResponse)


class ScenarioGameplayStateResponse(ScenarioGameplayStateRequest):
    scenario_id: str


@router.get("/profile/{user_id}", response_model=CampaignProfileResponse)
async def get_profile(user_id: str) -> CampaignProfileResponse:
    profile = get_campaign_profile_summary(user_id)
    return CampaignProfileResponse(**profile)


@router.get("/profile/{user_id}/mastery", response_model=list[CampaignMasteryResponse])
async def get_mastery(user_id: str) -> list[CampaignMasteryResponse]:
    masteries = list_campaign_mastery_summaries(user_id)
    return [CampaignMasteryResponse(**mastery) for mastery in masteries]


@router.get("/profile/{user_id}/badges", response_model=list[CampaignBadgeResponse])
async def get_badges(user_id: str) -> list[CampaignBadgeResponse]:
    badges = list_campaign_badge_summaries(user_id)
    return [CampaignBadgeResponse(**badge) for badge in badges]


@router.get(
    "/scenario/{scenario_id}/summary",
    response_model=CampaignScenarioSummaryResponse,
)
async def get_scenario_summary(scenario_id: str) -> CampaignScenarioSummaryResponse:
    try:
        summary = get_scenario_campaign_summary(scenario_id)
    except CampaignNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    return CampaignScenarioSummaryResponse(**summary)


@router.get(
    "/scenario/{scenario_id}/director-state",
    response_model=ScenarioDirectorStateResponse,
)
async def get_director_state(scenario_id: str) -> ScenarioDirectorStateResponse:
    try:
        state = get_scenario_director_state(scenario_id)
    except CampaignNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    return ScenarioDirectorStateResponse(scenario_id=scenario_id, **state)


@router.put(
    "/scenario/{scenario_id}/director-state",
    response_model=ScenarioDirectorStateResponse,
)
async def put_director_state(
    scenario_id: str,
    req: ScenarioDirectorStateRequest,
) -> ScenarioDirectorStateResponse:
    try:
        state = save_scenario_director_state(scenario_id, req.model_dump())
    except CampaignNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except CampaignError as exc:
        raise HTTPException(400, str(exc)) from exc

    return ScenarioDirectorStateResponse(scenario_id=scenario_id, **state)


@router.get(
    "/scenario/{scenario_id}/gameplay-state",
    response_model=ScenarioGameplayStateResponse,
)
async def get_gameplay_state(scenario_id: str) -> ScenarioGameplayStateResponse:
    try:
        state = get_scenario_gameplay_state(scenario_id)
    except CampaignNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    return ScenarioGameplayStateResponse(scenario_id=scenario_id, **state)


@router.put(
    "/scenario/{scenario_id}/gameplay-state",
    response_model=ScenarioGameplayStateResponse,
)
async def put_gameplay_state(
    scenario_id: str,
    req: ScenarioGameplayStateRequest,
) -> ScenarioGameplayStateResponse:
    try:
        state = save_scenario_gameplay_state(scenario_id, req.model_dump())
    except CampaignNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except CampaignError as exc:
        raise HTTPException(400, str(exc)) from exc

    return ScenarioGameplayStateResponse(scenario_id=scenario_id, **state)


@router.get(
    "/profile/{user_id}/daily-status",
    response_model=CampaignDailyChallengeResponse,
)
async def get_daily_status(
    user_id: str,
    profile_id: str,
    local_date: str,
    timezone_offset_minutes: int = 0,
) -> CampaignDailyChallengeResponse:
    try:
        summary = get_daily_challenge_summary(
            user_id,
            profile_id=profile_id,
            local_date=local_date,
            timezone_offset_minutes=timezone_offset_minutes,
        )
    except CampaignError as exc:
        raise HTTPException(400, str(exc)) from exc

    return CampaignDailyChallengeResponse(**summary)


@router.post(
    "/scenario/{scenario_id}/finalize",
    response_model=CampaignFinalizeResponse,
)
async def finalize_campaign(
    scenario_id: str,
    req: CampaignFinalizeRequest,
) -> CampaignFinalizeResponse:
    try:
        result = finalize_scenario_campaign(
            scenario_id,
            user_id=req.user_id,
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
        raise HTTPException(404, str(exc)) from exc
    except CampaignStateError as exc:
        raise HTTPException(400, str(exc)) from exc
    except CampaignConflictError as exc:
        raise HTTPException(409, str(exc)) from exc
    except CampaignError as exc:
        raise HTTPException(400, str(exc)) from exc

    return CampaignFinalizeResponse(**result)
