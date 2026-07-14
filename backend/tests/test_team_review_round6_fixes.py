"""Round-6 team-review Critical fixes — behavioural regression tests.

Covers the three back-end Critical findings closed in the round-6 review:

* **C1** — ``/api/ws/agent-conversation/{thread_id}`` WS endpoint exists, is
  gated by ``FEATURE_AGENT_CONVERSATION`` (close code 4404 when disabled),
  enforces thread existence (4404), and completes the first-frame auth
  handshake against the thread owner (HC-34).
* **C2** — ``mark_scenario_conversations_as_deleted`` flips every in-flight
  turn to ``scenario_deleted`` before cascade DELETE; the stream CAS
  post-check emits a terminal ``turn_error`` frame with
  ``code="SCENARIO_DELETED"`` even when the row is already gone.
* **C3** — ``X-Org-Id`` HTTP header is the sole transport for the
  organisation routing hint (body still forbids it via
  ``extra='forbid'``); the header is validated for length + charset,
  persisted onto the thread row, and carried through into the daily-org
  quota bucket so ``ORG_DAILY_QUOTA_EXCEEDED`` is actually triggerable.

These tests deliberately do NOT duplicate assertions already covered by
``test_conversation.py`` / ``test_scenario_delete.py`` — they focus on
the new code paths introduced by the round-6 patch.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.api import conversation as conversation_module
from app.api.conversation import router as conversation_router
from app.main import app
from app.models.agent_conversation import AgentConversationThread, AgentConversationTurn
from app.models.agent_identity import AgentIdentity
from app.models.database import Scenario, ScenarioStatus, get_engine
from app.services import conversation_service

# ── Test helpers (trimmed from test_conversation.py to keep this file
# self-contained — we do not want to import private helpers across test
# modules since pytest collection order is not stable).


def _ensure_router_registered() -> None:
    for route in app.routes:
        if getattr(route, "path", "") == "/api/conversation/start":
            return
    app.include_router(conversation_router)


_ensure_router_registered()


@pytest.fixture(autouse=True)
def _enable_feature(monkeypatch):
    monkeypatch.setattr(conversation_module.settings, "FEATURE_AGENT_CONVERSATION", True)
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _seed_scenario(engine, *, user_id: str | None = None) -> str:
    s = Scenario(question="qq", status=ScenarioStatus.DONE, user_id=user_id)
    with Session(engine) as session:
        session.add(s)
        session.commit()
        session.refresh(s)
        return s.id


def _seed_identity(engine, *, user_id: str) -> str:
    identity = AgentIdentity(
        user_id=user_id,
        kind="custom",
        display_name="WS linked identity",
        role="Analyst",
        continuity_key=f"ws-{user_id or 'ownerless'}",
    )
    with Session(engine) as session:
        session.add(identity)
        session.commit()
        session.refresh(identity)
        return identity.id


def _default_start_body(scenario_id: str, *, content: str = "hello") -> dict:
    return {"scenario_id": scenario_id, "first_user_content": content}


def _make_signed_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


# ══════════════════════════════════════════════════════════════════════
# C1 — /api/ws/agent-conversation/{thread_id} endpoint
# ══════════════════════════════════════════════════════════════════════


class TestC1AgentConversationWsEndpoint:
    """C1: thread-scoped WS endpoint wires run_websocket_session correctly."""

    @pytest.mark.asyncio
    async def test_feature_disabled_ws_closes_with_4404_direct(self, monkeypatch):
        """Direct endpoint invocation — TestClient's close-code pass-through
        varies across starlette releases, so we assert ``ws.close(code=4404)``
        was awaited (the frontend observes the raw close code regardless).
        """
        from unittest.mock import AsyncMock

        import app.api.ws as ws_module

        monkeypatch.setattr(ws_module.settings, "FEATURE_AGENT_CONVERSATION", False)
        ws = AsyncMock()
        await ws_module.agent_conversation_ws_endpoint(ws, "no-such-thread")
        ws.accept.assert_awaited_once()
        ws.close.assert_awaited_once_with(code=4404, reason="feature disabled")

    @pytest.mark.asyncio
    async def test_thread_exists_check_rejects_missing_thread(self, monkeypatch):
        """``_thread_exists_sync`` must return False for a missing thread id
        so ``run_websocket_session`` can close 4404.
        """
        import app.api.ws as ws_module

        assert ws_module._thread_exists_sync("absolutely-not-a-thread") is False

    @pytest.mark.asyncio
    async def test_thread_authorized_principal_enforces_owner_match(
        self, client,
    ):
        """HC-34: a signed principal whose subject does not equal the
        thread's owner_user_id is rejected.
        """
        import app.api.ws as ws_module
        from app.api.helpers import SessionPrincipal

        engine = get_engine()
        owner = "user-c1-auth"
        scenario_id = _seed_scenario(engine, user_id=owner)
        start = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
        ).json()
        thread_id = start["thread_id"]

        # Owner is None at this point because SESSION_SECRET is unset in
        # the default fixture — write the owner onto the thread directly
        # so the HC-34 guard has something to match against.
        with Session(engine) as session:
            thread = session.get(AgentConversationThread, thread_id)
            assert thread is not None
            thread.owner_user_id = owner
            session.add(thread)
            session.commit()

        matching = SessionPrincipal(subject=owner)
        stranger = SessionPrincipal(subject="someone-else")

        assert (
            ws_module._thread_authorized_principal_sync(thread_id, matching)
            is True
        )
        assert (
            ws_module._thread_authorized_principal_sync(thread_id, stranger)
            is False
        )

    @pytest.mark.parametrize(
        ("linked_resource", "linked_owner"),
        [
            ("scenario", None),
            ("scenario", "someone-else"),
            ("identity", ""),
            ("identity", "someone-else"),
        ],
        ids=[
            "ownerless-scenario",
            "foreign-scenario",
            "ownerless-identity",
            "foreign-identity",
        ],
    )
    @pytest.mark.asyncio
    async def test_signed_handshake_closes_4404_for_inconsistent_thread_link(
        self,
        client,
        monkeypatch,
        linked_resource,
        linked_owner,
    ):
        from unittest.mock import AsyncMock

        import app.api.ws as ws_module

        engine = get_engine()
        owner = "user-c1-auth"
        scenario_owner = linked_owner if linked_resource == "scenario" else owner
        scenario_id = _seed_scenario(engine, user_id=scenario_owner)
        identity_id = (
            _seed_identity(engine, user_id=linked_owner)
            if linked_resource == "identity"
            else None
        )
        response = client.post(
            "/api/conversation/start",
            json={
                **_default_start_body(scenario_id),
                "agent_identity_id": identity_id,
            },
        )
        assert response.status_code == 200
        start = response.json()
        thread_id = start["thread_id"]

        with Session(engine) as session:
            thread = session.get(AgentConversationThread, thread_id)
            assert thread is not None
            thread.owner_user_id = owner
            session.add(thread)
            session.commit()

        secret = "agent-conversation-ws-secret"
        monkeypatch.setattr(ws_module.settings, "SESSION_SECRET", secret)
        token = _make_signed_token(secret, owner)
        websocket = AsyncMock()
        websocket.receive_text.side_effect = [
            json.dumps({"type": "auth", "token": token})
        ]

        await ws_module.agent_conversation_ws_endpoint(websocket, thread_id)

        websocket.accept.assert_awaited_once()
        websocket.close.assert_awaited_once_with(
            code=4404,
            reason="conversation_thread not found",
        )
        sent = [call.args[0] for call in websocket.send_text.await_args_list]
        assert not any('"auth_ok"' in message for message in sent)
        assert websocket not in ws_module.ws_manager._connections.get(scenario_id, [])

    def test_endpoint_is_registered_on_the_app(self):
        """The router must expose ``/ws/agent-conversation/{thread_id}``
        so the frontend's hardcoded URL resolves against a real route.
        """
        routes: set[str] = set()
        pending = list(app.routes)
        while pending:
            route = pending.pop()
            if path := getattr(route, "path", ""):
                routes.add(path)
            pending.extend(getattr(route, "routes", ()))
        assert "/ws/agent-conversation/{thread_id}" in routes

    @pytest.mark.asyncio
    async def test_capacity_scope_uses_scenario_id_not_thread_id(self, client, monkeypatch):
        from unittest.mock import AsyncMock

        import app.api.ws as ws_module

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        monkeypatch.setattr(ws_module.settings, "FEATURE_AGENT_CONVERSATION", True)
        thread_a = client.post(
            "/api/conversation/start", json=_default_start_body(scenario_id, content="a"),
        ).json()["thread_id"]
        thread_b = client.post(
            "/api/conversation/start", json=_default_start_body(scenario_id, content="b"),
        ).json()["thread_id"]

        reservations: list[tuple[str, bool]] = []

        async def fake_run_websocket_session(manager, scope_key, websocket, **_kwargs):
            ok = await manager.reserve_pending_auth(scope_key)
            reservations.append((scope_key, ok))

        monkeypatch.setattr(ws_module, "MAX_WS_PER_SCENARIO", 1)
        ws_module.ws_manager._pending_auth.clear()
        monkeypatch.setattr(ws_module, "run_websocket_session", fake_run_websocket_session)

        await ws_module.agent_conversation_ws_endpoint(AsyncMock(), thread_a)
        await ws_module.agent_conversation_ws_endpoint(AsyncMock(), thread_b)

        assert reservations == [
            (scenario_id, True),
            (scenario_id, False),
        ]


# ══════════════════════════════════════════════════════════════════════
# C2 — scenario delete emits SCENARIO_DELETED terminal event
# ══════════════════════════════════════════════════════════════════════


class TestC2ScenarioDeletedTerminalSignal:
    """C2: mark_scenario_conversations_as_deleted + stream CAS post-check."""

    def test_delete_helpers_are_reexported(self):
        """Keep the public module surface aligned with the helpers used by
        scenario deletion and API callers.
        """
        assert "mark_scenario_conversations_as_deleted" in conversation_service.__all__
        assert "signal_scenario_deleted_turns" in conversation_service.__all__

    def test_mark_helper_sets_active_turns_to_scenario_deleted(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        r = client.post(
            "/api/conversation/start", json=_default_start_body(scenario_id),
        )
        assert r.status_code == 200
        thread_id = r.json()["thread_id"]
        assistant_turn_id = r.json()["assistant_turn_id"]

        with Session(engine) as session:
            # A fresh ``start`` leaves the assistant placeholder in ``pending``
            # — that is precisely what the helper targets.
            transitioned = (
                conversation_service.mark_scenario_conversations_as_deleted(
                    session, scenario_id,
                )
            )
            session.commit()
        assert assistant_turn_id in transitioned

        # The DB row should now carry the terminal status and no
        # thread.active_turn_id pointer.
        with Session(engine) as session:
            turn = session.get(AgentConversationTurn, assistant_turn_id)
            thread = session.get(AgentConversationThread, thread_id)
            assert turn is not None and turn.status == "scenario_deleted"
            assert turn.error_code == "SCENARIO_DELETED"
            assert thread is not None and thread.active_turn_id is None
            assert thread.latest_status == "scenario_deleted"

    def test_mark_helper_does_not_commit_outside_caller_transaction(self, client):
        """BE-1: helper must be rollback-safe for the outer scenario delete tx."""
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        start = client.post(
            "/api/conversation/start", json=_default_start_body(scenario_id),
        ).json()
        assistant_turn_id = start["assistant_turn_id"]
        thread_id = start["thread_id"]

        with Session(engine) as session:
            transitioned = conversation_service.mark_scenario_conversations_as_deleted(
                session, scenario_id,
            )
            assert assistant_turn_id in transitioned
            session.rollback()

        with Session(engine) as session:
            turn = session.get(AgentConversationTurn, assistant_turn_id)
            thread = session.get(AgentConversationThread, thread_id)
            assert turn is not None
            assert turn.status == "pending"
            assert turn.error_code is None
            assert thread is not None
            assert thread.active_turn_id == assistant_turn_id
            assert thread.latest_status == "pending"

    def test_mark_helper_does_not_rewrite_terminal_states(self, client):
        """Rows already finalised via ``done`` / ``error`` / ``aborted`` must
        not be clobbered by a late scenario delete.  The helper's WHERE
        clause restricts to the non-terminal set.
        """
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        r = client.post(
            "/api/conversation/start", json=_default_start_body(scenario_id),
        ).json()
        assistant_turn_id = r["assistant_turn_id"]

        # Manually finalise as done.
        with Session(engine) as session:
            ok = conversation_service.finalize_turn_cas(
                session,
                turn_id=assistant_turn_id,
                new_status="done",
                expected_from=("pending", "streaming"),
                content="final",
                error_code=None,
                model="test-model",
            )
            assert ok is True

        with Session(engine) as session:
            transitioned = (
                conversation_service.mark_scenario_conversations_as_deleted(
                    session, scenario_id,
                )
            )
        assert assistant_turn_id not in transitioned

        with Session(engine) as session:
            turn = session.get(AgentConversationTurn, assistant_turn_id)
            assert turn is not None
            assert turn.status == "done"
            assert turn.error_code is None

    @pytest.mark.asyncio
    async def test_delete_endpoint_signals_after_commit_and_wakes_stream(
        self,
        client,
        monkeypatch,
    ):
        """Regression: delete flow must delay the wake-up signal until after
        the delete transaction commits, then wake the in-flight stream.
        """
        engine = get_engine()
        scenario_id = _seed_scenario(engine, user_id="user-c2")
        r = client.post(
            "/api/conversation/start", json=_default_start_body(scenario_id),
        ).json()
        assistant_turn_id = r["assistant_turn_id"]
        stall_forever = asyncio.Event()

        async def _two_chunk_stream(*_args, **_kwargs):
            yield "alpha"
            await stall_forever.wait()

        called_with: list[tuple[str, bool]] = []
        signaled_batches: list[list[str]] = []
        real_mark = conversation_service.mark_scenario_conversations_as_deleted
        real_signal = conversation_service.signal_scenario_deleted_turns

        def spy(session, sid, *, signal_immediately=True):
            called_with.append((sid, signal_immediately))
            return real_mark(session, sid, signal_immediately=signal_immediately)

        def spy_signal(turn_ids: list[str]) -> None:
            signaled_batches.append(list(turn_ids))
            real_signal(turn_ids)

        monkeypatch.setattr(
            conversation_service,
            "mark_scenario_conversations_as_deleted",
            spy,
        )
        monkeypatch.setattr(
            conversation_service,
            "signal_scenario_deleted_turns",
            spy_signal,
        )

        iterator = await conversation_service.stream_assistant_turn(
            thread_id=r["thread_id"],
            assistant_turn_id=assistant_turn_id,
            new_user_content="watch delete",
            owner_user_id=None,
            overrides=conversation_service.LLMOverrides(
                api_key=None,
                base_url=None,
                model="test-model",
                disable_user_quota=False,
            ),
            _llm_stream_factory=_two_chunk_stream,
        )

        assert (await anext(iterator))["event"] == "turn_started"
        assert (await anext(iterator))["event"] == "turn_token_delta"

        terminal_task = asyncio.create_task(anext(iterator))
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(terminal_task), timeout=0.05)
        assert terminal_task.done() is False

        resp = client.delete(f"/api/scenario/{scenario_id}")

        assert resp.status_code == 200
        assert (scenario_id, False) in called_with

        terminal = await asyncio.wait_for(terminal_task, timeout=1.0)
        assert terminal["event"] == "turn_error"
        assert terminal["data"]["code"] == "SCENARIO_DELETED"
        assert terminal["data"]["status"] == "scenario_deleted"
        assert signaled_batches == [[assistant_turn_id]]

        with pytest.raises(StopAsyncIteration):
            await anext(iterator)

        with Session(engine) as session:
            assert session.get(AgentConversationTurn, assistant_turn_id) is None


# ══════════════════════════════════════════════════════════════════════
# C3 — X-Org-Id header + ORG_DAILY_QUOTA
# ══════════════════════════════════════════════════════════════════════


class TestC3OrgIdHeaderAndQuota:
    """C3: header routing + organization_id persistence + org quota."""

    @pytest.fixture(autouse=True)
    def _reset_quota_state(self):
        """Prevent cross-test quota bleed regardless of the backing store."""
        conversation_service.reset_conversation_quota_counters()
        yield
        conversation_service.reset_conversation_quota_counters()

    def test_body_organization_id_still_forbidden(self, client):
        """v1 schema freeze: body still rejects ``organization_id``."""
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        resp = client.post(
            "/api/conversation/start",
            json={
                **_default_start_body(scenario_id),
                "organization_id": "not-allowed-in-body",
            },
        )
        assert resp.status_code == 422

    def test_missing_header_leaves_organization_id_null(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        resp = client.post(
            "/api/conversation/start", json=_default_start_body(scenario_id),
        )
        assert resp.status_code == 200
        thread_id = resp.json()["thread_id"]
        with Session(engine) as session:
            thread = session.get(AgentConversationThread, thread_id)
            assert thread is not None
            assert thread.organization_id is None

    def test_valid_header_is_persisted_on_the_thread(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        resp = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers={"X-Org-Id": "tenant-42_ab"},
        )
        assert resp.status_code == 200
        thread_id = resp.json()["thread_id"]
        with Session(engine) as session:
            thread = session.get(AgentConversationThread, thread_id)
            assert thread is not None
            assert thread.organization_id == "tenant-42_ab"

    def test_header_invalid_charset_returns_400(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        resp = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers={"X-Org-Id": "has space in it"},
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "ORG_ID_INVALID_CHAR"

    def test_header_too_long_returns_400(self, client):
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        resp = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers={"X-Org-Id": "a" * 129},
        )
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "ORG_ID_TOO_LONG"

    def test_org_daily_quota_actually_triggers(self, client, monkeypatch):
        """C3 root cause: ``ORG_DAILY_QUOTA_EXCEEDED`` was dead code before the
        fix because ``organization_id`` was hardcoded to ``None``.  Now that
        the header is wired through, exceeding the org cap must produce
        HTTP 429 with the correct error code.
        """
        # Tiny cap so the test doesn't burn thousands of fake rows.  Each
        # ``start`` adds 2 ticks to the org bucket, so cap=3 ⇒ the 2nd
        # start trips the guard.
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_ORG_PER_DAY",
            3,
            raising=False,
        )
        # Make sure no user cap hides the org check.
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_USER_PER_DAY",
            100,
            raising=False,
        )

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        headers = {"X-Org-Id": "tenant-quota"}

        first = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers=headers,
        )
        assert first.status_code == 200

        second = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers=headers,
        )
        assert second.status_code == 429
        detail = second.json()["detail"]
        assert detail["code"] == "ORG_DAILY_QUOTA_EXCEEDED"
        # Retry-After header should be present for rolling-24h clarity.
        assert "retry-after" in {k.lower() for k in second.headers.keys()}

    def test_org_daily_quota_is_keyed_per_organization(self, client, monkeypatch):
        """Tenant A exhausting its budget must not drain tenant B."""
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_ORG_PER_DAY",
            3,
            raising=False,
        )
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_USER_PER_DAY",
            100,
            raising=False,
        )
        engine = get_engine()
        scenario_id = _seed_scenario(engine)

        tenant_a_first = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers={"X-Org-Id": "tenant-A"},
        )
        assert tenant_a_first.status_code == 200

        tenant_a_second = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id, content="overflow-a"),
            headers={"X-Org-Id": "tenant-A"},
        )
        assert tenant_a_second.status_code == 429
        assert tenant_a_second.json()["detail"]["code"] == "ORG_DAILY_QUOTA_EXCEEDED"

        tenant_b_first = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id, content="fresh-b"),
            headers={"X-Org-Id": "tenant-B"},
        )
        assert tenant_b_first.status_code == 200

    def test_org_daily_quota_reads_persisted_usage(self, client, monkeypatch):
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_ORG_PER_DAY",
            3,
            raising=False,
        )
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_USER_PER_DAY",
            100,
            raising=False,
        )

        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        headers = {"X-Org-Id": "tenant-reload"}

        first = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers=headers,
        )
        assert first.status_code == 200

        with Session(engine) as session:
            with pytest.raises(HTTPException) as excinfo:
                conversation_service._enforce_daily_user_org_quota(
                    session,
                    user_id=None,
                    organization_id="tenant-reload",
                    additions=2,
                )
        assert excinfo.value.status_code == 429
        assert excinfo.value.detail["code"] == "ORG_DAILY_QUOTA_EXCEEDED"
        assert "Retry-After" in (excinfo.value.headers or {})

    def test_org_header_is_case_folded_before_persistence_and_quota(self, client, monkeypatch):
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_ORG_PER_DAY",
            3,
            raising=False,
        )
        monkeypatch.setattr(
            conversation_service.settings,
            "CONVERSATION_TURNS_PER_USER_PER_DAY",
            100,
            raising=False,
        )
        engine = get_engine()
        scenario_id = _seed_scenario(engine)
        resp = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id),
            headers={"X-Org-Id": "Tenant-Mixed_CASE"},
        )
        assert resp.status_code == 200
        thread_id = resp.json()["thread_id"]

        with Session(engine) as session:
            thread = session.get(AgentConversationThread, thread_id)
            assert thread is not None
            assert thread.organization_id == "tenant-mixed_case"

        over = client.post(
            "/api/conversation/start",
            json=_default_start_body(scenario_id, content="same-tenant"),
            headers={"X-Org-Id": "tenant-mixed_case"},
        )
        assert over.status_code == 429
        assert over.json()["detail"]["code"] == "ORG_DAILY_QUOTA_EXCEEDED"
