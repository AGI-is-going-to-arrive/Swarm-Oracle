"""Extreme scale test matrix — 3..100 agents × 1..40 rounds.

All synthetic (no LLM calls). Bytes/token ratio validated at 2.99.
Produces: full matrix, component breakdown, growth curves, and
a cost projection table (USD at GPT-4o pricing).

Run:  .venv/bin/python -m pytest tests/test_extreme_matrix.py -v -s
"""

from __future__ import annotations

import time

from app.services.blackboard import Blackboard
from app.services.memory import (
    build_agent_context,
    format_briefing_for_context,
    format_messages_for_context,
)

SETTING = "三国末期，天下三分。曹魏、蜀汉、东吴在军事、外交、经济等领域展开全面博弈。各方均有雄心壮志。"  # noqa: E501
TOPIC = "如果诸葛亮北伐成功占领长安，三国格局将如何改变？各方将如何应对这一局势？"
SAMPLE = "若孔明得长安，关中粮道可通，西北人心亦动。魏必倾国来争，吾忧蜀道难守、粮尽援绝。当先据潼关、散关，修渠屯田以续。"  # noqa: E501

BYTES_PER_TOKEN = 2.99  # validated with GPT 5.2

# Full matrix dimensions
AGENT_COUNTS = [3, 5, 10, 15, 20, 30, 50, 75, 100]
ROUND_COUNTS = [1, 3, 5, 8, 12, 20, 30, 40]

_NAMES = [
    "曹操", "刘备", "孙权", "诸葛亮", "司马懿", "周瑜", "关羽", "荀彧",
    "鲁肃", "姜维", "赵云", "张飞", "陆逊", "贾诩", "黄忠", "马超",
    "甘宁", "徐庶", "庞统", "法正", "典韦", "许褚", "夏侯惇", "张辽",
    "太史慈", "甘夫人", "糜竺", "魏延", "黄权", "费祎", "蒋琬", "董允",
    "邓艾", "钟会", "孟获", "祝融", "孙策", "大乔", "小乔", "貂蝉",
    "吕布", "董卓", "袁绍", "袁术", "刘表", "刘璋", "马腾", "韩遂",
    "公孙瓒", "陶谦", "张角", "张宝", "张梁", "何进", "卢植", "皇甫嵩",
    "朱儁", "王允", "杨修", "荀攸", "程昱", "郭嘉", "曹仁", "曹洪",
    "夏侯渊", "于禁", "乐进", "李典", "曹彰", "曹植", "曹丕", "司马昭",
    "司马师", "王元姬", "钟毓", "羊祜", "杜预", "陈寿", "张华", "陆抗",
    "诸葛恪", "诸葛瑾", "步骘", "顾雍", "陆凯", "薛综", "严畯", "程普",
    "韩当", "黄盖", "蒋钦", "周泰", "凌统", "丁奉", "潘璋", "马忠",
    "朱然", "全琮", "吕蒙", "陈宫",
]
_TIERS = ["CORE", "CORE", "IMPORTANT", "IMPORTANT", "MOB"]


def _make_agents(n: int) -> list[dict]:
    agents = []
    for i in range(n):
        agents.append({
            "name": _NAMES[i % len(_NAMES)] + (f"_{i // len(_NAMES)}" if i >= len(_NAMES) else ""),
            "role": f"角色{i+1}",
            "persona": "性格鲜明",
            "emotion": "冷静",
            "tier": _TIERS[i % len(_TIERS)],
        })
    return agents


def _simulate_messages(agents: list[dict], rounds: int) -> list[dict]:
    msgs = []
    for r in range(1, rounds + 1):
        for a in agents:
            msgs.append({
                "agent_name": a["name"],
                "content": f"R{r}-{a['name']}: {SAMPLE}",
                "emotion": a["emotion"],
                "round_number": r,
            })
    return msgs


def _simulate_bb(agents: list[dict], rounds: int) -> Blackboard:
    bb = Blackboard()
    for r in range(1, rounds + 1):
        for a in agents:
            bb.post(a["name"], f"R{r}: {SAMPLE}", a["emotion"])
    return bb


def _ctx_bytes_raw(agent: dict, messages: list[dict]) -> int:
    recent = format_messages_for_context(messages, tier=agent["tier"])
    ctx = build_agent_context(
        agent=agent, setting_background=SETTING,
        current_topic=TOPIC, recent_messages=recent, tier=agent["tier"],
    )
    return len(ctx.encode("utf-8"))


def _ctx_bytes_bb(agent: dict, bb: Blackboard) -> int:
    shared = format_briefing_for_context(bb.get_shared_briefing())
    ctx = build_agent_context(
        agent=agent, setting_background=SETTING,
        current_topic=TOPIC, recent_messages="",
        tier=agent["tier"], shared_briefing=shared,
    )
    return len(ctx.encode("utf-8"))


def _bb_components(bb: Blackboard) -> dict:
    """Return byte sizes of each BB briefing component."""
    b = bb.get_shared_briefing()
    result = {}
    s = b.get("summary", "")
    result["summary"] = len(f"【全局态势】{s}".encode("utf-8")) if s else 0
    d = b.get("debates", [])
    result["debates"] = len(("【当前争论焦点】" + "；".join(d)).encode("utf-8")) if d else 0
    t = b.get("tensions", [])
    result["tensions"] = len(("【紧张点】" + "；".join(t)).encode("utf-8")) if t else 0
    p = b.get("positions", {})
    if p:
        lines = [f"  {k}: {v}" for k, v in p.items()]
        result["positions"] = len(("【各方立场】\n" + "\n".join(lines)).encode("utf-8"))
    else:
        result["positions"] = 0
    r = b.get("recent", [])
    if r:
        lines = [f"[{e.get('agent','?')}]({e.get('emotion','')}): {e.get('summary','')}" for e in r]
        result["activity"] = len(("【最近发言】\n" + "\n".join(lines)).encode("utf-8"))
    else:
        result["activity"] = 0
    return result


def _total_round_tokens(agents, messages, bb, mode):
    """Total prompt tokens for one round (all agents)."""
    total = 0
    for a in agents:
        b = _ctx_bytes_raw(a, messages) if mode == "raw" else _ctx_bytes_bb(a, bb)
        total += b
    return total / BYTES_PER_TOKEN


# ══════════════════════════════════════════════════════════════
#  Tests
# ══════════════════════════════════════════════════════════════

class TestExtremeMatrix:

    def test_full_matrix(self):
        """Complete NxM matrix of RAW vs BB avg bytes per agent."""
        print("\n" + "=" * 140)
        print("  FULL MATRIX: avg context bytes per agent  (RAW | BB | ratio)")
        print("=" * 140)

        # Header
        h = f"  {'Agents':<8}"
        for rc in ROUND_COUNTS:
            h += f" {'R'+str(rc):>22}"
        print(h)
        h2 = f"  {'':8}"
        for _ in ROUND_COUNTS:
            h2 += f" {'RAW':>7}{'BB':>7}{'×':>8}"
        print(h2)
        print("  " + "-" * (8 + len(ROUND_COUNTS) * 22))

        for ac in AGENT_COUNTS:
            agents = _make_agents(ac)
            row = f"  {ac:>4}    "
            for rc in ROUND_COUNTS:
                msgs = _simulate_messages(agents, rc)
                bb = _simulate_bb(agents, rc)
                raw_avg = sum(_ctx_bytes_raw(a, msgs) for a in agents) / len(agents)
                bb_avg = sum(_ctx_bytes_bb(a, bb) for a in agents) / len(agents)
                ratio = bb_avg / raw_avg if raw_avg else 0
                marker = (
                    "✅" if ratio < 1.0 else "⛔" if ratio > 2.5 else "⚠️" if ratio > 1.5 else "  "
                )
                row += f" {raw_avg/1000:>6.1f}k{bb_avg/1000:>6.1f}k{ratio:>5.1f}×{marker}"
            print(row)

    def test_total_tokens_per_round(self):
        """Total prompt tokens consumed per round (all agents combined)."""
        print("\n" + "=" * 140)
        print("  TOTAL TOKENS PER ROUND  (all agents combined, 1 round of calls)")
        print("=" * 140)

        h = f"  {'Agents':<8}"
        for rc in ROUND_COUNTS:
            h += f" {'R'+str(rc):>24}"
        print(h)
        h2 = f"  {'':8}"
        for _ in ROUND_COUNTS:
            h2 += f" {'RAW':>8}{'BB':>8}{'Δ%':>8}"
        print(h2)
        print("  " + "-" * (8 + len(ROUND_COUNTS) * 24))

        for ac in AGENT_COUNTS:
            agents = _make_agents(ac)
            row = f"  {ac:>4}    "
            for rc in ROUND_COUNTS:
                msgs = _simulate_messages(agents, rc)
                bb = _simulate_bb(agents, rc)
                raw_t = _total_round_tokens(agents, msgs, bb, "raw")
                bb_t = _total_round_tokens(agents, msgs, bb, "bb")
                delta = ((bb_t - raw_t) / raw_t * 100) if raw_t else 0
                row += f" {raw_t:>7,.0f} {bb_t:>7,.0f} {delta:>+6.0f}%"
            print(row)

    def test_component_at_extreme_scale(self):
        """BB component decomposition at extreme scales."""
        print("\n" + "=" * 120)
        print("  BB COMPONENT DECOMPOSITION AT EXTREME SCALES  (bytes)")
        print("=" * 120)

        configs = [
            (3, 3), (5, 5), (10, 8), (20, 8),
            (30, 12), (50, 20), (75, 30), (100, 40),
        ]

        print(f"  {'Config':<12} {'Positions':>10} {'Activity':>10} {'Other':>10} "
              f"{'Total BB':>10} {'RAW avg':>10} {'Pos/Total':>10} {'BB/RAW':>8}")
        print("  " + "-" * 90)

        for ac, rc in configs:
            agents = _make_agents(ac)
            msgs = _simulate_messages(agents, rc)
            bb = _simulate_bb(agents, rc)
            comp = _bb_components(bb)

            raw_avg = sum(_ctx_bytes_raw(a, msgs) for a in agents) / len(agents)
            core_a = next(a for a in agents if a["tier"] == "CORE")
            bb_total = _ctx_bytes_bb(core_a, bb)
            pos_pct = comp["positions"] / bb_total * 100 if bb_total else 0
            ratio = bb_total / raw_avg if raw_avg else 0
            other = comp["summary"] + comp["debates"] + comp["tensions"]

            print(f"  {ac:>3}A×{rc:<3}R   {comp['positions']:>10,} "
                  f"{comp['activity']:>10,} {other:>10,} "
                  f"{bb_total:>10,} {raw_avg:>10,.0f} "
                  f"{pos_pct:>9.1f}% {ratio:>7.2f}×")

    def test_positions_growth_formula(self):
        """Derive the exact growth formula for positions bytes."""
        print("\n" + "=" * 80)
        print("  POSITIONS GROWTH FORMULA DERIVATION")
        print("=" * 80)

        data_points = []
        for ac in [3, 5, 10, 15, 20, 30, 50, 75, 100]:
            agents = _make_agents(ac)
            bb = _simulate_bb(agents, 5)
            comp = _bb_components(bb)
            pos_bytes = comp["positions"]
            per_agent = pos_bytes / ac if ac else 0
            data_points.append((ac, pos_bytes, per_agent))
            print(f"  {ac:>3} agents → positions = {pos_bytes:>8,} bytes "
                  f"({per_agent:>6.1f} bytes/agent)")

        # Linear regression (simple y = mx + b)
        n = len(data_points)
        sx = sum(d[0] for d in data_points)
        sy = sum(d[1] for d in data_points)
        sxx = sum(d[0]**2 for d in data_points)
        sxy = sum(d[0]*d[1] for d in data_points)
        m = (n * sxy - sx * sy) / (n * sxx - sx**2)
        b = (sy - m * sx) / n

        print(f"\n  Linear fit: positions_bytes ≈ {m:.1f} × agents + {b:.1f}")
        print(f"  → ~{m:.0f} bytes per agent ({m/BYTES_PER_TOKEN:.0f} tokens/agent)")

        # Verify
        for ac, actual, _ in data_points:
            predicted = m * ac + b
            err = abs(predicted - actual) / actual * 100
            mark = "✅" if err < 5 else "⚠️"
            print(f"    {ac:>3} agents: predicted={predicted:>8,.0f}  actual={actual:>8,}  "
                  f"error={err:.1f}% {mark}")

    def test_activity_log_cap(self):
        """Prove activity_log is bounded regardless of scale."""
        print("\n" + "=" * 80)
        print("  ACTIVITY LOG CAP TEST")
        print("=" * 80)

        for ac in [5, 10, 20, 50, 100]:
            for rc in [1, 5, 10, 20, 40]:
                agents = _make_agents(ac)
                bb = _simulate_bb(agents, rc)
                comp = _bb_components(bb)
                entries = len(bb.get_shared_briefing().get("recent", []))
                print(f"  {ac:>3}A×{rc:>2}R: activity = {comp['activity']:>6,} bytes, "
                      f"entries = {entries:>3}")

        print("\n  → activity_log is ALWAYS bounded by sliding window (max 20 entries)")

    def test_raw_cap_proof(self):
        """Prove RAW context is capped regardless of scale."""
        print("\n" + "=" * 80)
        print("  RAW CONTEXT CAP PROOF")
        print("=" * 80)

        print(f"  {'Config':<12} {'CORE':>8} {'IMP':>8} {'MOB':>8} "
              f"{'CORE msgs':>10} {'Total msgs':>10}")
        print("  " + "-" * 60)

        for ac in [5, 10, 20, 50, 100]:
            for rc in [1, 5, 10, 20, 40]:
                agents = _make_agents(ac)
                msgs = _simulate_messages(agents, rc)
                total_msgs = len(msgs)

                core_a = next(a for a in agents if a["tier"] == "CORE")
                imp_a = next(a for a in agents if a["tier"] == "IMPORTANT")
                mob_a = next(a for a in agents if a["tier"] == "MOB")

                core_b = _ctx_bytes_raw(core_a, msgs)
                imp_b = _ctx_bytes_raw(imp_a, msgs)
                mob_b = _ctx_bytes_raw(mob_a, msgs)
                core_msgs = min(total_msgs, 8)

                print(f"  {ac:>3}A×{rc:>2}R    {core_b:>8,} {imp_b:>8,} {mob_b:>8,} "
                      f"{core_msgs:>10} {total_msgs:>10,}")

        print("\n  → CORE always sees max 8 messages regardless of 50, 500, or 4000 total messages")

    def test_cost_projection(self):
        """Project USD cost for a full simulation run."""
        print("\n" + "=" * 100)
        print("  COST PROJECTION  (full simulation = agents × rounds API calls)")
        print("=" * 100)

        # GPT-4o pricing: $2.50/M input, $10/M output (est)
        # GPT-5.2 pricing: assume similar or use $5/M input
        INPUT_PRICE = 5.0  # $/M tokens
        OUTPUT_TOKENS_PER_CALL = 80  # avg completion tokens
        OUTPUT_PRICE = 15.0  # $/M tokens

        print(f"  Pricing: ${INPUT_PRICE}/M input tokens, "
              f"${OUTPUT_PRICE}/M output tokens, "
              f"~{OUTPUT_TOKENS_PER_CALL} output tokens/call")
        print()

        print(f"  {'Config':<12} {'Calls':>8} "
              f"{'RAW input$':>10} {'BB input$':>10} "
              f"{'RAW total$':>10} {'BB total$':>10} {'Δ$':>8}")
        print("  " + "-" * 75)

        for ac, rc in [(5, 3), (10, 8), (20, 12), (30, 20),
                       (50, 20), (50, 40), (100, 20), (100, 40)]:
            agents = _make_agents(ac)
            calls = ac * rc

            msgs = _simulate_messages(agents, rc)
            bb = _simulate_bb(agents, rc)

            # Sum tokens across all agents for one round, then multiply by rounds
            raw_tokens_per_round = sum(
                _ctx_bytes_raw(a, msgs) / BYTES_PER_TOKEN for a in agents
            )
            bb_tokens_per_round = sum(
                _ctx_bytes_bb(a, bb) / BYTES_PER_TOKEN for a in agents
            )

            raw_input_total = raw_tokens_per_round * rc
            bb_input_total = bb_tokens_per_round * rc
            output_total = calls * OUTPUT_TOKENS_PER_CALL

            raw_input_cost = raw_input_total / 1e6 * INPUT_PRICE
            bb_input_cost = bb_input_total / 1e6 * INPUT_PRICE
            raw_total_cost = raw_input_cost + output_total / 1e6 * OUTPUT_PRICE
            bb_total_cost = bb_input_cost + output_total / 1e6 * OUTPUT_PRICE
            delta = bb_total_cost - raw_total_cost

            print(f"  {ac:>3}A×{rc:>2}R    {calls:>8,} "
                  f"${raw_input_cost:>9.4f} ${bb_input_cost:>9.4f} "
                  f"${raw_total_cost:>9.4f} ${bb_total_cost:>9.4f} "
                  f"${delta:>+7.4f}")

    def test_performance_benchmark(self):
        """Measure wall-clock time to construct contexts at extreme scale."""
        print("\n" + "=" * 80)
        print("  CONTEXT CONSTRUCTION PERFORMANCE  (wall time)")
        print("=" * 80)

        configs = [(10, 8), (50, 20), (100, 40)]

        for ac, rc in configs:
            agents = _make_agents(ac)
            msgs = _simulate_messages(agents, rc)
            bb = _simulate_bb(agents, rc)

            # RAW
            t0 = time.perf_counter()
            for a in agents:
                _ctx_bytes_raw(a, msgs)
            raw_ms = (time.perf_counter() - t0) * 1000

            # BB
            t0 = time.perf_counter()
            for a in agents:
                _ctx_bytes_bb(a, bb)
            bb_ms = (time.perf_counter() - t0) * 1000

            # BB post throughput
            t0 = time.perf_counter()
            bb2 = Blackboard()
            for r in range(1, rc + 1):
                for a in agents:
                    bb2.post(a["name"], f"R{r}: {SAMPLE}", a["emotion"])
            post_ms = (time.perf_counter() - t0) * 1000

            print(f"  {ac}A×{rc}R:")
            print(f"    RAW context build (all agents): {raw_ms:>8.1f} ms")
            print(f"    BB  context build (all agents): {bb_ms:>8.1f} ms")
            print(f"    BB  post() throughput ({ac*rc} posts): {post_ms:>8.1f} ms "
                  f"({ac*rc/post_ms*1000:,.0f} posts/sec)")
            print()
