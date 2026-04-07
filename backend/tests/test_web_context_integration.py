"""Integration tests for Web Search Enhancement — Phase 2.

Tests the full pipeline: POST /api/scenario with web_search_enabled →
fetch_web_context → store in DB → return in response.

All tests mock parse_and_run_background to make POST /api/scenario
deterministically return 200, removing conditional assertion branches.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.main import app
from app.models import Scenario
from app.models.database import get_engine
from app.services.web_context import WebSearchResult, WebSearchSnippet


@pytest.fixture()
def client():
    return TestClient(app)


def _noop_background(**kwargs):
    """Replacement for parse_and_run_background that does nothing."""
    async def _noop(*a, **kw):
        pass
    return _noop(*(), **{})


class TestCreateScenarioWithWebSearch:
    """All tests patch parse_and_run_background → noop so POST /api/scenario
    always returns 200 without needing a reachable LLM."""

    def test_web_search_enabled_stores_context(self, client):
        """web_search_enabled=true → web_context_json stored + returned in response."""
        mock_result = WebSearchResult(
            query="What if pigs fly?",
            snippets=[
                WebSearchSnippet(text="Pigs cannot fly naturally", source_url="https://science.com"),
                WebSearchSnippet(text="Aviation experiments", source_url="https://flight.com"),
            ],
            provider="tavily",
            timestamp="2026-04-07T12:00:00Z",
            cached=False,
        )

        with (
            patch("app.services.web_context.fetch_web_context", new_callable=AsyncMock, return_value=mock_result),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if pigs fly?",
                "web_search_enabled": True,
            })

        assert resp.status_code == 200
        data = resp.json()
        assert data["web_search_context"] is not None
        assert data["web_search_context"]["query"] == "What if pigs fly?"
        assert len(data["web_search_context"]["snippets"]) == 2

        # Verify DB storage
        engine = get_engine()
        with Session(engine) as session:
            scenario = session.get(Scenario, data["id"])
            assert scenario is not None
            assert scenario.web_context_json is not None
            assert "pigs fly" in scenario.web_context_json

    def test_web_search_disabled_no_fetch(self, client):
        """web_search_enabled=false → fetch_web_context never called."""
        with (
            patch("app.services.web_context.fetch_web_context", new_callable=AsyncMock) as mock_fetch,
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if no search?",
                "web_search_enabled": False,
            })

        assert resp.status_code == 200
        mock_fetch.assert_not_called()

    def test_web_search_default_off_no_fetch(self, client):
        """No web_search_enabled field → default off, no search."""
        with (
            patch("app.services.web_context.fetch_web_context", new_callable=AsyncMock) as mock_fetch,
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if default?",
            })

        assert resp.status_code == 200
        mock_fetch.assert_not_called()

    def test_web_search_failure_does_not_block(self, client):
        """Search exception → scenario still created with web_search_context=None."""
        with (
            patch("app.services.web_context.fetch_web_context", new_callable=AsyncMock, side_effect=Exception("Search API down")),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if search fails?",
                "web_search_enabled": True,
            })

        assert resp.status_code == 200
        data = resp.json()
        assert data.get("web_search_context") is None

    def test_web_search_returns_none_gracefully(self, client):
        """fetch_web_context returns None → scenario created, no context."""
        with (
            patch("app.services.web_context.fetch_web_context", new_callable=AsyncMock, return_value=None),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if search returns nothing?",
                "web_search_enabled": True,
            })

        assert resp.status_code == 200
        data = resp.json()
        assert data.get("web_search_context") is None
