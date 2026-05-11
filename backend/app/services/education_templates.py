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
            "经典辩论入门题：从教学效率、情感联结、教育公平三个维度展开正反论证，"
            "适合首次体验辩论竞技场的学生。"
        ),
        "description_en": (
            "Entry-level debate motion exploring AI's role in teaching: efficiency, "
            "emotional bonding, and educational equity. Ideal for first-time debate users."
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
            "批判性思维训练：模拟一群信息消费者面对同一条争议性新闻时的反应，"
            "学生通过观察 Agent 的论证链条学习溯源、交叉验证与认知偏差识别。"
        ),
        "description_en": (
            "Critical-thinking exercise simulating diverse media consumers reacting to a "
            "contested news item; students learn source tracing, cross-validation, and "
            "cognitive-bias recognition."
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
            "历史反事实推演：让多位代表不同阶层（工匠、地主、农民、商人）的 Agent "
            "推演 200 年的另一种文明轨迹，培养历史想象力与因果链分析能力。"
        ),
        "description_en": (
            "Counterfactual history simulation across two centuries with agents representing "
            "artisans, landowners, peasants, and merchants — develops historical imagination "
            "and causal-chain reasoning."
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
            "科学探究：让气候学家、伦理学家、政策制定者与发展中国家代表在多轮中"
            "讨论地球工程的连锁反应，理解科学决策的复杂性与跨学科性。"
        ),
        "description_en": (
            "Science exploration with climatologists, ethicists, policymakers, and Global "
            "South representatives debating geoengineering cascades — illustrating the "
            "complexity and interdisciplinarity of science-policy decisions."
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
            "哲学伦理推演：让功利主义、义务论、美德伦理与契约论代表分别给出立场，"
            "通过反复辩驳让学生理解伦理框架的张力与现实工程取舍。"
        ),
        "description_en": (
            "Philosophical-ethics walkthrough where utilitarian, deontological, virtue, and "
            "contractarian agents argue self-driving dilemmas — exposes ethical framework "
            "tensions and engineering trade-offs."
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
            "经济学情景模拟：让劳动经济学家、企业主、低收入工人、政府官员与税务专家"
            "围绕 UBI 的供给侧、需求侧与财政约束展开多轮博弈，"
            "学生观察均衡点如何形成。"
        ),
        "description_en": (
            "Economics scenario where labor economists, business owners, low-income workers, "
            "officials, and tax experts negotiate UBI's supply, demand, and fiscal constraints "
            "across multiple rounds — students observe how equilibria emerge."
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
