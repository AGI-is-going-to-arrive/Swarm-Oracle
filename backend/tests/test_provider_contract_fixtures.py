"""P5-3: Provider contract fixture tests.

Validates adapter parsing against realistic provider response payloads
without making real HTTP calls. Each fixture represents a frozen snapshot
of the provider API response structure.
"""

from app.services.native_search_adapters import (
    OpenAIResponsesAdapter,
    XAIResponsesAdapter,
    _NullAdapter,
    get_adapter,
)
from app.services.web_context import _detect_provider_body_error

# ── xAI Responses API fixtures ──────────────────────────

XAI_SUCCESS_FIXTURE = {
    "id": "resp_xai_001",
    "object": "response",
    "output": [
        {
            "type": "web_search_call",
            "id": "ws_001",
            "status": "completed",
        },
        {
            "type": "message",
            "content": [
                {
                    "type": "output_text",
                    "text": "Based on my research, AI advances are accelerating.",
                    "annotations": [
                        {"url": "https://arxiv.org/abs/2401.001", "title": "AI Survey 2026"},
                        {"url": "https://nature.com/articles/ai", "title": "Nature AI"},
                        {"url": "javascript:alert(1)", "title": "XSS attempt"},
                    ],
                },
            ],
        },
    ],
    "usage": {"input_tokens": 100, "output_tokens": 200},
}

XAI_MULTI_SEARCH_FIXTURE = {
    "id": "resp_xai_002",
    "output": [
        {"type": "web_search_call", "id": "ws_001", "status": "completed"},
        {"type": "web_search_call", "id": "ws_002", "status": "completed"},
        {"type": "web_search_call", "id": "ws_003", "status": "completed"},
        {
            "type": "message",
            "content": [{"type": "output_text", "text": "Combined results."}],
        },
    ],
}

XAI_FAILED_SEARCH_FIXTURE = {
    "id": "resp_xai_003",
    "output": [
        {
            "type": "web_search_call",
            "id": "ws_001",
            "status": "failed",
            "error": "rate_limit_exceeded",
        },
        {
            "type": "message",
            "content": [{"type": "output_text", "text": "Could not search."}],
        },
    ],
}

XAI_TOP_LEVEL_CITATIONS_FIXTURE = {
    "id": "resp_xai_004",
    "citations": [
        "https://example.com/source1",
        {"url": "https://example.com/source2", "title": "Source 2"},
        "ftp://bad-protocol.com/file",
    ],
    "output": [
        {
            "type": "message",
            "content": [{"type": "output_text", "text": "With top-level citations."}],
        },
    ],
}

# ── OpenAI Responses API fixtures ────────────────────────

OPENAI_SUCCESS_FIXTURE = {
    "id": "resp_openai_001",
    "output": [
        {
            "type": "web_search_call",
            "id": "ws_001",
            "status": "completed",
        },
        {
            "type": "message",
            "content": [
                {
                    "type": "output_text",
                    "text": "Here are the findings.",
                    "annotations": [
                        {"url": "https://openai.com/research", "title": "OpenAI Research"},
                        {"url": "https://deepmind.com/research", "title": "DeepMind"},
                    ],
                },
            ],
        },
    ],
}

OPENAI_TOOL_USE_FIXTURE = {
    "id": "resp_openai_002",
    "output": [
        {"type": "tool_use", "name": "web_search", "id": "tu_001"},
        {"type": "tool_use", "name": "code_interpreter", "id": "tu_002"},
        {"type": "tool_use", "name": "web_search", "id": "tu_003"},
        {
            "type": "message",
            "content": [{"type": "output_text", "text": "Done."}],
        },
    ],
}


# ── Provider body error fixtures ─────────────────────────

BODY_ERROR_STRING_FIXTURE = {"error": "insufficient_quota"}
BODY_ERROR_DICT_FIXTURE = {"error": {"message": "API key expired", "code": "auth_error"}}
BODY_CLEAN_FIXTURE = {"output": [{"type": "message", "content": []}]}


class TestXAIContractFixtures:

    def setup_method(self):
        self.adapter = XAIResponsesAdapter()

    def test_success_fixture_parses_safe_citations(self):
        citations = self.adapter.parse_citations(XAI_SUCCESS_FIXTURE)
        urls = [c.source_url for c in citations]
        assert "https://arxiv.org/abs/2401.001" in urls
        assert "https://nature.com/articles/ai" in urls
        assert "javascript:alert(1)" not in urls
        assert len(citations) == 2

    def test_success_fixture_count_tool_calls(self):
        assert self.adapter.count_tool_calls(XAI_SUCCESS_FIXTURE) == 1

    def test_multi_search_fixture_count(self):
        assert self.adapter.count_tool_calls(XAI_MULTI_SEARCH_FIXTURE) == 3

    def test_failed_search_detected(self):
        err = self.adapter.detect_body_error(XAI_FAILED_SEARCH_FIXTURE)
        assert err is not None
        assert "rate_limit_exceeded" in err

    def test_success_no_body_error(self):
        assert self.adapter.detect_body_error(XAI_SUCCESS_FIXTURE) is None

    def test_top_level_citations_parsed(self):
        citations = self.adapter.parse_citations(XAI_TOP_LEVEL_CITATIONS_FIXTURE)
        urls = [c.source_url for c in citations]
        assert "https://example.com/source1" in urls
        assert "https://example.com/source2" in urls
        assert "ftp://bad-protocol.com/file" not in urls
        assert len(citations) == 2

    def test_top_level_citation_title(self):
        citations = self.adapter.parse_citations(XAI_TOP_LEVEL_CITATIONS_FIXTURE)
        source2 = next(c for c in citations if "source2" in c.source_url)
        assert source2.text == "Source 2"


class TestOpenAIContractFixtures:

    def setup_method(self):
        self.adapter = OpenAIResponsesAdapter()

    def test_success_fixture_parses_citations(self):
        citations = self.adapter.parse_citations(OPENAI_SUCCESS_FIXTURE)
        assert len(citations) == 2
        urls = [c.source_url for c in citations]
        assert "https://openai.com/research" in urls
        assert "https://deepmind.com/research" in urls

    def test_success_fixture_count_tool_calls(self):
        assert self.adapter.count_tool_calls(OPENAI_SUCCESS_FIXTURE) == 1

    def test_tool_use_type_counted(self):
        assert self.adapter.count_tool_calls(OPENAI_TOOL_USE_FIXTURE) == 2

    def test_code_interpreter_not_counted(self):
        count = self.adapter.count_tool_calls(OPENAI_TOOL_USE_FIXTURE)
        assert count == 2  # only web_search, not code_interpreter

    def test_no_body_error_on_success(self):
        assert self.adapter.detect_body_error(OPENAI_SUCCESS_FIXTURE) is None


class TestNullAdapterContractFixtures:

    def test_ignores_all_fixtures(self):
        adapter = _NullAdapter()
        assert adapter.parse_citations(XAI_SUCCESS_FIXTURE) == []
        assert adapter.count_tool_calls(XAI_MULTI_SEARCH_FIXTURE) == 0
        assert adapter.detect_body_error(XAI_FAILED_SEARCH_FIXTURE) is None


class TestProviderBodyErrorFixtures:

    def test_string_error(self):
        result = _detect_provider_body_error("xai", BODY_ERROR_STRING_FIXTURE)
        assert result is not None
        assert "insufficient_quota" in result

    def test_dict_error(self):
        result = _detect_provider_body_error("openai", BODY_ERROR_DICT_FIXTURE)
        assert result is not None
        assert "API key expired" in result

    def test_clean_body(self):
        assert _detect_provider_body_error("tavily", BODY_CLEAN_FIXTURE) is None

    def test_non_dict_body(self):
        assert _detect_provider_body_error("exa", "text") is None  # type: ignore[arg-type]


class TestAdapterRegistryContract:

    def test_xai_adapter_properties(self):
        adapter = get_adapter("xai")
        assert adapter.max_domains == 5
        assert adapter.max_tool_calls == 5

    def test_openai_adapter_properties(self):
        adapter = get_adapter("openai")
        assert adapter.max_domains == 100
        assert adapter.max_tool_calls == 5

    def test_unknown_provider_null(self):
        adapter = get_adapter("anthropic")
        assert isinstance(adapter, _NullAdapter)
        assert adapter.max_domains == 0
        assert adapter.max_tool_calls == 0

    def test_all_registered_adapters_have_required_methods(self):
        for name in ("xai", "openai"):
            adapter = get_adapter(name)
            assert hasattr(adapter, "build_search_tools")
            assert hasattr(adapter, "parse_citations")
            assert hasattr(adapter, "detect_body_error")
            assert hasattr(adapter, "count_tool_calls")
            assert hasattr(adapter, "max_domains")
            assert hasattr(adapter, "max_tool_calls")
