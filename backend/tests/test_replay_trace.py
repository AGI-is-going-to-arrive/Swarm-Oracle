"""Tests for GET /api/scenario/{id}/replay-trace (BE-4).

Covers the Layer 3 acceptance matrix from the graph-playability-upgrade plan
(§BE-4 + §L513):

1.  ``FEATURE_REPLAY_TRACE`` off → 404 (no 500).
2.  Unauthenticated → 401 when SESSION_SECRET is configured.
3.  Cross-owner → 404 (ownership concealment, never 403).
4.  2x counterfactual + 1x resume + GET + 4th POST still 429 (shared pool
    with ``MAX_REPLAY_BRANCHES=3``; GET never consumes quota).
5.  ``after`` + ``limit`` cursor yields stable pagination.
6.  ``idx_branch_replay_source`` surfaces in ``EXPLAIN QUERY PLAN``.
7.  ``>100 branches`` query budget — response stays bounded.
8.  Zero-write — neither ``session.add`` nor ``session.commit`` fires on any
    request path exercised.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import inspect
import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session, select

from app.api import replay_trace as replay_trace_module
from app.api.replay_trace import router as replay_trace_router
from app.main import app
from app.models.checkpoint import ScenarioCheckpoint
from app.models.database import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.services.branch_lineage import BranchLineageError

# ── Fixtures ─────────────────────────────────────────────


def _ensure_router_registered() -> None:
    """Attach the replay-trace router without touching main.py.

    BE-4 owner contract forbids modifying ``backend/app/main.py``; the
    orchestrator Agent will merge the include_router snippet upstream.  For
    the local pytest process we include it here idempotently.
    """
    for route in app.routes:
        if getattr(route, "path", "") == "/api/scenario/{scenario_id}/replay-trace":
            return
    app.include_router(replay_trace_router)


_ensure_router_registered()


@pytest.fixture(autouse=True)
def _enable_feature(monkeypatch):
    monkeypatch.setattr(replay_trace_module.settings, "FEATURE_REPLAY_TRACE", True)
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _make_signed_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


# ── Seeding helpers ──────────────────────────────────────


def _seed_scenario(
    engine,
    *,
    status=ScenarioStatus.DONE,
    user_id=None,
    created_at=None,
):
    scenario_kwargs = {"question": "q", "status": status, "user_id": user_id}
    if created_at is not None:
        scenario_kwargs["created_at"] = created_at
    s = Scenario(**scenario_kwargs)
    with Session(engine) as session:
        session.add(s)
        session.commit()
        session.refresh(s)
        return s.id


def _seed_branch(
    engine,
    scenario_id: str,
    *,
    branch_id: str | None = None,
    title: str = "root",
    status=BranchStatus.ACTIVE,
    replay_kind=None,
    replay_source_branch_id=None,
    parent_branch_id=None,
    fork_round: int = 0,
    replay_source_round=None,
) -> str:
    branch_kwargs = dict(
        scenario_id=scenario_id,
        title=title,
        status=status,
        replay_kind=replay_kind,
        replay_source_branch_id=replay_source_branch_id,
        parent_branch_id=parent_branch_id,
        fork_round=fork_round,
        replay_source_round=replay_source_round,
    )
    if branch_id is not None:
        branch_kwargs["id"] = branch_id
    b = Branch(**branch_kwargs)
    with Session(engine) as session:
        session.add(b)
        session.commit()
        session.refresh(b)
        return b.id


def _seed_agent(engine, scenario_id, name="A"):
    a = Agent(scenario_id=scenario_id, name=name, role="analyst")
    with Session(engine) as session:
        session.add(a)
        session.commit()
        session.refresh(a)
        return a.id


def _seed_round(engine, branch_id, round_number):
    r = Round(branch_id=branch_id, round_number=round_number)
    with Session(engine) as session:
        session.add(r)
        session.commit()
        session.refresh(r)
        return r.id


def _seed_message(engine, round_id, agent_id, content="msg"):
    m = AgentMessage(round_id=round_id, agent_id=agent_id, content=content, emotion="neutral")
    with Session(engine) as session:
        session.add(m)
        session.commit()
        session.refresh(m)
        return m.id


def _seed_checkpoint(
    engine,
    scenario_id: str,
    branch_id: str,
    *,
    round_number: int,
    created_at: datetime,
) -> None:
    with Session(engine) as session:
        session.add(
            ScenarioCheckpoint(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=round_number,
                created_at=created_at,
            )
        )
        session.commit()


def _seed_scenario_with_lineage(engine, *, user_id=None, branch_count=3):
    """Scenario with 1 root branch + ``branch_count`` replay children."""
    sid = _seed_scenario(engine, user_id=user_id)
    root_bid = _seed_branch(engine, sid, title="root")
    aid = _seed_agent(engine, sid)
    rid = _seed_round(engine, root_bid, 1)
    _seed_message(engine, rid, aid)

    child_ids = []
    for idx in range(branch_count):
        cb = _seed_branch(
            engine,
            sid,
            title=f"replay-{idx}",
            replay_kind="counterfactual" if idx % 2 == 0 else "resume",
            replay_source_branch_id=root_bid,
            parent_branch_id=root_bid,
            fork_round=1,
            replay_source_round=1,
        )
        child_ids.append(cb)
    return sid, root_bid, aid, child_ids


# ── Tests ────────────────────────────────────────────────


class TestFeatureGate:
    def test_feature_off_returns_404(self, client, monkeypatch):
        monkeypatch.setattr(replay_trace_module.settings, "FEATURE_REPLAY_TRACE", False)
        engine = get_engine()
        sid = _seed_scenario(engine)
        resp = client.get(f"/api/scenario/{sid}/replay-trace")
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "FEATURE_DISABLED"


class TestAuth:
    def test_unauthenticated_returns_401_when_secret_configured(self, client, monkeypatch):
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", "s3cret")
        engine = get_engine()
        sid = _seed_scenario(engine, user_id="u1")
        resp = client.get(f"/api/scenario/{sid}/replay-trace")
        assert resp.status_code == 401

    def test_cross_owner_returns_404_not_403(self, client, monkeypatch):
        """Concealment: foreign scenario MUST surface as 404, not 403."""
        secret = "s3cret"
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
        engine = get_engine()
        sid = _seed_scenario(engine, user_id="owner_u")
        foreign_token = _make_signed_token(secret, "intruder_u")

        resp = client.get(
            f"/api/scenario/{sid}/replay-trace",
            headers={"X-Session-Token": foreign_token},
        )
        assert resp.status_code == 404
        # Must not leak existence or ownership
        assert resp.json()["detail"]["code"] == "SCENARIO_NOT_FOUND"

    def test_owner_concealment_precedes_conflicting_branch_filters(
        self,
        client,
        monkeypatch,
    ):
        secret = "s3cret"
        monkeypatch.setattr("app.api.helpers.settings.SESSION_SECRET", secret)
        engine = get_engine()
        scenario_id = _seed_scenario(engine, user_id="owner_u")
        foreign_token = _make_signed_token(secret, "intruder_u")

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={
                "branch_id": "private-target",
                "root_branch_id": "private-root",
            },
            headers={"X-Session-Token": foreign_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == {
            "code": "SCENARIO_NOT_FOUND",
            "message": "Scenario not found",
        }


class TestPagination:
    def test_cursor_and_limit_produce_stable_pages(self, client):
        engine = get_engine()
        sid, root_bid, _aid, children = _seed_scenario_with_lineage(
            engine, branch_count=5,
        )

        page1 = client.get(f"/api/scenario/{sid}/replay-trace?limit=2").json()
        assert len(page1["nodes"]) == 2
        assert page1["next_cursor"] is not None

        page2 = client.get(
            f"/api/scenario/{sid}/replay-trace?limit=2&after={page1['next_cursor']}"
        ).json()
        assert len(page2["nodes"]) == 2

        # No overlap, monotonic ordering (branch.id ASC)
        page1_ids = [n["branch_id"] for n in page1["nodes"]]
        page2_ids = [n["branch_id"] for n in page2["nodes"]]
        assert set(page1_ids).isdisjoint(page2_ids)
        assert page1_ids + page2_ids == sorted(page1_ids + page2_ids)

        # Only branches that declare replay_source_branch_id surface
        returned_ids = set(page1_ids + page2_ids)
        assert root_bid not in returned_ids
        assert returned_ids.issubset(set(children))

    def test_malformed_cursor_returns_400(self, client):
        engine = get_engine()
        sid, *_ = _seed_scenario_with_lineage(engine, branch_count=1)
        resp = client.get(f"/api/scenario/{sid}/replay-trace?after=   ")
        assert resp.status_code == 400

    def test_unknown_cursor_returns_400(self, client):
        engine = get_engine()
        sid, *_ = _seed_scenario_with_lineage(engine, branch_count=1)
        resp = client.get(f"/api/scenario/{sid}/replay-trace?after=nonexistent-branch-id")
        assert resp.status_code == 400

    def test_root_branch_id_filter(self, client):
        """``root_branch_id`` scopes to children whose replay_source_branch_id matches."""
        engine = get_engine()
        sid, root_bid, _aid, children = _seed_scenario_with_lineage(
            engine, branch_count=3,
        )
        # Add an unrelated lineage anchored on a different source
        other_root = _seed_branch(engine, sid, title="other-root")
        _seed_branch(
            engine, sid, title="other-child",
            replay_kind="counterfactual", replay_source_branch_id=other_root,
        )

        resp = client.get(
            f"/api/scenario/{sid}/replay-trace?root_branch_id={root_bid}&limit=50"
        )
        assert resp.status_code == 200
        returned = {n["branch_id"] for n in resp.json()["nodes"]}
        assert returned == set(children)


class TestTargetLineage:
    def test_target_orders_root_to_leaf_by_lineage_not_uuid(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        root_id = _seed_branch(engine, scenario_id, branch_id="zz-root")
        child_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="mm-child",
            parent_branch_id=root_id,
            fork_round=1,
        )
        leaf_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="aa-leaf",
            parent_branch_id=child_id,
            fork_round=2,
        )

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": f"  {leaf_id}  "},
        )

        assert response.status_code == 200
        assert [node["branch_id"] for node in response.json()["nodes"]] == [
            root_id,
            child_id,
            leaf_id,
        ]

    def test_target_paginates_by_lineage_position_and_validates_cursor(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        root_id = _seed_branch(engine, scenario_id, branch_id="zz-page-root")
        child_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="mm-page-child",
            parent_branch_id=root_id,
            fork_round=1,
        )
        leaf_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="aa-page-leaf",
            parent_branch_id=child_id,
            fork_round=2,
        )
        outside_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="outside-current-lineage",
        )

        page_one = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": leaf_id, "limit": 2},
        )
        assert page_one.status_code == 200
        assert [node["branch_id"] for node in page_one.json()["nodes"]] == [
            root_id,
            child_id,
        ]
        assert page_one.json()["next_cursor"] == child_id

        page_two = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": leaf_id, "limit": 2, "after": child_id},
        )
        assert page_two.status_code == 200
        assert [node["branch_id"] for node in page_two.json()["nodes"]] == [leaf_id]
        assert page_two.json()["next_cursor"] is None

        final_page = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": leaf_id, "limit": 2, "after": leaf_id},
        )
        assert final_page.status_code == 200
        assert final_page.json() == {"nodes": [], "next_cursor": None}

        invalid_cursor = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": leaf_id, "after": outside_id},
        )
        assert invalid_cursor.status_code == 400
        assert invalid_cursor.json()["detail"] == {
            "code": "REPLAY_TRACE_CURSOR_INVALID",
            "message": "Cursor branch is not in the selected lineage",
        }

    def test_replay_target_is_self_contained_and_ignores_replay_source(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        root_id = _seed_branch(engine, scenario_id, branch_id="native-root")
        clone_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="resume-clone",
            replay_kind="resume",
            replay_source_branch_id=root_id,
            parent_branch_id=root_id,
            fork_round=1,
        )
        _seed_branch(
            engine,
            scenario_id,
            branch_id="unrelated-replay",
            replay_kind="counterfactual",
            replay_source_branch_id=root_id,
            parent_branch_id=root_id,
            fork_round=1,
        )

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": clone_id},
        )

        assert response.status_code == 200
        assert [node["branch_id"] for node in response.json()["nodes"]] == [clone_id]

    def test_native_descendant_stops_at_replay_parent(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        native_root_id = _seed_branch(engine, scenario_id, branch_id="native-before-replay")
        replay_parent_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="replay-parent",
            replay_kind="resume",
            replay_source_branch_id=native_root_id,
            parent_branch_id=native_root_id,
            fork_round=1,
        )
        native_child_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="native-after-replay",
            parent_branch_id=replay_parent_id,
            fork_round=2,
        )

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": native_child_id},
        )

        assert response.status_code == 200
        assert [node["branch_id"] for node in response.json()["nodes"]] == [
            replay_parent_id,
            native_child_id,
        ]
        assert native_root_id not in {
            node["branch_id"] for node in response.json()["nodes"]
        }

    def test_unstarted_target_without_rounds_is_valid(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_id = _seed_branch(engine, scenario_id, branch_id="empty-unstarted")

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": branch_id},
        )

        assert response.status_code == 200
        assert [node["branch_id"] for node in response.json()["nodes"]] == [branch_id]

    def test_blank_target_keeps_legacy_unfiltered_contract(self, client):
        engine = get_engine()
        scenario_id, *_ = _seed_scenario_with_lineage(engine, branch_count=3)

        unfiltered = client.get(f"/api/scenario/{scenario_id}/replay-trace?limit=50")
        blank_target = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"limit": 50, "branch_id": "   "},
        )

        assert blank_target.status_code == 200
        assert blank_target.json() == unfiltered.json()

    def test_target_and_legacy_root_conflict_is_fixed_400(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        root_id = _seed_branch(engine, scenario_id)
        target_id = _seed_branch(
            engine,
            scenario_id,
            parent_branch_id=root_id,
            fork_round=1,
        )

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": target_id, "root_branch_id": root_id},
        )

        assert response.status_code == 400
        assert response.json()["detail"] == {
            "code": "REPLAY_TRACE_BRANCH_FILTER_CONFLICT",
            "message": "branch_id cannot be combined with root_branch_id",
        }

    def test_endpoint_is_sync_for_fastapi_threadpool(self):
        assert inspect.iscoroutinefunction(replay_trace_module.get_replay_trace) is False

    def test_target_avoids_duplicate_scoped_branch_precheck(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_id = _seed_branch(engine, scenario_id, branch_id="single-target-lookup")
        branch_selects: list[str] = []

        def capture_branch_selects(
            _connection,
            _cursor,
            statement,
            _parameters,
            _context,
            _executemany,
        ):
            normalized = " ".join(str(statement).split()).lower()
            if normalized.startswith("select") and " from branch " in normalized:
                branch_selects.append(normalized)

        event.listen(engine, "before_cursor_execute", capture_branch_selects)
        try:
            response = client.get(
                f"/api/scenario/{scenario_id}/replay-trace",
                params={"branch_id": branch_id},
            )
        finally:
            event.remove(engine, "before_cursor_execute", capture_branch_selects)

        assert response.status_code == 200
        assert len(branch_selects) == 2

    def test_target_response_preserves_exact_existing_wire_keys(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_id = _seed_branch(engine, scenario_id, branch_id="wire-target")

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": branch_id},
        )

        assert response.status_code == 200
        payload = response.json()
        assert set(payload) == {"nodes", "next_cursor"}
        assert len(payload["nodes"]) == 1
        assert set(payload["nodes"][0]) == {
            "branch_id",
            "parent_branch_id",
            "replay_source_branch_id",
            "origin_round",
            "replay_kind",
            "status",
            "created_at",
        }


class TestTargetLineageErrors:
    def test_missing_target_is_generic_404(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        missing_id = "sensitive-missing-target"

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": missing_id},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == {
            "code": "BRANCH_NOT_FOUND",
            "message": "Branch not found in scenario",
        }
        assert missing_id not in response.text

    def test_cross_scenario_target_is_generic_404(self, client):
        engine = get_engine()
        requested_scenario_id = _seed_scenario(engine)
        foreign_scenario_id = _seed_scenario(engine)
        foreign_branch_id = _seed_branch(
            engine,
            foreign_scenario_id,
            branch_id="sensitive-foreign-target",
        )

        response = client.get(
            f"/api/scenario/{requested_scenario_id}/replay-trace",
            params={"branch_id": foreign_branch_id},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == {
            "code": "BRANCH_NOT_FOUND",
            "message": "Branch not found in scenario",
        }
        assert foreign_branch_id not in response.text

    def test_resolver_not_found_is_generic_404(self, client, monkeypatch):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_id = _seed_branch(engine, scenario_id, branch_id="race-target")

        def resolver_not_found(*_args, **_kwargs):
            raise BranchLineageError(
                "BRANCH_LINEAGE_BRANCH_NOT_FOUND",
                "sensitive race target details",
            )

        monkeypatch.setattr(
            replay_trace_module,
            "resolve_branch_lineage",
            resolver_not_found,
            raising=False,
        )

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": branch_id},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == {
            "code": "BRANCH_NOT_FOUND",
            "message": "Branch not found in scenario",
        }
        assert "sensitive" not in response.text

    def test_page_branch_disappearing_after_resolution_is_generic_404(
        self,
        client,
        monkeypatch,
    ):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        branch_id = _seed_branch(engine, scenario_id, branch_id="sensitive-page-race")
        real_resolver = replay_trace_module.resolve_branch_lineage

        def resolve_then_delete_page_branch(session, **kwargs):
            lineage = real_resolver(session, **kwargs)
            session.rollback()
            with Session(engine) as delete_session:
                page_branch = delete_session.get(Branch, branch_id)
                assert page_branch is not None
                delete_session.delete(page_branch)
                delete_session.commit()
            return lineage

        monkeypatch.setattr(
            replay_trace_module,
            "resolve_branch_lineage",
            resolve_then_delete_page_branch,
        )

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": branch_id},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == {
            "code": "BRANCH_NOT_FOUND",
            "message": "Branch not found in scenario",
        }
        assert branch_id not in response.text

    @pytest.mark.parametrize(
        ("corruption", "expected_code"),
        [
            ("missing_parent", "BRANCH_LINEAGE_MISSING_PARENT"),
            ("cycle", "BRANCH_LINEAGE_CYCLE"),
            ("cross_scenario_parent", "BRANCH_LINEAGE_CROSS_SCENARIO_PARENT"),
            ("invalid_fork", "BRANCH_LINEAGE_INVALID_FORK_BOUNDARY"),
        ],
    )
    def test_corrupt_target_is_stable_409_without_ids(
        self,
        client,
        corruption,
        expected_code,
    ):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        root_id = _seed_branch(engine, scenario_id, branch_id=f"secret-{corruption}-root")
        target_id = _seed_branch(
            engine,
            scenario_id,
            branch_id=f"secret-{corruption}-target",
            parent_branch_id=root_id,
            fork_round=1,
        )
        sensitive_ids = {root_id, target_id}

        if corruption == "missing_parent":
            missing_parent_id = "secret-absent-parent"
            sensitive_ids.add(missing_parent_id)
            with engine.connect() as connection:
                connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
                connection.exec_driver_sql(
                    "UPDATE branch SET parent_branch_id = ? WHERE id = ?",
                    (missing_parent_id, target_id),
                )
                connection.commit()
                connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        elif corruption == "cycle":
            with engine.connect() as connection:
                connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
                connection.exec_driver_sql(
                    "UPDATE branch SET parent_branch_id = ? WHERE id = ?",
                    (target_id, root_id),
                )
                connection.commit()
                connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        elif corruption == "cross_scenario_parent":
            foreign_scenario_id = _seed_scenario(engine)
            foreign_parent_id = _seed_branch(
                engine,
                foreign_scenario_id,
                branch_id="secret-foreign-parent",
            )
            sensitive_ids.add(foreign_parent_id)
            with Session(engine) as session:
                target = session.get(Branch, target_id)
                assert target is not None
                target.parent_branch_id = foreign_parent_id
                session.add(target)
                session.commit()
        else:
            with Session(engine) as session:
                target = session.get(Branch, target_id)
                assert target is not None
                target.fork_round = 0
                session.add(target)
                session.commit()

        response = client.get(
            f"/api/scenario/{scenario_id}/replay-trace",
            params={"branch_id": target_id},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": expected_code,
            "message": "Branch lineage is invalid",
        }
        assert all(branch_id not in response.text for branch_id in sensitive_ids)


class TestCheckpointBatching:
    def test_target_batches_earliest_checkpoint_timestamps_with_fallback(self, client):
        engine = get_engine()
        scenario_created_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        root_earliest = datetime(2024, 1, 2, tzinfo=timezone.utc)
        root_later = datetime(2024, 1, 3, tzinfo=timezone.utc)
        leaf_created_at = datetime(2024, 1, 4, tzinfo=timezone.utc)
        scenario_id = _seed_scenario(engine, created_at=scenario_created_at)
        root_id = _seed_branch(engine, scenario_id, branch_id="checkpoint-root")
        child_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="checkpoint-child",
            parent_branch_id=root_id,
            fork_round=1,
        )
        leaf_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="checkpoint-leaf",
            parent_branch_id=child_id,
            fork_round=2,
        )
        outside_id = _seed_branch(
            engine,
            scenario_id,
            branch_id="checkpoint-outside-page",
        )
        _seed_checkpoint(
            engine,
            scenario_id,
            root_id,
            round_number=2,
            created_at=root_later,
        )
        _seed_checkpoint(
            engine,
            scenario_id,
            root_id,
            round_number=1,
            created_at=root_earliest,
        )
        _seed_checkpoint(
            engine,
            scenario_id,
            leaf_id,
            round_number=1,
            created_at=leaf_created_at,
        )
        _seed_checkpoint(
            engine,
            scenario_id,
            outside_id,
            round_number=1,
            created_at=datetime(2023, 1, 1, tzinfo=timezone.utc),
        )
        checkpoint_selects: list[tuple[str, tuple[object, ...]]] = []

        def capture_checkpoint_selects(
            _connection,
            _cursor,
            statement,
            _parameters,
            _context,
            _executemany,
        ):
            normalized = " ".join(str(statement).split()).lower()
            if normalized.startswith("select") and "scenario_checkpoint" in normalized:
                checkpoint_selects.append((normalized, tuple(_parameters)))

        event.listen(engine, "before_cursor_execute", capture_checkpoint_selects)
        try:
            response = client.get(
                f"/api/scenario/{scenario_id}/replay-trace",
                params={"branch_id": leaf_id},
            )
        finally:
            event.remove(engine, "before_cursor_execute", capture_checkpoint_selects)

        assert response.status_code == 200
        assert len(checkpoint_selects) == 1
        checkpoint_sql, checkpoint_parameters = checkpoint_selects[0]
        assert " group by " in checkpoint_sql
        assert "scenario_checkpoint.branch_id in (" in checkpoint_sql
        assert set(checkpoint_parameters) == {root_id, child_id, leaf_id}
        assert outside_id not in checkpoint_parameters
        nodes_by_id = {
            node["branch_id"]: node for node in response.json()["nodes"]
        }
        assert nodes_by_id[root_id]["created_at"].startswith("2024-01-02T00:00:00")
        assert nodes_by_id[child_id]["created_at"].startswith("2024-01-01T00:00:00")
        assert nodes_by_id[leaf_id]["created_at"].startswith("2024-01-04T00:00:00")


class TestSharedQuota:
    """GET replay-trace must NOT consume the shared MAX_REPLAY_BRANCHES=3 pool.

    Cover the plan scenario: 2x counterfactual + 1x resume exhausts the pool;
    GET replay-trace runs in between; the 4th POST counterfactual still 429.
    """

    def test_get_after_quota_filled_then_4th_post_is_429(self, client, monkeypatch):
        from app.api import graphs as graphs_module

        monkeypatch.setattr(graphs_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
        engine = get_engine()
        sid = _seed_scenario(engine)
        root_bid = _seed_branch(engine, sid, title="root")
        aid = _seed_agent(engine, sid)
        rid = _seed_round(engine, root_bid, 1)
        _seed_message(engine, rid, aid)

        # Pre-fill quota: 2 counterfactual + 1 resume (matches "2x+1x")
        _seed_branch(
            engine, sid, title="cf-1",
            replay_kind="counterfactual", replay_source_branch_id=root_bid,
        )
        _seed_branch(
            engine, sid, title="cf-2",
            replay_kind="counterfactual", replay_source_branch_id=root_bid,
        )
        _seed_branch(
            engine, sid, title="resume-1",
            replay_kind="resume", replay_source_branch_id=root_bid,
        )

        # GET replay-trace — should succeed and list all 3 children without
        # touching the quota.
        resp_get = client.get(f"/api/scenario/{sid}/replay-trace?limit=50")
        assert resp_get.status_code == 200
        assert len(resp_get.json()["nodes"]) == 3

        # 4th counterfactual POST — MUST still be rejected with 429.
        resp_post = client.post(
            f"/api/scenario/{sid}/counterfactual",
            json={
                "source_branch_id": root_bid,
                "round_number": 1,
                "agent_id": aid,
                "replacement_content": "over quota",
            },
        )
        assert resp_post.status_code == 429
        assert resp_post.json()["detail"]["code"] == "REPLAY_BRANCH_LIMIT_REACHED"


class TestIndexUsage:
    def test_idx_branch_replay_source_exists(self):
        """Migration 022 must have created the index."""
        engine = get_engine()
        with engine.connect() as conn:
            from sqlalchemy import text

            indexes = [
                row[1]
                for row in conn.execute(text("PRAGMA index_list('branch')")).fetchall()
            ]
        assert "idx_branch_replay_source" in indexes, (
            f"idx_branch_replay_source must exist on branch; got {indexes}"
        )

    def test_explain_query_plan_uses_idx_branch_replay_source(self):
        """HC-20: lineage walk (``root_branch_id`` query path) hits the index."""
        engine = get_engine()
        with engine.connect() as conn:
            from sqlalchemy import text

            rows = conn.execute(
                text(
                    "EXPLAIN QUERY PLAN "
                    "SELECT branch.id FROM branch "
                    "WHERE branch.scenario_id = :sid "
                    "AND branch.replay_source_branch_id = :rid "
                    "ORDER BY branch.id ASC LIMIT 21"
                ),
                {"sid": "some-id", "rid": "r1"},
            ).fetchall()
        plan_text = " ".join(str(row) for row in rows).lower()
        # SQLite's planner selects idx_branch_replay_source when
        # replay_source_branch_id is constrained by equality.
        assert "idx_branch_replay_source" in plan_text, (
            f"Expected idx_branch_replay_source in EXPLAIN QUERY PLAN; got: {plan_text}"
        )


class TestQueryBudget:
    def test_large_dataset_stays_bounded(self, client):
        engine = get_engine()
        sid = _seed_scenario(engine)
        root_bid = _seed_branch(engine, sid, title="root")

        # 110 replay children — ensure pagination limit caps result size
        with Session(engine) as session:
            branches = [
                Branch(
                    scenario_id=sid,
                    title=f"replay-{i}",
                    status=BranchStatus.ACTIVE,
                    replay_kind="counterfactual",
                    replay_source_branch_id=root_bid,
                    fork_round=1,
                )
                for i in range(110)
            ]
            session.add_all(branches)
            session.commit()

        resp = client.get(f"/api/scenario/{sid}/replay-trace?limit=100")
        assert resp.status_code == 200
        payload = resp.json()
        assert len(payload["nodes"]) == 100
        assert payload["next_cursor"] is not None


class TestZeroWrite:
    def test_get_never_writes(self, client, monkeypatch):
        engine = get_engine()
        sid, _root, _aid, _children = _seed_scenario_with_lineage(
            engine, branch_count=3,
        )

        write_counter = {"add": 0, "commit": 0, "delete": 0, "merge": 0}
        orig_add = Session.add
        orig_commit = Session.commit
        orig_delete = Session.delete
        orig_merge = Session.merge

        def counting_add(self, *a, **kw):
            write_counter["add"] += 1
            return orig_add(self, *a, **kw)

        def counting_commit(self, *a, **kw):
            write_counter["commit"] += 1
            return orig_commit(self, *a, **kw)

        def counting_delete(self, *a, **kw):
            write_counter["delete"] += 1
            return orig_delete(self, *a, **kw)

        def counting_merge(self, *a, **kw):
            write_counter["merge"] += 1
            return orig_merge(self, *a, **kw)

        monkeypatch.setattr(Session, "add", counting_add)
        monkeypatch.setattr(Session, "commit", counting_commit)
        monkeypatch.setattr(Session, "delete", counting_delete)
        monkeypatch.setattr(Session, "merge", counting_merge)

        resp = client.get(f"/api/scenario/{sid}/replay-trace?limit=10")
        assert resp.status_code == 200
        assert write_counter == {"add": 0, "commit": 0, "delete": 0, "merge": 0}

        # Sanity: branch row count unchanged after GET
        with Session(engine) as session:
            replay_rows = session.exec(
                select(Branch).where(
                    Branch.scenario_id == sid,
                    Branch.replay_source_branch_id.is_not(None),  # type: ignore[union-attr]
                )
            ).all()
        assert len(replay_rows) == 3
