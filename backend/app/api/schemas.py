"""SwarmOracle API — Pydantic request/response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator

from app.config import settings

# ── Request schemas ──────────────────────────────────────


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


class CreateScenarioRequest(BaseModel):
    question: str
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
    # V2: Pixel visualization
    visualization_enabled: bool | None = None  # Enable pixel theater mode
    # Web Search Enhancement: opt-in per-scenario
    web_search_enabled: bool = False  # Request web search before simulation (default off)
    web_search_provider: str | None = None
    web_search_api_key: str | None = None
    web_search_base_url: str | None = None
    # Phase 3 F3: Custom agent identities to include in simulation
    custom_agent_identity_ids: list[str] | None = None
    continuity_overrides: list["ContinuityOverrideRequest"] | None = None

    @field_validator("custom_agent_identity_ids")
    @classmethod
    def validate_custom_agent_identity_ids(cls, v: list[str] | None) -> list[str] | None:
        if v is not None and len(v) > 5:
            raise ValueError("custom_agent_identity_ids must contain at most 5 items")
        return v

    @field_validator("continuity_overrides")
    @classmethod
    def validate_continuity_overrides(
        cls,
        v: list["ContinuityOverrideRequest"] | None,
    ) -> list["ContinuityOverrideRequest"] | None:
        if v is not None and len(v) > 50:
            raise ValueError("continuity_overrides must contain at most 50 items")
        return v

    @field_validator("question")
    @classmethod
    def validate_question(cls, v: str) -> str:
        normalized = v.strip()
        if not normalized:
            raise ValueError("question cannot be empty")
        if len(normalized) > 1000:
            raise ValueError("question too long (max 1000 chars)")
        return normalized

    @field_validator(
        "llm_api_key",
        "llm_base_url",
        "llm_model",
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
        if normalized not in {"tavily", "exa", "xai", "searxng"}:
            raise ValueError("web_search_provider must be one of tavily, exa, xai, searxng")
        return normalized

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


class ScenarioResponse(BaseModel):
    id: str
    question: str
    status: str
    created_at: str
    agents: list[dict] = []
    branches: list[dict] = []
    groups: list[dict] = []  # P3-A
    messages: list[dict] = []  # Historical agent messages
    total_rounds: int | None = None
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
    fork_reason: str = ""
