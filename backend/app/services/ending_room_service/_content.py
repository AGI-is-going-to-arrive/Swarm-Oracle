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


def _oracle_vocabulary_hints(
    role_slot: "EndingRoomRoleSlot",
    variant: str,
    language: str,
    persona_snapshot: dict[str, Any] | None = None,
) -> str:
    """Build persona vocabulary hint that blends domain terminology with agent-specific identity.

    The hint has two layers:
    1. Domain palette — static keywords per variant (imperial, finance, etc.)
    2. Identity layer — dynamic context from the agent's simulation history
    """
    lang_key = "zh" if language.startswith("zh") else "en"
    is_zh = lang_key == "zh"

    if role_slot == EndingRoomRoleSlot.ARCHIVIST:
        return _ARCHIVIST_VOCABULARY_HINT.get(lang_key, "")

    # Layer 1: domain palette
    base_hint = _VOCABULARY_HINTS.get(variant, {}).get(lang_key, "")

    # Layer 2: identity from persona_snapshot
    snapshot = persona_snapshot or {}
    identity_parts: list[str] = []

    agent_role = str(snapshot.get("agent_role") or "").strip()
    bio_short = str(snapshot.get("bio_short") or snapshot.get("agent_persona") or "").strip()
    impact = snapshot.get("impact_score")
    tier = str(snapshot.get("tier") or "").strip().upper()
    turn_count = snapshot.get("turn_count")
    key_moments = snapshot.get("key_moment_hits")
    branch_pressure = str(snapshot.get("branch_pressure") or "").strip()
    agent_stance = str(snapshot.get("agent_stance") or "").strip()

    if agent_role:
        identity_parts.append(
            f"此人身份为「{agent_role}」" if is_zh
            else f"This speaker's role is '{agent_role}'"
        )
    if bio_short:
        identity_parts.append(
            f"简介：{bio_short[:_BIO_SHORT_MAX_CHARS]}" if is_zh
            else f"Bio: {bio_short[:_BIO_SHORT_MAX_CHARS]}"
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
            f"这条线当前最受压的是：{branch_pressure[:_BIO_SHORT_MAX_CHARS]}"
            if is_zh
            else (
                "This branch is currently under pressure at: "
                f"{branch_pressure[:_BIO_SHORT_MAX_CHARS]}"
            )
        )
    if agent_stance:
        identity_parts.append(
            f"默认立场：{agent_stance[:_BIO_SHORT_MAX_CHARS]}" if is_zh
            else f"Default stance: {agent_stance[:_BIO_SHORT_MAX_CHARS]}"
        )

    if (isinstance(turn_count, int)
            and turn_count > 0
            and isinstance(key_moments, int)
            and key_moments > 0):
        identity_parts.append(
            f"推演中发言{turn_count}次、参与{key_moments}个关键时刻" if is_zh
            else f"Spoke {turn_count} times, involved in {key_moments} key moments"
        )

    identity_hint = "；".join(identity_parts) + "。" if identity_parts else ""

    if base_hint and identity_hint:
        return f"{base_hint} {identity_hint}"
    return base_hint or identity_hint

def _build_roundtable_opening_content(
    branch_card: dict[str, Any],
    *,
    participant: EndingRoomParticipant | None = None,
    language: str,
) -> str:
    title = _oracle_visible_text(branch_card.get("title"), language=language, limit=40) or (
        "当前世界线" if language == "zh" else "this ending"
    )
    hook = _resolve_roundtable_hook(
        branch_card,
        participant=participant,
        language=language,
    )
    insight = _oracle_visible_clause(branch_card.get("insight"), language=language, limit=72)
    variant = _roundtable_participant_variant(participant)
    if language == "zh":
        if variant == "imperial":
            return (
                f"《{title}》先失手的，不是终局，而是“{hook}”那一下再没人把秩序压回去。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '从那一刻起，后面的代价就只能越滚越大。'}"  # noqa: E501
            )
        if variant == "field":
            return (
                f"《{title}》是在“{hook}”这里先把前线掏空的，不是到了结局才突然坏掉。"
                f"{f'后面会一路滑向“{insight}”。' if insight and insight != hook else '前线一空，后面的收场就只是时间问题。'}"  # noqa: E501
            )
        if variant == "finance":
            return (
                f"《{title}》不是到收尾才出事，而是在“{hook}”这里先把清算、流动性和信心链一起撬松了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '资金预期一松，后面的代价就只会越滚越大。'}"  # noqa: E501
            )
        if variant == "market":
            return (
                f"《{title}》不是到了结局才疼，而是在“{hook}”这里先把客流、摊位和现钱周转一起挤坏了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '一旦现钱链先断，后面的收场就只剩谁来吞下损失。'}"  # noqa: E501
            )
        if variant == "faith":
            return (
                f"《{title}》不是到结尾才裂开，而是在“{hook}”这里先把誓约、祭坛和共同体信任一起掏松了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '一旦共同誓约先松，后面的代价就会沿着裂口越滚越大。'}"  # noqa: E501
            )
        if variant == "industry":
            return (
                f"《{title}》不是到收尾才断电，而是在“{hook}”这里先把产能、调度和备援一起拉歪了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '节拍一歪，后面的代价就会按整条链路往外传。'}"  # noqa: E501
            )
        if variant == "frontier":
            return (
                f"《{title}》不是到结局才失压，而是在“{hook}”这里先把轨道节拍、补给窗和生命维持一起扯紧了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '边疆一旦先失去缓冲，后面的收场就只剩谁先断供。'}"  # noqa: E501
            )
        if variant == "survival":
            return (
                f"《{title}》不是到最后才崩，而是在“{hook}”这里先把避难、药品和口粮配给一起挤穿了。"
                f"{f'后面才会一路滑向“{insight}”。' if insight and insight != hook else '生存链先破，后面的代价就只会越来越直接。'}"  # noqa: E501
            )
        if variant == "scholar":
            return (
                f"《{title}》是从“{hook}”这里开始对不上证词和账册的，后面每一层解释都只能越补越漏。"
                f"{f'最后才会落到“{insight}”。' if insight and insight != hook else '真正的代价，是后面的每一步都开始替这处证词断口埋单。'}"  # noqa: E501
            )
        if variant == "civic":
            return (
                f"《{title}》是从“{hook}”这里开始对不上账的，后面每一层解释都只能越补越漏。"
                f"{f'最后才会落到“{insight}”。' if insight and insight != hook else '真正的代价，是后面的每一步都开始替这一下埋单。'}"  # noqa: E501
            )
        if insight and insight != hook:
            return f"我代表《{title}》发言：这条线先被“{hook}”推偏，后面才会一路滑向“{insight}”。"
        return f"我代表《{title}》发言：真正把这条线推到现在这个收场的，不是终局，而是更早的“{hook}”。"  # noqa: E501
    if variant == "imperial":
        ending_clause = (
            f"From there it kept drifting toward '{insight}'."
            if insight and insight != hook
            else "After that, the cost only kept compounding."
        )
        return (
            f"{title} did not break at the finale. It broke when '{hook}' was no longer forced back into order. "  # noqa: E501
            f"{ending_clause}"
        )
    if variant == "field":
        ending_clause = (
            f"After that it kept sliding toward '{insight}'."
            if insight and insight != hook
            else "Once the line was hollowed out, the rest was only a matter of time."
        )
        return (
            f"{title} was lost before the ending label ever appeared: '{hook}' emptied the front first. "  # noqa: E501
            f"{ending_clause}"
        )
    if variant == "finance":
        ending_clause = (
            f"From there it kept drifting toward '{insight}'."
            if insight and insight != hook
            else "Once the settlement rail loosened, the rest of the cost only compounded."
        )
        return (
            f"{title} does not first break at the ending. "
            f"It breaks when '{hook}' loosens settlement, liquidity, and confidence at once. "
            f"{ending_clause}"
        )
    if variant == "market":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once foot traffic and cash rotation are squeezed first, the later cost only turns into loss allocation."  # noqa: E501
        )
        return (
            f"{title} does not start hurting at the finale. "
            f"It starts when '{hook}' squeezes stalls, customers, and cash rotation first. "
            f"{ending_clause}"
        )
    if variant == "faith":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once the shared covenant loosens first, the later cost only compounds along the fracture."  # noqa: E501
        )
        return (
            f"{title} does not first split at the finale. It splits when '{hook}' loosens vows, ritual legitimacy, and communal trust together. "  # noqa: E501
            f"{ending_clause}"
        )
    if variant == "industry":
        ending_clause = (
            f"From there it keeps drifting toward '{insight}'."
            if insight and insight != hook
            else "Once throughput and backup timing are bent first, the later cost just propagates down the line."  # noqa: E501
        )
        return (
            f"{title} does not first fail at the ending. It fails when '{hook}' bends throughput, dispatch rhythm, and fallback capacity together. "  # noqa: E501
            f"{ending_clause}"
        )
    if variant == "frontier":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once orbital timing and life-support slack are squeezed first, the later cost becomes a question of who loses air, fuel, or time."  # noqa: E501
        )
        return (
            f"{title} does not first lose pressure at the finale. It starts when '{hook}' tightens orbital timing, supply windows, and life-support slack together. "  # noqa: E501
            f"{ending_clause}"
        )
    if variant == "survival":
        ending_clause = (
            f"That is how it keeps sliding toward '{insight}'."
            if insight and insight != hook
            else "Once refuge, medicine, and ration slack are punctured first, the later cost only turns more immediate."  # noqa: E501
        )
        return (
            f"{title} does not first collapse at the ending. "
            f"It starts when '{hook}' punctures refuge, medicine, and ration slack together. "
            f"{ending_clause}"
        )
    if variant == "scholar":
        ending_clause = (
            f"That is how it ends up at '{insight}'."
            if insight and insight != hook
            else "The real cost is that every later explanation starts paying for the first record gap."  # noqa: E501
        )
        return (
            f"{title} first slips at '{hook}', where the testimony and ledger stop lining up cleanly. "  # noqa: E501
            f"{ending_clause}"
        )
    if variant == "civic":
        ending_clause = (
            f"That is how it ends up at '{insight}'."
            if insight and insight != hook
            else "The real cost is that every later move pays for that first leak."
        )
        return (
            f"{title} first slips at '{hook}', and every layer after that is only paper trying to catch up. "  # noqa: E501
            f"{ending_clause}"
        )
    if insight and insight != hook:
        return f"I speak for {title}: this ending tipped when '{hook}' slipped first, and that is how it kept drifting toward '{insight}'."  # noqa: E501
    return f"I speak for {title}: what pushed this ending into its current shape was not the finale itself, but the earlier hinge '{hook}'."  # noqa: E501


def _build_roundtable_crossfire_content(
    branch_cards: list[dict[str, Any]],
    *,
    language: str,
) -> str:
    if not branch_cards:
        return (
            "我先只拎摘要里最早失手的那一下，不把所有故事搅成一团。"
            if language == "zh"
            else "I am pulling out the first hinge from the summaries instead of blending every story together."  # noqa: E501
        )
    lead = branch_cards[0]
    lead_hook = _resolve_roundtable_hook(lead, participant=None, language=language)
    lead_title = _oracle_visible_text(lead.get("title"), language=language, limit=40) or (
        "当前世界线" if language == "zh" else "this ending"
    )
    rival = branch_cards[1] if len(branch_cards) > 1 else None
    if language == "zh":
        if rival is None:
            return f"我先只盯《{lead_title}》里“{lead_hook}”这一手，因为真正的差别就从这里被放大。"
        rival_hook = _resolve_roundtable_hook(rival, participant=None, language=language)
        rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "另一条世界线"  # noqa: E501
        return (
            f"我先把两条线最早失手的地方摆出来：《{lead_title}》先在“{lead_hook}”上偏了，"
            f"《{rival_title}》则在“{rival_hook}”上先松了口子。"
        )
    if rival is None:
        return f"I am keeping the focus on the hinge '{lead_hook}' inside {lead_title}, because that is where the difference first starts to widen."  # noqa: E501
    rival_hook = _resolve_roundtable_hook(rival, participant=None, language=language)
    rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "another ending"  # noqa: E501
    return (
        f"I am putting the first slips side by side: {lead_title} starts to drift at '{lead_hook}', "  # noqa: E501
        f"while {rival_title} first loosens at '{rival_hook}'."
    )

def _build_roundtable_verdict_content(
    branch_cards: list[dict[str, Any]],
    *,
    language: str,
) -> str:
    """Build a verdict anchor copy that instructs the LLM to produce an evaluative
    synthesis rather than a bland placeholder.  When the LLM is enabled this text
    serves as the semantic safety-net; when disabled it is shown verbatim."""
    titles = [
        _oracle_visible_text(card.get("title"), language=language, limit=40)
        or (f"世界线{i + 1}" if language == "zh" else f"worldline {i + 1}")
        for i, card in enumerate(branch_cards)
    ]
    hinges = [
        _resolve_roundtable_hook(card, participant=None, language=language)
        for card in branch_cards
    ]
    branch_bullets = "\n".join(
        f"- {title}: {hinge}" for title, hinge in zip(titles, hinges)
    )
    if language == "zh":
        return (
            f"各条世界线的关键转折参考：\n{branch_bullets}\n\n"
            "你刚主持完一场激烈的圆桌讨论。现在用你自己的话做个总结——"
            "像一个资深主持人在节目尾声的即兴点评，不是在写报告。"
            "别复述每条世界线，直接说你觉得这场讨论最意外的发现是什么。"
            "哪边的论证更站得住脚？谁的逻辑链有硬伤？"
            "用具体的人名和他们说过的话来佐证你的判断。"
            "语气要像在跟朋友聊天，但观点要锐利。"
        )
    return (
        f"Key hinge references per worldline:\n{branch_bullets}\n\n"
        "You just finished hosting a heated roundtable. Now give your honest take — "
        "like a seasoned moderator's off-the-cuff closing remarks, not a written report. "
        "Don't recap each worldline. Cut straight to what surprised you most in this discussion. "
        "Whose argument actually holds up? Where did someone's logic fall apart? "
        "Use specific names and things they actually said to back your judgment. "
        "Sound like you're talking to a friend, but keep your opinions sharp."
    )


def _build_roundtable_witness_content(
    branch_card: dict[str, Any],
    *,
    witness: EndingRoomParticipant,
    branch_rows: list[dict[str, Any]],
    language: str,
) -> str:
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
    quote = _oracle_visible_text(str(witness_evidence.get("latest_quote") or "").strip(), language=language, limit=120) or ""  # noqa: E501
    latest_round = int(witness_evidence.get("latest_round") or 0)
    role_hint = str((witness.persona_snapshot_json or {}).get("agent_role") or "").strip()
    bio_hint = str((witness.persona_snapshot_json or {}).get("bio_short") or "").strip()
    branch_title = _oracle_visible_text(
        str((witness.persona_snapshot_json or {}).get("witness_branch_title") or branch_card.get("title") or "").strip(),  # noqa: E501
        language=language,
        limit=40,
    ) or ("当前世界线" if language == "zh" else "this branch")
    if language == "zh":
        quote_clause = f"我在 R{latest_round} 当时说过「{quote}」。" if quote and latest_round > 0 else ""  # noqa: E501
        return (
            f"{witness.display_name}：证人只补这一段。"
            f"{quote_clause}"
            f"{f'{role_hint}，' if role_hint else ''}{bio_hint or '我只把这条线自己留下的证据补给圆桌。'}"  # noqa: E501
            f"在《{branch_title}》里，真正先失手的是「{evidence_hook}」这一下；我只替这条线把它讲实，不替全桌下结论。"
        )
    quote_clause = f"In R{latest_round} I said '{quote}'. " if quote and latest_round > 0 else ""
    return (
        f"{witness.display_name}: this witness note only covers one hinge. "
        f"{quote_clause}"
        f"{f'{role_hint}. ' if role_hint else ''}{bio_hint or 'I am only filling in the evidence this branch actually left behind.'} "  # noqa: E501
        f"Inside {branch_title}, the first real slip was '{evidence_hook}'; "
        f"I am here to make that concrete, not to summarize the whole table."
    )


def _followup_angle_label(role_hint: str | None, *, language: str) -> str:
    normalized = str(role_hint or "").strip().lower()
    if any(
        token in normalized
        for token in (
            "皇",
            "king",
            "queen",
            "emperor",
            "court",
            "judge",
            "crown",
        )
    ):
        return "权力链" if language == "zh" else "the authority chain"
    if any(
        token in normalized
        for token in (
            "将",
            "统帅",
            "general",
            "commander",
            "captain",
            "marshal",
            "guard",
        )
    ):
        return "执行链" if language == "zh" else "the execution chain"
    if any(
        token in normalized
        for token in (
            "银行",
            "行长",
            "财政",
            "金融",
            "清算",
            "流动性",
            "bank",
            "banker",
            "finance",
            "treasury",
            "settlement",
            "liquidity",
        )
    ):
        return "清算链" if language == "zh" else "the settlement chain"
    if any(
        token in normalized
        for token in (
            "摊主",
            "商户",
            "商贩",
            "市场",
            "港口",
            "贸易",
            "货运",
            "vendor",
            "merchant",
            "market",
            "trade",
            "port",
            "freight",
        )
    ):
        return "现钱链" if language == "zh" else "the cash-flow chain"
    if any(
        token in normalized
        for token in (
            "祭司",
            "祭坛",
            "神官",
            "神谕",
            "priest",
            "cleric",
            "oracle",
            "temple",
            "faith",
            "ritual",
            "covenant",
        )
    ):
        return "誓约链" if language == "zh" else "the covenant chain"
    if any(
        token in normalized
        for token in (
            "工程",
            "工厂",
            "电网",
            "产能",
            "后勤",
            "调度",
            "engineer",
            "factory",
            "industrial",
            "grid",
            "throughput",
            "logistics",
            "plant",
        )
    ):
        return "产能链" if language == "zh" else "the throughput chain"
    if any(
        token in normalized
        for token in (
            "边疆",
            "拓荒",
            "殖民",
            "轨道",
            "补给舱",
            "生命维持",
            "pilot",
            "orbital",
            "frontier",
            "colony",
            "expedition",
            "convoy",
            "airlock",
            "life support",
        )
    ):
        return "轨道链" if language == "zh" else "the orbital chain"
    if any(
        token in normalized
        for token in (
            "避难",
            "药品",
            "口粮",
            "撤离",
            "医疗",
            "scout",
            "medic",
            "refuge",
            "ration",
            "evacuation",
            "shelter",
            "survival",
        )
    ):
        return "生存链" if language == "zh" else "the survival chain"
    if any(
        token in normalized
        for token in (
            "史官",
            "书记官",
            "学者",
            "档案",
            "证人",
            "scribe",
            "scholar",
            "historian",
            "witness",
            "record",
            "ledger",
            "clerk",
        )
    ):
        return "证词链" if language == "zh" else "the testimony chain"
    if any(
        token in normalized
        for token in (
            "档案",
            "scribe",
            "record",
            "ledger",
            "minister",
            "文书",
            "coordinator",
        )
    ):
        return "记录链" if language == "zh" else "the records chain"
    return "因果链" if language == "zh" else "the causal chain"

def _oracle_role_pressure_clause(variant: str, *, language: str) -> str:
    if language == "zh":
        if variant == "imperial":
            return "我盯的不是一句面子话，而是谁还能把号令、体面和行省秩序压回原位。"
        if variant == "field":
            return "我盯的是前线、补给和调度空窗，不是事后好看的解释。"
        if variant == "civic":
            return "我盯的是账册、解释链和最后到底谁来签字背责。"
        if variant == "finance":
            return "我盯的不是场面，而是清算链、流动性和挤兑预期什么时候先松。"
        if variant == "market":
            return "我盯的不是口号，而是客流、摊位和现钱周转先在哪一步被挤坏。"
        if variant == "faith":
            return "我盯的不是口头神圣感，而是誓约、仪式边界和共同体信任先在哪一步松掉。"
        if variant == "industry":
            return "我盯的不是漂亮产量，而是产能、调度和备援先在哪一处脱节。"
        if variant == "frontier":
            return "我盯的不是远景口号，而是轨道窗口、补给节拍和生命维持先在哪一下吃紧。"
        if variant == "survival":
            return "我盯的不是安慰话，而是避难位、药品和口粮先在哪一步不够用了。"
        if variant == "scholar":
            return "我盯的不是好听说法，而是证词、账册和责任顺序先从哪一行开始对不上。"
        return ""
    if variant == "imperial":
        return "I am not tracking posture. I am tracking command, legitimacy, and whether provincial order can still be forced back into line."  # noqa: E501
    if variant == "field":
        return "I am tracking the line, the supply rail, and the tempo gap, not the polished explanation after the loss."  # noqa: E501
    if variant == "civic":
        return "I am tracking the ledger, the explanation chain, and who is left signing for the damage."  # noqa: E501
    if variant == "finance":
        return "I am not tracking optics. I am tracking settlement rails, liquidity strain, and when the run expectation starts to loosen."  # noqa: E501
    if variant == "market":
        return "I am not tracking slogans. I am tracking foot traffic, stall order, and where cash flow gets squeezed first."  # noqa: E501
    if variant == "faith":
        return "I am not tracking sacred posture. I am tracking vows, ritual boundaries, and where communal trust loosens first."  # noqa: E501
    if variant == "industry":
        return "I am not tracking glossy output. I am tracking throughput, dispatch rhythm, and where fallback capacity first drops out."  # noqa: E501
    if variant == "frontier":
        return "I am not tracking frontier romance. I am tracking orbital windows, convoy timing, and where life-support slack tightens first."  # noqa: E501
    if variant == "survival":
        return "I am not tracking reassurance. I am tracking shelter slots, medicine, and where ration slack fails first."  # noqa: E501
    if variant == "scholar":
        return "I am not tracking polished spin. I am tracking testimony order, record gaps, and which line of the ledger stops lining up first."  # noqa: E501
    return ""

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
    target_label = response_participant.display_name
    addressed_label = " / ".join(participant.display_name for participant in addressed_participants)
    addressed_label_zh = addressed_label or "被点名角色"
    addressed_label_zh_roundtable = addressed_label or "被点名代表"
    addressed_label_en = addressed_label or "the addressed speaker"
    addressed_label_en_roundtable = addressed_label or "the addressed representative"
    is_archivist = response_participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
    variant_seed = "|".join(
        [
            room.id,
            response_participant.id,
            interaction_mode.value,
            str(response_index),
            sanitize_untrusted_text(user_content, max_chars=96),
        ]
    )
    role_hint = str(participant_evidence.get("role_hint") or "").strip()
    bio_hint = str(participant_evidence.get("bio_hint") or "").strip()
    evidence_hint = str(participant_evidence.get("evidence_hook") or room.title).strip()
    latest_quote = str(participant_evidence.get("latest_quote") or "").strip()
    latest_round = int(participant_evidence.get("latest_round") or 0)
    angle_label = _followup_angle_label(role_hint, language=room.language)
    role_variant = _oracle_role_voice_variant(role_hint, bio_hint)
    role_pressure_clause = _oracle_role_pressure_clause(role_variant, language=room.language)
    profile_focus_hint = _oracle_profile_focus_hint(room)
    if room.language == "zh":
        if thread.mode == EndingRoomThreadMode.ROOM:
            focus = _stable_oracle_choice(variant_seed + ":focus", [
                "我只顺着这间会客厅已经摆开的线索回答，不替别处补词。",
                "这次我只接这间会客厅里已经摆出来的证据，不往别处借词。",
                "我就沿着这张桌上的线索往下讲，不替别处补旁枝。",
            ])
        else:
            focus = _stable_oracle_choice(variant_seed + ":focus", [
                "我只沿着这条追问继续往下说，不把别处的声音混进来。",
                "这次只顺着当前追问往下掰，不把别处的杂音拉进来。",
                "我就按这条追问继续说，不把旁线的声音掺进来。",
            ])
        quote_clause = (
            f"我在 R{latest_round} 当时说过「{latest_quote}」。"
            if latest_quote and latest_round > 0
            else f"我会继续沿着「{evidence_hint}」这根线说下去。"
        )
        if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
            if is_archivist:
                if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                    return (
                        f"{target_label}：先别急着求一个统一答案。"
                        f"{addressed_label or '当前桌上的代表'}各自把自己的断点讲清，我只盯哪一步先把局面推歪。"  # noqa: E501
                    )
                return (
                    f"{target_label}：这轮我不替所有人抢结论。"
                    f"{addressed_label or '当前阵容'}各守一条线，我只把焦点锁在「{evidence_hint}」上。{focus}"  # noqa: E501
                    )
            opener = _stable_oracle_choice(variant_seed + ":relay", [
                "我先补一句",
                "我先接这一角",
                "我先把这一层讲清",
            ]) if response_index == 0 else _stable_oracle_choice(variant_seed + ":relay", [
                "我再接一层",
                "我补另一面",
                "我把另一扣也补上",
            ])
            role_prefix = f"{role_hint}。" if role_hint else ""
            stance_prefix = f"{bio_hint} " if bio_hint else ""
            return (
                f"{target_label}：{opener}{role_prefix}"
                f"{stance_prefix}{quote_clause}"
                f"所以这轮我只把 {angle_label} 讲具体，不把责任抹平成抽象命运。{focus}"
                f"{role_pressure_clause}"
                f"{f'别把{profile_focus_hint}讲成空话。' if profile_focus_hint else ''}"
            )
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
            if is_archivist:
                if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                    return (
                        f"{target_label}：这轮先只听 {addressed_label_zh_roundtable} 把那一手讲透。"
                        "我只补两件事：这一步为什么会把后面钉死，以及改它要付什么代价。"
                    )
                archivist_hotseat_open = _stable_oracle_choice(
                    variant_seed + ":arch-hotseat",
                    [
                        f"这轮热座先听 {addressed_label_zh} 把自己的判断说透。",
                        f"这次先让 {addressed_label_zh} 把那一步讲透，我只补后果。",
                        f"这轮先别抢话，先听 {addressed_label_zh} 把那一手掰开。",
                    ],
                )
                return (
                    f"{target_label}：{archivist_hotseat_open}"
                    f"我只补两件事：那一步为什么会锁死后续，以及改它要付什么代价。{focus}"
                    f"{f'重点别离开{profile_focus_hint}。' if profile_focus_hint else ''}"
                )
            persona_prefix = f"{bio_hint} " if bio_hint else ""
            role_prefix = f"{role_hint}。" if role_hint else ""
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}：{_stable_oracle_choice(variant_seed + ':hotseat-open', [
                        '你就盯着这一步问，那我也不绕。',
                        '你问到这一下，我就直说。',
                        '既然你盯的是这一手，我就不兜圈子。'
                    ])}{role_prefix}"
                    f"{persona_prefix}{quote_clause}"
                    f"真要把关键一手往后压半轮，先坏的不是结局名义上的输赢，而是{angle_label}这根线先松；它一松，后面的代价会自己滚大。"
                )
            return (
                f"{target_label}：{_stable_oracle_choice(variant_seed + ':hotseat-open', [
                    '你点的就是最先松掉的那一扣。',
                    '真要追这条责，就得从这一下说起。',
                    '你问到的正是这一步。'
                ])}{role_prefix}"
                f"{persona_prefix}{quote_clause}"
                f"如果只改一手，我会先把「{evidence_hint}」前的判断慢半拍，先把 {angle_label} 重新对齐；这样能压住失控，但短期一定更乱。"  # noqa: E501
                f"{focus}"
                f"{role_pressure_clause}"
                f"{f'这一下真正牵着的是{profile_focus_hint}。' if profile_focus_hint else ''}"
            )
        if is_archivist:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}：先别把整桌的声音揉平。"
                    f"这一问我先只钉住「{evidence_hint}」这道分叉，再把话交给最该负责的代表。"
                )
            return (
                f"{target_label}：{_stable_oracle_choice(variant_seed + ':arch-route', [
                    '我先把噪声压下去。',
                    '我先把这问钉回真正的分叉点。',
                    '先别让旁枝把问题带偏。'
                ])}"
                f"这一问先压回「{evidence_hint}」，再只点当前世界线里最相关的 1-2 位参与者回答。{focus}"  # noqa: E501
                f"{f'别把{profile_focus_hint}说成空词。' if profile_focus_hint else ''}"
            )
        if addressed_label:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}：这问落到我这条线，我就只讲最先失手的那一下。"
                    f"{quote_clause}对我来说，真正不能退的是「{evidence_hint}」，因为这一下先松了，后面整条线就只能跟着失血。"
                )
            return (
                f"{target_label}：围绕「{user_content}」，我只按当前房间里点名的世界线回声回答。"
                f"{quote_clause}我先解释为什么「{evidence_hint}」在我这里看起来不能再拖。{focus}"
            )
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}：{quote_clause}"
                f"如果你真要问这条线哪里先失手，我会先把「{evidence_hint}」这一下翻出来，因为从这里开始，后面的代价就不是补一句话能收回的。"
            )
        return (
            f"{target_label}：{quote_clause}"
            f"围绕「{user_content}」，我先把「{evidence_hint}」这处转折说清，再把代价讲明白。{focus}"
        )
    if thread.mode == EndingRoomThreadMode.ROOM:
        focus = _stable_oracle_choice(variant_seed + ":focus-en", [
            "I am staying with the evidence already on this chamber table, not borrowing from elsewhere.",  # noqa: E501
            "I am only working with what is already on this chamber table, not importing another branch.",  # noqa: E501
            "I will keep this answer on the evidence already in front of this chamber, not on some other line.",  # noqa: E501
        ])
    else:
        focus = _stable_oracle_choice(variant_seed + ":focus-en", [
            "I am staying on this follow-up thread and not blending in voices from elsewhere.",
            "I am keeping this answer inside the active follow-up thread, not pulling in stray voices.",  # noqa: E501
            "I will stay with this thread only and keep the side-noise out of it.",
        ])
    quote_clause = (
        f"In R{latest_round} I said '{latest_quote}'."
        if latest_quote and latest_round > 0
        else f"I am still staying on the hinge '{evidence_hint}'."
    )
    if interaction_mode == EndingRoomInteractionMode.ALL_PRESENT:
        if is_archivist:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}: do not force a false consensus. "
                    f"{addressed_label or 'The reps on this table'} should each name their own hinge, and I only care which slip broke first."  # noqa: E501
                )
            return (
                f"{target_label}: this pass is about division of labor, not instant consensus. "
                f"{addressed_label or 'The current table'} each hold one strand while I keep the hinge on '{evidence_hint}'. {focus}"  # noqa: E501
            )
        opener = _stable_oracle_choice(variant_seed + ":relay-en", [
            "I will take the first angle",
            "Let me take the first cut",
            "I will open from my side of it",
        ]) if response_index == 0 else _stable_oracle_choice(variant_seed + ":relay-en", [
            "Let me add another angle",
            "I will pick up the next edge",
            "Let me layer in the other side",
        ])
        role_prefix = f"{role_hint}. " if role_hint else ""
        stance_prefix = f"{bio_hint} " if bio_hint else ""
        return (
            f"{target_label}: {opener} {role_prefix}{stance_prefix}{quote_clause} "
            f"In this round I am only covering {angle_label}, not dissolving into generic commentary. {focus}"  # noqa: E501
            f" {role_pressure_clause}"
            f"{f' Keep {profile_focus_hint} concrete.' if profile_focus_hint else ''}"
        )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
        if is_archivist:
            if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
                return (
                    f"{target_label}: let {addressed_label_en_roundtable} answer that move cleanly first. "  # noqa: E501
                    "I am only here to pin the consequence and the cost after that answer lands."
                )
            archivist_hotseat_open = _stable_oracle_choice(
                variant_seed + ":arch-hotseat-en",
                [
                    f"the hotseat answer comes first from {addressed_label_en}.",
                    f"let {addressed_label_en} take the hinge first; I will only close the cost.",
                    f"we start with {addressed_label_en} on the exact move, then I tighten the tradeoff.",  # noqa: E501
                ],
            )
            return (
                f"{target_label}: {archivist_hotseat_open} "
                f"I only collapse the tradeoff after that answer lands. {focus}"
                f"{f' Keep {profile_focus_hint} concrete.' if profile_focus_hint else ''}"
            )
        persona_prefix = f"{bio_hint} " if bio_hint else ""
        role_prefix = f"{role_hint}. " if role_hint else ""
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}: {_stable_oracle_choice(variant_seed + ':hotseat-open-en', [
                    'you are asking about the exact move, so I will stay on it.',
                    'you pinned the hinge, so I will answer from the hinge.',
                    'if we are staying on that move, then I will answer it head-on.'
                ])} {role_prefix}{persona_prefix}{quote_clause} "
                f"If that hinge slips half a beat later, {angle_label} loosens first and the rest of this branch pays for it."  # noqa: E501
            )
        return (
            f"{target_label}: {_stable_oracle_choice(variant_seed + ':hotseat-open-en', [
                'you pointed at the exact hinge.',
                'that is the move you have to put under the lamp.',
                'if you want the first real miss, it starts here.'
            ])} {role_prefix}{persona_prefix}{quote_clause} "
            f"If I only get one correction, I slow down the move right before '{evidence_hint}' and realign {angle_label}; it buys control at the cost of tempo. {focus}"  # noqa: E501
            f" {role_pressure_clause}"
            f"{f' That is where {profile_focus_hint} gets tested first.' if profile_focus_hint else ''}"  # noqa: E501
        )
    if is_archivist:
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}: do not flatten the whole table at once. "
                f"I am pinning this question to '{evidence_hint}' first, then handing it to the representative who owns that damage."  # noqa: E501
            )
        return (
            f"{target_label}: {_stable_oracle_choice(variant_seed + ':arch-route-en', [
                'I will pin the hinge before I route the answer.',
                'Let me force the question back onto the real hinge first.',
                'First I narrow the hinge, then I hand the floor to the right voice.'
            ])} "
            f"The question stays pinned to '{evidence_hint}', then I hand it only to the most relevant current-worldline speakers. {focus}"  # noqa: E501
            f"{f' Keep {profile_focus_hint} concrete.' if profile_focus_hint else ''}"
        )
    if addressed_label:
        if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
            return (
                f"{target_label}: if the question lands on my branch, I answer from the first slip, not from the ending label. "  # noqa: E501
                f"{quote_clause} For me, '{evidence_hint}' is the hinge that made the rest of this branch bleed out."  # noqa: E501
            )
        return (
            f"{target_label}: on '{user_content}', I will answer through the addressed worldline echo only. "  # noqa: E501
            f"{quote_clause} I am starting with '{evidence_hint}' as the hinge. {focus}"
        )
    if room.room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        return (
            f"{target_label}: {quote_clause} "
            f"If you want the earliest miss, I start with '{evidence_hint}', because that is where this branch stopped being recoverable."  # noqa: E501
        )
    return (
        f"{target_label}: {quote_clause} "
        f"On '{user_content}', I will stay with '{evidence_hint}' as the hinge and make the tradeoff explicit. {focus}"  # noqa: E501
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
    if user_content:
        lines.append(f"user_question={sanitize_untrusted_text(user_content, max_chars=280)}")
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


def _normalize_oracle_generated_content(text: str, *, fallback: str, max_chars: int = 520) -> str:
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
    vocab_hint = _oracle_vocabulary_hints(participant.role_slot, variant, room.language, participant.persona_snapshot_json)  # noqa: E501
    vocab_line = f"Persona vocabulary: {vocab_hint}\n" if vocab_hint else ""
    return (
        f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
        "You are generating live Oracle Chambers dialogue for SwarmOracle.\n"
        f"{task_line}\n"
        f"Target voice: {_oracle_voice_brief(room, participant=participant, phase=phase, thread_mode=thread_mode, interaction_mode=interaction_mode)}\n"  # noqa: E501
        f"{vocab_line}"
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
        f"{format_untrusted_text_block('Context', _oracle_context_digest(room, participant=participant, user_content=user_content, context_hint=context_hint), max_chars=2200)}\n\n"  # noqa: E501
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
) -> str:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return anchor_copy
    json_prompt = _build_oracle_rewrite_prompt(
        room=room,
        participant=participant,
        phase=phase,
        anchor_copy=anchor_copy,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        context_hint=context_hint,
        output_json=True,
    )
    plain_text_prompt = _build_oracle_rewrite_prompt(
        room=room,
        participant=participant,
        phase=phase,
        anchor_copy=anchor_copy,
        user_content=user_content,
        thread_mode=thread_mode,
        interaction_mode=interaction_mode,
        recent_lines=recent_lines,
        context_hint=context_hint,
        output_json=False,
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
                    json_prompt,
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
            polished,
            fallback=anchor_copy,
        )
        return content or anchor_copy
    except Exception as structured_exc:
        try:
            with llm_request_scope(quota_key=None, purpose=f"{purpose}:plain_text_retry"):
                import app.services.ending_room_service as _pkg
                plain_result = await asyncio.wait_for(
                    _pkg.llm_call(
                        plain_text_prompt,
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
                polished,
                fallback=anchor_copy,
            )
            return content or anchor_copy
        except Exception as plain_exc:
            _effort_err_str = str(plain_exc).lower()
            _is_effort_unsupported = (
                "reasoning_effort" in _effort_err_str
                or ("reasoning" in _effort_err_str and "400" in str(plain_exc))
                or "unsupported parameter" in _effort_err_str
            )
            if _is_effort_unsupported:
                try:
                    with llm_request_scope(quota_key=None, purpose=f"{purpose}:no_effort_retry"):
                        import app.services.ending_room_service as _pkg_retry
                        no_effort_result = await asyncio.wait_for(
                            _pkg_retry.llm_call(
                                plain_text_prompt,
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
                        polished,
                        fallback=anchor_copy,
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
                    "Oracle Chambers LLM fallback for %s: structured=%s ; plain=%s",
                    purpose,
                    structured_exc,
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
) -> str:
    prompt = _build_oracle_rewrite_prompt(
        room=room,
        participant=participant,
        phase=phase,
        anchor_copy=anchor_copy,
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
                reasoning_effort="low",
                temperature=0.55,
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
    polished = _strip_oracle_scope_boilerplate(
        "".join(chunks),
        language=room.language,
    )
    return _normalize_oracle_generated_content(polished, fallback=anchor_copy)
