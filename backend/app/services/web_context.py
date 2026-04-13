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
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
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
            )
        except (json.JSONDecodeError, TypeError):
            return None


# ── In-Memory TTL Cache ─────────────────────────────────

_cache: dict[str, tuple[float, WebSearchResult]] = {}
_WEB_SEARCH_URL_ALLOWLIST: dict[str, frozenset[str]] = {
    "tavily": frozenset({"api.tavily.com"}),
    "exa": frozenset({"api.exa.ai"}),
    "xai": frozenset({"api.x.ai"}),
}
_ALLOWED_WEB_SEARCH_SCHEMES: frozenset[str] = frozenset({"http", "https"})


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
    if len(_cache) > 200:
        oldest_key = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest_key, None)


def clear_cache() -> None:
    """Clear the in-memory search cache (for testing)."""
    _cache.clear()


# ── Tavily Provider ─────────────────────────────────────


async def _search_tavily(
    query: str,
    request_config: WebSearchRequestConfig | None = None,
) -> list[WebSearchSnippet]:
    """Call Tavily Search API and return snippets.

    Tavily API: POST https://api.tavily.com/search
    Body: { "query": "...", "max_results": N, "api_key": "..." }
    Response: { "results": [{ "title": "...", "url": "...", "content": "..." }] }
    """
    api_key = request_config.api_key if request_config else settings.WEB_SEARCH_API_KEY
    if not api_key:
        logger.warning("Tavily search skipped: WEB_SEARCH_API_KEY not configured")
        return []

    timeout = request_config.timeout_seconds if request_config else settings.WEB_SEARCH_TIMEOUT_SECONDS
    max_results = settings.WEB_SEARCH_MAX_RESULTS
    endpoint = request_config.base_url if request_config and request_config.base_url else _default_provider_base_url("tavily")

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            endpoint,
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


async def _search_searxng(
    query: str,
    request_config: WebSearchRequestConfig | None = None,
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
    timeout = request_config.timeout_seconds if request_config else settings.WEB_SEARCH_TIMEOUT_SECONDS
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
) -> list[WebSearchSnippet]:
    """Call Exa Search API and normalize results into snippets."""
    api_key = request_config.api_key if request_config else settings.WEB_SEARCH_API_KEY
    if not api_key:
        logger.warning("Exa search skipped: WEB_SEARCH_API_KEY not configured")
        return []

    timeout = request_config.timeout_seconds if request_config else settings.WEB_SEARCH_TIMEOUT_SECONDS
    max_results = settings.WEB_SEARCH_MAX_RESULTS
    endpoint = request_config.base_url if request_config and request_config.base_url else _default_provider_base_url("exa")

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            endpoint,
            headers={"x-api-key": api_key},
            json={
                "query": query,
                "numResults": max_results,
                "contents": {
                    "highlights": {
                        "maxCharacters": 400,
                    }
                },
            },
        )
        resp.raise_for_status()
        data = resp.json()

    snippets: list[WebSearchSnippet] = []
    for item in data.get("results", []):
        if not isinstance(item, dict):
            continue
        text = _coerce_snippet_text(item)
        url = str(item.get("url", "")).strip()
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
        text = str(item.get("text", "")).strip()
        url = str(item.get("source_url", "")).strip()
        if text and url:
            snippets.append(WebSearchSnippet(text=text, source_url=url))
    return snippets[:max_results]


def _fallback_xai_citation_snippets(raw_text: str, annotations: list[dict], max_results: int) -> list[WebSearchSnippet]:
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
) -> list[WebSearchSnippet]:
    """Call xAI Responses API with the web_search tool and request structured snippets."""
    api_key = request_config.api_key if request_config else settings.WEB_SEARCH_API_KEY
    if not api_key:
        logger.warning("xAI search skipped: WEB_SEARCH_API_KEY not configured")
        return []

    timeout = request_config.timeout_seconds if request_config else settings.XAI_WEB_SEARCH_TIMEOUT_SECONDS
    max_results = settings.WEB_SEARCH_MAX_RESULTS
    output_budget = max(300, min(900, 180 * max_results))
    endpoint = request_config.base_url if request_config and request_config.base_url else _default_provider_base_url("xai")
    model = request_config.model if request_config and request_config.model else settings.XAI_WEB_SEARCH_MODEL
    prompt = (
        "Use web search.\n"
        f"Return a strict JSON object with key \"snippets\" containing at most {max_results} items.\n"
        "Each item must be an object with keys \"text\" and \"source_url\".\n"
        "text must be a concise factual snippet under 400 characters grounded in the source.\n"
        "source_url must be the exact source URL.\n"
        "No markdown. No extra prose outside JSON."
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "input": prompt + f"\n\nUser query: {query}",
                "tools": [{"type": "web_search"}],
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
        return structured

    return _fallback_xai_citation_snippets(raw_text, annotations, max_results)


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
) -> list[WebSearchSnippet]:
    """Dispatch to the configured provider. Returns [] on any failure."""
    search_fn = _PROVIDER_MAP.get(provider)
    if search_fn is None:
        logger.warning("Unknown web search provider: %s", provider)
        return []
    try:
        try:
            return await search_fn(query, request_config)
        except TypeError:
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
        # Native provider detection is V2 scope
        logger.info("Native web search provider is V2 — skipping")
        return None

    snippets = await _search_with_provider(provider, query, request_config)
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

    _cache_put(query, request_config, result)
    logger.info(
        "Web search success: provider=%s, snippets=%d, query=%s",
        provider, len(snippets), query[:60],
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
    cleaned = "".join(ch for ch in url if ch >= " " or ch == "\t")
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
