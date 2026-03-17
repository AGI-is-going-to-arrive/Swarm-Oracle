"""Campaign API for Track A / Phase A1."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from app.services.campaign import (
    CampaignConflictError,
    CampaignError,
    CampaignNotFoundError,
    CampaignStateError,
    finalize_scenario_campaign,
    get_daily_challenge_summary,
    get_campaign_profile_summary,
    list_campaign_badge_summaries,
    list_campaign_mastery_summaries,
)

router = APIRouter(prefix="/api/campaign", tags=["campaign"])

VALID_ARCHIVE_GRADES = {"S", "A", "B", "C"}
VALID_PROFILE_RESONANCES = {"signature", "aligned", "offbeat"}


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

    @field_validator("most_used_card")
    @classmethod
    def validate_most_used_card(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class CampaignFinalizeResponse(BaseModel):
    scenario_id: str
    already_finalized: bool
    campaign_score_delta: int
    profile: CampaignProfileResponse
    mastery: CampaignMasteryResponse
    badges: list[CampaignBadgeResponse]
    newly_unlocked_badges: list[CampaignBadgeResponse]


@router.get("/profile/{user_id}", response_model=CampaignProfileResponse)
async def get_profile(user_id: str) -> CampaignProfileResponse:
    profile = get_campaign_profile_summary(user_id)
    if profile is None:
        raise HTTPException(404, "Campaign profile not found")
    return CampaignProfileResponse(**profile)


@router.get("/profile/{user_id}/mastery", response_model=list[CampaignMasteryResponse])
async def get_mastery(user_id: str) -> list[CampaignMasteryResponse]:
    masteries = list_campaign_mastery_summaries(user_id)
    if masteries is None:
        raise HTTPException(404, "Campaign profile not found")
    return [CampaignMasteryResponse(**mastery) for mastery in masteries]


@router.get("/profile/{user_id}/badges", response_model=list[CampaignBadgeResponse])
async def get_badges(user_id: str) -> list[CampaignBadgeResponse]:
    badges = list_campaign_badge_summaries(user_id)
    if badges is None:
        raise HTTPException(404, "Campaign profile not found")
    return [CampaignBadgeResponse(**badge) for badge in badges]


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

    if summary is None:
        raise HTTPException(404, "Campaign profile not found")
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
