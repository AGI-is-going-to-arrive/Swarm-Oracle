"""Pydantic contracts for ``Scenario.parsed_context.full_report``."""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LanguageCode = Literal["zh", "en"]
GenerationMode = Literal["generation", "rewrite", "static"]
ReportStatus = Literal["generating", "complete", "partial", "failed", "skipped"]
ReportTier = Literal["generation", "rewrite", "static"]
ConfidenceLevel = Literal["high", "medium", "low"]
EvidenceKind = Literal["utterance", "causal_fact", "faction_event", "interview"]
IndicatorDirection = Literal["up", "down"]
ChartStatus = Literal["available", "partial", "missing"]
KnownChartType = Literal["probability_bar", "faction_share"]
KNOWN_CHART_TYPES: tuple[KnownChartType, ...] = ("probability_bar", "faction_share")
LanguageAvailability = Literal["available", "missing"]
ResultReportSSEName = Literal[
    "report_started",
    "report_section_delta",
    "report_section_complete",
    "report_failed",
    "report_complete",
]
ResultReportSSEStatus = Literal[
    "pending",
    "generating",
    "complete",
    "partial",
    "failed",
    "skipped",
]

_TARGET_BRANCH_SORT = ["probability_desc", "fork_round_asc", "id_asc"]
_SENSITIVE_KEYS = frozenset(
    {
        "apikey",
        "llmapikey",
        "websearchapikey",
        "xapikey",
        "accesskey",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "authorization",
        "authorizationheader",
        "bearer",
        "token",
        "secret",
        "sessionsecret",
        "password",
        "passwd",
        "baseurl",
        "llmbaseurl",
        "websearchbaseurl",
    }
)
_SENSITIVE_KEY_SUFFIXES = (
    "apikey",
    "accesskey",
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "bearer",
    "baseurl",
)
_SENSITIVE_KEY_PREFIXES = ("authorization", "bearer")
_SENSITIVE_VALUE_RE = re.compile(
    r"(authorization\s*:\s*)?bearer\s+\S+|api[_-]?key\s*[:=]|"
    r"\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,})\b|"
    r"\bhttps?://[^/?#\s@]+@[^/?#\s]+",
    re.IGNORECASE,
)


class ResultReportTooLargeError(ValueError):
    """Raised when a full report exceeds the configured UTF-8 byte cap."""


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class I18nText(_StrictModel):
    zh: str
    en: str


class LanguageStatus(_StrictModel):
    zh: LanguageAvailability
    en: LanguageAvailability


class Likelihood(_StrictModel):
    probability: float = Field(ge=0.0, le=1.0)
    interval: tuple[float, float]
    wep: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_interval(self) -> "Likelihood":
        low, high = self.interval
        if low < 0.0 or high > 1.0 or low > high:
            raise ValueError("likelihood.interval must be ordered within 0..1")
        return self


class AnalyticConfidence(_StrictModel):
    level: ConfidenceLevel
    basis: str = Field(min_length=1)
    basis_i18n: I18nText | None = None


class Verdict(_StrictModel):
    headline_answer: str = Field(min_length=1)
    likelihood: Likelihood
    analytic_confidence: AnalyticConfidence
    disclaimer: str | None = None


class ProbabilityBarBranch(_StrictModel):
    branch_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    probability: float = Field(ge=0.0, le=1.0)
    dominant: bool
    status: str = Field(min_length=1)


class ProbabilityBarData(_StrictModel):
    status: ChartStatus
    reason: str | None = None
    sort: list[str] = Field(default_factory=list)
    branches: list[ProbabilityBarBranch] = Field(default_factory=list)


class FactionShareItem(_StrictModel):
    faction_key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    member_count: int = Field(ge=0)
    share: float = Field(ge=0.0, le=1.0)
    stance_center: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)


class FactionShareData(_StrictModel):
    status: ChartStatus
    reason: str | None = None
    factions: list[FactionShareItem] = Field(default_factory=list)
    relation_edge_count: int = Field(default=0, ge=0)
    avg_opposition: float | None = Field(default=None, ge=0.0, le=1.0)


class Chart(_StrictModel):
    kind: str = Field(
        min_length=1,
        description="Legacy chart discriminator. Mirrors type for compatibility.",
    )
    type: str = Field(
        min_length=1,
        description=(
            "Stable chart discriminator. Known values are probability_bar and "
            "faction_share; unrecognized values are passed through for frontend fallback."
        ),
    )
    data: dict[str, Any]

    @model_validator(mode="before")
    @classmethod
    def normalize_discriminator(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        chart_kind = str(normalized.get("kind") or "").strip()
        chart_type = str(normalized.get("type") or chart_kind).strip()
        if not chart_kind and chart_type:
            normalized["kind"] = chart_type
        if chart_type:
            normalized["type"] = chart_type
        return normalized

    @model_validator(mode="after")
    def validate_known_chart_data(self) -> "Chart":
        if self.kind != self.type:
            raise ValueError("chart kind and type must match")
        model = _CHART_DATA_MODELS.get(self.type)
        if model is None:
            return self
        normalized = _normalize_legacy_chart_data(self.type, self.data)
        self.data = model.model_validate(normalized).model_dump(mode="json")
        return self


_CHART_DATA_MODELS: dict[str, type[BaseModel]] = {
    "probability_bar": ProbabilityBarData,
    "faction_share": FactionShareData,
}


def _normalize_legacy_chart_data(chart_type: str, data: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(data)
    if chart_type == "probability_bar":
        if "branches" not in normalized and "branch_id" in normalized:
            branch_id = str(normalized.get("branch_id") or "").strip()
            normalized = {
                "status": normalized.get("status") or "available",
                "sort": normalized.get("sort") or [],
                "branches": [
                    {
                        "branch_id": branch_id,
                        "label": str(normalized.get("label") or branch_id).strip(),
                        "probability": normalized.get("probability", 0.0),
                        "dominant": normalized.get("dominant", True),
                        "status": str(normalized.get("status") or "unknown").strip(),
                    }
                ],
            }
        normalized.setdefault("sort", [])
        normalized.setdefault("branches", [])
        return normalized
    if chart_type == "faction_share":
        normalized.setdefault("factions", [])
        normalized.setdefault("relation_edge_count", 0)
        normalized.setdefault("avg_opposition", None)
    return normalized


class ReportSection(_StrictModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    title_i18n: I18nText
    intent: str = Field(min_length=1)
    body_md_i18n: I18nText
    evidence_refs: list[str] = Field(default_factory=list)
    charts: list[Chart] = Field(default_factory=list)


class EvidenceRef(_StrictModel):
    id: str = Field(min_length=1)
    branch_id: str = Field(min_length=1)
    round_id: str = Field(min_length=1)
    round_number: int = Field(ge=0)
    agent_id: str = Field(min_length=1)
    agent_name: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    quote: str = Field(min_length=1)
    kind: EvidenceKind


class IndicatorToWatch(_StrictModel):
    signal: str = Field(min_length=1)
    direction: IndicatorDirection
    note: str = Field(min_length=1)
    threshold: str = ""
    observation: str = ""
    time_horizon: str = ""
    rationale: str = ""
    evidence_refs: list[str] = Field(default_factory=list)


class DissentingView(_StrictModel):
    runner_up_branch_id: str = Field(min_length=1)
    why_verdict_could_be_wrong: str = Field(min_length=1)
    what_almost_won: str = Field(min_length=1)


class KeyParticipant(_StrictModel):
    agent_name: str = Field(min_length=1)
    impact_score: float = Field(ge=0.0, le=1.0)
    key_moment_hits: int = Field(ge=0)


class FullReport(_StrictModel):
    version: str = Field(min_length=1)
    generated_at: str = Field(min_length=1)
    generation_mode: GenerationMode
    target_branch_id: str = Field(min_length=1)
    target_branch_sort: list[str]
    language: LanguageCode
    available_languages: list[LanguageCode]
    title: str = Field(min_length=1)
    title_i18n: I18nText
    summary: str = Field(min_length=1)
    summary_i18n: I18nText
    status: ReportStatus
    tier: ReportTier
    verdict: Verdict
    sections: list[ReportSection] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    indicators_to_watch: list[IndicatorToWatch] = Field(default_factory=list)
    dissenting: DissentingView | None = None
    key_participants: list[KeyParticipant] = Field(default_factory=list)
    follow_ups: list[str] = Field(default_factory=list)
    limitations: str = Field(min_length=1)
    interview_evidence: list[dict[str, Any]] = Field(default_factory=list)
    premortem: list[dict[str, Any]] = Field(default_factory=list)
    language_status: LanguageStatus | None = None

    @model_validator(mode="after")
    def validate_report_contract(self) -> "FullReport":
        if self.target_branch_sort != _TARGET_BRANCH_SORT:
            raise ValueError("target_branch_sort must match the frozen /story order")
        if not self.available_languages:
            raise ValueError("available_languages cannot be empty")
        if len(set(self.available_languages)) != len(self.available_languages):
            raise ValueError("available_languages cannot contain duplicates")
        evidence_ids = {item.id for item in self.evidence}
        for section in self.sections:
            unknown_refs = [
                evidence_id
                for evidence_id in section.evidence_refs
                if evidence_id not in evidence_ids
            ]
            if unknown_refs:
                raise ValueError("section evidence_refs must reference report evidence ids")
        for indicator in self.indicators_to_watch:
            unknown_refs = [
                evidence_id
                for evidence_id in indicator.evidence_refs
                if evidence_id not in evidence_ids
            ]
            if unknown_refs:
                raise ValueError("indicator evidence_refs must reference report evidence ids")
        _assert_no_sensitive_material(self.model_dump(mode="json"))
        return self


class ToolTraceSummary(_StrictModel):
    tool: str = Field(min_length=1)
    query: str = ""
    item_count: int = Field(default=0, ge=0)
    elapsed_ms: int = Field(default=0, ge=0)


class ResultReportSSEData(_StrictModel):
    report_id: str | None = None
    section_id: str | None = None
    status: ResultReportSSEStatus
    message: str | None = None
    tool_trace: list[ToolTraceSummary] = Field(default_factory=list)
    error_code: str | None = None


class ResultReportSSEEvent(_StrictModel):
    event: ResultReportSSEName
    data: ResultReportSSEData

    @model_validator(mode="after")
    def validate_no_sensitive_material(self) -> "ResultReportSSEEvent":
        _assert_no_sensitive_material(self.model_dump(mode="json"))
        return self


def utf8_json_size_bytes(payload: Any) -> int:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return len(encoded.encode("utf-8"))


def validate_full_report_payload(
    payload: dict[str, Any],
    *,
    max_bytes: int | None = None,
) -> FullReport:
    """Validate one persisted ``full_report`` payload against the frozen IR."""

    if max_bytes is None:
        from app.config import settings

        max_bytes = settings.REPORT_FULL_REPORT_MAX_BYTES
    _assert_no_sensitive_material(payload)
    report = FullReport.model_validate(payload)
    response_payload = report.model_dump(mode="json")
    if utf8_json_size_bytes(response_payload) > max_bytes:
        raise ResultReportTooLargeError(
            f"full_report exceeds byte budget ({max_bytes} bytes)",
        )
    return report


def full_report_for_story(payload: object, *, max_bytes: int | None = None) -> dict | None:
    """Return a safe story payload or a bounded partial marker."""

    if not isinstance(payload, dict):
        return None
    try:
        return validate_full_report_payload(payload, max_bytes=max_bytes).model_dump(
            mode="json",
        )
    except ResultReportTooLargeError:
        return {"status": "partial", "truncated": True}
    except ValueError:
        return None


def encode_sse_event(event: ResultReportSSEEvent) -> str:
    data = event.data.model_dump(mode="json", exclude_none=True)
    return f"event: {event.event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _assert_no_sensitive_material(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            key_text = str(key)
            if _is_sensitive_key(key):
                raise ValueError(f"sensitive key is not allowed at {path}.{key_text}")
            _assert_no_sensitive_material(nested, f"{path}.{key_text}")
        return
    if isinstance(value, list):
        for index, nested in enumerate(value):
            _assert_no_sensitive_material(nested, f"{path}[{index}]")
        return
    if isinstance(value, str) and _SENSITIVE_VALUE_RE.search(value):
        raise ValueError(f"sensitive value is not allowed at {path}")


def _is_sensitive_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    normalized = key.strip().lower().replace("-", "").replace("_", "")
    if normalized in _SENSITIVE_KEYS:
        return True
    if normalized.endswith(_SENSITIVE_KEY_SUFFIXES):
        return True
    return normalized.startswith(_SENSITIVE_KEY_PREFIXES)
