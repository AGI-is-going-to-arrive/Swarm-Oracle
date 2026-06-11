"""Tests for app.config — Settings loading."""

import pytest


def test_settings_defaults():
    """Settings should have sensible defaults."""
    from app.config import Settings

    s = Settings()
    assert s.LLM_RESPONSES_URL.startswith("http")
    assert s.LLM_MODEL_NAME  # not empty
    assert s.LLM_REASONING_EFFORT in ("none", "low", "medium", "high")
    assert s.LLM_REQUESTS_PER_MINUTE >= 0
    assert s.LLM_TOKENS_PER_MINUTE >= 0
    assert s.LOG_LEVEL == "INFO"
    assert s.LOG_FORMAT == "json"
    assert s.MAX_AGENTS > 0
    assert s.MAX_ROUNDS > 0
    assert s.MAX_BRANCHES > 0
    assert s.MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS >= s.MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS
    assert s.MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS >= s.MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS
    assert s.MEMORY_CROWD_MAX_RECENT <= s.MEMORY_IMPORTANT_MAX_RECENT <= s.MEMORY_CORE_MAX_RECENT
    assert s.MEMORY_IMPORTANT_CONTEXT_MAX_CHARS <= s.MEMORY_CORE_CONTEXT_MAX_CHARS
    assert 0 < s.BRANCH_PRUNE_THRESHOLD < 1
    assert 0 <= s.FORK_SENSITIVITY <= 1
    assert s.PORT > 0


def test_result_report_feature_is_enabled_by_default(monkeypatch):
    """Result Report is a default user-visible result feature."""
    monkeypatch.delenv("FEATURE_RESULT_REPORT", raising=False)

    from app.config import Settings

    s = Settings(
        _env_file=None,
        LLM_RESPONSES_URL="http://127.0.0.1:8317/v1",
        LLM_API_KEY="sk-12345678",
    )
    assert s.FEATURE_RESULT_REPORT is True


def test_settings_from_env(monkeypatch):
    """Settings should load from environment variables."""
    monkeypatch.setenv("LLM_MODEL_NAME", "test-model-name")
    monkeypatch.setenv("MAX_AGENTS", "42")
    monkeypatch.setenv("LLM_REASONING_EFFORT", "medium")
    monkeypatch.setenv("LLM_REQUESTS_PER_MINUTE", "7")
    monkeypatch.setenv("LLM_TOKENS_PER_MINUTE", "12345")

    from app.config import Settings
    s = Settings()
    assert s.LLM_MODEL_NAME == "test-model-name"
    assert s.MAX_AGENTS == 42
    assert s.LLM_REASONING_EFFORT == "medium"
    assert s.LLM_REQUESTS_PER_MINUTE == 7
    assert s.LLM_TOKENS_PER_MINUTE == 12345


def test_memory_budget_settings_from_env(monkeypatch):
    monkeypatch.setenv("MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS", "24000")
    monkeypatch.setenv("MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS", "14000")
    monkeypatch.setenv("MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS", "10000")
    monkeypatch.setenv("MEMORY_CORE_MAX_RECENT", "14")
    monkeypatch.setenv("MEMORY_IMPORTANT_MAX_RECENT", "6")
    monkeypatch.setenv("MEMORY_CROWD_MAX_RECENT", "3")
    monkeypatch.setenv("MEMORY_CORE_CONTEXT_MAX_CHARS", "5200")
    monkeypatch.setenv("MEMORY_IMPORTANT_CONTEXT_MAX_CHARS", "3600")

    from app.config import Settings

    s = Settings()
    assert s.MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS == 24000
    assert s.MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS == 14000
    assert s.MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS == 10000
    assert s.MEMORY_CORE_MAX_RECENT == 14
    assert s.MEMORY_IMPORTANT_MAX_RECENT == 6
    assert s.MEMORY_CROWD_MAX_RECENT == 3
    assert s.MEMORY_CORE_CONTEXT_MAX_CHARS == 5200
    assert s.MEMORY_IMPORTANT_CONTEXT_MAX_CHARS == 3600


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


@pytest.mark.parametrize("provider", ["tavily", "exa", "firecrawl", "xai", "searxng"])
def test_settings_accept_supported_web_search_providers(provider):
    from app.config import Settings

    s = Settings(_env_file=None, WEB_SEARCH_PROVIDER=provider)

    assert s.WEB_SEARCH_PROVIDER == provider


def test_settings_reject_native_web_search_provider():
    from app.config import Settings

    with pytest.raises(ValueError) as excinfo:
        Settings(_env_file=None, WEB_SEARCH_PROVIDER="native")

    message = str(excinfo.value)
    assert "tavily | exa | firecrawl | xai | searxng" in message
    assert (
        "'native' is no longer supported; pick a listed provider or unset "
        "WEB_SEARCH_PROVIDER"
    ) in message


def test_settings_reject_wildcard_cors_origin():
    from app.config import Settings

    with pytest.raises(ValueError, match="cannot contain '\\*'"):
        Settings(CORS_ORIGINS=["*"])


def test_settings_normalize_relative_local_paths(monkeypatch):
    """Relative local paths should resolve against backend root, not cwd."""
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./relative-dev.db")
    monkeypatch.setenv("CHROMA_PERSIST_DIR", "./relative-chroma")

    from app.config import BACKEND_ROOT, Settings

    s = Settings()
    assert s.DATABASE_URL == f"sqlite:///{(BACKEND_ROOT / 'relative-dev.db').resolve()}"
    assert s.CHROMA_PERSIST_DIR == str((BACKEND_ROOT / "relative-chroma").resolve())


def test_settings_preserve_sqlite_uri_database_url(monkeypatch):
    db_url = "sqlite:///file:/tmp/swarmoracle-uri.db?uri=true"
    monkeypatch.setenv("DATABASE_URL", db_url)

    from app.config import Settings

    s = Settings()
    assert s.DATABASE_URL == db_url


@pytest.mark.parametrize("api_key", ["sk-12345678", "your-api-key-here"])
def test_settings_reject_placeholder_key_for_non_local_llm(monkeypatch, api_key):
    monkeypatch.setenv("LLM_RESPONSES_URL", "https://api.example.com/v1/chat/completions")
    monkeypatch.setenv("LLM_API_KEY", api_key)

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


def test_settings_reject_invalid_memory_budget_relationship(monkeypatch):
    monkeypatch.setenv("MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS", "12000")
    monkeypatch.setenv("MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS", "16000")

    from app.config import Settings

    with pytest.raises(ValueError, match="MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS"):
        Settings()


def test_settings_reject_invalid_memory_tier_order(monkeypatch):
    monkeypatch.setenv("MEMORY_CORE_MAX_RECENT", "4")
    monkeypatch.setenv("MEMORY_IMPORTANT_MAX_RECENT", "6")

    from app.config import Settings

    with pytest.raises(ValueError, match="CROWD <= IMPORTANT <= CORE"):
        Settings()


def test_settings_reject_invalid_branch_prune_threshold(monkeypatch):
    monkeypatch.setenv("BRANCH_PRUNE_THRESHOLD", "1.2")

    from app.config import Settings

    with pytest.raises(ValueError, match="BRANCH_PRUNE_THRESHOLD"):
        Settings()


def test_settings_reject_invalid_fork_sensitivity(monkeypatch):
    monkeypatch.setenv("FORK_SENSITIVITY", "-0.1")

    from app.config import Settings

    with pytest.raises(ValueError, match="FORK_SENSITIVITY"):
        Settings()
