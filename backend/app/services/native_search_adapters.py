"""Native LLM search adapters — provider-specific tools/citation parsing.

Each adapter encapsulates:
- build_search_tools(): provider-specific `tools` payload for native search
- parse_citations(): extract citations/sources from the LLM response body
- detect_body_error(): detect 200-OK responses that contain errors in body

Architecture: adapters are stateless and frozen. The adapter registry maps
provider names from detect_provider() to concrete adapter instances.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.services.web_context import (
    WebSearchSnippet,
    _sanitize_domain_filters,
    _sanitize_url,
)


class NativeSearchAdapter(Protocol):
    """Protocol for provider-specific native search integration."""

    max_domains: int
    max_tool_calls: int

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]: ...

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]: ...

    def detect_body_error(self, response_body: dict) -> str | None: ...

    def count_tool_calls(self, response_body: dict) -> int: ...


def _append_citation(
    citations: list[WebSearchSnippet],
    seen_urls: set[str],
    *,
    raw_url: object,
    raw_title: object = "",
) -> None:
    url = _sanitize_url(raw_url if isinstance(raw_url, str) else "")
    title = raw_title if isinstance(raw_title, str) else ""
    if url and url not in seen_urls:
        seen_urls.add(url)
        citations.append(WebSearchSnippet(
            text=(title or url)[:500],
            source_url=url,
        ))


def _parse_response_citations(response_body: dict) -> list[WebSearchSnippet]:
    citations: list[WebSearchSnippet] = []
    seen_urls: set[str] = set()
    raw_citations = response_body.get("citations", [])
    if not isinstance(raw_citations, list):
        return []
    for item in raw_citations:
        if isinstance(item, str):
            _append_citation(citations, seen_urls, raw_url=item)
        elif isinstance(item, dict):
            _append_citation(
                citations,
                seen_urls,
                raw_url=item.get("url", ""),
                raw_title=item.get("title", ""),
            )
    return citations


def _parse_annotation_citations(response_body: dict) -> list[WebSearchSnippet]:
    citations: list[WebSearchSnippet] = []
    seen_urls: set[str] = set()
    for output_item in response_body.get("output", []):
        if not isinstance(output_item, dict):
            continue
        if output_item.get("type") != "message":
            continue
        for part in output_item.get("content", []):
            if not isinstance(part, dict):
                continue
            annotations = part.get("annotations", [])
            if not isinstance(annotations, list):
                continue
            for ann in annotations:
                _append_citation(
                    citations,
                    seen_urls,
                    raw_url=ann.get("url", "") if isinstance(ann, dict) else "",
                    raw_title=ann.get("title", "") if isinstance(ann, dict) else "",
                )
    return citations


def _count_web_search_tool_calls(response_body: dict) -> int:
    """Count web_search tool-use invocations in a Responses API output."""
    count = 0
    for item in response_body.get("output", []):
        if not isinstance(item, dict):
            continue
        if item.get("type") == "web_search_call":
            count += 1
        elif item.get("type") == "tool_use" and item.get("name") == "web_search":
            count += 1
    return count


@dataclass(frozen=True)
class XAIResponsesAdapter:
    """xAI Responses API native web search adapter.

    Uses `tools: [{"type": "web_search", "filters": {...}}]`.
    Citations come from output annotations on message content.
    """

    max_domains: int = 5
    max_tool_calls: int = 5

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]:
        tool: dict = {"type": "web_search"}
        allowed_domains = _sanitize_domain_filters(domains, max_domains=self.max_domains)
        if allowed_domains:
            tool["filters"] = {"allowed_domains": allowed_domains}
        return [tool]

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]:
        citations = _parse_response_citations(response_body)
        if citations:
            return citations
        return _parse_annotation_citations(response_body)

    def detect_body_error(self, response_body: dict) -> str | None:
        for item in response_body.get("output", []):
            if not isinstance(item, dict):
                continue
            if item.get("type") == "web_search_call" and item.get("status") == "failed":
                return f"xAI web_search_call failed: {item.get('error', 'unknown')}"
        return None

    def count_tool_calls(self, response_body: dict) -> int:
        return _count_web_search_tool_calls(response_body)


@dataclass(frozen=True)
class OpenAIResponsesAdapter:
    """OpenAI Responses API native web search adapter (backlog).

    Structurally similar to xAI. Domain filter limit is 100.
    """

    max_domains: int = 100
    max_tool_calls: int = 5

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]:
        tool: dict = {"type": "web_search"}
        allowed_domains = _sanitize_domain_filters(domains, max_domains=self.max_domains)
        if allowed_domains:
            tool["filters"] = {"allowed_domains": allowed_domains}
        return [tool]

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]:
        citations = _parse_response_citations(response_body)
        if citations:
            return citations
        return _parse_annotation_citations(response_body)

    def detect_body_error(self, response_body: dict) -> str | None:
        for item in response_body.get("output", []):
            if not isinstance(item, dict):
                continue
            if item.get("type") == "web_search_call" and item.get("status") == "failed":
                return f"OpenAI web_search_call failed: {item.get('error', 'unknown')}"
        return None

    def count_tool_calls(self, response_body: dict) -> int:
        return _count_web_search_tool_calls(response_body)


@dataclass(frozen=True)
class _NullAdapter:
    """No-op adapter for providers without native search."""

    max_domains: int = 0
    max_tool_calls: int = 0

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]:
        return []

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]:
        return []

    def detect_body_error(self, response_body: dict) -> str | None:
        return None

    def count_tool_calls(self, response_body: dict) -> int:
        return 0


_ADAPTER_REGISTRY: dict[str, NativeSearchAdapter] = {
    "xai": XAIResponsesAdapter(),
    "openai": OpenAIResponsesAdapter(),
}

_NULL_ADAPTER = _NullAdapter()


def get_adapter(provider_name: str) -> NativeSearchAdapter:
    """Return the native search adapter for a provider, or null adapter."""
    return _ADAPTER_REGISTRY.get(provider_name, _NULL_ADAPTER)
