"""SwarmOracle API — Pydantic request/response schemas."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.config import settings

_CAMPAIGN_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_CAMPAIGN_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CAMPAIGN_WEEK_PATTERN = re.compile(r"^\d{4}-W\d{2}$")
_ORIGIN_NODE_TYPE_PATTERN = re.compile(r"^[A-Za-z0-9_:-]+$")
NativeSearchUpstreamOverride = Literal[
    "off",
    "auto",
    "xai_responses",
    "openai_responses",
]

# ── Request schemas ──────────────────────────────────────

WorldContextTraitText = Annotated[str, Field(max_length=80)]
WorldContextConstraintText = Annotated[str, Field(max_length=240)]
WorldContextEvidenceText = Annotated[str, Field(max_length=600)]
WorldContextWarningText = Annotated[str, Field(max_length=240)]


class ContinuityOverrideRequest(BaseModel):
    continuity_key: str
    action: str
    identity_id: str | None = None
    agent_name: str | None = None
    agent_role: str | None = None

    @field_validator("continuity_key")
    @classmethod
    def validate_continuity_key(cls, v: str) -> str:
        normalized = v.strip()
        if not normalized:
            raise ValueError("continuity_key cannot be empty")
        if len(normalized) > 128:
            raise ValueError("continuity_key must be at most 128 characters")
        return normalized

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        normalized = v.strip().lower()
        if normalized not in {"reuse_existing", "create_new"}:
            raise ValueError("action must be 'reuse_existing' or 'create_new'")
        return normalized

    @field_validator("identity_id")
    @classmethod
    def normalize_identity_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip()
        return normalized or None

    @field_validator("agent_name", "agent_role")
    @classmethod
    def normalize_agent_fields(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip()
        if len(normalized) > 200:
            raise ValueError("agent_name/agent_role must be at most 200 characters")
        return normalized or None

    @model_validator(mode="after")
    def validate_identity_choice(self) -> "ContinuityOverrideRequest":
        if self.action == "reuse_existing" and not self.identity_id:
            raise ValueError("identity_id is required when action is 'reuse_existing'")
        if self.action == "create_new":
            self.identity_id = None
        return self


class WebSearchOverride(BaseModel):
    """Frozen v1 pre-plan shape for web search override.

    BE-5 (R3-C2): schema is locked to single-provider override fields. No
    ``providers`` aggregate field is allowed — per-family provider selection is
    exposed read-only via ``GET /api/capabilities`` (see BE-6), never accepted
    on the request payload.
    """

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None


class CampaignContext(BaseModel):
    """Authoritative challenge/track context attached to a scenario at creation.

    Persisted into ``Scenario.parsed_context.campaign_context`` and read by
    ``finalize_scenario_campaign`` to drive durable daily-dedupe, streak, and
    weekly-bonus accounting. Legacy callers that omit this context fall back
    to the ``completed_daily_challenge`` boolean (``campaign_context_source``
    becomes ``"legacy_bool"``).
    """

    model_config = ConfigDict(extra="forbid")

    challenge_id: str | None = None
    challenge_local_date: str | None = None  # YYYY-MM-DD
    week_key: str | None = None  # e.g. "2026-W20"
    weekly_track_id: str | None = None
    profile_id: str | None = None
    difficulty_tier: Literal["easy", "normal", "hard", "expert"] | None = None
    is_daily_challenge: bool = False
    is_weekly_track: bool = False

    @field_validator("challenge_local_date")
    @classmethod
    def validate_date_format(cls, v: str | None) -> str | None:
        if v is not None and not _CAMPAIGN_DATE_PATTERN.match(v):
            raise ValueError("challenge_local_date must be YYYY-MM-DD")
        return v

    @field_validator("week_key")
    @classmethod
    def validate_week_key_format(cls, v: str | None) -> str | None:
        if v is not None and not _CAMPAIGN_WEEK_PATTERN.match(v):
            raise ValueError("week_key must be YYYY-Wnn")
        return v

    @field_validator("challenge_id", "weekly_track_id", "profile_id")
    @classmethod
    def validate_id_charset(cls, v: str | None) -> str | None:
        if v is not None and not _CAMPAIGN_ID_PATTERN.match(v):
            raise ValueError("id fields must be 1-64 chars of [a-zA-Z0-9_-]")
        return v

    @model_validator(mode="after")
    def validate_paired_intent_fields(self) -> "CampaignContext":
        """Daily / weekly intents must come with their required identifiers.

        Without these guarantees, a request would set ``is_daily_challenge=True``
        but the ledger would have nothing to dedupe on, and ``streak_after`` /
        weekly bonus accounting would silently no-op. Catching it at the API
        boundary keeps callers honest.
        """
        if self.is_daily_challenge and not self.challenge_id:
            raise ValueError(
                "challenge_id is required when is_daily_challenge=True"
            )
        if self.is_weekly_track:
            if not self.week_key:
                raise ValueError(
                    "week_key is required when is_weekly_track=True"
                )
            if not self.weekly_track_id:
                raise ValueError(
                    "weekly_track_id is required when is_weekly_track=True"
                )
        return self


class WorldContextEntity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=100)
    role: str = Field(default="", max_length=200)
    traits: list[WorldContextTraitText] = Field(default_factory=list, max_length=10)
    perspective: str = Field(default="", max_length=500)

    @field_validator("name", "role", "perspective")
    @classmethod
    def normalize_entity_text(cls, v: str) -> str:
        return re.sub(r"\s+", " ", str(v or "")).strip()

    @field_validator("traits")
    @classmethod
    def normalize_traits(cls, v: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for item in v:
            trait = re.sub(r"\s+", " ", str(item or "")).strip()[:80]
            if not trait:
                continue
            key = trait.casefold()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(trait)
        return normalized[:10]


class WorldContextSourceMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str = Field(max_length=255)
    content_type: str = Field(max_length=100)
    suffix: str = Field(max_length=16)
    byte_count: int = Field(ge=0)
    char_count: int = Field(ge=0)
    extraction_method: Literal["pdf", "text", "markdown"]


class WorldContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=120)
    summary: str = Field(max_length=1200)
    key_entities: list[WorldContextEntity] = Field(default_factory=list, max_length=12)
    constraints: list[WorldContextConstraintText] = Field(default_factory=list, max_length=10)
    evidence_snippets: list[WorldContextEvidenceText] = Field(
        default_factory=list,
        max_length=8,
    )
    source_metadata: WorldContextSourceMetadata
    warnings: list[WorldContextWarningText] = Field(default_factory=list, max_length=10)

    @field_validator("title", "summary")
    @classmethod
    def normalize_text_field(cls, v: str) -> str:
        return re.sub(r"\s+", " ", str(v or "")).strip()

    @field_validator("constraints", "warnings")
    @classmethod
    def normalize_short_lists(cls, v: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for item in v:
            text = re.sub(r"\s+", " ", str(item or "")).strip()[:240]
            if not text:
                continue
            key = text.casefold()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(text)
        return normalized

    @field_validator("evidence_snippets")
    @classmethod
    def normalize_evidence_snippets(cls, v: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for item in v:
            text = re.sub(r"\s+", " ", str(item or "")).strip()[:600]
            if not text:
                continue
            key = text.casefold()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(text)
        return normalized


class CreateScenarioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(..., min_length=1, max_length=2000)
    language: Literal["zh", "en"] | None = None
    user_id: str | None = None
    num_agents: int | None = None  # User-specified agent count, range 3-1500
    rounds: int | None = None      # User-specified round count (overrides parsed default)
    mode: str | None = "blackboard"  # "raw" | "blackboard"
    hierarchical: bool | None = None  # P3-A: force hierarchical mode (auto-detected if num_agents > threshold)  # noqa: E501
    reasoning_effort: str | None = None  # "low" | "medium" | "high" | None (= use server default or disabled)  # noqa: E501
    temperature: float | None = None  # Chat-completions sampling temperature override
    branch_sensitivity: float | None = None  # Override branch detector sensitivity (0-1)
    fork_prompt_variant: str | None = None  # Detector prompt variant: "a" | "b"
    fork_detector_active_branch_limit: int | None = None  # Optional cap on active branches eligible for future fork detection; 0 disables the budget  # noqa: E501
    # P4-E: BYOK — bring your own key
    llm_api_key: str | None = None    # OpenAI-compatible API key
    llm_base_url: str | None = None   # OpenAI-compatible base URL or endpoint (e.g. https://api.openai.com/v1)
    llm_model: str | None = None      # Model name override (e.g. gpt-4o, claude-3.5-sonnet)
    llm_requests_per_minute: int | None = None  # Optional request-rate cap for this run; 0 disables the cap  # noqa: E501
    llm_tokens_per_minute: int | None = None  # Optional token-rate cap for this run; 0 disables the cap  # noqa: E501
    disable_user_quota: bool | None = None  # Local-only: disable user-level fairness cap for this run  # noqa: E501
    model_profile_id: str | None = None  # Optional local ModelProfile id for provider policy
    # V2: Pixel visualization
    visualization_enabled: bool | None = None  # Enable pixel theater mode
    # Web Search Enhancement: opt-in per-scenario
    web_search_enabled: bool = False  # Request web search before simulation (default off)
    web_search_families: list[str] | None = None
    web_search_provider: str | None = None
    web_search_api_key: str | None = None
    web_search_base_url: str | None = None
    web_search_intensity: str | None = None
    # Phase 3 F3: Custom agent identities to include in simulation
    custom_agent_identity_ids: list[str] | None = None
    continuity_overrides: list["ContinuityOverrideRequest"] | None = None
    world_context: WorldContext | None = None
    # Campaign Phase 1: authoritative challenge/track context for finalize accounting
    campaign_context: CampaignContext | None = None

    @field_validator("custom_agent_identity_ids", mode="before")
    @classmethod
    def validate_custom_agent_identity_ids(cls, v: object) -> list[str] | None:
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("custom_agent_identity_ids must be a list")

        normalized: list[str] = []
        seen: set[str] = set()
        for item in v:
            if not isinstance(item, str):
                raise ValueError("custom_agent_identity_ids must contain strings")
            candidate = item.strip()
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            normalized.append(candidate)

        if len(normalized) > settings.MAX_CUSTOM_AGENTS:
            raise ValueError(
                f"custom_agent_identity_ids must contain at most {settings.MAX_CUSTOM_AGENTS} items"
            )
        return normalized

    @model_validator(mode="after")
    def validate_custom_agent_identity_count(self) -> "CreateScenarioRequest":
        if self.custom_agent_identity_ids is None:
            return self
        limit = settings.custom_agent_limit_for(self.num_agents)
        if len(self.custom_agent_identity_ids) > limit:
            raise ValueError(
                f"custom_agent_identity_ids must contain at most {limit} items "
                "for the requested agent count"
            )
        return self

    @field_validator("continuity_overrides")
    @classmethod
    def validate_continuity_overrides(
        cls,
        v: list["ContinuityOverrideRequest"] | None,
    ) -> list["ContinuityOverrideRequest"] | None:
        if v is not None and len(v) > 50:
            raise ValueError("continuity_overrides must contain at most 50 items")
        return v

    @field_validator("web_search_families")
    @classmethod
    def validate_web_search_families(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        allowed = {"polymarket", "finance", "academic", "news_deep"}
        normalized: list[str] = []
        for family in v:
            candidate = family.strip().lower()
            if candidate not in allowed:
                raise ValueError(
                    "web_search_families must contain only polymarket, finance, academic, news_deep"
                )
            if candidate not in normalized:
                normalized.append(candidate)
        return normalized

    @field_validator("question")
    @classmethod
    def validate_question(cls, v: str) -> str:
        normalized = v.strip()
        if not normalized:
            raise ValueError("question cannot be empty")
        return normalized

    @field_validator(
        "llm_api_key",
        "llm_base_url",
        "llm_model",
        "model_profile_id",
        "web_search_api_key",
        "web_search_base_url",
    )
    @classmethod
    def normalize_optional_byok(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None

    @field_validator("web_search_provider")
    @classmethod
    def validate_web_search_provider(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip().lower()
        if normalized not in {"tavily", "exa", "firecrawl", "xai", "searxng"}:
            raise ValueError(
                "web_search_provider must be one of tavily, exa, firecrawl, xai, searxng"
            )
        return normalized

    @model_validator(mode="after")
    def validate_web_search_intensity(self) -> "CreateScenarioRequest":
        if not self.web_search_enabled:
            self.web_search_intensity = None
            return self
        normalized = (self.web_search_intensity or "standard").strip().lower()
        if normalized not in {"light", "standard", "deep"}:
            raise ValueError("web_search_intensity must be 'light', 'standard', or 'deep'")
        self.web_search_intensity = normalized
        return self

    @field_validator("user_id")
    @classmethod
    def validate_user_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip()
        if len(normalized) > 128:
            raise ValueError("user_id must be at most 128 characters")
        return normalized or None

    @field_validator("num_agents")
    @classmethod
    def validate_num_agents(cls, v: int | None) -> int | None:
        if v is not None and (v < 3 or v > settings.MAX_AGENTS):
            raise ValueError(f"num_agents must be between 3 and {settings.MAX_AGENTS}")
        return v

    @field_validator("rounds")
    @classmethod
    def validate_rounds(cls, v: int | None) -> int | None:
        if v is not None and (v < 1 or v > settings.MAX_ROUNDS):
            raise ValueError(f"rounds must be between 1 and {settings.MAX_ROUNDS}")
        return v

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, v: str | None) -> str | None:
        if v is not None and v not in ("raw", "blackboard"):
            raise ValueError("mode must be 'raw' or 'blackboard'")
        return v

    @field_validator("reasoning_effort")
    @classmethod
    def validate_reasoning_effort(cls, v: str | None) -> str | None:
        if v is not None and v not in ("low", "medium", "high"):
            raise ValueError("reasoning_effort must be 'low', 'medium', or 'high'")
        return v

    @field_validator("temperature")
    @classmethod
    def validate_temperature(cls, v: float | None) -> float | None:
        if v is not None and not (0.0 <= v <= 2.0):
            raise ValueError("temperature must be between 0.0 and 2.0")
        return v

    @field_validator("branch_sensitivity")
    @classmethod
    def validate_branch_sensitivity(cls, v: float | None) -> float | None:
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError("branch_sensitivity must be between 0.0 and 1.0")
        return v

    @field_validator("fork_prompt_variant")
    @classmethod
    def validate_fork_prompt_variant(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip().lower()
        if normalized not in ("a", "b", "c", "d", "e", "f"):
            raise ValueError("fork_prompt_variant must be 'a', 'b', 'c', 'd', 'e', or 'f'")
        return normalized

    @field_validator("fork_detector_active_branch_limit")
    @classmethod
    def validate_fork_detector_active_branch_limit(cls, v: int | None) -> int | None:
        if v is not None and not (0 <= v <= settings.MAX_BRANCHES):
            raise ValueError(
                f"fork_detector_active_branch_limit must be between 0 and {settings.MAX_BRANCHES}"
            )
        return v

    @field_validator("llm_requests_per_minute", "llm_tokens_per_minute")
    @classmethod
    def validate_optional_non_negative_limit(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError("LLM rate limits must be >= 0")
        return v


class TestLlmRequest(BaseModel):
    """Request body for BYOK connection test."""
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_requests_per_minute: int | None = None
    llm_tokens_per_minute: int | None = None
    include_probe: bool = True
    include_native_probe: bool = False
    native_probe_only: bool = False
    supports_native_search_override: bool | None = None
    native_search_upstream_override: NativeSearchUpstreamOverride | None = None
    live_native_test: bool = False

    @field_validator("llm_requests_per_minute", "llm_tokens_per_minute")
    @classmethod
    def validate_test_optional_non_negative_limit(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError("LLM rate limits must be >= 0")
        return v


class InterveneRequest(BaseModel):
    branch_id: str
    text: str
    card_id: str | None = None
    profile_id: str | None = None
    directive: str | None = None

    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        normalized = v.strip()
        if not normalized:
            raise ValueError("intervention text cannot be empty")
        if len(normalized) > 2000:
            raise ValueError("intervention text too long (max 2000 chars)")
        return normalized

    @field_validator("card_id", "profile_id", "directive")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_card_bundle(self) -> "InterveneRequest":
        if self.card_id and not self.profile_id:
            raise ValueError("profile_id is required when card_id is provided")
        return self


class RetrospectiveInterveneRequest(BaseModel):
    """Replay simulation from a specific round with an injected event."""
    branch_id: str
    round_number: int
    text: str

    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        normalized = v.strip()
        if not normalized:
            raise ValueError("intervention text cannot be empty")
        if len(normalized) > 2000:
            raise ValueError("intervention text too long (max 2000 chars)")
        return normalized

    @field_validator("round_number")
    @classmethod
    def validate_round_number(cls, v: int) -> int:
        if v < 1:
            raise ValueError("round_number must be >= 1")
        return v


class BatchInterveneRequest(BaseModel):
    """Inject interventions into multiple branches simultaneously."""
    interventions: list[InterveneRequest]

    @field_validator("interventions")
    @classmethod
    def validate_interventions(cls, v: list[InterveneRequest]) -> list[InterveneRequest]:
        if len(v) > 50:
            raise ValueError("interventions must contain at most 50 items")
        return v


class ResumeRequest(BaseModel):
    """Resume simulation from a specific round on a new branch (P1-9)."""
    source_branch_id: str
    round_number: int = Field(ge=1)


# ── Response schemas ─────────────────────────────────────


class InterventionTemplateVariable(BaseModel):
    key: str
    label_en: str
    label_zh: str
    examples: list[str] = Field(default_factory=list)


class InterventionTemplateResponse(BaseModel):
    id: str
    name: str
    template: str
    name_en: str
    name_zh: str
    description_en: str
    description_zh: str
    template_en: str
    template_zh: str
    variables: list[InterventionTemplateVariable] | None = None
    intervention_kind: str | None = None
    suggested_targets: str | None = None


class ScenarioResponse(BaseModel):
    id: str
    question: str
    status: str
    run_group_id: str | None = None
    total_rounds: int | None = None
    created_at: str
    agents: list[dict] = []
    branches: list[dict] = []
    groups: list[dict] = []  # P3-A
    messages: list[dict] = []  # Historical agent messages
    estimated_tokens_per_round: int | None = None
    estimated_total_tokens: int | None = None
    context_safety: str | None = None
    mode: str | None = None
    hierarchical: bool = False  # P3-A
    # V2: Pixel visualization
    visualization_enabled: bool = False
    scene_theme: str | None = None
    # Web Search Enhancement
    web_search_context: dict | None = None
    director_state: dict | None = None
    gameplay_state: dict | None = None
    fork_debug: dict | None = None
    # Phase 3: additive fields
    causal_graph_id: str | None = None
    checkpoints: list | None = None
    faction_timeline_id: str | None = None


class StoryBranch(BaseModel):
    id: str
    title: str
    probability: float
    status: str
    story: str = ""
    insight: str = ""
    key_moments: list[str] = []
    parent_branch_id: str | None = None
    fork_round: int = 0
    fork_reason: str = ""
    replay_kind: str | None = None
    replay_source_branch_id: str | None = None
    question_answer: str | None = None


# ── Replay Trace (BE-4) ──────────────────────────────────────────────
class ReplayTraceNode(BaseModel):
    """Single branch node in a replay lineage trace (F4 / BE-4)."""

    model_config = ConfigDict(extra="forbid")

    branch_id: str
    parent_branch_id: str | None = None
    replay_source_branch_id: str | None = None
    origin_round: int
    replay_kind: str
    status: str
    created_at: datetime


class ReplayTraceResponse(BaseModel):
    """Cursor-paginated response for ``GET /api/scenario/{id}/replay-trace``."""

    model_config = ConfigDict(extra="forbid")

    nodes: list[ReplayTraceNode] = []
    next_cursor: str | None = None


# ── Agent Conversation (BE-3) ────────────────────────────────────────
#
# F7 — user-owned dialogue thread anchored to a branch/round/node, with
# streaming assistant turns.  HC-31/32/34/36 hard constraints:
#   * ``owner_user_id`` on the thread is the sole ACL / quota authority
#     (never ``organization_id`` from request body — v1 deleted per-org
#     quota entirely).  Creation-time freeze is asserted by the API layer.
#   * ``model`` payload is strictly a *logical* model name — it must not
#     contain ``://`` or ``http`` (no base_url composites).
#   * ``error_message`` on responses is a short user-visible phrase mapped
#     from a whitelisted ``error_code``; raw traceback stays in server-side
#     structured logs via ``redact_byok()`` (HC-36).


class StartConversationRequest(BaseModel):
    """Request body for ``POST /api/conversation/start``."""

    model_config = ConfigDict(extra="forbid")

    scenario_id: str
    agent_identity_id: str | None = None
    origin_branch_id: str | None = None
    origin_round_number: int | None = Field(default=None, ge=0)
    origin_node_id: str | None = None
    origin_node_type: str | None = None
    origin_excerpt: str | None = None
    first_user_content: str
    # BYOK (HC-24) — remote base URLs require api_key; local providers may be keyless.
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    disable_user_quota: bool | None = None

    @field_validator("first_user_content")
    @classmethod
    def _validate_first_user_content(cls, v: str) -> str:
        normalized = (v or "").strip()
        if not normalized:
            raise ValueError("first_user_content cannot be empty")
        if len(normalized) > 8000:
            raise ValueError("first_user_content too long (max 8000 chars)")
        return normalized

    @field_validator("origin_node_type", "origin_branch_id", "origin_node_id")
    @classmethod
    def _normalize_optional_text(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip()
        if len(normalized) > 128:
            raise ValueError("origin_* fields must be at most 128 characters")
        return normalized or None

    @field_validator("origin_node_type")
    @classmethod
    def _validate_origin_node_type(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not _ORIGIN_NODE_TYPE_PATTERN.fullmatch(v):
            raise ValueError(
                "origin_node_type must use only letters, numbers, underscores, dashes, or colons"
            )
        return v

    @field_validator("origin_excerpt")
    @classmethod
    def _normalize_origin_excerpt(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip()
        if len(normalized) > 1000:
            raise ValueError("origin_excerpt must be at most 1000 characters")
        return normalized or None

    @field_validator("llm_api_key", "llm_base_url", "llm_model")
    @classmethod
    def _normalize_optional_byok(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None

    @field_validator("llm_model")
    @classmethod
    def _validate_model_shape(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if "://" in v or "http" in v.lower():
            raise ValueError("llm_model must be a logical model name, not a URL")
        if len(v) > 100:
            raise ValueError("llm_model must be at most 100 characters")
        return v


class ConversationTurnCreate(BaseModel):
    """Request body for ``POST /api/conversation/{thread_id}/turn``.

    Triggers an assistant streaming reply in response to a new user turn.
    ``user_content`` is the new user message; the assistant turn id is
    returned immediately and tokens stream via SSE.
    """

    model_config = ConfigDict(extra="forbid")

    user_content: str
    origin_excerpt: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    disable_user_quota: bool | None = None

    @field_validator("user_content")
    @classmethod
    def _validate_user_content(cls, v: str) -> str:
        normalized = (v or "").strip()
        if not normalized:
            raise ValueError("user_content cannot be empty")
        if len(normalized) > 8000:
            raise ValueError("user_content too long (max 8000 chars)")
        return normalized

    @field_validator("origin_excerpt")
    @classmethod
    def _normalize_origin_excerpt(cls, v: str | None) -> str | None:
        if v is None:
            return None
        normalized = v.strip()
        if len(normalized) > 1000:
            raise ValueError("origin_excerpt must be at most 1000 characters")
        return normalized or None

    @field_validator("llm_api_key", "llm_base_url", "llm_model")
    @classmethod
    def _normalize_optional_byok(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None

    @field_validator("llm_model")
    @classmethod
    def _validate_model_shape(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if "://" in v or "http" in v.lower():
            raise ValueError("llm_model must be a logical model name, not a URL")
        if len(v) > 100:
            raise ValueError("llm_model must be at most 100 characters")
        return v


class ConversationTurnResponse(BaseModel):
    """Single turn view for ``GET /api/conversation/{thread_id}`` playback."""

    model_config = ConfigDict(extra="forbid")

    id: str
    thread_id: str
    role: str
    sequence: int
    status: str
    content: str = ""
    error_code: str | None = None
    # HC-36: never echo raw provider traceback; short user-visible phrase only.
    error_message: str | None = None
    model: str | None = None
    source_branch_id: str | None = None
    source_round_number: int | None = None
    source_node_id: str | None = None
    source_node_type: str | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class ConversationThreadResponse(BaseModel):
    """Response for ``POST /api/conversation/start`` and ``GET /api/conversation/{id}``."""

    model_config = ConfigDict(extra="forbid")

    thread_id: str
    scenario_id: str
    agent_identity_id: str | None = None
    owner_user_id: str
    origin_branch_id: str | None = None
    origin_round_number: int | None = None
    origin_node_id: str | None = None
    origin_node_type: str | None = None
    last_turn_sequence: int
    latest_status: str
    active_turn_id: str | None = None
    created_at: datetime
    updated_at: datetime
    # Populated by start endpoint (both turns) and by GET (full playback).
    user_turn_id: str | None = None
    assistant_turn_id: str | None = None
    sequence_range: list[int] | None = None
    turns: list[ConversationTurnResponse] = []
