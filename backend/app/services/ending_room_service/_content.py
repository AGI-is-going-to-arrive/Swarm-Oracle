"""Oracle voice, vocabulary hints, content builders, and LLM rewrite functions."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from sqlmodel import Session

from app.config import settings
from app.models import (
    EndingRoom,
    EndingRoomInteractionMode,
    EndingRoomParticipant,
    EndingRoomPhase,
    EndingRoomRoleSlot,
    EndingRoomThread,
    EndingRoomThreadMode,
    EndingRoomType,
    Scenario,
)
from app.models.database import get_engine
from app.services.debate_prompts import get_debate_profile_style, infer_debate_profile
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    _strip_reasoning_blocks,
    format_untrusted_text_block,
    llm_request_scope,
)

from ._utils import (
    _BIO_SHORT_MAX_CHARS,
    _ORACLE_FOLLOWUP_STREAM_TIMEOUT_SECONDS,
    _ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
    _ORACLE_STREAM_PROBE_TIMEOUT_SECONDS,
    _build_participant_followup_evidence,
    _oracle_visible_clause,
    _oracle_visible_text,
    _roundtable_branch_hook,
    _stable_oracle_choice,
    sanitize_untrusted_text,
)

logger = logging.getLogger(__name__)


def _roundtable_participant_variant(participant: EndingRoomParticipant | None) -> str:
    snapshot = participant.persona_snapshot_json if participant is not None else {}
    role_hint = str((snapshot or {}).get("agent_role") or "").strip()
    bio_hint = str(
        (snapshot or {}).get("bio_short") or (snapshot or {}).get("agent_persona") or ""
    ).strip()
    return _oracle_role_voice_variant(role_hint, bio_hint)


def _roundtable_variant_hook_fallback(
    *,
    variant: str,
    language: str,
    seed: str,
) -> str:
    if language == "zh":
        fallback_map = {
            "imperial": [
                "号令不再只穿过一个中枢",
                "朝廷再压不回同一条命令链",
                "体面与军令开始各走各的",
            ],
            "field": ["前线先被掏空了", "轮换和粮道先脱了节", "防线先被拖成空壳"],
            "finance": ["清算和信心先一起松了", "流动性先被抽出了缝", "挤兑预期先跑在前面了"],
            "market": ["客流和现钱周转先乱了", "摊位秩序先被挤坏了", "街面现金链先断了气"],
            "faith": ["誓约和共同体信任先松了", "祭仪边界先裂开了", "神圣名义先压不住人心了"],
            "industry": ["调度节拍和备援先脱了钩", "产能链先弯了腰", "维保欠账先浮上来了"],
            "frontier": [
                "补给窗口和生命维持先吃紧了",
                "轨道节拍先滑开了",
                "护航与补给先对不上拍了",
            ],
            "survival": [
                "避难位和口粮余量先不够了",
                "药品和撤离顺序先扛不住了",
                "生存缓冲先被挤穿了",
            ],
            "scholar": ["证词、账册和时序先对不上了", "记录链先漏页了", "案卷先开始彼此打架了"],
            "civic": ["账册和责任链先对不上了", "程序和签字链先漏了口子", "谁来背责先没人说得清了"],
            "plain": ["真正先滑开的那一下", "因果链先失了准头", "代价最早开始滚动的地方"],
        }
    else:
        fallback_map = {
            "imperial": [
                "the command chain no longer ran through one center",
                "authority split before the court could force it back into line",
                "the order stopped traveling through a single throne",
            ],
            "field": [
                "the front line was left hollow",
                "rotation and supply fell out of step",
                "the shield line had to hold without depth",
            ],
            "finance": [
                "settlement and confidence loosened together",
                "the clearing rail slipped before trust could be rebuilt",
                "liquidity strain outran the public reassurance",
            ],
            "market": [
                "cash rotation and stall order broke first",
                "foot traffic fell before anyone admitted the damage",
                "the market floor lost rhythm before the officials found words",
            ],
            "faith": [
                "vows and communal trust lost force first",
                "ritual authority cracked before the breach could be named",
                "the covenant frayed before the room admitted it",
            ],
            "industry": [
                "dispatch rhythm and backup capacity slipped first",
                "throughput bent before the system could rebalance",
                "maintenance debt surfaced before output could be defended",
            ],
            "frontier": [
                "the supply window and life-support margin tightened first",
                "orbital timing slipped before the frontier could recover",
                "the convoy gap opened before anyone could close it",
            ],
            "survival": [
                "shelter, medicine, and ration slack ran thin first",
                "the evacuation order slipped before relief arrived",
                "the survival margin collapsed before the speeches caught up",
            ],
            "scholar": [
                "the record, the testimony, and the timeline stopped lining up",
                "the ledger broke sequence before the verdict was named",
                "the evidence trail frayed before the room admitted it",
            ],
            "civic": [
                "the ledger and the chain of responsibility stopped lining up",
                "the explanation chain broke before the paperwork could catch it",
                "procedure stopped holding the damage inside one accountable line",
            ],
            "plain": [
                "the line of cause and cost slipped out of alignment",
                "the first real slip came before anyone named the ending",
                "the hinge gave way before the result could be defended",
            ],
        }
    choices = fallback_map.get(variant) or fallback_map["plain"]
    return _stable_oracle_choice(seed, choices)


def _resolve_roundtable_hook(
    branch_card: dict[str, Any],
    *,
    participant: EndingRoomParticipant | None,
    language: str,
) -> str:
    visible_hook = _roundtable_branch_hook(branch_card, language=language)
    generic_hook = "当前世界线" if language == "zh" else "the first decisive hinge"
    if visible_hook != generic_hook:
        return visible_hook
    variant = _roundtable_participant_variant(participant)
    seed = "|".join(
        [
            language,
            variant,
            str(branch_card.get("title") or ""),
            str(branch_card.get("insight") or ""),
            str(branch_card.get("story") or ""),
            str(participant.display_name if participant is not None else ""),
        ]
    )
    return _roundtable_variant_hook_fallback(variant=variant, language=language, seed=seed)


def _oracle_role_voice_variant(role_hint: str | None, bio_hint: str | None) -> str:
    normalized = f"{role_hint or ''} {bio_hint or ''}".strip().lower()
    if any(
        token in normalized
        for token in (
            "皇", "贵族", "公爵", "亲王", "王储",
            "king", "queen", "emperor", "crown", "court",
            "noble", "duke", "lord", "baron", "prince", "princess",
            "regent", "viceroy",
        )
    ):
        return "imperial"
    if any(
        token in normalized
        for token in (
            "将", "统帅", "指挥官", "舰队", "参谋", "军师", "元帅",
            "commander", "captain", "marshal", "fleet", "guard",
            "general", "warlord", "chieftain", "warrior", "admiral",
            "colonel", "sergeant", "lieutenant",
        )
    ):
        return "field"
    if any(
        token in normalized
        for token in (
            "银行", "行长", "财政", "金融", "清算", "流动性",
            "审计", "会计", "投资",
            "bank", "banker", "finance", "treasury", "settlement", "liquidity",
            "accountant", "auditor", "investor", "broker",
        )
    ):
        return "finance"
    if any(
        token in normalized
        for token in (
            "摊主", "商户", "商贩", "市场", "港口", "贸易", "货运",
            "店主", "掌柜", "酒馆", "农夫", "工匠", "手艺人",
            "vendor", "merchant", "market", "port", "trade", "freight",
            "shopkeeper", "innkeeper", "tavern", "farmer", "craftsman", "artisan",
        )
    ):
        return "market"
    if any(
        token in normalized
        for token in (
            "祭司", "祭坛", "神官", "修士", "神谕", "僧", "和尚", "主教", "教会",
            "priest", "cleric", "oracle", "temple", "faith", "ritual", "covenant",
            "monk", "bishop", "cardinal", "church", "monastery", "abbey",
        )
    ):
        return "faith"
    if any(
        token in normalized
        for token in (
            "工程", "工厂", "电网", "产能", "后勤", "调度",
            "技师", "矿", "工头",
            "engineer", "factory", "industrial", "grid", "throughput",
            "logistics", "plant",
            "technician", "mechanic", "foreman", "miner", "mining",
        )
    ):
        return "industry"
    if any(
        token in normalized
        for token in (
            "边疆", "拓荒", "殖民", "轨道", "补给舱", "生命维持",
            "宇航", "航天", "探险",
            "pilot", "orbital", "frontier", "colony", "expedition", "convoy",
            "airlock", "life support",
            "astronaut", "navigator", "explorer",
        )
    ):
        return "frontier"
    if any(
        token in normalized
        for token in (
            "避难", "药品", "口粮", "撤离", "医疗",
            "医生", "大夫", "护士",
            "scout", "medic", "refuge", "ration", "evacuation",
            "shelter", "survival",
            "doctor", "physician", "surgeon", "nurse", "paramedic",
        )
    ):
        return "survival"
    if any(
        token in normalized
        for token in (
            "史官", "书记官", "学者", "档案", "证人",
            "scribe", "scholar", "historian", "witness", "record", "ledger", "clerk",
        )
    ):
        return "scholar"
    if any(
        token in normalized
        for token in (
            "议长", "文书", "总督", "知府", "太守", "官员", "大臣", "县令",
            "speaker", "minister", "council",
            "governor", "mayor", "senator", "representative",
            "magistrate", "congressman", "alderman", "prefect",
        )
    ):
        return "civic"
    if any(
        token in normalized
        for token in (
            "外交", "大使", "使节", "使者", "领事",
            "diplomat", "ambassador", "envoy", "consul", "emissary", "negotiator",
        )
    ):
        return "diplomat"
    if any(
        token in normalized
        for token in (
            "顾问", "谋士", "谋臣", "幕僚", "参赞",
            "advisor", "strategist", "counselor", "aide", "consultant",
        )
    ):
        return "advisor"
    if any(
        token in normalized
        for token in (
            "科学", "研究员", "实验", "分析师",
            "scientist", "researcher", "analyst", "laboratory",
        )
    ):
        return "science"
    return "plain"

# ── Persona Vocabulary Hints ──────────────────────────────────────

_VOCABULARY_HINTS: dict[str, dict[str, str]] = {
    "imperial": {
        "zh": "用词偏好：旨意、承祚、正朔、廷议、法度、署令。句式简短命令式，忌长句解释。情绪基调：冷厉克制。",  # noqa: E501
        "en": "Vocabulary: decree, mandate, succession, court, edict, sovereign. Clipped imperative sentences. Tone: cold authority.",  # noqa: E501
    },
    "field": {
        "zh": "用词偏好：防线、粮道、侧翼、轮换、伤亡数、战损比。句式短平快，先结论后补充。情绪基调：铁血不留情面。",  # noqa: E501
        "en": "Vocabulary: line, flank, rotation, attrition, supply route, casualties. Short declarative style. Tone: unsentimental steel.",  # noqa: E501
    },
    "finance": {
        "zh": "用词偏好：头寸、敞口、清算窗口、信用差、票据、对手方。爱用比率与绝对数混合。情绪基调：冷静但暗藏警告。",  # noqa: E501
        "en": "Vocabulary: exposure, position, clearing window, credit spread, counterparty, settlement. Mix ratios with absolutes. Tone: calm warning.",  # noqa: E501
    },
    "market": {
        "zh": "用词偏好：进货价、日流水、摊位费、客流、赊账、尾货。从街面感受讲起。情绪基调：精明带怨气。",  # noqa: E501
        "en": "Vocabulary: foot traffic, cost price, stall rent, cash rotation, consignment, dead stock. Ground-level framing. Tone: shrewd grievance.",  # noqa: E501
    },
    "faith": {
        "zh": "用词偏好：誓约、裂痕、祭仪、托付、圣所、信众。爱用设问和反问。情绪基调：沉痛但不软弱。",  # noqa: E501
        "en": "Vocabulary: covenant, fracture, rite, sanctuary, flock, consecration. Rhetorical questions welcome. Tone: solemn grief.",  # noqa: E501
    },
    "industry": {
        "zh": "用词偏好：产能、维保欠账、调度周期、冗余容量、停机、负荷。数据先行。情绪基调：务实不耐烦。",  # noqa: E501
        "en": "Vocabulary: throughput, maintenance debt, dispatch cycle, spare capacity, downtime, load. Data-first framing. Tone: pragmatic impatience.",  # noqa: E501
    },
    "frontier": {
        "zh": "用词偏好：补给窗口、轨道衰减、气闸、生命维持余量、护航编队。用倒计时感营造紧迫。情绪基调：压抑但精确。",  # noqa: E501
        "en": "Vocabulary: supply window, orbital decay, airlock, life-support margin, convoy escort. Countdown urgency. Tone: compressed precision.",  # noqa: E501
    },
    "survival": {
        "zh": "用词偏好：配给、避难槽位、诊所容量、撤离序列、水源净化率。街头视角。情绪基调：疲惫但坚定。",  # noqa: E501
        "en": "Vocabulary: ration, shelter slot, clinic capacity, evacuation order, water purification rate. Street-level triage. Tone: weary resolve.",  # noqa: E501
    },
    "scholar": {
        "zh": "用词偏好：案卷、证词、时序、缺页、笔录、佐证。爱用'然而记录显示'式转折。情绪基调：克制的较真。",  # noqa: E501
        "en": "Vocabulary: ledger, testimony, chronology, missing entry, deposition, corroboration. 'However the record shows' pivots. Tone: restrained pedantry.",  # noqa: E501
    },
    "civic": {
        "zh": "用词偏好：议程、动议、记录在案、职权范围、审计、问责。程序化措辞。情绪基调：冷淡的程序正义。",  # noqa: E501
        "en": "Vocabulary: agenda, motion, on record, jurisdiction, audit, accountability. Procedural phrasing. Tone: cold due process.",  # noqa: E501
    },
    "diplomat": {
        "zh": "用词偏好：照会、斡旋、条款、利害方、退让底线、立场分歧。句式迂回但精确。情绪基调：克制的压力。",  # noqa: E501
        "en": "Vocabulary: memorandum, mediation, terms, stakeholder, red line, leverage, concession. Circuitous but precise phrasing. Tone: measured pressure.",  # noqa: E501
    },
    "advisor": {
        "zh": "用词偏好：局势研判、可选项、代价、风险敞口、窗口期、变量。先摆选项再给倾向。情绪基调：冷静抽离。",  # noqa: E501
        "en": "Vocabulary: assessment, options, cost, risk exposure, window, variable, trade-off. Options-first framing. Tone: detached clarity.",  # noqa: E501
    },
    "science": {
        "zh": "用词偏好：样本量、置信区间、控制变量、复现、偏差、模型假设。数据驱动表达。情绪基调：审慎的好奇。",  # noqa: E501
        "en": "Vocabulary: sample size, confidence interval, control variable, reproducibility, bias, model assumption. Data-driven expression. Tone: cautious curiosity.",  # noqa: E501
    },
}

_ARCHIVIST_VOCABULARY_HINT: dict[str, str] = {
    "zh": "用词偏好：关键转折、各方、权衡、裁定、总览。句式：先判断后引用。情绪基调：公允但不温吞。",  # noqa: E501
    "en": "Vocabulary: pivot, parties, trade-off, ruling, overview. Judge-first-then-cite structure. Tone: fair but sharp.",  # noqa: E501
}


def _oracle_prompt_text(value: str | None, *, limit: int = 180) -> str | None:
    text = sanitize_untrusted_text(str(value or ""), max_chars=limit)
    return text or None


def _append_oracle_context_text(
    lines: list[str],
    *,
    key: str,
    value: str | None,
    language: str,
    limit: int = 180,
) -> None:
    raw_text = _oracle_prompt_text(value, limit=limit)
    if not raw_text:
        return
    visible_text = _oracle_visible_text(value, language=language, limit=limit)
    if visible_text:
        lines.append(f"{key}={visible_text}")
        if language == "en" and raw_text != visible_text:
            lines.append(f"{key}_source={raw_text}")
        return
    lines.append(f"{key}_source={raw_text}")


def _oracle_static_vocabulary_hint(
    role_slot: "EndingRoomRoleSlot",
    variant: str,
    language: str,
) -> str:
    lang_key = "zh" if language.startswith("zh") else "en"
    if role_slot == EndingRoomRoleSlot.ARCHIVIST:
        return _ARCHIVIST_VOCABULARY_HINT.get(lang_key, "")
    return _VOCABULARY_HINTS.get(variant, {}).get(lang_key, "")


def _oracle_identity_vocabulary_hint(
    language: str,
    persona_snapshot: dict[str, Any] | None,
) -> str:
    """Build sanitized persona-derived vocabulary context."""
    lang_key = "zh" if language.startswith("zh") else "en"
    is_zh = lang_key == "zh"
    snapshot = persona_snapshot or {}
    identity_parts: list[str] = []

    agent_role = sanitize_untrusted_text(str(snapshot.get("agent_role") or ""), max_chars=80)
    bio_short = sanitize_untrusted_text(
        str(snapshot.get("bio_short") or snapshot.get("agent_persona") or ""),
        max_chars=_BIO_SHORT_MAX_CHARS,
    )
    impact = snapshot.get("impact_score")
    tier = str(snapshot.get("tier") or "").strip().upper()
    turn_count = snapshot.get("turn_count")
    key_moments = snapshot.get("key_moment_hits")
    branch_pressure = sanitize_untrusted_text(
        str(snapshot.get("branch_pressure") or ""),
        max_chars=_BIO_SHORT_MAX_CHARS,
    )
    agent_stance = sanitize_untrusted_text(
        str(snapshot.get("agent_stance") or ""),
        max_chars=_BIO_SHORT_MAX_CHARS,
    )

    if agent_role:
        identity_parts.append(
            f"此人身份为「{agent_role}」" if is_zh
            else f"This speaker's role is '{agent_role}'"
        )
    if bio_short:
        identity_parts.append(
            f"简介：{bio_short}" if is_zh
            else f"Bio: {bio_short}"
        )

    # Weight cues — high-impact agents should speak with more authority
    if isinstance(impact, (int, float)) and impact > 0:
        if impact >= 0.75:
            identity_parts.append(
                "此人在推演中影响极大，措辞应自信且有分量" if is_zh
                else "High-impact participant; speak with authority and weight"
            )
        elif impact <= 0.35:
            identity_parts.append(
                "此人在推演中影响有限，措辞应谨慎且从自身角度出发" if is_zh
                else "Low-impact participant; speak cautiously from personal perspective"
            )

    if tier:
        tier_map_zh = {"CORE": "核心人物", "IMPORTANT": "重要角色", "CROWD": "边缘角色"}
        tier_map_en = {"CORE": "core figure", "IMPORTANT": "important figure", "CROWD": "minor figure"}  # noqa: E501
        tier_label = (tier_map_zh if is_zh else tier_map_en).get(tier)
        if tier_label:
            identity_parts.append(
                f"叙事地位：{tier_label}" if is_zh
                else f"Narrative weight: {tier_label}"
            )

    if branch_pressure:
        identity_parts.append(
            f"这条线当前最受压的是：{branch_pressure}"
            if is_zh
            else f"This branch is currently under pressure at: {branch_pressure}"
        )
    if agent_stance:
        identity_parts.append(
            f"默认立场：{agent_stance}" if is_zh
            else f"Default stance: {agent_stance}"
        )

    if (isinstance(turn_count, int)
            and turn_count > 0
            and isinstance(key_moments, int)
            and key_moments > 0):
        identity_parts.append(
            f"推演中发言{turn_count}次、参与{key_moments}个关键时刻" if is_zh
            else f"Spoke {turn_count} times, involved in {key_moments} key moments"
        )

    return "；".join(identity_parts) + "。" if identity_parts else ""


def _oracle_vocabulary_hints(
    role_slot: "EndingRoomRoleSlot",
    variant: str,
    language: str,
    persona_snapshot: dict[str, Any] | None = None,
) -> str:
    """Build vocabulary hint from static domain terms and sanitized identity."""
    base_hint = _oracle_static_vocabulary_hint(role_slot, variant, language)
    identity_hint = (
        ""
        if role_slot == EndingRoomRoleSlot.ARCHIVIST
        else _oracle_identity_vocabulary_hint(language, persona_snapshot)
    )

    if base_hint and identity_hint:
        return f"{base_hint} {identity_hint}"
    return base_hint or identity_hint


def _oracle_vocabulary_prompt_section(
    role_slot: "EndingRoomRoleSlot",
    variant: str,
    language: str,
    persona_snapshot: dict[str, Any] | None = None,
) -> str:
    """Render trusted static vocabulary separately from untrusted identity data."""
    base_hint = _oracle_static_vocabulary_hint(role_slot, variant, language)
    identity_hint = (
        ""
        if role_slot == EndingRoomRoleSlot.ARCHIVIST
        else _oracle_identity_vocabulary_hint(language, persona_snapshot)
    )
    if not base_hint and not identity_hint:
        return ""
    lines: list[str] = []
    if base_hint:
        lines.append(f"Persona vocabulary: {base_hint}")
    elif identity_hint:
        lines.append("Persona vocabulary: see persona identity context below.")
    if identity_hint:
        lines.append(
            format_untrusted_text_block(
                "Persona Vocabulary Identity",
                identity_hint,
                max_chars=900,
            )
        )
    return "\n".join(lines) + "\n"

def _build_roundtable_opening_content(
    branch_card: dict[str, Any],
    *,
    participant: EndingRoomParticipant | None = None,
    language: str,
) -> str:
    """Build a minimal factual anchor for the opening turn.

    Variant-specific tone is driven by the LLM generation layer
    (`_oracle_voice_brief` + `_VOCABULARY_HINTS`); this anchor only
    carries the factual skeleton (title + key hinge + downstream insight)
    so the LLM rewrite has room to write naturally.
    """
    title = _oracle_visible_text(branch_card.get("title"), language=language, limit=40) or (
        "当前世界线" if language == "zh" else "this ending"
    )
    hook = _resolve_roundtable_hook(
        branch_card,
        participant=participant,
        language=language,
    )
    insight = _oracle_visible_clause(branch_card.get("insight"), language=language, limit=72)
    if language == "zh":
        base = f"《{title}》的关键转折在「{hook}」。"
        if insight and insight != hook:
            base += f"这之后的走向是「{insight}」。"
        return base
    base = f"The key turning point in {title} was '{hook}'."
    if insight and insight != hook:
        base += f" From there it moved toward '{insight}'."
    return base


def _build_roundtable_crossfire_content(
    branch_cards: list[dict[str, Any]],
    *,
    language: str,
) -> str:
    """Pure factual contrast anchor for the crossfire turn.

    Returns a minimal hinge comparison; voice and tone differentiation
    are produced by the LLM generation layer.
    """
    if not branch_cards:
        return (
            "尚无可对比的世界线摘要。"
            if language == "zh"
            else "No worldline summaries available to compare yet."
        )
    lead = branch_cards[0]
    lead_hook = _resolve_roundtable_hook(lead, participant=None, language=language)
    lead_title = _oracle_visible_text(lead.get("title"), language=language, limit=40) or (
        "当前世界线" if language == "zh" else "this ending"
    )
    rival = branch_cards[1] if len(branch_cards) > 1 else None
    if language == "zh":
        if rival is None:
            return f"焦点：《{lead_title}》的关键转折——「{lead_hook}」。"
        rival_hook = _resolve_roundtable_hook(rival, participant=None, language=language)
        rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "另一条世界线"  # noqa: E501
        return (
            f"对比：《{lead_title}》的转折在「{lead_hook}」；"
            f"《{rival_title}》的转折在「{rival_hook}」。"
        )
    if rival is None:
        return f"Focus: the key hinge of {lead_title} was '{lead_hook}'."
    rival_hook = _resolve_roundtable_hook(rival, participant=None, language=language)
    rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "another ending"  # noqa: E501
    return (
        f"Contrast: {lead_title} hinged on '{lead_hook}'; "
        f"{rival_title} hinged on '{rival_hook}'."
    )

def _build_roundtable_verdict_content(
    branch_cards: list[dict[str, Any]],
    *,
    language: str,
) -> str:
    """Build display-ready verdict anchor copy.

    LLM generation uses this as a semantic safety net, so it must never contain
    prompt instructions that could leak verbatim when LLM generation is disabled.
    """
    titles = [
        _oracle_visible_text(card.get("title"), language=language, limit=40)
        or (f"世界线{i + 1}" if language == "zh" else f"worldline {i + 1}")
        for i, card in enumerate(branch_cards)
    ]
    hinges = [
        _resolve_roundtable_hook(card, participant=None, language=language)
        for card in branch_cards
    ]
    lead_title = titles[0] if titles else ("这条线" if language == "zh" else "this line")
    lead_hinge = hinges[0] if hinges else ("关键转折" if language == "zh" else "the hinge")
    rival_title = titles[1] if len(titles) > 1 else None
    rival_hinge = hinges[1] if len(hinges) > 1 else None
    if language == "zh":
        if rival_title and rival_hinge:
            return (
                f"我把这桌的分歧压到一句话："
                f"《{lead_title}》的证据更扎实，因为「{lead_hinge}」先改变了局面；"
                f"《{rival_title}》提醒我们「{rival_hinge}」这笔代价不能抹掉，"
                "但它还没推翻前一个转折。"
                f"我的裁决是：先承认《{lead_title}》解释力更强，"
                f"再沿着《{rival_title}》留下的代价继续追问。"
            )
        return (
            f"这桌最后落在《{lead_title}》这条线：真正撑起判断的是「{lead_hinge}」。"
            "我的裁决是：先看这个转折带来的实际后果，再决定后续追问要往哪边打。"
        )
    if rival_title and rival_hinge:
        return (
            "I would reduce this table to one disagreement: "
            f"{lead_title} has the stronger evidence because "
            f"'{lead_hinge}' changed the situation first; "
            f"{rival_title} still matters because '{rival_hinge}' names a real cost, "
            "but it does not overturn the first hinge. "
            f"My verdict: treat {lead_title} as the stronger explanation, "
            f"then keep pressing the cost left by {rival_title}."
        )
    return (
        f"This table lands on {lead_title}: the judgment rests on '{lead_hinge}'. "
        "My verdict is to follow that concrete hinge first, "
        "then ask what cost still needs pressure."
    )


def _build_roundtable_witness_content(
    branch_card: dict[str, Any],
    *,
    witness: EndingRoomParticipant,
    branch_rows: list[dict[str, Any]],
    language: str,
) -> str:
    """Factual witness anchor: name + quote + role + branch hinge.

    Drops template phrasing ("证人只补这一段"/"only covers one hinge");
    LLM generation layer is responsible for tone and stance.
    """
    evidence_hook = _resolve_roundtable_hook(
        branch_card,
        participant=witness,
        language=language,
    )
    witness_evidence = _build_participant_followup_evidence(
        witness,
        branch_rows=branch_rows,
        evidence_hook=evidence_hook,
    )
    quote = _oracle_visible_text(
        str(witness_evidence.get("latest_quote") or "").strip(),
        language=language,
        limit=120,
    ) or ""
    latest_round = int(witness_evidence.get("latest_round") or 0)
    role_hint = str((witness.persona_snapshot_json or {}).get("agent_role") or "").strip()
    bio_hint = str((witness.persona_snapshot_json or {}).get("bio_short") or "").strip()
    branch_title = _oracle_visible_text(
        str((witness.persona_snapshot_json or {}).get("witness_branch_title")
            or branch_card.get("title") or "").strip(),
        language=language,
        limit=40,
    ) or ("当前世界线" if language == "zh" else "this branch")
    if language == "zh":
        parts: list[str] = [f"{witness.display_name}（证人）"]
        if quote and latest_round > 0:
            parts.append(f"R{latest_round} 原话：「{quote}」")
        if role_hint:
            parts.append(role_hint)
        if bio_hint:
            parts.append(bio_hint)
        parts.append(f"《{branch_title}》核心转折：「{evidence_hook}」")
        return "。".join(parts) + "。"
    parts_en: list[str] = [f"{witness.display_name} (witness)"]
    if quote and latest_round > 0:
        parts_en.append(f"R{latest_round} note: '{quote}'")
    if role_hint:
        parts_en.append(role_hint)
    if bio_hint:
        parts_en.append(bio_hint)
    parts_en.append(f"Key hinge in {branch_title}: '{evidence_hook}'")
    return ". ".join(parts_en) + "."


def _build_followup_reply_content(
    room: EndingRoom,
    *,
    thread: EndingRoomThread,
    response_participant: EndingRoomParticipant,
    user_content: str,
    addressed_participants: list[EndingRoomParticipant],
    interaction_mode: EndingRoomInteractionMode,
    response_index: int,
    response_count: int,
    participant_evidence: dict[str, Any],
) -> str:
    """Build display-ready follow-up fallback copy.

    This is shown verbatim when LLM generation is disabled or exhausted, so it
    must read like a direct reply instead of a mode-tagged fact list.
    """
    del response_count, thread
    target_label = response_participant.display_name
    addressed_label = " / ".join(
        participant.display_name for participant in addressed_participants
    )
    is_archivist = response_participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
    role_hint = str(participant_evidence.get("role_hint") or "").strip()
    bio_hint = str(participant_evidence.get("bio_hint") or "").strip()
    evidence_hint = str(participant_evidence.get("evidence_hook") or room.title).strip()
    latest_quote = str(participant_evidence.get("latest_quote") or "").strip()
    latest_round = int(participant_evidence.get("latest_round") or 0)
    profile_focus_hint = _oracle_profile_focus_hint(room)
    user_question = sanitize_untrusted_text(user_content, max_chars=80)

    is_zh = room.language == "zh"

    def _clean_sentence(value: str) -> str:
        return str(value or "").strip().strip("。.!?！？")

    def _zh_join(*parts: str) -> str:
        cleaned = [_clean_sentence(part) for part in parts if _clean_sentence(part)]
        return "。".join(cleaned) + ("。" if cleaned else "")

    def _en_join(*parts: str) -> str:
        cleaned = [_clean_sentence(part) for part in parts if _clean_sentence(part)]
        return ". ".join(cleaned) + ("." if cleaned else "")

    role_suffix = (
        f"（{role_hint}）"
        if role_hint and is_zh
        else (f" ({role_hint})" if role_hint else "")
    )
    quote_zh = (
        f"R{latest_round} 原话是「{latest_quote}」"
        if latest_quote and latest_round > 0
        else ""
    )
    quote_en = (
        f"In R{latest_round}, I said '{latest_quote}'"
        if latest_quote and latest_round > 0
        else ""
    )

    if is_zh:
        speaker = f"{target_label}{role_suffix}"
        if interaction_mode == EndingRoomInteractionMode.THREAD_FOLLOWUP:
            return _zh_join(
                f"{speaker}：你问「{user_question}」，我会把答案落在「{evidence_hint}」",
                quote_zh,
                "这不是旁枝，是这条线还能不能继续推进的门槛",
            )
        if interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
            return _zh_join(
                f"{speaker}：这张证据卡真正补上的，是「{evidence_hint}」",
                quote_zh,
                "它改变的不是气氛，而是这场争论里哪条因果链更硬",
            )
        if interaction_mode == EndingRoomInteractionMode.EPILOGUE:
            return _zh_join(
                f"{speaker}：往后三步看，先回来的还是「{evidence_hint}」这笔账",
                quote_zh,
                "它会继续压着人做选择，而不是在结局页就消失",
            )
        if is_archivist:
            target_clause = f"这句是追着{addressed_label}来的" if addressed_label else ""
            return _zh_join(
                f"{target_label}：我先把这句追问钉住",
                target_clause,
                f"桌面上真正能判的核心转折，是「{evidence_hint}」",
                f"接下来要问的是它怎样改变{profile_focus_hint or '后果'}",
            )
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
            target = addressed_label or target_label
            return _zh_join(
                f"{speaker}：{target}被问到的其实就是「{evidence_hint}」",
                quote_zh,
                "我的回答是，这里撑不住，后面的判断也就站不稳",
            )
        return _zh_join(
            f"{speaker}：我只补一个角度，关键仍是「{evidence_hint}」",
            quote_zh or bio_hint,
            f"这会直接影响{profile_focus_hint or '后续代价'}",
        )

    speaker = f"{target_label}{role_suffix}"
    if interaction_mode == EndingRoomInteractionMode.THREAD_FOLLOWUP:
        return _en_join(
            f"{speaker}: You asked '{user_question}', "
            f"and I would anchor the answer on '{evidence_hint}'",
            quote_en,
            "That is not side detail; it is the threshold this line has to survive",
        )
    if interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
        return _en_join(
            f"{speaker}: This evidence card adds one thing that matters: '{evidence_hint}'",
            quote_en,
            "It changes which causal chain in the table can actually carry the verdict",
        )
    if interaction_mode == EndingRoomInteractionMode.EPILOGUE:
        return _en_join(
            f"{speaker}: Three moves later, the bill still comes due at '{evidence_hint}'",
            quote_en,
            "That pressure keeps forcing choices after the ending page",
        )
    if is_archivist:
        target_clause = f"This follows {addressed_label}'s answer" if addressed_label else ""
        return _en_join(
            f"{target_label}: I would pin this follow-up to one hinge",
            target_clause,
            f"The table can actually judge the core hinge: '{evidence_hint}'",
            f"The next question is how it changes {profile_focus_hint or 'the consequences'}",
        )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
        target = addressed_label or target_label
        return _en_join(
            f"{speaker}: {target} is really being asked about '{evidence_hint}'",
            quote_en,
            "If that fails, the later judgment does not stand either",
        )
    return _en_join(
        f"{speaker}: I will add one angle; the hinge is still '{evidence_hint}'",
        quote_en or bio_hint,
        f"That directly changes {profile_focus_hint or 'the next cost'}",
    )


def _oracle_scope_notice(
    room: EndingRoom,
    *,
    thread_mode: EndingRoomThreadMode | None = None,
) -> str:
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        if thread_mode == EndingRoomThreadMode.FOLLOWUP:
            return (
                "Stay inside the current roundtable thread. Only use this table transcript and crossline summaries."  # noqa: E501
            )
        return "Stay inside the current roundtable. Do not use foreign full transcripts."
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        return "Stay inside the current worldline and phrase the answer as one actionable correction plus its cost."  # noqa: E501
    if thread_mode == EndingRoomThreadMode.FOLLOWUP:
        return "Stay inside the active follow-up thread and the current worldline only."
    return "Stay inside the current worldline and the current chamber only."


def _oracle_speaker_brief(participant: EndingRoomParticipant) -> str:
    snapshot = participant.persona_snapshot_json or {}
    pieces = [
        f"name={participant.display_name}",
        f"role_slot={participant.role_slot.value}",
    ]
    if snapshot.get("agent_role"):
        pieces.append(f"role_hint={snapshot['agent_role']}")
    if snapshot.get("bio_short"):
        pieces.append(f"bio_hint={snapshot['bio_short']}")
    if snapshot.get("selection_reason"):
        pieces.append(f"selection_reason={snapshot['selection_reason']}")
    return ", ".join(pieces)



def _oracle_recent_lines_digest(recent_lines: list[str] | None, *, limit: int = 4) -> str:
    cleaned = [
        sanitize_untrusted_text(line, max_chars=180)
        for line in (recent_lines or [])
        if str(line or "").strip()
    ]
    if not cleaned:
        return ""
    window = cleaned[-limit:]
    return "\n".join(f"- {line}" for line in window)



def _oracle_profile_id(room: EndingRoom) -> str:
    question = ""
    scene_theme = ""
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, room.scenario_id)
        if scenario is not None:
            question = str(scenario.question or "")
            scene_theme = str(getattr(scenario, "scene_theme", "") or "")
    profile_id = infer_debate_profile(question)
    if profile_id != "generic":
        return profile_id
    scene_theme_lower = scene_theme.lower()
    for candidate in (
        "law",
        "governance",
        "war",
        "empire",
        "industry",
        "trade",
        "faith",
        "ecology",
        "frontier",
        "mythic",
        "survival",
    ):
        if candidate in scene_theme_lower:
            return candidate
    return "generic"



def _oracle_profile_scene_brief(room: EndingRoom) -> str:
    profile_id = _oracle_profile_id(room)
    style = get_debate_profile_style(room.language, profile_id)
    if room.language == "zh":
        scene_labels = {
            "law": "法政",
            "governance": "治理",
            "war": "战争",
            "empire": "帝国",
            "industry": "工业",
            "trade": "贸易",
            "faith": "信仰",
            "ecology": "生态",
            "frontier": "边疆",
            "mythic": "神话",
            "survival": "生存",
            "generic": "通用",
        }
        return (
            f"profile={profile_id}({scene_labels.get(profile_id, '通用')})\n"
            f"lexicon_focus={style.get('pressure') or style.get('pro_case') or ''}\n"
            f"judge_focus={style.get('judge_focus') or ''}"
        )
    return (
        f"profile={profile_id}\n"
        f"lexicon_focus={style.get('pressure') or style.get('pro_case') or ''}\n"
        f"judge_focus={style.get('judge_focus') or ''}"
    )



def _oracle_profile_focus_hint(room: EndingRoom) -> str:
    profile_id = _oracle_profile_id(room)
    style = get_debate_profile_style(room.language, profile_id)
    return str(style.get("judge_focus") or style.get("pressure") or "").strip()


def _oracle_persona_digest(
    participant: EndingRoomParticipant,
    *,
    language: str,
) -> str:
    snapshot = participant.persona_snapshot_json or {}
    lines = [
        f"speaker_name={participant.display_name}",
        f"role_slot={participant.role_slot.value}",
    ]
    _append_oracle_context_text(
        lines,
        key="agent_name",
        value=snapshot.get("agent_name"),
        language=language,
        limit=80,
    )
    _append_oracle_context_text(
        lines,
        key="agent_role",
        value=snapshot.get("agent_role"),
        language=language,
        limit=80,
    )
    _append_oracle_context_text(
        lines,
        key="persona_hint",
        value=snapshot.get("bio_short") or snapshot.get("agent_persona"),
        language=language,
        limit=180,
    )
    _append_oracle_context_text(
        lines,
        key="agent_stance",
        value=snapshot.get("agent_stance"),
        language=language,
        limit=120,
    )
    _append_oracle_context_text(
        lines,
        key="worldline_title",
        value=snapshot.get("branch_title") or snapshot.get("witness_branch_title"),
        language=language,
        limit=60,
    )
    _append_oracle_context_text(
        lines,
        key="branch_pressure",
        value=snapshot.get("branch_pressure"),
        language=language,
        limit=120,
    )
    _append_oracle_context_text(
        lines,
        key="branch_insight",
        value=snapshot.get("branch_insight"),
        language=language,
        limit=180,
    )
    _append_oracle_context_text(
        lines,
        key="source_quote",
        value=snapshot.get("latest_quote") or snapshot.get("opening_quote"),
        language=language,
        limit=180,
    )
    tier = str(snapshot.get("tier") or "").strip()
    if tier:
        lines.append(f"narrative_weight={tier}")
    if snapshot.get("impact_score") is not None:
        lines.append(f"importance_score={snapshot['impact_score']}")
    if snapshot.get("selection_reason"):
        lines.append(f"selection_reason={snapshot['selection_reason']}")
    if snapshot.get("turn_count") is not None:
        lines.append(f"turn_count={snapshot['turn_count']}")
    if snapshot.get("key_moment_hits") is not None:
        lines.append(f"key_moment_hits={snapshot['key_moment_hits']}")
    if snapshot.get("last_round_spoken") is not None:
        lines.append(f"last_round_spoken={snapshot['last_round_spoken']}")
    return "\n".join(lines)



def _oracle_context_digest(
    room: EndingRoom,
    *,
    participant: EndingRoomParticipant,
    user_content: str | None = None,
    context_hint: str | None = None,
    scenario_question: str | None = None,
    transcript_quotes: list[str] | None = None,
) -> str:
    lines = [
        f"room_type={room.room_type.value}",
        f"room_title={room.title}",
        f"language={room.language}",
        _oracle_profile_scene_brief(room),
        f"speaker={_oracle_speaker_brief(participant)}",
        _oracle_persona_digest(participant, language=room.language),
        f"scope={_oracle_scope_notice(room)}",
    ]
    snapshot = participant.persona_snapshot_json or {}
    agent_emotion = sanitize_untrusted_text(
        str(snapshot.get("agent_emotion") or ""), max_chars=40
    )
    if agent_emotion:
        lines.append(f"agent_emotion={agent_emotion}")
    branch_title = _oracle_visible_text(snapshot.get("branch_title"), language=room.language, limit=40)  # noqa: E501
    if branch_title:
        lines.append(f"branch_title={branch_title}")
    if snapshot.get("impact_score") is not None:
        lines.append(f"impact_score={snapshot['impact_score']}")
    if snapshot.get("turn_count") is not None:
        lines.append(f"turn_count={snapshot['turn_count']}")
    if snapshot.get("last_round_spoken") is not None:
        lines.append(f"last_round_spoken={snapshot['last_round_spoken']}")
    if snapshot.get("key_moment_hits") is not None:
        lines.append(f"key_moment_hits={snapshot['key_moment_hits']}")
    if scenario_question:
        lines.append(
            f"scenario_question={sanitize_untrusted_text(scenario_question, max_chars=300)}"
        )
    if user_content:
        lines.append(f"user_question={sanitize_untrusted_text(user_content, max_chars=280)}")
    if transcript_quotes:
        quotes_text = "\n".join(
            sanitize_untrusted_text(q, max_chars=200) for q in transcript_quotes[:5]
        )
        lines.append(
            format_untrusted_text_block(
                "Simulation Transcript Excerpts",
                quotes_text,
                max_chars=1200,
            )
        )
    if context_hint:
        lines.append(
            format_untrusted_text_block(
                "Turn Context",
                context_hint,
                max_chars=2200,
            )
        )
    return "\n".join(lines)



def _oracle_voice_brief(
    room: EndingRoom,
    *,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
) -> str:
    is_archivist = participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
    profile_focus_hint = _oracle_profile_focus_hint(room)
    profile_focus_clause = (
        f" Keep {profile_focus_hint} concrete."
        if profile_focus_hint and room.language != "zh"
        else (f" 别把{profile_focus_hint}讲成空话。" if profile_focus_hint else "")
    )
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        if is_archivist:
            return (
                "Speak like a sharp moderator who can collapse six branches into one clear hinge. "
                "Do not sound bureaucratic or defensive. One crisp frame, then the handoff or verdict."  # noqa: E501
                f"{profile_focus_clause}"
            )
        variant = _oracle_role_voice_variant(
            str(participant.persona_snapshot_json.get("agent_role") if participant.persona_snapshot_json else ""),  # noqa: E501
            str(
                (participant.persona_snapshot_json or {}).get("bio_short")
                or (participant.persona_snapshot_json or {}).get("agent_persona")
                or ""
            ),
        )
        if variant == "imperial":
            return (
                "Speak like a ruler defending a failing line of authority: clipped, decisive, and intolerant of drift. "  # noqa: E501
                "Prefer command language over reflection."
            )
        if variant == "field":
            return (
                "Speak like a frontline commander: concrete, tactile, and unsentimental. "
                "Name positions, tempo, losses, supplies, or lines before abstractions."
            )
        if variant == "finance":
            return (
                "Speak like a wary finance operator: numbers-first, run-aware, and sensitive to settlement, liquidity, and confidence breaks. "  # noqa: E501
                "Prefer balance-sheet pressure over heroic rhetoric."
            )
        if variant == "market":
            return (
                "Speak like someone who feels policy through foot traffic, cash rotation, and stall-level disruption. "  # noqa: E501
                "Prefer customer flow, payment friction, and loss allocation over abstract governance phrasing."  # noqa: E501
            )
        if variant == "faith":
            return (
                "Speak like a keeper of vows and communal legitimacy under strain. "
                "Prefer oaths, ritual boundaries, fracture lines, and trust erosion over generic morale talk."  # noqa: E501
            )
        if variant == "industry":
            return (
                "Speak like an operator of plants, grids, and dispatch rhythm. "
                "Name throughput, maintenance debt, fallback capacity, or timing gaps before abstractions."  # noqa: E501
            )
        if variant == "frontier":
            return (
                "Speak like a frontier operator living on convoy windows and life-support slack. "
                "Prefer orbit timing, hull risk, supply windows, or airlock pressure over generic exploration rhetoric."  # noqa: E501
            )
        if variant == "survival":
            return (
                "Speak like someone triaging collapse at street level. "
                "Prefer shelter slots, ration math, clinic capacity, or evacuation order over abstract resilience slogans."  # noqa: E501
            )
        if variant == "scholar":
            return (
                "Speak like a witness or scribe aligning testimony, ledgers, and sequence. "
                "Prefer record gaps, contradictory lines, and evidentiary order over sweeping narration."  # noqa: E501
            )
        if variant == "civic":
            return (
                "Speak like a political or administrative operator: procedural, precise, and quietly accusatory. "  # noqa: E501
                "Name the ledger, explanation chain, or institutional leak before the finale."
            )
        return (
            "Speak like a representative defending one specific worldline. "
            "Name the decisive hinge, why it mattered, and what it cost. Do not narrate the process."  # noqa: E501
        )
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        return (
            "Speak like a strategist making one hard correction under pressure. "
            "Lead with the move, then the reason, then the cost. No fluff."
        )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT and not is_archivist:
        return (
            "Answer like someone just got called out on the exact hinge. "
            "Open with the answer, then name the decisive mistake, then the cost if needed. No throat-clearing."  # noqa: E501
        )
    if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT and not is_archivist:
        return (
            "Answer like one speaker in a tight relay. "
            "Only contribute your angle; do not summarize for the whole room or echo the previous speaker's opener."  # noqa: E501
        )
    if interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
        return (
            "Speak like someone presenting a piece of cross-branch evidence. "
            "Lead with the key difference this parallel worldline reveals, then explain "
            "what it means for the current discussion. Stay concrete and comparative."
        )
    if interaction_mode == EndingRoomInteractionMode.EPILOGUE and not is_archivist:
        return (
            "Speak like someone living through the aftermath. "
            "Focus on consequences unfolding after the main ending, not on re-narrating it."
        )
    if is_archivist and thread_mode == EndingRoomThreadMode.FOLLOWUP:
        return (
            "Speak like a moderator pinning the question to one hinge and one consequence. "
            "Do not explain permissions or workflow unless the user explicitly asks."
            f"{profile_focus_clause}"
        )
    if is_archivist:
        return (
            "Speak like a debrief host tightening the scene, not like a support agent. "
            "Frame the hinge in one sentence, then route or conclude."
            f"{profile_focus_clause}"
        )
    return (
        "Speak like a current-worldline participant who still owns the consequences. "
        "Be concrete, slightly defensive, causal, and use domain-specific nouns instead of generic abstractions."  # noqa: E501
    )



def _oracle_banned_process_phrases(language: str) -> str:
    if language == "zh":
        return (
            "- Do not repeat phrases like “我只顺着…回答 / 我只沿着…继续 / 我会继续沿着…这根线说下去 / 我先替你筛掉噪声”\n"  # noqa: E501
            "- Do not literally restate scope or room permissions unless the user explicitly asks about scope\n"  # noqa: E501
            "- Do not use the room title as if it were the actual hinge when a more concrete hinge already exists\n"  # noqa: E501
            "- Avoid stock openings like “先失手的，不是终局… / 你点到的就是这一下… / 这轮热座先听…” unless the anchor copy truly requires them\n"  # noqa: E501
            "- Avoid filler/process phrases like “总的来说 / 综上所述 / 值得注意的是 / 让我们来看看 / 不得不说 / 需要强调的是 / 从某种角度来说”\n"  # noqa: E501
            "- Avoid mechanical sequencing like “首先...其次...最后” or standalone “首先 / 其次 / 最后” when speaking live\n"  # noqa: E501
            "- Avoid repeating the same sentence rhythm or first clause used by the immediately previous speaker\n"  # noqa: E501
        )
    return (
        "- Do not repeat phrases like 'I am staying with...', 'I will stay on...', 'I will route from...', or 'let me filter the noise'\n"  # noqa: E501
        "- Do not literally restate scope or permissions unless the user explicitly asks about them\n"  # noqa: E501
        "- Do not treat the room title as the hinge when a more concrete hinge already exists\n"
        "- Avoid stock openings like 'the first miss was not the ending...' or 'you pointed to the exact hinge...' unless the anchor copy truly requires them\n"  # noqa: E501
        "- Avoid filler/process phrases like 'It's worth noting', 'Let's take a look', 'In conclusion', or 'It must be emphasized'\n"  # noqa: E501
        "- Avoid mechanical sequencing like 'First... Second... Finally'\n"
        "- Avoid repeating the same sentence rhythm or first clause used by the immediately previous speaker\n"  # noqa: E501
    )



def _strip_oracle_reasoning_prefix(text: str) -> str:
    cleaned = _strip_reasoning_blocks(str(text or ""))
    if re.match(r"^\s*<think>[\s\S]*$", cleaned, flags=re.IGNORECASE):
        return ""
    return cleaned


def _normalize_oracle_generated_content(text: str, *, fallback: str, max_chars: int = 800) -> str:
    normalized = sanitize_untrusted_text(
        _strip_oracle_reasoning_prefix(text),
        max_chars=max_chars,
    )
    return normalized or fallback


def _strip_oracle_scope_boilerplate(text: str, *, language: str) -> str:
    cleaned = sanitize_untrusted_text(text, max_chars=1200)
    if language == "zh":
        patterns = [
            r"我只顺着[^。！？!?]+[。！？!?]?",
            r"我只沿着[^。！？!?]+[。！？!?]?",
            r"我会继续沿着[^。！？!?]+[。！？!?]?",
            r"我先替你筛掉噪声。?",
        ]
    else:
        patterns = [
            r"I am staying[^.?!]+[.?!]?",
            r"I will stay[^.?!]+[.?!]?",
            r"I will route[^.?!]+[.?!]?",
            r"Let me filter the noise[.?!]?",
        ]
    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


def _build_oracle_generation_prompt(
    *,
    room: EndingRoom,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    scenario_question: str | None = None,
    transcript_quotes: list[str] | None = None,
    user_content: str | None = None,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    recent_lines: list[str] | None = None,
    context_hint: str | None = None,
    factual_guardrail: str | None = None,
    output_json: bool = True,
) -> str:
    """Build a generation-first prompt that leads with character identity and scenario context.

    Unlike the rewrite prompt, this does NOT include anchor copy as a central reference.
    Instead, character persona + scenario question + simulation transcript drive the output.
    A lightweight factual guardrail (key facts only) replaces the full template.
    """
    snapshot = participant.persona_snapshot_json or {}

    task_line = (
        "Generate an original spoken line for this character at this Oracle Chambers session. "
        "You ARE this character — speak from their lived experience, drawing on their history, "
        "emotions, and specific knowledge of what happened in the simulation."
        if user_content is None
        else "Generate an original follow-up reply as this character. "
        "Respond directly to the user's question, drawing on your character's unique perspective "
        "and specific knowledge of what happened."
    )
    structural_note = ""
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
        structural_note = (
            "Answer the user's question in the first sentence. "
            "Then pin one hinge and one cost. Do not spend the first sentence on self-introduction."
        )
    elif interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
        structural_note = (
            "Add only one distinct angle. "
            "Do not summarize the room or echo the previous speaker's cadence."
        )
    elif interaction_mode == EndingRoomInteractionMode.THREAD_FOLLOWUP:
        structural_note = (
            "Answer inside the active thread and the user's exact anchor. "
            "Do not restart the verdict, recap the room, or broaden into a new topic. "
            "Do not explain thread mechanics or permissions."
        )
    elif interaction_mode == EndingRoomInteractionMode.ARCHIVIST_ROUTE:
        structural_note = (
            "The Archivist should frame the hinge and route cleanly; "
            "other speakers should answer the hinge directly."
        )
    elif interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
        structural_note = (
            "Present evidence from a parallel worldline. "
            "Open with the key difference this evidence reveals. "
            "Explain what the cited evidence means for the current discussion."
        )
    elif interaction_mode == EndingRoomInteractionMode.EPILOGUE:
        structural_note = (
            "Extend the story naturally from where the main narrative ended. "
            "Focus on consequences, aftershocks, or unresolved threads."
        )
    phase_note = ""
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and phase == EndingRoomPhase.OPENING:
        phase_note = (
            "For a roundtable opening, start with the hinge or the cost immediately. "
            "Avoid stock openers like '我代表《...》发言' / 'I speak for...'. "
        )
    elif room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and phase == EndingRoomPhase.VERDICT:
        phase_note = (
            "Deliver an evaluative verdict: identify the core disagreement, "
            "assess which arguments have evidence, and give a clear judgment."
        )
    output_hint = (
        "Keep the same language as the context. Output strict JSON only: {\"content\":\"...\"}"
        if output_json
        else "Keep the same language as the context. Output plain text only with no JSON, bullets, or labels."  # noqa: E501
    )
    variant = _oracle_role_voice_variant(
        str(snapshot.get("agent_role") or ""),
        str(snapshot.get("bio_short") or snapshot.get("agent_persona") or ""),
    )
    vocab_section = _oracle_vocabulary_prompt_section(
        participant.role_slot, variant, room.language, snapshot
    )

    character_block = _build_character_identity_block(participant)

    guardrail_section = ""
    if factual_guardrail:
        guardrail_section = (
            "\nFactual guardrail (key facts only — do NOT paraphrase this, "
            "just ensure your original speech is consistent with these facts):\n"
            f"{format_untrusted_text_block('Key Facts', factual_guardrail, max_chars=600)}\n"
        )

    return (
        f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
        "You are generating live Oracle Chambers dialogue for SwarmOracle.\n"
        f"{task_line}\n\n"
        f"{character_block}\n\n"
        f"Target voice: {_oracle_voice_brief(room, participant=participant, phase=phase, thread_mode=thread_mode, interaction_mode=interaction_mode)}\n"  # noqa: E501
        f"{vocab_section}"
        "Hard rules:\n"
        "- You ARE this character — draw on their role, persona, emotional state, and stance\n"
        "- Reference the original scenario question and how this branch's events connect to it\n"
        "- Use specific names, events, numbers, and turning points from the simulation\n"
        "- Sound like a real person talking at a table, not an AI writing a report\n"
        "- Vary sentence structure — mix short decisive statements with longer explanations\n"
        "- No rhetorical questions, no parallel sentence structures, no listicle patterns\n"
        "- In roundtables, each speaker must sound noticeably different\n"
        "- Reference what other participants said by name — react to their specific points\n"
        "- Write as if speaking aloud: contractions OK, sentence fragments OK, mid-thought pivots OK\n"  # noqa: E501
        "- Keep it compact: one short paragraph, usually 2-4 sentences\n"
        f"{_oracle_banned_process_phrases(room.language)}"
        f"{structural_note}\n"
        f"{phase_note}\n"
        f"{output_hint}\n\n"
        f"{format_untrusted_text_block('Context', _oracle_context_digest(room, participant=participant, user_content=user_content, context_hint=context_hint, scenario_question=scenario_question, transcript_quotes=transcript_quotes), max_chars=3000)}\n"  # noqa: E501
        f"{guardrail_section}"
        f"{format_untrusted_text_block('Recent Lines To Avoid Mimicking', _oracle_recent_lines_digest(recent_lines), max_chars=1200) if recent_lines else ''}\n"  # noqa: E501
        f"phase={phase.value}\n"
        f"thread_mode={(thread_mode.value if thread_mode is not None else 'room')}\n"
        f"scope_notice={_oracle_scope_notice(room, thread_mode=thread_mode)}\n"
    )


def _build_character_identity_block(
    participant: EndingRoomParticipant,
) -> str:
    snapshot = participant.persona_snapshot_json or {}
    lines = [f"Character: {sanitize_untrusted_text(participant.display_name, max_chars=80)}"]
    role = sanitize_untrusted_text(str(snapshot.get("agent_role") or ""), max_chars=80)
    if role:
        lines.append(f"Role: {role}")
    persona = sanitize_untrusted_text(
        str(snapshot.get("bio_short") or snapshot.get("agent_persona") or ""),
        max_chars=180,
    )
    if persona:
        lines.append(f"Persona: {persona}")
    emotion = sanitize_untrusted_text(
        str(snapshot.get("agent_emotion") or ""), max_chars=40
    )
    if emotion:
        lines.append(f"Current emotion: {emotion}")
    stance = sanitize_untrusted_text(
        str(snapshot.get("agent_stance") or ""), max_chars=120
    )
    if stance:
        lines.append(f"Stance: {stance}")
    branch_title = sanitize_untrusted_text(
        str(snapshot.get("branch_title") or ""), max_chars=60
    )
    if branch_title:
        lines.append(f"Representing worldline: {branch_title}")
    return format_untrusted_text_block(
        "Character Identity",
        "\n".join(lines),
        max_chars=900,
    )


def _build_factual_guardrail(
    branch_card: dict[str, Any],
    *,
    participant: EndingRoomParticipant | None = None,
    language: str,
) -> str:
    """Extract lightweight factual elements for generation guardrail."""
    title = _oracle_visible_text(
        branch_card.get("title"), language=language, limit=40
    ) or ("当前世界线" if language == "zh" else "this ending")
    hook = _resolve_roundtable_hook(
        branch_card, participant=participant, language=language
    )
    insight = _oracle_visible_clause(
        branch_card.get("insight"), language=language, limit=72
    )
    key_moments = branch_card.get("key_moments") or []
    lines = [f"worldline_title={title}", f"key_hinge={hook}"]
    if insight:
        lines.append(f"outcome_insight={insight}")
    for i, moment in enumerate(key_moments[:3]):
        if isinstance(moment, str) and moment.strip():
            lines.append(
                f"key_moment_{i + 1}="
                f"{sanitize_untrusted_text(moment, max_chars=100)}"
            )
    return "\n".join(lines)


def _build_oracle_rewrite_prompt(
    *,
    room: EndingRoom,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    anchor_copy: str,
    user_content: str | None = None,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    recent_lines: list[str] | None = None,
    context_hint: str | None = None,
    scenario_question: str | None = None,
    transcript_quotes: list[str] | None = None,
    output_json: bool = True,
) -> str:
    task_line = (
        "Generate a fresh, natural spoken line for this Oracle Chambers character. "
        "The anchor copy below is only a semantic safety net — use it for factual scope and conclusion direction, "  # noqa: E501
        "but write your own words as if you ARE this character speaking live at the table."
        if user_content is None
        else "Generate a fresh follow-up reply as this character. "
        "The anchor copy is only a semantic safety net for scope and conclusion direction. "
        "Write your own words responding directly to the user's question."
    )
    structural_note = ""
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
        structural_note = (
            "For hotseat follow-up, answer the user's question in the first sentence. "
            "Then pin one hinge and one cost. Do not spend the first sentence on self-introduction."
        )
    elif interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
        structural_note = (
            "For all-present follow-up, this speaker should add only one distinct angle. "
            "Do not summarize the room or echo the previous speaker's cadence."
        )
    elif interaction_mode == EndingRoomInteractionMode.THREAD_FOLLOWUP:
        structural_note = (
            "For thread follow-up, answer inside the active thread and the user's exact anchor. "
            "Do not restart the verdict, recap the room, or broaden into a new topic. "
            "Do not explain thread mechanics or permissions."
        )
    elif interaction_mode == EndingRoomInteractionMode.ARCHIVIST_ROUTE:
        structural_note = (
            "For archivist-route follow-up, the Archivist should frame the hinge and route cleanly; "  # noqa: E501
            "other speakers should answer the hinge directly instead of restating the workflow."
        )
    elif interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
        structural_note = (
            "You are presenting evidence from a parallel worldline. "
            "Open with the key difference this evidence reveals, not a summary of the original branch. "  # noqa: E501
            "Explain what the cited evidence means for the current discussion — "
            "why does this alternate outcome matter here? Keep it grounded in specifics from the evidence."  # noqa: E501
        )
    elif interaction_mode == EndingRoomInteractionMode.EPILOGUE:
        structural_note = (
            "For epilogue follow-up, extend the story naturally from where the main narrative ended. "  # noqa: E501
            "Focus on consequences, aftershocks, or unresolved threads — do not re-summarize the ending."  # noqa: E501
        )
    phase_note = ""
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and phase == EndingRoomPhase.OPENING:
        phase_note = (
            "For a roundtable opening, start with the hinge or the cost immediately. "
            "Avoid the stock opener '我代表《...》发言' / 'I speak for...'. "
            "Also avoid repeating generic openings like '真正把这条线...' or '这条线真正...'."
        )
    elif room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE and phase == EndingRoomPhase.VERDICT:
        phase_note = (
            "For roundtable verdict/follow-up, the Archivist should sound comparative and decisive; "  # noqa: E501
            "representatives should sound like they are defending one branch, not explaining the room."  # noqa: E501
        )
    output_hint = (
        "Keep the same language as the anchor copy. Output strict JSON only: {\"content\":\"...\"}"
        if output_json
        else "Keep the same language as the anchor copy. Output plain text only with no JSON, bullets, or labels."  # noqa: E501
    )
    variant = _oracle_role_voice_variant(
        str(participant.persona_snapshot_json.get("agent_role") if participant.persona_snapshot_json else ""),  # noqa: E501
        str(
            (participant.persona_snapshot_json or {}).get("bio_short")
            or (participant.persona_snapshot_json or {}).get("agent_persona")
            or ""
        ),
    )
    vocab_section = _oracle_vocabulary_prompt_section(
        participant.role_slot,
        variant,
        room.language,
        participant.persona_snapshot_json,
    )
    return (
        f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
        "You are generating live Oracle Chambers dialogue for SwarmOracle.\n"
        f"{task_line}\n"
        f"Target voice: {_oracle_voice_brief(room, participant=participant, phase=phase, thread_mode=thread_mode, interaction_mode=interaction_mode)}\n"  # noqa: E501
        f"{vocab_section}"
        "Hard rules:\n"
        "- The anchor copy is a semantic safety net only — do NOT paraphrase it line by line\n"
        "- Preserve the factual scope and conclusion direction, but use completely fresh wording\n"
        "- Do not invent facts, branches, quotes, or motives not already in context\n"
        "- Sound like a real person talking at a table, not like an AI writing a report\n"
        "- Write as if you are genuinely thinking about this specific situation, "
        "not filling in a template\n"
        "- Use specific names, events, numbers, and turning points — never vague abstractions like 'the situation' or 'the outcome'\n"  # noqa: E501
        "- Use concrete names, numbers, and events from the anchor copy — never use generic placeholders\n"  # noqa: E501
        "- No rhetorical questions, no parallel sentence structures, no listicle patterns\n"
        "- Vary sentence structure — mix short decisive statements with longer explanations. Never use parallel structures like X是...Y是...Z是...\n"  # noqa: E501
        "- Let persona, stance, and story pressure drive word choice and what gets emphasized first\n"  # noqa: E501
        "- When role, persona, stance, or source quotes exist in context, prioritize them over the anchor template\n"  # noqa: E501
        "- In roundtables, each speaker must sound noticeably different — vary sentence length, opening style, and emotional register\n"  # noqa: E501
        "- Sound like a person having a real conversation at a table, not writing a report\n"
        "- Reference what other participants said by name — react to their specific points\n"
        "- Write as if speaking aloud: contractions OK, sentence fragments OK, mid-thought pivots OK\n"  # noqa: E501
        "- Use scene-appropriate nouns and pressure points; avoid collapsing into generic 'situation / outcome / consequence'\n"  # noqa: E501
        "- If target language is English, translate any Chinese fragments instead of leaving them inline\n"  # noqa: E501
        "- Keep it compact: one short paragraph, no bullets, usually 2-4 sentences\n"
        "- Keep scope implicit unless the user explicitly asks about it\n"
        f"{_oracle_banned_process_phrases(room.language)}"
        f"{structural_note}\n"
        f"{phase_note}\n"
        f"{output_hint}\n\n"
        f"{format_untrusted_text_block('Context', _oracle_context_digest(room, participant=participant, user_content=user_content, context_hint=context_hint, scenario_question=scenario_question, transcript_quotes=transcript_quotes), max_chars=3000)}\n\n"  # noqa: E501
        "NOTE: The fallback reference below is NOT your script — it is only a safety net for factual scope. "  # noqa: E501
        "Write your own words first; consult the reference only to verify facts and direction.\n"
        + "{}\n\n".format(
            format_untrusted_text_block(
                "Fallback Reference (anchor copy)",
                anchor_copy,
                max_chars=1200,
            )
        )
        + f"{format_untrusted_text_block('Recent Lines To Avoid Mimicking', _oracle_recent_lines_digest(recent_lines), max_chars=1200) if recent_lines else ''}\n"  # noqa: E501
        f"phase={phase.value}\n"
        f"thread_mode={(thread_mode.value if thread_mode is not None else 'room')}\n"
        f"scope_notice={_oracle_scope_notice(room, thread_mode=thread_mode)}\n"
    )


async def _maybe_rewrite_oracle_copy(
    *,
    room: EndingRoom,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    anchor_copy: str,
    user_content: str | None = None,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    recent_lines: list[str] | None = None,
    context_hint: str | None = None,
    purpose: str,
    streaming_first: bool = False,
    scenario_question: str | None = None,
    transcript_quotes: list[str] | None = None,
    factual_guardrail: str | None = None,
) -> str:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return anchor_copy

    # --- Tier 1: generation-first (no anchor copy in prompt) ---
    gen_prompt = _build_oracle_generation_prompt(
        room=room,
        participant=participant,
        phase=phase,
        scenario_question=scenario_question,
        transcript_quotes=transcript_quotes,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        context_hint=context_hint,
        factual_guardrail=factual_guardrail,
        output_json=True,
    )
    try:
        with llm_request_scope(quota_key=None, purpose=purpose):
            import app.services.ending_room_service as _pkg
            structured_call = (
                _pkg.llm_call_json_with_stream_fallback
                if streaming_first
                else _pkg.llm_call_json
            )
            result = await asyncio.wait_for(
                structured_call(
                    gen_prompt,
                    reasoning_effort="medium",
                    temperature=0.82,
                    fallback_mode="agent_message",
                ),
                timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
            )
        polished = _strip_oracle_scope_boilerplate(
            str(result.get("content") or ""),
            language=room.language,
        )
        content = _normalize_oracle_generated_content(
            polished, fallback="",
        )
        if content:
            return content
    except Exception as gen_exc:
        logger.info(
            "Oracle generation-first failed for %s, falling back to rewrite: %s",
            purpose,
            gen_exc,
        )

    # --- Tier 2: rewrite fallback (anchor copy as reference) ---
    rewrite_prompt = _build_oracle_rewrite_prompt(
        room=room,
        participant=participant,
        phase=phase,
        anchor_copy=anchor_copy,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        context_hint=context_hint,
        scenario_question=scenario_question,
        transcript_quotes=transcript_quotes,
        output_json=True,
    )
    plain_rewrite_prompt = _build_oracle_rewrite_prompt(
        room=room,
        participant=participant,
        phase=phase,
        anchor_copy=anchor_copy,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        context_hint=context_hint,
        scenario_question=scenario_question,
        transcript_quotes=transcript_quotes,
        output_json=False,
    )
    try:
        with llm_request_scope(quota_key=None, purpose=f"{purpose}:rewrite"):
            import app.services.ending_room_service as _pkg
            result = await asyncio.wait_for(
                _pkg.llm_call_json(
                    rewrite_prompt,
                    reasoning_effort="medium",
                    temperature=0.78,
                    fallback_mode="agent_message",
                ),
                timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
            )
        polished = _strip_oracle_scope_boilerplate(
            str(result.get("content") or ""),
            language=room.language,
        )
        content = _normalize_oracle_generated_content(
            polished, fallback=anchor_copy,
        )
        return content or anchor_copy
    except Exception as rewrite_exc:
        try:
            with llm_request_scope(
                quota_key=None, purpose=f"{purpose}:plain_text_retry"
            ):
                import app.services.ending_room_service as _pkg
                plain_result = await asyncio.wait_for(
                    _pkg.llm_call(
                        plain_rewrite_prompt,
                        reasoning_effort="low",
                        temperature=0.65,
                    ),
                    timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
                )
            polished = _strip_oracle_scope_boilerplate(
                str(plain_result or ""),
                language=room.language,
            )
            content = _normalize_oracle_generated_content(
                polished, fallback=anchor_copy,
            )
            return content or anchor_copy
        except Exception as plain_exc:
            _effort_err = str(plain_exc).lower()
            _is_effort_unsupported = (
                "reasoning_effort" in _effort_err
                or ("reasoning" in _effort_err and "400" in str(plain_exc))
                or "unsupported parameter" in _effort_err
            )
            if _is_effort_unsupported:
                try:
                    with llm_request_scope(
                        quota_key=None, purpose=f"{purpose}:no_effort_retry"
                    ):
                        import app.services.ending_room_service as _pkg_r
                        no_effort_result = await asyncio.wait_for(
                            _pkg_r.llm_call(
                                plain_rewrite_prompt,
                                reasoning_effort=None,
                                temperature=0.65,
                            ),
                            timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
                        )
                    polished = _strip_oracle_scope_boilerplate(
                        str(no_effort_result or ""),
                        language=room.language,
                    )
                    content = _normalize_oracle_generated_content(
                        polished, fallback=anchor_copy,
                    )
                    return content or anchor_copy
                except Exception as no_effort_exc:
                    logger.warning(
                        "Oracle LLM no-effort fallback for %s: %s",
                        purpose,
                        no_effort_exc,
                    )
            else:
                logger.warning(
                    "Oracle Chambers LLM all tiers failed for %s: rewrite=%s ; plain=%s",
                    purpose,
                    rewrite_exc,
                    plain_exc,
                )
            return anchor_copy


async def _oracle_followup_streaming_supported() -> bool:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return False
    try:
        import app.services.ending_room_service as _pkg
        probe = await _pkg.probe_streaming_support(
            model=settings.LLM_MODEL_NAME,
            timeout=_ORACLE_STREAM_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as exc:  # pragma: no cover - defensive fallback
        logger.warning("Oracle follow-up stream probe failed: %s", exc)
        return False
    supported = bool(probe.get("supported"))
    if not supported:
        logger.info(
            "Oracle follow-up stream fallback engaged: %s",
            probe.get("reason") or "unsupported",
        )
    return supported

async def _stream_oracle_copy(
    *,
    room: EndingRoom,
    participant: EndingRoomParticipant,
    phase: EndingRoomPhase,
    anchor_copy: str,
    user_content: str | None = None,
    thread_mode: EndingRoomThreadMode | None = None,
    interaction_mode: EndingRoomInteractionMode | None = None,
    recent_lines: list[str] | None = None,
    context_hint: str | None = None,
    purpose: str,
    on_delta: Callable[[str], Awaitable[None]] | None = None,
    scenario_question: str | None = None,
    transcript_quotes: list[str] | None = None,
) -> str:
    prompt = _build_oracle_generation_prompt(
        room=room,
        participant=participant,
        phase=phase,
        scenario_question=scenario_question,
        transcript_quotes=transcript_quotes,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        context_hint=context_hint,
        output_json=False,
    )
    raw_buffer = ""
    visible_length = 0
    chunks: list[str] = []
    stream_iter = None
    try:
        with llm_request_scope(quota_key=None, purpose=purpose):
            import app.services.ending_room_service as _pkg
            stream_iter = _pkg.llm_call_stream(
                prompt,
                reasoning_effort="medium",
                temperature=0.75,
                timeout=_ORACLE_FOLLOWUP_STREAM_TIMEOUT_SECONDS,
            ).__aiter__()
            while True:
                try:
                    if visible_length == 0:
                        delta = await asyncio.wait_for(
                            anext(stream_iter),
                            timeout=_pkg._ORACLE_FOLLOWUP_FIRST_VISIBLE_DELTA_TIMEOUT_SECONDS,
                        )
                    else:
                        delta = await anext(stream_iter)
                except StopAsyncIteration:
                    break
                if not delta:
                    continue
                raw_buffer = f"{raw_buffer}{delta}"
                visible_text = _strip_oracle_reasoning_prefix(raw_buffer)
                if not visible_text:
                    continue
                visible_delta = visible_text[visible_length:]
                if not visible_delta:
                    continue
                visible_length = len(visible_text)
                chunks.append(visible_delta)
                if on_delta is not None:
                    await on_delta(visible_delta)
    finally:
        if stream_iter is not None:
            await stream_iter.aclose()
    if not chunks:
        raise RuntimeError("oracle stream produced no visible content")
    polished = _strip_oracle_scope_boilerplate(
        "".join(chunks),
        language=room.language,
    )
    return _normalize_oracle_generated_content(polished, fallback=anchor_copy)
