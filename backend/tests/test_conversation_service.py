"""Regression tests for agent conversation prompt context enrichment."""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.models.agent_conversation import AgentConversationThread, AgentConversationTurn
from app.models.checkpoint import FactionEvent
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
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.models.model_profile import ModelProfile
from app.services import conversation_service as service
from app.services.conversation_service import (
    _build_prompt,
    _load_prompt_context,
    abort_turn,
    create_thread_with_first_turn,
    resolve_byok_overrides,
    stream_assistant_turn,
)


def test_prompt_without_agent_context_uses_graph_analyst_voice():
    thread = AgentConversationThread(
        scenario_id="scenario-analyst",
        owner_user_id="owner-1",
        origin_node_id="outcome:br1",
        origin_node_type="outcome",
        last_turn_sequence=0,
        latest_status="idle",
    )

    prompt = _build_prompt(
        thread=thread,
        new_user_content="为什么会走到这个结局？",
        history=[],
        prompt_context=None,
    )

    assert "You are a graph analyst" in prompt
    assert "Do not pretend to be a specific participant" in prompt
    assert "You are an in-story Agent" not in prompt


def test_prompt_with_agent_context_keeps_in_story_agent_voice():
    thread = AgentConversationThread(
        scenario_id="scenario-agent",
        owner_user_id="owner-1",
        origin_node_id="event-1",
        origin_node_type="event",
        last_turn_sequence=0,
        latest_status="idle",
    )

    prompt = _build_prompt(
        thread=thread,
        new_user_content="你为什么这么判断？",
        history=[],
        prompt_context=type(
            "PromptContextStub",
            (),
            {
                "agent_name": "司马懿",
                "agent_role": None,
                "agent_persona": None,
                "scenario_question": None,
                "origin_excerpt": None,
                "branch_summary": None,
                "node_summary": None,
                "relation_summaries": [],
                "round_transcripts": [],
            },
        )(),
    )

    assert "You are an in-story Agent" in prompt
    assert "Agent name" in prompt
    assert "司马懿" in prompt


def test_prompt_context_includes_recent_round_transcript_payload_and_edge_evidence():
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(
            question="What if the council splits?",
            status=ScenarioStatus.DONE,
            user_id="owner-1",
        )
        session.add(scenario)
        session.flush()

        branch = Branch(
            scenario_id=scenario.id,
            title="Dissent branch",
            summary="The faction split becomes visible.",
        )
        agent = Agent(
            scenario_id=scenario.id,
            name="Archivist Ada",
            role="Archivist",
        )
        session.add(branch)
        session.add(agent)
        session.flush()

        for round_number in range(1, 5):
            round_row = Round(
                id=f"round-{round_number}",
                branch_id=branch.id,
                round_number=round_number,
                compressed_summary=f"compressed summary r{round_number}",
            )
            session.add(round_row)
            session.flush()
            message_count = 6 if round_number == 4 else 1
            for message_index in range(1, message_count + 1):
                session.add(
                    AgentMessage(
                        id=f"msg-{round_number}-{message_index}",
                        round_id=round_row.id,
                        agent_id=agent.id,
                        content=(
                            f"round {round_number} message {message_index} marker "
                            + ("x" * 350 if message_index == 1 else "")
                        ),
                        emotion="focused",
                    )
                )

        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario.id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()
        origin_node = GraphNode(
            snapshot_id=snapshot.id,
            node_key="origin-node",
            node_type="event",
            label="Archivist identifies the split",
            round_number=4,
            payload_json=json.dumps(
                {
                    "branch_id": branch.id,
                    "agent_name": "Archivist Ada",
                    "private_context": "full payload marker",
                    "nested": {"kept": True},
                }
            ),
        )
        neighbor_node = GraphNode(
            snapshot_id=snapshot.id,
            node_key="neighbor-node",
            node_type="stance_shift",
            label="Council response",
            round_number=4,
        )
        session.add(origin_node)
        session.add(neighbor_node)
        session.flush()
        session.add(
            GraphEdge(
                snapshot_id=snapshot.id,
                source_node_id=origin_node.id,
                target_node_id=neighbor_node.id,
                edge_type="caused",
                source_ref="round-4-msg-1",
                source_round_number=4,
                evidence_json=json.dumps(
                    {
                        "detail": "edge evidence detail marker",
                        "quote": "quoted evidence marker",
                    }
                ),
            )
        )
        session.flush()

        thread = AgentConversationThread(
            scenario_id=scenario.id,
            owner_user_id="owner-1",
            origin_branch_id=branch.id,
            origin_round_number=4,
            origin_node_id=origin_node.id,
            origin_node_type="event",
            last_turn_sequence=0,
            latest_status="idle",
        )

        context = _load_prompt_context(
            session,
            thread,
            origin_excerpt="frontend excerpt marker",
        )

    prompt = _build_prompt(
        thread=thread,
        new_user_content="Explain this node.",
        history=[],
        prompt_context=context,
    )

    assert len(prompt) <= 4000
    assert "frontend excerpt marker" in prompt
    assert "Recent round transcript" in prompt
    assert "[R2 Archivist Ada focused]" in prompt
    assert "round 1 message 1 marker" not in prompt
    assert "round 4 message 5 marker" in prompt
    assert "round 4 message 6 marker" not in prompt
    assert "round 4 message 1 marker " + ("x" * 300) not in prompt
    assert "full payload marker" in prompt
    assert "source_ref=round-4-msg-1" in prompt
    assert "source_round=4" in prompt
    assert "edge evidence detail marker" in prompt
    assert "quoted evidence marker" in prompt
    assert prompt.count("UNTRUSTED DATA") >= 2


# ── H1 cross-scenario branch isolation ──────────────────────


def _seed_scenario_with_branch(
    session: Session,
    *,
    user_id: str,
    transcript_marker: str,
) -> tuple[str, str]:
    """Create a scenario + branch + 1 round with a marker message."""
    scenario = Scenario(
        question=f"q-{user_id}",
        status=ScenarioStatus.DONE,
        user_id=user_id,
    )
    session.add(scenario)
    session.flush()
    branch = Branch(
        scenario_id=scenario.id,
        title=f"branch-{user_id}",
        summary=f"summary-{user_id}",
    )
    agent = Agent(
        scenario_id=scenario.id,
        name=f"Agent-{user_id}",
        role="role",
    )
    session.add(branch)
    session.add(agent)
    session.flush()
    round_row = Round(
        branch_id=branch.id,
        round_number=1,
        compressed_summary=f"summary-r1-{user_id}",
    )
    session.add(round_row)
    session.flush()
    session.add(
        AgentMessage(
            round_id=round_row.id,
            agent_id=agent.id,
            content=transcript_marker,
            emotion="focused",
        )
    )
    session.flush()
    return scenario.id, branch.id


def test_load_prompt_context_rejects_cross_scenario_branch_id():
    """H1: a thread that names a branch from another scenario must NOT leak
    the foreign-scenario transcript through ``_summarize_round_transcripts``.

    Pre-fix the function fell back to the raw ``branch_id`` after blanking the
    branch row, which meant the summarizer pulled rounds from the wrong
    scenario.  Post-fix the fallback must be ``None`` and the resulting prompt
    must not contain the foreign transcript marker.
    """
    engine = get_engine()
    with Session(engine) as session:
        leak_scenario_id, leak_branch_id = _seed_scenario_with_branch(
            session,
            user_id="owner-leak",
            transcript_marker="LEAK_SHOULD_NOT_APPEAR_IN_PROMPT",
        )
        own_scenario = Scenario(
            question="own scenario",
            status=ScenarioStatus.DONE,
            user_id="owner-leak",
        )
        session.add(own_scenario)
        session.flush()
        session.commit()

        # Build a thread anchored in own_scenario but pointing at the
        # *other* scenario's branch — simulating either a stale row from
        # before H1 was enforced, or a malformed ``thread.origin_branch_id``.
        thread = AgentConversationThread(
            scenario_id=own_scenario.id,
            owner_user_id="owner-leak",
            origin_branch_id=leak_branch_id,
            origin_round_number=1,
            origin_node_id=None,
            origin_node_type=None,
            last_turn_sequence=0,
            latest_status="idle",
        )

        with pytest.raises(HTTPException) as exc_info:
            _load_prompt_context(session, thread)
        assert exc_info.value.detail["code"] == "BRANCH_NOT_FOUND"

    # Sanity check: the same thread anchored at the *correct* scenario does
    # surface its transcript, proving the guard is the only thing dropping it.
    with Session(engine) as session:
        thread_ok = AgentConversationThread(
            scenario_id=leak_scenario_id,
            owner_user_id="owner-leak",
            origin_branch_id=leak_branch_id,
            origin_round_number=1,
            origin_node_id=None,
            origin_node_type=None,
            last_turn_sequence=0,
            latest_status="idle",
        )
        context_ok = _load_prompt_context(session, thread_ok)
    assert context_ok.round_transcripts, (
        "Same-scenario branch should still surface transcript content"
    )
    assert any(
        "LEAK_SHOULD_NOT_APPEAR_IN_PROMPT" in chunk
        for chunk in context_ok.round_transcripts
    )


def test_create_thread_with_first_turn_rejects_cross_scenario_origin_branch():
    """H1: ``create_thread_with_first_turn`` must refuse a foreign branch up
    front so a poisoned row never lands in the database.
    """
    engine = get_engine()
    with Session(engine) as session:
        _, leak_branch_id = _seed_scenario_with_branch(
            session,
            user_id="owner-x",
            transcript_marker="cross-scenario-source",
        )
        own_scenario = Scenario(
            question="own",
            status=ScenarioStatus.DONE,
            user_id="owner-x",
        )
        session.add(own_scenario)
        session.flush()
        own_scenario_id = own_scenario.id
        session.commit()

    with pytest.raises(HTTPException) as exc_info:
        create_thread_with_first_turn(
            scenario_id=own_scenario_id,
            owner_user_id="owner-x",
            agent_identity_id=None,
            origin_branch_id=leak_branch_id,
            origin_round_number=None,
            origin_node_id=None,
            origin_node_type=None,
            first_user_content="hello",
        )
    assert exc_info.value.status_code == 404
    detail = exc_info.value.detail
    assert isinstance(detail, dict)
    assert detail.get("code") == "BRANCH_NOT_FOUND"


def test_create_thread_with_first_turn_accepts_same_scenario_origin_branch():
    """Sanity: same-scenario branch still passes the H1 guard."""
    engine = get_engine()
    with Session(engine) as session:
        scenario_id, branch_id = _seed_scenario_with_branch(
            session,
            user_id="owner-ok",
            transcript_marker="ok",
        )
        session.commit()

    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id,
        owner_user_id="owner-ok",
        agent_identity_id=None,
        origin_branch_id=branch_id,
        origin_round_number=1,
        origin_node_id=None,
        origin_node_type=None,
        first_user_content="hello",
    )
    assert outcome.thread.origin_branch_id == branch_id
    assert outcome.thread.scenario_id == scenario_id


@pytest.mark.asyncio
async def test_stream_assistant_turn_rehydrates_profile_from_scenario_context(monkeypatch):
    engine = get_engine()
    with Session(engine) as session:
        profile = ModelProfile(
            user_id="conv-owner",
            name="Conversation profile",
            provider="openai",
            base_url="https://api.openai.com/v1",
            model="conversation-profile-model",
            api_key="sk-conversation-profile",
            rpm=41,
            tpm=4100,
            concurrency=7,
            supports_structured_outputs=False,
            supports_native_search=True,
            native_search_upstream="xai_responses",
        )
        session.add(profile)
        session.commit()
        session.refresh(profile)
        profile_id = profile.id

        scenario = Scenario(
            question="Will node chat reuse the launch profile?",
            status=ScenarioStatus.DONE,
            user_id="conv-owner",
            parsed_context={
                "model_profile_id": profile_id,
                "llm_concurrency": 1,
                "supports_structured_outputs": True,
                "supports_native_search": False,
            },
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id,
        owner_user_id="conv-owner",
        agent_identity_id=None,
        origin_branch_id=None,
        origin_round_number=None,
        origin_node_id=None,
        origin_node_type=None,
        first_user_content="hello",
    )

    captured: dict[str, object] = {}

    async def _fake_stream(_prompt: str, **kwargs):
        captured["stream_kwargs"] = kwargs
        yield "profile answer"

    class _Scope:
        def __enter__(self):
            return None

        def __exit__(self, *_args):
            return False

    def _spy_scope(**kwargs):
        captured["scope"] = kwargs
        return _Scope()

    monkeypatch.setattr(
        "app.services.conversation_service.llm_request_scope",
        _spy_scope,
    )

    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id,
        assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="hello",
        assistant_turn_preclaimed=False,
        owner_user_id="conv-owner",
        overrides=resolve_byok_overrides(
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            disable_user_quota=False,
        ),
        request_id="req-profile",
        cancel_event=asyncio.Event(),
        _llm_stream_factory=_fake_stream,
    )
    events = [event async for event in stream]

    assert captured["stream_kwargs"] == {
        "api_key": "sk-conversation-profile",
        "base_url": "https://api.openai.com/v1",
        "model": "conversation-profile-model",
    }
    assert captured["scope"] == {
        "quota_key": "user:conv-owner",
        "purpose": "agent_conversation",
        "reasoning_effort": "low",
        "requests_per_minute": 41,
        "tokens_per_minute": 4100,
        "concurrency": 7,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": True,
        "native_search_upstream_override": "xai_responses",
    }
    assert [event["event"] for event in events] == [
        "turn_started",
        "turn_token_delta",
        "turn_completed",
    ]
    assert events[0]["data"]["model"] == "conversation-profile-model"


@pytest.mark.asyncio
async def test_stream_assistant_turn_errors_on_empty_stream(monkeypatch):
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Will an empty stream be rejected?",
            status=ScenarioStatus.DONE,
            user_id="conv-owner",
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id,
        owner_user_id="conv-owner",
        agent_identity_id=None,
        origin_branch_id=None,
        origin_round_number=None,
        origin_node_id=None,
        origin_node_type=None,
        first_user_content="hello",
    )

    async def _empty_stream(_prompt: str, **_kwargs):
        if False:
            yield "unreachable"

    async def _empty_fallback(_prompt: str, **_kwargs):
        return ""

    monkeypatch.setattr(
        "app.services.conversation_service.llm_call",
        _empty_fallback,
    )

    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id,
        assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="hello",
        assistant_turn_preclaimed=False,
        owner_user_id="conv-owner",
        overrides=resolve_byok_overrides(
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            disable_user_quota=False,
        ),
        request_id="req-empty-stream",
        cancel_event=asyncio.Event(),
        _llm_stream_factory=_empty_stream,
    )
    events = [event async for event in stream]

    assert [event["event"] for event in events] == ["turn_started", "turn_error"]
    assert events[-1]["data"]["code"] == "LLM_EMPTY"
    assert events[-1]["data"]["message"] == "LLM returned no visible content."

    with Session(get_engine()) as session:
        turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)

    assert turn is not None
    assert turn.status == "error"
    assert turn.error_code == "LLM_EMPTY"
    assert turn.content == ""


@pytest.mark.asyncio
async def test_stream_assistant_turn_non_stream_fallback_after_empty_stream(monkeypatch):
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Will reasoning-only streaming fall back to non-stream text?",
            status=ScenarioStatus.DONE,
            user_id="conv-owner",
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id,
        owner_user_id="conv-owner",
        agent_identity_id=None,
        origin_branch_id=None,
        origin_round_number=None,
        origin_node_id=None,
        origin_node_type=None,
        first_user_content="hello",
    )

    async def _empty_stream(_prompt: str, **_kwargs):
        if False:
            yield "hidden reasoning should not stream"

    fallback_calls: list[dict[str, object]] = []

    async def _fallback_call(_prompt: str, **kwargs):
        fallback_calls.append(kwargs)
        return "fallback visible answer"

    monkeypatch.setattr(
        "app.services.conversation_service.llm_call",
        _fallback_call,
        raising=False,
    )

    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id,
        assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="hello",
        assistant_turn_preclaimed=False,
        owner_user_id="conv-owner",
        overrides=resolve_byok_overrides(
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            disable_user_quota=False,
        ),
        request_id="req-empty-stream-fallback",
        cancel_event=asyncio.Event(),
        _llm_stream_factory=_empty_stream,
    )
    events = [event async for event in stream]

    assert [event["event"] for event in events] == [
        "turn_started",
        "turn_token_delta",
        "turn_completed",
    ]
    assert events[1]["data"]["delta"] == "fallback visible answer"
    assert fallback_calls

    with Session(get_engine()) as session:
        turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)

    assert turn is not None
    assert turn.status == "done"
    assert turn.error_code is None
    assert turn.content == "fallback visible answer"


async def test_stream_assistant_turn_abort_during_fallback_does_not_commit_done(monkeypatch):
    # 回归 codex 终审 High：空流式触发非流式 fallback，fallback 执行期间用户 abort。
    # abort_turn() 在有 live stream 时只 set cancel event（不 CAS），依赖 stream task finalize；
    # 非流式 fallback 不经过 _stream_with_cancel_signal，修复前 fallback 文本会把已中止的 turn
    # 经 done CAS 救成 "done"。修复后 fallback 返回时二次检查 cancel event → 走 aborted。
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Does abort during fallback avoid a false done?",
            status=ScenarioStatus.DONE,
            user_id="conv-owner",
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id,
        owner_user_id="conv-owner",
        agent_identity_id=None,
        origin_branch_id=None,
        origin_round_number=None,
        origin_node_id=None,
        origin_node_type=None,
        first_user_content="hello",
    )

    async def _empty_stream(_prompt: str, **_kwargs):
        if False:
            yield ""

    fallback_entered = asyncio.Event()
    fallback_cancelled = asyncio.Event()

    async def _fallback_call(_prompt: str, **_kwargs):
        # fallback 执行期间用户 abort：只 set cancel event（不 cancel task）
        fallback_entered.set()
        abort_turn(
            thread_id=outcome.thread.id,
            turn_id=outcome.assistant_turn.id,
            owner_user_id="conv-owner",
        )
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            fallback_cancelled.set()
            raise
        return "fallback answer that must be discarded"

    monkeypatch.setattr(
        "app.services.conversation_service.llm_call",
        _fallback_call,
        raising=False,
    )

    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id,
        assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="hello",
        assistant_turn_preclaimed=False,
        owner_user_id="conv-owner",
        overrides=resolve_byok_overrides(
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            disable_user_quota=False,
        ),
        request_id="req-abort-during-fallback",
        cancel_event=asyncio.Event(),
        _llm_stream_factory=_empty_stream,
    )

    events = [event async for event in stream]
    assert [event["event"] for event in events] == ["turn_started", "turn_aborted"]

    assert fallback_entered.is_set()
    assert fallback_cancelled.is_set()

    with Session(get_engine()) as session:
        turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)

    assert turn is not None
    # 已中止的 turn 不能被 fallback 文本救成 done
    assert turn.status == "aborted"
    assert turn.content != "fallback answer that must be discarded"


async def test_stream_assistant_turn_abort_before_fallback_skips_provider(monkeypatch):
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Does a pre-fallback abort skip the fallback provider call?",
            status=ScenarioStatus.DONE,
            user_id="conv-owner",
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id

    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id,
        owner_user_id="conv-owner",
        agent_identity_id=None,
        origin_branch_id=None,
        origin_round_number=None,
        origin_node_id=None,
        origin_node_type=None,
        first_user_content="hello",
    )

    async def _empty_stream(_prompt: str, **_kwargs):
        abort_turn(
            thread_id=outcome.thread.id,
            turn_id=outcome.assistant_turn.id,
            owner_user_id="conv-owner",
        )
        if False:
            yield ""

    fallback_calls: list[dict[str, object]] = []

    async def _fallback_call(_prompt: str, **kwargs):
        fallback_calls.append(kwargs)
        return "fallback answer that must not be requested"

    monkeypatch.setattr(
        "app.services.conversation_service.llm_call",
        _fallback_call,
        raising=False,
    )

    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id,
        assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="hello",
        assistant_turn_preclaimed=False,
        owner_user_id="conv-owner",
        overrides=resolve_byok_overrides(
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            disable_user_quota=False,
        ),
        request_id="req-abort-before-fallback",
        cancel_event=asyncio.Event(),
        _llm_stream_factory=_empty_stream,
    )

    events = [event async for event in stream]
    assert [event["event"] for event in events] == ["turn_started", "turn_aborted"]

    assert fallback_calls == []

    with Session(get_engine()) as session:
        turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)

    assert turn is not None
    assert turn.status == "aborted"
    assert turn.content != "fallback answer that must not be requested"


@pytest.fixture
def coherent_origin():
    with Session(get_engine()) as session:
        scenario_id, branch_a = _seed_scenario_with_branch(
            session, user_id="origin-owner", transcript_marker="ancestor-round-one",
        )
        branch_b = Branch(scenario_id=scenario_id, title="Unrelated branch")
        session.add(branch_b)
        session.flush()
        session.add_all([
            Round(id="origin-a-r2", branch_id=branch_a, round_number=2),
            Round(id="origin-b-r1", branch_id=branch_b.id, round_number=1),
        ])
        actor = session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).first()
        assert actor is not None
        session.add(AgentMessage(
            round_id="origin-a-r2", agent_id=actor.id, content="parent-post-fork-secret",
        ))
        snapshot = GraphSnapshot(
            owner_type="scenario", owner_id=scenario_id, graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()
        node = GraphNode(
            snapshot_id=snapshot.id, node_key="origin-key", node_type="event",
            round_number=1, label="Ancestor event",
            payload_json=json.dumps({"branch_id": branch_a, "agent_name": actor.name}),
        )
        session.add(node)
        session.commit()
        return {
            "scenario_id": scenario_id, "origin_branch_id": branch_a,
            "origin_round_number": 1, "origin_node_id": node.id, "origin_node_type": "event",
            "branch_b": branch_b.id, "actor_id": actor.id, "snapshot_id": snapshot.id,
        }


def _start_at_origin(origin, **changes):
    coordinates = {key: value for key, value in origin.items()
                   if key.startswith("origin_") or key == "scenario_id"}
    coordinates.update(changes)
    return create_thread_with_first_turn(
        **coordinates, owner_user_id="origin-owner", agent_identity_id=None,
        first_user_content="Explain the selected event.",
    )


@pytest.mark.parametrize("conflict", ["branch", "round", "type", "missing_node"])
def test_origin_conflicts_fail_at_start_and_hydration(coherent_origin, conflict):
    changes = {
        "branch": {"origin_branch_id": coherent_origin["branch_b"]},
        "round": {"origin_round_number": 999},
        "type": {"origin_node_type": "stance_shift"},
        "missing_node": {"origin_node_id": "missing-authoritative-node"},
    }[conflict]
    with pytest.raises(HTTPException) as start_error:
        _start_at_origin(coherent_origin, **changes)
    assert start_error.value.status_code in {400, 404}
    with Session(get_engine()) as session:
        assert session.exec(select(AgentConversationThread)).all() == []
        coordinates = {key: value for key, value in coherent_origin.items()
                       if key.startswith("origin_") or key == "scenario_id"}
        coordinates.update(changes)
        historical = AgentConversationThread(owner_user_id="origin-owner", **coordinates)
        with pytest.raises(HTTPException) as hydrate_error:
            _load_prompt_context(session, historical)
    assert hydrate_error.value.detail["code"] == start_error.value.detail["code"]


def test_origin_key_is_canonicalized_and_graph_deletion_fails_closed(coherent_origin):
    outcome = _start_at_origin(coherent_origin, origin_node_id="origin-key")
    assert outcome.thread.origin_node_id == coherent_origin["origin_node_id"]
    with Session(get_engine()) as session:
        node = session.get(GraphNode, coherent_origin["origin_node_id"])
        session.delete(node)
        session.add(GraphNode(
            snapshot_id=coherent_origin["snapshot_id"], node_key="origin-key",
            node_type="event", round_number=2,
            payload_json=json.dumps({"branch_id": coherent_origin["origin_branch_id"]}),
        ))
        session.commit()
        with pytest.raises(HTTPException) as exc_info:
            _load_prompt_context(session, outcome.thread)
        assert exc_info.value.detail["code"] == "ORIGIN_NODE_NOT_FOUND"


def test_descendant_scope_allows_ancestor_node_and_excludes_parent_future(coherent_origin):
    with Session(get_engine()) as session:
        child = Branch(
            scenario_id=coherent_origin["scenario_id"],
            parent_branch_id=coherent_origin["origin_branch_id"], fork_round=1,
            title="Descendant scope",
        )
        session.add(child)
        session.flush()
        session.add(Round(branch_id=child.id, round_number=2))
        session.commit()
        child_id = child.id
    outcome = _start_at_origin(coherent_origin, origin_branch_id=child_id)
    with Session(get_engine()) as session:
        context = _load_prompt_context(session, outcome.thread)
    assert "Descendant scope" in context.branch_summary
    assert "ancestor-round-one" in "\n".join(context.round_transcripts)
    assert "parent-post-fork-secret" not in "\n".join(context.round_transcripts)
    assert len(context.round_transcripts) == 1


def test_self_contained_replay_rejects_source_branch_node(coherent_origin):
    with Session(get_engine()) as session:
        replay = Branch(
            scenario_id=coherent_origin["scenario_id"],
            parent_branch_id=coherent_origin["origin_branch_id"], fork_round=1,
            replay_kind="resume", title="Self-contained replay",
        )
        session.add(replay)
        session.flush()
        session.add(Round(branch_id=replay.id, round_number=1))
        session.commit()
        replay_id = replay.id
    with pytest.raises(HTTPException) as exc_info:
        _start_at_origin(coherent_origin, origin_branch_id=replay_id)
    assert exc_info.value.detail["code"] == "INVALID_CONVERSATION_ORIGIN"


def test_fork_target_and_projected_outcome_keep_authoritative_round(coherent_origin):
    with Session(get_engine()) as session:
        child = Branch(
            scenario_id=coherent_origin["scenario_id"],
            parent_branch_id=coherent_origin["origin_branch_id"], fork_round=1,
            status=BranchStatus.COMPLETED, title="Fork target",
        )
        session.add(child)
        session.flush()
        session.add(Round(branch_id=child.id, round_number=2))
        fork = GraphNode(
            snapshot_id=coherent_origin["snapshot_id"], node_key="fork-node",
            node_type="fork", round_number=1,
            payload_json=json.dumps({
                "branch_id": child.id, "source_branch_id": coherent_origin["origin_branch_id"],
            }),
        )
        session.add(fork)
        session.commit()
        child_id, fork_id = child.id, fork.id
    for node_id, node_type in ((fork_id, "fork"), (f"outcome:{child_id}", "outcome")):
        outcome = _start_at_origin(
            coherent_origin, origin_branch_id=child_id, origin_node_id=node_id,
            origin_node_type=node_type,
        )
        with Session(get_engine()) as session:
            context = _load_prompt_context(session, outcome.thread)
        assert "ancestor-round-one" in "\n".join(context.round_transcripts)
        assert "parent-post-fork-secret" not in "\n".join(context.round_transcripts)


def test_result_agent_without_graph_keeps_existing_parsed_history_fallback():
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Archived result", user_id="origin-owner", status=ScenarioStatus.DONE,
            parsed_context={"agents": [{
                "id": "archived-agent", "name": "Historian", "role": "Witness",
                "persona": "Remembers the original outcome.",
            }]},
        )
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id
    outcome = _start_at_origin({
        "scenario_id": scenario_id, "origin_branch_id": None, "origin_round_number": None,
        "origin_node_id": "agent:archived-agent", "origin_node_type": "agent",
    })
    with Session(get_engine()) as session:
        context = _load_prompt_context(session, outcome.thread)
    assert context.agent_name == "Historian"
    assert context.agent_persona == "Remembers the original outcome."
    assert context.round_transcripts == ()
    with pytest.raises(HTTPException):
        _start_at_origin({
            "scenario_id": scenario_id, "origin_branch_id": None, "origin_round_number": None,
            "origin_node_id": "agent:unknown-agent", "origin_node_type": "agent",
        })


def test_faction_event_is_pinned_and_hydrated_from_owned_durable_event(coherent_origin):
    with Session(get_engine()) as session:
        event = FactionEvent(
            scenario_id=coherent_origin["scenario_id"],
            branch_id=coherent_origin["origin_branch_id"], round_number=1,
            actor_agent_id=coherent_origin["actor_id"], faction_key="faction-a",
            event_type="betrayal", payload_json='{"shift": 0.7}',
        )
        session.add(event)
        session.commit()
        event_id = event.id
    outcome = _start_at_origin(
        coherent_origin, origin_node_id=coherent_origin["actor_id"],
        origin_node_type="faction_event:betrayal",
    )
    assert outcome.thread.origin_node_id == f"faction-event:{event_id}"
    with Session(get_engine()) as session:
        context = _load_prompt_context(session, outcome.thread)
    assert '"shift": 0.7' in context.node_summary
    assert "ancestor-round-one" in "\n".join(context.round_transcripts)


async def _lease_test_stream(factory):
    with Session(get_engine()) as session:
        scenario = Scenario(question="Durable stream lease", status=ScenarioStatus.DONE)
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id
    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id, owner_user_id=None, agent_identity_id=None,
        origin_branch_id=None, origin_round_number=None, origin_node_id=None, origin_node_type=None,
        first_user_content="hello",
    )
    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id, assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="hello", owner_user_id=None,
        overrides=service.LLMOverrides(None, None, "test-model", False),
        _llm_stream_factory=factory,
    )
    return outcome, stream


async def test_active_stream_past_five_minutes_keeps_durable_lease(monkeypatch):
    now = service._now()
    monkeypatch.setattr(service, "_now", lambda: now)

    async def provider(*_args, **_kwargs):
        nonlocal now
        for index in range(7):
            now += timedelta(minutes=1)
            yield f"part-{index}"

    outcome, stream = await _lease_test_stream(provider)
    try:
        assert (await anext(stream))["event"] == "turn_started"
        for _ in range(6):
            assert (await anext(stream))["event"] == "turn_token_delta"
        with pytest.raises(HTTPException) as exc_info:
            service.append_user_turn_and_reserve_assistant(
                thread_id=outcome.thread.id, owner_user_id=None, user_content="competing turn",
            )
        assert exc_info.value.detail["code"] == "THREAD_BUSY"
        with Session(get_engine()) as session:
            turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)
            assert turn.status == "streaming"
            assert turn.updated_at.replace(tzinfo=timezone.utc) == now
        assert [event["event"] async for event in stream] == [
            "turn_token_delta", "turn_completed",
        ]
    finally:
        await stream.aclose()


@pytest.mark.parametrize("local_signal", [True, False])
async def test_stale_reap_cancels_old_stream_once_and_preserves_emitted_prefix(
    monkeypatch, local_signal,
):
    async def provider(*_args, **_kwargs):
        yield "visible-prefix"
        yield "revoked-late-token"

    outcome, stream = await _lease_test_stream(provider)
    try:
        assert (await anext(stream))["event"] == "turn_started"
        assert (await anext(stream))["data"]["delta"] == "visible-prefix"
        with Session(get_engine()) as session:
            turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)
            turn.updated_at = service._now() - timedelta(minutes=6)
            session.add(turn)
            session.commit()
        if not local_signal:
            monkeypatch.setattr(
                service, "_signal_turn_cancel_event", lambda *_args, **_kwargs: False,
            )
        _, _, next_turn = service.append_user_turn_and_reserve_assistant(
            thread_id=outcome.thread.id, owner_user_id=None, user_content="replacement",
        )
        if local_signal:
            assert service._get_turn_cancel_reason(outcome.assistant_turn.id) == "turn_revoked"
        events = [event async for event in stream]
        assert [event["event"] for event in events] == ["turn_aborted"]
        assert events[0]["data"]["code"] == "STALE_TURN_REAPED"
        with Session(get_engine()) as session:
            old = session.get(AgentConversationTurn, outcome.assistant_turn.id)
            thread = session.get(AgentConversationThread, outcome.thread.id)
            assert old.status == "aborted" and old.content == "visible-prefix"
            assert old.completed_at is not None
            assert thread.active_turn_id == next_turn.id and thread.latest_status == "pending"
    finally:
        await stream.aclose()


async def test_stalled_stream_heartbeats_and_detects_remote_abort(monkeypatch):
    monkeypatch.setattr(service, "_TURN_HEARTBEAT_SECONDS", 0.01)
    now = service._now()
    monkeypatch.setattr(service, "_now", lambda: now)
    entered = asyncio.Event()
    cleaned_up = asyncio.Event()

    async def provider(*_args, **_kwargs):
        yield "partial"
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned_up.set()

    outcome, stream = await _lease_test_stream(provider)
    pending = None
    try:
        await anext(stream)
        await anext(stream)
        pending = asyncio.create_task(anext(stream))
        await asyncio.wait_for(entered.wait(), timeout=0.5)
        now += timedelta(minutes=6)
        for _ in range(50):
            await asyncio.sleep(0.01)
            with Session(get_engine()) as session:
                turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)
                if turn.updated_at.replace(tzinfo=timezone.utc) == now:
                    assert turn.content == "partial"
                    break
        else:
            pytest.fail("live stalled stream did not renew its durable lease")
        with pytest.raises(HTTPException) as busy:
            service.append_user_turn_and_reserve_assistant(
                thread_id=outcome.thread.id, owner_user_id=None, user_content="competing",
            )
        assert busy.value.detail["code"] == "THREAD_BUSY"
        with Session(get_engine()) as session:
            assert service.finalize_turn_cas(
                session, turn_id=outcome.assistant_turn.id, new_status="aborted",
                error_code="USER_ABORTED",
            )
        terminal = await asyncio.wait_for(pending, timeout=0.5)
        assert terminal["event"] == "turn_aborted"
        assert cleaned_up.is_set()
        assert [event async for event in stream] == []
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await stream.aclose()


async def test_foreign_owner_cannot_cancel_registered_stream():
    async def provider(*_args, **_kwargs):
        yield "safe"

    outcome, stream = await _lease_test_stream(provider)
    try:
        await anext(stream)
        with pytest.raises(HTTPException) as exc_info:
            abort_turn(
                thread_id=outcome.thread.id, turn_id=outcome.assistant_turn.id,
                owner_user_id="foreign-owner",
            )
        assert exc_info.value.status_code == 404
        assert service._get_turn_cancel_reason(outcome.assistant_turn.id) is None
        assert [event["event"] async for event in stream] == ["turn_token_delta", "turn_completed"]
    finally:
        await stream.aclose()


async def test_historical_anchor_conflict_errors_before_provider(coherent_origin):
    outcome = _start_at_origin(coherent_origin)
    with Session(get_engine()) as session:
        thread = session.get(AgentConversationThread, outcome.thread.id)
        thread.origin_round_number = 999
        session.add(thread)
        session.commit()

    async def provider(*_args, **_kwargs):
        pytest.fail("Invalid historical coordinates must never reach the provider")
        yield ""

    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id, assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="Explain the event", owner_user_id="origin-owner",
        overrides=service.LLMOverrides(None, None, "test-model", False),
        _llm_stream_factory=provider,
    )
    events = [event async for event in stream]
    assert [event["event"] for event in events] == ["turn_error"]
    assert events[0]["data"]["code"] == "INVALID_CONVERSATION_ORIGIN"
    with Session(get_engine()) as session:
        turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)
        thread = session.get(AgentConversationThread, outcome.thread.id)
        assert turn.status == "error"
        assert thread.active_turn_id is None


async def test_abort_winning_final_cas_still_emits_one_terminal(monkeypatch):
    async def provider(*_args, **_kwargs):
        yield "visible"

    original_finalize = service.finalize_turn_cas

    def abort_before_done(session, **kwargs):
        if kwargs["new_status"] == "done":
            assert original_finalize(
                session, turn_id=kwargs["turn_id"], new_status="aborted",
                error_code="USER_ABORTED",
            )
        return original_finalize(session, **kwargs)

    monkeypatch.setattr(service, "finalize_turn_cas", abort_before_done)
    outcome, stream = await _lease_test_stream(provider)
    events = [event async for event in stream]
    assert [event["event"] for event in events] == [
        "turn_started", "turn_token_delta", "turn_aborted",
    ]
    with Session(get_engine()) as session:
        turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)
        assert turn.status == "aborted" and turn.content == "visible"


@pytest.mark.parametrize("explicit_effort", [None, "high"])
async def test_conversation_scope_honors_scenario_and_explicit_effort(
    monkeypatch, explicit_effort,
):
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Effort propagation", status=ScenarioStatus.DONE,
            parsed_context={"reasoning_effort": "low"},
        )
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id
    outcome = create_thread_with_first_turn(
        scenario_id=scenario_id, owner_user_id=None, agent_identity_id=None,
        origin_branch_id=None, origin_round_number=None, origin_node_id=None, origin_node_type=None,
        first_user_content="hello",
    )
    captured = []
    from app.services.llm_client import resolve_reasoning_effort

    async def empty_stream(*_args, **_kwargs):
        captured.append(resolve_reasoning_effort())
        if False:
            yield ""

    async def fallback(*_args, **_kwargs):
        captured.append(resolve_reasoning_effort())
        return "complete fallback"

    monkeypatch.setattr(service, "llm_call", fallback)
    stream = await stream_assistant_turn(
        thread_id=outcome.thread.id, assistant_turn_id=outcome.assistant_turn.id,
        new_user_content="hello", owner_user_id=None,
        overrides=service.LLMOverrides(
            None, None, "test-model", False, reasoning_effort=explicit_effort,
        ),
        _llm_stream_factory=empty_stream,
    )
    events = [event async for event in stream]
    assert events[-1]["event"] == "turn_completed"
    assert captured == [explicit_effort or "low"] * 2


async def test_abort_after_fallback_delta_wins_common_finalization(monkeypatch):
    async def empty_provider(*_args, **_kwargs):
        if False:
            yield ""

    async def fallback(*_args, **_kwargs):
        return "visible fallback prefix"

    monkeypatch.setattr(service, "llm_call", fallback)
    outcome, stream = await _lease_test_stream(empty_provider)
    try:
        assert (await anext(stream))["event"] == "turn_started"
        delta = await anext(stream)
        assert delta["event"] == "turn_token_delta"
        assert delta["data"]["delta"] == "visible fallback prefix"
        assert abort_turn(
            thread_id=outcome.thread.id, turn_id=outcome.assistant_turn.id,
            owner_user_id=None,
        ) is True
        remaining = [event async for event in stream]
        assert [event["event"] for event in remaining] == ["turn_aborted"]
        assert remaining[0]["data"]["code"] == "USER_ABORTED"
        with Session(get_engine()) as session:
            turn = session.get(AgentConversationTurn, outcome.assistant_turn.id)
            thread = session.get(AgentConversationThread, outcome.thread.id)
            assert turn.status == "aborted"
            assert turn.content == "visible fallback prefix"
            assert thread.active_turn_id is None and thread.latest_status == "aborted"
    finally:
        await stream.aclose()
