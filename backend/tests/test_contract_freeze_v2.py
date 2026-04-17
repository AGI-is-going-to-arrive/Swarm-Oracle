"""Contract Freeze v2 — BE-5 (R3-C2 closure).

Locks the request-payload surface for ``POST /api/scenario`` and the
``WebSearchOverride`` schema to their v1 pre-plan state. Provider override
aggregation is intentionally absent from the request schema — it is surfaced
read-only via ``GET /api/capabilities`` (owned by BE-6) so that request/response
schema drift cannot reintroduce the R3-C2 vulnerability.

Assertions:
1. ``CreateScenarioRequest`` rejects arbitrary extra fields (``extra='forbid'``).
2. ``POST /api/scenario`` with a stray ``providers`` key returns 422.
3. ``POST /api/scenario`` with an unknown field returns 422.
4. ``WebSearchOverride`` JSON schema does not expose ``providers``.
5. Constructing ``WebSearchOverride(providers=...)`` raises ``ValidationError``.
6. A known-good payload still returns a non-422 response (regression guard).
"""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.schemas import CreateScenarioRequest, WebSearchOverride
from app.main import app


@pytest.fixture()
def client():
    return TestClient(app)


# ── CreateScenarioRequest — extra='forbid' ────────────────


def test_create_scenario_request_forbids_providers_field():
    """Direct pydantic construction: extra 'providers' key raises ValidationError."""
    with pytest.raises(ValidationError) as excinfo:
        CreateScenarioRequest(
            question="What if we had providers?",
            providers=[{"name": "polymarket", "enabled": True}],
        )
    # Pydantic v2 flags unknown fields as "extra_forbidden"
    errs = excinfo.value.errors()
    assert any(e["type"] == "extra_forbidden" for e in errs), errs


def test_create_scenario_rejects_providers_extra_field(client):
    """POST /api/scenario with providers extra field must be 422 rejected."""
    resp = client.post(
        "/api/scenario",
        json={
            "question": "What if providers leaked?",
            "providers": [{"name": "polymarket", "enabled": True}],
        },
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    detail = str(body.get("detail", ""))
    assert "providers" in detail or "extra" in detail.lower(), body


def test_create_scenario_rejects_unknown_field(client):
    """POST /api/scenario with any unknown top-level field must be 422 rejected."""
    resp = client.post(
        "/api/scenario",
        json={"question": "What if unknown fields slipped?", "xyz": "foo"},
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    detail = str(body.get("detail", ""))
    assert "xyz" in detail or "extra" in detail.lower(), body


def test_create_scenario_valid_payload_regression(client):
    """Regression guard: known-good payload must not be 422 blocked.

    Accept 200 (LLM reachable) or 500 (LLM offline) — only 422 indicates a
    schema regression introduced by this change.
    """
    resp = client.post(
        "/api/scenario",
        json={
            "question": "What if pigs fly?",
            "web_search_enabled": True,
            "web_search_provider": "tavily",
        },
    )
    assert resp.status_code != 422, resp.text
    assert resp.status_code in (200, 500), resp.text


# ── WebSearchOverride — v1 pre-plan schema freeze ─────────


def test_web_search_override_v1_schema_has_no_providers():
    """WebSearchOverride JSON schema must NOT expose a 'providers' field."""
    schema = WebSearchOverride.model_json_schema()
    props = set(schema.get("properties", {}).keys())
    assert "providers" not in props, (
        f"WebSearchOverride must not expose 'providers' (R3-C2): got {props}"
    )
    # Additive tolerance: guarantee only v1 single-override fields remain.
    expected_v1_fields = {"enabled", "provider", "api_key", "base_url"}
    assert props == expected_v1_fields, (
        f"WebSearchOverride drifted from v1 pre-plan shape: {props}"
    )


def test_web_search_override_rejects_providers():
    """Constructing WebSearchOverride(providers=...) must raise ValidationError."""
    with pytest.raises(ValidationError) as excinfo:
        WebSearchOverride(
            enabled=True,
            providers={"polymarket": {"enabled": True}},
        )
    errs = excinfo.value.errors()
    assert any(e["type"] == "extra_forbidden" for e in errs), errs


def test_web_search_override_accepts_v1_fields():
    """Regression: v1 fields (enabled/provider/api_key/base_url) construct cleanly."""
    ov = WebSearchOverride(
        enabled=True,
        provider="tavily",
        api_key="test-key",
        base_url="https://api.tavily.com",
    )
    assert ov.enabled is True
    assert ov.provider == "tavily"
    assert ov.api_key == "test-key"
    assert ov.base_url == "https://api.tavily.com"
