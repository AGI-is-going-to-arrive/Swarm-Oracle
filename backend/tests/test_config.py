"""Tests for app.config — Settings loading."""

import pytest


def test_settings_defaults():
    """Settings should have sensible defaults."""
    from app.config import Settings

    s = Settings()
    assert s.LLM_RESPONSES_URL.startswith("http")
    assert s.LLM_MODEL_NAME  # not empty
    assert s.LLM_REASONING_EFFORT in ("none", "low", "medium", "high")
    assert s.LOG_LEVEL == "INFO"
    assert s.LOG_FORMAT == "json"
    assert s.MAX_AGENTS > 0
    assert s.MAX_ROUNDS > 0
    assert s.MAX_BRANCHES > 0
    assert 0 < s.BRANCH_PRUNE_THRESHOLD < 1
    assert 0 <= s.FORK_SENSITIVITY <= 1
    assert s.PORT > 0


def test_settings_from_env(monkeypatch):
    """Settings should load from environment variables."""
    monkeypatch.setenv("LLM_MODEL_NAME", "test-model-name")
    monkeypatch.setenv("MAX_AGENTS", "42")
    monkeypatch.setenv("LLM_REASONING_EFFORT", "medium")

    from app.config import Settings
    s = Settings()
    assert s.LLM_MODEL_NAME == "test-model-name"
    assert s.MAX_AGENTS == 42
    assert s.LLM_REASONING_EFFORT == "medium"


def test_settings_normalize_log_config(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "debug")
    monkeypatch.setenv("LOG_FORMAT", "PLAIN")

    from app.config import Settings

    s = Settings()
    assert s.LOG_LEVEL == "DEBUG"
    assert s.LOG_FORMAT == "plain"


def test_settings_cors_origins():
    """CORS_ORIGINS should be a list."""
    from app.config import Settings
    s = Settings()
    assert isinstance(s.CORS_ORIGINS, list)
    assert len(s.CORS_ORIGINS) > 0


def test_settings_normalize_relative_local_paths(monkeypatch):
    """Relative local paths should resolve against backend root, not cwd."""
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./relative-dev.db")
    monkeypatch.setenv("CHROMA_PERSIST_DIR", "./relative-chroma")

    from app.config import BACKEND_ROOT, Settings

    s = Settings()
    assert s.DATABASE_URL == f"sqlite:///{(BACKEND_ROOT / 'relative-dev.db').resolve()}"
    assert s.CHROMA_PERSIST_DIR == str((BACKEND_ROOT / "relative-chroma").resolve())


def test_settings_reject_placeholder_key_for_non_local_llm(monkeypatch):
    monkeypatch.setenv("LLM_RESPONSES_URL", "https://api.example.com/v1/chat/completions")
    monkeypatch.setenv("LLM_API_KEY", "sk-12345678")

    from app.config import Settings

    with pytest.raises(ValueError, match="non-placeholder value"):
        Settings()


def test_settings_allow_placeholder_key_for_local_gateway(monkeypatch):
    monkeypatch.setenv("LLM_RESPONSES_URL", "http://host.docker.internal:8318/v1/chat/completions")
    monkeypatch.setenv("LLM_API_KEY", "sk-12345678")

    from app.config import Settings

    s = Settings()
    assert s.LLM_API_KEY == "sk-12345678"


def test_settings_reject_blank_model_name(monkeypatch):
    monkeypatch.setenv("LLM_MODEL_NAME", "   ")

    from app.config import Settings

    with pytest.raises(ValueError, match="LLM_MODEL_NAME cannot be empty"):
        Settings()


def test_settings_reject_invalid_log_level(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "verbose")

    from app.config import Settings

    with pytest.raises(ValueError, match="LOG_LEVEL"):
        Settings()


def test_settings_reject_invalid_log_format(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "xml")

    from app.config import Settings

    with pytest.raises(ValueError, match="LOG_FORMAT"):
        Settings()
