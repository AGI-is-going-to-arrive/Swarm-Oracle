"""SwarmOracle configuration — loads from .env via pydantic-settings."""

import ipaddress
from pathlib import Path
from urllib.parse import urlparse

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
_LOCAL_LLM_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal", "::1"}
_PLACEHOLDER_LLM_API_KEYS = {"", "sk-12345678", "your-api-key-here"}
DEFAULT_LLM_RESPONSES_URL = "http://127.0.0.1:8317/v1"
WEB_SEARCH_PROVIDER_CHOICES = frozenset({"tavily", "exa", "firecrawl", "xai", "searxng"})
WEB_SEARCH_PROVIDER_CHOICES_LABEL = "tavily | exa | firecrawl | xai | searxng"


def is_placeholder_llm_api_key(api_key: str) -> bool:
    return api_key.strip() in _PLACEHOLDER_LLM_API_KEYS


def normalize_llm_allowed_host(host: str | None) -> str | None:
    """Normalize a request-level LLM allowlist host via IDNA/lowercase."""
    raw = (host or "").strip()
    if not raw:
        return None
    if any(marker in raw for marker in ("://", "/", "?", "#", "@")):
        return None
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    try:
        return ipaddress.ip_address(raw).compressed.lower()
    except ValueError:
        pass
    try:
        return raw.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None


def normalize_llm_extra_allowed_hosts(value: str | None) -> str:
    normalized: list[str] = []
    seen: set[str] = set()
    for item in (value or "").split(","):
        host = normalize_llm_allowed_host(item)
        if host and host not in seen:
            normalized.append(host)
            seen.add(host)
    return ",".join(normalized)


def _is_local_llm_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").strip().lower()
    return hostname in _LOCAL_LLM_HOSTS


def is_static_llm_configured(
    *,
    base_url: str,
    api_key: str,
    default_base_url: str = DEFAULT_LLM_RESPONSES_URL,
) -> bool:
    """Return a zero-cost static capability hint for configured LLM credentials."""
    effective_base_url = (base_url or "").strip().rstrip("/")
    bundled_base_url = (default_base_url or "").strip().rstrip("/")
    return not (
        effective_base_url == bundled_base_url
        and is_placeholder_llm_api_key(api_key)
    )


class Settings(BaseSettings):
    # ── Runtime ──────────────────────────────────────────
    ENV: str = "development"  # development | production

    # ── LLM ──────────────────────────────────────────────
    LLM_RESPONSES_URL: str = DEFAULT_LLM_RESPONSES_URL
    LLM_API_KEY: str = "sk-12345678"
    LLM_MODEL_NAME: str = "gpt-5.4-mini"
    LLM_REASONING_EFFORT: str = "none"  # none | low | medium | high
    LLM_REQUESTS_PER_MINUTE: int = 0
    LLM_TOKENS_PER_MINUTE: int = 0
    LLM_EXTRA_ALLOWED_HOSTS: str = ""
    LLM_ALLOW_PRIVATE_BYOK_HOSTS: bool = False

    # ── Simulation ───────────────────────────────────────
    MAX_AGENTS: int = 1500  # P3-A: raised from 100 for 1000+ scale
    MAX_ROUNDS: int = 40
    MAX_BRANCHES: int = 8
    MEMORY_COMPRESS_INTERVAL: int = 5
    MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS: int = 20_000
    MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS: int = 12_000
    MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS: int = 12_000
    MEMORY_CORE_MAX_RECENT: int = 12
    MEMORY_IMPORTANT_MAX_RECENT: int = 5
    MEMORY_CROWD_MAX_RECENT: int = 3
    MEMORY_CORE_CONTEXT_MAX_CHARS: int = 4_200
    MEMORY_IMPORTANT_CONTEXT_MAX_CHARS: int = 3_000
    BRANCH_PRUNE_THRESHOLD: float = 0.05
    FORK_SENSITIVITY: float = 0.7
    DEFAULT_NUM_AGENTS: int = 20
    MAX_CUSTOM_AGENTS: int = 20
    DEFAULT_ROUNDS: int = 10
    HIERARCHICAL_AGENT_THRESHOLD: int = 50  # P3-A: auto-enable hierarchical mode above this

    # ── Concurrency ──────────────────────────────────────
    LLM_CONCURRENCY: int = 5
    LLM_MAX_PENDING: int = 24
    LLM_USER_MAX_PENDING: int = 4
    LLM_CIRCUIT_BREAKER_THRESHOLD: int = 6
    LLM_CIRCUIT_BREAKER_RESET_SECONDS: int = 30
    DEBATE_USE_LLM: bool = True
    ORACLE_CHAMBERS_USE_LLM: bool = True
    DOCUMENT_ENTITY_TIMEOUT: int = 120
    DOCUMENT_PERSONA_TIMEOUT: int = 300
    DOCUMENT_PERSONA_SINGLE_TIMEOUT: int = 60
    DOCUMENT_MAX_TEXT_FOR_SCAN: int = 50_000
    DOCUMENT_SCAN_SAMPLE_SIZE: int = 10_000
    DOCUMENT_MAX_EXTRACTED_TEXT_CHARS: int = 1_000_000
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: str = "json"  # json | plain
    EXPOSE_API_DOCS: bool = False  # Separate toggle for /docs, /redoc, /openapi.json

    # ── Database ─────────────────────────────────────────
    DATABASE_URL: str = f"sqlite:///{(BACKEND_ROOT / 'swarmoracle.db').resolve()}"
    CHROMA_PERSIST_DIR: str = str((BACKEND_ROOT / "chroma_data").resolve())

    # ── Web Search Enhancement ────────────────────────────
    # Set true only with WEB_SEARCH_PROVIDER plus a configured provider/API key.
    ENABLE_WEB_SEARCH: bool = False
    WEB_SEARCH_PROVIDER: str = "tavily"  # tavily | exa | firecrawl | xai | searxng
    WEB_SEARCH_API_KEY: str = ""
    XAI_WEB_SEARCH_MODEL: str = "grok-4.20-reasoning"
    XAI_WEB_SEARCH_TIMEOUT_SECONDS: float = 45.0
    WEB_SEARCH_MAX_RESULTS: int = 5
    WEB_SEARCH_TIMEOUT_SECONDS: float = 8.0
    WEB_SEARCH_CACHE_TTL_SECONDS: int = 300
    SEARXNG_URL: str = "http://localhost:8888"
    NEW_SOURCES_POLYMARKET_CONFIGURED_HOST: str = "us"
    # Set true only after ENABLE_WEB_SEARCH and a configured search provider/API key.
    FEATURE_FAMILY_QUERY_OPTIMIZATION: bool = Field(default=False)
    FAMILY_QUERY_OPTIMIZATION_TIMEOUT_SECONDS: float = Field(default=5.0)
    FAMILY_QUERY_OPTIMIZATION_CACHE_TTL_SECONDS: int = Field(default=300)
    FAMILY_QUERY_OPTIMIZATION_MAX_QUERY_CHARS: int = Field(default=180)

    # ── Native Search Budget ─────────────────────────────
    NATIVE_SEARCH_MAX_TOOL_CALLS: int = 5
    NATIVE_SEARCH_MAX_CITATIONS: int = 50

    # ── Phase 3 Feature Flags ────────────────────────────
    FEATURE_CUSTOM_AGENTS: bool = True
    FEATURE_AGENT_IDENTITY: bool = True
    FEATURE_CAUSAL_GRAPH: bool = True
    FEATURE_GRAPH_ANALYSIS: bool = True
    FEATURE_COUNTERFACTUAL_REPLAY: bool = True
    FEATURE_FACTIONS: bool = True
    FEATURE_ARGUMENT_MAP: bool = True
    ARGUMENT_MAP_LLM_ENRICHMENT: bool = True
    FEATURE_IDENTITY_COMPACTION: bool = False
    FEATURE_REPLAY_TRACE: bool = Field(default=True)
    FEATURE_AGENT_CONVERSATION: bool = Field(default=True)
    FEATURE_ROUNDTABLE_SURVEY: bool = Field(default=True)
    FEATURE_ROUNDTABLE_ANALYST: bool = Field(default=True)
    FEATURE_ROUNDTABLE_INSIGHT_LLM: bool = False
    FEATURE_KG_EXPLORER: bool = Field(default=True)
    # Set true only when web search is configured. Enabling it surfaces 4
    # domain-source checkboxes on the home page, and it depends on
    # ENABLE_WEB_SEARCH + a configured provider.
    FEATURE_NEW_SOURCES: bool = Field(default=False)
    FEATURE_SNAPSHOT_EXPORT: bool = Field(default=True)
    FEATURE_PREDICTION_JOURNAL: bool = Field(default=True)
    FEATURE_RESULT_VERDICT: bool = Field(default=True)
    FEATURE_RESULT_REPORT: bool = Field(default=True)
    REPORT_MAX_SECTIONS: int = Field(default=5, ge=1)
    REPORT_MIN_SECTIONS: int = Field(default=2, ge=1)
    REPORT_MAX_TOOL_CALLS_PER_SECTION: int = Field(default=5, ge=0)
    REPORT_MIN_TOOL_CALLS_PER_SECTION: int = Field(default=2, ge=0)
    REPORT_SECTION_TIMEOUT_SECONDS: float = Field(default=60.0, gt=0)
    REPORT_PLAN_TIMEOUT_SECONDS: float = Field(default=20.0, gt=0)
    REPORT_MAX_EVIDENCE_PER_SECTION: int = Field(default=5, ge=0)
    REPORT_SECTION_CONTENT_MAX_CHARS: int = Field(default=12_000, ge=1)
    REPORT_FULL_REPORT_MAX_BYTES: int = Field(default=262_144, ge=1)
    REPORT_EVIDENCE_EXCERPT_MAX_CHARS: int = Field(default=600, ge=1)
    # DPD Hallucination Verification Gate — warning-only post-verdict check.
    FEATURE_HALLUCINATION_GATE: bool = Field(default=False)
    HALLUCINATION_GATE_THRESHOLD: float = Field(default=0.75, ge=0.0, le=1.0)
    FEATURE_EDUCATION_TEMPLATES: bool = Field(default=True)
    FEATURE_PERSONA_EXPORT: bool = Field(default=True)

    # ── Identity Memory Compaction ───────────────────────
    IDENTITY_COMPACT_THRESHOLD: int = 50   # trigger when raw doc count >= this
    IDENTITY_COMPACT_BATCH_SIZE: int = 30  # oldest raw docs to compact per run
    IDENTITY_COMPACT_GROUP_SIZE: int = 10  # docs per LLM summarization group

    # ── Agent Conversation (BE-3) Quotas ─────────────────
    # Hard caps enforced by `app.services.conversation_service`.  Request-time
    # `disable_user_quota` may only bypass the user-day counter on a local
    # provider (HC-31) — the scenario/thread/org caps apply regardless.
    CONVERSATION_MAX_THREADS_PER_SCENARIO: int = Field(default=10)
    CONVERSATION_MAX_TURNS_PER_THREAD: int = Field(default=50)
    CONVERSATION_TURNS_PER_USER_PER_DAY: int = Field(default=500)
    CONVERSATION_TURNS_PER_ORG_PER_DAY: int = Field(default=5000)

    # ── Auth ─────────────────────────────────────────────
    SESSION_SECRET: str = ""  # If set, enables lightweight session-token auth
    # When set, /api/admin/* endpoints require matching X-Admin-Token header.
    # When empty, admin endpoints stay open (development mode).
    ADMIN_TOKEN: str = ""

    # ── Server ───────────────────────────────────────────
    HOST: str = "0.0.0.0"
    PORT: int = 18927
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:9528", "http://localhost:18928"]

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
    )

    def custom_agent_limit_for(self, num_agents: int | None) -> int:
        effective = (
            num_agents
            if num_agents is not None and num_agents >= 3
            else self.DEFAULT_NUM_AGENTS
        )
        return min(effective, self.MAX_CUSTOM_AGENTS)

    @field_validator("DATABASE_URL", mode="after")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        prefix = "sqlite:///"
        if not value.startswith(prefix):
            return value

        path_part = value[len(prefix):]
        if not path_part or path_part == ":memory:":
            return value
        if path_part.startswith("file:"):
            return value

        db_path = Path(path_part)
        if db_path.is_absolute():
            return value

        return f"{prefix}{(BACKEND_ROOT / db_path).resolve()}"

    @field_validator("CHROMA_PERSIST_DIR", mode="after")
    @classmethod
    def normalize_chroma_persist_dir(cls, value: str) -> str:
        persist_dir = Path(value)
        if persist_dir.is_absolute():
            return str(persist_dir)
        return str((BACKEND_ROOT / persist_dir).resolve())

    @field_validator("CORS_ORIGINS", mode="after")
    @classmethod
    def validate_cors_origins(cls, value: list[str]) -> list[str]:
        normalized = [origin.strip() for origin in value if origin and origin.strip()]
        if "*" in normalized:
            raise ValueError(
                "CORS_ORIGINS cannot contain '*' while the app enables credentialed CORS; "
                "list explicit origins instead"
            )
        if not normalized:
            raise ValueError("CORS_ORIGINS must contain at least one explicit origin")
        return normalized

    @field_validator("WEB_SEARCH_PROVIDER", mode="after")
    @classmethod
    def validate_web_search_provider(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in WEB_SEARCH_PROVIDER_CHOICES:
            raise ValueError(
                f"WEB_SEARCH_PROVIDER must be one of {WEB_SEARCH_PROVIDER_CHOICES_LABEL}; "
                "'native' is no longer supported; pick a listed provider or unset "
                "WEB_SEARCH_PROVIDER"
            )
        return normalized

    @field_validator("NEW_SOURCES_POLYMARKET_CONFIGURED_HOST", mode="after")
    @classmethod
    def validate_new_sources_polymarket_configured_host(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"us", "non-us"}:
            raise ValueError("NEW_SOURCES_POLYMARKET_CONFIGURED_HOST must be 'us' or 'non-us'")
        return normalized

    @field_validator("LLM_EXTRA_ALLOWED_HOSTS", mode="after")
    @classmethod
    def validate_llm_extra_allowed_hosts(cls, value: str) -> str:
        return normalize_llm_extra_allowed_hosts(value)

    @model_validator(mode="after")
    def validate_llm_runtime_settings(self) -> "Settings":
        model_name = self.LLM_MODEL_NAME.strip()
        if not model_name:
            raise ValueError("LLM_MODEL_NAME cannot be empty")
        self.LLM_MODEL_NAME = model_name

        self.LLM_RESPONSES_URL = self.LLM_RESPONSES_URL.strip()

        api_key = self.LLM_API_KEY.strip()
        if not _is_local_llm_url(self.LLM_RESPONSES_URL) and is_placeholder_llm_api_key(api_key):
            raise ValueError(
                "LLM_API_KEY must be set to a non-placeholder value for non-local LLM endpoints"
            )
        self.LLM_API_KEY = api_key
        log_level = self.LOG_LEVEL.strip().upper()
        if log_level not in {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}:
            raise ValueError("LOG_LEVEL must be one of CRITICAL, ERROR, WARNING, INFO, DEBUG")
        self.LOG_LEVEL = log_level

        log_format = self.LOG_FORMAT.strip().lower()
        if log_format not in {"json", "plain"}:
            raise ValueError("LOG_FORMAT must be 'json' or 'plain'")
        self.LOG_FORMAT = log_format

        cors_origins = [origin.strip() for origin in self.CORS_ORIGINS if origin.strip()]
        if not cors_origins:
            raise ValueError("CORS_ORIGINS cannot be empty")
        if "*" in cors_origins:
            raise ValueError(
                "CORS_ORIGINS cannot include '*' while allow_credentials is enabled"
            )
        self.CORS_ORIGINS = cors_origins

        positive_int_fields = {
            "MAX_AGENTS": self.MAX_AGENTS,
            "MAX_CUSTOM_AGENTS": self.MAX_CUSTOM_AGENTS,
            "MAX_ROUNDS": self.MAX_ROUNDS,
            "MAX_BRANCHES": self.MAX_BRANCHES,
            "MEMORY_COMPRESS_INTERVAL": self.MEMORY_COMPRESS_INTERVAL,
            "MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS": self.MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS,
            "MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS": self.MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS,
            "MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS": self.MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS,  # noqa: E501
            "MEMORY_CORE_MAX_RECENT": self.MEMORY_CORE_MAX_RECENT,
            "MEMORY_IMPORTANT_MAX_RECENT": self.MEMORY_IMPORTANT_MAX_RECENT,
            "MEMORY_CROWD_MAX_RECENT": self.MEMORY_CROWD_MAX_RECENT,
            "MEMORY_CORE_CONTEXT_MAX_CHARS": self.MEMORY_CORE_CONTEXT_MAX_CHARS,
            "MEMORY_IMPORTANT_CONTEXT_MAX_CHARS": self.MEMORY_IMPORTANT_CONTEXT_MAX_CHARS,
            "DOCUMENT_ENTITY_TIMEOUT": self.DOCUMENT_ENTITY_TIMEOUT,
            "DOCUMENT_PERSONA_TIMEOUT": self.DOCUMENT_PERSONA_TIMEOUT,
            "DOCUMENT_PERSONA_SINGLE_TIMEOUT": self.DOCUMENT_PERSONA_SINGLE_TIMEOUT,
            "DOCUMENT_MAX_TEXT_FOR_SCAN": self.DOCUMENT_MAX_TEXT_FOR_SCAN,
            "DOCUMENT_SCAN_SAMPLE_SIZE": self.DOCUMENT_SCAN_SAMPLE_SIZE,
            "DOCUMENT_MAX_EXTRACTED_TEXT_CHARS": self.DOCUMENT_MAX_EXTRACTED_TEXT_CHARS,
        }
        for field_name, value in positive_int_fields.items():
            if value <= 0:
                raise ValueError(f"{field_name} must be > 0")

        if self.LLM_REQUESTS_PER_MINUTE < 0:
            raise ValueError("LLM_REQUESTS_PER_MINUTE must be >= 0")
        if self.LLM_TOKENS_PER_MINUTE < 0:
            raise ValueError("LLM_TOKENS_PER_MINUTE must be >= 0")

        if not (0.0 <= self.BRANCH_PRUNE_THRESHOLD < 1.0):
            raise ValueError("BRANCH_PRUNE_THRESHOLD must be >= 0 and < 1")
        if not (0.0 <= self.FORK_SENSITIVITY <= 1.0):
            raise ValueError("FORK_SENSITIVITY must be between 0 and 1")

        if self.MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS > self.MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS:
            raise ValueError(
                "MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS must be <= MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS"  # noqa: E501
            )
        if self.MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS > self.MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS:  # noqa: E501
            raise ValueError(
                "MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS must be <= MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS"  # noqa: E501
            )
        if not (
            self.MEMORY_CROWD_MAX_RECENT
            <= self.MEMORY_IMPORTANT_MAX_RECENT
            <= self.MEMORY_CORE_MAX_RECENT
        ):
            raise ValueError(
                "Memory tier recent-message limits must satisfy CROWD <= IMPORTANT <= CORE"
            )
        if self.MEMORY_IMPORTANT_CONTEXT_MAX_CHARS > self.MEMORY_CORE_CONTEXT_MAX_CHARS:
            raise ValueError(
                "MEMORY_IMPORTANT_CONTEXT_MAX_CHARS must be <= MEMORY_CORE_CONTEXT_MAX_CHARS"
            )

        # Identity memory compaction constraints
        if self.IDENTITY_COMPACT_THRESHOLD <= 0:
            raise ValueError("IDENTITY_COMPACT_THRESHOLD must be > 0")
        if self.IDENTITY_COMPACT_BATCH_SIZE <= 0:
            raise ValueError("IDENTITY_COMPACT_BATCH_SIZE must be > 0")
        if self.IDENTITY_COMPACT_GROUP_SIZE <= 0:
            raise ValueError("IDENTITY_COMPACT_GROUP_SIZE must be > 0")
        if self.IDENTITY_COMPACT_GROUP_SIZE > self.IDENTITY_COMPACT_BATCH_SIZE:
            raise ValueError(
                "IDENTITY_COMPACT_GROUP_SIZE must be <= IDENTITY_COMPACT_BATCH_SIZE"
            )
        if self.IDENTITY_COMPACT_THRESHOLD >= 200:
            raise ValueError(
                "IDENTITY_COMPACT_THRESHOLD must be < 200 (identity memory FIFO hard limit)"
            )
        return self


settings = Settings()
