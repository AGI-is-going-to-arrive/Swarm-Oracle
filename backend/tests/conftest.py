"""Shared test configuration and fixtures."""

import os
import sys

import pytest

# Ensure app package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Override .env for tests
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_swarmoracle.db")
os.environ.setdefault("LLM_RESPONSES_URL", "http://127.0.0.1:8317/v1/responses")
os.environ.setdefault("LLM_API_KEY", "sk-12345678")
os.environ.setdefault("LLM_MODEL_NAME", "gpt-5.2")
os.environ.setdefault("LLM_REASONING_EFFORT", "low")


@pytest.fixture(autouse=True)
def setup_test_db():
    """Create a fresh test database for each test."""
    from app.models.database import get_engine, init_db
    from sqlmodel import SQLModel

    # Force a fresh engine for tests
    import app.models.database as db_mod
    db_mod._engine = None
    os.environ["DATABASE_URL"] = "sqlite:///./test_swarmoracle.db"

    # Drop existing tables first, then create fresh ones
    engine = get_engine()
    SQLModel.metadata.drop_all(engine)
    init_db()
    yield
    # Cleanup
    try:
        os.remove("./test_swarmoracle.db")
    except OSError:
        pass
