from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlmodel import Session

from app.models import Scenario
from app.models.database import get_engine
from app.models.model_profile import ModelProfile
from app.services.llm_resolution import (
    merge_profile_provider_overrides,
    model_profile_provider_unresolved,
    recover_profile_provider_overrides,
    resolve_post_completion_llm_call_config,
    scenario_has_model_profile_pointer,
)


def _make_profile(
    session: Session,
    *,
    user_id: str,
    name: str,
    api_key: str,
) -> ModelProfile:
    profile = ModelProfile(
        user_id=user_id,
        name=name,
        provider="openai",
        base_url="https://api.openai.com/v1",
        model="gpt-test",
        api_key=api_key,
        rpm=11,
        tpm=1100,
        concurrency=3,
        supports_structured_outputs=True,
        supports_native_search=False,
    )
    session.add(profile)
    session.flush()
    return profile


def test_recover_profile_provider_overrides_missing_profile_returns_none(monkeypatch):
    monkeypatch.setattr("app.services.llm_resolution.settings.FEATURE_MODEL_PROFILES", True)
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="missing profile",
            user_id="owner-a",
            parsed_context={"model_profile_id": "missing-profile"},
        )
        session.add(scenario)
        session.commit()

        assert recover_profile_provider_overrides(session, scenario) is None


def test_model_profile_provider_unresolved_requires_profile_pointer():
    scenario = Scenario(question="legacy", parsed_context={"llm_model": "legacy-model"})

    assert scenario_has_model_profile_pointer(scenario) is False
    assert model_profile_provider_unresolved(scenario, None) is False


def test_model_profile_provider_unresolved_fails_closed_without_key():
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "missing-profile"},
    )

    assert scenario_has_model_profile_pointer(scenario) is True
    assert model_profile_provider_unresolved(scenario, None) is True


def test_model_profile_provider_unresolved_requires_complete_explicit_provider():
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "profile-a"},
    )

    assert (
        model_profile_provider_unresolved(
            scenario,
            None,
            explicit_api_key="sk-request",
        )
        is True
    )
    assert (
        model_profile_provider_unresolved(
            scenario,
            None,
            explicit_api_key="sk-request",
            explicit_base_url="https://api.openai.com/v1",
            explicit_model="gpt-test",
        )
        is False
    )


@pytest.mark.parametrize(
    "recovered",
    [
        {"api_key": "sk-recovered"},
        {
            "api_key": "sk-recovered",
            "base_url": "https://api.openai.com/v1",
        },
        {
            "api_key": "sk-recovered",
            "model": "gpt-test",
        },
    ],
)
def test_model_profile_provider_unresolved_rejects_incomplete_recovered_remote_provider(
    recovered,
):
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "profile-a"},
    )

    assert (
        model_profile_provider_unresolved(
            scenario,
            recovered,
        )
        is True
    )


def test_model_profile_provider_unresolved_allows_complete_recovered_remote_provider():
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "profile-a"},
    )

    assert model_profile_provider_unresolved(
        scenario,
        {
            "api_key": "sk-recovered",
            "base_url": "https://api.openai.com/v1",
            "model": "gpt-test",
        },
    ) is False


@pytest.mark.parametrize(
    ("explicit_provider",),
    [
        ({"explicit_api_key": "sk-provider-a"},),
        ({"explicit_model": "provider-a-model"},),
        (
            {
                "explicit_api_key": "sk-provider-a",
                "explicit_base_url": "https://provider-a.example/v1",
            },
        ),
    ],
)
def test_model_profile_provider_unresolved_rejects_partial_explicit_provider_mix(
    explicit_provider,
):
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "profile-b"},
    )
    recovered = {
        "api_key": "sk-provider-b",
        "base_url": "https://api.openai.com/v1",
        "model": "provider-b-model",
    }

    assert model_profile_provider_unresolved(
        scenario,
        recovered,
        **explicit_provider,
    ) is True


def test_model_profile_provider_unresolved_allows_explicit_local_provider_without_key():
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "profile-a"},
    )

    assert (
        model_profile_provider_unresolved(
            scenario,
            None,
            explicit_base_url="http://127.0.0.1:11434/v1",
            explicit_model="llama3.2",
        )
        is False
    )


def test_model_profile_provider_unresolved_allows_recovered_local_provider_without_key():
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "profile-a"},
    )

    assert (
        model_profile_provider_unresolved(
            scenario,
            {
                "api_key": None,
                "base_url": "http://localhost:1234/v1",
                "model": "local-model",
            },
        )
        is False
    )


def test_post_completion_resolution_allows_explicit_local_provider_without_key():
    resolved = resolve_post_completion_llm_call_config(
        parsed_context=None,
        request_base_url="http://host.docker.internal:11434/v1",
        request_model="llama3.2",
    )

    assert resolved.api_key is None
    assert resolved.base_url == "http://host.docker.internal:11434/v1"
    assert resolved.model == "llama3.2"


def test_post_completion_resolution_rejects_explicit_remote_provider_without_key():
    with pytest.raises(HTTPException) as exc_info:
        resolve_post_completion_llm_call_config(
            parsed_context=None,
            request_base_url="https://api.openai.com/v1",
            request_model="gpt-test",
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["code"] == "BYOK_API_KEY_REQUIRED"


def test_post_completion_resolution_rejects_key_only_mix_with_inherited_remote_provider():
    with pytest.raises(HTTPException) as exc_info:
        resolve_post_completion_llm_call_config(
            parsed_context={
                "llm_base_url": "https://api.openai.com/v1",
                "llm_model": "provider-b-model",
            },
            request_api_key="sk-provider-a",
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["code"] == "BYOK_API_KEY_REQUIRED"


def test_post_completion_resolution_allows_complete_remote_provider_override():
    resolved = resolve_post_completion_llm_call_config(
        parsed_context={
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "provider-b-model",
        },
        request_api_key="sk-provider-a",
        request_base_url="https://provider-a.example/v1",
        request_model="provider-a-model",
    )

    assert resolved.api_key == "sk-provider-a"
    assert resolved.base_url == "https://provider-a.example/v1"
    assert resolved.model == "provider-a-model"


def test_profile_merge_does_not_carry_a_recovered_secret_to_an_explicit_local_override():
    recovered = {
        "api_key": "sk-remote-profile-secret",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-remote",
        "requests_per_minute": 10,
    }

    merged = merge_profile_provider_overrides(
        {
            "api_key": None,
            "base_url": "http://localhost:11434/v1",
            "model": "llama3.2",
        },
        recovered,
    )

    assert merged.get("api_key") is None
    assert merged["base_url"] == "http://localhost:11434/v1"
    assert merged["model"] == "llama3.2"
    assert "requests_per_minute" not in merged


def test_profile_merge_does_not_carry_provider_policy_to_a_complete_different_override():
    recovered = {
        "api_key": "sk-provider-a",
        "base_url": "https://provider-a.example/v1",
        "model": "provider-a-model",
        "requests_per_minute": 10,
        "tokens_per_minute": 1000,
        "concurrency": 2,
        "supports_structured_outputs_override": True,
        "supports_native_search_override": True,
        "native_search_upstream_override": "xai_responses",
        "model_profile_id": "profile-a",
        "quota_user_id": "owner-a",
    }

    merged = merge_profile_provider_overrides(
        {
            "api_key": "sk-provider-b",
            "base_url": "https://provider-b.example/v1",
            "model": "provider-b-model",
            "requests_per_minute": 7,
        },
        recovered,
        include_quota_user_id=True,
    )

    assert merged == {
        "api_key": "sk-provider-b",
        "base_url": "https://provider-b.example/v1",
        "model": "provider-b-model",
        "requests_per_minute": 7,
        "quota_user_id": "owner-a",
    }


def test_post_completion_complete_override_does_not_inherit_old_provider_policy():
    resolved = resolve_post_completion_llm_call_config(
        parsed_context={
            "llm_base_url": "https://provider-a.example/v1",
            "llm_model": "provider-a-model",
            "llm_requests_per_minute": 10,
            "llm_tokens_per_minute": 1000,
            "llm_concurrency": 2,
            "supports_structured_outputs": True,
            "supports_native_search": True,
            "native_search_upstream": "xai_responses",
        },
        request_api_key="sk-provider-b",
        request_base_url="https://provider-b.example/v1",
        request_model="provider-b-model",
        request_requests_per_minute=7,
    )

    assert resolved.api_key == "sk-provider-b"
    assert resolved.base_url == "https://provider-b.example/v1"
    assert resolved.model == "provider-b-model"
    assert resolved.requests_per_minute == 7
    assert resolved.tokens_per_minute is None
    assert resolved.concurrency is None
    assert resolved.supports_structured_outputs_override is None
    assert resolved.supports_native_search_override is None
    assert resolved.native_search_upstream_override is None
    assert resolved.inherit_context_policy is False


def test_post_completion_same_provider_binding_retains_its_context_policy():
    resolved = resolve_post_completion_llm_call_config(
        parsed_context={
            "llm_api_key": "sk-provider-a",
            "llm_base_url": "https://provider-a.example/v1",
            "llm_model": "provider-a-model",
            "llm_requests_per_minute": 10,
            "llm_tokens_per_minute": 1000,
            "llm_concurrency": 2,
            "supports_structured_outputs": False,
            "supports_native_search": True,
            "native_search_upstream": "openai_responses",
        },
        request_api_key="sk-provider-a",
        request_base_url="https://provider-a.example/v1",
        request_model="provider-a-model",
    )

    assert resolved.requests_per_minute == 10
    assert resolved.tokens_per_minute == 1000
    assert resolved.concurrency == 2
    assert resolved.supports_structured_outputs_override is False
    assert resolved.supports_native_search_override is True
    assert resolved.native_search_upstream_override == "openai_responses"
    assert resolved.inherit_context_policy is True


def test_post_completion_server_default_fallback_clears_old_remote_provider_policy(
    monkeypatch,
):
    monkeypatch.setattr("app.services.llm_resolution.settings.LLM_API_KEY", "server-key")

    resolved = resolve_post_completion_llm_call_config(
        parsed_context={
            "llm_base_url": "https://provider-a.example/v1",
            "llm_model": "provider-a-model",
            "llm_requests_per_minute": 10,
            "llm_tokens_per_minute": 1000,
            "llm_concurrency": 2,
            "supports_structured_outputs": True,
            "supports_native_search": True,
            "native_search_upstream": "xai_responses",
        },
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


def test_profile_merge_recovers_the_key_when_the_profile_endpoint_is_not_overridden():
    recovered = {
        "api_key": "sk-profile-secret",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-profile",
    }

    merged = merge_profile_provider_overrides(
        {"api_key": None, "base_url": None, "model": None},
        recovered,
    )

    assert merged["api_key"] == "sk-profile-secret"
    assert merged["base_url"] == "https://api.openai.com/v1"
    assert merged["model"] == "gpt-profile"


def test_recover_profile_provider_overrides_user_mismatch_returns_none(monkeypatch):
    monkeypatch.setattr("app.services.llm_resolution.settings.FEATURE_MODEL_PROFILES", True)
    engine = get_engine()
    with Session(engine) as session:
        profile = _make_profile(
            session,
            user_id="owner-a",
            name="Owner A",
            api_key="sk-owner-a",
        )
        scenario = Scenario(
            question="mismatched owner",
            user_id="owner-b",
            parsed_context={"model_profile_id": profile.id},
        )
        session.add(scenario)
        session.commit()

        assert recover_profile_provider_overrides(session, scenario) is None


def test_recover_profile_provider_overrides_missing_user_allows_single_profile_owner(
    monkeypatch,
):
    monkeypatch.setattr("app.services.llm_resolution.settings.FEATURE_MODEL_PROFILES", True)
    engine = get_engine()
    with Session(engine) as session:
        profile = _make_profile(
            session,
            user_id="owner-a",
            name="Owner A",
            api_key="sk-owner-a",
        )
        scenario = Scenario(
            question="local single-user recovery",
            parsed_context={"model_profile_id": profile.id},
        )
        session.add(scenario)
        session.commit()

        recovered = recover_profile_provider_overrides(session, scenario)

    assert recovered is not None
    assert recovered["api_key"] == "sk-owner-a"
    assert recovered["base_url"] == "https://api.openai.com/v1"
    assert recovered["model"] == "gpt-test"
    assert recovered["quota_user_id"] == "owner-a"


def test_recover_profile_provider_overrides_missing_user_refuses_multiple_profile_owners(
    monkeypatch,
):
    monkeypatch.setattr("app.services.llm_resolution.settings.FEATURE_MODEL_PROFILES", True)
    engine = get_engine()
    with Session(engine) as session:
        profile = _make_profile(
            session,
            user_id="owner-a",
            name="Owner A",
            api_key="sk-owner-a",
        )
        _make_profile(
            session,
            user_id="owner-b",
            name="Owner B",
            api_key="sk-owner-b",
        )
        scenario = Scenario(
            question="multi-user recovery",
            parsed_context={"model_profile_id": profile.id},
        )
        session.add(scenario)
        session.commit()

        assert recover_profile_provider_overrides(session, scenario) is None


def test_recover_profile_provider_overrides_missing_user_fail_closes_on_owner_count_error(
    monkeypatch,
):
    monkeypatch.setattr("app.services.llm_resolution.settings.FEATURE_MODEL_PROFILES", True)
    scenario = Scenario(
        question="owner count error",
        parsed_context={"model_profile_id": "profile-a"},
    )

    class FailingOwnerCountSession:
        def get(self, *_args):
            return SimpleNamespace(
                id="profile-a",
                user_id="owner-a",
                api_key="sk-owner-a",
                base_url="https://api.openai.com/v1",
                model="gpt-test",
                rpm=None,
                tpm=None,
                concurrency=None,
                supports_structured_outputs=None,
                supports_native_search=None,
            )

        def exec(self, *_args, **_kwargs):
            raise RuntimeError("owner count query failed")

    assert recover_profile_provider_overrides(FailingOwnerCountSession(), scenario) is None
