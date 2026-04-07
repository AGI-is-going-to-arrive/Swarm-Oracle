"""Web Search Enhancement — search orchestration + result formatting.

This module provides:
- fetch_web_context(): async function to search external APIs before simulation
- format_context_block(): render [REAL_WORLD_CONTEXT] prompt block
- WebSearchResult: typed result dataclass

Architecture: called once at scenario creation (Round 1 pre-fetch).
Search failure NEVER blocks simulation (graceful degradation).
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

import httpx

from app.config import settings
from app.services.llm_client import format_untrusted_text_block

logger = logging.getLogger(__name__)

# ── Data Types ──────────────────────────────────────────


@dataclass(frozen=True)
class WebSearchSnippet:
    text: str
    source_url: str


@dataclass
class WebSearchResult:
    query: str
    snippets: list[WebSearchSnippet] = field(default_factory=list)
    provider: str = ""
    timestamp: str = ""
    cached: bool = False

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> WebSearchResult | None:
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                return None
            snippets = [
                WebSearchSnippet(text=s.get("text", ""), source_url=s.get("source_url", ""))
                for s in data.get("snippets", [])
                if isinstance(s, dict)
            ]
            return cls(
                query=data.get("query", ""),
                snippets=snippets,
                provider=data.get("provider", ""),
                timestamp=data.get("timestamp", ""),
                cached=data.get("cached", False),
            )
        except (json.JSONDecodeError, TypeError):
            return None


# ── In-Memory TTL Cache ─────────────────────────────────

_cache: dict[str, tuple[float, WebSearchResult]] = {}


def _cache_key(query: str) -> str:
    return hashlib.sha256(query.strip().lower().encode()).hexdigest()[:16]


def _cache_get(query: str) -> WebSearchResult | None:
    key = _cache_key(query)
    entry = _cache.get(key)
    if entry is None:
        return None
    expires_at, result = entry
    if time.monotonic() > expires_at:
        _cache.pop(key, None)
        return None
    cached_result = WebSearchResult(
        query=result.query,
        snippets=list(result.snippets),
        provider=result.provider,
        timestamp=result.timestamp,
        cached=True,
    )
    return cached_result


def _cache_put(query: str, result: WebSearchResult) -> None:
    key = _cache_key(query)
    ttl = settings.WEB_SEARCH_CACHE_TTL_SECONDS
    _cache[key] = (time.monotonic() + ttl, result)
    # Evict oldest entries if cache grows too large
    if len(_cache) > 200:
        oldest_key = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest_key, None)


def clear_cache() -> None:
    """Clear the in-memory search cache (for testing)."""
    _cache.clear()


# ── Tavily Provider ─────────────────────────────────────


async def _search_tavily(query: str) -> list[WebSearchSnippet]:
    """Call Tavily Search API and return snippets.

    Tavily API: POST https://api.tavily.com/search
    Body: { "query": "...", "max_results": N, "api_key": "..." }
    Response: { "results": [{ "title": "...", "url": "...", "content": "..." }] }
    """
    api_key = settings.WEB_SEARCH_API_KEY
    if not api_key:
        logger.warning("Tavily search skipped: WEB_SEARCH_API_KEY not configured")
        return []

    timeout = settings.WEB_SEARCH_TIMEOUT_SECONDS
    max_results = settings.WEB_SEARCH_MAX_RESULTS

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://api.tavily.com/search",
            json={
                "query": query,
                "max_results": max_results,
                "api_key": api_key,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    snippets: list[WebSearchSnippet] = []
    for item in data.get("results", []):
        if not isinstance(item, dict):
            continue
        text = item.get("content", "").strip()
        url = item.get("url", "").strip()
        if text and url:
            snippets.append(WebSearchSnippet(text=text, source_url=url))

    return snippets[:max_results]


# ── SearXNG Provider ────────────────────────────────────


async def _search_searxng(query: str) -> list[WebSearchSnippet]:
    """Call SearXNG instance and return snippets.

    SearXNG API: GET {SEARXNG_URL}/search?q=...&format=json
    Response: { "results": [{ "title": "...", "url": "...", "content": "..." }] }
    """
    base_url = settings.SEARXNG_URL.rstrip("/")
    timeout = settings.WEB_SEARCH_TIMEOUT_SECONDS
    max_results = settings.WEB_SEARCH_MAX_RESULTS

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(
            f"{base_url}/search",
            params={"q": query, "format": "json"},
        )
        resp.raise_for_status()
        data = resp.json()

    snippets: list[WebSearchSnippet] = []
    for item in data.get("results", []):
        if not isinstance(item, dict):
            continue
        text = item.get("content", "").strip()
        url = item.get("url", "").strip()
        if text and url:
            snippets.append(WebSearchSnippet(text=text, source_url=url))

    return snippets[:max_results]


# ── Provider Dispatch ───────────────────────────────────

_PROVIDER_MAP = {
    "tavily": _search_tavily,
    "searxng": _search_searxng,
}


async def _search_with_provider(provider: str, query: str) -> list[WebSearchSnippet]:
    """Dispatch to the configured provider. Returns [] on any failure."""
    search_fn = _PROVIDER_MAP.get(provider)
    if search_fn is None:
        logger.warning("Unknown web search provider: %s", provider)
        return []
    try:
        return await search_fn(query)
    except httpx.TimeoutException:
        logger.warning("Web search timeout (%s): query=%r", provider, query[:80])
        return []
    except httpx.HTTPStatusError as exc:
        logger.warning("Web search HTTP error (%s): %s", provider, exc.response.status_code)
        return []
    except Exception:
        logger.warning("Web search unexpected error (%s)", provider, exc_info=True)
        return []


# ── Public API ──────────────────────────────────────────


async def fetch_web_context(question: str) -> WebSearchResult | None:
    """Fetch web search context for a scenario question.

    Returns WebSearchResult on success, None on failure or when disabled.
    Failures are logged but never raised — simulation proceeds without context.
    """
    if not settings.ENABLE_WEB_SEARCH:
        return None

    query = question.strip()
    if not query:
        return None

    # Check cache
    cached = _cache_get(query)
    if cached is not None:
        logger.info("Web search cache hit for query: %s", query[:60])
        return cached

    provider = settings.WEB_SEARCH_PROVIDER
    if provider == "native":
        # Native provider detection is V2 scope
        logger.info("Native web search provider is V2 — skipping")
        return None

    snippets = await _search_with_provider(provider, query)
    if not snippets:
        logger.info("Web search returned no results for query: %s", query[:60])
        return None

    result = WebSearchResult(
        query=query,
        snippets=snippets,
        provider=provider,
        timestamp=datetime.now(timezone.utc).isoformat(),
        cached=False,
    )

    _cache_put(query, result)
    logger.info(
        "Web search success: provider=%s, snippets=%d, query=%s",
        provider, len(snippets), query[:60],
    )
    return result


def _sanitize_url(url: str, max_chars: int = 300) -> str:
    """Strip control characters and truncate URL to prevent prompt injection."""
    # Remove newlines, carriage returns, and other control chars
    cleaned = "".join(ch for ch in url if ch >= " " or ch == "\t")
    return cleaned[:max_chars]


def format_context_block(result: WebSearchResult | None) -> str:
    """Render a [REAL_WORLD_CONTEXT] prompt block from search results.

    Returns empty string if result is None or has no snippets.
    All snippet text is wrapped via format_untrusted_text_block() guardrail.
    Source URLs are sanitized (control chars stripped + length capped).
    """
    if result is None or not result.snippets:
        return ""

    lines: list[str] = [
        "[REAL_WORLD_CONTEXT]",
        f"The following real-world information was retrieved on {result.timestamp}:",
        "",
    ]
    for i, snippet in enumerate(result.snippets, 1):
        sanitized = format_untrusted_text_block(
            f"Source #{i}",
            snippet.text,
            max_chars=800,
        )
        safe_url = _sanitize_url(snippet.source_url)
        lines.append(f"{i}. {sanitized}")
        lines.append(f"   Source: {safe_url}")
        lines.append("")

    lines.append(
        "IMPORTANT: Use this factual context to inform your reasoning. "
        "If the context contradicts your prior knowledge, prefer the context."
    )
    lines.append("[/REAL_WORLD_CONTEXT]")

    return "\n".join(lines)
