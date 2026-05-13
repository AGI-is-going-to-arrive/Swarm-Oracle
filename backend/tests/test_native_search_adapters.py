"""P3-1: Native search adapter contract tests."""

from app.services.native_search_adapters import (
    OpenAIResponsesAdapter,
    XAIResponsesAdapter,
    _NullAdapter,
    get_adapter,
)


class TestXAIResponsesAdapter:

    def setup_method(self):
        self.adapter = XAIResponsesAdapter()

    def test_max_domains(self):
        assert self.adapter.max_domains == 5

    def test_build_tools_no_domains(self):
        tools = self.adapter.build_search_tools()
        assert tools == [{"type": "web_search"}]

    def test_build_tools_with_domains_within_limit(self):
        tools = self.adapter.build_search_tools(domains=["a.com", "b.com"])
        assert tools == [{"type": "web_search", "filters": {"allowed_domains": ["a.com", "b.com"]}}]

    def test_build_tools_sanitizes_domains(self):
        tools = self.adapter.build_search_tools(
            domains=["A.com", "bad domain", "a.com", "bücher.example"],
        )
        assert tools == [{
            "type": "web_search",
            "filters": {"allowed_domains": ["a.com", "xn--bcher-kva.example"]},
        }]

    def test_build_tools_caps_at_max_domains(self):
        domains = [f"d{i}.com" for i in range(10)]
        tools = self.adapter.build_search_tools(domains=domains)
        assert len(tools[0]["filters"]["allowed_domains"]) == 5

    def test_build_tools_empty_domains(self):
        tools = self.adapter.build_search_tools(domains=[])
        assert tools == []

    def test_build_tools_all_invalid_domains(self):
        tools = self.adapter.build_search_tools(domains=["bad domain", "javascript:alert(1)"])
        assert tools == []

    def test_parse_citations_with_annotations(self):
        body = {
            "output": [{
                "type": "message",
                "content": [{
                    "text": "AI is advancing",
                    "annotations": [
                        {"url": "https://example.com/1", "title": "Source 1"},
                        {"url": "https://example.com/2", "title": "Source 2"},
                    ],
                }],
            }],
        }
        citations = self.adapter.parse_citations(body)
        assert len(citations) == 2
        assert citations[0].source_url == "https://example.com/1"
        assert citations[0].text == "Source 1"

    def test_parse_citations_with_top_level_citations(self):
        body = {
            "citations": [
                "https://example.com/1",
                {"url": "https://example.com/2", "title": "Source 2"},
            ],
        }
        citations = self.adapter.parse_citations(body)
        assert [c.source_url for c in citations] == [
            "https://example.com/1",
            "https://example.com/2",
        ]
        assert citations[1].text == "Source 2"

    def test_parse_citations_filters_unsafe_urls(self):
        body = {
            "citations": [
                "javascript:alert(1)",
                {"url": "ftp://example.com/file", "title": "FTP"},
                {"url": "https:///missing-host", "title": "Bad"},
                {"url": "https://safe.example/source", "title": "Safe"},
            ],
        }
        citations = self.adapter.parse_citations(body)
        assert len(citations) == 1
        assert citations[0].source_url == "https://safe.example/source"

    def test_parse_citations_deduplicates_urls(self):
        body = {
            "output": [{
                "type": "message",
                "content": [
                    {"text": "a", "annotations": [{"url": "https://dup.com", "title": "A"}]},
                    {"text": "b", "annotations": [{"url": "https://dup.com", "title": "B"}]},
                ],
            }],
        }
        citations = self.adapter.parse_citations(body)
        assert len(citations) == 1

    def test_parse_citations_empty_output(self):
        assert self.adapter.parse_citations({}) == []
        assert self.adapter.parse_citations({"output": []}) == []

    def test_parse_citations_no_annotations(self):
        body = {
            "output": [{
                "type": "message",
                "content": [{"text": "plain text"}],
            }],
        }
        assert self.adapter.parse_citations(body) == []

    def test_parse_citations_skips_empty_url(self):
        body = {
            "output": [{
                "type": "message",
                "content": [{
                    "text": "x",
                    "annotations": [{"url": "", "title": "No URL"}],
                }],
            }],
        }
        assert self.adapter.parse_citations(body) == []

    def test_parse_citations_uses_url_as_text_fallback(self):
        body = {
            "output": [{
                "type": "message",
                "content": [{
                    "text": "x",
                    "annotations": [{"url": "https://fallback.com"}],
                }],
            }],
        }
        citations = self.adapter.parse_citations(body)
        assert citations[0].text == "https://fallback.com"

    def test_detect_body_error_returns_none_on_clean(self):
        assert self.adapter.detect_body_error({}) is None
        assert self.adapter.detect_body_error({"output": [{"type": "message"}]}) is None

    def test_detect_body_error_returns_none_on_non_dict_input(self):
        assert self.adapter.detect_body_error(None) is None
        assert self.adapter.detect_body_error([]) is None
        assert self.adapter.detect_body_error("bad") is None

    def test_detect_body_error_detects_failed_search_call(self):
        body = {
            "output": [
                {"type": "web_search_call", "status": "failed", "error": "rate_limited"},
            ],
        }
        err = self.adapter.detect_body_error(body)
        assert err is not None
        assert err == "xAI web_search_call failed"

    def test_detect_body_error_ignores_successful_search_call(self):
        body = {
            "output": [
                {"type": "web_search_call", "status": "completed"},
            ],
        }
        assert self.adapter.detect_body_error(body) is None

    def test_count_tool_calls_zero(self):
        assert self.adapter.count_tool_calls({}) == 0
        assert self.adapter.count_tool_calls({"output": []}) == 0

    def test_count_tool_calls_web_search_call(self):
        body = {
            "output": [
                {"type": "web_search_call", "status": "completed"},
                {"type": "message", "content": [{"text": "hi"}]},
                {"type": "web_search_call", "status": "completed"},
            ],
        }
        assert self.adapter.count_tool_calls(body) == 2

    def test_count_tool_calls_tool_use_named(self):
        body = {
            "output": [
                {"type": "tool_use", "name": "web_search"},
                {"type": "tool_use", "name": "code_interpreter"},
            ],
        }
        assert self.adapter.count_tool_calls(body) == 1

    def test_max_tool_calls_default(self):
        assert self.adapter.max_tool_calls == 5


class TestOpenAIResponsesAdapter:

    def test_max_domains(self):
        adapter = OpenAIResponsesAdapter()
        assert adapter.max_domains == 100

    def test_build_tools_caps_at_100(self):
        adapter = OpenAIResponsesAdapter()
        domains = [f"d{i}.com" for i in range(150)]
        tools = adapter.build_search_tools(domains=domains)
        assert len(tools[0]["filters"]["allowed_domains"]) == 100

    def test_build_tools_all_invalid_domains(self):
        adapter = OpenAIResponsesAdapter()
        tools = adapter.build_search_tools(domains=["bad domain", "javascript:alert(1)"])
        assert tools == []


class TestGetAdapter:

    def test_xai(self):
        adapter = get_adapter("xai")
        assert isinstance(adapter, XAIResponsesAdapter)

    def test_openai(self):
        adapter = get_adapter("openai")
        assert isinstance(adapter, OpenAIResponsesAdapter)

    def test_unknown_returns_null(self):
        adapter = get_adapter("deepseek")
        assert isinstance(adapter, _NullAdapter)
        assert adapter.build_search_tools() == []
        assert adapter.parse_citations({}) == []
        assert adapter.detect_body_error({}) is None

    def test_null_adapter_max_domains(self):
        adapter = get_adapter("unknown_provider")
        assert adapter.max_domains == 0

    def test_null_adapter_max_tool_calls(self):
        adapter = get_adapter("unknown_provider")
        assert adapter.max_tool_calls == 0

    def test_null_adapter_count_tool_calls(self):
        adapter = get_adapter("unknown_provider")
        assert adapter.count_tool_calls({"output": [{"type": "web_search_call"}]}) == 0


class TestOpenAIDetectBodyError:

    def setup_method(self):
        self.adapter = OpenAIResponsesAdapter()

    def test_clean_response(self):
        assert self.adapter.detect_body_error({}) is None

    def test_non_dict_input_returns_none(self):
        assert self.adapter.detect_body_error(None) is None
        assert self.adapter.detect_body_error([]) is None
        assert self.adapter.detect_body_error("bad") is None

    def test_failed_search_call(self):
        body = {
            "output": [
                {"type": "web_search_call", "status": "failed", "error": "timeout"},
            ],
        }
        err = self.adapter.detect_body_error(body)
        assert err is not None
        assert err == "OpenAI web_search_call failed"

    def test_count_tool_calls(self):
        body = {
            "output": [
                {"type": "web_search_call", "status": "completed"},
                {"type": "web_search_call", "status": "completed"},
                {"type": "web_search_call", "status": "completed"},
            ],
        }
        assert self.adapter.count_tool_calls(body) == 3

    def test_max_tool_calls_default(self):
        assert self.adapter.max_tool_calls == 5
