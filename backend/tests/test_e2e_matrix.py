"""E2E test matrix — real GPT 5.2 API calls across multiple configurations.

Runs actual LLM calls at select (agents, rounds) points to validate
the synthetic matrix findings with real token counts.

Matrix (trimmed for fast CI):
  3 agents × 2 rounds  (small baseline)
  5 agents × 3 rounds  (medium)
  10 agents × 3 rounds (larger, cross-validates with synthetic matrix)
  Total API calls: ~78 calls (2 modes per config)
  Estimated time: ~2-3 min with concurrency=8

Run:  .venv/bin/python -m pytest tests/test_e2e_matrix.py -v -s
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field

import httpx
import pytest

from app.config import settings
from app.services.blackboard import Blackboard
from app.services.llm_client import _resolve_llm_api_url
from app.services.memory import (
    build_agent_context,
    format_briefing_for_context,
    format_messages_for_context,
)

LLM_API_URL = _resolve_llm_api_url()
CONCURRENCY = 8
RETRIABLE_STATUS_CODES = {429, 500, 502, 503, 504}
REQUEST_RETRY_ATTEMPTS = 3

SETTING = "三国末期，天下三分。曹魏、蜀汉、东吴在军事、外交、经济等领域展开全面博弈。"
TOPIC = "如果诸葛亮北伐成功占领长安，三国格局将如何改变？"

AGENT_PROMPT = """你是{name}，{role}。性格：{persona}。
当前情绪: {emotion}
背景: {setting}
话题: {topic}

{context_section}

请以{name}的身份发言。输出严格 JSON:
{{"content": "你的发言(50-80字)", "emotion": "发言后情绪", "diverge": null}}"""

# Agent pool — enough for 20 agents
_AGENT_POOL = [
    {"name": "曹操", "role": "魏国丞相", "persona": "雄才大略，多疑善变", "emotion": "冷静", "tier": "CORE"},  # noqa: E501
    {"name": "刘备", "role": "蜀汉之主", "persona": "仁德宽厚，善用贤才", "emotion": "忧虑", "tier": "CORE"},  # noqa: E501
    {"name": "孙权", "role": "东吴大帝", "persona": "审时度势，擅长平衡", "emotion": "冷静", "tier": "IMPORTANT"},  # noqa: E501
    {"name": "诸葛亮", "role": "蜀汉丞相", "persona": "谨慎多谋，鞠躬尽瘁", "emotion": "坚定", "tier": "CORE"},  # noqa: E501
    {"name": "司马懿", "role": "魏国重臣", "persona": "城府极深，善于忍耐", "emotion": "冷静", "tier": "IMPORTANT"},  # noqa: E501
    {"name": "周瑜", "role": "东吴大都督", "persona": "英姿勃发，心高气傲", "emotion": "激动", "tier": "IMPORTANT"},  # noqa: E501
    {"name": "关羽", "role": "蜀汉大将", "persona": "义薄云天，骄傲自负", "emotion": "坚定", "tier": "IMPORTANT"},  # noqa: E501
    {"name": "荀彧", "role": "魏国谋士", "persona": "王佐之才，忠汉心切", "emotion": "忧虑", "tier": "MOB"},  # noqa: E501
    {"name": "鲁肃", "role": "东吴谋士", "persona": "淳厚务实，主张联蜀", "emotion": "冷静", "tier": "MOB"},  # noqa: E501
    {"name": "姜维", "role": "蜀汉将领", "persona": "继承北伐遗志，英勇善战", "emotion": "坚定", "tier": "MOB"},  # noqa: E501
    {"name": "赵云", "role": "蜀汉将军", "persona": "忠勇双全，冷静果敢", "emotion": "冷静", "tier": "CORE"},  # noqa: E501
    {"name": "张飞", "role": "蜀汉猛将", "persona": "粗中有细，暴烈直率", "emotion": "激动", "tier": "IMPORTANT"},  # noqa: E501
    {"name": "陆逊", "role": "东吴都督", "persona": "少年英才，沉着冷静", "emotion": "冷静", "tier": "IMPORTANT"},  # noqa: E501
    {"name": "贾诩", "role": "魏国谋士", "persona": "明哲保身，算无遗策", "emotion": "冷静", "tier": "MOB"},  # noqa: E501
    {"name": "黄忠", "role": "蜀汉老将", "persona": "老当益壮，不甘示弱", "emotion": "激动", "tier": "MOB"},  # noqa: E501
    {"name": "马超", "role": "蜀汉将军", "persona": "西凉勇士，桀骜不驯", "emotion": "坚定", "tier": "MOB"},  # noqa: E501
    {"name": "甘宁", "role": "东吴将领", "persona": "豪放不羁，勇猛善战", "emotion": "激动", "tier": "MOB"},  # noqa: E501
    {"name": "徐庶", "role": "流浪谋士", "persona": "才华横溢，身在曹营心在汉", "emotion": "忧虑", "tier": "MOB"},  # noqa: E501
    {"name": "庞统", "role": "蜀汉谋士", "persona": "凤雏之才，不拘小节", "emotion": "冷静", "tier": "MOB"},  # noqa: E501
    {"name": "法正", "role": "蜀汉谋士", "persona": "睚眦必报，善出奇谋", "emotion": "冷静", "tier": "MOB"},  # noqa: E501
]


@dataclass
class CallMetrics:
    agent: str
    round_num: int
    mode: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: float = 0
    context_bytes: int = 0
    content: str = ""


@dataclass
class ConfigResult:
    num_agents: int
    num_rounds: int
    mode: str
    calls: list[CallMetrics] = field(default_factory=list)

    @property
    def total_prompt(self) -> int:
        return sum(c.prompt_tokens for c in self.calls)

    @property
    def total_completion(self) -> int:
        return sum(c.completion_tokens for c in self.calls)

    @property
    def avg_prompt_per_round(self) -> float:
        if not self.num_rounds:
            return 0
        return self.total_prompt / self.num_rounds

    @property
    def total_context_bytes(self) -> int:
        return sum(c.context_bytes for c in self.calls)

    @property
    def total_latency_ms(self) -> float:
        return sum(c.latency_ms for c in self.calls)

    def round_prompt(self, r: int) -> int:
        return sum(c.prompt_tokens for c in self.calls if c.round_num == r)


async def _call_llm(
    prompt: str, agent_name: str, round_num: int, mode: str,
    semaphore: asyncio.Semaphore,
) -> CallMetrics:
    """Call LLM with semaphore for concurrency control."""
    m = CallMetrics(agent=agent_name, round_num=round_num, mode=mode)
    m.context_bytes = len(prompt.encode("utf-8"))

    async with semaphore:
        start = time.perf_counter()
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = None
            for attempt in range(REQUEST_RETRY_ATTEMPTS):
                resp = await client.post(
                    LLM_API_URL,
                    json={
                        "model": settings.LLM_MODEL_NAME,
                        "messages": [{"role": "user", "content": prompt}],
                        "reasoning_effort": "low",
                    },
                    headers={
                        "Authorization": f"Bearer {settings.LLM_API_KEY}",
                        "Content-Type": "application/json",
                    },
                )
                if (
                    resp.status_code not in RETRIABLE_STATUS_CODES
                    or attempt + 1 >= REQUEST_RETRY_ATTEMPTS
                ):
                    resp.raise_for_status()
                    break
                await asyncio.sleep(0.5 * (attempt + 1))
        m.latency_ms = (time.perf_counter() - start) * 1000

    assert resp is not None
    data = resp.json()
    usage = data.get("usage", {})
    m.prompt_tokens = usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0)
    m.completion_tokens = usage.get("completion_tokens", 0) or usage.get("output_tokens", 0)

    try:
        text = (data["choices"][0]["message"]["content"] or "").strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(lines[1:-1] if lines[-1].strip().startswith("```") else lines[1:])
        result = json.loads(text)
        m.content = result.get("content", "")
    except Exception:
        m.content = (data.get("choices", [{}])[0].get("message", {}).get("content") or "")[:60]

    return m


def _build_prompt(agent: dict, ctx: str) -> str:
    return AGENT_PROMPT.format(
        name=agent["name"], role=agent["role"],
        persona=agent["persona"], emotion=agent["emotion"],
        setting=SETTING, topic=TOPIC, context_section=ctx,
    )


async def _run_config(
    agents: list[dict], num_rounds: int, sem: asyncio.Semaphore,
) -> tuple[ConfigResult, ConfigResult]:
    """Run both RAW and BB modes for a given (agents, rounds) config."""
    n = len(agents)

    # ── RAW mode ──
    raw = ConfigResult(num_agents=n, num_rounds=num_rounds, mode="raw")
    messages: list[dict] = []

    for rnd in range(1, num_rounds + 1):
        tasks = []
        for agent in agents:
            recent = format_messages_for_context(messages, tier=agent["tier"])
            ctx = build_agent_context(
                agent=agent, setting_background=SETTING,
                current_topic=TOPIC, recent_messages=recent,
                tier=agent["tier"],
            )
            prompt = _build_prompt(agent, ctx)
            tasks.append((agent, _call_llm(prompt, agent["name"], rnd, "raw", sem)))

        results = await asyncio.gather(*[t[1] for t in tasks])
        for (agent, _), m in zip(tasks, results):
            raw.calls.append(m)
            messages.append({
                "agent_name": agent["name"],
                "content": m.content,
                "emotion": agent["emotion"],
                "round_number": rnd,
            })

    # ── BB mode ──
    bb_res = ConfigResult(num_agents=n, num_rounds=num_rounds, mode="bb")
    bb = Blackboard()

    for rnd in range(1, num_rounds + 1):
        briefing = bb.get_shared_briefing()
        shared_text = format_briefing_for_context(briefing)

        tasks = []
        for agent in agents:
            if shared_text and shared_text != "(尚无共享信息)":
                ctx = build_agent_context(
                    agent=agent, setting_background=SETTING,
                    current_topic=TOPIC, recent_messages="",
                    tier=agent["tier"], shared_briefing=shared_text,
                )
            else:
                ctx = build_agent_context(
                    agent=agent, setting_background=SETTING,
                    current_topic=TOPIC,
                    recent_messages="(第一轮，尚无历史消息)",
                    tier=agent["tier"],
                )
            prompt = _build_prompt(agent, ctx)
            tasks.append((agent, _call_llm(prompt, agent["name"], rnd, "bb", sem)))

        results = await asyncio.gather(*[t[1] for t in tasks])
        for (agent, _), m in zip(tasks, results):
            bb_res.calls.append(m)
            bb.post(agent["name"], m.content, agent["emotion"])

    return raw, bb_res


# ══════════════════════════════════════════════════════════════

# Trimmed matrix configs for fast CI:
MATRIX_CONFIGS = [
    (3, 2),    # small baseline
    (5, 3),    # medium
    (10, 3),   # larger cross-validation point
]


class TestE2EMatrix:
    """Real API test matrix across multiple configurations."""

    @pytest.fixture(autouse=True)
    def check_api(self):
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(
                    LLM_API_URL,
                    json={
                        "model": settings.LLM_MODEL_NAME,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 1,
                    },
                    headers={
                        "Authorization": f"Bearer {settings.LLM_API_KEY}",
                        "Content-Type": "application/json",
                    },
                )
            if response.status_code >= 500:
                pytest.skip(f"LLM API unhealthy: HTTP {response.status_code}")
        except Exception as e:
            pytest.skip(f"API check failed: {e}")

    @pytest.mark.asyncio
    async def test_full_matrix(self):
        """Run all matrix configs with real API calls."""
        effective_concurrency = (
            min(CONCURRENCY, settings.LLM_CONCURRENCY)
            if settings.LLM_CONCURRENCY > 0
            else CONCURRENCY
        )
        sem = asyncio.Semaphore(max(1, effective_concurrency))
        all_results: list[tuple[ConfigResult, ConfigResult]] = []

        total_calls = sum(a * r * 2 for a, r in MATRIX_CONFIGS)
        print(f"\n{'=' * 90}")
        print(f"  E2E TEST MATRIX — {len(MATRIX_CONFIGS)} configs, "
              f"~{total_calls} API calls, concurrency={max(1, effective_concurrency)}")
        print(f"{'=' * 90}")

        for ac, rc in MATRIX_CONFIGS:
            agents = _AGENT_POOL[:ac]
            api_calls = ac * rc * 2
            print(f"\n  ── {ac} agents × {rc} rounds ({api_calls} API calls) ──")

            t0 = time.perf_counter()
            raw, bb = await _run_config(agents, rc, sem)
            wall_s = time.perf_counter() - t0
            all_results.append((raw, bb))

            # Per-round detail
            for r in range(1, rc + 1):
                rp = raw.round_prompt(r)
                bp = bb.round_prompt(r)
                delta = ((bp - rp) / rp * 100) if rp else 0
                print(f"    R{r}: RAW={rp:>7,}  BB={bp:>7,}  ({delta:>+6.1f}%)")
            print(f"    Wall: {wall_s:.1f}s  |  "
                  f"RAW total={raw.total_prompt:,}  BB total={bb.total_prompt:,}")

        # ════════════════════════════════════════════
        #  Summary tables
        # ════════════════════════════════════════════
        print(f"\n{'=' * 90}")
        print("  MATRIX SUMMARY")
        print(f"{'=' * 90}")

        # Table 1: Overview
        print(f"\n  {'Config':<12} {'Calls':>6} {'RAW prompt':>12} {'BB prompt':>12} "
              f"{'BB/RAW':>8} {'RAW $/M':>8} {'BB $/M':>8}")
        print(f"  {'-' * 12} {'-' * 6} {'-' * 12} {'-' * 12} "
              f"{'-' * 8} {'-' * 8} {'-' * 8}")

        for raw, bb in all_results:
            calls = raw.num_agents * raw.num_rounds
            ratio = bb.total_prompt / raw.total_prompt if raw.total_prompt else 0
            raw_cost = raw.total_prompt / 1e6 * 5.0  # $5/M tokens
            bb_cost = bb.total_prompt / 1e6 * 5.0
            print(f"  {raw.num_agents:>2}A×{raw.num_rounds:<2}R     {calls:>6} "
                  f"{raw.total_prompt:>12,} {bb.total_prompt:>12,} "
                  f"{ratio:>7.2f}× ${raw_cost:>6.4f} ${bb_cost:>6.4f}")

        # Table 2: Agent sweep analysis
        print("\n  ── AGENT SWEEP (fixed 3 rounds) ──")
        print(f"  {'Agents':>8} {'RAW/round':>12} {'BB/round':>12} "
              f"{'BB/RAW':>8} {'BB growth':>12}")

        prev_bb = 0
        for raw, bb in all_results:
            if raw.num_rounds != 3:
                continue
            ravg = raw.avg_prompt_per_round
            bavg = bb.avg_prompt_per_round
            ratio = bavg / ravg if ravg else 0
            growth = f"+{bavg - prev_bb:,.0f}" if prev_bb else "—"
            prev_bb = bavg
            print(f"  {raw.num_agents:>8} {ravg:>12,.0f} {bavg:>12,.0f} "
                  f"{ratio:>7.2f}× {growth:>12}")

        # Table 3: Round sweep analysis
        print("\n  ── ROUND SWEEP (fixed 10 agents) ──")
        print(f"  {'Rounds':>8} {'RAW total':>12} {'BB total':>12} "
              f"{'BB/RAW':>8} {'RAW/call':>10} {'BB/call':>10}")

        for raw, bb in all_results:
            if raw.num_agents != 10:
                continue
            calls = raw.num_agents * raw.num_rounds
            ratio = bb.total_prompt / raw.total_prompt if raw.total_prompt else 0
            raw_per = raw.total_prompt / calls
            bb_per = bb.total_prompt / calls
            print(f"  {raw.num_rounds:>8} {raw.total_prompt:>12,} {bb.total_prompt:>12,} "
                  f"{ratio:>7.2f}× {raw_per:>10,.0f} {bb_per:>10,.0f}")

        # Table 4: Bytes/token ratio validation
        print("\n  ── BYTES/TOKEN RATIO ──")
        print(f"  {'Config':<12} {'RAW b/t':>10} {'BB b/t':>10}")
        for raw, bb in all_results:
            raw_ratio = raw.total_context_bytes / raw.total_prompt if raw.total_prompt else 0
            bb_ratio = bb.total_context_bytes / bb.total_prompt if bb.total_prompt else 0
            print(f"  {raw.num_agents:>2}A×{raw.num_rounds:<2}R      {raw_ratio:>10.2f} {bb_ratio:>10.2f}")  # noqa: E501

        print(f"\n{'=' * 90}")
        print(f"  All {len(MATRIX_CONFIGS)} configs completed successfully")
        print(f"  Total API calls: {sum(r.num_agents * r.num_rounds * 2 for r, _ in all_results)}")
        print(f"{'=' * 90}")

        # Assertions
        for raw, bb in all_results:
            assert len(raw.calls) == raw.num_agents * raw.num_rounds
            assert len(bb.calls) == bb.num_agents * bb.num_rounds
