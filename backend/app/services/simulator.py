"""Stage 2: Simulate — Multi-agent simulation engine with branching and pruning."""

from __future__ import annotations

import ast
import asyncio
import json
import logging
from typing import Any

from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
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
from app.services.llm_client import get_runtime_parallelism_limit, llm_call_json
from app.services.memory import (
    build_agent_context,
    compress_rounds,
    format_briefing_for_context,
    format_messages_for_context,
    retrieve_relevant_memories,
    store_memory,
)
from app.services.narrator import narrate_branch
from app.services.runtime_lock import runtime_lock_is_active, simulation_lock_key

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

_FORK_DEBUG_TRACE_KEY = "fork_debug_trace"
_FORK_DEBUG_MAX_SIGNALS = 12
_FORK_DEBUG_MAX_SIGNAL_CHARS = 240
_FORK_DEBUG_MAX_SUMMARY_CHARS = 1200
_FORK_DEBUG_MAX_DESCRIPTION_CHARS = 240


def _truncate_debug_text(value: Any, *, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return f"{text[: max_chars - 1]}…"


def _sanitize_fork_debug_signals(signals: list[str]) -> list[str]:
    unique_signals: list[str] = []
    seen: set[str] = set()
    for signal in signals:
        normalized = _truncate_debug_text(
            signal,
            max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
        )
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_signals.append(normalized)
        if len(unique_signals) >= _FORK_DEBUG_MAX_SIGNALS:
            break
    return unique_signals


def _sanitize_fork_debug_branch(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    title = _truncate_debug_text(
        payload.get("title"),
        max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
    )
    description = _truncate_debug_text(
        payload.get("description"),
        max_chars=_FORK_DEBUG_MAX_DESCRIPTION_CHARS,
    )
    result: dict[str, Any] = {
        "title": title,
        "probability": float(payload.get("probability") or 0.0),
    }
    if description:
        result["description_excerpt"] = description
    return result


def _sanitize_fork_debug_result(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"should_fork": False, "reason": "", "branches": []}

    sanitized_branches = [
        branch
        for branch in (
            _sanitize_fork_debug_branch(item) for item in payload.get("branches", [])
        )
        if branch is not None
    ]
    return {
        "should_fork": payload.get("should_fork") is True,
        "reason": _truncate_debug_text(
            payload.get("reason"),
            max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
        ),
        "branches": sanitized_branches,
    }


def _record_fork_debug_trace(engine, scenario_id: str, entry: dict[str, Any]) -> None:
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return

        ctx = dict(scenario.parsed_context or {})
        trace = list(ctx.get(_FORK_DEBUG_TRACE_KEY) or [])
        trace.append(entry)
        ctx[_FORK_DEBUG_TRACE_KEY] = trace
        scenario.parsed_context = ctx
        session.add(scenario)
        session.commit()


def _get_fork_prompt_template(language: str, variant: str) -> str:
    normalized_variant = (variant or "a").strip().lower()
    if language == "Chinese":
        if normalized_variant == "b":
            return FORK_DETECT_PROMPT_ZH_B
        if normalized_variant == "c":
            return FORK_DETECT_PROMPT_ZH_C
        if normalized_variant == "d":
            return FORK_DETECT_PROMPT_ZH_D
        if normalized_variant == "e":
            return FORK_DETECT_PROMPT_ZH_E
        if normalized_variant == "f":
            return FORK_DETECT_PROMPT_ZH_F
        return FORK_DETECT_PROMPT_ZH
    if normalized_variant == "b":
        return FORK_DETECT_PROMPT_EN_B
    if normalized_variant == "c":
        return FORK_DETECT_PROMPT_EN_C
    if normalized_variant == "d":
        return FORK_DETECT_PROMPT_EN_D
    if normalized_variant == "e":
        return FORK_DETECT_PROMPT_EN_E
    if normalized_variant == "f":
        return FORK_DETECT_PROMPT_EN_F
    return FORK_DETECT_PROMPT_EN


def _update_scenario_status(engine, scenario_id: str, status: ScenarioStatus) -> None:
    """Persist scenario status so reconnects/resyncs can recover the current stage."""
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None or scenario.status == status:
            return
        scenario.status = status
        session.add(scenario)
        session.commit()


def _pick_theater_ending_payload(
    narrated_branches: list[dict[str, Any]],
    *,
    branch_id: str | None = None,
) -> dict[str, Any] | None:
    """Choose the single ending payload Theater should present."""
    if not narrated_branches:
        return None

    if branch_id is not None:
        for item in narrated_branches:
            if item.get("id") == branch_id:
                return item

    return max(
        narrated_branches,
        key=lambda item: (
            float(item.get("probability") or 0),
            str(item.get("id") or ""),
        ),
    )


def reconcile_scenario_done_if_complete(engine, scenario_id: str) -> bool:
    """Mark a stale simulating/narrating scenario as done when all branch data is final."""
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return False
        if scenario.status not in (ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING):
            return False
        if runtime_lock_is_active(simulation_lock_key(scenario_id)):
            return False

        branches = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).all()
        if not branches:
            return False
        if any(branch.status == BranchStatus.ACTIVE for branch in branches):
            return False

        completed_branches = [
            branch for branch in branches if branch.status == BranchStatus.COMPLETED
        ]
        if any(
            not (branch.story or "").strip() or not (branch.insight or "").strip()
            for branch in completed_branches
        ):
            return False

        scenario.status = ScenarioStatus.DONE
        session.add(scenario)
        session.commit()
        return True


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
        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                row = conn.exec_driver_sql(
                    """
                    SELECT id, user_input
                    FROM pending_intervention
                    WHERE scenario_id = ? AND branch_id = ?
                    ORDER BY id ASC
                    LIMIT 1
                    """,
                    (scenario_id, branch_id),
                ).first()
                if row is None:
                    conn.commit()
                    return None
                conn.exec_driver_sql(
                    "DELETE FROM pending_intervention WHERE id = ?",
                    (row[0],),
                )
                conn.commit()
                return str(row[1])
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise

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


async def get_pending_intervention_count(key: str) -> int:
    """Return the number of queued interventions for one branch."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            return int(
                session.exec(
                    select(func.count(PendingIntervention.id)).where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                    )
                ).one()
                or 0
            )

    async with _intervention_lock:
        return len(pending_interventions.get(key, []))


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


async def clear_pending_interventions_for_branch(scenario_id: str, branch_id: str) -> None:
    """Remove leftover queued interventions for a single finished branch."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention).where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                    )
                ).all()
            )
            for item in queued:
                session.delete(item)
            session.commit()

    key = f"{scenario_id}:{branch_id}"
    async with _intervention_lock:
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

FORK_DETECT_PROMPT_ZH_B = """你是一位偏积极的世界线分叉分析师。请分析以下讨论，只要已经出现互斥未来、制度分流、审批路径分裂、责任链改写或不可同时满足的目标，就优先判定应该 fork。

【最近讨论摘要】
{recent_summary}

【Agent 标记的分歧信号】
{diverge_signals}

【分支灵敏度】{sensitivity}（0-1，越高越容易触发分支）

判定标准:
1. 不要把 fork 理解成“必须彻底对骂”。只要分歧会导向两条或更多无法同时成立的未来，就可以 fork。
2. 如果同一事件存在不同审批路径、不同责任归属、不同任务节奏、不同公众叙事，且这些差异会改变后续历史，请倾向于 fork。
3. 只有当所有人实际上已经收敛到同一路线，只剩措辞、证据门槛或执行细节差异时，才返回 should_fork=false。
4. 若 should_fork=true，请尽量压缩成 2-4 条最具代表性的未来路径。

输出严格 JSON:
{{
  "should_fork": true或false,
  "reason": "一句话说明这些分歧为何会或不会形成互斥未来",
  "branches": [
    {{
      "title": "简短生动的走向标题（6-12字）",
      "description": "这条路线独有的发展路径是什么？必须具体，不得与其它分支重复",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_EN_B = """You are an aggressive timeline-fork analyst. If the discussion already implies incompatible futures, diverging institutions, different approval paths, distinct responsibility chains, incompatible mission tempos, or mutually exclusive goals, prefer should_fork=true.

[Recent Discussion Summary]
{recent_summary}

[Divergence Signals Marked By Agents]
{diverge_signals}

[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)

Decision rubric:
1. Do not require open hostility. If the disagreement leads to two or more incompatible futures, that is enough to fork.
2. Prefer forking when the same event can proceed through meaningfully different approval paths, ownership structures, risk postures, public narratives, or downstream institutions.
3. Return should_fork=false only when the discussion has effectively converged on one path and the remaining differences are wording, evidence thresholds, or implementation details.
4. If should_fork=true, compress the result into the 2-4 most representative futures.

Return strict JSON:
{{
  "should_fork": true or false,
  "reason": "One sentence on why these disagreements do or do not create incompatible futures",
  "branches": [
    {{
      "title": "A vivid future-path title (3-8 words)",
      "description": "Describe the unique trajectory and outcome of this branch in concrete terms. Do not repeat other branches.",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_ZH_C = """你是一位世界线分叉分析师。请分析以下讨论。只引入一条更积极的规则：
只要这些分歧已经隐含两条或更多无法同时成立的未来，即使讨论双方在安全原则上部分一致，也可以判定 should_fork=true。

【最近讨论摘要】
{recent_summary}

【Agent 标记的分歧信号】
{diverge_signals}

【分支灵敏度】{sensitivity}（0-1，越高越容易触发分支）

其他要求与默认口径一致：不要把纯措辞差异、证据门槛差异或执行细节差异误判为 fork。

输出严格 JSON:
{{
  "should_fork": true或false,
  "reason": "一句话说明这些分歧为何会或不会形成互斥未来",
  "branches": [
    {{
      "title": "简短生动的走向标题（6-12字）",
      "description": "这条路线独有的发展路径是什么？必须具体，不得与其它分支重复",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_EN_C = """You are a timeline-fork analyst. Apply one additional rule beyond the default baseline:
If the disagreement already implies two or more incompatible futures, that alone is enough for should_fork=true, even if the participants still agree on some shared safety or governance principles.

[Recent Discussion Summary]
{recent_summary}

[Divergence Signals Marked By Agents]
{diverge_signals}

[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)

All other baseline expectations remain: do not fork on wording differences, evidence-threshold differences, or implementation details alone.

Return strict JSON:
{{
  "should_fork": true or false,
  "reason": "One sentence on why these disagreements do or do not create incompatible futures",
  "branches": [
    {{
      "title": "A vivid future-path title (3-8 words)",
      "description": "Describe the unique trajectory and outcome of this branch in concrete terms. Do not repeat other branches.",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_ZH_D = """你是一位制度分叉分析师。请分析以下讨论。只引入一条额外规则：
如果同一事件会导向不同审批路径、不同责任归属、不同任务节奏或不同治理结构，并且这些差异会改变后续决策与历史叙事，就可以判定 should_fork=true。

【最近讨论摘要】
{recent_summary}

【Agent 标记的分歧信号】
{diverge_signals}

【分支灵敏度】{sensitivity}（0-1，越高越容易触发分支）

其他要求与默认口径一致：不要把纯措辞差异、证据门槛差异或执行细节差异误判为 fork。

输出严格 JSON:
{{
  "should_fork": true或false,
  "reason": "一句话说明这些分歧为何会或不会形成制度/责任/审批层面的分叉",
  "branches": [
    {{
      "title": "简短生动的走向标题（6-12字）",
      "description": "这条路线独有的发展路径是什么？必须具体，不得与其它分支重复",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_EN_D = """You are an institutional fork analyst. Apply one additional rule:
If the same event can proceed through meaningfully different approval paths, responsibility chains, mission tempos, or governance structures, and those differences would change downstream decisions and historical narrative, you may return should_fork=true.

[Recent Discussion Summary]
{recent_summary}

[Divergence Signals Marked By Agents]
{diverge_signals}

[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)

All other baseline expectations remain: do not fork on wording differences, evidence-threshold differences, or implementation details alone.

Return strict JSON:
{{
  "should_fork": true or false,
  "reason": "One sentence on why these disagreements do or do not create a fork in institutions, approvals, or responsibility chains",
  "branches": [
    {{
      "title": "A vivid future-path title (3-8 words)",
      "description": "Describe the unique trajectory and outcome of this branch in concrete terms. Do not repeat other branches.",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_ZH_E = """你是一位世界线分叉分析师。请分析以下讨论。只引入一条额外规则：
只有当讨论已经明显收敛到同一路线，剩下的差异只属于措辞、证据门槛或执行细节时，才返回 should_fork=false。若你在“表层分歧”和“互斥未来”之间拿不准，请倾向于 fork。

【最近讨论摘要】
{recent_summary}

【Agent 标记的分歧信号】
{diverge_signals}

【分支灵敏度】{sensitivity}（0-1，越高越容易触发分支）

输出严格 JSON:
{{
  "should_fork": true或false,
  "reason": "一句话说明这些分歧为何会或不会形成互斥未来",
  "branches": [
    {{
      "title": "简短生动的走向标题（6-12字）",
      "description": "这条路线独有的发展路径是什么？必须具体，不得与其它分支重复",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_EN_E = """You are a timeline-fork analyst. Apply one additional rule:
Return should_fork=false only when the discussion has clearly converged on one path and the remaining differences are just wording, evidence thresholds, or implementation details. If you are uncertain between a surface disagreement and incompatible futures, lean toward forking.

[Recent Discussion Summary]
{recent_summary}

[Divergence Signals Marked By Agents]
{diverge_signals}

[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)

Return strict JSON:
{{
  "should_fork": true or false,
  "reason": "One sentence on why these disagreements do or do not create incompatible futures",
  "branches": [
    {{
      "title": "A vivid future-path title (3-8 words)",
      "description": "Describe the unique trajectory and outcome of this branch in concrete terms. Do not repeat other branches.",
      "probability": 0.6
    }}
  ]
}}

{language_directive}
"""

FORK_DETECT_PROMPT_ZH_F = """你是一位世界线压缩分析师。请分析以下讨论，并遵循两条规则：
1. 只要讨论已经形成互斥未来，或者会走向不同审批路径、责任链、治理结构或任务节奏，就可以 fork。
2. 但请强制做“主路径压缩”：默认只返回 2 条最具代表性的未来。只有当第 3 条路径在制度、责任或任务结果上明显独立且不可并入前两条时，才允许返回第 3 条。

【最近讨论摘要】
{recent_summary}

【Agent 标记的分歧信号】
{diverge_signals}

【分支灵敏度】{sensitivity}（0-1，越高越容易触发分支）

输出严格 JSON:
{{
  "should_fork": true或false,
  "reason": "一句话说明这些分歧为何会或不会形成互斥未来",
  "branches": [
    {{
      "title": "简短生动的走向标题（6-12字）",
      "description": "这条路线独有的发展路径是什么？必须具体，不得与其它分支重复",
      "probability": 0.6
    }}
  ]
}}

额外要求:
- 若 should_fork=true，优先返回 2 条主路径
- 只有当第 3 条未来明显独立且无法并入前两条时，才返回 3 条
- 不要把纯措辞差异、证据门槛差异或执行细节差异当作独立分支

{language_directive}
"""

FORK_DETECT_PROMPT_EN_F = """You are a timeline-compression analyst. Apply two rules:
1. If the discussion already implies incompatible futures, or meaningfully different approval paths, responsibility chains, governance structures, or mission tempos, you may fork.
2. But aggressively compress the result into the fewest representative futures: return 2 branches by default, and only return a 3rd branch when it is clearly independent and cannot be merged into the first two.

[Recent Discussion Summary]
{recent_summary}

[Divergence Signals Marked By Agents]
{diverge_signals}

[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)

Return strict JSON:
{{
  "should_fork": true or false,
  "reason": "One sentence on why these disagreements do or do not create incompatible futures",
  "branches": [
    {{
      "title": "A vivid future-path title (3-8 words)",
      "description": "Describe the unique trajectory and outcome of this branch in concrete terms. Do not repeat other branches.",
      "probability": 0.6
    }}
  ]
}}

Additional rules:
- If should_fork=true, prefer 2 representative branches
- Only return a 3rd branch when it is clearly independent and cannot be merged into the first two
- Do not create separate branches for wording differences, evidence-threshold differences, or implementation details alone

{language_directive}
"""


# ── Simulation Orchestrator ──────────────────────────────


async def run_simulation(
    scenario_id: str,
    ws_callback: Any = None,
    llm_overrides: dict | None = None,
    branch_id: str | None = None,
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
        fork_prompt_variant = str(ctx.get("fork_prompt_variant", "a") or "a").strip().lower()
        fork_detector_active_branch_limit = ctx.get("fork_detector_active_branch_limit")
        effective_detector_branch_budget_limit = None
        if fork_detector_active_branch_limit is not None:
            fork_detector_active_branch_limit = max(0, int(fork_detector_active_branch_limit))
            effective_detector_branch_budget_limit = (
                None
                if fork_detector_active_branch_limit == 0
                else fork_detector_active_branch_limit
            )
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
        if llm_overrides.get("temperature") is None and ctx.get("llm_temperature") is not None:
            llm_overrides["temperature"] = ctx.get("llm_temperature")

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

    start_round = 1
    resume_parent_branch_id: str | None = None
    active_branch_id: str
    if branch_id is None:
        root_title = ctx.get("initial_title", "历史拐点")
        active_branch_id = _get_or_create_root_branch(engine, scenario_id, title=root_title)
        all_branches = [{"id": active_branch_id, "status": "ACTIVE", "probability": 1.0}]

        # Push root branch to frontend so tree renders before agent_speak events
        await push({
            "type": "branch_init",
            "data": {
                "id": active_branch_id,
                "title": root_title,
                "probability": 1.0,
                "status": "ACTIVE",
                "parent_branch_id": None,
            },
        })
    else:
        with Session(engine) as session:
            target_branch = session.get(Branch, branch_id)
            if target_branch is None or target_branch.scenario_id != scenario_id:
                raise ValueError(f"Branch {branch_id} not found in scenario {scenario_id}")

            target_branch.status = BranchStatus.ACTIVE
            session.add(target_branch)
            session.commit()

            last_round = session.exec(
                select(func.max(Round.round_number)).where(Round.branch_id == branch_id)
            ).one_or_none()
            completed_rounds = int(last_round or 0)
            start_round = max(completed_rounds + 1, (target_branch.fork_round or 0) + 1, 1)
            active_branch_id = target_branch.id
            resume_parent_branch_id = target_branch.parent_branch_id
            all_branches = [{
                "id": active_branch_id,
                "status": BranchStatus.ACTIVE.value,
                "probability": target_branch.probability,
            }]

    # ── Blackboard per branch (only in blackboard mode) ─
    mode = ctx.get("mode", "blackboard")
    if mode == "blackboard":
        bb_init = Blackboard()
        # P3-A: register agent groups on the blackboard
        if hierarchical:
            for agent_name, group_name in agent_to_group.items():
                bb_init.set_agent_group(agent_name, group_name)
                bb_init.set_agent_faction(agent_name, group_name)
        if branch_id is not None and resume_parent_branch_id:
            parent_summary = _load_latest_compressed_briefing(
                engine,
                resume_parent_branch_id,
                before_round=start_round,
            )
            if parent_summary:
                bb_init.update_global_summary(parent_summary)
        blackboards: dict[str, Blackboard] = {active_branch_id: bb_init}
    else:
        blackboards = {}  # RAW mode — no blackboard, agents read DB directly

    # ── Simulation loop ──────────────────────────────
    for round_num in range(start_round, sim_rounds + 1):
        active_branches = [b for b in all_branches if b["status"] == "ACTIVE"]
        if not active_branches:
            break

        detector_budget_ranks: dict[str, int] = {}
        detector_budget_eligible_ids: set[str] | None = None
        if effective_detector_branch_budget_limit is not None:
            ranked_active_branches = sorted(
                active_branches,
                key=lambda item: (
                    -float(item.get("probability", 0.0) or 0.0),
                    str(item.get("id") or ""),
                ),
            )
            detector_budget_ranks = {
                str(branch["id"]): index + 1
                for index, branch in enumerate(ranked_active_branches)
            }
            detector_budget_eligible_ids = {
                str(branch["id"])
                for branch in ranked_active_branches[:effective_detector_branch_budget_limit]
            }

        for branch_info in active_branches:
            current_branch_id = branch_info["id"]

            # 0) Check for pending user interventions (Butterfly Effect)
            intervention_key = f"{scenario_id}:{current_branch_id}"
            intervention_text = await pop_next_pending_intervention(intervention_key)
            if intervention_text is not None:
                await push({
                    "type": "intervention_injected",
                    "data": {
                        "branch_id": current_branch_id,
                        "round": round_num,
                        "text": intervention_text,
                    },
                })

                # V2-P2: Broadcast viz:event_anim for butterfly effect
                if viz_mapper is not None:
                    viz_interv = viz_mapper.map_intervention(
                        intervention_text, params={"round": round_num, "branch_id": current_branch_id}
                    )
                    await viz_push(viz_interv)

            # 1) Gather agent messages — each pushed to frontend immediately
            round_id = _create_round(engine, current_branch_id, round_num)
            bb = blackboards.get(current_branch_id)
            if bb is None:
                bb = Blackboard()  # ephemeral — discarded each round in RAW mode

            if hierarchical and leader_agents:
                # P3-A: hierarchical mode — only Leaders call LLM
                messages = await _gather_hierarchical_messages(
                    engine, scenario_id, current_branch_id, round_id, round_num,
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
                    engine, scenario_id, current_branch_id, round_id, round_num, agents, setting_bg, key_variable,
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
                "data": {"branch_id": current_branch_id, "round": round_num,
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
                compress_bb = blackboards.get(current_branch_id)  # None in RAW mode
                await _compress_round_memory(
                    engine,
                    current_branch_id,
                    round_num,
                    blackboard=compress_bb,
                    language=detected_language,
                    llm_overrides=llm_overrides,
                )

            # 4) Detect forking (skip on last round — children would have no messages)
            diverge_signals = [m["diverge"] for m in messages if m.get("diverge")]
            active_count = len([b for b in all_branches if b["status"] == "ACTIVE"])
            if diverge_signals:
                detector_temperature = (llm_overrides or {}).get("temperature")
                recent_summary = format_messages_for_context(
                    _get_recent_messages(engine, current_branch_id, max_rounds=3),
                    max_recent=15,
                )
                fork_debug_entry: dict[str, Any] = {
                    "branch_id": current_branch_id,
                    "round": round_num,
                    "active_branch_count": active_count,
                    "max_branches": settings.MAX_BRANCHES,
                    "fork_detector_active_branch_limit": fork_detector_active_branch_limit,
                    "detector_branch_rank": detector_budget_ranks.get(current_branch_id),
                    "detector_branch_budget_eligible": (
                        True if detector_budget_eligible_ids is None else current_branch_id in detector_budget_eligible_ids
                    ),
                    "sim_rounds": sim_rounds,
                    "sensitivity": sensitivity,
                    "temperature": detector_temperature,
                    "prompt_variant": fork_prompt_variant,
                    "diverge_signal_count": len(diverge_signals),
                    "diverge_signals": _sanitize_fork_debug_signals(diverge_signals),
                    "recent_summary_excerpt": _truncate_debug_text(
                        recent_summary,
                        max_chars=_FORK_DEBUG_MAX_SUMMARY_CHARS,
                    ),
                    "detector_invoked": False,
                    "skip_reason": None,
                    "decision": "pending",
                }

                if active_count >= settings.MAX_BRANCHES:
                    fork_debug_entry["skip_reason"] = "max_branches_reached"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                elif (
                    detector_budget_eligible_ids is not None
                    and current_branch_id not in detector_budget_eligible_ids
                ):
                    fork_debug_entry["skip_reason"] = "detector_budget_exceeded"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                elif round_num >= sim_rounds:
                    fork_debug_entry["skip_reason"] = "last_round"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                else:
                    fork_result = await _detect_fork(
                        engine,
                        current_branch_id,
                        diverge_signals,
                        sensitivity,
                        llm_overrides=llm_overrides,
                        language=detected_language,
                        prompt_variant=fork_prompt_variant,
                        recent_summary=recent_summary,
                    )
                    fork_debug_entry["detector_invoked"] = True
                    fork_debug_entry["detector_result"] = _sanitize_fork_debug_result(
                        fork_result,
                    )

                    # H-6 fix: strict boolean check — LLM may return truthy non-bool values
                    if fork_result.get("should_fork") is True:
                        new_branch_infos = []
                        for fb in fork_result.get("branches", []):
                            new_id = _create_branch(
                                engine, scenario_id,
                                parent_branch_id=current_branch_id,
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
                            if current_branch_id in blackboards:
                                blackboards[new_id] = blackboards[current_branch_id].fork()
                            new_branch_infos.append({
                                "id": new_id,
                                "title": fb["title"],
                                "description": fb.get("description", ""),
                                "probability": fb["probability"],
                            })

                        fork_debug_entry["decision"] = "fork_created"
                        fork_debug_entry["created_branch_count"] = len(new_branch_infos)
                        fork_debug_entry["created_branch_ids"] = [
                            branch["id"] for branch in new_branch_infos
                        ]
                        fork_debug_entry["created_branch_titles"] = [
                            branch["title"] for branch in new_branch_infos
                        ]
                        _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)

                        await push({
                            "type": "branch_fork",
                            "data": {
                                "parent": current_branch_id,
                                "children": new_branch_infos,
                                "reason": fork_result["reason"],
                            }
                        })

                        # V2: Broadcast viz:world_split
                        if viz_mapper is not None:
                            child_ids = [b["id"] for b in new_branch_infos]
                            viz_split = viz_mapper.map_branch_split(
                                parent_branch_id=current_branch_id,
                                child_branch_ids=child_ids,
                                reason=fork_result.get("reason"),
                            )
                            await viz_push(viz_split)

                        # ── Mark parent as COMPLETED after fork ──
                        # Parent's timeline splits into children; parent no longer
                        # participates in further rounds or fork detection.
                        branch_info["status"] = "COMPLETED"
                        _update_branch_status(engine, current_branch_id, BranchStatus.COMPLETED)
                        await push({
                            "type": "branch_update",
                            "data": {
                                "branch_id": current_branch_id,
                                "status": "COMPLETED",
                            },
                        })
                    else:
                        fork_debug_entry["decision"] = "no_fork"
                        _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)

        # 5) Normalize active branch probabilities before pruning.
        _apply_normalized_active_branch_probabilities(engine, scenario_id, all_branches)

        # 6) Prune low-probability branches
        for b in all_branches:
            if b["status"] == "ACTIVE" and b["probability"] < settings.BRANCH_PRUNE_THRESHOLD:
                b["status"] = "PRUNED"
                _update_branch_status(engine, b["id"], BranchStatus.PRUNED)
                await push({
                    "type": "branch_prune",
                    "data": {"branch_id": b["id"], "reason": "概率过低"},
                })

        # 7) Re-normalize survivors after pruning so active branches still sum to 1.0.
        _apply_normalized_active_branch_probabilities(engine, scenario_id, all_branches)

    # ── Stage 3: Narrate ─────────────────────────────
    if branch_id is None:
        _update_scenario_status(engine, scenario_id, ScenarioStatus.NARRATING)
        await push({"type": "status", "data": {"status": "narrating"}})

    narrated_branch_payloads: list[dict[str, Any]] = []
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
            narrated_branch_payloads.append({
                "id": b["id"],
                "probability": b.get("probability", 0),
                "title": narration.get("title", ""),
                "story": narration.get("story", ""),
                "insight": narration.get("insight", ""),
            })

    # ── Done ─────────────────────────────────────────
    # Cleanup pending interventions for this scenario (prevent memory leak)
    if branch_id is None:
        await clear_pending_interventions_for_scenario(scenario_id)
    else:
        await clear_pending_interventions_for_branch(scenario_id, branch_id)

    scenario_finished = reconcile_scenario_done_if_complete(engine, scenario_id)
    if scenario_finished and viz_mapper is not None:
        chosen_ending = _pick_theater_ending_payload(
            narrated_branch_payloads,
            branch_id=branch_id,
        )
        if chosen_ending is not None:
            prob = chosen_ending.get("probability", 0)
            ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
            viz_end = viz_mapper.map_ending(
                branch_id=chosen_ending["id"],
                title=chosen_ending.get("title", ""),
                story=chosen_ending.get("story", "") or chosen_ending.get("insight", ""),
                ending_type=ending_type,
            )
            await viz_push(viz_end)

    if scenario_finished:
        await push({"type": "simulation_done"})

    if branch_id is None:
        logger.info("Simulation complete for scenario %s", scenario_id)
    else:
        logger.info(
            "Branch-only simulation complete for scenario %s branch %s (scenario_done=%s)",
            scenario_id,
            branch_id,
            scenario_finished,
        )


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
    semaphore = asyncio.Semaphore(get_runtime_parallelism_limit())

    # Build shared context: prefer Blackboard briefing, fall back to DB
    if blackboard is not None:
        briefing = blackboard.get_shared_briefing()
        shared_text = format_briefing_for_context(briefing)
    else:
        shared_text = ""

    # Only hit the DB when the blackboard cannot provide usable context.
    recent_msgs = None
    if not shared_text or shared_text == "(尚无共享信息)":
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
                assert recent_msgs is not None
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
                    temperature=_overrides.get("temperature"),
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


async def _detect_fork(
    engine,
    branch_id,
    diverge_signals,
    sensitivity,
    *,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    prompt_variant: str = "a",
    recent_summary: str | None = None,
) -> dict:
    """Detect if current discussion warrants a branch fork."""
    recent_text = recent_summary
    if recent_text is None:
        recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=3)
        recent_text = format_messages_for_context(recent_msgs, max_recent=15)
    prompt_template = _get_fork_prompt_template(language, prompt_variant)

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
            temperature=_overrides.get("temperature"),
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

    msgs_text = "\n".join(_format_message_for_compression(m) for m in msgs)
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
        temperature=(llm_overrides or {}).get("temperature"),
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
        temperature=(llm_overrides or {}).get("temperature"),
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


def _normalized_active_branch_probabilities(
    active_branches: list[dict[str, Any]],
) -> tuple[list[float] | None, bool]:
    if not active_branches:
        return None, False

    prob_sum = sum(float(branch.get("probability", 0.0) or 0.0) for branch in active_branches)
    if prob_sum <= 0:
        fallback = [round(1.0 / len(active_branches), 4) for _ in active_branches]
        fallback[-1] = round(1.0 - sum(fallback[:-1]), 4)
        return fallback, True

    if abs(prob_sum - 1.0) <= 0.01:
        return None, False

    normalized = [
        round(float(branch.get("probability", 0.0) or 0.0) / prob_sum, 4)
        for branch in active_branches
    ]
    normalized[-1] = round(1.0 - sum(normalized[:-1]), 4)
    return normalized, False


def _apply_normalized_active_branch_probabilities(
    engine,
    scenario_id: str,
    all_branches: list[dict[str, Any]],
) -> None:
    active_branches = [branch for branch in all_branches if branch["status"] == "ACTIVE"]
    normalized_probabilities, used_uniform_fallback = _normalized_active_branch_probabilities(
        active_branches,
    )
    if normalized_probabilities is None:
        return

    if used_uniform_fallback:
        logger.warning(
            "Active branches for scenario %s summed to <= 0; falling back to uniform probabilities",
            scenario_id,
        )

    with Session(engine) as session:
        for branch, normalized_probability in zip(active_branches, normalized_probabilities):
            branch["probability"] = normalized_probability
            db_branch = session.get(Branch, branch["id"])
            if db_branch:
                db_branch.probability = normalized_probability
                session.add(db_branch)
        session.commit()


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
        round_rows = list(session.exec(
            select(Round.id, Round.round_number)
            .where(Round.branch_id == branch_id,
                   Round.round_number >= start,
                   Round.round_number <= end)
        ).all())
        if not round_rows:
            return []
        round_ids = [row[0] for row in round_rows]
        round_num_map = {round_id: round_number for round_id, round_number in round_rows}

        rows = session.exec(
            select(AgentMessage, Agent.name, Agent.tier, Agent.role)
            .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
            .where(AgentMessage.round_id.in_(round_ids))
        ).all()

        return [
            {
                "agent_name": agent_name or "Unknown",
                "content": msg.content,
                "emotion": msg.emotion,
                "diverge": msg.diverge,
                "round": round_num_map.get(msg.round_id),
                "tier": getattr(agent_tier, "value", "") if agent_tier is not None else "",
                "role": agent_role or "",
            }
            for msg, agent_name, agent_tier, agent_role in rows
        ]


def _format_message_for_compression(message: dict[str, Any]) -> str:
    parts: list[str] = []
    round_number = message.get("round")
    if round_number is not None:
        parts.append(f"[R{round_number}]")

    speaker = message.get("agent_name", "Unknown")
    parts.append(f"[{speaker}]")

    tags: list[str] = []
    tier = str(message.get("tier", "") or "").strip()
    role = str(message.get("role", "") or "").strip()
    emotion = str(message.get("emotion", "") or "").strip()
    diverge = str(message.get("diverge", "") or "").strip()

    if tier:
        tags.append(tier)
    if role and ("leader" in role.lower() or "领袖" in role or "组长" in role):
        tags.append("LEADER")
    if emotion:
        tags.append(f"emotion={emotion}")
    if diverge:
        tags.append(f"diverge={diverge}")

    tag_block = f"[{'|'.join(tags)}]" if tags else ""
    return f"{''.join(parts)}{tag_block}: {message.get('content', '')}"


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
