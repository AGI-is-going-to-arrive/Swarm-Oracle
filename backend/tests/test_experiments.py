"""Mixed experiment history pagination, filtering, and owner boundaries."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.api.experiments import _list_experiments_sync
from app.api.helpers import SessionPrincipal
from app.main import app
from app.models import (
    Debate,
    DebateStatus,
    EndingRoom,
    EndingRoomStatus,
    EndingRoomType,
    ModelProfile,
    Scenario,
    ScenarioStatus,
)
from app.models.database import ResourceDeletion, get_engine


@pytest.fixture
def experiments():
    at = datetime(2026, 9, 5, 0, 0, tzinfo=timezone.utc)
    with Session(get_engine()) as session:
        profile = ModelProfile(
            id="owner-profile", user_id="owner", name="Owned profile", model="owned-model"
        )
        private_profile = ModelProfile(
            id="private-profile", user_id="other", name="Private profile", model="private-model"
        )
        session.add(profile)
        session.add(private_profile)
        session.add(
            Scenario(
                id="shared-id",
                question="Alpha 100% scenario",
                user_id="owner",
                status=ScenarioStatus.DONE,
                created_at=at,
                parsed_context={"model_profile_id": profile.id},
            )
        )
        session.add(
            Scenario(
                id="newer",
                question="Beta running scenario",
                user_id="owner",
                status=ScenarioStatus.SIMULATING,
                created_at=at + timedelta(seconds=1),
            )
        )
        session.add(
            Scenario(
                id="cancelled",
                question="Stopped scenario",
                user_id="owner",
                status=ScenarioStatus.CANCELLED,
                created_at=at - timedelta(seconds=1),
            )
        )
        session.add(
            Scenario(
                id="private-scenario",
                question="Private owner scenario",
                user_id="other",
                status=ScenarioStatus.DONE,
                created_at=at + timedelta(seconds=2),
            )
        )
        session.flush()
        session.add(
            Debate(
                id="shared-id",
                question="Alpha debate",
                motion="Alpha motion",
                user_id="owner",
                status=DebateStatus.ERROR,
                created_at=at,
                breakdown_json={
                    "metadata": {
                        "run_config": {
                            "providers": {
                                "judge": {
                                    "name": "Judge model",
                                    "model": "judge-model",
                                    "api_key": "never-return-this",
                                },
                            }
                        }
                    }
                },
            )
        )
        session.add(
            Debate(
                id="private-debate",
                question="Private owner debate",
                motion="Private",
                user_id="other",
                status=DebateStatus.DONE,
                created_at=at + timedelta(seconds=2),
            )
        )
        session.add(
            EndingRoom(
                id="shared-id",
                scenario_id="shared-id",
                room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
                title="Alpha roundtable",
                participant_set_hash="hash",
                scope_fingerprint="scope",
                status=EndingRoomStatus.DONE,
                created_at=at,
            )
        )
        session.add(
            EndingRoom(
                id="private-room",
                scenario_id="private-scenario",
                room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
                title="Private room",
                participant_set_hash="private-hash",
                scope_fingerprint="private-scope",
                status=EndingRoomStatus.DONE,
                created_at=at,
            )
        )
        session.commit()
    return at


def _page(*, owner="owner", **options):
    return _list_experiments_sync(
        SessionPrincipal(subject=owner) if owner is not None else None,
        **{"q": "", "kind": "all", "status": "all", "limit": 2, "cursor": None, **options},
    )


def test_mixed_source_pagination_has_stable_timestamp_and_id_ties(experiments):
    items = []
    cursor = None
    for _ in range(3):
        page = _page(cursor=cursor)
        assert page["total"] == 5
        items.extend(page["items"])
        cursor = page["next_cursor"]
    assert cursor is None
    assert [(item["kind"], item["id"]) for item in items] == [
        ("scenario", "newer"),
        ("scenario", "shared-id"),
        ("roundtable", "shared-id"),
        ("debate", "shared-id"),
        ("scenario", "cancelled"),
    ]
    assert len({(item["kind"], item["id"]) for item in items}) == 5
    assert items[2]["source_scenario_id"] == "shared-id"
    assert items[2]["models"] == [{
        "name": "Owned profile", "model": "owned-model", "binding_status": "current_profile",
    }]
    assert items[3]["models"] == [{"role": "judge", "name": "Judge model", "model": "judge-model"}]
    assert "never-return-this" not in str(items)
    assert "owner_user_id" not in str(items)


def test_owner_filters_apply_to_counts_and_every_source_before_pagination(experiments):
    owner = _page(limit=50)
    other = _page(owner="other", limit=50)
    local = _page(owner=None, limit=50)
    assert owner["total"] == 5
    assert other["total"] == 3
    assert local["total"] == 8
    assert all("private" not in item["id"] for item in owner["items"])
    assert {item["kind"] for item in other["items"]} == {"scenario", "debate", "roundtable"}


def test_search_type_and_status_filters_run_on_the_server(experiments):
    assert _page(q="Alpha", limit=50)["total"] == 3
    assert _page(q="100%", limit=50)["total"] == 2
    assert _page(kind="debate", status="error")["items"][0]["id"] == "shared-id"
    assert _page(kind="roundtable", status="running")["total"] == 0
    stopped = _page(status="cancelled")
    assert stopped["total"] == 1
    assert stopped["items"][0]["source_status"] == "cancelled"


@pytest.mark.parametrize(
    "change", [{"q": "Alpha"}, {"kind": "debate"}, {"status": "done"}, {"owner": "other"}]
)
def test_cursor_cannot_be_reused_with_different_filters_or_owner(experiments, change):
    cursor = _page()["next_cursor"]
    with pytest.raises(HTTPException) as error:
        _page(cursor=cursor, **change)
    assert error.value.detail["code"] == "EXPERIMENT_CURSOR_INVALID"


def test_new_inserts_and_deleted_anchor_do_not_duplicate_or_skip_old_rows(experiments):
    first = _page(limit=1)
    assert first["items"][0]["id"] == "newer"
    with Session(get_engine()) as session:
        session.delete(session.get(Scenario, "newer"))
        session.add(
            Scenario(
                id="new-after-pagination",
                question="New",
                user_id="owner",
                status=ScenarioStatus.DONE,
                created_at=experiments + timedelta(seconds=5),
            )
        )
        session.commit()
    next_page = _page(limit=50, cursor=first["next_cursor"])
    assert len(next_page["items"]) == 4
    assert all(item["id"] != "new-after-pagination" for item in next_page["items"])


def test_foreign_profile_pointer_does_not_disclose_its_model(experiments):
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, "shared-id")
        scenario.parsed_context = {"model_profile_id": "private-profile"}
        session.add(scenario)
        session.commit()
    page = _page(limit=50)
    assert "Private profile" not in str(page)
    assert "private-model" not in str(page)


def test_recorded_scenario_model_is_not_relabelled_after_profile_edit(experiments):
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, "shared-id")
        scenario.parsed_context = {
            "model_profile_id": "owner-profile", "llm_model": "actual-historical-model",
        }
        session.add(scenario)
        session.commit()
    client = TestClient(app)
    response = client.patch(
        "/api/model-profiles/owner-profile?user_id=owner",
        json={"name": "Edited current profile", "model": "edited-current-model"},
    )
    assert response.status_code == 200
    page = _page(kind="scenario", q="Alpha", limit=50)
    assert page["items"][0]["models"] == [{
        "name": "actual-historical-model", "model": "actual-historical-model",
        "binding_status": "recorded",
    }]


def test_room_history_prefers_actual_generation_binding_over_scene_and_current_profile(experiments):
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, "shared-id")
        scenario.parsed_context = {
            "model_profile_id": "owner-profile", "llm_model": "historical-scene-model",
        }
        room = session.get(EndingRoom, "shared-id")
        room.config_json = {
            "room_model_profile_id": "owner-profile",
            "generation_provider": {
                "model_profile_id": "owner-profile", "name": "Actual room profile",
                "model": "actual-room-model", "api_key": "must-never-be-returned",
            },
        }
        session.add(scenario)
        session.add(room)
        session.commit()
    response = TestClient(app).patch(
        "/api/model-profiles/owner-profile?user_id=owner",
        json={"name": "Later room profile", "model": "later-room-model"},
    )
    assert response.status_code == 200
    item = _page(kind="roundtable", limit=50)["items"][0]
    assert item["models"] == [{
        "name": "Actual room profile", "model": "actual-room-model", "binding_status": "recorded",
    }]
    assert "must-never-be-returned" not in str(item)


def test_permanent_debate_tombstone_hides_even_a_leftover_row(experiments):
    with Session(get_engine()) as session:
        session.add(
            ResourceDeletion(
                resource_type="debate", resource_id="shared-id", user_id="owner", status="completed"
            )
        )
        session.commit()
    page = _page(limit=50)
    assert page["total"] == 4
    assert all(item["kind"] != "debate" for item in page["items"])


def test_experiments_endpoint_rejects_unbounded_or_invalid_queries(experiments):
    client = TestClient(app)
    assert client.get("/api/experiments", params={"limit": 51}).status_code == 422
    assert client.get("/api/experiments", params={"q": "x" * 201}).status_code == 422
    assert client.get("/api/experiments", params={"kind": "unknown"}).status_code == 422
    assert client.get("/api/experiments", params={"cursor": "not-a-cursor"}).status_code == 400
