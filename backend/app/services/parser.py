"""Stage 1: Parse — Decompose a 'What-If' question into scenario context and agents."""

from __future__ import annotations

import logging

from app.services.llm_client import llm_call_json
from app.services.lang_detect import detect_language, get_language_directive

logger = logging.getLogger(__name__)

PARSE_PROMPT = """你是 SwarmOracle 的场景解析器。用户提出了一个"如果…"假设，请把它解析为一个生动的推演场景。

用户问题: "{question}"

请输出严格 JSON 格式:
{{
  "setting": {{
    "time_period": "具体的时代或年份",
    "location": "具体的地点或世界",
    "background": "2-3 句生动的背景描述，要有画面感"
  }},
  "key_variable": "被改变的核心历史变量（简明扼要）",
  "initial_title": "推演起点的标题（如：历史拐点、变局开端，8字以内）",
  "agents": [
    {{
      "name": "角色名（使用有辨识度的真实姓名）",
      "role": "角色身份/职位",
      "persona": "写出鲜明的性格特点、说话风格和核心动机，像在介绍一个真实的人（50字以内）",
      "stance": "对核心变量的立场 (支持/反对/中立/观望)",
      "tier": "CORE 或 IMPORTANT 或 CROWD"
    }}
  ],
  "simulation_rounds": 10,
  "branch_sensitivity": 0.7
}}

规则:
- 目标总角色数必须精确等于 {target_agents} 个
- 角色分层预算：{agent_plan}
- CORE Agent 3-5 个: 最关键的决策者，性格要鲜明对比
- IMPORTANT 5-10 个: 有影响力的参与者
- CROWD 5-15 个: 普通群众和旁观者
- 总 Agent 数不超过 {max_agents} 个
- simulation_rounds 范围 5-{max_rounds}
- branch_sensitivity: 0-1, 越高越容易产生分支 (建议 0.5-0.8)
- {language_directive}
- 角色的 persona 要具体生动，避免"性格开朗"这类空泛描述
  好的例子: "雷厉风行的军人作风，说话简短有力，讨厌拐弯抹角"
  坏的例子: "性格沉稳，做事认真"
"""

# P3-A: extended prompt for hierarchical mode (groups field)
PARSE_PROMPT_HIERARCHICAL = """你是 SwarmOracle 的场景解析器。用户提出了一个"如果…"假设，请把它解析为一个大规模推演场景（需要分组管理大量角色）。

用户问题: "{question}"

请输出严格 JSON 格式:
{{
  "setting": {{
    "time_period": "具体的时代或年份",
    "location": "具体的地点或世界",
    "background": "2-3 句生动的背景描述，要有画面感"
  }},
  "key_variable": "被改变的核心历史变量（简明扼要）",
  "initial_title": "推演起点的标题（如：历史拐点、变局开端，8字以内）",
  "groups": [
    {{
      "name": "阵营/派系名称",
      "leader": "领袖角色名",
      "members": ["成员1名", "成员2名", "..."],
      "stance": "该阵营对核心变量的整体立场"
    }}
  ],
  "agents": [
    {{
      "name": "角色名（使用有辨识度的真实姓名）",
      "role": "角色身份/职位",
      "persona": "写出鲜明的性格特点、说话风格和核心动机（50字以内）",
      "stance": "对核心变量的立场 (支持/反对/中立/观望)",
      "tier": "CORE 或 IMPORTANT 或 CROWD",
      "group": "所属阵营名称（必须与 groups 中的 name 对应）"
    }}
  ],
  "simulation_rounds": 10,
  "branch_sensitivity": 0.7
}}

规则:
- 目标总角色数必须精确等于 {target_agents} 个
- 角色分层预算：{agent_plan}
- 将 {max_agents} 个角色分为 3-8 个阵营/派系
- 每个阵营需指定一个 leader（CORE tier）
- CORE Agent（各阵营领袖）: 3-8 个，负责代表整个阵营发言
- IMPORTANT: 每阵营 3-5 个核心成员
- CROWD: 每阵营若干普通成员（用于展示群众规模）
- groups 中的 members 列出该阵营所有成员名（包括 leader）
- 所有 agent 的 group 字段需对应一个 groups 中的 name
- simulation_rounds 范围 5-{max_rounds}
- branch_sensitivity: 0-1, 越高越容易产生分支 (建议 0.5-0.8)
- {language_directive}
- 角色的 persona 要具体生动
"""

PARSE_RETRY_PROMPT = """你上一次只返回了 {current_agents} 个角色，但目标是 {target_agents} 个。请重新生成完整结果，并严格满足数量要求。

用户问题: "{question}"

请输出与之前完全相同的 JSON 结构，并遵守以下额外约束：
- 目标总角色数必须精确等于 {target_agents} 个
- 角色分层预算：{agent_plan}
- simulation_rounds 范围 5-{max_rounds}
- {language_directive}
- 角色名必须唯一，不能重复
- 不要解释，不要 markdown，只返回 JSON
"""

_FALLBACK_AGENT_TEMPLATES_ZH = [
    ("边境联络官", "负责把前线变化翻译给不同派系，谨慎但不失行动力。"),
    ("资源调度员", "天天盯着补给与产能，说话务实，讨厌空话。"),
    ("民生观察员", "更在意普通人的日常感受，擅长从细节判断风险。"),
    ("安全协调员", "习惯先看系统性漏洞，再决定是否支持激进方案。"),
    ("现场记录员", "沉默寡言但记忆极强，善于指出被忽略的代价。"),
]

_FALLBACK_AGENT_TEMPLATES_EN = [
    ("Frontier Liaison", "Translates fast-changing frontline conditions across factions and acts with careful urgency."),
    ("Resource Dispatcher", "Obsesses over supply and throughput, speaks bluntly, and distrusts vague promises."),
    ("Civic Observer", "Tracks everyday consequences for ordinary people and spots risks in small details."),
    ("Safety Coordinator", "Looks for system-wide failure modes before supporting any radical turn."),
    ("Field Recorder", "Quiet, precise, and unusually good at surfacing costs everyone else is ignoring."),
]


def _build_agent_plan(target_agents: int) -> str:
    target = max(3, target_agents)
    if target <= 5:
        core = 3
        important = target - core
    elif target <= 10:
        core = 4
        important = min(4, target - core)
    else:
        core = 4
        important = min(8, max(4, round(target * 0.3)))
        if core + important > target:
            important = max(1, target - core)
    crowd = max(0, target - core - important)
    return f"CORE {core} / IMPORTANT {important} / CROWD {crowd}"


def _synthesize_missing_agents(
    agents: list[dict],
    *,
    target_agents: int,
    language: str,
    groups: list[dict] | None = None,
) -> list[dict]:
    if len(agents) >= target_agents:
        return agents

    templates = _FALLBACK_AGENT_TEMPLATES_ZH if language == "Chinese" else _FALLBACK_AGENT_TEMPLATES_EN
    existing_names = {agent.get("name", "") for agent in agents}
    missing = target_agents - len(agents)
    enriched_agents = list(agents)

    group_name = None
    if groups:
        smallest_group = min(groups, key=lambda item: len(item.get("members", [])))
        group_name = smallest_group.get("name")

    for index in range(missing):
        base_name, persona = templates[index % len(templates)]
        suffix = 1
        candidate_name = base_name
        while candidate_name in existing_names:
            suffix += 1
            candidate_name = f"{base_name}{suffix}" if language == "Chinese" else f"{base_name} {suffix}"
        existing_names.add(candidate_name)

        tier = "IMPORTANT" if len(enriched_agents) < 6 else "CROWD"
        agent = {
            "name": candidate_name,
            "role": base_name,
            "persona": persona,
            "stance": "观望" if language == "Chinese" else "neutral",
            "tier": tier,
        }
        if group_name:
            agent["group"] = group_name
            for group in groups or []:
                if group.get("name") == group_name:
                    group.setdefault("members", []).append(candidate_name)
                    break
        enriched_agents.append(agent)

    return enriched_agents


async def parse_question(
    question: str,
    *,
    max_agents: int = 30,
    target_agents: int | None = None,
    max_rounds: int = 15,
    hierarchical: bool = False,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> dict:
    """Parse a what-if question into structured scenario context.

    Args:
        question: The what-if question to parse.
        max_agents: Maximum number of agents to generate.
        target_agents: Preferred exact agent count requested by the user.
        max_rounds: Maximum simulation rounds.
        hierarchical: If True, use hierarchical prompt with groups.
        api_key: BYOK — override API key for this call.
        base_url: BYOK — override base URL for this call.
        model: BYOK — override model name for this call.

    Returns:
        dict with keys: setting, key_variable, agents, simulation_rounds, branch_sensitivity
        When hierarchical=True, also includes 'groups' key.
    """
    # Auto-detect user input language
    language = detect_language(question)
    lang_directive = get_language_directive(language)
    logger.info("Detected language: %s", language)
    requested_agents = min(target_agents or max_agents, max_agents)
    agent_plan = _build_agent_plan(requested_agents)

    if hierarchical:
        prompt = PARSE_PROMPT_HIERARCHICAL.format(
            question=question,
            max_agents=max_agents,
            target_agents=requested_agents,
            agent_plan=agent_plan,
            max_rounds=max_rounds,
            language_directive=lang_directive,
        )
    else:
        prompt = PARSE_PROMPT.format(
            question=question,
            max_agents=max_agents,
            target_agents=requested_agents,
            agent_plan=agent_plan,
            max_rounds=max_rounds,
            language_directive=lang_directive,
        )

    logger.info("Parsing question: %s (hierarchical=%s)", question[:80], hierarchical)
    result = await llm_call_json(
        prompt, reasoning_effort="low",
        api_key=api_key, base_url=base_url, model=model,
    )

    if len(result.get("agents", [])) < requested_agents:
        logger.warning(
            "Parser under-filled agents for '%s': got %d, requested %d. Retrying once.",
            question[:80], len(result.get("agents", [])), requested_agents,
        )
        retry_prompt = PARSE_RETRY_PROMPT.format(
            question=question,
            current_agents=len(result.get("agents", [])),
            target_agents=requested_agents,
            agent_plan=agent_plan,
            max_rounds=max_rounds,
            language_directive=lang_directive,
        )
        retry_result = await llm_call_json(
            retry_prompt, reasoning_effort="low",
            api_key=api_key, base_url=base_url, model=model,
        )
        if len(retry_result.get("agents", [])) >= len(result.get("agents", [])):
            result = retry_result

    # Validate structure
    if "setting" not in result:
        raise ValueError("Missing 'setting' in parse result")
    if "agents" not in result:
        raise ValueError("Missing 'agents' in parse result")
    if len(result.get("agents", [])) == 0:
        raise ValueError("No agents generated")

    # Validate groups in hierarchical mode
    if hierarchical:
        if "groups" not in result or len(result.get("groups", [])) == 0:
            logger.warning("Hierarchical mode but no groups returned; generating fallback groups")
            result["groups"] = _generate_fallback_groups(result["agents"])
        else:
            # Ensure all agents have a group field
            group_names = {g["name"] for g in result["groups"]}
            for agent in result["agents"]:
                if agent.get("group") not in group_names:
                    # Assign to first group as fallback
                    agent["group"] = result["groups"][0]["name"]

    # M-3 fix: Clamp agent count to max_agents (LLM may ignore the limit)
    if len(result["agents"]) > max_agents:
        logger.warning("LLM returned %d agents, clamping to %d", len(result["agents"]), max_agents)
        result["agents"] = result["agents"][:max_agents]

    # Small underfills are especially visible in the UI because the user explicitly
    # asked for a concrete agent count. Top them up with deterministic extras so the
    # gameplay surface matches the requested size.
    if len(result["agents"]) < requested_agents and requested_agents <= 12:
        logger.warning(
            "Parser still under-filled after retry: got %d, requested %d. Synthesizing extras.",
            len(result["agents"]), requested_agents,
        )
        result["agents"] = _synthesize_missing_agents(
            result["agents"],
            target_agents=requested_agents,
            language=language,
            groups=result.get("groups"),
        )

    # Clamp values
    result["simulation_rounds"] = min(max(result.get("simulation_rounds", 10), 3), max_rounds)
    result["branch_sensitivity"] = min(max(result.get("branch_sensitivity", 0.7), 0.0), 1.0)

    logger.info("Parsed: %d agents, %d rounds, sensitivity=%.2f, groups=%d",
                len(result["agents"]), result["simulation_rounds"],
                result["branch_sensitivity"], len(result.get("groups", [])))

    # Store detected language for downstream services
    result["_language"] = language

    return result


def _generate_fallback_groups(agents: list[dict]) -> list[dict]:
    """Generate fallback groups from agent stances when LLM doesn't return groups."""
    from collections import defaultdict
    stance_groups: dict[str, list[str]] = defaultdict(list)
    for agent in agents:
        stance = agent.get("stance", "中立")
        stance_groups[stance].append(agent["name"])

    groups = []
    for stance, members in stance_groups.items():
        # L-7 fix: Prefer CORE tier agent as leader over always taking first
        leader = members[0]  # default fallback
        for agent in agents:
            if agent["name"] in members and agent.get("tier", "").upper() == "CORE":
                leader = agent["name"]
                break
        groups.append({
            "name": f"{stance}派",
            "leader": leader,
            "members": members,
            "stance": stance,
        })
        # Tag agents with group
        for agent in agents:
            if agent["name"] in members:
                agent["group"] = f"{stance}派"

    return groups
