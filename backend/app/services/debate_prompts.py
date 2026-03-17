"""Deterministic debate copy builders for Track D / Phase D1.

The first backend slice avoids depending on an external LLM so the debate
domain stays testable, fast, and safe to iterate on. The API surface is still
structured for later prompt-driven upgrades.
"""

from __future__ import annotations

import re

from app.models import DebatePhase, DebateSide
from app.services.lang_detect import detect_language

_WHITESPACE_RE = re.compile(r"\s+")

_PROFILE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "law": ("law", "legal", "court", "judge", "constitution", "regulation", "ban", "veto", "审判", "法律", "法庭", "合宪", "禁令", "否决权"),
    "governance": ("governance", "democracy", "vote", "election", "state", "senate", "policy", "committee", "board", "budget", "政府", "治理", "民主", "选举", "议会", "委员会", "预算"),
    "war": ("war", "military", "army", "navy", "invasion", "battle", "战争", "军事", "入侵", "战役"),
    "empire": ("empire", "dynasty", "emperor", "imperial", "colonial", "帝国", "王朝", "皇帝", "殖民"),
    "industry": ("factory", "industry", "industrial", "automation", "energy", "工厂", "工业", "自动化", "电网"),
    "trade": ("trade", "market", "port", "tariff", "supply chain", "贸易", "市场", "关税", "物流"),
    "faith": ("faith", "religion", "church", "temple", "god", "宗教", "信仰", "神殿", "教会"),
    "ecology": ("climate", "forest", "river", "ecology", "pollution", "生态", "气候", "森林", "污染"),
    "frontier": ("frontier", "colony", "settlement", "mars", "expansion", "边疆", "殖民地", "拓荒", "火星"),
    "mythic": ("magic", "myth", "oracle", "curse", "dragon", "神话", "魔法", "预言", "禁术"),
    "survival": ("survival", "plague", "famine", "collapse", "refuge", "生存", "瘟疫", "饥荒", "避难"),
}

_PROFILE_SCENES = {
    "law": "debate_arena_judicial",
    "governance": "debate_arena_civic",
    "war": "debate_arena_forum",
    "empire": "debate_arena_forum",
    "industry": "debate_arena_forum",
    "trade": "debate_arena_forum",
    "faith": "debate_arena_forum",
    "ecology": "debate_arena_civic",
    "frontier": "debate_arena_forum",
    "mythic": "debate_arena_forum",
    "survival": "debate_arena_forum",
    "generic": "debate_arena_forum",
}

KNOWN_DEBATE_PROFILES = frozenset({*_PROFILE_KEYWORDS.keys(), "generic"})

_PROFILE_LABELS_ZH = {
    "governance": "治理",
    "war": "战争",
    "empire": "帝国",
    "industry": "工业",
    "trade": "贸易",
    "law": "法政",
    "faith": "信仰",
    "ecology": "生态",
    "frontier": "边疆",
    "mythic": "神话",
    "survival": "生存",
    "generic": "议场",
}


def normalize_question(question: str, *, max_length: int = 160) -> str:
    compact = _WHITESPACE_RE.sub(" ", question).strip()
    if len(compact) <= max_length:
        return compact
    return f"{compact[: max_length - 1].rstrip()}..."


def resolve_debate_language(question: str) -> str:
    return "zh" if detect_language(question) == "Chinese" else "en"


def infer_debate_profile(question: str) -> str:
    normalized = question.lower()
    best_profile = "generic"
    best_hits = 0
    for profile_id, keywords in _PROFILE_KEYWORDS.items():
        hits = sum(1 for keyword in keywords if keyword.lower() in normalized)
        if hits > best_hits:
            best_profile = profile_id
            best_hits = hits
    return best_profile


def select_debate_scene(profile_id: str) -> str:
    return _PROFILE_SCENES.get(profile_id, _PROFILE_SCENES["generic"])


def build_motion(question: str, language: str) -> str:
    compact = normalize_question(question)
    if language == "zh":
        return f"本院动议：是否应推动这条假设世界线成为现实？{compact}"
    return f"Motion: This house should advance the following worldline: {compact}"


def build_cast(language: str, profile_id: str) -> dict[str, dict[str, str]]:
    if language == "zh":
        label = _PROFILE_LABELS_ZH.get(profile_id, "议场")
        return {
            "proposition": {"name": "正方席", "role": f"{label} 推进派"},
            "opposition": {"name": "反方席", "role": f"{label} 审慎派"},
            "judge": {"name": "裁决席", "role": "结构化评委"},
        }
    return {
        "proposition": {"name": "Proposition", "role": f"{profile_id.title()} Vanguard"},
        "opposition": {"name": "Opposition", "role": f"{profile_id.title()} Skeptic"},
        "judge": {"name": "Judge", "role": "Structured Arbiter"},
    }


def build_turn_copy(
    *,
    language: str,
    phase: DebatePhase,
    side: DebateSide,
    motion: str,
    question: str,
    profile_id: str,
    verdict_tone: str | None = None,
    winner: str | None = None,
) -> str:
    compact = normalize_question(question, max_length=96)
    if language == "zh":
        return _build_turn_copy_zh(
            phase=phase,
            side=side,
            motion=motion,
            compact_question=compact,
            profile_id=profile_id,
            verdict_tone=verdict_tone,
            winner=winner,
        )
    return _build_turn_copy_en(
        phase=phase,
        side=side,
        motion=motion,
        compact_question=compact,
        profile_id=profile_id,
        verdict_tone=verdict_tone,
        winner=winner,
    )


def _build_turn_copy_zh(
    *,
    phase: DebatePhase,
    side: DebateSide,
    motion: str,
    compact_question: str,
    profile_id: str,
    verdict_tone: str | None,
    winner: str | None,
) -> str:
    profile_label = _PROFILE_LABELS_ZH.get(profile_id, "议场")
    if phase == DebatePhase.OPENING and side == DebateSide.PROPOSITION:
        return f"我方支持这项动议。若围绕“{compact_question}”主动布局，{profile_label} 体系会获得先手，并把不确定性转成可治理的秩序。"
    if phase == DebatePhase.OPENING and side == DebateSide.OPPOSITION:
        return f"我方反对。动议把收益叙事说得太轻松，却低估了执行代价、反噬速度与制度脆弱面。"
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.PROPOSITION:
        return f"反方不断强调风险，却没有说明在不推动这条世界线时，如何处理已经暴露的压力与机会窗口。"
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.OPPOSITION:
        return f"正方把愿景当成证据。请正面回答：谁来承担失败成本，哪一层规则会首先失守？"
    if phase == DebatePhase.REBUTTAL and side == DebateSide.PROPOSITION:
        return f"我方并非否认代价，而是主张分阶段落地：先建立护栏，再释放增量，这比长期犹豫更稳。"
    if phase == DebatePhase.REBUTTAL and side == DebateSide.OPPOSITION:
        return f"所谓分阶段落地并没有消除根本漏洞，只是把风险从显性冲突延后成更难收拾的系统债。"
    if phase == DebatePhase.CLOSING and side == DebateSide.PROPOSITION:
        return f"结论很简单：动议不是盲目冒进，而是在承认摩擦的前提下争取更高上限。"
    if phase == DebatePhase.CLOSING and side == DebateSide.OPPOSITION:
        return f"我的结论也很明确：当关键证据尚未闭合时，克制本身就是更负责任的选择。"
    if phase == DebatePhase.VERDICT:
        outcome = "正方" if winner == "proposition" else "反方"
        tone_label = {
            "order": "秩序",
            "balance": "均衡",
            "rupture": "断裂",
        }.get(verdict_tone or "", "均衡")
        return f"裁决：{outcome}获胜。本场主导判词是“{tone_label}”。双方都形成了有效张力，但胜方在关键转折点上更能把论点落到可执行后果。"
    return motion


def _build_turn_copy_en(
    *,
    phase: DebatePhase,
    side: DebateSide,
    motion: str,
    compact_question: str,
    profile_id: str,
    verdict_tone: str | None,
    winner: str | None,
) -> str:
    if phase == DebatePhase.OPENING and side == DebateSide.PROPOSITION:
        return f"We support the motion. Around '{compact_question}', an active {profile_id} push converts uncertainty into governable leverage."
    if phase == DebatePhase.OPENING and side == DebateSide.OPPOSITION:
        return "We oppose the motion. The upside story is overstated, while execution cost, backlash speed, and institutional fragility are understated."
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.PROPOSITION:
        return "Opposition keeps naming risks without explaining how the status quo handles the same pressure and missed opportunities."
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.OPPOSITION:
        return "Proposition is treating aspiration as evidence. Who absorbs the failure cost, and which rule layer breaks first?"
    if phase == DebatePhase.REBUTTAL and side == DebateSide.PROPOSITION:
        return "We are not denying trade-offs. We are sequencing them: establish guardrails first, then unlock upside in controlled steps."
    if phase == DebatePhase.REBUTTAL and side == DebateSide.OPPOSITION:
        return "Sequencing does not remove the core flaw. It merely delays the instability until the system is more exposed."
    if phase == DebatePhase.CLOSING and side == DebateSide.PROPOSITION:
        return "The choice is not recklessness versus caution. It is whether we can claim the upside while managing the cost with discipline."
    if phase == DebatePhase.CLOSING and side == DebateSide.OPPOSITION:
        return "My closing point is simple: restraint is the more defensible strategy when the evidentiary base is still incomplete."
    if phase == DebatePhase.VERDICT:
        tone_label = {
            "order": "order",
            "balance": "balance",
            "rupture": "rupture",
        }.get(verdict_tone or "", "balance")
        winner_label = "Proposition" if winner == "proposition" else "Opposition"
        return f"Verdict: {winner_label} wins. The dominant tone is {tone_label}. Both sides produced tension, but the winner converted its key turn into more actionable consequences."
    return motion
