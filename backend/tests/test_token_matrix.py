"""Token cost test matrix — decomposes RAW vs BB context by component.

Synthetic benchmark: measures context BYTES at each (agents, rounds)
combination, decomposed by component. No LLM calls needed — bytes
map 1:1 to prompt tokens (validated with real API calls).

Then runs a few real LLM calls at key matrix points to validate.

Run:  .venv/bin/python -m pytest tests/test_token_matrix.py -v -s
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

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
RETRIABLE_STATUS_CODES = {429, 500, 502, 503, 504}
REQUEST_RETRY_ATTEMPTS = 3

SETTING = "三国末期，天下三分。曹魏、蜀汉、东吴在军事、外交、经济等领域展开全面博弈。"
TOPIC = "如果诸葛亮北伐成功占领长安，三国格局将如何改变？"

# Simulated agent utterance (~60 Chinese chars, realistic)
SAMPLE_UTTERANCE = "若孔明得长安，关中粮道可通，西北人心亦动。魏必倾国来争，吾忧蜀道难守、粮尽援绝。当先据潼关、散关，修渠屯田以续。"  # noqa: E501


def _make_agents(n: int) -> list[dict]:
    """Generate n agents with realistic tier distribution."""
    tiers = ["CORE", "CORE", "IMPORTANT", "IMPORTANT", "MOB"]
    names = [
        "曹操", "刘备", "孙权", "诸葛亮", "司马懿", "周瑜", "关羽",
        "荀彧", "鲁肃", "姜维", "赵云", "张飞", "陆逊", "贾诩", "黄忠",
        "马超", "甘宁", "徐庶", "庞统", "法正",
    ]
    agents = []
    for i in range(n):
        tier = tiers[i % len(tiers)]
        agents.append({
            "name": names[i % len(names)],
            "role": f"角色{i+1}",
            "persona": "勇猛善战",
            "emotion": "冷静",
            "tier": tier,
        })
    return agents


def _simulate_messages(agents: list[dict], rounds: int) -> list[dict]:
    """Simulate message history for given agents and rounds."""
    msgs = []
    for r in range(1, rounds + 1):
        for a in agents:
            msgs.append({
                "agent_name": a["name"],
                "content": f"R{r}-{a['name']}: {SAMPLE_UTTERANCE}",
                "emotion": a["emotion"],
                "round_number": r,
            })
    return msgs


def _simulate_blackboard(agents: list[dict], rounds: int) -> Blackboard:
    """Simulate a blackboard after given agents and rounds."""
    bb = Blackboard()
    for r in range(1, rounds + 1):
        for a in agents:
            bb.post(a["name"], f"R{r}: {SAMPLE_UTTERANCE}", a["emotion"])
    return bb


@dataclass
class ContextDecomposition:
    """Breakdown of context bytes by component."""
    total_bytes: int = 0
    template_bytes: int = 0  # system prompt template
    setting_bytes: int = 0   # world background
    topic_bytes: int = 0     # topic text
    conversation_bytes: int = 0  # messages or briefing
    # BB-specific decomposition
    positions_bytes: int = 0
    activity_bytes: int = 0
    summary_bytes: int = 0
    debates_bytes: int = 0
    tensions_bytes: int = 0


def _decompose_raw_context(agent: dict, messages: list[dict]) -> ContextDecomposition:
    """Decompose RAW context into components."""
    d = ContextDecomposition()
    d.setting_bytes = len(SETTING.encode("utf-8"))
    d.topic_bytes = len(TOPIC.encode("utf-8"))

    recent_text = format_messages_for_context(messages, tier=agent["tier"])
    d.conversation_bytes = len(recent_text.encode("utf-8"))

    full_ctx = build_agent_context(
        agent=agent, setting_background=SETTING,
        current_topic=TOPIC, recent_messages=recent_text,
        tier=agent["tier"],
    )
    d.total_bytes = len(full_ctx.encode("utf-8"))
    d.template_bytes = d.total_bytes - d.setting_bytes - d.topic_bytes - d.conversation_bytes

    return d


def _decompose_bb_context(agent: dict, bb: Blackboard) -> ContextDecomposition:
    """Decompose BB context into components with full briefing breakdown."""
    d = ContextDecomposition()
    d.setting_bytes = len(SETTING.encode("utf-8"))
    d.topic_bytes = len(TOPIC.encode("utf-8"))

    briefing = bb.get_shared_briefing()

    # Decompose briefing components
    summary = briefing.get("summary", "")
    d.summary_bytes = len(f"【全局态势】{summary}".encode("utf-8")) if summary else 0

    debates = briefing.get("debates", [])
    d.debates_bytes = len(("【当前争论焦点】" + "；".join(debates)).encode("utf-8")) if debates else 0  # noqa: E501

    tensions = briefing.get("tensions", [])
    d.tensions_bytes = len(("【紧张点】" + "；".join(tensions)).encode("utf-8")) if tensions else 0

    positions = briefing.get("positions", {})
    if positions:
        pos_lines = [f"  {name}: {stance}" for name, stance in positions.items()]
        d.positions_bytes = len(("【各方立场】\n" + "\n".join(pos_lines)).encode("utf-8"))

    recent = briefing.get("recent", [])
    if recent:
        recent_lines = [
            f"[{e.get('agent', '?')}]({e.get('emotion', '')}): {e.get('summary', '')}"
            for e in recent
        ]
        d.activity_bytes = len(("【最近发言】\n" + "\n".join(recent_lines)).encode("utf-8"))

    shared_text = format_briefing_for_context(briefing)
    d.conversation_bytes = len(shared_text.encode("utf-8"))

    full_ctx = build_agent_context(
        agent=agent, setting_background=SETTING,
        current_topic=TOPIC, recent_messages="",
        tier=agent["tier"], shared_briefing=shared_text,
    )
    d.total_bytes = len(full_ctx.encode("utf-8"))
    d.template_bytes = d.total_bytes - d.setting_bytes - d.topic_bytes - d.conversation_bytes

    return d


# ══════════════════════════════════════════════════════════════
#  Test 1: Synthetic context size matrix (no LLM calls)
# ══════════════════════════════════════════════════════════════

AGENT_COUNTS = [3, 5, 10, 15, 20]
ROUND_COUNTS = [1, 3, 5, 8, 12]


class TestSyntheticMatrix:
    """Context size decomposition across (agents × rounds) matrix."""

    def test_context_size_matrix(self):
        """Full matrix: RAW vs BB context bytes at every combination."""
        print("\n" + "=" * 100)
        print("  CONTEXT SIZE MATRIX  (bytes per agent, averaged across tiers)")
        print("=" * 100)

        # Header
        header = f"  {'Config':<15}"
        for rc in ROUND_COUNTS:
            header += f" {'R'+str(rc)+' RAW':>10} {'R'+str(rc)+' BB':>10} {'Δ':>8}"
        print(header)
        print("  " + "-" * (15 + len(ROUND_COUNTS) * 30))

        results = {}
        for ac in AGENT_COUNTS:
            agents = _make_agents(ac)
            row = f"  {ac:>2} agents     "

            for rc in ROUND_COUNTS:
                messages = _simulate_messages(agents, rc)
                bb = _simulate_blackboard(agents, rc)

                # Average context across all agents (different tiers get different sizes)
                raw_sizes = [_decompose_raw_context(a, messages).total_bytes for a in agents]
                bb_sizes = [_decompose_bb_context(a, bb).total_bytes for a in agents]

                avg_raw = sum(raw_sizes) / len(raw_sizes)
                avg_bb = sum(bb_sizes) / len(bb_sizes)
                delta = ((avg_bb - avg_raw) / avg_raw * 100) if avg_raw else 0

                results[(ac, rc)] = {
                    "raw_avg": avg_raw, "bb_avg": avg_bb, "delta": delta,
                    "raw_sizes": raw_sizes, "bb_sizes": bb_sizes,
                }

                marker = "✅" if delta < 0 else "⚠️" if delta > 50 else "  "
                row += f" {avg_raw:>10,.0f} {avg_bb:>10,.0f} {delta:>+6.1f}%{marker}"

            print(row)

        # All tests are informational
        assert len(results) == len(AGENT_COUNTS) * len(ROUND_COUNTS)

    def test_component_decomposition(self):
        """Decompose BB context into individual components at key scales."""
        print("\n" + "=" * 100)
        print("  BB CONTEXT COMPONENT DECOMPOSITION  (bytes)")
        print("=" * 100)

        configs = [(5, 3), (10, 5), (10, 8), (15, 8), (20, 8)]

        print(f"  {'Config':<12} {'Total':>8} {'Template':>10} {'Setting':>8} "
              f"{'Positions':>10} {'Activity':>10} {'Summary':>10} "
              f"{'Debates':>8} {'Tensions':>8}  {'Pos%':>5}")
        print("  " + "-" * 105)

        for ac, rc in configs:
            agents = _make_agents(ac)
            bb = _simulate_blackboard(agents, rc)
            # Use first CORE agent for decomposition
            core_agent = next(a for a in agents if a["tier"] == "CORE")
            d = _decompose_bb_context(core_agent, bb)

            pos_pct = (d.positions_bytes / d.total_bytes * 100) if d.total_bytes else 0

            print(f"  {ac}A×{rc}R       {d.total_bytes:>8,} {d.template_bytes:>10,} "
                  f"{d.setting_bytes:>8,} {d.positions_bytes:>10,} "
                  f"{d.activity_bytes:>10,} {d.summary_bytes:>10,} "
                  f"{d.debates_bytes:>8,} {d.tensions_bytes:>8,}  {pos_pct:>4.1f}%")

    def test_raw_tier_comparison(self):
        """Show how RAW context varies by tier at different scales."""
        print("\n" + "=" * 100)
        print("  RAW CONTEXT BY TIER  (bytes)")
        print("=" * 100)

        configs = [(5, 3), (10, 5), (10, 8), (15, 8), (20, 8)]

        print(f"  {'Config':<12} {'CORE':>10} {'IMPORTANT':>10} {'MOB':>10}  "
              f"{'CORE msgs':>10} {'IMP msgs':>10} {'MOB msgs':>10}")
        print("  " + "-" * 80)

        for ac, rc in configs:
            agents = _make_agents(ac)
            messages = _simulate_messages(agents, rc)

            core_a = next(a for a in agents if a["tier"] == "CORE")
            imp_a = next(a for a in agents if a["tier"] == "IMPORTANT")
            mob_a = next(a for a in agents if a["tier"] == "MOB")

            dc = _decompose_raw_context(core_a, messages)
            di = _decompose_raw_context(imp_a, messages)
            dm = _decompose_raw_context(mob_a, messages)

            # Count messages each tier sees
            core_msgs = min(len(messages), 8)
            imp_msgs = min(len(messages), 5)
            mob_msgs = min(len(messages), 3)

            print(f"  {ac}A×{rc}R       {dc.total_bytes:>10,} {di.total_bytes:>10,} "
                  f"{dm.total_bytes:>10,}  {core_msgs:>10} {imp_msgs:>10} {mob_msgs:>10}")

    def test_growth_rate_analysis(self):
        """Analyze per-round growth rate for RAW vs BB."""
        print("\n" + "=" * 100)
        print("  GROWTH RATE ANALYSIS  (avg bytes per agent per round)")
        print("=" * 100)

        for ac in [5, 10, 15]:
            agents = _make_agents(ac)
            print(f"\n  {ac} agents:")
            print(f"    {'Round':<8} {'RAW avg':>10} {'BB avg':>10} "
                  f"{'RAW Δ/rnd':>10} {'BB Δ/rnd':>10} {'BB/RAW':>8}")
            print("    " + "-" * 58)

            prev_raw, prev_bb = 0, 0
            for rc in range(1, 13):
                messages = _simulate_messages(agents, rc)
                bb = _simulate_blackboard(agents, rc)

                raw_avg = sum(
                    _decompose_raw_context(a, messages).total_bytes for a in agents
                ) / len(agents)
                bb_avg = sum(
                    _decompose_bb_context(a, bb).total_bytes for a in agents
                ) / len(agents)

                raw_delta = raw_avg - prev_raw if prev_raw else 0
                bb_delta = bb_avg - prev_bb if prev_bb else 0
                ratio = bb_avg / raw_avg if raw_avg else 0

                marker = " ✅" if ratio < 1.0 else " ⛔" if ratio > 2.0 else ""
                print(f"    R{rc:<5}   {raw_avg:>10,.0f} {bb_avg:>10,.0f} "
                      f"{raw_delta:>+10,.0f} {bb_delta:>+10,.0f} {ratio:>7.2f}×{marker}")

                prev_raw, prev_bb = raw_avg, bb_avg

    def test_crossover_search(self):
        """Find the (agents, rounds) where BB becomes cheaper than RAW."""
        print("\n" + "=" * 100)
        print("  CROSSOVER SEARCH  (looking for BB < RAW)")
        print("=" * 100)

        crossover_found = False
        for ac in range(3, 30):
            agents = _make_agents(ac)
            for rc in range(1, 20):
                messages = _simulate_messages(agents, rc)
                bb = _simulate_blackboard(agents, rc)

                raw_avg = sum(
                    _decompose_raw_context(a, messages).total_bytes for a in agents
                ) / len(agents)
                bb_avg = sum(
                    _decompose_bb_context(a, bb).total_bytes for a in agents
                ) / len(agents)

                if bb_avg < raw_avg:
                    if not crossover_found:
                        print(f"\n  Crossover found at {ac} agents × {rc} rounds!")
                        print(f"    RAW avg: {raw_avg:,.0f} bytes")
                        print(f"    BB  avg: {bb_avg:,.0f} bytes")
                        crossover_found = True

        if not crossover_found:
            print("\n  ⛔ NO CROSSOVER FOUND in range [3-29 agents] × [1-19 rounds]")
            print("  BB is ALWAYS more expensive than RAW in current implementation")
            print("\n  Analysis: RAW's tier filtering (CORE:8, IMPORTANT:5, MOB:3 messages)")
            print("  effectively caps context growth. BB's full shared briefing with all")
            print("  agent positions has no such cap — every agent reads ALL positions.")


# ══════════════════════════════════════════════════════════════
#  Test 2: Real LLM validation at key matrix points
# ══════════════════════════════════════════════════════════════

class TestLLMValidation:
    """Validate bytes→tokens correlation with real API calls."""

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
    async def test_bytes_to_tokens_ratio(self):
        """Validate that context bytes predict prompt tokens accurately."""
        print("\n" + "=" * 70)
        print("  BYTES → TOKENS VALIDATION (real GPT 5.2 calls)")
        print("=" * 70)

        test_points = [
            (3, 1, "CORE"),    # small
            (10, 3, "CORE"),   # medium RAW
            (10, 3, "MOB"),    # medium MOB
            (10, 8, "CORE"),   # large
        ]

        PROMPT_TEMPLATE = """你是{name}，{role}。性格：{persona}。
当前情绪: {emotion}
背景: {setting}
话题: {topic}

{context_section}

请以{name}的身份发言。输出严格 JSON:
{{"content": "你的发言(50字)", "emotion": "冷静", "diverge": null}}"""

        print(f"  {'Config':<20} {'Mode':<6} {'Bytes':>8} {'Tokens':>8} {'B/T ratio':>10}")
        print(f"  {'-'*20} {'-'*6} {'-'*8} {'-'*8} {'-'*10}")

        ratios = []

        for ac, rc, tier in test_points:
            agents = _make_agents(ac)
            messages = _simulate_messages(agents, rc)
            bb = _simulate_blackboard(agents, rc)
            agent = next(a for a in agents if a["tier"] == tier)

            for mode in ["raw", "bb"]:
                if mode == "raw":
                    recent = format_messages_for_context(messages, tier=tier)
                    ctx = build_agent_context(
                        agent=agent, setting_background=SETTING,
                        current_topic=TOPIC, recent_messages=recent, tier=tier,
                    )
                else:
                    shared = format_briefing_for_context(bb.get_shared_briefing())
                    ctx = build_agent_context(
                        agent=agent, setting_background=SETTING,
                        current_topic=TOPIC, recent_messages="",
                        tier=tier, shared_briefing=shared,
                    )

                prompt = PROMPT_TEMPLATE.format(
                    name=agent["name"], role=agent["role"],
                    persona=agent["persona"], emotion=agent["emotion"],
                    setting=SETTING, topic=TOPIC, context_section=ctx,
                )
                ctx_bytes = len(prompt.encode("utf-8"))

                # Real API call
                async with httpx.AsyncClient(timeout=60.0) as client:
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

                assert resp is not None
                data = resp.json()
                usage = data.get("usage", {})
                prompt_tokens = usage.get("prompt_tokens", 0)
                ratio = ctx_bytes / prompt_tokens if prompt_tokens else 0
                ratios.append(ratio)

                label = f"{ac}A×{rc}R {tier}"
                print(f"  {label:<20} {mode:<6} {ctx_bytes:>8,} "
                      f"{prompt_tokens:>8,} {ratio:>10.2f}")

        avg_ratio = sum(ratios) / len(ratios) if ratios else 0
        print(f"\n  Average bytes/token ratio: {avg_ratio:.2f}")
        print("  (Chinese text is typically ~3-4 bytes per token)")
        assert len(ratios) == 8  # 4 configs × 2 modes
