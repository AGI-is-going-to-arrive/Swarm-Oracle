from __future__ import annotations

from app.services.llm_resolution import resolve_post_completion_llm_call_config


def test_post_completion_resolution_drops_inherited_remote_byok_url_for_server_default(
    monkeypatch,
):
    import app.services.llm_resolution as llm_resolution

    monkeypatch.setattr(llm_resolution.settings, "LLM_API_KEY", "sk-server-default")

    resolved = resolve_post_completion_llm_call_config(
        parsed_context={
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "byok-profile-model",
            "llm_requests_per_minute": 3,
            "llm_tokens_per_minute": 4000,
            "llm_concurrency": 2,
            "supports_structured_outputs": False,
            "supports_native_search": True,
        }
    )

    assert resolved.api_key is None
    assert resolved.base_url is None
    assert resolved.model is None
    assert resolved.requests_per_minute is None
    assert resolved.tokens_per_minute is None
    assert resolved.concurrency is None
    assert resolved.supports_structured_outputs_override is None
    assert resolved.supports_native_search_override is None
    assert resolved.native_search_upstream_override is None
    assert resolved.inherit_context_policy is False


def test_post_completion_resolution_keeps_inherited_local_provider_url_without_key():
    resolved = resolve_post_completion_llm_call_config(
        parsed_context={
            "llm_base_url": "http://127.0.0.1:8317/v1",
            "llm_model": "local-model",
            "llm_requests_per_minute": 3,
            "llm_tokens_per_minute": 4000,
            "llm_concurrency": 2,
            "supports_structured_outputs": False,
            "supports_native_search": True,
        }
    )

    assert resolved.api_key is None
    assert resolved.base_url == "http://127.0.0.1:8317/v1"
    assert resolved.model == "local-model"
    assert resolved.requests_per_minute == 3
    assert resolved.tokens_per_minute == 4000
    assert resolved.concurrency == 2
    assert resolved.supports_structured_outputs_override is False
    assert resolved.supports_native_search_override is True
