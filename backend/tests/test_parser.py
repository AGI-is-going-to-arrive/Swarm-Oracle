"""Tests for app.services.parser — Stage 1 question parsing."""

from unittest.mock import AsyncMock

import pytest

import app.services.parser as parser_module
from app.services.llm_client import LLMError
from app.services.parser import parse_question


class TestParseQuestion:
    @pytest.mark.asyncio
    async def test_parse_historical(self):
        """Should parse a historical what-if question."""
        result = await parse_question("如果诸葛亮多活十年？", max_agents=10, max_rounds=8)

        assert "setting" in result
        assert "agents" in result
        assert "simulation_rounds" in result
        assert "branch_sensitivity" in result

        # Setting should have required fields
        setting = result["setting"]
        assert "time_period" in setting
        assert "background" in setting

        # Agents should be non-empty
        agents = result["agents"]
        assert len(agents) > 0
        assert len(agents) <= 10  # respect max_agents hint

        # Each agent should have required fields
        for agent in agents:
            assert "name" in agent
            assert "tier" in agent
            assert agent["tier"] in ("CORE", "IMPORTANT", "CROWD")

    @pytest.mark.asyncio
    async def test_parse_modern(self):
        """Should parse a modern what-if question."""
        result = await parse_question("如果苹果明天开源iOS？", max_agents=15)

        agents = result["agents"]
        assert len(agents) > 0

        # Should have at least one CORE agent
        core_agents = [a for a in agents if a.get("tier") == "CORE"]
        assert len(core_agents) >= 1

    @pytest.mark.asyncio
    async def test_rounds_clamped(self):
        """simulation_rounds should be clamped to valid range."""
        result = await parse_question("如果地球停止自转？", max_rounds=10)
        assert 3 <= result["simulation_rounds"] <= 10

    @pytest.mark.asyncio
    async def test_sensitivity_clamped(self):
        """branch_sensitivity should be clamped to [0, 1]."""
        result = await parse_question("如果人类发明了时间机器？")
        assert 0.0 <= result["branch_sensitivity"] <= 1.0

    @pytest.mark.asyncio
    async def test_retries_underfilled_agent_plan_and_tops_up_small_shortfall(self, monkeypatch):
        """Requested agent count should be honored when the first parse under-fills."""
        underfilled = {
            "setting": {"time_period": "未来", "location": "边疆星域", "background": "测试背景"},
            "key_variable": "自治城邦",
            "initial_title": "边疆风暴",
            "agents": [
                {"name": "张启航", "role": "舰队总指挥", "persona": "谨慎果断", "stance": "支持", "tier": "CORE"},
                {"name": "露丝·马丁", "role": "制度顾问", "persona": "重视自治", "stance": "支持", "tier": "IMPORTANT"},
                {"name": "德米特里·霍尔", "role": "监察官", "persona": "坚持合规", "stance": "观望", "tier": "IMPORTANT"},
            ],
            "simulation_rounds": 5,
            "branch_sensitivity": 0.7,
        }

        retry_still_short = {
            **underfilled,
            "agents": list(underfilled["agents"]),
        }

        llm_mock = AsyncMock(side_effect=[underfilled, retry_still_short])
        monkeypatch.setattr(parser_module, "llm_call_json", llm_mock)

        result = await parse_question(
            "如果一支远征舰队在荒芜边疆建立流动自治城邦，会发生什么？",
            max_agents=5,
            target_agents=5,
            max_rounds=8,
        )

        assert llm_mock.await_count == 2
        assert len(result["agents"]) == 5
        assert len({agent["name"] for agent in result["agents"]}) == 5
        assert result["agents"][-1]["tier"] == "IMPORTANT"

    @pytest.mark.asyncio
    async def test_retry_does_not_replace_with_lower_quality_payload(self, monkeypatch):
        """Retry results must not win on agent count alone when structure degrades."""
        first_result = {
            "setting": {"time_period": "未来", "location": "边疆星域", "background": "测试背景"},
            "key_variable": "自治城邦",
            "initial_title": "边疆风暴",
            "agents": [
                {"name": "张启航", "role": "舰队总指挥", "persona": "谨慎果断", "stance": "支持", "tier": "CORE"},
                {"name": "露丝·马丁", "role": "制度顾问", "persona": "重视自治", "stance": "支持", "tier": "IMPORTANT"},
                {"name": "德米特里·霍尔", "role": "监察官", "persona": "坚持合规", "stance": "观望", "tier": "IMPORTANT"},
            ],
            "simulation_rounds": 5,
            "branch_sensitivity": 0.7,
        }
        degraded_retry = {
            **first_result,
            "setting": {"time_period": "未来", "location": "", "background": ""},
            "agents": [
                {"name": "张启航", "role": "舰队总指挥", "persona": "谨慎果断", "stance": "支持", "tier": "CORE"},
                {"name": "张启航", "role": "", "persona": "", "stance": "支持", "tier": "IMPORTANT"},
                {"name": "德米特里·霍尔", "role": "监察官", "persona": "坚持合规", "stance": "观望", "tier": "IMPORTANT"},
                {"name": "路人甲", "role": "", "persona": "", "stance": "", "tier": ""},
            ],
        }

        llm_mock = AsyncMock(side_effect=[first_result, degraded_retry])
        monkeypatch.setattr(parser_module, "llm_call_json", llm_mock)

        result = await parse_question(
            "如果一支远征舰队在荒芜边疆建立流动自治城邦，会发生什么？",
            max_agents=5,
            target_agents=5,
            max_rounds=8,
        )

        assert llm_mock.await_count == 2
        assert result["setting"]["background"] == "测试背景"
        assert result["setting"]["location"] == "边疆星域"
        assert len(result["agents"]) == 5
        assert len({agent["name"] for agent in result["agents"]}) == 5
        assert "路人甲" not in {agent["name"] for agent in result["agents"]}

    @pytest.mark.asyncio
    async def test_falls_back_to_deterministic_parse_when_llm_json_is_invalid(self, monkeypatch):
        """Parser should degrade to a deterministic scenario instead of failing the whole run."""
        llm_mock = AsyncMock(side_effect=LLMError("Invalid JSON from LLM after recovery attempts"))
        monkeypatch.setattr(parser_module, "llm_call_json", llm_mock)

        result = await parse_question(
            "如果一个沿海城市突然由算法议会接管，会发生什么？",
            max_agents=5,
            target_agents=5,
            max_rounds=8,
        )

        assert llm_mock.await_count == 1
        assert result["initial_title"]
        assert result["setting"]["background"]
        assert len(result["agents"]) == 5
        assert all("name" in agent for agent in result["agents"])
        assert 3 <= result["simulation_rounds"] <= 8
        assert 0.0 <= result["branch_sensitivity"] <= 1.0

    @pytest.mark.asyncio
    async def test_fallback_rounds_use_explicit_default_rounds(self, monkeypatch):
        """Fallback parse should honor caller-provided default rounds instead of hardcoding 10."""
        llm_mock = AsyncMock(side_effect=LLMError("Invalid JSON from LLM after recovery attempts"))
        monkeypatch.setattr(parser_module, "llm_call_json", llm_mock)

        result = await parse_question(
            "如果一个港口城市突然改由自治委员会接管，会发生什么？",
            max_agents=5,
            target_agents=5,
            default_rounds=6,
            max_rounds=12,
        )

        assert llm_mock.await_count == 1
        assert result["simulation_rounds"] == 6
