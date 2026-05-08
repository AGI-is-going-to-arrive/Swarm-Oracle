"""Regression tests for agent conversation prompt context enrichment."""

from __future__ import annotations

import json

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
from app.services.conversation_service import _build_prompt, _load_prompt_context


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
