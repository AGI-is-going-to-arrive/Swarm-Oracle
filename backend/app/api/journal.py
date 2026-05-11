"""Personal prediction journal API."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlmodel import Session, select

from app.api.errors import api_error
from app.api.helpers import (
    SessionPrincipal,
    require_session_principal,
    resolve_authenticated_user_id,
    verify_session,
)
from app.config import settings
from app.models import Scenario
from app.models.database import get_engine
from app.models.prediction_journal import PredictionJournalEntry
from app.services.journal_service import (
    AlreadyResolvedError,
    create_entry,
    get_calibration_data,
    get_user_journal,
    resolve_entry,
)


def require_feature_prediction_journal() -> None:
    if not settings.FEATURE_PREDICTION_JOURNAL:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'prediction_journal' is not enabled",
        )


router = APIRouter(
    prefix="/api/me",
    tags=["journal"],
    dependencies=[
        Depends(require_feature_prediction_journal),
        Depends(verify_session),
    ],
)


class JournalEntryCreateRequest(BaseModel):
    scenario_id: str | None = None
    question: str = Field(min_length=1, max_length=1000)
    predicted_probability: float = Field(ge=0.0, le=1.0)

    @field_validator("scenario_id")
    @classmethod
    def normalize_scenario_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("question")
    @classmethod
    def normalize_question(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("question cannot be empty")
        return cleaned


class JournalEntryResolveRequest(BaseModel):
    actual_outcome: bool


class JournalEntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    scenario_id: str | None
    question: str
    predicted_probability: float
    actual_outcome: bool | None
    resolved_at: datetime | None
    created_at: datetime
    brier_score: float | None


class JournalListResponse(BaseModel):
    items: list[JournalEntryResponse]
    limit: int
    offset: int


class CalibrationBinResponse(BaseModel):
    range: list[float]
    predicted_avg: float | None
    actual_frequency: float | None
    count: int


class CalibrationResponse(BaseModel):
    bins: list[CalibrationBinResponse]


def _entry_to_response(entry: PredictionJournalEntry) -> JournalEntryResponse:
    return JournalEntryResponse.model_validate(entry)


async def get_current_user_id(
    x_user_id: Annotated[str | None, Header(alias="X-User-Id")] = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> str:
    requested_user_id = x_user_id.strip() if isinstance(x_user_id, str) else None
    requested_user_id = requested_user_id or None
    user_id = resolve_authenticated_user_id(requested_user_id, principal)
    if not user_id:
        raise api_error(
            401,
            "USER_ID_REQUIRED",
            "X-User-Id header is required when signed session auth is disabled",
        )
    return user_id


def _validate_owned_scenario(
    session: Session,
    scenario_id: str | None,
    user_id: str,
) -> None:
    if scenario_id is None:
        return
    scenario = session.exec(
        select(Scenario).where(
            Scenario.id == scenario_id,
            Scenario.user_id == user_id,
        )
    ).first()
    if scenario is None:
        raise api_error(404, "SCENARIO_NOT_FOUND", "Scenario not found")


@router.get("/journal", response_model=JournalListResponse)
async def list_journal_entries(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user_id: str = Depends(get_current_user_id),
) -> JournalListResponse:
    with Session(get_engine()) as session:
        items = get_user_journal(session, user_id, limit=limit, offset=offset)
    return JournalListResponse(
        items=[_entry_to_response(item) for item in items],
        limit=limit,
        offset=offset,
    )


@router.post("/journal", response_model=JournalEntryResponse)
async def create_journal_entry(
    body: JournalEntryCreateRequest,
    user_id: str = Depends(get_current_user_id),
) -> JournalEntryResponse:
    with Session(get_engine()) as session:
        _validate_owned_scenario(session, body.scenario_id, user_id)
        try:
            entry = create_entry(
                session,
                user_id=user_id,
                scenario_id=body.scenario_id,
                question=body.question,
                predicted_probability=body.predicted_probability,
            )
        except ValueError as exc:
            raise api_error(422, "JOURNAL_ENTRY_INVALID", str(exc)) from exc
    return _entry_to_response(entry)


@router.patch("/journal/{entry_id}/resolve", response_model=JournalEntryResponse)
async def resolve_journal_entry(
    entry_id: int,
    body: JournalEntryResolveRequest,
    user_id: str = Depends(get_current_user_id),
) -> JournalEntryResponse:
    with Session(get_engine()) as session:
        entry = session.exec(
            select(PredictionJournalEntry).where(
                PredictionJournalEntry.id == entry_id,
                PredictionJournalEntry.user_id == user_id,
            )
        ).first()
        if entry is None:
            raise api_error(404, "JOURNAL_ENTRY_NOT_FOUND", "Journal entry not found")
        try:
            resolved = resolve_entry(session, entry_id, body.actual_outcome)
        except AlreadyResolvedError as exc:
            raise api_error(
                409,
                "JOURNAL_ENTRY_ALREADY_RESOLVED",
                "Journal entry is already resolved",
            ) from exc
        except ValueError as exc:
            raise api_error(404, "JOURNAL_ENTRY_NOT_FOUND", str(exc)) from exc
    return _entry_to_response(resolved)


@router.get("/calibration", response_model=CalibrationResponse)
async def get_journal_calibration(
    user_id: str = Depends(get_current_user_id),
) -> CalibrationResponse:
    with Session(get_engine()) as session:
        payload = get_calibration_data(session, user_id)
    return CalibrationResponse(**payload)
