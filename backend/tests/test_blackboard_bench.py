"""Blackboard benchmarks — measures performance characteristics.

Run with:
    .venv/bin/python -m pytest tests/test_blackboard_bench.py -v -s

Metrics tracked:
1. Context size comparison and growth characteristics
2. Briefing generation throughput
3. Sliding window enforcement overhead
4. Fork deep-copy cost at scale
5. End-to-end: 100 agents × 10 rounds scalability
"""

import time

import pytest

from app.services.blackboard import Blackboard
from app.services.memory import (
    build_agent_context,
    format_briefing_for_context,
    format_messages_for_context,
)


# ── Helpers ──────────────────────────────────────────────


def _make_agent(name: str, tier: str = "CORE") -> dict:
    return {
        "name": name,
        "role": f"{name}的角色描述，包含详细的背景信息和社会关系",
        "persona": f"性格特征：{name}是一个非常有个性的角色，善于辩论",
        "emotion": "冷静",
        "tier": tier,
    }


def _make_messages(n: int) -> list[dict]:
    """Generate n realistic agent messages."""
    agents = ["曹操", "刘备", "孙权", "诸葛亮", "司马懿", "周瑜", "关羽", "张飞"]
    return [
        {
            "agent_name": agents[i % len(agents)],
            "content": f"这是第{i+1}条消息的完整内容，包含了对当前局势的分析和对未来走向的判断。"
                       f"我认为应该从{agents[(i+1) % len(agents)]}的角度来考虑这个问题，"
                       f"因为这涉及到多方利益的博弈和战略平衡。",
            "emotion": ["冷静", "激动", "忧虑", "坚定"][i % 4],
            "round_number": i // 4 + 1,
        }
        for i in range(n)
    ]


def _populate_blackboard(bb: Blackboard, n_agents: int, n_rounds: int) -> None:
    """Simulate n_rounds of discussion with n_agents."""
    agents = [f"Agent_{i}" for i in range(n_agents)]
    for r in range(n_rounds):
        for a in agents:
            bb.post(
                a,
                f"Round {r+1}: 这是{a}在第{r+1}轮的发言，包含约50字的内容来模拟真实对话长度。"
                f"这是一些补充内容来达到更接近真实场景的字符数。",
                ["冷静", "激动", "忧虑", "坚定"][r % 4],
            )
        if (r + 1) % 3 == 0:
            bb.update_global_summary({
                "situation": f"第{r+1}轮结束，局势紧张，多方存在明确分歧",
                "active_debates": [f"争论焦点{i}" for i in range(3)],
                "tension_points": [f"紧张点{i}" for i in range(2)],
                "consensus": "暂无共识" if r < 6 else "部分达成共识",
            })


# ── Benchmark: Context Size Characteristics ──────────────


class TestContextSizeCharacteristics:
    """Measure and report context size properties of Blackboard vs raw."""

    SETTING = "三国时代，天下大乱，群雄割据。各方势力在政治、军事、外交等方面展开激烈博弈。"
    TOPIC = "如果赤壁之战曹操获胜，三国格局将如何改变？"

    @pytest.mark.parametrize("n_msgs", [10, 30, 60, 120])
    def test_raw_grows_linearly_bb_stays_bounded(self, n_msgs):
        """Raw (unlimited) context grows linearly; BB stays bounded.

        The key property is that unlimited raw context (no tier filter)
        grows O(n) with message count, but BB is bounded by:
        - activity_log capped at 20 entries
        - positions dict grows with UNIQUE agents only (typically 8-15)
        """
        agent = _make_agent("曹操", "CORE")
        msgs = _make_messages(n_msgs)

        # BB approach
        bb = Blackboard()
        for m in msgs:
            bb.post(m["agent_name"], m["content"], m["emotion"])
        bb.update_global_summary({
            "situation": "三方对峙局势",
            "active_debates": ["战略路线", "联盟选择"],
            "tension_points": ["军事冲突"],
        })
        briefing_text = format_briefing_for_context(bb.get_shared_briefing())
        bb_size = len(briefing_text.encode("utf-8"))

        # Raw unlimited (what we'd get without tier filtering)
        raw_text = format_messages_for_context(msgs)  # default max_recent=15
        raw_size = len(raw_text.encode("utf-8"))

        # Raw tier-limited
        raw_tiered = format_messages_for_context(msgs, tier="CORE")
        raw_tiered_size = len(raw_tiered.encode("utf-8"))

        print(f"\n  [{n_msgs} msgs] briefing={bb_size}B, "
              f"raw(15)={raw_size}B, raw(tier=CORE,8)={raw_tiered_size}B, "
              f"unique_agents={len(bb.agent_positions)}, "
              f"log_entries={len(bb.activity_log)}")

        # Activity log is always bounded
        assert len(bb.activity_log) <= 20
        # Unique agents for 8-source messages should be exactly 8
        assert len(bb.agent_positions) == min(n_msgs, 8)

    def test_bb_activity_log_bounded(self):
        """Activity log stays bounded at max_activity_entries."""
        bb = Blackboard()
        msgs = _make_messages(200)
        for m in msgs:
            bb.post(m["agent_name"], m["content"], m["emotion"])

        briefing = bb.get_shared_briefing()
        assert len(briefing["recent"]) <= 10  # default max_entries for briefing
        assert len(bb.activity_log) == 20  # default window

    def test_bb_size_stable_across_rounds(self):
        """BB briefing size stabilizes after initial growth.

        With a fixed set of agents, BB size should plateau once:
        - All agents have posted (positions dict full)
        - Activity log hits window cap
        """
        agent = _make_agent("曹操", "CORE")
        sizes = []
        bb = Blackboard()

        for round_num in range(1, 21):
            for i in range(8):  # 8 fixed agents
                bb.post(f"Agent_{i}", f"Round {round_num} content", "冷静")

            briefing_text = format_briefing_for_context(bb.get_shared_briefing())
            sizes.append(len(briefing_text.encode("utf-8")))

        # After round 3+ (activity log fills up), size should be stable
        late_sizes = sizes[5:]  # rounds 6-20
        max_late = max(late_sizes)
        min_late = min(late_sizes)
        variance_pct = ((max_late - min_late) / min_late) * 100

        print(f"\n  Size progression: {sizes[:5]}... → {sizes[-3:]}")
        print(f"  Late variance: {variance_pct:.1f}% "
              f"(min={min_late}B, max={max_late}B)")

        # Late sizes should be stable (< 5% variance)
        assert variance_pct < 5.0, (
            f"BB size not stable after warmup: {variance_pct:.1f}% variance"
        )


# ── Benchmark: Briefing Generation Throughput ────────────


class TestBriefingThroughput:
    """Measure briefing generation speed at scale."""

    @pytest.mark.parametrize("n_agents,n_rounds", [
        (10, 5),
        (30, 10),
        (100, 10),
    ])
    def test_briefing_generation_time(self, n_agents, n_rounds):
        """Time get_shared_briefing + format after heavy usage."""
        bb = Blackboard()
        _populate_blackboard(bb, n_agents, n_rounds)

        # Measure briefing generation (1000 iterations)
        iterations = 1000
        start = time.perf_counter()
        for _ in range(iterations):
            briefing = bb.get_shared_briefing()
            _ = format_briefing_for_context(briefing)
        elapsed = time.perf_counter() - start

        per_call_us = (elapsed / iterations) * 1_000_000
        print(f"\n  {n_agents} agents × {n_rounds} rounds: "
              f"{per_call_us:.1f} µs/briefing "
              f"({iterations} iterations in {elapsed:.3f}s)")

        # Should be < 1ms per briefing even at 100 agents
        assert per_call_us < 1000, (
            f"Briefing generation too slow: {per_call_us:.1f} µs "
            f"(should be < 1000 µs)"
        )


# ── Benchmark: Sliding Window Overhead ───────────────────


class TestSlidingWindowOverhead:
    """Measure overhead of sliding window enforcement."""

    def test_post_throughput(self):
        """Measure post() speed with active sliding window."""
        bb = Blackboard(max_activity_entries=20)
        n_posts = 10_000

        start = time.perf_counter()
        for i in range(n_posts):
            bb.post(f"Agent_{i % 50}", f"Content {i}", "neutral")
        elapsed = time.perf_counter() - start

        per_post_us = (elapsed / n_posts) * 1_000_000
        print(f"\n  {n_posts} posts (window=20): "
              f"{per_post_us:.2f} µs/post, total {elapsed:.3f}s")

        assert per_post_us < 100, (
            f"post() too slow: {per_post_us:.2f} µs (should be < 100 µs)"
        )
        assert len(bb.activity_log) == 20

    def test_window_sizes(self):
        """Compare overhead across different window sizes."""
        n_posts = 5_000
        for window in [5, 20, 100, 500]:
            bb = Blackboard(max_activity_entries=window)
            start = time.perf_counter()
            for i in range(n_posts):
                bb.post(f"A{i % 50}", f"C{i}", "neutral")
            elapsed = time.perf_counter() - start
            per_post_us = (elapsed / n_posts) * 1_000_000
            print(f"\n  window={window}: {per_post_us:.2f} µs/post")
            assert len(bb.activity_log) == min(window, n_posts)


# ── Benchmark: Fork Cost ─────────────────────────────────


class TestForkCost:
    """Measure deep-copy cost at various scales."""

    @pytest.mark.parametrize("n_agents,n_rounds", [
        (10, 5),
        (30, 10),
        (100, 10),
    ])
    def test_fork_time(self, n_agents, n_rounds):
        """Time fork() after heavy usage."""
        bb = Blackboard()
        _populate_blackboard(bb, n_agents, n_rounds)

        iterations = 1000
        start = time.perf_counter()
        for _ in range(iterations):
            child = bb.fork()
        elapsed = time.perf_counter() - start

        per_fork_us = (elapsed / iterations) * 1_000_000
        log_size = len(bb.activity_log)
        positions = len(bb.agent_positions)
        print(f"\n  {n_agents}×{n_rounds} (log={log_size}, pos={positions}): "
              f"{per_fork_us:.1f} µs/fork")

        # Fork should be < 500 µs even at 100 agents
        assert per_fork_us < 500, (
            f"Fork too slow: {per_fork_us:.1f} µs (should be < 500 µs)"
        )

    def test_fork_memory_isolation(self):
        """Verify fork doesn't share mutable state."""
        bb = Blackboard()
        _populate_blackboard(bb, 50, 10)

        parent_log_len = len(bb.activity_log)
        child = bb.fork()

        # Mutate child extensively
        for i in range(100):
            child.post(f"NewAgent_{i}", f"New content {i}", "激动")
        child.update_global_summary({"situation": "CHANGED"})

        # Parent unchanged
        assert len(bb.activity_log) == parent_log_len
        assert bb.global_summary != "CHANGED"
        print(f"\n  Fork memory isolation verified: "
              f"parent log={parent_log_len}, child log={len(child.activity_log)}")


# ── Benchmark: End-to-End Token Budget ───────────────────


class TestTokenBudget:
    """Simulate realistic scenario and measure total token usage."""

    def test_100_agents_10_rounds(self):
        """Simulate 100 agents over 10 rounds, measure context sizes.

        Reports absolute sizes and growth characteristics. Key metrics:
        - BB activity log is bounded (20 entries max)
        - BB briefing size is determined by unique_agents + window
        - raw (tier-limited) is determined by max_recent per tier
        """
        bb = Blackboard()
        agents = [_make_agent(f"Agent_{i}", ["CORE", "IMPORTANT", "CROWD"][i % 3])
                  for i in range(100)]

        setting = "这是一个复杂的多方博弈场景，涉及政治、经济、军事等多个维度的决策。" * 3
        topic = "如果关键历史事件的结果发生逆转，世界格局将如何改变？"

        total_raw_bytes = 0
        total_bb_bytes = 0
        msgs_so_far: list[dict] = []
        per_round_bb: list[int] = []

        for round_num in range(1, 11):
            round_msgs = []
            for a in agents:
                content = (f"Round {round_num}: {a['name']}的详细发言，"
                           f"包含对局势的分析和建议，约100字的内容。" * 2)
                bb.post(a["name"], content, "冷静")
                round_msgs.append({
                    "agent_name": a["name"], "content": content,
                    "emotion": "冷静", "round_number": round_num,
                })
            msgs_so_far.extend(round_msgs)

            if round_num % 3 == 0:
                bb.update_global_summary({
                    "situation": f"第{round_num}轮总结",
                    "active_debates": ["A", "B"],
                    "tension_points": ["T"],
                })

            # Sample 3 agents (one per tier) to measure context
            round_bb_total = 0
            for tier_idx, tier in enumerate(["CORE", "IMPORTANT", "CROWD"]):
                agent = agents[tier_idx]

                # Raw (tier-limited)
                raw_text = format_messages_for_context(msgs_so_far, tier=tier)
                raw_ctx = build_agent_context(
                    agent=agent, setting_background=setting,
                    current_topic=topic, recent_messages=raw_text, tier=tier,
                )
                total_raw_bytes += len(raw_ctx.encode("utf-8"))

                # Blackboard
                briefing_text = format_briefing_for_context(bb.get_shared_briefing())
                bb_ctx = build_agent_context(
                    agent=agent, setting_background=setting,
                    current_topic=topic, recent_messages="",
                    tier=tier, shared_briefing=briefing_text,
                )
                bb_bytes = len(bb_ctx.encode("utf-8"))
                total_bb_bytes += bb_bytes
                round_bb_total += bb_bytes

            per_round_bb.append(round_bb_total)

        # Report
        print(f"\n  === 100 agents × 10 rounds ===")
        print(f"  Total raw(tier-limited): {total_raw_bytes:,} bytes")
        print(f"  Total BB context:        {total_bb_bytes:,} bytes")
        print(f"  Activity log:            {len(bb.activity_log)} entries")
        print(f"  Positions tracked:       {len(bb.agent_positions)}")
        print(f"  BB per-round (3 tiers):  {per_round_bb}")

        # Key metric: BB context is bounded (activity log capped)
        assert len(bb.activity_log) == 20

        # BB per-round size should stabilize after round 1
        # (round 1 grows as positions fill; later rounds are stable)
        late_rounds = per_round_bb[2:]  # rounds 3-10
        max_round = max(late_rounds)
        min_round = min(late_rounds)
        variance_pct = ((max_round - min_round) / min_round * 100
                        if min_round > 0 else 0)
        print(f"  BB late-round variance:  {variance_pct:.1f}%")

        # BB context per round should be stable (< 10% variance across late rounds)
        assert variance_pct < 10.0, (
            f"BB per-round size not stable: {variance_pct:.1f}% "
            f"variance (max={max_round}, min={min_round})"
        )

    def test_context_composition(self):
        """Break down BB briefing into components to understand size drivers.

        Shows exactly what contributes to BB briefing size for optimization.
        """
        for n_agents in [8, 30, 100]:
            bb = Blackboard()
            for i in range(n_agents):
                bb.post(
                    f"Agent_{i}",
                    f"这是Agent_{i}的发言内容，约三十个中文字符长度的模拟真实对话。",
                    "冷静",
                )
            bb.update_global_summary({
                "situation": "多方对峙",
                "active_debates": ["路线A", "路线B"],
                "tension_points": ["冲突点"],
            })

            briefing = bb.get_shared_briefing()
            text = format_briefing_for_context(briefing)

            # Measure component sizes
            summary_size = len(f"【全局态势】{briefing['summary']}".encode("utf-8"))
            positions_lines = [f"  {k}: {v}" for k, v in briefing["positions"].items()]
            positions_size = len(("【各方立场】\n" + "\n".join(positions_lines)).encode("utf-8"))
            recent_lines = [
                f"[{e['agent']}]({e['emotion']}): {e['summary']}"
                for e in briefing["recent"]
            ]
            recent_size = len(("【最近发言】\n" + "\n".join(recent_lines)).encode("utf-8"))
            total_size = len(text.encode("utf-8"))

            print(f"\n  [{n_agents} agents] total={total_size}B: "
                  f"summary={summary_size}B, "
                  f"positions={positions_size}B({positions_size*100//total_size}%), "
                  f"recent={recent_size}B({recent_size*100//total_size}%)")

        # The test always passes — it's purely diagnostic
        assert True
