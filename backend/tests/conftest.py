"""Shared test configuration and fixtures."""

import os
import sys

import pytest

# Ensure app package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Override .env for tests
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_swarmoracle.db")
os.environ.setdefault("LLM_RESPONSES_URL", "https://api.edgefn.net/v1")
os.environ.setdefault("LLM_API_KEY", "sk-1XtuRWNIfkcKpcUoA08aE55eBfBb4fEa8332Be93C0A57fA3")
os.environ.setdefault("LLM_MODEL_NAME", "MiniMax-M2.5")
os.environ.setdefault("LLM_REASONING_EFFORT", "low")
os.environ.setdefault("LLM_REQUESTS_PER_MINUTE", "10")
os.environ.setdefault("LLM_TOKENS_PER_MINUTE", "100000")
os.environ.setdefault("DEBATE_USE_LLM", "false")
os.environ.setdefault("ORACLE_CHAMBERS_USE_LLM", "false")


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    """Create an isolated SQLite database for each test."""
    from app.config import settings
    from app.models.database import dispose_engine, init_db

    db_path = tmp_path / "test_swarmoracle.db"
    db_url = f"sqlite:///{db_path}"

    monkeypatch.setenv("DATABASE_URL", db_url)
    settings.DATABASE_URL = db_url

    # Reset the singleton engine so each test points at a fresh temp DB.
    dispose_engine()

    init_db()
    yield
    dispose_engine()
