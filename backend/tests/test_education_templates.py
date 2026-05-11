"""Tests for S6-2 education scenario presets — service + API."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.education_templates import (
    TEMPLATES,
    get_template,
    instantiate_template,
    list_templates,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def enable_feature(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_EDUCATION_TEMPLATES", True)


@pytest.fixture
def disable_feature(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_EDUCATION_TEMPLATES", False)


# ── service: list_templates ─────────────────────────────


def test_list_templates_no_filter_returns_all() -> None:
    result = list_templates()
    assert len(result) == len(TEMPLATES) == 6
    ids = {t["id"] for t in result}
    assert ids == {t["id"] for t in TEMPLATES}


def test_list_templates_filter_by_category() -> None:
    result = list_templates(category="debate_training")
    assert len(result) == 1
    assert result[0]["id"] == "debate_basics"
    assert all(t["category"] == "debate_training" for t in result)


def test_list_templates_filter_by_difficulty() -> None:
    result = list_templates(difficulty="advanced")
    assert all(t["difficulty"] == "advanced" for t in result)
    ids = {t["id"] for t in result}
    assert {"historical_industrial_revolution", "science_climate_intervention"} <= ids


def test_list_templates_combined_filters() -> None:
    result = list_templates(category="philosophy", difficulty="intermediate")
    assert len(result) == 1
    assert result[0]["id"] == "philosophy_trolley_variants"


def test_list_templates_unknown_category_returns_empty() -> None:
    assert list_templates(category="not_a_real_category") == []


def test_list_templates_returns_deep_copies() -> None:
    first = list_templates()
    first[0]["title_zh"] = "MUTATED"
    second = list_templates()
    assert second[0]["title_zh"] != "MUTATED"


# ── service: get_template ───────────────────────────────


def test_get_template_found() -> None:
    template = get_template("debate_basics")
    assert template is not None
    assert template["id"] == "debate_basics"
    assert template["category"] == "debate_training"
    assert "title_zh" in template
    assert "title_en" in template
    assert template["suggested_agents"] == 4


def test_get_template_not_found_returns_none() -> None:
    assert get_template("does_not_exist") is None
    assert get_template("") is None


def test_get_template_returns_deep_copy() -> None:
    first = get_template("debate_basics")
    assert first is not None
    first["title_zh"] = "MUTATED"
    second = get_template("debate_basics")
    assert second is not None
    assert second["title_zh"] != "MUTATED"


# ── service: instantiate_template ───────────────────────


def test_instantiate_template_default_language_is_zh() -> None:
    request = instantiate_template("debate_basics")
    assert request["question"] == "AI 是否应该替代教师？"
    assert request["language"] == "zh"
    assert request["num_agents"] == 4
    assert request["rounds"] == 5
    assert request["mode"] == "debate"
    assert request["visualization_enabled"] is True
    assert request["template_id"] == "debate_basics"


def test_instantiate_template_english() -> None:
    request = instantiate_template("debate_basics", language="en")
    assert request["question"] == "Should AI replace teachers?"
    assert request["language"] == "en"


def test_instantiate_template_with_overrides() -> None:
    request = instantiate_template(
        "debate_basics",
        language="zh",
        overrides={"num_agents": 10, "rounds": 12, "custom_field": "extra"},
    )
    assert request["num_agents"] == 10
    assert request["rounds"] == 12
    assert request["custom_field"] == "extra"
    assert request["question"] == "AI 是否应该替代教师？"


def test_instantiate_template_invalid_language_falls_back_to_zh() -> None:
    request = instantiate_template("debate_basics", language="fr")
    assert request["language"] == "zh"
    assert request["question"] == "AI 是否应该替代教师？"


def test_instantiate_template_unknown_id_raises() -> None:
    with pytest.raises(ValueError, match="Template not found"):
        instantiate_template("unknown_id")


# ── API: feature gate ────────────────────────────────────


def test_api_list_templates_404_when_disabled(client, disable_feature) -> None:
    response = client.get("/api/scenario/templates")
    assert response.status_code == 404
    body = response.json()
    assert body.get("detail", {}).get("code") == "FEATURE_DISABLED"


def test_api_get_template_404_when_disabled(client, disable_feature) -> None:
    response = client.get("/api/scenario/templates/debate_basics")
    assert response.status_code == 404
    body = response.json()
    assert body.get("detail", {}).get("code") == "FEATURE_DISABLED"


# ── API: enabled ─────────────────────────────────────────


def test_api_list_templates_enabled_returns_all(client, enable_feature) -> None:
    response = client.get("/api/scenario/templates")
    assert response.status_code == 200
    payload = response.json()
    assert "templates" in payload
    assert len(payload["templates"]) == 6


def test_api_list_templates_filter_by_category(client, enable_feature) -> None:
    response = client.get("/api/scenario/templates", params={"category": "economics"})
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["templates"]) == 1
    assert payload["templates"][0]["id"] == "economics_universal_basic_income"


def test_api_list_templates_filter_by_difficulty(client, enable_feature) -> None:
    response = client.get(
        "/api/scenario/templates",
        params={"difficulty": "beginner"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert all(t["difficulty"] == "beginner" for t in payload["templates"])


def test_api_list_templates_invalid_category_returns_422(client, enable_feature) -> None:
    response = client.get(
        "/api/scenario/templates",
        params={"category": "not_a_real_category"},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "TEMPLATE_CATEGORY_INVALID"


def test_api_list_templates_invalid_difficulty_returns_422(client, enable_feature) -> None:
    response = client.get(
        "/api/scenario/templates",
        params={"difficulty": "expert"},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "TEMPLATE_DIFFICULTY_INVALID"


def test_api_get_template_found(client, enable_feature) -> None:
    response = client.get("/api/scenario/templates/critical_thinking_media")
    assert response.status_code == 200
    payload = response.json()
    assert payload["id"] == "critical_thinking_media"
    assert payload["category"] == "critical_thinking"
    assert payload["suggested_agents"] == 6


def test_api_get_template_not_found_returns_404(client, enable_feature) -> None:
    response = client.get("/api/scenario/templates/no_such_template")
    assert response.status_code == 404
    body = response.json()
    assert body.get("detail", {}).get("code") == "TEMPLATE_NOT_FOUND"


def test_api_get_template_does_not_collide_with_scenario_route(
    client, enable_feature
) -> None:
    """Confirm /scenario/templates is matched before /scenario/{scenario_id}."""
    response = client.get("/api/scenario/templates")
    assert response.status_code == 200
    assert "templates" in response.json()


# ── data integrity ───────────────────────────────────────


def test_all_templates_have_required_fields() -> None:
    required = {
        "id",
        "category",
        "title_zh",
        "title_en",
        "description_zh",
        "description_en",
        "difficulty",
        "suggested_agents",
        "suggested_rounds",
        "tags",
        "default_config",
    }
    for template in TEMPLATES:
        missing = required - template.keys()
        assert not missing, f"Template {template.get('id')} missing: {missing}"
        assert template["difficulty"] in {"beginner", "intermediate", "advanced"}
        assert isinstance(template["tags"], list)
        assert isinstance(template["default_config"], dict)


def test_template_ids_are_unique() -> None:
    ids = [t["id"] for t in TEMPLATES]
    assert len(ids) == len(set(ids))


def test_template_categories_cover_six_domains() -> None:
    categories = {t["category"] for t in TEMPLATES}
    expected = {
        "debate_training",
        "critical_thinking",
        "historical_simulation",
        "science_exploration",
        "philosophy",
        "economics",
    }
    assert categories == expected
