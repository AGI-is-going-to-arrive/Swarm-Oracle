"""SwarmOracle configuration — loads from .env via pydantic-settings."""

from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    # ── LLM ──────────────────────────────────────────────
    LLM_RESPONSES_URL: str = "http://127.0.0.1:8318/v1/chat/completions"
    LLM_API_KEY: str = "sk-12345678"
    LLM_MODEL_NAME: str = "gpt-5.1-codex-mini"
    LLM_REASONING_EFFORT: str = "none"  # none | low | medium | high

    # ── Simulation ───────────────────────────────────────
    MAX_AGENTS: int = 1500  # P3-A: raised from 100 for 1000+ scale
    MAX_ROUNDS: int = 40
    MAX_BRANCHES: int = 8
    MEMORY_COMPRESS_INTERVAL: int = 5
    BRANCH_PRUNE_THRESHOLD: float = 0.05
    FORK_SENSITIVITY: float = 0.7
    DEFAULT_NUM_AGENTS: int = 20
    DEFAULT_ROUNDS: int = 10
    HIERARCHICAL_AGENT_THRESHOLD: int = 50  # P3-A: auto-enable hierarchical mode above this

    # ── Concurrency ──────────────────────────────────────
    LLM_CONCURRENCY: int = 5

    # ── Database ─────────────────────────────────────────
    DATABASE_URL: str = f"sqlite:///{(BACKEND_ROOT / 'swarmoracle.db').resolve()}"
    CHROMA_PERSIST_DIR: str = str((BACKEND_ROOT / "chroma_data").resolve())

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


settings = Settings()
