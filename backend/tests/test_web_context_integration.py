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


def _noop_background(*args, **kwargs):
    """Replacement for parse_and_run_background that does nothing."""
    return None


def _mock_family_context(*ready_families: str) -> dict[str, dict[str, object]]:
    context: dict[str, dict[str, object]] = {
        "polymarket": {
            "state": "empty",
            "configured_host": "us",
            "geo_gated": False,
            "items": [],
        },
        "finance": {"state": "empty", "items": []},
        "academic": {"state": "empty", "items": []},
        "news_deep": {"state": "empty", "items": []},
    }
    ready_items: dict[str, list[dict[str, object]]] = {
        "polymarket": [{
            "id": "polymarket-1",
            "question": "Will pigs fly?",
            "url": "https://polymarket.com/event/pigs-fly",
        }],
        "finance": [{
            "id": "finance-1",
            "title": "Market impact of flight experiments",
            "summary": "Aviation investment context.",
            "source": "Finance Wire",
            "url": "https://finance.example.com/pigs-fly",
        }],
        "academic": [{
            "id": "academic-1",
            "title": "Aerodynamics of impossible animals",
            "abstract": "Academic evidence context.",
            "url": "https://academic.example.com/pigs-fly",
        }],
        "news_deep": [{
            "id": "news-1",
            "title": "Scientists discuss speculative flight",
            "description": "News context.",
            "source": "News Deep",
            "url": "https://news.example.com/pigs-fly",
        }],
    }
    for family in ready_families:
        context[family]["state"] = "ready"
        context[family]["items"] = ready_items[family]
    return context


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
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=mock_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                new_callable=AsyncMock,
                return_value=_mock_family_context(
                    "polymarket", "finance", "academic", "news_deep",
                ),
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if pigs fly?",
                "web_search_enabled": True,
                "web_search_families": ["polymarket", "finance", "academic", "news_deep"],
            })

        assert resp.status_code == 200
        data = resp.json()
        assert data["web_search_context"] is not None
        assert data["web_search_context"]["query"] == "What if pigs fly?"
        assert len(data["web_search_context"]["snippets"]) == 2
        family_context = data["web_search_context"]["family_context"]
        assert family_context["polymarket"]["state"] == "ready"
        assert family_context["polymarket"]["geo_gated"] is False
        assert family_context["polymarket"]["items"][0]["question"]
        assert family_context["finance"]["items"][0]["title"]
        assert family_context["academic"]["items"][0]["title"]
        assert family_context["news_deep"]["items"][0]["title"]

        # Verify DB storage
        engine = get_engine()
        with Session(engine) as session:
            scenario = session.get(Scenario, data["id"])
            assert scenario is not None
            assert scenario.web_context_json is not None
            assert "pigs fly" in scenario.web_context_json
            assert '"family_context"' in scenario.web_context_json

    def test_web_search_enabled_uses_runtime_polymarket_geo_host(self, client):
        mock_result = WebSearchResult(
            query="What if non-us markets?",
            snippets=[
                WebSearchSnippet(
                    text="Regional market access changed overnight.",
                    source_url="https://example.com/geo",
                ),
            ],
            provider="searxng",
            timestamp="2026-04-19T12:00:00Z",
            cached=False,
        )

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=mock_result,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
            patch(
                "app.services.web_context.settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST",
                "non-us",
            ),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if non-us markets?",
                "web_search_enabled": True,
                "web_search_families": ["polymarket", "finance", "academic", "news_deep"],
                "web_search_provider": "searxng",
            })

        assert resp.status_code == 200
        data = resp.json()
        polymarket = data["web_search_context"]["family_context"]["polymarket"]
        assert polymarket["configured_host"] == "non-us"
        assert polymarket["geo_gated"] is True
        assert polymarket["state"] == "empty"
        assert polymarket["items"] == []

        engine = get_engine()
        with Session(engine) as session:
            scenario = session.get(Scenario, data["id"])
            assert scenario is not None
            assert scenario.web_context_json is not None
            assert '"geo_gated": true' in scenario.web_context_json.lower()

    def test_web_search_family_selection_limits_ready_cards(self, client):
        mock_result = WebSearchResult(
            query="What if only academic is selected?",
            snippets=[
                WebSearchSnippet(
                    text="Academic evidence should remain while other families stay empty.",
                    source_url="https://example.com/academic",
                ),
            ],
            provider="searxng",
            timestamp="2026-04-19T12:30:00Z",
            cached=False,
        )

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=mock_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                new_callable=AsyncMock,
                return_value=_mock_family_context("academic"),
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if only academic is selected?",
                "web_search_enabled": True,
                "web_search_families": ["academic"],
                "web_search_provider": "searxng",
            })

        assert resp.status_code == 200
        family_context = resp.json()["web_search_context"]["family_context"]
        assert family_context["academic"]["state"] == "ready"
        assert family_context["academic"]["items"]
        assert family_context["finance"]["state"] == "empty"
        assert family_context["finance"]["items"] == []
        assert family_context["news_deep"]["state"] == "empty"
        assert family_context["news_deep"]["items"] == []
        assert family_context["polymarket"]["state"] == "empty"
        assert family_context["polymarket"]["items"] == []
        assert family_context["polymarket"]["geo_gated"] is False

    def test_web_search_custom_provider_overrides_forwarded(self, client):
        mock_result = WebSearchResult(
            query="What if custom search?",
            snippets=[WebSearchSnippet(text="override result", source_url="https://exa.ai")],
            provider="exa",
            timestamp="2026-04-13T12:00:00Z",
            cached=False,
        )

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=mock_result,
            ) as mock_fetch,
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if custom search?",
                "web_search_enabled": True,
                "web_search_provider": "exa",
                "web_search_api_key": "exa-test-key",
                "web_search_base_url": "https://api.exa.ai/search",
            })

        assert resp.status_code == 200
        mock_fetch.assert_awaited_once_with(
            "What if custom search?",
            provider_override="exa",
            api_key_override="exa-test-key",
            base_url_override="https://api.exa.ai/search",
            intensity="standard",
        )

    def test_web_search_intensity_maps_to_base_family_and_background(self, client):
        mock_result = WebSearchResult(
            query="What if deep search?",
            snippets=[
                WebSearchSnippet(
                    text=f"deep result {i}",
                    source_url=f"https://exa.ai/{i}",
                )
                for i in range(10)
            ],
            provider="exa",
            timestamp="2026-04-13T12:00:00Z",
            cached=False,
        )

        def _close_background(coro):
            coro.close()
            return None

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=mock_result,
            ) as mock_fetch,
            patch(
                "app.services.web_context.fetch_family_context",
                new_callable=AsyncMock,
                return_value=_mock_family_context("finance"),
            ) as mock_family,
            patch(
                "app.api.scenarios.parse_and_run_background",
                new_callable=AsyncMock,
            ) as parse_mock,
            patch("app.api.scenarios.schedule_background_task", side_effect=_close_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if deep search?",
                "web_search_enabled": True,
                "web_search_intensity": "deep",
                "web_search_families": ["finance"],
                "web_search_provider": "exa",
                "web_search_api_key": "exa-test-key",
                "web_search_base_url": "https://api.exa.ai/search",
            })

        assert resp.status_code == 200
        mock_fetch.assert_awaited_once_with(
            "What if deep search?",
            provider_override="exa",
            api_key_override="exa-test-key",
            base_url_override="https://api.exa.ai/search",
            intensity="deep",
        )
        family_config = mock_family.call_args.kwargs["request_config"]
        assert family_config.provider == "exa"
        assert family_config.max_results == 10
        assert family_config.snippet_limit == 8
        assert parse_mock.call_args.kwargs["web_search_intensity"] == "deep"
        assert parse_mock.call_args.kwargs["web_search_max_results"] == 10
        assert parse_mock.call_args.kwargs["web_search_snippet_limit"] == 8

    def test_web_search_disabled_no_fetch(self, client):
        """web_search_enabled=false → fetch_web_context never called."""
        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
            ) as mock_fetch,
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if no search?",
                "web_search_enabled": False,
            })

        assert resp.status_code == 200
        mock_fetch.assert_not_called()

    def test_web_search_disabled_ignores_invalid_override_fields(self, client):
        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
            ) as mock_fetch,
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if disabled ignores override?",
                "web_search_enabled": False,
                "web_search_provider": "tavily",
                "web_search_base_url": "https://not-allowed.example.com/search",
                "web_search_intensity": "extreme",
            })

        assert resp.status_code == 200
        mock_fetch.assert_not_called()

    def test_web_search_default_off_no_fetch(self, client):
        """No web_search_enabled field → default off, no search."""
        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
            ) as mock_fetch,
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
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                side_effect=Exception("Search API down"),
            ),
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
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "What if search returns nothing?",
                "web_search_enabled": True,
            })

        assert resp.status_code == 200
        data = resp.json()
        assert data.get("web_search_context") is None


class TestSourceFamilyShortCircuitBaseline:
    """P0-5 baseline + P1-4 fixed behavior tests for the source-family
    short-circuit logic at `backend/app/api/scenarios.py:create_scenario`.

    P0 baseline (now retired):
    - fetch_web_context() was called first; only if its result was non-None
      AND FEATURE_NEW_SOURCES was true AND req.web_search_families was truthy
      did fetch_family_context() run.
    - Both calls shared the SAME try-block — a family exception swallowed the
      base web_context_json.

    P1-4 fix (current behavior asserted below):
    - Base search and family search live in SEPARATE try-blocks.
    - Family search may run even when base search returns None.
    - A family exception does NOT discard a successful base result.
    """

    def test_family_search_runs_when_base_returns_none(self, client):
        """P1-4: fetch_web_context=None → fetch_family_context now still runs
        (independent execution). The result is exposed through the family
        envelope, even though the base snippets list is empty."""
        family_called = {"called": False}

        async def _mock_family(*a, **kw):
            family_called["called"] = True
            return _mock_family_context("finance")

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_mock_family,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "test family runs on base None",
                "web_search_enabled": True,
                "web_search_families": ["finance"],
            })

        assert resp.status_code == 200
        assert family_called["called"] is True, (
            "P1-4: fetch_family_context must run independently of base result"
        )
        data = resp.json()
        # Base search returned None but family succeeded → ctx is non-None
        # and the family envelope is surfaced.
        assert data.get("web_search_context") is not None
        assert data["web_search_context"]["snippets"] == []
        assert data["web_search_context"]["family_context"]["finance"]["state"] == "ready"

    def test_family_search_skipped_when_feature_disabled(self, client):
        """FEATURE_NEW_SOURCES=false → family search must be skipped even when
        base result is non-None and families are requested."""
        base_result = WebSearchResult(
            query="feature gated",
            provider="tavily",
            timestamp="2026-04-28T00:00:00Z",
            cached=False,
            snippets=[
                WebSearchSnippet(text="Base hit", source_url="https://example.com/base"),
            ],
        )

        family_called = {"called": False}

        async def _mock_family(*a, **kw):
            family_called["called"] = True
            return {}

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=base_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_mock_family,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", False),
        ):
            resp = client.post("/api/scenario", json={
                "question": "test short circuit on feature flag",
                "web_search_enabled": True,
                "web_search_families": ["finance", "academic"],
            })

        assert resp.status_code == 200
        assert family_called["called"] is False, (
            "fetch_family_context must not run when FEATURE_NEW_SOURCES is disabled"
        )
        # Base context should still be persisted/returned.
        data = resp.json()
        assert data.get("web_search_context") is not None
        assert data["web_search_context"]["query"] == "feature gated"
        # family_context must remain unset/None when feature is disabled.
        assert data["web_search_context"].get("family_context") is None

    def test_family_search_skipped_when_families_empty(self, client):
        """FEATURE_NEW_SOURCES=true but empty families list → family search
        must still be skipped (truthiness gate at line 745)."""
        base_result = WebSearchResult(
            query="empty families",
            provider="tavily",
            timestamp="2026-04-28T00:00:00Z",
            cached=False,
            snippets=[
                WebSearchSnippet(text="Base only", source_url="https://example.com/base"),
            ],
        )

        family_called = {"called": False}

        async def _mock_family(*a, **kw):
            family_called["called"] = True
            return {}

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=base_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_mock_family,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "test short circuit on empty families",
                "web_search_enabled": True,
                "web_search_families": [],
            })

        assert resp.status_code == 200
        assert family_called["called"] is False
        assert resp.json().get("web_search_context") is not None

    def test_selected_families_are_passed_to_background_parse(self, client):
        """Selected source families must survive the create route handoff.

        The simulator uses the parsed context to decide whether native provider
        search should receive server-controlled domain filters.
        """
        base_result = WebSearchResult(
            query="native handoff",
            provider="tavily",
            timestamp="2026-05-14T00:00:00Z",
            cached=False,
            snippets=[WebSearchSnippet(text="Base", source_url="https://example.com/base")],
        )

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=base_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                new_callable=AsyncMock,
                return_value=_mock_family_context("finance", "academic"),
            ),
            patch("app.api.scenarios.parse_and_run_background") as parse_mock,
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "native handoff",
                "web_search_enabled": True,
                "web_search_families": ["finance", "academic"],
            })

        assert resp.status_code == 200
        assert parse_mock.call_args is not None
        assert parse_mock.call_args.kwargs["web_search_families"] == [
            "finance",
            "academic",
        ]

    def test_family_exception_preserves_base_context(self, client):
        """P1-4 fix: when fetch_family_context raises, the base
        web_context_json is preserved.

        Previously (P0 baseline) the shared try-block discarded base context
        whenever family search threw. P1-4 split base and family into
        independent try-blocks; verify the new contract here."""
        base_result = WebSearchResult(
            query="base survives?",
            provider="tavily",
            timestamp="2026-04-28T00:00:00Z",
            cached=False,
            snippets=[
                WebSearchSnippet(text="Base snippet", source_url="https://example.com/base"),
            ],
        )

        async def _failing_family(*a, **kw):
            raise RuntimeError("family search exploded")

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=base_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_failing_family,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "test family exception preserves base",
                "web_search_enabled": True,
                "web_search_families": ["finance"],
            })

        assert resp.status_code == 200
        data = resp.json()
        # P1-4: base context survives a family exception.
        assert data.get("web_search_context") is not None, (
            "P1-4: base context must be preserved even when family search raises"
        )
        assert data["web_search_context"]["query"] == "base survives?"
        snippets = data["web_search_context"]["snippets"]
        assert any(s.get("text") == "Base snippet" for s in snippets)
        # family_context should be absent / empty because family fetch failed.
        family_context = data["web_search_context"].get("family_context") or {}
        assert not any(
            (entry or {}).get("state") == "ready" for entry in family_context.values()
        ), "Family entries must not be marked ready when fetch_family_context raised"

        # Confirm DB persists the surviving base context.
        engine = get_engine()
        with Session(engine) as session:
            scenario = session.get(Scenario, data["id"])
            assert scenario is not None
            assert scenario.web_context_json is not None
            assert "base survives?" in scenario.web_context_json


class TestSourceFamilyIndependentExecution:
    """P1-4: Base search and family search run in independent try-blocks.

    These tests lock the four (base_succeeds, family_succeeds) combinations:
    - base None  / family ready   → context exposes family only
    - base ready / family raises  → context exposes base only
    - base ready / family ready   → both surfaced together
    - base raises / family raises → no context, scenario still created
    """

    def test_family_runs_when_base_returns_none(self, client):
        """Base None + family success → scenario has family_context."""
        async def _family_ok(*a, **kw):
            return _mock_family_context("finance")

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_family_ok,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "base none, family ok",
                "web_search_enabled": True,
                "web_search_families": ["finance"],
            })

        assert resp.status_code == 200
        data = resp.json()
        ctx = data.get("web_search_context")
        assert ctx is not None
        assert ctx["snippets"] == []
        assert ctx["family_context"]["finance"]["state"] == "ready"
        assert ctx["family_context"]["finance"]["items"][0]["title"]

        engine = get_engine()
        with Session(engine) as session:
            scenario = session.get(Scenario, data["id"])
            assert scenario is not None
            assert scenario.web_context_json is not None
            assert '"family_context"' in scenario.web_context_json

    def test_base_preserved_when_family_fails(self, client):
        """Base success + family exception → scenario keeps base context."""
        base_result = WebSearchResult(
            query="base only please",
            provider="tavily",
            timestamp="2026-05-13T00:00:00Z",
            cached=False,
            snippets=[
                WebSearchSnippet(text="Resilient base", source_url="https://example.com/base"),
            ],
        )

        async def _family_fail(*a, **kw):
            raise RuntimeError("family exploded")

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=base_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_family_fail,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "base ok, family fails",
                "web_search_enabled": True,
                "web_search_families": ["finance"],
            })

        assert resp.status_code == 200
        data = resp.json()
        ctx = data.get("web_search_context")
        assert ctx is not None
        assert ctx["query"] == "base only please"
        assert any(s.get("text") == "Resilient base" for s in ctx["snippets"])
        # No family entry was successfully filled.
        family_context = ctx.get("family_context") or {}
        assert not any(
            (entry or {}).get("state") == "ready" for entry in family_context.values()
        )

    def test_both_succeed_merged(self, client):
        """Base + family both succeed → merged result with both surfaces."""
        base_result = WebSearchResult(
            query="merged path",
            provider="tavily",
            timestamp="2026-05-13T00:00:00Z",
            cached=False,
            snippets=[
                WebSearchSnippet(text="Base hit", source_url="https://example.com/base"),
            ],
        )

        async def _family_ok(*a, **kw):
            return _mock_family_context("finance", "academic")

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                new_callable=AsyncMock,
                return_value=base_result,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_family_ok,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "base ok, family ok",
                "web_search_enabled": True,
                "web_search_families": ["finance", "academic"],
            })

        assert resp.status_code == 200
        data = resp.json()
        ctx = data.get("web_search_context")
        assert ctx is not None
        assert any(s.get("text") == "Base hit" for s in ctx["snippets"])
        family_context = ctx["family_context"]
        assert family_context["finance"]["state"] == "ready"
        assert family_context["academic"]["state"] == "ready"
        assert family_context["polymarket"]["state"] == "empty"
        assert family_context["news_deep"]["state"] == "empty"

    def test_both_fail_no_web_context(self, client):
        """Both base and family fail → no web_context_json, scenario still created."""
        async def _base_fail(*a, **kw):
            raise RuntimeError("base exploded")

        async def _family_fail(*a, **kw):
            raise RuntimeError("family exploded")

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                side_effect=_base_fail,
            ),
            patch(
                "app.services.web_context.fetch_family_context",
                side_effect=_family_fail,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
            patch("app.api.scenarios.settings.FEATURE_NEW_SOURCES", True),
        ):
            resp = client.post("/api/scenario", json={
                "question": "both fail",
                "web_search_enabled": True,
                "web_search_families": ["finance"],
            })

        assert resp.status_code == 200
        data = resp.json()
        assert data.get("web_search_context") is None

        engine = get_engine()
        with Session(engine) as session:
            scenario = session.get(Scenario, data["id"])
            assert scenario is not None
            assert scenario.web_context_json is None


class TestBYOKKeyIsolation:
    """P0-4: Verify LLM BYOK key/base_url never leaks into web search path,
    and web search key never leaks into LLM path.

    Locks the contract at:
    - `app/api/scenarios.py:738-743` — web search uses req.web_search_*
    - `app/services/web_context.py:361-375` — `_resolve_request_config()`
      only reads WEB_SEARCH_* settings
    - `app/api/scenarios.py:798+` — LLM call uses req.llm_api_key
    """

    def test_llm_key_not_passed_to_web_search(self, client):
        """llm_api_key present + web_search_api_key absent →
        fetch_web_context must NOT receive the LLM key/base_url."""
        captured_config: dict[str, object] = {}

        async def _mock_fetch(
            question,
            *,
            provider_override=None,
            api_key_override=None,
            base_url_override=None,
        ):
            captured_config["question"] = question
            captured_config["provider"] = provider_override
            captured_config["api_key"] = api_key_override
            captured_config["base_url"] = base_url_override
            return None

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                side_effect=_mock_fetch,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "test BYOK isolation",
                "web_search_enabled": True,
                "llm_api_key": "sk-llm-secret-key",
                "llm_base_url": "https://api.openai.com/v1",
                # NO web_search_api_key or web_search_base_url
            })

        assert resp.status_code == 200
        # LLM key/base_url must NOT have leaked into the web search path.
        assert captured_config.get("api_key") != "sk-llm-secret-key"
        assert captured_config.get("base_url") != "https://api.openai.com/v1"
        # With no web_search_* overrides, the overrides should be None (settings fallback).
        assert captured_config.get("api_key") is None
        assert captured_config.get("base_url") is None

    def test_web_search_key_not_passed_to_llm(self, client):
        """web_search_api_key present + llm_api_key absent → web search receives
        the search key while the LLM path must NOT see it.

        We assert schema-level separation: the request accepts both fields
        independently and the search path receives only the search key. The
        Tavily base URL is paired with an explicit provider so this contract
        remains stable when the server default provider is SearXNG."""
        captured_config: dict[str, object] = {}

        async def _mock_fetch(
            question,
            *,
            provider_override=None,
            api_key_override=None,
            base_url_override=None,
            intensity=None,
        ):
            captured_config["api_key"] = api_key_override
            captured_config["base_url"] = base_url_override
            captured_config["provider"] = provider_override
            captured_config["intensity"] = intensity
            return None

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                side_effect=_mock_fetch,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "test reverse isolation",
                "web_search_enabled": True,
                "web_search_provider": "tavily",
                "web_search_api_key": "tavily-search-key",
                "web_search_base_url": "https://api.tavily.com",
                # NO llm_api_key
            })

        assert resp.status_code == 200
        # Web search path receives its own key.
        assert captured_config.get("api_key") == "tavily-search-key"
        assert captured_config.get("provider") == "tavily"
        assert captured_config.get("base_url") == "https://api.tavily.com"
        assert captured_config.get("intensity") == "standard"

    def test_both_byok_keys_stay_separate(self, client):
        """Both BYOK keys present → web search path must only receive the
        web search key (not the LLM key)."""
        search_captured: dict[str, object] = {}

        async def _mock_fetch(
            question,
            *,
            provider_override=None,
            api_key_override=None,
            base_url_override=None,
            intensity=None,
        ):
            search_captured["api_key"] = api_key_override
            search_captured["base_url"] = base_url_override
            search_captured["provider"] = provider_override
            search_captured["intensity"] = intensity
            return None

        with (
            patch(
                "app.services.web_context.fetch_web_context",
                side_effect=_mock_fetch,
            ),
            patch("app.api.scenarios.parse_and_run_background", side_effect=_noop_background),
        ):
            resp = client.post("/api/scenario", json={
                "question": "test dual BYOK",
                "web_search_enabled": True,
                "llm_api_key": "sk-llm-key",
                "llm_base_url": "https://api.openai.com/v1",
                "web_search_api_key": "tavily-key",
                "web_search_provider": "tavily",
            })

        assert resp.status_code == 200
        # Web search must receive the web search key + provider, never the LLM key.
        assert search_captured.get("api_key") == "tavily-key"
        assert search_captured.get("provider") == "tavily"
        assert search_captured.get("intensity") == "standard"
        assert search_captured.get("api_key") != "sk-llm-key"
        assert search_captured.get("base_url") != "https://api.openai.com/v1"


@pytest.mark.asyncio
async def test_parse_and_run_background_persists_selected_web_search_families(monkeypatch):
    """The parsed context is the simulator's source for native search domains."""
    from app.api import helpers as helpers_api

    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question="native search handoff")
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id

    async def _fake_parse_question(*args, **kwargs):
        return {
            "setting": {},
            "key_variable": "native search handoff",
            "initial_title": "Native Search Handoff",
            "agents": [{
                "name": "Analyst",
                "role": "researcher",
                "persona": "careful",
                "tier": "CORE",
                "stance": "",
            }],
            "groups": [],
            "simulation_rounds": 1,
        }

    async def _fake_run_sim_background(*args, **kwargs):
        helpers_api._parse_phase_simulations.discard(scenario_id)
        helpers_api._running_simulations.discard(scenario_id)
        helpers_api.clear_cancel_token(scenario_id)
        return None

    monkeypatch.setattr(helpers_api, "parse_question", _fake_parse_question)
    monkeypatch.setattr(helpers_api, "run_sim_background", _fake_run_sim_background)

    await helpers_api.parse_and_run_background(
        scenario_id,
        question="native search handoff",
        num_agents=1,
        mode="raw",
        hierarchical=False,
        rounds=1,
        visualization_enabled=False,
        reasoning_effort=None,
        temperature=None,
        branch_sensitivity=None,
        fork_prompt_variant=None,
        fork_detector_active_branch_limit=None,
        user_id=None,
        llm_api_key=None,
        llm_base_url=None,
        llm_model=None,
        llm_requests_per_minute=None,
        llm_tokens_per_minute=None,
        disable_user_quota=None,
        web_search_families=["finance", "academic"],
        web_search_intensity="deep",
        web_search_max_results=10,
        web_search_snippet_limit=8,
    )

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        assert scenario.parsed_context["web_search_families"] == ["finance", "academic"]
        assert scenario.parsed_context["web_search_intensity"] == "deep"
        assert scenario.parsed_context["web_search_max_results"] == 10
        assert scenario.parsed_context["web_search_snippet_limit"] == 8
