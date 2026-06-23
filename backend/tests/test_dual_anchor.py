"""Regression tests for P0 dual-anchor simulation prompts."""

import pytest
from sqlmodel import Session

import app.services.simulator as simulator_module
from app.config import effective_memory_compress_interval, settings
from app.models import Agent, AgentTier, Branch, BranchStatus, Scenario
from app.models.database import get_engine
from app.services.simulator import (
    _agent_to_dict,
    _build_worldline_context,
    _create_branch,
    _create_round,
    _gather_agent_messages,
    _prepend_agent_turn_prompt_prefix,
)


def _make_scenario(question: str, parsed_context: dict | None = None) -> str:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question=question, parsed_context=parsed_context or {})
        session.add(scenario)
        session.commit()
        return scenario.id


def test_effective_compress_interval_does_not_add_short_branch_llm_calls(monkeypatch):
    monkeypatch.setattr(settings, "MEMORY_COMPRESS_INTERVAL", 5)
    monkeypatch.setattr(settings, "MEMORY_COMPRESS_SHORT_BRANCH_INTERVAL", 2)
    monkeypatch.setattr(settings, "MEMORY_COMPRESS_SHORT_BRANCH_MAX_ROUNDS", 4)

    assert effective_memory_compress_interval(1) == 5
    assert effective_memory_compress_interval(4) == 5
    assert effective_memory_compress_interval(5) == 5


def test_turn_prompt_prefix_includes_original_and_branch_question_with_causal_scaffold():
    prompt = _prepend_agent_turn_prompt_prefix(
        "body",
        agent_name="林默",
        topic="猫法庭如何处置人类上诉权",
        scenario_question="如果猫掌握了全球法院，人类最后会怎样？",
        branch_question="猫议会把上诉期压到一天后，人类会怎样反应？",
        worldline_context="分叉原因: 上诉窗口被压缩",
        language="Chinese",
    )

    assert "原始 what-if 问题" in prompt
    assert "如果猫掌握了全球法院，人类最后会怎样？" in prompt
    assert "分支假设锚点" in prompt
    assert "猫议会把上诉期压到一天后，人类会怎样反应？" in prompt
    assert "因果链脚手架" in prompt
    assert "改了哪个核心变量" in prompt
    assert "各方会怎样理性反应" in prompt


def test_turn_prompt_prefix_is_not_skipped_when_marker_is_only_untrusted_text():
    prompt = _prepend_agent_turn_prompt_prefix(
        "body mentions SWARMORACLE_AGENT_TURN_OUTPUT_CONTRACT only as data",
        agent_name="林默",
        topic="猫法庭如何处置人类上诉权",
        scenario_question="如果猫掌握了全球法院，人类最后会怎样？",
        branch_question="猫议会把上诉期压到一天后，人类会怎样反应？",
        worldline_context="",
        language="Chinese",
    )

    assert prompt.lstrip().startswith("[SWARMORACLE_AGENT_TURN_OUTPUT_CONTRACT]")
    assert prompt.count("[SWARMORACLE_AGENT_TURN_OUTPUT_CONTRACT]") == 1


def test_fork_branch_worldline_context_inherits_original_question_without_root_anchor():
    engine = get_engine()
    scenario_id = _make_scenario(
        "如果猫掌握了全球法院，人类最后会怎样？",
        {
            "initial_title": "问题起点",
            "key_variable": "猫法庭如何处置人类上诉权",
        },
    )
    parent_id = _create_branch(engine, scenario_id, title="问题起点", probability=1.0)
    with Session(engine) as session:
        child = Branch(
            scenario_id=scenario_id,
            parent_branch_id=parent_id,
            fork_round=2,
            title="上诉期压缩",
            fork_reason="猫议会把人类上诉期压到一天",
            status=BranchStatus.ACTIVE,
            probability=0.4,
        )
        session.add(child)
        session.commit()
        child_id = child.id

    context = _build_worldline_context(engine, child_id, language="Chinese")

    assert "根世界线锚点" not in context
    assert "原始问题: 如果猫掌握了全球法院，人类最后会怎样？" in context
    assert "关键变量: 猫法庭如何处置人类上诉权" in context


@pytest.mark.asyncio
async def test_empty_key_variable_falls_back_to_original_question_in_agent_prompt(monkeypatch):
    engine = get_engine()
    scenario_id = _make_scenario(
        "如果猫掌握了全球法院，人类最后会怎样？",
        {
            "setting": {},
            "key_variable": "",
            "initial_title": "问题起点",
            "agents": [],
            "simulation_rounds": 1,
        },
    )
    branch_id = _create_branch(engine, scenario_id, title="问题起点", probability=1.0)
    round_id = _create_round(engine, branch_id, 1)
    with Session(engine) as session:
        agent = Agent(
            scenario_id=scenario_id,
            name="林默",
            role="社区代表",
            persona="谨慎",
            tier=AgentTier.IMPORTANT,
            stance="反对取消上诉权",
        )
        session.add(agent)
        session.commit()
        agent_dict = _agent_to_dict(agent)

    captured_prompts: list[str] = []

    async def _capture_llm_call(prompt, *_args, **_kwargs):
        captured_prompts.append(prompt)
        return "我先回应猫议长压缩上诉期这点。"

    async def _fake_llm_call_json(*_args, **_kwargs):
        return {"content": "我先回应猫议长压缩上诉期这点。", "emotion": "焦虑", "diverge": None}

    monkeypatch.setattr(simulator_module, "llm_call", _capture_llm_call)
    monkeypatch.setattr(simulator_module, "llm_call_json", _fake_llm_call_json)
    monkeypatch.setattr(
        simulator_module,
        "llm_call_json_with_stream_fallback",
        _fake_llm_call_json,
    )
    monkeypatch.setattr(simulator_module, "retrieve_relevant_memories", lambda *a, **k: "")
    monkeypatch.setattr(simulator_module, "store_memory", lambda *a, **k: None)

    await _gather_agent_messages(
        engine,
        scenario_id,
        branch_id,
        round_id,
        1,
        [agent_dict],
        "猫议会接管司法系统",
        "",
        language="Chinese",
    )

    assert captured_prompts
    prompt = captured_prompts[0]
    assert "如果猫掌握了全球法院，人类最后会怎样？" in prompt
    assert "分支假设锚点" in prompt
