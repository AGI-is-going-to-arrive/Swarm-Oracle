"""SwarmOracle API — Pydantic request/response schemas."""

from __future__ import annotations

from pydantic import BaseModel, field_validator

from app.config import settings


# ── Request schemas ──────────────────────────────────────


class CreateScenarioRequest(BaseModel):
    question: str
    num_agents: int | None = None  # User-specified agent count, range 3-1500
    rounds: int | None = None      # User-specified round count (overrides parsed default)
    mode: str | None = None         # "raw" | "blackboard", default "blackboard"
    hierarchical: bool | None = None  # P3-A: force hierarchical mode (auto-detected if num_agents > threshold)
    reasoning_effort: str | None = None  # "low" | "medium" | "high" | None (= use server default or disabled)
    # P4-E: BYOK — bring your own key
    llm_api_key: str | None = None    # OpenAI-compatible API key
    llm_base_url: str | None = None   # OpenAI-compatible base URL (e.g. https://api.openai.com/v1/chat/completions)
    llm_model: str | None = None      # Model name override (e.g. gpt-4o, claude-3.5-sonnet)
    # V2: Pixel visualization
    visualization_enabled: bool | None = None  # Enable pixel theater mode

    @field_validator("num_agents")
    @classmethod
    def validate_num_agents(cls, v: int | None) -> int | None:
        if v is not None and (v < 3 or v > settings.MAX_AGENTS):
            raise ValueError(f"num_agents must be between 3 and {settings.MAX_AGENTS}")
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


class TestLlmRequest(BaseModel):
    """Request body for BYOK connection test."""
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None


class InterveneRequest(BaseModel):
    branch_id: str
    text: str


class RetrospectiveInterveneRequest(BaseModel):
    """Replay simulation from a specific round with an injected event."""
    branch_id: str
    round_number: int
    text: str

    @field_validator("round_number")
    @classmethod
    def validate_round_number(cls, v: int) -> int:
        if v < 1:
            raise ValueError("round_number must be >= 1")
        return v


class BatchInterveneRequest(BaseModel):
    """Inject interventions into multiple branches simultaneously."""
    interventions: list[InterveneRequest]


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
    director_state: dict | None = None
    gameplay_state: dict | None = None


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
