"""Tests for app.config — Settings loading."""

import pytest
from pydantic import ValidationError


def test_settings_defaults():
    """Settings should have sensible defaults."""
    from app.config import DEFAULT_LLM_RESPONSES_URL, Settings

    s = Settings(_env_file=None)
    assert s.LLM_RESPONSES_URL == DEFAULT_LLM_RESPONSES_URL
    assert s.LLM_MODEL_NAME  # not empty
    assert s.LLM_REASONING_EFFORT in ("none", "low", "medium", "high")
    assert s.LLM_REQUESTS_PER_MINUTE >= 0
    assert s.LLM_TOKENS_PER_MINUTE >= 0
    assert s.LLM_EXTRA_ALLOWED_HOSTS == ""
    assert s.LLM_ALLOW_PRIVATE_BYOK_HOSTS is False
    assert s.LLM_ALLOW_LOCAL_BYOK_HOSTS is True
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
    assert s.HOST == "127.0.0.1"
    assert s.PORT > 0


def test_relative_samples_dir_resolves_from_repository_root():
    from app.config import REPO_ROOT, Settings

    s = Settings(_env_file=None, SAMPLES_DIR="local-samples")

    assert s.SAMPLES_DIR == (REPO_ROOT / "local-samples").resolve()


@pytest.mark.parametrize("sim_rounds", [3, 4])
def test_short_branch_compression_keeps_default_cadence(monkeypatch, sim_rounds):
    """Short simulations should not trigger extra LLM compression calls by default."""
    from app.config import effective_memory_compress_interval, settings

    monkeypatch.setattr(settings, "MEMORY_COMPRESS_INTERVAL", 5)
    monkeypatch.setattr(settings, "MEMORY_COMPRESS_SHORT_BRANCH_INTERVAL", 2)
    monkeypatch.setattr(settings, "MEMORY_COMPRESS_SHORT_BRANCH_MAX_ROUNDS", 4)

    assert effective_memory_compress_interval(sim_rounds) == 5


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


def test_agent_turn_timeout_contract(monkeypatch):
    from app.config import Settings

    timeout_fields = (
        "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_TOTAL_TIMEOUT_SECONDS",
    )
    for name in timeout_fields:
        monkeypatch.delenv(name, raising=False)

    defaults = Settings(_env_file=None)
    assert (
        defaults.AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS,
        defaults.AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS,
        defaults.AGENT_TURN_TOTAL_TIMEOUT_SECONDS,
    ) == (45.0, 120.0, 180.0)

    monkeypatch.setenv("AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS", "91.5")
    monkeypatch.setenv("AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS", "121")
    monkeypatch.setenv("AGENT_TURN_TOTAL_TIMEOUT_SECONDS", "240")

    configured = Settings(_env_file=None)
    assert (
        configured.AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS,
        configured.AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS,
        configured.AGENT_TURN_TOTAL_TIMEOUT_SECONDS,
    ) == (91.5, 121.0, 240.0)


@pytest.mark.parametrize("value", [0, -1, float("inf"), float("-inf"), float("nan")])
@pytest.mark.parametrize(
    "field",
    [
        "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_TOTAL_TIMEOUT_SECONDS",
    ],
)
def test_agent_turn_timeouts_reject_non_positive_or_non_finite(monkeypatch, field, value):
    from app.config import Settings

    for name in (
        "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS",
        "AGENT_TURN_TOTAL_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: value})


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.10", "api.example.com"])
def test_development_allows_empty_auth_for_any_bind_host_with_warning(host, caplog):
    from app.config import Settings, validate_secure_runtime_settings

    s = Settings(
        _env_file=None,
        LLM_RESPONSES_URL="http://127.0.0.1:8317/v1",
        LLM_API_KEY="sk-12345678",
        ENV="development",
        HOST=host,
        SESSION_SECRET="",
        ADMIN_TOKEN="",
    )

    validate_secure_runtime_settings(s)

    assert "SESSION_SECRET is empty" in caplog.text
    assert host in caplog.text


def test_production_requires_session_secret():
    from app.config import Settings, validate_secure_runtime_settings

    s = Settings(
        _env_file=None,
        LLM_RESPONSES_URL="http://127.0.0.1:8317/v1",
        LLM_API_KEY="sk-12345678",
        ENV="production",
        HOST="127.0.0.1",
        SESSION_SECRET="",
        ADMIN_TOKEN="admin-token",
    )

    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        validate_secure_runtime_settings(s)


def test_production_requires_admin_token():
    from app.config import Settings, validate_secure_runtime_settings

    s = Settings(
        _env_file=None,
        LLM_RESPONSES_URL="http://127.0.0.1:8317/v1",
        LLM_API_KEY="sk-12345678",
        ENV="production",
        HOST="127.0.0.1",
        SESSION_SECRET="session-secret",
        ADMIN_TOKEN="",
    )

    with pytest.raises(RuntimeError, match="ADMIN_TOKEN"):
        validate_secure_runtime_settings(s)


def test_production_empty_auth_fails_during_fastapi_startup(monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "ENV", "production")
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    monkeypatch.setattr(settings, "ADMIN_TOKEN", "")

    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        with TestClient(app):
            pass


def test_local_bind_allows_empty_auth_with_warning(caplog):
    from app.config import Settings, validate_secure_runtime_settings

    s = Settings(
        _env_file=None,
        LLM_RESPONSES_URL="http://127.0.0.1:8317/v1",
        LLM_API_KEY="sk-12345678",
        HOST="127.0.0.1",
        SESSION_SECRET="",
        ADMIN_TOKEN="",
    )

    validate_secure_runtime_settings(s)

    assert "SESSION_SECRET is empty" in caplog.text


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "localhost"])
def test_loopback_and_localhost_allow_empty_auth_with_warning(host, caplog):
    from app.config import Settings, validate_secure_runtime_settings

    s = Settings(
        _env_file=None,
        LLM_RESPONSES_URL="http://127.0.0.1:8317/v1",
        LLM_API_KEY="sk-12345678",
        HOST=host,
        SESSION_SECRET="",
        ADMIN_TOKEN="",
    )

    validate_secure_runtime_settings(s)

    assert "SESSION_SECRET is empty" in caplog.text
    assert host in caplog.text


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


def test_settings_normalize_extra_llm_allowed_hosts():
    from app.config import Settings

    s = Settings(
        _env_file=None,
        LLM_RESPONSES_URL="http://127.0.0.1:8317/v1",
        LLM_API_KEY="sk-12345678",
        LLM_EXTRA_ALLOWED_HOSTS=" API.Custom.EXAMPLE, bücher.example, api.custom.example ",
    )

    assert s.LLM_EXTRA_ALLOWED_HOSTS == "api.custom.example,xn--bcher-kva.example"


@pytest.mark.parametrize(
    ("base_url", "api_key", "expected"),
    [
        ("http://127.0.0.1:8317/v1", "sk-12345678", False),
        ("http://127.0.0.1:8317/v1/", "sk-12345678", False),
        ("http://localhost:8317/v1", "", False),
        ("http://host.docker.internal:8317/v1", "", False),
        ("https://api.openai.com/v1", "your-api-key-here", True),
        ("http://127.0.0.1:8317/v1", "your-api-key-here", False),
        ("http://127.0.0.1:8317/v1", "", False),
        ("http://127.0.0.1:8317/v1", "sk-real-configured-key", True),
        ("http://127.0.0.1:11434/v1", "sk-12345678", True),
    ],
)
def test_static_llm_configured_truth_table(base_url, api_key, expected):
    from app.config import is_static_llm_configured

    assert is_static_llm_configured(base_url=base_url, api_key=api_key) is expected


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
