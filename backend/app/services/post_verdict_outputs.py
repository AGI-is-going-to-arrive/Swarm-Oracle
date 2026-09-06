"""Bounded display-only saved analyses shared by API and snapshot archival paths."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.api.errors import api_error
from app.log_sanitize import _scrub_sensitive_text, contains_credential_material

_SAVED_OUTPUTS_KEY = "_post_verdict_outputs"
_MAX_SAVED_OUTPUTS = 20
_MAX_SAVED_OUTPUT_BYTES = 64 * 1024


class RoundtableProviderSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal[
        "room_profile", "scenario_profile", "role_override",
        "explicit", "scenario", "server_default",
    ]
    profile_id: str | None = Field(default=None, max_length=128)
    name: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=200)


class SavedSurveyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    participant_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=200)
    role: str = Field(max_length=200)
    source_agent_id: str | None = Field(default=None, max_length=128)
    source_branch_id: str | None = Field(default=None, max_length=128)
    agent_identity_id: str | None = Field(default=None, max_length=128)
    answer: str = Field(min_length=1, max_length=24000)
    elapsed_ms: int = Field(default=0, ge=0, le=86400000)


class SavePostVerdictOutputRequest(BaseModel):
    """A user-saved analysis, never an authoritative simulation evidence record."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    client_result_id: UUID
    kind: Literal["analyst", "survey"]
    room_id: str | None = Field(default=None, max_length=128)
    question: str = Field(min_length=1, max_length=2000)
    provider: RoundtableProviderSelection | None = None
    answer: str | None = Field(default=None, min_length=1, max_length=48000)
    stopped_reason: Literal["final_response"] | None = None
    participant_ids: list[str] = Field(default_factory=list, max_length=6)
    responses: list[SavedSurveyResponse] = Field(default_factory=list, max_length=6)

    @model_validator(mode="after")
    def validate_completed_output(self) -> SavePostVerdictOutputRequest:
        if self.kind == "analyst":
            if not self.answer or self.stopped_reason != "final_response" or self.responses or self.participant_ids:  # noqa: E501
                raise ValueError("Only a completed analyst answer can be saved")
        else:
            response_ids = [item.participant_id for item in self.responses]
            if (
                self.answer is not None or self.stopped_reason is not None
                or not response_ids
                or len(set(response_ids)) != len(response_ids)
                or len(set(self.participant_ids)) != len(self.participant_ids)
                or set(response_ids) != set(self.participant_ids)
            ):
                raise ValueError("Only a complete successful survey can be saved")
        return self


def _sanitize_saved_output(value: Any) -> Any:
    if isinstance(value, str):
        cleaned = _scrub_sensitive_text(value)
        if contains_credential_material(cleaned):
            raise api_error(
                422, "SAVED_OUTPUT_SENSITIVE_CONTENT", "Remove credentials before saving",
            )
        return cleaned
    if isinstance(value, list):
        return [_sanitize_saved_output(item) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_saved_output(item) for key, item in value.items()}
    return value


def _saved_outputs_from_context(context: dict[str, Any]) -> list[dict[str, Any]]:
    raw = context.get(_SAVED_OUTPUTS_KEY)
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > _MAX_SAVED_OUTPUTS:
        raise api_error(422, "SAVED_OUTPUT_INVALID", "Saved analysis archive has an invalid shape")
    # These records are display-only. Their profile/identity ids never enter
    # provider resolution, actions, claims, or memory hydration.
    return [_validate_saved_output_record(item) for item in raw]


def _validate_saved_output_record(value: Any) -> dict[str, Any]:
    """Validate and scrub display-only records on every archival read."""
    try:
        if not isinstance(value, dict):
            raise ValueError("record must be an object")
        if (
            value.get("version") != 1 or value.get("origin") != "simulation"
            or value.get("verification") != "user_saved"
        ):
            raise ValueError("unsupported record version or origin")
        payload_fields = set(SavePostVerdictOutputRequest.model_fields) - {"client_result_id"}
        envelope_fields = {
            "id", "version", "created_at", "origin", "verification", "archived", "content_digest",
        }
        if set(value) - payload_fields - envelope_fields:
            raise ValueError("record contains unknown fields")
        if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > _MAX_SAVED_OUTPUT_BYTES:  # noqa: E501
            raise ValueError("record is too large")
        request = SavePostVerdictOutputRequest.model_validate({
            **{key: item for key, item in value.items() if key in payload_fields},
            "client_result_id": value.get("id"),
        })
        created_at = value.get("created_at")
        if not isinstance(created_at, str) or len(created_at) > 64:
            raise ValueError("invalid creation time")
        datetime.fromisoformat(created_at)
        if "archived" in value and not isinstance(value["archived"], bool):
            raise ValueError("invalid archive marker")
        if value.get("archived") and (
            request.room_id is not None
            or (request.provider is not None and request.provider.profile_id is not None)
            or any(
                item.source_agent_id or item.source_branch_id or item.agent_identity_id
                for item in request.responses
            )
        ):
            raise ValueError("archived notes cannot retain active source links")
        digest = value.get("content_digest")
        if digest is not None and (
            not isinstance(digest, str) or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise ValueError("invalid content digest")
        result = _sanitize_saved_output({
            **request.model_dump(mode="json", exclude={"client_result_id"}),
            **{key: item for key, item in value.items() if key in envelope_fields},
        })
        if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > _MAX_SAVED_OUTPUT_BYTES:  # noqa: E501
            raise ValueError("record is too large")
        return result
    except (ValueError, TypeError) as exc:
        raise api_error(422, "SAVED_OUTPUT_INVALID", "Saved analysis archive has an invalid record") from exc  # noqa: E501
