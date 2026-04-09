"""SwarmOracle configuration — loads from .env via pydantic-settings."""

from pathlib import Path
from urllib.parse import urlparse

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
_LOCAL_LLM_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal", "::1"}
_PLACEHOLDER_LLM_API_KEYS = {"", "sk-12345678"}


def _is_local_llm_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").strip().lower()
    return hostname in _LOCAL_LLM_HOSTS


class Settings(BaseSettings):
    # ── LLM ──────────────────────────────────────────────
    LLM_RESPONSES_URL: str = "http://127.0.0.1:8317/v1"
    LLM_API_KEY: str = "sk-12345678"
    LLM_MODEL_NAME: str = "gpt-5.4-mini"
    LLM_REASONING_EFFORT: str = "none"  # none | low | medium | high
    LLM_REQUESTS_PER_MINUTE: int = 0
    LLM_TOKENS_PER_MINUTE: int = 0

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
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: str = "json"  # json | plain
    EXPOSE_API_DOCS: bool = False  # Separate toggle for /docs, /redoc, /openapi.json

    # ── Database ─────────────────────────────────────────
    DATABASE_URL: str = f"sqlite:///{(BACKEND_ROOT / 'swarmoracle.db').resolve()}"
    CHROMA_PERSIST_DIR: str = str((BACKEND_ROOT / "chroma_data").resolve())

    # ── Web Search Enhancement ────────────────────────────
    ENABLE_WEB_SEARCH: bool = False
    WEB_SEARCH_PROVIDER: str = "tavily"  # tavily | exa | searxng | brave | native
    WEB_SEARCH_API_KEY: str = ""
    WEB_SEARCH_MAX_RESULTS: int = 5
    WEB_SEARCH_TIMEOUT_SECONDS: float = 8.0
    WEB_SEARCH_CACHE_TTL_SECONDS: int = 300
    SEARXNG_URL: str = "http://localhost:8888"

    # ── Phase 3 Feature Flags ────────────────────────────
    FEATURE_CUSTOM_AGENTS: bool = False
    FEATURE_AGENT_IDENTITY: bool = False
    FEATURE_CAUSAL_GRAPH: bool = False
    FEATURE_COUNTERFACTUAL_REPLAY: bool = False
    FEATURE_FACTIONS: bool = False
    FEATURE_ARGUMENT_MAP: bool = False

    # ── Auth ─────────────────────────────────────────────
    SESSION_SECRET: str = ""  # If set, enables lightweight session-token auth

    # ── Server ───────────────────────────────────────────
    HOST: str = "0.0.0.0"
    PORT: int = 18927
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:9528", "http://localhost:18928"]

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
    )

    @field_validator("DATABASE_URL", mode="after")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        prefix = "sqlite:///"
        if not value.startswith(prefix):
            return value

        path_part = value[len(prefix):]
        if not path_part or path_part == ":memory:":
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

    @model_validator(mode="after")
    def validate_llm_runtime_settings(self) -> "Settings":
        model_name = self.LLM_MODEL_NAME.strip()
        if not model_name:
            raise ValueError("LLM_MODEL_NAME cannot be empty")
        self.LLM_MODEL_NAME = model_name

        api_key = self.LLM_API_KEY.strip()
        if not _is_local_llm_url(self.LLM_RESPONSES_URL) and api_key in _PLACEHOLDER_LLM_API_KEYS:
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
        return self


settings = Settings()
