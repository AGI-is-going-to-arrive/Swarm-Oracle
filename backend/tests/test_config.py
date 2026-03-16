"""Tests for app.config — Settings loading."""

import os


def test_settings_defaults():
    """Settings should have sensible defaults."""
    from app.config import Settings

    s = Settings()
    assert s.LLM_RESPONSES_URL.startswith("http")
    assert s.LLM_MODEL_NAME  # not empty
    assert s.LLM_REASONING_EFFORT in ("low", "medium", "high")
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


def test_settings_cors_origins():
    """CORS_ORIGINS should be a list."""
    from app.config import Settings
    s = Settings()
    assert isinstance(s.CORS_ORIGINS, list)
    assert len(s.CORS_ORIGINS) > 0
