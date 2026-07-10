"""Wave 1 regressions for branch-scoped agent state and prompt context."""

from __future__ import annotations

import copy

import pytest
from sqlmodel import Session, select

import app.services.simulator as simulator_module
from app.models import (
    Agent,
    AgentRelationEdge,
    AgentTier,
    Branch,
    BranchStatus,
    Round,
    Scenario,
    ScenarioCheckpoint,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.blackboard import Blackboard
from app.services.factions import build_previous_round_relationship_contexts
from app.services.memory import build_agent_context
from app.services.replay import write_checkpoint
from app.services.simulator import (
    _agent_to_dict,
    _create_branch,
    _create_round,
    _gather_agent_messages,
    run_simulation,
)
from app.services.vector_store import VectorStore


def _make_scenario(
    engine,
    *,
    rounds: int = 2,
    mode: str = "raw",
    initial_title: str = "Root",
) -> str:
    scenario = Scenario(
        question="Can this branch preserve independent agent state?",
        status=ScenarioStatus.SIMULATING,
        parsed_context={
            "_language": "English",
            "initial_title": initial_title,
            "setting": {},
            "simulation_rounds": rounds,
            "branch_sensitivity": 0.9,
            "key_variable": "Can this branch preserve independent agent state?",
            "mode": mode,
        },
    )
    with Session(engine) as session:
        session.add(scenario)
        session.commit()
        return scenario.id


def _add_agent(
    engine,
    scenario_id: str,
    *,
    name: str = "Analyst",
    emotion: str = "neutral",
    tier: AgentTier = AgentTier.CORE,
) -> dict:
    agent = Agent(
        scenario_id=scenario_id,
        name=name,
        role="Strategist",
        persona="Tracks state carefully",
        emotion=emotion,
        tier=tier,
    )
    with Session(engine) as session:
        session.add(agent)
        session.commit()
        session.refresh(agent)
        return _agent_to_dict(agent)


def _disable_unrelated_run_features(monkeypatch) -> None:
    for name in (
        "FEATURE_CAUSAL_GRAPH",
        "FEATURE_FACTIONS",
        "FEATURE_RESULT_VERDICT",
        "FEATURE_RESULT_REPORT",
        "FEATURE_FORK_TITLE_REWRITE",
    ):
        monkeypatch.setattr(simulator_module.settings, name, False)
    monkeypatch.setattr(simulator_module.settings, "MEMORY_COMPRESS_INTERVAL", 100)
    monkeypatch.setattr(simulator_module, "_CHECKPOINT_AVAILABLE", True)
    monkeypatch.setattr(simulator_module.settings, "FEATURE_COUNTERFACTUAL_REPLAY", True)
    monkeypatch.setattr(simulator_module, "store_memory", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        simulator_module,
        "retrieve_relevant_memories",
        lambda *args, **kwargs: "",
    )


@pytest.mark.asyncio
async def test_round_two_prompt_uses_updated_emotion_without_visualization(monkeypatch):
    engine = get_engine()
    scenario_id = _make_scenario(engine)
    branch_id = _create_branch(engine, scenario_id, title="Root")
    agent = _add_agent(engine, scenario_id)
    prompts: list[str] = []
    extracted_emotions = iter(("resolute", "concerned"))

    async def fake_llm_call(prompt: str, *_args, **_kwargs):
        prompts.append(prompt)
        return "I will keep the state visible."

    async def fake_llm_call_json(*_args, **_kwargs):
        return {
            "content": "I will keep the state visible.",
            "emotion": next(extracted_emotions),
            "diverge": None,
        }

    monkeypatch.setattr(simulator_module, "llm_call", fake_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", fake_llm_call_json)
    monkeypatch.setattr(simulator_module, "retrieve_relevant_memories", lambda *a, **k: "")
    monkeypatch.setattr(simulator_module, "store_memory", lambda *a, **k: None)

    await _gather_agent_messages(
        engine,
        scenario_id,
        branch_id,
        _create_round(engine, branch_id, 1),
        1,
        [agent],
        "background",
        "topic",
        language="English",
        viz_mapper=None,
    )

    assert agent["emotion"] == "resolute"

    await _gather_agent_messages(
        engine,
        scenario_id,
        branch_id,
        _create_round(engine, branch_id, 2),
        2,
        [agent],
        "background",
        "topic",
        language="English",
        viz_mapper=None,
    )

    assert len(prompts) == 2
    assert "[Current Emotion] resolute" in prompts[1]
    assert agent["emotion"] == "concerned"


def test_branch_agent_state_clone_inherits_then_isolates_forks_and_resume():
    clone_agent_states = getattr(simulator_module, "_clone_agent_states")
    base = [
        {
            "id": "agent-1",
            "name": "Analyst",
            "stance": "cautious",
            "emotion": "neutral",
            "knowledge": {"signals": ["baseline"]},
        }
    ]

    resumed = clone_agent_states(
        base,
        checkpoint_states=[
            {"agent_id": "agent-1", "stance": "committed", "emotion": "focused"}
        ],
    )
    sibling = clone_agent_states(base)
    child_a = clone_agent_states(resumed)
    child_b = clone_agent_states(resumed)

    child_a[0]["emotion"] = "angry"
    child_a[0]["knowledge"]["signals"].append("child-a-only")

    assert base[0]["emotion"] == "neutral"
    assert sibling[0]["emotion"] == "neutral"
    assert resumed[0]["emotion"] == "focused"
    assert child_b[0]["emotion"] == "focused"
    assert child_b[0]["knowledge"] == {"signals": ["baseline"]}


@pytest.mark.asyncio
async def test_fork_children_inherit_then_isolate_prompt_checkpoint_and_narration_state(
    monkeypatch,
):
    engine = get_engine()
    scenario_id = _make_scenario(engine, rounds=2, initial_title="Root")
    agent = _add_agent(engine, scenario_id)
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        assert scenario is not None
        scenario.parsed_context = {
            **dict(scenario.parsed_context or {}),
            "hierarchical": True,
            "groups": [
                {
                    "name": "analysis",
                    "leader": "Analyst",
                    "members": ["Analyst"],
                }
            ],
        }
        session.add(scenario)
        session.commit()
    turn_prompts: dict[str, str] = {}
    checkpoint_states: dict[tuple[str, int], list[dict]] = {}
    narration_states: dict[str, list[dict]] = {}

    async def fake_llm_call(prompt: str, *_args, **_kwargs):
        if "Alpha path" in prompt:
            turn_prompts["Alpha path"] = prompt
            return "ALPHA_TURN"
        if "Beta path" in prompt:
            turn_prompts["Beta path"] = prompt
            return "BETA_TURN"
        turn_prompts["Root"] = prompt
        return "ROOT_TURN"

    async def fake_metadata(prompt: str, *_args, **_kwargs):
        if "ALPHA_TURN" in prompt:
            return {"content": "ALPHA_TURN", "emotion": "angry", "diverge": None}
        if "BETA_TURN" in prompt:
            return {"content": "BETA_TURN", "emotion": "hopeful", "diverge": None}
        return {
            "content": "ROOT_TURN",
            "emotion": "focused",
            "diverge": "Two incompatible paths",
        }

    async def fake_fork_detector(prompt: str, *_args, **_kwargs):
        assert "should_fork" in prompt
        return {
            "should_fork": True,
            "reason": "The paths are mutually exclusive",
            "branches": [
                {
                    "title": "Alpha path",
                    "description": "Alpha continues",
                    "probability": 0.5,
                },
                {
                    "title": "Beta path",
                    "description": "Beta continues",
                    "probability": 0.5,
                },
            ],
        }

    def capture_checkpoint(
        _scenario_id: str,
        branch_id: str,
        round_number: int,
        agents: list[dict],
        _blackboard=None,
    ) -> None:
        checkpoint_states[(branch_id, round_number)] = copy.deepcopy(agents)

    async def capture_narration(
        _engine,
        branch_id: str,
        agents: list[dict],
        **_kwargs,
    ) -> dict:
        with Session(engine) as session:
            branch = session.get(Branch, branch_id)
            assert branch is not None
            narration_states[branch.title] = copy.deepcopy(agents)
        return {
            "title": "ignored",
            "story": "The branch completed.",
            "insight": "State remained branch scoped.",
        }

    _disable_unrelated_run_features(monkeypatch)
    monkeypatch.setattr(simulator_module, "llm_call", fake_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", fake_metadata)
    monkeypatch.setattr(
        simulator_module,
        "llm_call_json_with_stream_fallback",
        fake_fork_detector,
    )
    monkeypatch.setattr(simulator_module, "_checkpoint_write", capture_checkpoint)
    monkeypatch.setattr(
        simulator_module,
        "_narrate_branch_data_fail_soft",
        capture_narration,
    )

    await run_simulation(scenario_id)

    assert "[Current Emotion] focused" in turn_prompts["Alpha path"]
    assert "[Current Emotion] focused" in turn_prompts["Beta path"]
    assert "[Current Emotion] angry" not in turn_prompts["Beta path"]

    with Session(engine) as session:
        branches = session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all()
    branch_ids = {branch.title: branch.id for branch in branches}

    assert checkpoint_states[(branch_ids["Root"], 1)][0]["emotion"] == "focused"
    assert checkpoint_states[(branch_ids["Alpha path"], 2)][0]["emotion"] == "angry"
    assert checkpoint_states[(branch_ids["Beta path"], 2)][0]["emotion"] == "hopeful"
    assert narration_states["Alpha path"][0]["emotion"] == "angry"
    assert narration_states["Beta path"][0]["emotion"] == "hopeful"
    assert agent["emotion"] == "neutral"


def test_vector_retrieve_filters_exact_agent_within_allowed_branch_lineage(tmp_path):
    store = VectorStore(persist_dir=str(tmp_path / "wave1-chroma"))
    assert store.available
    store.store(
        "scenario-own-memory",
        "Alice",
        "Root memory from Alice",
        agent_id="alice-id",
        round_num=1,
        branch_id="root",
    )
    store.store(
        "scenario-own-memory",
        "Bob",
        "Root memory from Bob",
        agent_id="bob-id",
        round_num=1,
        branch_id="root",
    )
    store.store(
        "scenario-own-memory",
        "Alice",
        "Child memory from Alice",
        agent_id="alice-id",
        round_num=2,
        branch_id="child",
    )
    store.store(
        "scenario-own-memory",
        "Alice",
        "Sibling-only memory from Alice",
        agent_id="alice-id",
        round_num=2,
        branch_id="sibling",
    )

    results = store.retrieve(
        "scenario-own-memory",
        "memory",
        top_k=10,
        allowed_branch_ids=["child", "root"],
        agent_id="alice-id",
        agent_name="Alice",
    )

    assert {item["agent_name"] for item in results} == {"Alice"}
    assert {item["branch_id"] for item in results} == {"root", "child"}
    assert all("Bob" not in item["content"] for item in results)
    assert all("Sibling-only" not in item["content"] for item in results)


def test_vector_memory_isolated_by_agent_id_when_display_names_match(tmp_path):
    store = VectorStore(persist_dir=str(tmp_path / "wave1-agent-id-chroma"))
    assert store.available
    store.store(
        "scenario-stable-agent-id",
        "Alex",
        "Memory owned by agent A",
        agent_id="agent-a",
        round_num=1,
        branch_id="root",
    )
    store.store(
        "scenario-stable-agent-id",
        "Alex",
        "Memory owned by agent B",
        agent_id="agent-b",
        round_num=1,
        branch_id="root",
    )

    results = store.retrieve(
        "scenario-stable-agent-id",
        "Memory owned by agent",
        top_k=10,
        allowed_branch_rounds={"root": 1},
        agent_id="agent-a",
        agent_name="Alex",
        allow_legacy_name_fallback=False,
    )

    assert [item["content"] for item in results] == ["Memory owned by agent A"]
    assert results[0]["agent_id"] == "agent-a"


def test_legacy_agent_name_memory_requires_explicit_unique_name_fallback(tmp_path):
    store = VectorStore(persist_dir=str(tmp_path / "wave1-legacy-name-chroma"))
    assert store.available
    store.store(
        "scenario-legacy-agent-name",
        "Alex",
        "Legacy memory without a stable agent id",
        round_num=1,
        branch_id="root",
    )

    fail_closed = store.retrieve(
        "scenario-legacy-agent-name",
        "Legacy memory",
        top_k=10,
        allowed_branch_rounds={"root": 1},
        agent_id="agent-a",
        agent_name="Alex",
        allow_legacy_name_fallback=False,
    )
    unique_name_fallback = store.retrieve(
        "scenario-legacy-agent-name",
        "Legacy memory",
        top_k=10,
        allowed_branch_rounds={"root": 1},
        agent_id="agent-a",
        agent_name="Alex",
        allow_legacy_name_fallback=True,
    )

    assert fail_closed == []
    assert [item["content"] for item in unique_name_fallback] == [
        "Legacy memory without a stable agent id"
    ]


def test_vector_retrieve_excludes_memories_after_each_branch_cutoff(tmp_path):
    store = VectorStore(persist_dir=str(tmp_path / "wave1-round-scoped-chroma"))
    assert store.available
    for round_number in (1, 2, 3):
        store.store(
            "scenario-round-scope",
            "Alice",
            f"Source memory R{round_number}",
            agent_id="alice-id",
            round_num=round_number,
            branch_id="source",
        )
    store.store(
        "scenario-round-scope",
        "Alice",
        "Child memory R2",
        agent_id="alice-id",
        round_num=2,
        branch_id="child",
    )

    results = store.retrieve(
        "scenario-round-scope",
        "memory",
        top_k=10,
        allowed_branch_rounds={"source": 1, "child": 2},
        agent_id="alice-id",
        agent_name="Alice",
    )

    assert {item["content"] for item in results} == {
        "Source memory R1",
        "Child memory R2",
    }


def test_vector_retrieve_rejects_unverifiable_round_metadata(tmp_path):
    store = VectorStore(persist_dir=str(tmp_path / "wave1-missing-round-chroma"))
    assert store.available
    collection = store._get_collection("scenario-missing-round")
    assert collection is not None
    collection.add(
        documents=["Memory with no causal round"],
        metadatas=[{
            "agent_id": "alice-id",
            "agent_name": "Alice",
            "branch_id": "source",
        }],
        ids=["missing-round"],
    )

    results = store.retrieve(
        "scenario-missing-round",
        "memory",
        top_k=10,
        allowed_branch_rounds={"source": 1},
        agent_id="alice-id",
        agent_name="Alice",
    )

    assert results == []


def test_replay_branch_memory_scope_stops_ancestor_at_cloned_fork_round():
    engine = get_engine()
    scenario_id = _make_scenario(engine, rounds=4)
    source_id = _create_branch(engine, scenario_id, title="Completed source")
    replay_id = _create_branch(
        engine,
        scenario_id,
        parent_branch_id=source_id,
        fork_round=1,
        title="Replay from R2",
    )
    with Session(engine) as session:
        replay = session.get(Branch, replay_id)
        assert replay is not None
        replay.replay_kind = "counterfactual"
        replay.replay_source_branch_id = source_id
        replay.replay_source_round = 2
        session.add(replay)
        session.commit()

    scope = simulator_module._branch_memory_round_limits(
        engine,
        replay_id,
        current_round=2,
    )

    assert scope == {replay_id: 1, source_id: 1}


def test_counterfactual_target_memory_scope_excludes_replaced_source_round():
    engine = get_engine()
    scenario_id = _make_scenario(engine, rounds=4)
    target = _add_agent(engine, scenario_id, name="Target")
    observer = _add_agent(engine, scenario_id, name="Observer")
    source_id = _create_branch(engine, scenario_id, title="Completed source")
    replay_id = _create_branch(
        engine,
        scenario_id,
        parent_branch_id=source_id,
        fork_round=2,
        title="Counterfactual from R2",
    )
    with Session(engine) as session:
        replay = session.get(Branch, replay_id)
        assert replay is not None
        replay.replay_kind = "counterfactual"
        replay.replay_source_branch_id = source_id
        replay.replay_source_round = 2
        replay.replay_source_agent_id = target["id"]
        session.add(replay)
        session.commit()

    target_scope = simulator_module._branch_memory_round_limits(
        engine,
        replay_id,
        current_round=3,
        agent_id=target["id"],
    )
    observer_scope = simulator_module._branch_memory_round_limits(
        engine,
        replay_id,
        current_round=3,
        agent_id=observer["id"],
    )

    assert target_scope == {replay_id: 2, source_id: 1}
    assert observer_scope == {replay_id: 2, source_id: 2}


def test_round_one_retrospective_keeps_source_memory_cap_at_zero():
    engine = get_engine()
    scenario_id = _make_scenario(engine, rounds=3)
    source_id = _create_branch(engine, scenario_id, title="Source")
    replay_id = _create_branch(
        engine,
        scenario_id,
        parent_branch_id=source_id,
        fork_round=0,
        title="Retrospective from R1",
    )
    with Session(engine) as session:
        replay = session.get(Branch, replay_id)
        assert replay is not None
        replay.replay_kind = "retrospective"
        replay.replay_source_branch_id = source_id
        replay.replay_source_round = 1
        session.add(replay)
        session.commit()

    scope = simulator_module._branch_memory_round_limits(
        engine,
        replay_id,
        current_round=2,
    )

    assert scope == {replay_id: 1, source_id: 0}


def test_cyclic_branch_memory_lineage_fails_closed_to_starting_branch():
    engine = get_engine()
    scenario_id = _make_scenario(engine, rounds=3)
    branch_a_id = _create_branch(
        engine,
        scenario_id,
        fork_round=1,
        title="Cycle A",
    )
    branch_b_id = _create_branch(
        engine,
        scenario_id,
        parent_branch_id=branch_a_id,
        fork_round=1,
        title="Cycle B",
    )
    with Session(engine) as session:
        branch_a = session.get(Branch, branch_a_id)
        assert branch_a is not None
        branch_a.parent_branch_id = branch_b_id
        session.add(branch_a)
        session.commit()

    scope = simulator_module._branch_memory_round_limits(
        engine,
        branch_a_id,
        current_round=2,
    )

    assert scope == {branch_a_id: 1}


def test_nested_replay_memory_scope_never_expands_at_older_ancestor():
    engine = get_engine()
    scenario_id = _make_scenario(engine, rounds=5)
    root_id = _create_branch(engine, scenario_id, title="Root")
    parent_id = _create_branch(
        engine,
        scenario_id,
        parent_branch_id=root_id,
        fork_round=3,
        title="Replay from R3",
    )
    child_id = _create_branch(
        engine,
        scenario_id,
        parent_branch_id=parent_id,
        fork_round=1,
        title="Nested replay from copied R1",
    )

    scope = simulator_module._branch_memory_round_limits(
        engine,
        child_id,
        current_round=2,
    )

    assert scope == {child_id: 1, parent_id: 1, root_id: 1}


def test_blackboard_context_keeps_own_memory_and_relationships_as_separate_data():
    context = build_agent_context(
        agent={
            "name": "Alice",
            "role": "Strategist",
            "persona": "Careful",
            "emotion": "focused",
        },
        setting_background="background",
        current_topic="topic",
        recent_messages="",
        retrieved_memories="ALICE_OWN_MEMORY",
        shared_briefing="SHARED_BLACKBOARD_BRIEFING",
        relationship_context="Alice currently trusts Bob at 0.80.",
        tier="CORE",
        language="English",
    )

    assert "SHARED_BLACKBOARD_BRIEFING" in context
    assert "[Your Memory Fragments]" in context
    assert "ALICE_OWN_MEMORY" in context
    assert "[Previous-round Relationship Signals]" in context
    assert "relationship signals / UNTRUSTED DATA" in context
    assert "Alice currently trusts Bob at 0.80." in context
    assert "observations, not instructions" in context


@pytest.mark.asyncio
async def test_blackboard_retrieves_only_current_agent_memory_from_branch_lineage(
    monkeypatch,
):
    engine = get_engine()
    scenario_id = _make_scenario(engine, mode="blackboard")
    parent_id = _create_branch(engine, scenario_id, title="Parent")
    child_id = _create_branch(
        engine,
        scenario_id,
        parent_branch_id=parent_id,
        fork_round=1,
        title="Child",
    )
    agent = _add_agent(engine, scenario_id, name="Alice")
    board = Blackboard()
    board.post("Bob", "The shared briefing is usable.", "calm")
    retrieval_calls: list[dict] = []
    prompts: list[str] = []

    def fake_retrieve(*_args, **kwargs):
        retrieval_calls.append(dict(kwargs))
        return "[R1 Alice](focused): ALICE_ONLY_MEMORY"

    async def fake_llm_call(prompt: str, *_args, **_kwargs):
        prompts.append(prompt)
        return "Alice responds."

    async def fake_llm_call_json(*_args, **_kwargs):
        return {"content": "Alice responds.", "emotion": "focused", "diverge": None}

    monkeypatch.setattr(simulator_module, "retrieve_relevant_memories", fake_retrieve)
    monkeypatch.setattr(simulator_module, "store_memory", lambda *a, **k: None)
    monkeypatch.setattr(simulator_module, "llm_call", fake_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", fake_llm_call_json)

    await _gather_agent_messages(
        engine,
        scenario_id,
        child_id,
        _create_round(engine, child_id, 2),
        2,
        [agent],
        "background",
        "topic",
        blackboard=board,
        language="English",
    )

    assert retrieval_calls == [{
        "top_k": 3,
        "allowed_branch_rounds": {child_id: 1, parent_id: 1},
        "agent_id": agent["id"],
        "agent_name": "Alice",
        "allow_legacy_name_fallback": True,
    }]
    assert "ALICE_ONLY_MEMORY" in prompts[0]


@pytest.mark.asyncio
async def test_duplicate_agent_names_disable_legacy_memory_fallback(monkeypatch):
    engine = get_engine()
    scenario_id = _make_scenario(engine, mode="blackboard")
    branch_id = _create_branch(engine, scenario_id, title="Duplicate names")
    first = _add_agent(engine, scenario_id, name="Alex")
    second = _add_agent(engine, scenario_id, name="Alex")
    board = Blackboard()
    board.post("Observer", "The shared briefing is usable.", "calm")
    retrieval_calls: list[dict] = []
    stored_calls: list[dict] = []

    def fake_retrieve(*_args, **kwargs):
        retrieval_calls.append(dict(kwargs))
        return ""

    async def fake_llm_call(*_args, **_kwargs):
        return "Alex responds."

    async def fake_llm_call_json(*_args, **_kwargs):
        return {"content": "Alex responds.", "emotion": "focused", "diverge": None}

    monkeypatch.setattr(simulator_module, "retrieve_relevant_memories", fake_retrieve)
    monkeypatch.setattr(
        simulator_module,
        "store_memory",
        lambda **kwargs: stored_calls.append(dict(kwargs)),
    )
    monkeypatch.setattr(simulator_module, "llm_call", fake_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", fake_llm_call_json)

    await _gather_agent_messages(
        engine,
        scenario_id,
        branch_id,
        _create_round(engine, branch_id, 1),
        1,
        [first, second],
        "background",
        "topic",
        blackboard=board,
        language="English",
    )

    assert {call["agent_id"] for call in retrieval_calls} == {
        first["id"],
        second["id"],
    }
    assert all(
        call["allow_legacy_name_fallback"] is False
        for call in retrieval_calls
    )
    assert {call["agent_id"] for call in stored_calls} == {
        first["id"],
        second["id"],
    }


@pytest.mark.asyncio
async def test_previous_round_adjacent_relationship_enters_next_turn_prompt(monkeypatch):
    engine = get_engine()
    scenario_id = _make_scenario(engine)
    branch_id = _create_branch(engine, scenario_id, title="Relationship branch")
    alice = _add_agent(engine, scenario_id, name="Alice")
    bob = _add_agent(engine, scenario_id, name="Bob")

    with Session(engine) as session:
        session.add(
            AgentRelationEdge(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=1,
                source_agent_id=alice["id"],
                target_agent_id=bob["id"],
                trust_score=0.82,
                opposition_score=0.18,
                evidence_summary="They defended the same proposal.",
            )
        )
        session.add(
            AgentRelationEdge(
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_number=2,
                source_agent_id=alice["id"],
                target_agent_id=bob["id"],
                trust_score=0.01,
                opposition_score=0.99,
                evidence_summary="FUTURE_EDGE_MUST_NOT_APPEAR",
            )
        )
        session.commit()

    prompts: list[str] = []

    async def fake_llm_call(prompt: str, *_args, **_kwargs):
        prompts.append(prompt)
        return "Relationship-aware response."

    async def fake_llm_call_json(*_args, **_kwargs):
        return {
            "content": "Relationship-aware response.",
            "emotion": "attentive",
            "diverge": None,
        }

    monkeypatch.setattr(simulator_module.settings, "FEATURE_FACTIONS", True)
    monkeypatch.setattr(simulator_module, "llm_call", fake_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", fake_llm_call_json)
    monkeypatch.setattr(simulator_module, "retrieve_relevant_memories", lambda *a, **k: "")
    monkeypatch.setattr(simulator_module, "store_memory", lambda *a, **k: None)

    await _gather_agent_messages(
        engine,
        scenario_id,
        branch_id,
        _create_round(engine, branch_id, 2),
        2,
        [alice, bob],
        "background",
        "topic",
        language="English",
    )

    alice_prompt = next(
        prompt for prompt in prompts
        if "You are speaking only as the character named Alice." in prompt
    )
    assert "[Previous-round Relationship Signals]" in alice_prompt
    assert "Bob" in alice_prompt
    assert "trust=0.82" in alice_prompt
    assert "They defended the same proposal." in alice_prompt
    assert "FUTURE_EDGE_MUST_NOT_APPEAR" not in alice_prompt


def test_relationship_context_is_agent_perspective_and_bounded():
    engine = get_engine()
    scenario_id = _make_scenario(engine)
    branch_id = _create_branch(engine, scenario_id, title="Bounded relationships")
    alice = _add_agent(engine, scenario_id, name="Alice")
    peers = [
        _add_agent(engine, scenario_id, name=f"Peer {index}")
        for index in range(6)
    ]

    with Session(engine) as session:
        for index, peer in enumerate(peers):
            session.add(
                AgentRelationEdge(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_number=1,
                    source_agent_id=alice["id"],
                    target_agent_id=peer["id"],
                    trust_score=0.9 - (index * 0.05),
                    opposition_score=0.1 + (index * 0.05),
                    evidence_summary=f"evidence-{index}-" + ("x" * 300),
                )
            )
        session.commit()

    contexts = build_previous_round_relationship_contexts(
        engine,
        scenario_id,
        branch_id,
        2,
        [alice, *peers],
        language="English",
        max_edges_per_agent=4,
        max_chars_per_agent=420,
    )

    alice_context = contexts[alice["id"]]
    assert alice_context.count("- With ") <= 4
    assert len(alice_context) <= 420
    assert "Peer 0" in alice_context
    assert "Peer 5" not in alice_context


@pytest.mark.asyncio
async def test_resume_restores_only_active_branch_state_and_keeps_sibling_checkpoint(
    monkeypatch,
):
    engine = get_engine()
    scenario_id = _make_scenario(engine, rounds=2)
    agent = _add_agent(engine, scenario_id, emotion="neutral")

    with Session(engine) as session:
        source = Branch(
            scenario_id=scenario_id,
            title="Source",
            status=BranchStatus.COMPLETED,
            probability=1.0,
        )
        session.add(source)
        session.flush()
        resumed = Branch(
            scenario_id=scenario_id,
            parent_branch_id=source.id,
            fork_round=1,
            title="Resumed",
            replay_kind="resume",
            status=BranchStatus.ACTIVE,
            probability=0.6,
        )
        sibling = Branch(
            scenario_id=scenario_id,
            parent_branch_id=source.id,
            fork_round=1,
            title="Sibling",
            replay_kind="resume",
            status=BranchStatus.ACTIVE,
            probability=0.4,
        )
        session.add(resumed)
        session.add(sibling)
        session.flush()
        session.add(Round(branch_id=resumed.id, round_number=1))
        session.add(Round(branch_id=sibling.id, round_number=1))
        session.commit()
        source_id = source.id
        resumed_id = resumed.id
        sibling_id = sibling.id

    write_checkpoint(
        scenario_id,
        source_id,
        1,
        [{"id": agent["id"], "stance": "committed", "emotion": "focused"}],
    )
    write_checkpoint(
        scenario_id,
        sibling_id,
        1,
        [{"id": agent["id"], "stance": "opposed", "emotion": "angry"}],
    )
    prompts: list[str] = []

    async def fake_llm_call(prompt: str, *_args, **_kwargs):
        prompts.append(prompt)
        return "The resumed branch continues."

    async def fake_llm_call_json(*_args, **_kwargs):
        return {
            "content": "The resumed branch continues.",
            "emotion": "calm",
            "diverge": None,
        }

    async def fake_narration(*_args, **_kwargs):
        return {
            "title": "ignored",
            "story": "Resume completed.",
            "insight": "Only the active branch was restored.",
        }

    _disable_unrelated_run_features(monkeypatch)
    monkeypatch.setattr(simulator_module, "llm_call", fake_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", fake_llm_call_json)
    monkeypatch.setattr(
        simulator_module,
        "_narrate_branch_data_fail_soft",
        fake_narration,
    )

    await run_simulation(scenario_id, branch_id=resumed_id)

    assert "[Current Emotion] focused" in prompts[0]
    with Session(engine) as session:
        db_agent = session.get(Agent, agent["id"])
        sibling_checkpoint = session.exec(
            select(ScenarioCheckpoint).where(
                ScenarioCheckpoint.branch_id == sibling_id,
                ScenarioCheckpoint.round_number == 1,
            )
        ).one()
    assert db_agent is not None
    assert db_agent.emotion == "neutral"
    assert sibling_checkpoint.compressed_summary is not None
    assert '"emotion": "angry"' in sibling_checkpoint.compressed_summary
