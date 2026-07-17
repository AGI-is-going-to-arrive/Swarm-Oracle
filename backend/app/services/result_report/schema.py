"""Pydantic contracts for ``Scenario.parsed_context.full_report``."""

from __future__ import annotations

import html
import json
import math
import re
import unicodedata
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LanguageCode = Literal["zh", "en"]
GenerationMode = Literal["generation", "rewrite", "static"]
ReportStatus = Literal[
    "generating",
    "complete",
    "partial",
    "failed",
    "cancelled",
    "skipped",
]
ReportTier = Literal["generation", "rewrite", "static"]
SectionTier = Literal["generation", "rewrite", "static"]
# Why a section fell back to its static/offline tier. ``None`` means the section
# was produced by the LLM (generation/rewrite) without any failure.
SectionFailureReason = Literal[
    "timeout",
    "tool_floor_not_met",
    "empty_outline",
    "json_parse_error",
    "plan_outline_timeout",
    "unsupported_action",
    "tool_budget_exhausted",
    "empty_body",
    "other",
]
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
    "cancelled",
    "skipped",
]
InterviewStatusValue = Literal["skipped", "complete", "partial", "failed"]
PremortemStatus = Literal["available", "partial", "missing"]
PremortemReason = Literal[
    "no_distinct_evidence",
    "insufficient_source_diversity",
    "generation_failed",
    "lineage_unavailable",
    "report_generation_failed",
    "byte_budget_truncated",
]
PremortemEvidenceRole = Literal[
    "failure_signal",
    "failure_mechanism",
    "counterevidence",
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


def _finite_float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _normalize_likelihood_probability(value: Any) -> float:
    number = _finite_float_or_none(value)
    if number is None:
        return 0.0
    return _clamp01(number)


def _normalize_likelihood_interval(value: Any) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return (0.0, 1.0)

    first = _finite_float_or_none(value[0])
    second = _finite_float_or_none(value[1])
    if first is None and second is None:
        return (0.0, 1.0)
    if first is None:
        first = second
    if second is None:
        second = first

    low = _clamp01(first if first is not None else 0.0)
    high = _clamp01(second if second is not None else 1.0)
    return (low, high) if low <= high else (high, low)


def _derive_likelihood_label(probability: float) -> str:
    probability = _clamp01(probability)
    if probability < 0.05:
        return "almost_no_chance"
    if probability < 0.20:
        return "very_unlikely"
    if probability < 0.40:
        return "unlikely"
    if probability < 0.60:
        return "roughly_even"
    if probability < 0.80:
        return "likely"
    if probability < 0.95:
        return "very_likely"
    return "almost_certain"


class Likelihood(_StrictModel):
    probability: float = Field(ge=0.0, le=1.0)
    interval: tuple[float, float]
    wep: str = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def normalize_probability_and_interval(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        if "probability" in normalized:
            normalized["probability"] = _normalize_likelihood_probability(
                normalized.get("probability"),
            )
        if "interval" in normalized:
            normalized["interval"] = _normalize_likelihood_interval(
                normalized.get("interval"),
            )
        wep = str(normalized.get("wep") or "").strip()
        if wep:
            normalized["wep"] = wep
        else:
            normalized["wep"] = _derive_likelihood_label(
                _normalize_likelihood_probability(normalized.get("probability")),
            )
        return normalized

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
    # Per-section observability (S9). ``tier`` records which generation tier
    # produced this section; ``failure_reason`` is non-null only when the
    # section fell back to ``static`` and explains why the LLM tiers failed.
    # Both default so legacy persisted reports deserialize unchanged.
    tier: SectionTier = "generation"
    failure_reason: SectionFailureReason | None = None


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


class Claim(_StrictModel):
    """Auditable report conclusion bound to durable simulation coordinates."""

    claim_id: str = Field(min_length=1)
    claim_text: str = Field(min_length=1)
    claim_type: str = Field(min_length=1)
    speaker: str | None
    agent_id: str | None
    message_ids: list[str]
    action_ids: list[str]
    branch_id: str = Field(min_length=1)
    round_numbers: list[int]
    exact_quote: str | None
    evidence_strength: Literal["strong", "moderate", "weak", "unsupported"]
    temporal_coverage: list[str]
    role_coverage: list[str]
    confidence: ConfidenceLevel
    downgrade_reason: str | None

    @model_validator(mode="after")
    def validate_claim_contract(self) -> "Claim":
        for label, values in (
            ("message_ids", self.message_ids),
            ("action_ids", self.action_ids),
        ):
            if any(not str(value).strip() for value in values):
                raise ValueError(f"claim {label} must contain nonblank ids")
            if len(values) != len(set(values)):
                raise ValueError(f"claim {label} cannot contain duplicates")
        if any(round_number < 0 for round_number in self.round_numbers):
            raise ValueError("claim round_numbers must be nonnegative")
        if len(self.round_numbers) != len(set(self.round_numbers)):
            raise ValueError("claim round_numbers cannot contain duplicates")
        allowed_phases = {"early", "middle", "late"}
        if any(phase not in allowed_phases for phase in self.temporal_coverage):
            raise ValueError("claim temporal_coverage contains an unknown phase")
        if len(self.temporal_coverage) != len(set(self.temporal_coverage)):
            raise ValueError("claim temporal_coverage cannot contain duplicates")
        if any(not role.strip() for role in self.role_coverage):
            raise ValueError("claim role_coverage must contain nonblank roles")
        if len(self.role_coverage) != len(set(self.role_coverage)):
            raise ValueError("claim role_coverage cannot contain duplicates")
        if self.exact_quote is not None:
            if not self.exact_quote:
                raise ValueError("claim exact_quote cannot be empty")
            if not self.message_ids or not self.speaker or not self.agent_id:
                raise ValueError(
                    "claim exact_quote requires speaker, agent_id, and message_ids"
                )
        if self.action_ids and (not self.agent_id or not self.round_numbers):
            raise ValueError("claim action_ids require agent_id and round_numbers")
        if self.evidence_strength == "unsupported":
            if self.confidence == "high":
                raise ValueError("unsupported claim cannot have high confidence")
            if not self.downgrade_reason:
                raise ValueError("unsupported claim requires downgrade_reason")
        return self


def _validate_premortem_i18n(value: I18nText, *, label: str) -> None:
    if not value.zh.strip() or not value.en.strip():
        raise ValueError(f"{label} must contain nonblank zh and en text")


class PremortemEvidenceLink(_StrictModel):
    evidence_ref: str = Field(min_length=1)
    role: PremortemEvidenceRole
    rationale_i18n: I18nText

    @model_validator(mode="after")
    def validate_link(self) -> "PremortemEvidenceLink":
        if not self.evidence_ref.strip():
            raise ValueError("premortem evidence_ref must be nonblank")
        _validate_premortem_i18n(
            self.rationale_i18n,
            label="premortem rationale_i18n",
        )
        return self


class PremortemFailureMode(_StrictModel):
    id: str = Field(pattern=r"^pm_\d{3}$")
    failure_mode_i18n: I18nText
    mechanism_i18n: I18nText
    early_warning_i18n: I18nText
    uncertainty_i18n: I18nText
    evidence_chain: list[PremortemEvidenceLink] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_item(self) -> "PremortemFailureMode":
        for label in (
            "failure_mode_i18n",
            "mechanism_i18n",
            "early_warning_i18n",
            "uncertainty_i18n",
        ):
            _validate_premortem_i18n(getattr(self, label), label=f"premortem {label}")
        evidence_refs = [link.evidence_ref for link in self.evidence_chain]
        if len(set(evidence_refs)) != len(evidence_refs):
            raise ValueError("premortem evidence_chain cannot contain duplicate refs")
        return self


class PremortemAnalysis(_StrictModel):
    status: PremortemStatus
    reason: PremortemReason | None = None
    items: list[PremortemFailureMode] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def validate_status_contract(self) -> "PremortemAnalysis":
        item_ids = [item.id for item in self.items]
        if len(set(item_ids)) != len(item_ids):
            raise ValueError("premortem failure-mode ids must be unique")
        if self.status == "missing":
            if self.items or self.reason is None:
                raise ValueError("missing premortem requires empty items and a reason")
            return self
        if not self.items:
            raise ValueError("available or partial premortem requires nonempty items")
        if self.status == "partial":
            if self.reason is None:
                raise ValueError("partial premortem requires a reason")
            return self
        if self.reason is not None:
            raise ValueError("available premortem cannot include a reason")
        if any(len(item.evidence_chain) < 2 for item in self.items):
            raise ValueError("available premortem items require at least two evidence refs")
        return self


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


class InterviewStatus(_StrictModel):
    status: InterviewStatusValue
    requested_agents: int = Field(ge=0)
    completed_agents: int = Field(ge=0)
    truncated_agents: int = Field(default=0, ge=0)
    error_code: str | None = None
    message: str | None = None


class ToolTraceSummary(_StrictModel):
    section_id: str | None = Field(default=None, max_length=80)
    tool: str = Field(min_length=1, max_length=64)
    query: str = Field(default="", max_length=200)
    item_count: int = Field(default=0, ge=0)
    elapsed_ms: int = Field(default=0, ge=0)


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
    claims: list[Claim] = Field(default_factory=list)
    sections: list[ReportSection] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    indicators_to_watch: list[IndicatorToWatch] = Field(default_factory=list)
    dissenting: DissentingView | None = None
    key_participants: list[KeyParticipant] = Field(default_factory=list)
    follow_ups: list[str] = Field(default_factory=list)
    limitations: str = Field(min_length=1)
    interview_evidence: list[dict[str, Any]] = Field(default_factory=list)
    interview_status: InterviewStatus | None = None
    premortem: list[dict[str, Any]] = Field(default_factory=list)
    premortem_analysis: PremortemAnalysis | None = None
    language_status: LanguageStatus | None = None
    tool_trace: list[ToolTraceSummary] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def validate_report_contract(self) -> "FullReport":
        if self.target_branch_sort != _TARGET_BRANCH_SORT:
            raise ValueError("target_branch_sort must match the frozen /story order")
        if not self.available_languages:
            raise ValueError("available_languages cannot be empty")
        if len(set(self.available_languages)) != len(self.available_languages):
            raise ValueError("available_languages cannot contain duplicates")
        evidence_ids = {item.id for item in self.evidence}
        claim_ids = [claim.claim_id for claim in self.claims]
        if len(claim_ids) != len(set(claim_ids)):
            raise ValueError("claim_id must be unique within a report")
        evidence_by_message_id: dict[str, list[EvidenceRef]] = {}
        for evidence in self.evidence:
            evidence_by_message_id.setdefault(evidence.message_id, []).append(evidence)
        allowed_claim_branch_ids = {self.target_branch_id}
        allowed_claim_branch_ids.update(
            evidence.branch_id for evidence in self.evidence
        )
        for claim in self.claims:
            if claim.branch_id not in allowed_claim_branch_ids:
                raise ValueError("claim branch_id must belong to report evidence scope")
            unknown_message_ids = [
                message_id
                for message_id in claim.message_ids
                if message_id not in evidence_by_message_id
            ]
            if unknown_message_ids:
                raise ValueError("claim message_ids must reference report evidence")
            referenced_evidence = [
                evidence
                for message_id in claim.message_ids
                for evidence in evidence_by_message_id.get(message_id, [])
            ]
            referenced_rounds = {evidence.round_number for evidence in referenced_evidence}
            if not referenced_rounds.issubset(set(claim.round_numbers)):
                raise ValueError(
                    "claim round_numbers must include referenced message coordinates"
                )
            if claim.exact_quote is not None and not any(
                evidence.agent_id == claim.agent_id
                and evidence.agent_name == claim.speaker
                for evidence in referenced_evidence
            ):
                raise ValueError(
                    "claim exact_quote speaker must match referenced evidence coordinates"
                )
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
        if self.premortem_analysis is not None:
            if len(evidence_ids) != len(self.evidence):
                raise ValueError(
                    "structured premortem requires unique report evidence ids"
                )
            evidence_by_id = {item.id: item for item in self.evidence}
            for item in self.premortem_analysis.items:
                referenced_ids = [link.evidence_ref for link in item.evidence_chain]
                unknown_refs = [
                    evidence_id
                    for evidence_id in referenced_ids
                    if evidence_id not in evidence_by_id
                ]
                if unknown_refs:
                    raise ValueError(
                        "premortem evidence_chain must reference report evidence ids"
                    )
                if self.premortem_analysis.status != "available":
                    continue
                referenced = [evidence_by_id[evidence_id] for evidence_id in referenced_ids]
                source_coordinates = {
                    (
                        evidence.branch_id,
                        evidence.round_id,
                        evidence.round_number,
                        evidence.agent_id,
                        evidence.message_id,
                    )
                    for evidence in referenced
                }
                agent_ids = {evidence.agent_id for evidence in referenced}
                branch_ids = {evidence.branch_id for evidence in referenced}
                if len(source_coordinates) < 2 or (
                    len(agent_ids) < 2 and len(branch_ids) < 2
                ):
                    raise ValueError(
                        "available premortem items require source diversity"
                    )
        _assert_no_sensitive_material(self.model_dump(mode="json"))
        return self


class ResultReportSSEData(_StrictModel):
    report_id: str | None = None
    section_id: str | None = None
    status: ResultReportSSEStatus
    message: str | None = None
    tool_trace: list[ToolTraceSummary] = Field(default_factory=list)
    error_code: str | None = None
    tier: SectionTier | None = None
    failure_reason: SectionFailureReason | None = None


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
            if is_sensitive_report_key(key):
                raise ValueError(f"sensitive key is not allowed at {path}.{key_text}")
            _assert_no_sensitive_material(nested, f"{path}.{key_text}")
        return
    if isinstance(value, list):
        for index, nested in enumerate(value):
            _assert_no_sensitive_material(nested, f"{path}[{index}]")
        return
    if isinstance(value, str) and _SENSITIVE_VALUE_RE.search(
        _canonicalize_html_entities_for_sensitive_scan(value)
    ):
        raise ValueError(f"sensitive value is not allowed at {path}")


def _canonicalize_html_entities_for_sensitive_scan(value: str) -> str:
    """Decode bounded nested entities for detection without mutating payload text."""

    canonical = str(value or "")
    for _ in range(3):
        decoded = html.unescape(canonical)
        if decoded == canonical:
            break
        canonical = decoded
    return unicodedata.normalize("NFKC", canonical)


def is_sensitive_report_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    normalized = re.sub(
        r"[\s_-]+",
        "",
        _canonicalize_html_entities_for_sensitive_scan(key).strip().lower(),
    )
    if normalized in _SENSITIVE_KEYS:
        return True
    if normalized.endswith(_SENSITIVE_KEY_SUFFIXES):
        return True
    return normalized.startswith(_SENSITIVE_KEY_PREFIXES)
