"""Regression tests for agent conversation prompt context enrichment."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException
from sqlmodel import Session

from app.models.agent_conversation import AgentConversationThread
from app.models.database import (
    Agent,
    AgentMessage,
    Branch,
    Round,
    Scenario,
    ScenarioStatus,
    get_engine,
)
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.models.model_profile import ModelProfile
from app.services.conversation_service import (
    _build_prompt,
    _load_prompt_context,
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


def test_load_prompt_context_drops_cross_scenario_branch_id_from_transcript():
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

        context = _load_prompt_context(session, thread)

    assert context.branch_summary is None, (
        "Foreign-scenario branch must be blanked, not summarized"
    )
    assert context.round_transcripts == (), (
        "Foreign-scenario rounds must NOT be summarized into the prompt"
    )

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
            user_id=None,
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
