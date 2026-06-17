from types import SimpleNamespace

from sqlmodel import Session

from app.models import Scenario
from app.models.database import get_engine
from app.models.model_profile import ModelProfile
from app.services.llm_resolution import (
    model_profile_provider_unresolved,
    recover_profile_provider_overrides,
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


def test_model_profile_provider_unresolved_allows_recovered_key():
    scenario = Scenario(
        question="profile replay",
        parsed_context={"model_profile_id": "profile-a"},
    )

    assert (
        model_profile_provider_unresolved(
            scenario,
            {"api_key": "sk-recovered"},
        )
        is False
    )


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
