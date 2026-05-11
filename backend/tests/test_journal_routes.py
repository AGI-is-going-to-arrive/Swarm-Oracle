"""Tests for the Personal Prediction Journal API."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.config import settings
from app.main import app
from app.models import Scenario, ScenarioStatus
from app.models.database import get_engine
from app.models.prediction_journal import PredictionJournalEntry
from app.services.journal_service import (
    AlreadyResolvedError,
    create_entry,
    resolve_entry,
)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "SESSION_SECRET", "")
    return TestClient(app)


@pytest.fixture
def journal_enabled(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PREDICTION_JOURNAL", True, raising=False)


def _headers(user_id: str = "journal-user") -> dict[str, str]:
    return {"X-User-Id": user_id}


def test_feature_flag_off_returns_404(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PREDICTION_JOURNAL", False, raising=False)

    resp = client.get("/api/me/journal", headers=_headers())

    assert resp.status_code == 404


def test_feature_flag_on_returns_empty_list(client, journal_enabled):
    resp = client.get("/api/me/journal", headers=_headers())

    assert resp.status_code == 200
    assert resp.json() == {"items": [], "limit": 50, "offset": 0}


def test_create_list_resolve_and_calibration_flow(client, journal_enabled):
    create_resp = client.post(
        "/api/me/journal",
        headers=_headers(),
        json={
            "scenario_id": None,
            "question": "Will the launch succeed?",
            "predicted_probability": 0.8,
        },
    )

    assert create_resp.status_code == 200
    created = create_resp.json()
    assert created["user_id"] == "journal-user"
    assert created["question"] == "Will the launch succeed?"
    assert created["predicted_probability"] == 0.8
    assert created["actual_outcome"] is None
    assert created["brier_score"] is None

    list_resp = client.get("/api/me/journal", headers=_headers())
    assert list_resp.status_code == 200
    assert list_resp.json()["items"][0]["id"] == created["id"]

    resolve_resp = client.patch(
        f"/api/me/journal/{created['id']}/resolve",
        headers=_headers(),
        json={"actual_outcome": True},
    )
    assert resolve_resp.status_code == 200
    resolved = resolve_resp.json()
    assert resolved["actual_outcome"] is True
    assert resolved["resolved_at"] is not None
    assert resolved["brier_score"] == pytest.approx(0.04)

    calibration_resp = client.get("/api/me/calibration", headers=_headers())
    assert calibration_resp.status_code == 200
    bins = calibration_resp.json()["bins"]
    assert len(bins) == 10
    assert bins[8] == {
        "range": [0.8, 0.9],
        "predicted_avg": pytest.approx(0.8),
        "actual_frequency": pytest.approx(1.0),
        "count": 1,
    }


def test_brier_score_for_true_outcome(client, journal_enabled):
    create_resp = client.post(
        "/api/me/journal",
        headers=_headers(),
        json={
            "scenario_id": None,
            "question": "Will demand increase?",
            "predicted_probability": 0.8,
        },
    )
    assert create_resp.status_code == 200

    resolve_resp = client.patch(
        f"/api/me/journal/{create_resp.json()['id']}/resolve",
        headers=_headers(),
        json={"actual_outcome": True},
    )

    assert resolve_resp.status_code == 200
    assert resolve_resp.json()["brier_score"] == pytest.approx(0.04)


def test_resolve_already_resolved_entry_returns_409(client, journal_enabled):
    create_resp = client.post(
        "/api/me/journal",
        headers=_headers(),
        json={
            "scenario_id": None,
            "question": "Will the forecast be settled once?",
            "predicted_probability": 0.7,
        },
    )
    assert create_resp.status_code == 200
    entry_id = create_resp.json()["id"]

    first = client.patch(
        f"/api/me/journal/{entry_id}/resolve",
        headers=_headers(),
        json={"actual_outcome": True},
    )
    assert first.status_code == 200

    second = client.patch(
        f"/api/me/journal/{entry_id}/resolve",
        headers=_headers(),
        json={"actual_outcome": False},
    )
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "JOURNAL_ENTRY_ALREADY_RESOLVED"


def test_resolve_foreign_entry_returns_403(client, journal_enabled):
    create_resp = client.post(
        "/api/me/journal",
        headers=_headers("owner-a"),
        json={
            "scenario_id": None,
            "question": "Will the branch win?",
            "predicted_probability": 0.6,
        },
    )
    assert create_resp.status_code == 200

    resolve_resp = client.patch(
        f"/api/me/journal/{create_resp.json()['id']}/resolve",
        headers=_headers("owner-b"),
        json={"actual_outcome": False},
    )

    assert resolve_resp.status_code == 403


def test_create_rejects_unowned_legacy_scenario(client, journal_enabled):
    with Session(get_engine()) as session:
        scenario = Scenario(
            id="legacy-null-owner-scenario",
            question="Legacy unowned scenario?",
            status=ScenarioStatus.DONE,
            user_id=None,
        )
        session.add(scenario)
        session.commit()

    resp = client.post(
        "/api/me/journal",
        headers=_headers("journal-user"),
        json={
            "scenario_id": "legacy-null-owner-scenario",
            "question": "Can I attach to a legacy unowned scenario?",
            "predicted_probability": 0.5,
        },
    )

    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "SCENARIO_FORBIDDEN"


def test_resolve_stale_session_cannot_overwrite_settled_entry():
    with Session(get_engine()) as session:
        entry = create_entry(
            session,
            user_id="race-user",
            scenario_id=None,
            question="Will the race settle once?",
            predicted_probability=0.6,
        )
        entry_id = entry.id
    assert entry_id is not None

    first_session = Session(get_engine())
    stale_session = Session(get_engine())
    try:
        assert first_session.get(PredictionJournalEntry, entry_id) is not None
        assert stale_session.get(PredictionJournalEntry, entry_id) is not None

        first = resolve_entry(first_session, entry_id, True)
        assert first.actual_outcome is True

        with pytest.raises(AlreadyResolvedError):
            resolve_entry(stale_session, entry_id, False)
    finally:
        first_session.close()
        stale_session.close()

    with Session(get_engine()) as session:
        final = session.get(PredictionJournalEntry, entry_id)
    assert final is not None
    assert final.actual_outcome is True
