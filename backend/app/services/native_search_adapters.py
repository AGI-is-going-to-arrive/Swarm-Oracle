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

from app.services.web_context import WebSearchSnippet


class NativeSearchAdapter(Protocol):
    """Protocol for provider-specific native search integration."""

    max_domains: int

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]: ...

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]: ...

    def detect_body_error(self, response_body: dict) -> str | None: ...


@dataclass(frozen=True)
class XAIResponsesAdapter:
    """xAI Responses API native web search adapter.

    Uses `tools: [{"type": "web_search", "filters": {...}}]`.
    Citations come from output annotations on message content.
    """

    max_domains: int = 5

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]:
        tool: dict = {"type": "web_search"}
        if domains:
            capped = domains[:self.max_domains]
            tool["filters"] = {"allowed_domains": capped}
        return [tool]

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]:
        citations: list[WebSearchSnippet] = []
        seen_urls: set[str] = set()
        for output_item in response_body.get("output", []):
            if output_item.get("type") != "message":
                continue
            for part in output_item.get("content", []):
                for ann in part.get("annotations", []):
                    url = ann.get("url", "")
                    title = ann.get("title", "")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        citations.append(WebSearchSnippet(
                            text=title or url,
                            source_url=url,
                        ))
        return citations

    def detect_body_error(self, response_body: dict) -> str | None:
        return None


@dataclass(frozen=True)
class OpenAIResponsesAdapter:
    """OpenAI Responses API native web search adapter (backlog).

    Structurally similar to xAI. Domain filter limit is 100.
    """

    max_domains: int = 100

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]:
        tool: dict = {"type": "web_search"}
        if domains:
            capped = domains[:self.max_domains]
            tool["filters"] = {"allowed_domains": capped}
        return [tool]

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]:
        citations: list[WebSearchSnippet] = []
        seen_urls: set[str] = set()
        for output_item in response_body.get("output", []):
            if output_item.get("type") != "message":
                continue
            for part in output_item.get("content", []):
                for ann in part.get("annotations", []):
                    url = ann.get("url", "")
                    title = ann.get("title", "")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        citations.append(WebSearchSnippet(
                            text=title or url,
                            source_url=url,
                        ))
        return citations

    def detect_body_error(self, response_body: dict) -> str | None:
        return None


@dataclass(frozen=True)
class _NullAdapter:
    """No-op adapter for providers without native search."""

    max_domains: int = 0

    def build_search_tools(self, *, domains: list[str] | None = None) -> list[dict]:
        return []

    def parse_citations(self, response_body: dict) -> list[WebSearchSnippet]:
        return []

    def detect_body_error(self, response_body: dict) -> str | None:
        return None


_ADAPTER_REGISTRY: dict[str, NativeSearchAdapter] = {
    "xai": XAIResponsesAdapter(),
    "openai": OpenAIResponsesAdapter(),
}

_NULL_ADAPTER = _NullAdapter()


def get_adapter(provider_name: str) -> NativeSearchAdapter:
    """Return the native search adapter for a provider, or null adapter."""
    return _ADAPTER_REGISTRY.get(provider_name, _NULL_ADAPTER)
