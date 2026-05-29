"""Education scenario presets — predefined templates for classroom use."""

from __future__ import annotations

import copy
from typing import Any

TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "debate_basics",
        "category": "debate_training",
        "title_zh": "AI 是否应该替代教师？",
        "title_en": "Should AI replace teachers?",
        "description_zh": (
            "校董会想用 AI 导师把课后辅导成本压低 30%，班主任拿出两名学生的"
            "沉默记录：他们很快拿到答案，却没人发现已经跟不上。辩题卡在谁来"
            "承担那一次误读。"
        ),
        "description_en": (
            "The school board wants AI tutors to cut after-school support costs by 30%. "
            "A homeroom teacher brings notes on two quiet students: they got quick answers, "
            "but no adult noticed they were lost. The vote turns on who owns that missed signal."
        ),
        "difficulty": "beginner",
        "suggested_agents": 4,
        "suggested_rounds": 5,
        "tags": ["education", "AI", "ethics"],
        "default_config": {
            "mode": "debate",
            "visualization_enabled": True,
        },
    },
    {
        "id": "critical_thinking_media",
        "category": "critical_thinking",
        "title_zh": "如何识别社交媒体上的虚假信息？",
        "title_en": "How can we identify misinformation on social media?",
        "description_zh": (
            "班级群里一段视频声称市长要取消免费午餐，转发按钮已经按到一半；"
            "本地记者却指出时间戳错位，音频有剪接痕迹。小组得先决定：先发，"
            "还是先追到第一条来源。"
        ),
        "description_en": (
            "A class chat receives a viral clip claiming the mayor will cancel free lunches. "
            "One student is ready to repost before it disappears; a local reporter points to "
            "a bad timestamp and spliced audio. The group has to choose between sharing first "
            "and tracing the first source."
        ),
        "difficulty": "intermediate",
        "suggested_agents": 6,
        "suggested_rounds": 7,
        "tags": ["education", "media-literacy", "critical-thinking"],
        "default_config": {
            "mode": "blackboard",
            "visualization_enabled": True,
        },
    },
    {
        "id": "historical_industrial_revolution",
        "category": "historical_simulation",
        "title_zh": "如果工业革命没有发生，世界会怎样？",
        "title_en": "What if the Industrial Revolution never happened?",
        "description_zh": (
            "曼彻斯特行会压住蒸汽纺机许可，商人却拿着三船棉布订单逼议会开禁；"
            "农户担心地租上涨，矿主等着铁路资金。Agent 从这场会议起步，追踪"
            "谁能把能源、城市和殖民贸易拉到自己一边。"
        ),
        "description_en": (
            "A Manchester guild blocks licenses for steam-powered spinning while merchants "
            "wave orders for three ships of cotton cloth. Farmers fear higher rents; mine "
            "owners wait for railway money. Agents start at that council meeting and track "
            "who pulls energy, cities, and colonial trade into their camp."
        ),
        "difficulty": "advanced",
        "suggested_agents": 8,
        "suggested_rounds": 10,
        "tags": ["education", "history", "counterfactual"],
        "default_config": {
            "mode": "blackboard",
            "visualization_enabled": True,
        },
    },
    {
        "id": "science_climate_intervention",
        "category": "science_exploration",
        "title_zh": "全球部署平流层气溶胶会发生什么？",
        "title_en": "What happens if we deploy stratospheric aerosols globally?",
        "description_zh": (
            "气候学家主张趁下一次高温峰值前试喷气溶胶，岛国代表先把损失补偿"
            "和季风风险摆上桌。资金方只给 18 个月窗口，这场推演卡在谁有权"
            "按下暂停键。"
        ),
        "description_en": (
            "A climatologist wants a test spray before the next heat peak; an island-state "
            "delegate puts compensation and monsoon risk on the table first. Funders give "
            "only an 18-month window, so the scenario hinges on who can pause the launch."
        ),
        "difficulty": "advanced",
        "suggested_agents": 6,
        "suggested_rounds": 8,
        "tags": ["education", "science", "climate", "ethics"],
        "default_config": {
            "mode": "blackboard",
            "visualization_enabled": True,
        },
    },
    {
        "id": "philosophy_trolley_variants",
        "category": "philosophy",
        "title_zh": "电车难题的现代变体：自动驾驶应如何取舍？",
        "title_en": "Modern trolley problem: how should autonomous vehicles choose?",
        "description_zh": (
            "雨夜测试日志里同时出现闯红灯的孩子和车内心脏病乘客，自动驾驶团队"
            "第二天就要冻结决策规则。律师盯着责任，残障权益代表追问规则会把谁"
            "算成可牺牲的人；会议没有现成正确答案。"
        ),
        "description_en": (
            "A rainy-night test log puts a child running a red light and a passenger with a "
            "heart condition in the same decision. The autonomous-vehicle team has to freeze "
            "the rule the next day. The lawyer watches liability; a disability-rights advocate "
            "asks whose body the rule treats as expendable."
        ),
        "difficulty": "intermediate",
        "suggested_agents": 4,
        "suggested_rounds": 6,
        "tags": ["education", "philosophy", "ethics", "AI"],
        "default_config": {
            "mode": "debate",
            "visualization_enabled": True,
        },
    },
    {
        "id": "economics_universal_basic_income",
        "category": "economics",
        "title_zh": "全民基本收入会改变劳动力市场吗？",
        "title_en": "Would Universal Basic Income reshape the labor market?",
        "description_zh": (
            "一家机器人仓库运营商裁掉 1,200 人后，市长提出每月 1,000 美元 UBI "
            "试点；杂货店老板担心房租被推高，单亲护理员想辞掉夜班，税务官说"
            "销售税补不上缺口。小组先谈钱从哪来，再争雇主会不会趁机压工资。"
        ),
        "description_en": (
            "After a robotic warehouse operator cuts 1,200 jobs, the mayor proposes a "
            "$1,000-a-month UBI pilot. A grocer worries rent will rise, a single parent wants "
            "to leave the night shift, and the tax officer says sales tax cannot fill the gap. "
            "The group debates funding first, then whether employers will push wages down."
        ),
        "difficulty": "intermediate",
        "suggested_agents": 6,
        "suggested_rounds": 7,
        "tags": ["education", "economics", "policy"],
        "default_config": {
            "mode": "blackboard",
            "visualization_enabled": True,
        },
    },
]

VALID_CATEGORIES = frozenset(str(t["category"]) for t in TEMPLATES)
VALID_DIFFICULTIES = frozenset({"beginner", "intermediate", "advanced"})
_VALID_DIFFICULTIES = VALID_DIFFICULTIES
_VALID_LANGUAGES = {"zh", "en"}


def list_templates(
    category: str | None = None,
    difficulty: str | None = None,
) -> list[dict[str, Any]]:
    """Return templates filtered by optional category and difficulty."""
    results = TEMPLATES
    if category is not None:
        normalized_cat = category.strip()
        results = [t for t in results if t["category"] == normalized_cat]
    if difficulty is not None:
        normalized_diff = difficulty.strip().lower()
        results = [t for t in results if t["difficulty"] == normalized_diff]
    return [copy.deepcopy(t) for t in results]


def get_template(template_id: str) -> dict[str, Any] | None:
    """Return a single template by ID, or None if not found."""
    if not template_id:
        return None
    normalized = template_id.strip()
    for template in TEMPLATES:
        if template["id"] == normalized:
            return copy.deepcopy(template)
    return None


def instantiate_template(
    template_id: str,
    language: str = "zh",
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Convert a template into a CreateScenarioRequest-compatible dict.

    The returned dict applies language selection (title_zh/title_en → question)
    and merges user overrides on top of the template's default_config plus the
    suggested agent/round counts.
    """
    template = get_template(template_id)
    if template is None:
        raise ValueError(f"Template not found: {template_id}")

    lang = (language or "zh").strip().lower()
    if lang not in _VALID_LANGUAGES:
        lang = "zh"

    question = template["title_zh"] if lang == "zh" else template["title_en"]

    request: dict[str, Any] = {
        "question": question,
        "num_agents": template["suggested_agents"],
        "rounds": template["suggested_rounds"],
        "template_id": template["id"],
        "template_category": template["category"],
        "template_difficulty": template["difficulty"],
        "language": lang,
    }
    request.update(template.get("default_config", {}))

    if overrides:
        request.update(overrides)

    return request
