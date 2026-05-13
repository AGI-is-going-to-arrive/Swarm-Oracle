"""Web Search Enhancement — search orchestration + result formatting.

This module provides:
- fetch_web_context(): async function to search external APIs before simulation
- format_context_block(): render [REAL_WORLD_CONTEXT] prompt block
- WebSearchResult: typed result dataclass

Architecture: called once at scenario creation (Round 1 pre-fetch).
Search failure NEVER blocks simulation (graceful degradation).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.services.llm_client import format_untrusted_text_block

logger = logging.getLogger(__name__)

# ── Data Types ──────────────────────────────────────────


@dataclass(frozen=True)
class WebSearchSnippet:
    text: str
    source_url: str


@dataclass(frozen=True)
class WebSearchRequestConfig:
    provider: str
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    timeout_seconds: float = 0.0


@dataclass(frozen=True)
class ProviderSearchCapability:
    supports_domain_filter: bool
    supports_sources: bool
    domain_filter_mode: Literal["api", "query", "prompt", "none"]
    max_domains: int | None = None
    supports_citation_url: bool = True


PROVIDER_CAPABILITIES: dict[str, ProviderSearchCapability] = {
    "tavily": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="api", max_domains=300,
    ),
    "exa": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="api", max_domains=1200,
    ),
    "searxng": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="query", max_domains=None,
    ),
    "xai": ProviderSearchCapability(
        supports_domain_filter=True, supports_sources=True,
        domain_filter_mode="api", max_domains=5,
    ),
    "native": ProviderSearchCapability(
        supports_domain_filter=False, supports_sources=False,
        domain_filter_mode="none",
    ),
}


@dataclass(frozen=True)
class ProviderSearchOutcome:
    snippets: list[WebSearchSnippet]
    state: Literal[
        "ready", "empty", "failed", "search_skipped",
        "unsupported_provider", "fallback_unconstrained",
    ]
    domain_filter_mode: Literal["api", "query", "prompt", "none"]
    domain_coverage: Literal["full", "partial", "none"]
    status_reason: str | None = None


def _detect_provider_body_error(provider: str, response_body: dict) -> str | None:
    """Detect HTTP 200 responses that contain an error in the body.

    Adapter hook for providers like Anthropic (web_search_tool_result_error),
    Qwen (silent search skip at high RPS), Kimi (incomplete tool-call loop).
    Concrete implementations will be added per-provider in P3.
    """
    return None


def _normalize_domain_filter(domain: str) -> str:
    """Normalize a domain for exact/subdomain matching and provider filters."""
    candidate = domain.strip().strip(".").lower()
    if not candidate:
        return ""
    if any(unicodedata.category(ch).startswith("C") for ch in candidate):
        return ""
    if any(ch.isspace() or ch in '"\'()' for ch in candidate):
        return ""
    try:
        candidate = candidate.encode("idna").decode("ascii")
    except UnicodeError:
        return ""
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", candidate):
        return ""
    if ".." in candidate:
        return ""
    return candidate


def _filter_snippets_by_domain(
    snippets: list[WebSearchSnippet],
    allowed_domains: list[str] | None,
) -> list[WebSearchSnippet]:
    """Post-filter snippets to only include URLs matching allowed domains.

    A snippet matches when its URL hostname ends with one of the allowed
    domains (case-insensitive). Invalid URLs are silently dropped. If
    ``allowed_domains`` is None or empty, all snippets pass through.
    """
    if not allowed_domains:
        return snippets
    allowed_set = {
        normalized
        for domain in allowed_domains
        if (normalized := _normalize_domain_filter(domain))
    }
    if not allowed_set:
        return []
    filtered: list[WebSearchSnippet] = []
    for s in snippets:
        try:
            parsed_url = urlparse(s.source_url)
            if parsed_url.scheme.lower() not in _ALLOWED_WEB_SEARCH_SCHEMES:
                continue
            hostname = _normalize_domain_filter(parsed_url.hostname or "")
            if any(hostname == d or hostname.endswith("." + d) for d in allowed_set):
                filtered.append(s)
        except Exception:
            continue
    return filtered


@dataclass
class WebSearchResult:
    query: str
    snippets: list[WebSearchSnippet] = field(default_factory=list)
    provider: str = ""
    timestamp: str = ""
    cached: bool = False
    family_context: dict[str, dict[str, object]] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> WebSearchResult | None:
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                return None
            snippets = []
            for s in data.get("snippets", []):
                if not isinstance(s, dict):
                    continue
                raw_text = s.get("text", "")
                raw_url = s.get("source_url", "")
                text = str(raw_text) if raw_text is not None else ""
                url = str(raw_url) if raw_url is not None else ""
                if not text:
                    continue  # skip snippets with no usable text
                snippets.append(WebSearchSnippet(text=text, source_url=url))
            return cls(
                query=data.get("query", ""),
                snippets=snippets,
                provider=data.get("provider", ""),
                timestamp=data.get("timestamp", ""),
                cached=data.get("cached", False),
                family_context=(
                    data.get("family_context", {})
                    if isinstance(data.get("family_context"), dict)
                    else {}
                ),
            )
        except (json.JSONDecodeError, TypeError):
            return None


# ── In-Memory TTL Cache ─────────────────────────────────

_MAX_CACHE_SIZE = 200
_MAX_INFLIGHT_LOCKS = 1000
_cache: dict[str, tuple[float, WebSearchResult]] = {}
_inflight_locks: dict[str, asyncio.Lock] = {}
_WEB_SEARCH_URL_ALLOWLIST: dict[str, frozenset[str]] = {
    "tavily": frozenset({"api.tavily.com"}),
    "exa": frozenset({"api.exa.ai"}),
    "xai": frozenset({"api.x.ai"}),
}
_ALLOWED_WEB_SEARCH_SCHEMES: frozenset[str] = frozenset({"http", "https"})
def _clip_text(value: str, max_chars: int) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= max_chars:
        return normalized
    return f"{normalized[: max_chars - 1].rstrip()}…"


def _truncate_snippet(value: str, max_chars: int = 800) -> str:
    """Length-cap a snippet body without collapsing whitespace.

    Provider boundaries call this so multi-line content (e.g. Exa highlights
    joined by ``\\n\\n``) survives, while still bounding prompt budget.
    """
    if len(value) <= max_chars:
        return value
    return f"{value[: max_chars - 1].rstrip()}…"


def _snippet_title(text: str, fallback: str) -> str:
    normalized = " ".join(text.split())
    if not normalized:
        return fallback
    match = re.split(r"(?<=[.!?])\s+", normalized, maxsplit=1)
    candidate = match[0] if match else normalized
    return _clip_text(candidate or normalized, 96)


def _snippet_source_label(url: str) -> str:
    hostname = (urlparse(url).hostname or "").strip().lower()
    return hostname or "source"


def _stable_family_item_id(family: str, query: str, index: int, url: str, text: str) -> str:
    digest = hashlib.sha256(
        f"{family}::{query}::{index}::{url}::{text}".encode("utf-8")
    ).hexdigest()
    return f"{family[:3]}-{digest[:10]}"


FAMILY_DOMAIN_FILTERS: dict[str, list[str]] = {
    "polymarket": [
        "polymarket.com",
        "metaculus.com",
        "predictit.org",
        "manifold.markets",
    ],
    "finance": [
        "bloomberg.com",
        "reuters.com",
        "ft.com",
        "wsj.com",
        "cnbc.com",
        "finance.yahoo.com",
        "seekingalpha.com",
    ],
    "academic": [
        "arxiv.org",
        "scholar.google.com",
        "semanticscholar.org",
        "pubmed.ncbi.nlm.nih.gov",
        "nature.com",
        "science.org",
        "ieee.org",
    ],
    "news_deep": [
        "apnews.com",
        "bbc.com",
        "nytimes.com",
        "theguardian.com",
        "propublica.org",
        "theintercept.com",
        "bellingcat.com",
    ],
}


def _snippets_to_family_items(
    family: str,
    query: str,
    snippets: list[WebSearchSnippet],
    max_items: int = 5,
) -> list[dict[str, object]]:
    usable = [s for s in snippets if s.text.strip()][:max_items]
    items: list[dict[str, object]] = []
    for index, snippet in enumerate(usable, start=1):
        item_id = _stable_family_item_id(family, query, index, snippet.source_url, snippet.text)
        url = _sanitize_url(snippet.source_url)
        if family == "polymarket":
            items.append({
                "id": item_id,
                "question": _snippet_title(snippet.text, query),
                "url": url,
            })
        elif family == "finance":
            items.append({
                "id": item_id,
                "title": _snippet_title(snippet.text, query),
                "summary": _clip_text(snippet.text, 180),
                "source": _snippet_source_label(snippet.source_url),
                "url": url,
            })
        elif family == "academic":
            items.append({
                "id": item_id,
                "title": _snippet_title(snippet.text, query),
                "abstract": _clip_text(snippet.text, 220),
                "url": url,
            })
        elif family == "news_deep":
            items.append({
                "id": item_id,
                "title": _snippet_title(snippet.text, query),
                "description": _clip_text(snippet.text, 220),
                "source": _snippet_source_label(snippet.source_url),
                "url": url,
            })
    return items


async def fetch_family_context(
    query: str,
    selected_families: list[str],
    request_config: WebSearchRequestConfig | None = None,
) -> dict[str, dict[str, object]]:
    """Run per-family domain-filtered searches and return structured results."""
    polymarket_geo_gated = settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST != "us"
    provider = request_config.provider if request_config else settings.WEB_SEARCH_PROVIDER

    family_context: dict[str, dict[str, object]] = {
        "polymarket": {
            "state": "empty",
            "configured_host": settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST,
            "geo_gated": polymarket_geo_gated,
            "items": [],
        },
        "finance": {"state": "empty", "items": []},
        "academic": {"state": "empty", "items": []},
        "news_deep": {"state": "empty", "items": []},
    }

    families_to_search = [
        f for f in selected_families
        if f in FAMILY_DOMAIN_FILTERS
        and not (f == "polymarket" and polymarket_geo_gated)
    ]
    if not families_to_search:
        return family_context

    async def _search_family(
        family: str,
    ) -> tuple[str, list[WebSearchSnippet], dict[str, object]]:
        domains = FAMILY_DOMAIN_FILTERS[family]
        cap = PROVIDER_CAPABILITIES.get(provider)

        # Provider doesn't support domain filtering at all
        if not cap or not cap.supports_domain_filter or cap.domain_filter_mode == "none":
            return family, [], {
                "state": "unsupported_provider",
                "status_reason": (
                    f"Provider '{provider}' does not support domain filtering"
                ),
            }

        try:
            outcome = await _search_with_provider(
                provider,
                query,
                request_config,
                include_domains=domains,
                swallow_errors=False,
            )
            # Post-filter results against family domains
            snippets = _filter_snippets_by_domain(outcome.snippets, domains)
            metadata: dict[str, object] = {
                "domain_filter_mode": outcome.domain_filter_mode,
                "domain_coverage": outcome.domain_coverage,
            }
            if outcome.status_reason:
                metadata["status_reason"] = outcome.status_reason
            return family, snippets, metadata
        except Exception:
            logger.warning("Family search failed: family=%s", family, exc_info=True)
            return family, [], {
                "state": "failed",
                "status_reason": f"Search error for family '{family}'",
            }

    results = await asyncio.gather(*[_search_family(f) for f in families_to_search])

    for family, snippets, metadata in results:
        items = _snippets_to_family_items(family, query, snippets)
        state = metadata.pop("state", None)
        if state:
            # Pre-determined state (unsupported_provider, failed, etc.)
            family_context[family]["state"] = state
        elif items:
            family_context[family]["state"] = "ready"
            family_context[family]["items"] = items
        # else: stays "empty" (default)

        # Add optional metadata (domain_filter_mode, domain_coverage, status_reason)
        for key in ("domain_filter_mode", "domain_coverage", "status_reason"):
            if key in metadata:
                family_context[family][key] = metadata[key]

    return family_context


def build_source_family_context(
    result: WebSearchResult,
    *,
    selected_families: list[str] | None = None,
) -> dict[str, dict[str, object]]:
    """Legacy sync projection — kept for backward compatibility with tests."""
    polymarket_geo_gated = settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST != "us"
    selected = set(selected_families or [])

    family_context: dict[str, dict[str, object]] = {
        "polymarket": {
            "state": "empty",
            "configured_host": settings.NEW_SOURCES_POLYMARKET_CONFIGURED_HOST,
            "geo_gated": polymarket_geo_gated,
            "items": [],
        },
        "finance": {"state": "empty", "items": []},
        "academic": {"state": "empty", "items": []},
        "news_deep": {"state": "empty", "items": []},
    }

    for family in ["polymarket", "finance", "academic", "news_deep"]:
        if family not in selected:
            continue
        if family == "polymarket" and polymarket_geo_gated:
            continue
        items = _snippets_to_family_items(family, result.query, result.snippets)
        if items:
            family_context[family]["state"] = "ready"
            family_context[family]["items"] = items

    return family_context


def _normalize_base_url(url: str | None) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    netloc = (parsed.netloc or "").lower()
    if not scheme or not netloc:
        return ""
    path = (parsed.path or "").rstrip("/")
    return f"{scheme}://{netloc}{path}"


def _default_provider_base_url(provider: str) -> str:
    normalized_provider = (provider or "").strip().lower()
    if normalized_provider == "tavily":
        return "https://api.tavily.com/search"
    if normalized_provider == "exa":
        return "https://api.exa.ai/search"
    if normalized_provider == "xai":
        return "https://api.x.ai/v1/responses"
    if normalized_provider == "searxng":
        return _normalize_base_url(settings.SEARXNG_URL)
    return ""


def validate_web_search_base_url(provider: str, url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url)
        scheme = (parsed.scheme or "").lower()
        if scheme not in _ALLOWED_WEB_SEARCH_SCHEMES:
            return None
        normalized_url = _normalize_base_url(url)
        normalized_provider = (provider or "").strip().lower()
        if normalized_provider == "searxng":
            configured_base_url = _normalize_base_url(settings.SEARXNG_URL)
            if not configured_base_url or normalized_url != configured_base_url:
                return None
            return url
        hostname = (parsed.hostname or "").strip().lower()
        allowed_hosts = _WEB_SEARCH_URL_ALLOWLIST.get(normalized_provider)
        if not allowed_hosts or hostname not in allowed_hosts:
            return None
        if scheme != "https":
            return None
        return url
    except Exception:
        return None


def _resolve_request_config(
    provider_override: str | None = None,
    api_key_override: str | None = None,
    base_url_override: str | None = None,
) -> WebSearchRequestConfig:
    default_provider = settings.WEB_SEARCH_PROVIDER.strip().lower()
    provider = (provider_override or default_provider).strip().lower()
    provided_api_key = (api_key_override or "").strip()
    api_key = (
        provided_api_key
        if provided_api_key
        else settings.WEB_SEARCH_API_KEY.strip() if provider == default_provider else ""
    )
    base_url = (base_url_override or _default_provider_base_url(provider)).strip()
    model = settings.XAI_WEB_SEARCH_MODEL if provider == "xai" else ""
    timeout_seconds = (
        settings.XAI_WEB_SEARCH_TIMEOUT_SECONDS
        if provider == "xai"
        else settings.WEB_SEARCH_TIMEOUT_SECONDS
    )
    return WebSearchRequestConfig(
        provider=provider,
        api_key=api_key,
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
    )


def _cache_key(query: str, request_config: WebSearchRequestConfig) -> str:
    payload = (
        f"{query.strip().lower()}::{request_config.provider}::"
        f"{request_config.base_url}::{request_config.api_key}::{request_config.model}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _cache_get(query: str, request_config: WebSearchRequestConfig) -> WebSearchResult | None:
    key = _cache_key(query, request_config)
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


def _cache_put(query: str, request_config: WebSearchRequestConfig, result: WebSearchResult) -> None:
    key = _cache_key(query, request_config)
    ttl = settings.WEB_SEARCH_CACHE_TTL_SECONDS
    _cache[key] = (time.monotonic() + ttl, result)
    # Evict oldest entries if cache grows too large
    if len(_cache) > _MAX_CACHE_SIZE:
        oldest_key = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest_key, None)


def _get_inflight_lock(cache_key: str) -> asyncio.Lock:
    """Return a per-key lock to dedup concurrent fetches (cache stampede).

    Locks are popped after `fetch_web_context` finishes, so this dict normally
    only contains in-flight keys. The cap is a pathological-case safety net for
    bursts where many distinct keys arrive faster than they finish.
    """
    if len(_inflight_locks) >= _MAX_INFLIGHT_LOCKS and cache_key not in _inflight_locks:
        # Pathological burst: distinct in-flight keys exceeded cap. Clear is
        # last-resort; concurrent waiters in their own critical section keep
        # their lock reference (the next setdefault may create a new one for
        # a duplicate key, sacrificing dedup for that key but never safety).
        _inflight_locks.clear()
    return _inflight_locks.setdefault(cache_key, asyncio.Lock())


def clear_cache() -> None:
    """Clear the in-memory search cache (for testing)."""
    _cache.clear()
    _inflight_locks.clear()


# ── Tavily Provider ─────────────────────────────────────


async def _search_tavily(
    query: str,
    request_config: WebSearchRequestConfig | None = None,
    *,
    include_domains: list[str] | None = None,
) -> list[WebSearchSnippet]:
    """Call Tavily Search API and return snippets.

    Tavily API: POST https://api.tavily.com/search
    Body: { "query": "...", "max_results": N, "api_key": "...", "include_domains": [...] }
    Response: { "results": [{ "title": "...", "url": "...", "content": "..." }] }
    """
    api_key = request_config.api_key if request_config else settings.WEB_SEARCH_API_KEY
    if not api_key:
        logger.warning("Tavily search skipped: WEB_SEARCH_API_KEY not configured")
        return []

    timeout = (
        request_config.timeout_seconds
        if request_config
        else settings.WEB_SEARCH_TIMEOUT_SECONDS
    )
    max_results = settings.WEB_SEARCH_MAX_RESULTS
    endpoint = (
        request_config.base_url
        if request_config and request_config.base_url
        else _default_provider_base_url("tavily")
    )

    body: dict[str, object] = {
        "query": query,
        "max_results": max_results,
        "api_key": api_key,
    }
    if include_domains:
        body["include_domains"] = include_domains

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(endpoint, json=body)
        resp.raise_for_status()
        data = resp.json()

    snippets: list[WebSearchSnippet] = []
    for item in data.get("results", []):
        if not isinstance(item, dict):
            continue
        raw_text = item.get("content", "")
        raw_url = item.get("url", "")
        if not isinstance(raw_text, str) or not isinstance(raw_url, str):
            continue
        text = _truncate_snippet(raw_text.strip())
        url = _sanitize_url(raw_url.strip())
        if text and url:
            snippets.append(WebSearchSnippet(text=text, source_url=url))

    return snippets[:max_results]


# ── SearXNG Provider ────────────────────────────────────


async def _search_searxng(
    query: str,
    request_config: WebSearchRequestConfig | None = None,
    *,
    include_domains: list[str] | None = None,
) -> list[WebSearchSnippet]:
    """Call SearXNG instance and return snippets.

    SearXNG API: GET {SEARXNG_URL}/search?q=...&format=json
    Response: { "results": [{ "title": "...", "url": "...", "content": "..." }] }
    """
    base_url = (
        request_config.base_url.rstrip("/")
        if request_config and request_config.base_url
        else settings.SEARXNG_URL.rstrip("/")
    )
    timeout = (
        request_config.timeout_seconds
        if request_config
        else settings.WEB_SEARCH_TIMEOUT_SECONDS
    )
    max_results = settings.WEB_SEARCH_MAX_RESULTS

    effective_query = query
    if include_domains:
        safe_domains = [
            normalized
            for domain in include_domains
            if (normalized := _normalize_domain_filter(domain))
        ]
        if safe_domains:
            site_filter = " OR ".join(f"site:{d}" for d in safe_domains)
            effective_query = f"({query}) ({site_filter})"

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(
            f"{base_url}/search",
            params={"q": effective_query, "format": "json"},
        )
        resp.raise_for_status()
        try:
            data = resp.json()
        except (json.JSONDecodeError, ValueError):
            logger.warning("SearXNG returned non-JSON response")
            return []

    snippets: list[WebSearchSnippet] = []
    for item in data.get("results", []):
        if not isinstance(item, dict):
            continue
        raw_text = item.get("content", "")
        raw_url = item.get("url", "")
        if not isinstance(raw_text, str) or not isinstance(raw_url, str):
            continue
        text = _truncate_snippet(raw_text.strip())
        url = _sanitize_url(raw_url.strip())
        if text and url:
            snippets.append(WebSearchSnippet(text=text, source_url=url))

    result_snippets = snippets[:max_results]
    if include_domains:
        result_snippets = _filter_snippets_by_domain(result_snippets, include_domains)
    return result_snippets


# ── Exa Provider ───────────────────────────────────────


def _coerce_snippet_text(item: dict) -> str:
    raw_text = item.get("text")
    if isinstance(raw_text, str) and raw_text.strip():
        return raw_text.strip()

    raw_highlights = item.get("highlights")
    if isinstance(raw_highlights, list):
        highlights = [
            highlight.strip()
            for highlight in raw_highlights
            if isinstance(highlight, str) and highlight.strip()
        ]
        if highlights:
            return "\n\n".join(highlights)

    raw_summary = item.get("summary")
    if isinstance(raw_summary, str) and raw_summary.strip():
        return raw_summary.strip()

    return ""


async def _search_exa(
    query: str,
    request_config: WebSearchRequestConfig | None = None,
    *,
    include_domains: list[str] | None = None,
) -> list[WebSearchSnippet]:
    """Call Exa Search API and normalize results into snippets."""
    api_key = request_config.api_key if request_config else settings.WEB_SEARCH_API_KEY
    if not api_key:
        logger.warning("Exa search skipped: WEB_SEARCH_API_KEY not configured")
        return []

    timeout = (
        request_config.timeout_seconds
        if request_config
        else settings.WEB_SEARCH_TIMEOUT_SECONDS
    )
    max_results = settings.WEB_SEARCH_MAX_RESULTS
    endpoint = (
        request_config.base_url
        if request_config and request_config.base_url
        else _default_provider_base_url("exa")
    )

    body: dict[str, object] = {
        "query": query,
        "numResults": max_results,
        "contents": {
            "highlights": {
                "maxCharacters": 400,
            }
        },
    }
    if include_domains:
        body["includeDomains"] = include_domains

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            endpoint,
            headers={"x-api-key": api_key},
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()

    snippets: list[WebSearchSnippet] = []
    for item in data.get("results", []):
        if not isinstance(item, dict):
            continue
        raw_text = _coerce_snippet_text(item)
        raw_url = item.get("url", "")
        if not isinstance(raw_text, str) or not isinstance(raw_url, str):
            continue
        text = _truncate_snippet(raw_text.strip())
        url = _sanitize_url(raw_url.strip())
        if text and url:
            snippets.append(WebSearchSnippet(text=text, source_url=url))

    return snippets[:max_results]


# ── xAI Provider ───────────────────────────────────────


def _find_xai_output_text(payload: dict) -> tuple[str, list[dict]]:
    for item in payload.get("output", []):
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict) or content.get("type") != "output_text":
                continue
            text = content.get("text")
            if isinstance(text, str) and text.strip():
                annotations = content.get("annotations", [])
                return text.strip(), annotations if isinstance(annotations, list) else []
    return "", []


def _strip_json_code_fence(raw: str) -> str:
    stripped = raw.strip()
    if not stripped.startswith("```"):
        return stripped
    stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
    stripped = re.sub(r"\s*```$", "", stripped)
    return stripped.strip()


def _parse_xai_structured_snippets(raw_text: str, max_results: int) -> list[WebSearchSnippet]:
    try:
        payload = json.loads(_strip_json_code_fence(raw_text))
    except json.JSONDecodeError:
        return []

    if not isinstance(payload, dict):
        return []

    snippets: list[WebSearchSnippet] = []
    for item in payload.get("snippets", []):
        if not isinstance(item, dict):
            continue
        snippet_text = item.get("text", "")
        snippet_url = item.get("source_url", "")
        if not isinstance(snippet_text, str) or not isinstance(snippet_url, str):
            continue
        text = _truncate_snippet(snippet_text.strip())
        url = _sanitize_url(snippet_url.strip())
        if text and url:
            snippets.append(WebSearchSnippet(text=text, source_url=url))
    return snippets[:max_results]


def _fallback_xai_citation_snippets(
    raw_text: str,
    annotations: list[dict],
    max_results: int,
) -> list[WebSearchSnippet]:
    urls: list[str] = []
    for annotation in annotations:
        if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
            continue
        url = str(annotation.get("url", "")).strip()
        if url and url not in urls:
            urls.append(url)

    if not urls:
        return []

    cleaned_text = re.sub(r"\[\[\d+\]\]\([^)]+\)", "", raw_text)
    cleaned_text = " ".join(cleaned_text.split()).strip()
    if not cleaned_text:
        return []

    snippet_text = cleaned_text[:400]
    return [
        WebSearchSnippet(text=snippet_text, source_url=url)
        for url in urls[:max_results]
    ]


async def _search_xai(
    query: str,
    request_config: WebSearchRequestConfig | None = None,
    *,
    include_domains: list[str] | None = None,
) -> list[WebSearchSnippet]:
    """Call xAI Responses API with the web_search tool and request structured snippets."""
    api_key = request_config.api_key if request_config else settings.WEB_SEARCH_API_KEY
    if not api_key:
        logger.warning("xAI search skipped: WEB_SEARCH_API_KEY not configured")
        return []

    timeout = (
        request_config.timeout_seconds
        if request_config
        else settings.XAI_WEB_SEARCH_TIMEOUT_SECONDS
    )
    max_results = settings.WEB_SEARCH_MAX_RESULTS
    output_budget = max(300, min(900, 180 * max_results))
    endpoint = (
        request_config.base_url
        if request_config and request_config.base_url
        else _default_provider_base_url("xai")
    )
    model = (
        request_config.model
        if request_config and request_config.model
        else settings.XAI_WEB_SEARCH_MODEL
    )
    prompt = (
        "Use web search.\n"
        "Return a strict JSON object with key "
        f"\"snippets\" containing at most {max_results} items.\n"
        "Each item must be an object with keys \"text\" and \"source_url\".\n"
        "text must be a concise factual snippet under 400 characters grounded in the source.\n"
        "source_url must be the exact source URL.\n"
        "No markdown. No extra prose outside JSON."
    )

    tools: list[dict[str, object]] = [{"type": "web_search"}]
    if include_domains:
        capped = include_domains[:5]
        tools = [{"type": "web_search", "filters": {"allowed_domains": capped}}]

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "input": prompt + f"\n\nUser query: {query}",
                "tools": tools,
                "max_output_tokens": output_budget,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    raw_text, annotations = _find_xai_output_text(data)
    if not raw_text:
        return []

    structured = _parse_xai_structured_snippets(raw_text, max_results)
    if structured:
        if include_domains:
            structured = _filter_snippets_by_domain(structured, include_domains)
        return structured

    fallback = _fallback_xai_citation_snippets(raw_text, annotations, max_results)
    if include_domains:
        fallback = _filter_snippets_by_domain(fallback, include_domains)
    return fallback


# ── Provider Dispatch ───────────────────────────────────

_PROVIDER_MAP = {
    "tavily": _search_tavily,
    "exa": _search_exa,
    "searxng": _search_searxng,
    "xai": _search_xai,
}


async def _search_with_provider(
    provider: str,
    query: str,
    request_config: WebSearchRequestConfig | None = None,
    *,
    include_domains: list[str] | None = None,
    swallow_errors: bool = True,
) -> ProviderSearchOutcome:
    """Dispatch to the configured provider. Returns structured outcome."""
    cap = PROVIDER_CAPABILITIES.get(provider)
    dfm = cap.domain_filter_mode if cap else "none"
    dc = "none"
    if include_domains and cap and cap.max_domains is not None:
        dc = "full" if len(include_domains) <= cap.max_domains else "partial"
    elif include_domains:
        dc = "full"

    search_fn = _PROVIDER_MAP.get(provider)
    if search_fn is None:
        logger.warning("Unknown web search provider: %s", provider)
        if not swallow_errors:
            raise ValueError(f"Unknown web search provider: {provider}")
        return ProviderSearchOutcome(
            [], "unsupported_provider", "none", "none",
            status_reason=f"Unknown provider: {provider}",
        )
    try:
        snippets = await search_fn(query, request_config, include_domains=include_domains)
        state = "ready" if snippets else "empty"
        return ProviderSearchOutcome(snippets, state, dfm, dc)
    except httpx.TimeoutException:
        logger.warning("Web search timeout (%s): query=%r", provider, query[:80])
        if not swallow_errors:
            raise
        return ProviderSearchOutcome(
            [], "failed", dfm, dc,
            status_reason=f"Timeout from provider '{provider}'",
        )
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code
        logger.warning("Web search HTTP error (%s): %s", provider, status_code)
        if not swallow_errors:
            raise
        if status_code == 429:
            return ProviderSearchOutcome(
                [], "search_skipped", dfm, dc,
                status_reason=f"Rate limited by provider '{provider}'",
            )
        if status_code in (400, 401, 403, 404, 422):
            return ProviderSearchOutcome(
                [], "unsupported_provider", dfm, dc,
                status_reason=f"HTTP {status_code} from provider '{provider}'",
            )
        return ProviderSearchOutcome(
            [], "failed", dfm, dc,
            status_reason=f"HTTP {status_code} from provider '{provider}'",
        )
    except Exception:
        logger.warning("Web search unexpected error (%s)", provider, exc_info=True)
        if not swallow_errors:
            raise
        return ProviderSearchOutcome(
            [], "failed", dfm, dc,
            status_reason=f"Unexpected error from provider '{provider}'",
        )


# ── Public API ──────────────────────────────────────────


async def fetch_web_context(
    question: str,
    provider_override: str | None = None,
    api_key_override: str | None = None,
    base_url_override: str | None = None,
) -> WebSearchResult | None:
    """Fetch web search context for a scenario question.

    Returns WebSearchResult on success, None on failure or when disabled.
    Failures are logged but never raised — simulation proceeds without context.
    """
    has_request_override = any([
        provider_override and provider_override.strip(),
        api_key_override and api_key_override.strip(),
        base_url_override and base_url_override.strip(),
    ])
    if not settings.ENABLE_WEB_SEARCH and not has_request_override:
        return None

    query = question.strip()
    if not query:
        return None

    request_config = _resolve_request_config(
        provider_override=provider_override,
        api_key_override=api_key_override,
        base_url_override=base_url_override,
    )

    # Check cache
    cached = _cache_get(query, request_config)
    if cached is not None:
        logger.info("Web search cache hit for query: %s", query[:60])
        return cached

    provider = request_config.provider
    if provider == "native":
        # Deprecated: `native` is rejected by config validator; this branch only
        # protects against legacy/monkeypatched runtime overrides (V2 scope).
        logger.info("Native web search provider is V2 — skipping")
        return None

    # In-flight de-duplication: if multiple coroutines miss cache concurrently,
    # only one performs the provider call; the rest wait and reuse the result.
    cache_key = _cache_key(query, request_config)
    lock = _get_inflight_lock(cache_key)
    try:
        async with lock:
            # Double-check after acquiring lock — another coroutine may have filled it.
            cached = _cache_get(query, request_config)
            if cached is not None:
                logger.info("Web search cache hit (post-lock) for query: %s", query[:60])
                return cached

            outcome = await _search_with_provider(provider, query, request_config)
            if not outcome.snippets:
                logger.info(
                    "Web search returned no results for query: %s (state=%s)",
                    query[:60], outcome.state,
                )
                return None

            result = WebSearchResult(
                query=query,
                snippets=outcome.snippets,
                provider=provider,
                timestamp=datetime.now(timezone.utc).isoformat(),
                cached=False,
            )

            _cache_put(query, request_config, result)
    finally:
        # Pop after release so subsequent callers either hit cache (fast path)
        # or create a fresh lock (next miss). Identity check guards against the
        # pathological-burst clear in `_get_inflight_lock` having replaced this
        # entry with a different lock object.
        if _inflight_locks.get(cache_key) is lock:
            _inflight_locks.pop(cache_key, None)

    logger.info(
        "Web search success: provider=%s, snippets=%d, query=%s",
        provider, len(outcome.snippets), query[:60],
    )
    return result


def _sanitize_url(url: str | None, max_chars: int = 300) -> str:
    """Sanitize a source URL for safe prompt embedding.

    - None / empty → empty string
    - Non-http(s) schemes → empty string
    - Control characters stripped, length capped
    """
    if not url:
        return ""
    cleaned = "".join(ch for ch in url if ch >= " " and ch != "\x7f")
    cleaned = cleaned[:max_chars]
    # Only allow http/https schemes
    if not cleaned.lower().startswith(("http://", "https://")):
        return ""
    return cleaned


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
        safe_url = _sanitize_url(snippet.source_url)
        url_suffix = f"\n   Source: {safe_url}" if safe_url else ""
        sanitized = format_untrusted_text_block(
            f"Source #{i}",
            snippet.text + url_suffix,
            max_chars=800,
        )
        lines.append(f"{i}. {sanitized}")
        lines.append("")

    lines.append(
        "IMPORTANT: Use this factual context to inform your reasoning. "
        "If the context contradicts your prior knowledge, prefer the context."
    )
    lines.append("[/REAL_WORLD_CONTEXT]")

    return "\n".join(lines)
