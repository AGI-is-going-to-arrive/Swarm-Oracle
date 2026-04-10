"""Shared test configuration and fixtures."""

import os
import sys

import pytest

# Ensure app package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Override .env for tests
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_swarmoracle.db")
os.environ.setdefault("LLM_RESPONSES_URL", "http://127.0.0.1:8317/v1")
os.environ.setdefault("LLM_API_KEY", "sk-12345678")
os.environ.setdefault("LLM_MODEL_NAME", "gpt-5.4-mini")
os.environ.setdefault("LLM_REASONING_EFFORT", "low")
os.environ.setdefault("LLM_REQUESTS_PER_MINUTE", "0")
os.environ.setdefault("LLM_TOKENS_PER_MINUTE", "0")
os.environ.setdefault("DEBATE_USE_LLM", "false")
os.environ.setdefault("ORACLE_CHAMBERS_USE_LLM", "false")


@pytest.fixture(autouse=True)
def setup_test_db(tmp_path, monkeypatch):
    """Create isolated SQLite + Chroma state for each test."""
    from app.config import settings
    from app.models.database import dispose_engine, init_db
    from app.services.vector_store import reset_vector_store

    db_path = tmp_path / "test_swarmoracle.db"
    db_url = f"sqlite:///{db_path}"
    chroma_dir = tmp_path / "test_chroma"

    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setenv("CHROMA_PERSIST_DIR", str(chroma_dir))
    settings.DATABASE_URL = db_url
    settings.CHROMA_PERSIST_DIR = str(chroma_dir)

    # Reset singletons so each test points at a fresh temp DB and Chroma dir.
    dispose_engine()
    reset_vector_store()

    init_db()
    yield
    dispose_engine()
    reset_vector_store()
