"""End-to-end Blackboard benchmark — calls real GPT 5.2 API.

Compares RAW mode (tier-filtered DB messages) vs BLACKBOARD mode
across 5 agents × 3 rounds with concurrent execution per round.

Run with:
    .venv/bin/python -m pytest tests/test_blackboard_e2e.py -v -s
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import time
from dataclasses import dataclass, field

import httpx
import pytest

from app.config import settings
from app.services.blackboard import Blackboard
from app.services.memory import (
    build_agent_context,
    format_briefing_for_context,
    format_messages_for_context,
)

logger = logging.getLogger(__name__)

# Use 8318 endpoint directly (conftest uses the same default for unit tests)
LLM_API_URL = "http://127.0.0.1:8318/v1/chat/completions"
CONCURRENCY = 5  # match settings.LLM_CONCURRENCY

# ── Scenario ─────────────────────────────────────────────

SETTING = "三国末期，天下三分。曹魏、蜀汉、东吴在军事、外交、经济等领域展开全面博弈。"
TOPIC = "如果诸葛亮北伐成功占领长安，三国格局将如何改变？"

AGENTS = [
    {"name": "曹操", "role": "魏国丞相", "persona": "雄才大略，多疑善变", "emotion": "冷静", "tier": "CORE"},
    {"name": "刘备", "role": "蜀汉之主", "persona": "仁德宽厚，善用贤才", "emotion": "忧虑", "tier": "CORE"},
    {"name": "孙权", "role": "东吴大帝", "persona": "审时度势，擅长平衡", "emotion": "冷静", "tier": "IMPORTANT"},
    {"name": "荀彧", "role": "魏国谋士", "persona": "王佐之才，忠汉心切", "emotion": "忧虑", "tier": "MOB"},
    {"name": "姜维", "role": "蜀汉将领", "persona": "继承北伐遗志，英勇善战", "emotion": "坚定", "tier": "MOB"},
]

AGENT_PROMPT = """你是{name}，{role}。性格：{persona}。
当前情绪: {emotion}
背景: {setting}
话题: {topic}

{context_section}

请以{name}的身份发言，回应当前局势。输出严格 JSON:
{{"content": "你的发言(50-80字)", "emotion": "发言后情绪", "diverge": null}}"""


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
class BenchmarkResult:
    mode: str
    calls: list[CallMetrics] = field(default_factory=list)

    @property
    def total_prompt(self) -> int:
        return sum(c.prompt_tokens for c in self.calls)

    @property
    def total_completion(self) -> int:
        return sum(c.completion_tokens for c in self.calls)

    @property
    def total_tokens(self) -> int:
        return self.total_prompt + self.total_completion

    @property
    def total_context_bytes(self) -> int:
        return sum(c.context_bytes for c in self.calls)

    @property
    def total_latency_ms(self) -> float:
        return sum(c.latency_ms for c in self.calls)

    def round_prompt(self, r: int) -> int:
        return sum(c.prompt_tokens for c in self.calls if c.round_num == r)


async def _call_llm(prompt: str, agent: str, round_num: int, mode: str) -> CallMetrics:
    """Call LLM and capture usage metrics."""
    m = CallMetrics(agent=agent, round_num=round_num, mode=mode)
    m.context_bytes = len(prompt.encode("utf-8"))

    payload = {
        "model": settings.LLM_MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "reasoning_effort": "low",
    }

    start = time.perf_counter()
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            LLM_API_URL,
            json=payload,
            headers={
                "Authorization": f"Bearer {settings.LLM_API_KEY}",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
    m.latency_ms = (time.perf_counter() - start) * 1000

    data = resp.json()
    usage = data.get("usage", {})
    m.prompt_tokens = usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0)
    m.completion_tokens = usage.get("completion_tokens", 0) or usage.get("output_tokens", 0)

    try:
        text = data["choices"][0]["message"]["content"].strip()
        if text.startswith("```"):
            lines = text.split("\n")
            if lines[-1].strip().startswith("```"):
                lines = lines[1:-1]
            else:
                lines = lines[1:]
            text = "\n".join(lines)
        result = json.loads(text)
        m.content = result.get("content", "")
    except Exception:
        m.content = "(parse error)"

    return m


def _build_prompt(agent: dict, ctx: str) -> str:
    return AGENT_PROMPT.format(
        name=agent["name"], role=agent["role"],
        persona=agent["persona"], emotion=agent["emotion"],
        setting=SETTING, topic=TOPIC, context_section=ctx,
    )


# ── Test ─────────────────────────────────────────────────

NUM_ROUNDS = 3


class TestBlackboardE2E:
    """5 agents × 3 rounds, concurrent within each round."""

    @pytest.fixture(autouse=True)
    def check_api(self):
        try:
            r = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                 "--connect-timeout", "5", "-m", "10", LLM_API_URL],
                capture_output=True, text=True, timeout=15,
            )
            if r.stdout.strip() == "000":
                pytest.skip("LLM API not reachable")
        except Exception as e:
            pytest.skip(f"API check failed: {e}")

    @pytest.mark.asyncio
    async def test_scaled_benchmark(self):
        """5 agents × 3 rounds, concurrent, RAW vs BB."""
        semaphore = asyncio.Semaphore(CONCURRENCY)

        # ══════════════════════════════════════════════
        #  Phase A: RAW mode
        # ══════════════════════════════════════════════
        raw = BenchmarkResult(mode="raw")
        raw_messages: list[dict] = []

        print("\n" + "=" * 70)
        print("  RAW MODE — 5 agents × 3 rounds (concurrent)")
        print("=" * 70)

        for rnd in range(1, NUM_ROUNDS + 1):
            async def _raw_agent(agent):
                async with semaphore:
                    recent_text = format_messages_for_context(
                        raw_messages, tier=agent["tier"]
                    )
                    ctx = build_agent_context(
                        agent=agent, setting_background=SETTING,
                        current_topic=TOPIC, recent_messages=recent_text,
                        tier=agent["tier"],
                    )
                    return agent, await _call_llm(
                        _build_prompt(agent, ctx), agent["name"], rnd, "raw"
                    )

            t0 = time.perf_counter()
            results = await asyncio.gather(*[_raw_agent(a) for a in AGENTS])
            wall = (time.perf_counter() - t0) * 1000

            round_tokens = 0
            for agent, m in results:
                raw.calls.append(m)
                round_tokens += m.prompt_tokens
                raw_messages.append({
                    "agent_name": agent["name"],
                    "content": m.content,
                    "emotion": agent["emotion"],
                    "round_number": rnd,
                })

            print(f"  R{rnd}: prompt_tokens={round_tokens:,}  "
                  f"wall={wall:.0f}ms  msgs_accumulated={len(raw_messages)}")

        # ══════════════════════════════════════════════
        #  Phase B: BLACKBOARD mode
        # ══════════════════════════════════════════════
        bb_res = BenchmarkResult(mode="bb")
        bb = Blackboard()

        print("\n" + "=" * 70)
        print("  BLACKBOARD MODE — 5 agents × 3 rounds (concurrent)")
        print("=" * 70)

        for rnd in range(1, NUM_ROUNDS + 1):
            briefing = bb.get_shared_briefing()
            shared_text = format_briefing_for_context(briefing)

            async def _bb_agent(agent, _shared=shared_text):
                async with semaphore:
                    if _shared and _shared != "(尚无共享信息)":
                        ctx = build_agent_context(
                            agent=agent, setting_background=SETTING,
                            current_topic=TOPIC, recent_messages="",
                            tier=agent["tier"], shared_briefing=_shared,
                        )
                    else:
                        ctx = build_agent_context(
                            agent=agent, setting_background=SETTING,
                            current_topic=TOPIC,
                            recent_messages="(第一轮，尚无历史消息)",
                            tier=agent["tier"],
                        )
                    return agent, await _call_llm(
                        _build_prompt(agent, ctx), agent["name"], rnd, "bb"
                    )

            t0 = time.perf_counter()
            results = await asyncio.gather(*[_bb_agent(a) for a in AGENTS])
            wall = (time.perf_counter() - t0) * 1000

            round_tokens = 0
            for agent, m in results:
                bb_res.calls.append(m)
                round_tokens += m.prompt_tokens
                bb.post(agent["name"], m.content, agent["emotion"])

            print(f"  R{rnd}: prompt_tokens={round_tokens:,}  "
                  f"wall={wall:.0f}ms  bb_activity_len={len(bb.activity_log)}")

        # ══════════════════════════════════════════════
        #  Results
        # ══════════════════════════════════════════════
        print("\n" + "=" * 70)
        print("  BENCHMARK RESULTS  (5 agents × 3 rounds)")
        print("=" * 70)

        def _delta(a, b):
            return ((b - a) / a * 100) if a else 0

        print(f"\n  {'Metric':<30} {'RAW':>10} {'BB':>10} {'Δ':>10}")
        print(f"  {'-'*30} {'-'*10} {'-'*10} {'-'*10}")

        rp, bp = raw.total_prompt, bb_res.total_prompt
        print(f"  {'Total prompt tokens':<30} {rp:>10,} {bp:>10,} {_delta(rp,bp):>+9.1f}%")

        rc, bc = raw.total_completion, bb_res.total_completion
        print(f"  {'Total completion tokens':<30} {rc:>10,} {bc:>10,} {_delta(rc,bc):>+9.1f}%")

        rt, bt = raw.total_tokens, bb_res.total_tokens
        print(f"  {'Total tokens':<30} {rt:>10,} {bt:>10,} {_delta(rt,bt):>+9.1f}%")

        rcb, bcb = raw.total_context_bytes, bb_res.total_context_bytes
        print(f"  {'Total context bytes':<30} {rcb:>10,} {bcb:>10,} {_delta(rcb,bcb):>+9.1f}%")

        rl, bl = raw.total_latency_ms, bb_res.total_latency_ms
        print(f"  {'Total latency (sum)':<30} {rl:>10,.0f} {bl:>10,.0f} {_delta(rl,bl):>+9.1f}%")

        print(f"\n  Per-round prompt tokens:")
        for r in range(1, NUM_ROUNDS + 1):
            rr = raw.round_prompt(r)
            br = bb_res.round_prompt(r)
            d = _delta(rr, br)
            marker = " ✅" if d < 0 else " ⚠️" if d > 20 else ""
            print(f"    R{r}: RAW={rr:>7,} BB={br:>7,} ({d:>+6.1f}%){marker}")

        # Growth rate analysis
        print(f"\n  RAW growth: R1→R8 = {raw.round_prompt(1):,} → {raw.round_prompt(NUM_ROUNDS):,} "
              f"(×{raw.round_prompt(NUM_ROUNDS)/max(raw.round_prompt(1),1):.1f})")
        print(f"  BB  growth: R1→R8 = {bb_res.round_prompt(1):,} → {bb_res.round_prompt(NUM_ROUNDS):,} "
              f"(×{bb_res.round_prompt(NUM_ROUNDS)/max(bb_res.round_prompt(1),1):.1f})")

        print()
        assert len(raw.calls) == len(AGENTS) * NUM_ROUNDS
        assert len(bb_res.calls) == len(AGENTS) * NUM_ROUNDS
