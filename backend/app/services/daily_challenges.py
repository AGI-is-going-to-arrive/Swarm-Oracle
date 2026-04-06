"""Daily challenge catalog and rotation helpers."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

DAILY_CHALLENGES: tuple[dict[str, Any], ...] = (
    {
        "id": "daily-ai-governance",
        "question": "如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？",
        "question_en": "What if artificial intelligence ruled the world and every nation were governed directly by algorithms?",  # noqa: E501
        "subtitle_zh": "治理博弈 · 中央算法与地方民意",
        "subtitle_en": "Governance Conflict · Algorithmic Rule vs Local Voice",
        "profile_id": "governance",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-roman-empire",
        "question": "如果罗马帝国从未衰落？",
        "question_en": "What if the Roman Empire never fell?",
        "subtitle_zh": "帝国统合 · 中央铁军与地方自治",
        "subtitle_en": "Imperial Balance · Central Order vs Provincial Autonomy",
        "profile_id": "empire",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-war-front",
        "question": "如果世界大战在高度自动化军备时代再次爆发？",
        "question_en": "What if a world war erupted again in an age of highly automated arsenals?",
        "subtitle_zh": "战争抉择 · 补给线与停火窗口",
        "subtitle_en": "War Doctrine · Supply Lines and Ceasefire Windows",
        "profile_id": "war",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-industry",
        "question": "如果工业革命提前一百年到来？",
        "question_en": "What if the Industrial Revolution arrived a hundred years earlier?",
        "subtitle_zh": "工业与资源 · 产能扩张与社会缓冲",
        "subtitle_en": "Industry and Resources · Throughput vs Social Buffering",
        "profile_id": "industry",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-frontier",
        "question": "如果人类在 2000 年就建立了火星殖民地？",
        "question_en": "What if humanity had established a colony on Mars by the year 2000?",
        "subtitle_zh": "边疆探索 · 远征速度与生存规则",
        "subtitle_en": "Frontier Expansion · Expedition Pace vs Survival Rules",
        "profile_id": "frontier",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-trade-chokepoint",
        "question": "如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？",
        "question_en": "What if the world’s most critical strait were permanently monopolized by a maritime trade consortium?",  # noqa: E501
        "subtitle_zh": "贸易绞盘 · 关税杠杆与港口封锁",
        "subtitle_en": "Trade Leverage · Tariff Pressure and Port Choke Points",
        "profile_id": "trade",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-legal-veto",
        "question": "如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？",
        "question_en": "What if the supreme court held an emergency veto that could pause every algorithmic policy?",  # noqa: E501
        "subtitle_zh": "法律红线 · 紧急否决与程序补丁",
        "subtitle_en": "Legal Red Lines · Emergency Vetoes and Procedural Patches",
        "profile_id": "law",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-faith-order",
        "question": "如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？",
        "question_en": "What if a single prophecy became the only legitimate basis for ruling an entire kingdom?",  # noqa: E501
        "subtitle_zh": "神权号角 · 圣谕改写与异端审判",
        "subtitle_en": "Sacred Order · Rewritten Prophecy and Heresy Trials",
        "profile_id": "faith",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-ecology-threshold",
        "question": "如果跨大陆淡水供应在十年内枯竭，会发生什么？",
        "question_en": "What if the cross-continental freshwater supply ran dry within a decade?",
        "subtitle_zh": "生态阈值 · 迁徙窗口与系统韧性",
        "subtitle_en": "Ecology Thresholds · Migration Windows and System Resilience",
        "profile_id": "ecology",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-mythic-pact",
        "question": "如果王国与巨龙订立的守护契约在一夜之间失效，会发生什么？",
        "question_en": "What if the kingdom’s protective pact with its dragons failed overnight?",
        "subtitle_zh": "神话秩序 · 龙契约与禁术代价",
        "subtitle_en": "Mythic Order · Dragon Pacts and Forbidden Costs",
        "profile_id": "mythic",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-survival-grid",
        "question": "如果最后一座避难城只能再维持三十天供电，会发生什么？",
        "question_en": "What if the last refuge city had only thirty days of power left?",
        "subtitle_zh": "生存极限 · 最后冗余与撤退路线",
        "subtitle_en": "Survival Pressure · Last Reserves and Retreat Routes",
        "profile_id": "survival",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
    {
        "id": "daily-generic-shuffle",
        "question": "如果所有大型组织都必须每周随机交换一次负责人，会发生什么？",
        "question_en": (
            "What if every major organization had to randomly swap its leader once a week?"
        ),
        "subtitle_zh": "通用博弈 · 关键分歧与隐藏议程",
        "subtitle_en": "General Tension · Core Frictions and Hidden Agendas",
        "profile_id": "generic",
        "rounds": 3,
        "num_agents": 3,
        "mode": "blackboard",
        "visualization_enabled": True,
    },
)
_DAILY_ROTATION_ORDER: tuple[str, ...] = (
    "daily-ai-governance",
    "daily-roman-empire",
    "daily-war-front",
    "daily-industry",
    "daily-frontier",
    "daily-trade-chokepoint",
    "daily-legal-veto",
    "daily-faith-order",
    "daily-ecology-threshold",
    "daily-mythic-pact",
    "daily-survival-grid",
    "daily-generic-shuffle",
)
_DAILY_CHALLENGE_BY_ID = {challenge["id"]: challenge for challenge in DAILY_CHALLENGES}


def _parse_local_date(local_date: str) -> date:
    return date.fromisoformat(local_date)


def _date_key(value: date) -> str:
    return value.isoformat()


def _rotation_catalog() -> tuple[dict[str, Any], ...]:
    catalog: list[dict[str, Any]] = []
    for challenge_id in _DAILY_ROTATION_ORDER:
        challenge = _DAILY_CHALLENGE_BY_ID.get(challenge_id)
        if challenge is None:
            raise RuntimeError(
                f"Daily challenge rotation references unknown challenge id: {challenge_id}"
            )
        catalog.append(challenge)
    return tuple(catalog)


def _day_index(local_date: date) -> int:
    epoch = date(1970, 1, 1)
    return (local_date - epoch).days


def challenge_week_key(local_date: str) -> str:
    target_date = _parse_local_date(local_date)
    monday_offset = 6 if target_date.weekday() == 6 else target_date.weekday()
    week_start = target_date - timedelta(days=monday_offset)
    return _date_key(week_start)


def get_today_challenge_definition(local_date: str) -> dict[str, Any]:
    target_date = _parse_local_date(local_date)
    catalog = _rotation_catalog()
    return catalog[_day_index(target_date) % len(catalog)].copy()


def get_weekly_challenge_definitions(local_date: str, count: int = 3) -> list[dict[str, Any]]:
    target_date = _parse_local_date(local_date)
    catalog = _rotation_catalog()
    week_index = _day_index(target_date) // 7
    start = (week_index * count) % len(catalog)
    return [
        catalog[(start + offset) % len(catalog)].copy()
        for offset in range(count)
    ]


def get_challenge_rotation(local_date: str, weekly_count: int = 3) -> dict[str, Any]:
    normalized_count = max(1, min(weekly_count, len(_rotation_catalog())))
    return {
        "local_date": local_date,
        "week_key": challenge_week_key(local_date),
        "today_challenge": get_today_challenge_definition(local_date),
        "weekly_challenges": get_weekly_challenge_definitions(local_date, normalized_count),
    }
