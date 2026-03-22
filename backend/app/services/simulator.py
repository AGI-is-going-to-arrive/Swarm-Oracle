"""Stage 2: Simulate — Multi-agent simulation engine with branching and pruning."""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import sqlite3
from typing import Any

from sqlmodel import Session, select

from app.config import settings
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.blackboard import Blackboard
from app.services.lang_detect import get_language_directive
from app.services.llm_client import llm_call_json
from app.services.memory import (
    build_agent_context,
    compress_rounds,
    format_briefing_for_context,
    format_messages_for_context,
    retrieve_relevant_memories,
    store_memory,
)
from app.services.narrator import narrate_branch

# V2: Visualization layer (lazy-loaded only when enabled)
try:
    from app.visualization import (
        VisualizationMapper,
        assign_position,
        assign_sprites_batch,
        check_card_trigger,
        get_card_viz_event,
        select_scene,
    )
    _VIZ_AVAILABLE = True
except ImportError:
    _VIZ_AVAILABLE = False

# ── Intervention Queue ───────────────────────────────────
# File-backed SQLite deployments use a shared DB queue so different workers
# can see the same pending interventions. In-memory fallback is kept only
# for tests / non-file SQLite URLs.
pending_interventions: dict[str, list[str]] = {}
_intervention_lock = asyncio.Lock()

logger = logging.getLogger(__name__)


def _pending_intervention_db_path() -> str | None:
    db_url = settings.DATABASE_URL.strip()
    prefix = "sqlite:///"
    if not db_url.startswith(prefix):
        return None

    db_path = db_url[len(prefix):].split("?", 1)[0]
    if not db_path or db_path == ":memory:" or db_path.startswith("file:"):
        return None
    return db_path


def _split_intervention_key(key: str) -> tuple[str, str]:
    scenario_id, separator, branch_id = key.partition(":")
    if not separator or not scenario_id or not branch_id:
        raise ValueError(f"Invalid intervention key: {key!r}")
    return scenario_id, branch_id


def _coerce_stance_value(raw_stance: Any) -> float:
    """Convert parser/domain stance values into a safe visualization scalar.

    The parser often returns human-readable stance labels such as "支持/反对/中立".
    Visualization only needs a coarse left/center/right placement, so unknown
    labels safely fall back to the center instead of crashing on float().
    """
    if raw_stance is None:
        return 0.0
    if isinstance(raw_stance, (int, float)):
        return max(-1.0, min(1.0, float(raw_stance)))

    text = str(raw_stance).strip()
    if not text:
        return 0.0

    try:
        return max(-1.0, min(1.0, float(text)))
    except ValueError:
        lowered = text.lower()
        if any(
            token in lowered
            for token in (
                "support",
                "pro",
                "favor",
                "支持",
                "赞成",
                "赞同",
                "拥护",
                "同意",
                "賛成",
                "支持する",
                "찬성",
                "지지",
            )
        ):
            return 0.6
        if any(
            token in lowered
            for token in (
                "oppose",
                "against",
                "con",
                "反对",
                "质疑",
                "抵制",
                "否决",
                "反対",
                "反対する",
                "반대",
                "저지",
            )
        ):
            return -0.6
        if any(
            token in lowered
            for token in (
                "neutral",
                "undecided",
                "中立",
                "观望",
                "摇摆",
                "保留",
                "中立的",
                "保留する",
                "중립",
                "유보",
            )
        ):
            return 0.0
        return 0.0


async def get_pending_interventions(key: str) -> list[str]:
    """Pop all queued interventions for a branch in FIFO order."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention)
                    .where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                    )
                    .order_by(PendingIntervention.id.asc())
                ).all()
            )
            if not queued:
                return []
            texts = [item.user_input for item in queued]
            for item in queued:
                session.delete(item)
            session.commit()
            return texts

    async with _intervention_lock:
        return pending_interventions.pop(key, [])


async def pop_next_pending_intervention(key: str) -> str | None:
    """Atomically pop the next intervention while preserving per-branch order."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT id, user_input
                FROM pending_intervention
                WHERE scenario_id = ? AND branch_id = ?
                ORDER BY id ASC
                LIMIT 1
                """,
                (scenario_id, branch_id),
            ).fetchone()
            if row is None:
                conn.execute("COMMIT")
                return None
            conn.execute(
                "DELETE FROM pending_intervention WHERE id = ?",
                (row[0],),
            )
            conn.execute("COMMIT")
            return str(row[1])
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise
        finally:
            conn.close()

    async with _intervention_lock:
        queue = pending_interventions.get(key)
        if not queue:
            return None
        next_text = queue.pop(0)
        if not queue:
            pending_interventions.pop(key, None)
        return next_text


async def add_pending_intervention(key: str, text: str) -> None:
    """Append one intervention while preserving FIFO order across workers."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            session.add(
                PendingIntervention(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    user_input=text,
                )
            )
            session.commit()
        return

    async with _intervention_lock:
        if key not in pending_interventions:
            pending_interventions[key] = []
        pending_interventions[key].append(text)


async def clear_pending_interventions_for_scenario(scenario_id: str) -> None:
    """Remove any leftover queued interventions for a finished scenario."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention).where(PendingIntervention.scenario_id == scenario_id)
                ).all()
            )
            for item in queued:
                session.delete(item)
            session.commit()

    prefix = f"{scenario_id}:"
    async with _intervention_lock:
        keys_to_remove = [key for key in pending_interventions if key.startswith(prefix)]
        for key in keys_to_remove:
            pending_interventions.pop(key, None)


def _resolve_hierarchical_agent_sets(
    agents: list[dict[str, Any]],
    group_leaders: dict[str, str],
    agent_to_group: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    """Resolve effective leader/worker sets from hierarchical group config.

    If a configured leader is missing from the loaded agent set, promote the first
    available member in that group so hierarchical mode can keep producing leader
    guidance instead of degrading the entire group to silence.
    """
    if not group_leaders:
        return [], list(agents), {}

    agent_names = {str(agent.get("name", "")).strip() for agent in agents}
    group_members: dict[str, list[dict[str, Any]]] = {}
    for agent in agents:
        group_name = agent_to_group.get(str(agent.get("name", "")).strip())
        if group_name:
            group_members.setdefault(group_name, []).append(agent)

    effective_group_leaders: dict[str, str] = {}
    for group_name, configured_leader in group_leaders.items():
        members = group_members.get(group_name, [])
        if not members:
            logger.warning(
                "Hierarchical group %s has no available members; skipping leader resolution",
                group_name,
            )
            continue

        if configured_leader in agent_names:
            effective_group_leaders[group_name] = configured_leader
            continue

        fallback_leader = str(members[0].get("name", "")).strip()
        effective_group_leaders[group_name] = fallback_leader
        logger.warning(
            "Hierarchical group %s configured leader %s missing; falling back to %s",
            group_name,
            configured_leader or "<empty>",
            fallback_leader,
        )

    leader_names = set(effective_group_leaders.values())
    leader_agents = [agent for agent in agents if agent.get("name") in leader_names]
    worker_agents = [agent for agent in agents if agent.get("name") not in leader_names]
    return leader_agents, worker_agents, effective_group_leaders

FORK_DETECT_PROMPT_ZH = """你是一位敏锐的历史分歧分析师。请分析以下讨论，判断是否出现了足以改变走向的根本分歧。

【最近讨论摘要】
{recent_summary}

【Agent 标记的分歧信号】
{diverge_signals}

【分支灵敏度】{sensitivity}（0-1，越高越容易触发分支）

请判断:
1. 这些分歧是根本性的路线之争，还是仅仅是表面争论？
2. 如果存在实质分歧，它会导致几条截然不同的历史走向？

输出严格 JSON:
{{
  "should_fork": true或false,
  "reason": "一句话说明分歧的核心是什么",
  "branches": [
    {{
      "title": "简短生动的走向标题（6-12字，如：火星殖民计划启动、地球建立统一防线）",
      "description": "这条路线独有的发展路径是什么？具体描述这一条走向的核心走势和结果（每条必须不同！）",
      "probability": 0.6
    }}
  ]
}}

标题写法要求:
- 标题要像新闻标题一样吸引眼球，不要用"走向A"这种抽象表达
- 每个标题用最具辨识度的关键词，让人一眼看懂这条路线的核心区别
- 好的例子: "全面开战"、"和谈妥协"、"技术突围"、"联盟瓦解"
- 坏的例子: "积极发展路线"、"保守应对方案"、"第一种可能性"

描述写法要求:
- 每条分支的 description 必须各不相同，具体描述该路线独有的发展走势
- 不要写笼统的"核心分歧在于…"这种对所有分支通用的话
- 好的例子: "曹操集结二十万大军南下，目标直取荆州，刘备被迫退守"
- 坏的例子: "核心分歧在于是否对外扩张"

{language_directive}
"""

FORK_DETECT_PROMPT_EN = """You are a sharp historical divergence analyst. Review the discussion below and decide whether it contains a fundamental disagreement strong enough to split the timeline.

[Recent Discussion Summary]
{recent_summary}

[Divergence Signals Marked By Agents]
{diverge_signals}

[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)

Decide:
1. Are these disagreements fundamental strategic splits or merely surface-level arguments?
2. If a material split exists, how many genuinely different future paths does it create?

Return strict JSON:
{{
  "should_fork": true or false,
  "reason": "One sentence describing the core disagreement",
  "branches": [
    {{
      "title": "A vivid future-path title (3-8 words, e.g. Mars Colony Launches, Earth Forms A Unified Front)",
      "description": "Describe the unique trajectory and outcome of this branch in concrete terms. Every branch must be meaningfully different.",
      "probability": 0.6
    }}
  ]
}}

Title requirements:
- Titles should read like sharp headlines, not abstract placeholders such as 'Path A'
- Use the most distinctive keywords so the difference is obvious at a glance
- Good examples: "Total War", "Negotiated Peace", "Tech Breakthrough", "Alliance Collapse"
- Bad examples: "Aggressive Development Path", "Conservative Response Plan", "First Possibility"

Description requirements:
- Each branch description must be concrete and different from the others
- Do not repeat generic language like 'the core disagreement is whether to expand outward'
- Good example: "Cao Cao mobilizes two hundred thousand troops toward Jingzhou, forcing Liu Bei into a defensive retreat"
- Bad example: "The core disagreement is whether to expand outward"

{language_directive}
"""


# ── Simulation Orchestrator ──────────────────────────────


async def run_simulation(
    scenario_id: str,
    ws_callback: Any = None,
    llm_overrides: dict | None = None,
):
    """Execute the full simulation pipeline (Stage 2 + Stage 3).

    Args:
        scenario_id: The scenario to simulate.
        ws_callback: async callable(scenario_id, event_dict) for real-time push.
        llm_overrides: BYOK credentials (api_key, base_url, model).
                       Kept only in memory — never persisted to DB.
    """
    engine = get_engine()

    async def push(event: dict):
        if ws_callback:
            await ws_callback(scenario_id, event)

    # ── Load scenario ────────────────────────────────
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise ValueError(f"Scenario {scenario_id} not found")
        ctx = scenario.parsed_context or {}
        detected_language = ctx.get("_language", "Chinese")
        setting_bg = _format_setting(ctx.get("setting", {}), language=detected_language)
        sim_rounds = ctx.get("simulation_rounds", 10)
        sensitivity = ctx.get("branch_sensitivity", 0.7)
        key_variable = ctx.get("key_variable", scenario.question)

        # V2: Initialize visualization mapper if enabled
        viz_enabled = getattr(scenario, "visualization_enabled", False)
        scene_theme = getattr(scenario, "scene_theme", None)

        # P4-E: BYOK overrides — received via function param (memory-only, not from DB)
        # Merge model name from parsed_context (non-sensitive, kept for display)
        if llm_overrides is None:
            llm_overrides = {}
        if not llm_overrides.get("model") and ctx.get("llm_model"):
            llm_overrides["model"] = ctx.get("llm_model")
        if not llm_overrides.get("base_url") and ctx.get("llm_base_url"):
            llm_overrides["base_url"] = ctx.get("llm_base_url")

        # Load agents
        db_agents = list(session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all())
        agents = [_agent_to_dict(a) for a in db_agents]

    # P3-A: Detect hierarchical mode from parsed groups
    groups_data = ctx.get("groups", [])
    hierarchical = bool(groups_data) and ctx.get("hierarchical", False)

    # Build group membership lookup
    group_leaders: dict[str, str] = {}   # {group_name: leader_agent_name}
    agent_to_group: dict[str, str] = {}  # {agent_name: group_name}
    if hierarchical:
        for g in groups_data:
            gname = g.get("name", "")
            leader = g.get("leader", "")
            group_leaders[gname] = leader
            for member_name in g.get("members", []):
                agent_to_group[member_name] = gname
        logger.info("Hierarchical mode: %d groups, %d agents mapped",
                    len(group_leaders), len(agent_to_group))

    # Separate leaders from workers for hierarchical sim
    leader_agents = []
    worker_agents = []
    if hierarchical:
        leader_agents, worker_agents, group_leaders = _resolve_hierarchical_agent_sets(
            agents,
            group_leaders,
            agent_to_group,
        )
        logger.info("Leaders: %d, Workers: %d", len(leader_agents), len(worker_agents))

    await push({"type": "status", "data": {"status": "simulating", "hierarchical": hierarchical}})

    # V2: Build visualization broadcaster
    viz_mapper = None
    agent_prev_emotions: dict[str, str] = {}   # track emotion changes per agent
    last_card_round: int | None = None          # card event cooldown tracker
    if viz_enabled and _VIZ_AVAILABLE:
        viz_mapper = VisualizationMapper()
        # Assign sprites to all agents based on persona keywords
        sprite_assignments = assign_sprites_batch(agents, persona_key="persona")
        # Add initial positions + names for frontend rendering
        for i, sa in enumerate(sprite_assignments):
            stance = 0.0
            for a in agents:
                if str(a.get("id", "")) == sa["agent_id"]:
                    stance = _coerce_stance_value(a.get("stance"))
                    sa["name"] = a.get("name", "")
                    break
            x, y = assign_position(stance, len(agents), i)
            sa["x"] = x
            sa["y"] = y

        # V2-P2: Dynamically resolve scene theme from scenario question
        resolved_theme = scene_theme
        if not resolved_theme:
            resolved_theme = select_scene(scenario.question or "")
        # Broadcast scene init + agent sprites
        await push({
            "type": "viz:scene_init",
            "data": {
                "scene_theme": resolved_theme,
                "agents": sprite_assignments,
            },
        })
        # V2-P2: Broadcast viz:scene_change so Phaser updates background
        viz_scene_evt = viz_mapper.map_scene_change(resolved_theme)
        await push(viz_scene_evt)

        # Initialize emotion baselines from agent data
        for a in agents:
            agent_prev_emotions[a["id"]] = a.get("emotion", "neutral") or "neutral"

        logger.info("V2 Visualization enabled: theme=%s, %d sprites", resolved_theme, len(sprite_assignments))

    async def viz_push(event: dict):
        """Broadcast viz event (no-op if visualization disabled)."""
        if viz_mapper is not None:
            await push(event)

    # ── Create root branch ───────────────────────────
    root_title = ctx.get("initial_title", "历史拐点")
    root_branch_id = _get_or_create_root_branch(engine, scenario_id, title=root_title)
    all_branches = [{"id": root_branch_id, "status": "ACTIVE", "probability": 1.0}]

    # Push root branch to frontend so tree renders before agent_speak events
    await push({
        "type": "branch_init",
        "data": {
            "id": root_branch_id,
            "title": root_title,
            "probability": 1.0,
            "status": "ACTIVE",
            "parent_branch_id": None,
        },
    })

    # ── Blackboard per branch (only in blackboard mode) ─
    mode = ctx.get("mode", "blackboard")
    if mode == "blackboard":
        bb_init = Blackboard()
        # P3-A: register agent groups on the blackboard
        if hierarchical:
            for agent_name, group_name in agent_to_group.items():
                bb_init.set_agent_group(agent_name, group_name)
                bb_init.set_agent_faction(agent_name, group_name)
        blackboards: dict[str, Blackboard] = {root_branch_id: bb_init}
    else:
        blackboards = {}  # RAW mode — no blackboard, agents read DB directly

    # ── Simulation loop ──────────────────────────────
    for round_num in range(1, sim_rounds + 1):
        active_branches = [b for b in all_branches if b["status"] == "ACTIVE"]
        if not active_branches:
            break

        for branch_info in active_branches:
            branch_id = branch_info["id"]

            # 0) Check for pending user interventions (Butterfly Effect)
            intervention_key = f"{scenario_id}:{branch_id}"
            intervention_text = await pop_next_pending_intervention(intervention_key)
            if intervention_text is not None:
                await push({
                    "type": "intervention_injected",
                    "data": {
                        "branch_id": branch_id,
                        "round": round_num,
                        "text": intervention_text,
                    },
                })

                # V2-P2: Broadcast viz:event_anim for butterfly effect
                if viz_mapper is not None:
                    viz_interv = viz_mapper.map_intervention(
                        intervention_text, params={"round": round_num, "branch_id": branch_id}
                    )
                    await viz_push(viz_interv)

            # 1) Gather agent messages — each pushed to frontend immediately
            round_id = _create_round(engine, branch_id, round_num)
            bb = blackboards.get(branch_id)
            if bb is None:
                bb = Blackboard()  # ephemeral — discarded each round in RAW mode

            if hierarchical and leader_agents:
                # P3-A: hierarchical mode — only Leaders call LLM
                messages = await _gather_hierarchical_messages(
                    engine, scenario_id, branch_id, round_id, round_num,
                    leader_agents, worker_agents, agent_to_group, group_leaders,
                    setting_bg, key_variable,
                    intervention_text=intervention_text,
                    push=push,
                    blackboard=bb,
                    llm_overrides=llm_overrides,
                    language=detected_language,
                    viz_mapper=viz_mapper,
                    agent_prev_emotions=agent_prev_emotions,
                )
            else:
                messages = await _gather_agent_messages(
                    engine, scenario_id, branch_id, round_id, round_num, agents, setting_bg, key_variable,
                    intervention_text=intervention_text,
                    push=push,
                    blackboard=bb,
                    llm_overrides=llm_overrides,
                    language=detected_language,
                    viz_mapper=viz_mapper,
                    agent_prev_emotions=agent_prev_emotions,
                )

            # 2) Round summary
            if detected_language.startswith("Chinese"):
                summary_text = f"第{round_num}轮完成, {len(messages)}条发言"
            else:
                summary_text = f"Round {round_num} complete, {len(messages)} messages"
            await push({
                "type": "round_summary",
                "data": {"branch_id": branch_id, "round": round_num,
                         "summary": summary_text},
            })

            # V2-P2: Check for card event triggers
            if viz_mapper is not None and _VIZ_AVAILABLE:
                active_count_for_card = len([b for b in all_branches if b["status"] == "ACTIVE"])
                triggered_card = check_card_trigger(
                    round_number=round_num,
                    branch_count=active_count_for_card,
                    last_card_round=last_card_round,
                )
                if triggered_card:
                    last_card_round = round_num
                    card_viz = get_card_viz_event(triggered_card)
                    await viz_push(card_viz)
                    logger.info("V2 Card event triggered: %s at round %d", triggered_card, round_num)

            # 3) Compress memory every N rounds
            if round_num % settings.MEMORY_COMPRESS_INTERVAL == 0:
                compress_bb = blackboards.get(branch_id)  # None in RAW mode
                await _compress_round_memory(
                    engine,
                    branch_id,
                    round_num,
                    blackboard=compress_bb,
                    language=detected_language,
                    llm_overrides=llm_overrides,
                )

            # 4) Detect forking (skip on last round — children would have no messages)
            diverge_signals = [m["diverge"] for m in messages if m.get("diverge")]
            active_count = len([b for b in all_branches if b["status"] == "ACTIVE"])
            if diverge_signals and active_count < settings.MAX_BRANCHES and round_num < sim_rounds:
                fork_result = await _detect_fork(
                    engine, branch_id, diverge_signals, sensitivity,
                    llm_overrides=llm_overrides,
                    language=detected_language,
                )
                # H-6 fix: strict boolean check — LLM may return truthy non-bool values
                if fork_result.get("should_fork") is True:
                    new_branch_infos = []
                    for fb in fork_result.get("branches", []):
                        new_id = _create_branch(
                            engine, scenario_id,
                            parent_branch_id=branch_id,
                            fork_round=round_num,
                            fork_reason=fork_result["reason"],
                            title=fb["title"],
                            description=fb.get("description", ""),
                            probability=fb["probability"],
                        )
                        all_branches.append({
                            "id": new_id, "status": "ACTIVE",
                            "probability": fb["probability"]
                        })
                        # Fork blackboard for the new branch (only in blackboard mode)
                        if branch_id in blackboards:
                            blackboards[new_id] = blackboards[branch_id].fork()
                        new_branch_infos.append({
                            "id": new_id,
                            "title": fb["title"],
                            "description": fb.get("description", ""),
                            "probability": fb["probability"],
                        })

                    await push({
                        "type": "branch_fork",
                        "data": {
                            "parent": branch_id,
                            "children": new_branch_infos,
                            "reason": fork_result["reason"],
                        }
                    })

                    # V2: Broadcast viz:world_split
                    if viz_mapper is not None:
                        child_ids = [b["id"] for b in new_branch_infos]
                        viz_split = viz_mapper.map_branch_split(
                            parent_branch_id=branch_id,
                            child_branch_ids=child_ids,
                            reason=fork_result.get("reason"),
                        )
                        await viz_push(viz_split)

                    # ── Mark parent as COMPLETED after fork ──
                    # Parent's timeline splits into children; parent no longer
                    # participates in further rounds or fork detection.
                    branch_info["status"] = "COMPLETED"
                    _update_branch_status(engine, branch_id, BranchStatus.COMPLETED)
                    await push({
                        "type": "branch_update",
                        "data": {
                            "branch_id": branch_id,
                            "status": "COMPLETED",
                        },
                    })

        # 5) Normalize active branch probabilities (H-1 fix)
        # P2-8: Single session for all probability updates
        active_branches = [b for b in all_branches if b["status"] == "ACTIVE"]
        prob_sum = sum(b["probability"] for b in active_branches)
        if prob_sum > 0 and abs(prob_sum - 1.0) > 0.01:
            with Session(engine) as session:
                for b in active_branches:
                    b["probability"] = round(b["probability"] / prob_sum, 4)
                    db_branch = session.get(Branch, b["id"])
                    if db_branch:
                        db_branch.probability = b["probability"]
                        session.add(db_branch)
                session.commit()

        # 6) Prune low-probability branches
        for b in all_branches:
            if b["status"] == "ACTIVE" and b["probability"] < settings.BRANCH_PRUNE_THRESHOLD:
                b["status"] = "PRUNED"
                _update_branch_status(engine, b["id"], BranchStatus.PRUNED)
                await push({
                    "type": "branch_prune",
                    "data": {"branch_id": b["id"], "reason": "概率过低"},
                })

    # ── Stage 3: Narrate ─────────────────────────────
    await push({"type": "status", "data": {"status": "narrating"}})

    for b in all_branches:
        if b["status"] in ("ACTIVE", "COMPLETED"):
            narration = await _narrate_branch_data(
                engine,
                b["id"],
                agents,
                language=detected_language,
                llm_overrides=llm_overrides,
            )
            _save_narration(engine, b["id"], narration)
            await push({
                "type": "narration",
                "data": {
                    "branch_id": b["id"],
                    "title": narration.get("title", ""),
                    "story": narration.get("story", ""),
                    "insight": narration.get("insight", ""),
                },
            })

            # V2-P2: Broadcast viz:ending_play for each narrated branch
            if viz_mapper is not None:
                prob = b.get("probability", 0)
                ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
                viz_end = viz_mapper.map_ending(
                    branch_id=b["id"],
                    title=narration.get("title", ""),
                    story=narration.get("story", ""),
                    ending_type=ending_type,
                )
                await viz_push(viz_end)

    # ── Done ─────────────────────────────────────────
    # Cleanup pending interventions for this scenario (prevent memory leak)
    await clear_pending_interventions_for_scenario(scenario_id)

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario:
            scenario.status = ScenarioStatus.DONE
            session.add(scenario)
            session.commit()

    await push({"type": "simulation_done"})
    logger.info("Simulation complete for scenario %s", scenario_id)


# ── Internal helpers ─────────────────────────────────────


async def _gather_agent_messages(
    engine, scenario_id, branch_id, round_id, round_num, agents, setting_bg, topic,
    *, intervention_text: str | None = None,
    push=None,
    blackboard: Blackboard | None = None,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    viz_mapper=None,
    agent_prev_emotions: dict[str, str] | None = None,
) -> list[dict]:
    """Gather messages from all agents for this round.

    Each agent pushes its result immediately (not batched):
    - agent_speak_start: Agent begins thinking (shows indicator)
    - agent_speak: Final parsed message (content + emotion + diverge)

    When blackboard is provided, agents read shared briefing instead of
    raw DB messages. Results are batch-posted to the blackboard AFTER
    asyncio.gather returns (concurrency-safe).
    """
    semaphore = asyncio.Semaphore(settings.LLM_CONCURRENCY)

    # Build shared context: prefer Blackboard briefing, fall back to DB
    if blackboard is not None:
        briefing = blackboard.get_shared_briefing()
        shared_text = format_briefing_for_context(briefing)
    else:
        shared_text = ""

    # Fall back to DB messages when no blackboard or first round (empty board)
    recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=2)
    emotion_state = agent_prev_emotions if agent_prev_emotions is not None else {}

    async def push_event(event: dict):
        """Push event if callback is available."""
        if push:
            await push(event)

    async def process_agent(agent: dict):
        async with semaphore:
            agent_tier = agent.get("tier", "")

            # L2 vector memory: retrieve relevant memories for CORE/IMPORTANT
            l2_memories = ""
            if agent_tier in ("CORE", "IMPORTANT"):
                query = f"{topic} {agent.get('name', '')} {agent.get('role', '')}"
                l2_memories = retrieve_relevant_memories(scenario_id, query, top_k=5)

            # Build context: Blackboard shared briefing + DB fallback
            if shared_text and shared_text != "(尚无共享信息)":
                agent_briefing = shared_text
                ctx = build_agent_context(
                    agent=agent,
                    setting_background=setting_bg,
                    current_topic=topic,
                    recent_messages="",
                    retrieved_memories=l2_memories,
                    tier=agent_tier,
                    shared_briefing=agent_briefing,
                    intervention_text=intervention_text or "",
                    language=language,
                )
            else:
                # Fallback: format DB messages per-tier (first round or no blackboard)
                recent_text = format_messages_for_context(recent_msgs, tier=agent_tier)
                ctx = build_agent_context(
                    agent=agent,
                    setting_background=setting_bg,
                    current_topic=topic,
                    recent_messages=recent_text,
                    retrieved_memories=l2_memories,
                    tier=agent_tier,
                    intervention_text=intervention_text or "",
                    language=language,
                )

            # Choose reasoning effort based on tier
            effort = "medium" if agent.get("tier") == "CORE" else "low"

            # Notify frontend: agent starts thinking
            await push_event({
                "type": "agent_speak_start",
                "data": {
                    "agent": agent["name"],
                    "agent_id": agent["id"],
                    "branch": branch_id,
                    "round": round_num,
                },
            })

            try:
                _overrides = llm_overrides or {}
                result = await llm_call_json(
                    ctx, reasoning_effort=effort,
                    model=_overrides.get("model"),
                    api_key=_overrides.get("api_key"),
                    base_url=_overrides.get("base_url"),
                    fallback_mode="agent_message",
                )
                content = result.get("content", "")
                emotion = result.get("emotion", "neutral")
                diverge = result.get("diverge")
                if diverge and diverge.lower() in ("null", "none", ""):
                    diverge = None
            except Exception as exc:
                logger.warning("Agent %s failed: %s", agent["name"], exc)
                content = f"({agent['name']}沉默了)"
                emotion = "neutral"
                diverge = None

            msg = {
                "agent_id": agent["id"],
                "agent_name": agent["name"],
                "content": content,
                "emotion": emotion,
                "diverge": diverge,
            }

            # Push final parsed message immediately (no batching)
            await push_event({
                "type": "agent_speak",
                "data": {
                    "agent": agent["name"],
                    "agent_id": agent["id"],
                    "message": content,
                    "emotion": emotion,
                    "branch": branch_id,
                    "round": round_num,
                },
            })

            # V2: Broadcast viz:bubble_show when visualization is active
            if viz_mapper is not None:
                agent_stance = _coerce_stance_value(agent.get("stance"))
                viz_bubble = viz_mapper.map_agent_speak(
                    agent_id=agent["id"],
                    agent_name=agent["name"],
                    message=content,
                    emotion=emotion,
                    stance=agent_stance,
                )
                await push_event(viz_bubble)

                # V2-P2: Broadcast viz:agent_move (stance-based positioning)
                agent_idx = next(
                    (i for i, a in enumerate(agents) if a["id"] == agent["id"]), 0
                )
                viz_move = viz_mapper.map_stance_move(
                    agent_id=agent["id"],
                    stance_value=agent_stance,
                    total_agents=len(agents),
                    index=agent_idx,
                )
                await push_event(viz_move)

                # V2-P2: Broadcast viz:emotion_change when emotion shifts
                prev_em = emotion_state.get(agent["id"], "neutral")
                if emotion != prev_em:
                    viz_emo = viz_mapper.map_emotion_change(
                        agent_id=agent["id"],
                        old_emotion=prev_em,
                        new_emotion=emotion,
                    )
                    await push_event(viz_emo)
                    emotion_state[agent["id"]] = emotion

            return msg

    tasks = [process_agent(a) for a in agents]
    results = await asyncio.gather(*tasks)

    # Batch-post results to Blackboard (after gather — concurrency-safe)
    _save_messages(
        engine,
        [
            {
                "round_id": round_id,
                "agent_id": msg["agent_id"],
                "content": msg["content"],
                "emotion": msg["emotion"],
                "diverge": msg.get("diverge"),
            }
            for msg in results
        ],
    )

    if blackboard is not None:
        for msg in results:
            blackboard.post(
                agent_name=msg["agent_name"],
                content=msg["content"],
                emotion=msg["emotion"],
                diverge=msg.get("diverge"),
            )

    # L2: Store agent utterances to vector memory (fire-and-forget)
    for msg in results:
        store_memory(
            scenario_id=scenario_id,
            agent_name=msg["agent_name"],
            content=msg["content"],
            round_num=round_num,
            emotion=msg.get("emotion", "neutral"),
            branch_id=branch_id,
        )

    return list(results)


async def _gather_hierarchical_messages(
    engine, scenario_id, branch_id, round_id, round_num,
    leader_agents, worker_agents, agent_to_group, group_leaders,
    setting_bg, topic,
    *, intervention_text: str | None = None,
    push=None,
    blackboard: Blackboard | None = None,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    viz_mapper=None,
    agent_prev_emotions: dict[str, str] | None = None,
) -> list[dict]:
    """P3-A: Hierarchical message gathering.

    1. Only Leader agents make LLM calls
    2. Worker responses are synthesized from their Leader's output
    3. Dramatically reduces LLM calls: 1000 agents → ~10 LLM calls
    """
    # Step 1: Gather Leader messages (with LLM calls)
    leader_messages = await _gather_agent_messages(
        engine, scenario_id, branch_id, round_id, round_num,
        leader_agents, setting_bg, topic,
        intervention_text=intervention_text,
        push=push,
        blackboard=blackboard,
        llm_overrides=llm_overrides,
        language=language,
        viz_mapper=viz_mapper,
        agent_prev_emotions=agent_prev_emotions,
    )

    # Build leader name → message lookup
    leader_msg_map: dict[str, dict] = {}
    for msg in leader_messages:
        leader_msg_map[msg["agent_name"]] = msg

    # Step 2: Synthesize Worker responses from Leader output (no LLM calls)
    all_messages = list(leader_messages)

    async def push_event(event: dict):
        if push:
            await push(event)

    worker_messages: list[dict[str, Any]] = []
    for worker in worker_agents:
        worker_group = agent_to_group.get(worker["name"], "")
        leader_name = group_leaders.get(worker_group, "")
        leader_msg = leader_msg_map.get(leader_name)

        if leader_msg:
            # Synthesize: Worker echoes a condensed version of Leader's stance
            leader_content = leader_msg.get("content", "")
            worker_stance = worker.get("stance", "")
            # Create a short synthesized response reflecting the worker's persona
            synth_content = (
                f"({worker['name']}作为{worker.get('role', '成员')}，"
                f"响应{leader_name}的立场) "
                f"{leader_content[:80]}…"
            )
            emotion = leader_msg.get("emotion", "neutral")
        else:
            synth_content = f"({worker['name']}保持沉默)"
            emotion = "neutral"

        msg = {
            "agent_id": worker["id"],
            "agent_name": worker["name"],
            "content": synth_content,
            "emotion": emotion,
            "diverge": None,
            "synthesized": True,  # Mark as non-LLM
        }

        worker_messages.append(msg)

        # Push to frontend (but NO agent_speak_start — instant, no "thinking")
        await push_event({
            "type": "agent_speak",
            "data": {
                "agent": worker["name"],
                "agent_id": worker["id"],
                "message": synth_content,
                "emotion": emotion,
                "branch": branch_id,
                "round": round_num,
                "synthesized": True,
            },
        })

        # V2: Broadcast viz:bubble_show for worker (synthesized) agents
        if viz_mapper is not None:
            worker_stance = _coerce_stance_value(worker.get("stance"))
            viz_bubble = viz_mapper.map_agent_speak(
                agent_id=worker["id"],
                agent_name=worker["name"],
                message=synth_content,
                emotion=emotion,
                stance=worker_stance,
            )
            await push_event(viz_bubble)

        all_messages.append(msg)

    _save_messages(
        engine,
        [
            {
                "round_id": round_id,
                "agent_id": msg["agent_id"],
                "content": msg["content"],
                "emotion": msg["emotion"],
                "diverge": msg.get("diverge"),
            }
            for msg in worker_messages
        ],
    )
    for msg in worker_messages:
        store_memory(
            scenario_id=scenario_id,
            agent_name=msg["agent_name"],
            content=msg["content"],
            round_num=round_num,
            emotion=msg.get("emotion", "neutral"),
            branch_id=branch_id,
        )

    # Batch-post all results to Blackboard
    if blackboard is not None:
        for msg in all_messages:
            if not msg.get("synthesized"):  # Only post real messages
                continue  # Leaders already posted in _gather_agent_messages
            blackboard.post(
                agent_name=msg["agent_name"],
                content=msg["content"],
                emotion=msg["emotion"],
                diverge=msg.get("diverge"),
            )

    logger.info(
        "Hierarchical round %d: %d leader LLM calls, %d worker syntheses",
        round_num, len(leader_messages), len(worker_agents),
    )

    return all_messages


async def _detect_fork(engine, branch_id, diverge_signals, sensitivity, *, llm_overrides: dict | None = None, language: str = "Chinese") -> dict:
    """Detect if current discussion warrants a branch fork."""
    recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=3)
    recent_text = format_messages_for_context(recent_msgs, max_recent=15)
    prompt_template = FORK_DETECT_PROMPT_ZH if language == "Chinese" else FORK_DETECT_PROMPT_EN

    prompt = prompt_template.format(
        recent_summary=recent_text,
        diverge_signals="\n".join(f"- {s}" for s in diverge_signals),
        sensitivity=sensitivity,
        language_directive=get_language_directive(language),
    )

    try:
        _overrides = llm_overrides or {}
        return await llm_call_json(
            prompt, reasoning_effort="medium",
            model=_overrides.get("model"),
            api_key=_overrides.get("api_key"),
            base_url=_overrides.get("base_url"),
        )
    except Exception as exc:
        logger.warning("Fork detection failed: %s", exc)
        return {"should_fork": False}


async def _compress_round_memory(
    engine,
    branch_id,
    current_round,
    *,
    blackboard: Blackboard | None = None,
    language: str = "Chinese",
    llm_overrides: dict | None = None,
):
    """Compress recent rounds into a summary.

    When blackboard is provided, also updates its global summary
    so subsequent rounds benefit from the compressed context.
    """
    start_round = max(1, current_round - settings.MEMORY_COMPRESS_INTERVAL + 1)
    msgs = _get_messages_in_range(engine, branch_id, start_round, current_round)
    if not msgs:
        return

    msgs_text = "\n".join(f"[{m['agent_name']}]: {m['content']}" for m in msgs)
    previous_briefing = _load_latest_compressed_briefing(
        engine,
        branch_id,
        before_round=start_round,
    )
    summary = await compress_rounds(
        msgs_text,
        language=language,
        previous_briefing=previous_briefing,
        api_key=(llm_overrides or {}).get("api_key"),
        base_url=(llm_overrides or {}).get("base_url"),
        model=(llm_overrides or {}).get("model"),
    )

    _save_round_summary(
        engine,
        branch_id,
        current_round,
        json.dumps(summary, ensure_ascii=False),
    )

    # Update Blackboard with structured compression output
    if blackboard is not None:
        blackboard.update_global_summary(summary)


def _load_latest_compressed_briefing(engine, branch_id: str, *, before_round: int) -> dict | None:
    """Load the latest structured summary before the current compression window."""
    with Session(engine) as session:
        round_row = session.exec(
            select(Round)
            .where(
                Round.branch_id == branch_id,
                Round.round_number < before_round,
                Round.compressed_summary != None,  # noqa: E711
            )
            .order_by(Round.round_number.desc())
        ).first()

    if round_row is None or not round_row.compressed_summary:
        return None

    try:
        parsed = json.loads(round_row.compressed_summary)
    except json.JSONDecodeError:
        try:
            parsed = ast.literal_eval(round_row.compressed_summary)
        except (SyntaxError, ValueError):
            logger.warning(
                "Failed to parse historical compressed_summary for branch=%s round=%s",
                branch_id,
                round_row.round_number,
            )
            return None
    except TypeError:
        logger.warning(
            "Failed to parse historical compressed_summary for branch=%s round=%s",
            branch_id,
            round_row.round_number,
        )
        return None

    return parsed if isinstance(parsed, dict) else None


async def _narrate_branch_data(
    engine,
    branch_id,
    agents,
    *,
    language: str = "Chinese",
    llm_overrides: dict | None = None,
) -> dict:
    """Collect branch data and narrate it."""
    branch_info = _get_branch(engine, branch_id)
    all_msgs = _get_recent_messages(engine, branch_id, max_rounds=100)
    raw_text = "\n".join(f"[R{m.get('round', '?')} {m['agent_name']}]: {m['content']}" for m in all_msgs)
    agents_summary = ", ".join(f"{a['name']}({a['role']})" for a in agents[:10])

    result = await narrate_branch(
        branch_title=branch_info.get("title", ""),
        probability=branch_info.get("probability", 0.5),
        agents_summary=agents_summary,
        raw_rounds=raw_text[:3000],  # limit to ~3K chars
        language=language,
        api_key=(llm_overrides or {}).get("api_key"),
        base_url=(llm_overrides or {}).get("base_url"),
        model=(llm_overrides or {}).get("model"),
    )
    result["title"] = branch_info.get("title", "未命名")
    return result


# ── Database helpers ─────────────────────────────────────


def _agent_to_dict(agent: Agent) -> dict:
    return {
        "id": agent.id, "name": agent.name, "role": agent.role,
        "persona": agent.persona, "tier": agent.tier.value,
        "stance": agent.stance, "emotion": agent.emotion,
        "group_id": agent.group_id,  # P3-A
    }


def _format_setting(setting: dict, *, language: str = "Chinese") -> str:
    if language == "Chinese":
        labels = {
            "time_period": "时代",
            "location": "地点",
            "background": "背景",
            "unknown": "未知",
        }
    else:
        labels = {
            "time_period": "Era",
            "location": "Location",
            "background": "Background",
            "unknown": "Unknown",
        }
    return (
        f"{labels['time_period']}: {setting.get('time_period', labels['unknown'])}\n"
        f"{labels['location']}: {setting.get('location', labels['unknown'])}\n"
        f"{labels['background']}: {setting.get('background', '')}"
    )


def _create_branch(engine, scenario_id, *, parent_branch_id=None,
                    fork_round=0, fork_reason="", title="", description="", probability=1.0) -> str:
    branch = Branch(
        scenario_id=scenario_id, parent_branch_id=parent_branch_id,
        fork_round=fork_round, fork_reason=fork_reason,
        title=title, description=description, probability=probability,
    )
    with Session(engine) as session:
        session.add(branch)
        session.commit()
        session.refresh(branch)
        return branch.id


def _get_or_create_root_branch(engine, scenario_id: str, *, title: str) -> str:
    with Session(engine) as session:
        root_branch = session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.parent_branch_id == None,  # noqa: E711
            )
        ).first()
        if root_branch:
            root_branch.title = title or root_branch.title
            root_branch.probability = 1.0
            root_branch.status = BranchStatus.ACTIVE
            session.add(root_branch)
            session.commit()
            session.refresh(root_branch)
            return root_branch.id

    return _create_branch(engine, scenario_id, title=title, probability=1.0)


def _create_round(engine, branch_id, round_number) -> str:
    r = Round(branch_id=branch_id, round_number=round_number)
    with Session(engine) as session:
        session.add(r)
        session.commit()
        session.refresh(r)
        return r.id


def _save_message(engine, round_id, agent_id, content, emotion, diverge):
    _save_messages(
        engine,
        [{
            "round_id": round_id,
            "agent_id": agent_id,
            "content": content,
            "emotion": emotion,
            "diverge": diverge,
        }],
    )


def _save_messages(engine, messages: list[dict[str, Any]]) -> None:
    if not messages:
        return

    rows = [
        AgentMessage(
            round_id=message["round_id"],
            agent_id=message["agent_id"],
            content=message["content"],
            emotion=message["emotion"],
            diverge=message.get("diverge"),
        )
        for message in messages
    ]
    with Session(engine) as session:
        session.add_all(rows)
        session.commit()


def _get_recent_messages(engine, branch_id, max_rounds=2) -> list[dict]:
    """P0-2 fix: Uses JOIN to fetch agent names in a single query (no N+1)."""
    with Session(engine) as session:
        rounds = session.exec(
            select(Round)
            .where(Round.branch_id == branch_id)
            .order_by(Round.round_number.desc())
            .limit(max_rounds)
        ).all()
        if not rounds:
            return []
        round_ids = [r.id for r in rounds]
        round_num_map = {r.id: r.round_number for r in rounds}

        # LEFT JOIN: preserves messages even if agent was deleted
        rows = session.exec(
            select(AgentMessage, Agent.name)
            .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
            .where(AgentMessage.round_id.in_(round_ids))
        ).all()

        # Sort by round_number ASC (rounds were fetched DESC)
        results = []
        for msg, agent_name in rows:
            results.append({
                "agent_name": agent_name or "Unknown",
                "content": msg.content,
                "emotion": msg.emotion,
                "round": round_num_map.get(msg.round_id, 0),
            })
        results.sort(key=lambda x: x["round"])
        return results


def _get_messages_in_range(engine, branch_id, start, end) -> list[dict]:
    """P0-2 fix: Uses JOIN to fetch agent names in a single query (no N+1)."""
    with Session(engine) as session:
        round_ids = list(session.exec(
            select(Round.id)
            .where(Round.branch_id == branch_id,
                   Round.round_number >= start,
                   Round.round_number <= end)
        ).all())
        if not round_ids:
            return []

        rows = session.exec(
            select(AgentMessage, Agent.name)
            .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
            .where(AgentMessage.round_id.in_(round_ids))
        ).all()

        return [
            {"agent_name": agent_name or "Unknown", "content": msg.content}
            for msg, agent_name in rows
        ]


def _update_branch_status(engine, branch_id, status: BranchStatus):
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch:
            branch.status = status
            session.add(branch)
            session.commit()


def _get_branch(engine, branch_id) -> dict:
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if not branch:
            return {}
        return {"id": branch.id, "title": branch.title, "probability": branch.probability,
                "status": branch.status.value}


def _save_narration(engine, branch_id, narration: dict):
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch:
            branch.story = narration.get("story", "")
            branch.insight = narration.get("insight", "")
            key_moments = narration.get("key_moments", [])
            if isinstance(key_moments, list):
                branch.key_moments = json.dumps(key_moments, ensure_ascii=False)
            elif isinstance(key_moments, str):
                # LLM returned a string instead of list — wrap it
                branch.key_moments = json.dumps([key_moments], ensure_ascii=False)
            branch.status = BranchStatus.COMPLETED
            session.add(branch)
            session.commit()


def _save_round_summary(engine, branch_id, round_num, summary_text):
    with Session(engine) as session:
        r = session.exec(
            select(Round)
            .where(Round.branch_id == branch_id, Round.round_number == round_num)
        ).first()
        if r:
            r.compressed_summary = summary_text
            session.add(r)
            session.commit()
