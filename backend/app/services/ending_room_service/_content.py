"""Oracle voice, vocabulary hints, content builders, and LLM rewrite functions."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from sqlmodel import Session, select

from app.config import settings
from app.models import (
    Branch,
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
    llm_call,
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
    _parse_key_moments,
    _roundtable_branch_hook,
    _stable_oracle_choice,
    _strip_question_prefix,
    sanitize_untrusted_text,
)

logger = logging.getLogger(__name__)
_MAX_INSIGHT_REWRITES = 8
_INSIGHT_REWRITE_CONCURRENCY = 3


def _roundtable_participant_variant(participant: EndingRoomParticipant | None) -> str:
    snapshot = participant.persona_snapshot_json if participant is not None else {}
    role_hint = str((snapshot or {}).get("agent_role") or "").strip()
    bio_hint = str(
        (snapshot or {}).get("bio_short") or (snapshot or {}).get("agent_persona") or ""
    ).strip()
    return _oracle_role_voice_variant(role_hint, bio_hint)


def _roundtable_question_prefix(scenario_question: str | None, *, language: str) -> str:
    question = sanitize_untrusted_text(str(scenario_question or ""), max_chars=180)
    if not question:
        return ""
    if language == "zh":
        return f"针对「{question}」这个问题，"
    if re.search(r"[\u3400-\u9fff]", question):
        return ""
    return f"For the question '{question}', "


def _phase_value_for_insight_turn(turn: dict[str, Any]) -> str:
    phase = turn["phase"]
    return phase.value if hasattr(phase, "value") else str(phase)


def _roundtable_phase_turn_excerpt_block(
    planned_turns: list[dict[str, Any]],
    *,
    phase: str,
) -> str:
    excerpts = [
        str(turn.get("content") or "").strip()
        for turn in planned_turns
        if _phase_value_for_insight_turn(turn) == phase
    ]
    return "\n".join(f"- {excerpt}" for excerpt in excerpts[:4] if excerpt)


def _roundtable_phase_insight_prompt(
    *,
    insight: dict[str, Any],
    planned_turns: list[dict[str, Any]],
    language: str,
    scenario_question: str | None,
) -> str:
    phase = str(insight.get("phase") or "")
    current_insight = json.dumps(
        {
            "phase": phase,
            "stakes": insight.get("stakes"),
            "moderator_focus": insight.get("moderator_focus"),
            "commentary": insight.get("commentary"),
            "insight_body": insight.get("insight_body"),
        },
        ensure_ascii=False,
    )
    turn_excerpts = _roundtable_phase_turn_excerpt_block(
        planned_turns,
        phase=phase,
    )
    if language == "zh":
        instruction = (
            "你是世界线圆桌的主持人。请用简体中文改写这一阶段洞察，"
            "让它更像给读者看的主持人总结。\n"
            "只输出一段可直接展示的洞察文本。不要 JSON、Markdown、项目符号、"
            "代码块或推理过程。保留原阶段的事实边界，不新增世界线事件。"
        )
    else:
        instruction = (
            "You are the host of a Worldline Roundtable. Write in English and "
            "rewrite this phase insight as a reader-facing moderator takeaway.\n"
            "Output one display-ready paragraph only. Do not output JSON, "
            "Markdown, bullets, code fences, or reasoning. Preserve the phase's "
            "factual boundaries and do not invent new worldline events."
        )
    question_block = format_untrusted_text_block(
        "Scenario question",
        scenario_question or "",
        max_chars=600,
    )
    insight_block = format_untrusted_text_block(
        "Current insight",
        current_insight,
        max_chars=1200,
    )
    excerpts_block = format_untrusted_text_block(
        "Phase turn excerpts",
        turn_excerpts,
        max_chars=1800,
    )
    return (
        f"{instruction}\n"
        f"Phase: {phase}\n"
        f"{question_block}\n"
        f"{insight_block}\n"
        f"{excerpts_block}"
    )


def _normalize_roundtable_phase_insight_output(
    output: Any,
    *,
    scenario_question: str | None,
) -> str | None:
    def _looks_like_invalid_display_text(value: str) -> bool:
        leading_text = value.lstrip()
        return (
            leading_text.startswith(("{", "[", "```", "<think"))
            or "```" in value
            or re.match(r"^(?:[-*+]\s+|\d+[.)]\s+)", leading_text) is not None
        )

    cleaned = _strip_reasoning_blocks(str(output or "")).strip()
    if not cleaned:
        return None
    if _looks_like_invalid_display_text(cleaned):
        return None
    cleaned = _strip_question_prefix(
        cleaned,
        scenario_question=scenario_question,
    ).strip()
    if _looks_like_invalid_display_text(cleaned):
        return None
    cleaned = sanitize_untrusted_text(cleaned, max_chars=900)
    if len(cleaned) < 15:
        return None
    return cleaned


async def _enhance_roundtable_phase_insights(
    *,
    insights: list[dict[str, Any]],
    planned_turns: list[dict[str, Any]],
    language: str,
    scenario_question: str | None,
    llm_overrides: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Optionally rewrite Worldline Roundtable phase insights via server LLM."""

    if not settings.FEATURE_ROUNDTABLE_INSIGHT_LLM:
        return insights

    overrides = llm_overrides or {}
    rewritten = [dict(insight) for insight in insights]
    rewrite_count = min(len(rewritten), _MAX_INSIGHT_REWRITES)
    if rewrite_count <= 0:
        return rewritten

    semaphore = asyncio.Semaphore(_INSIGHT_REWRITE_CONCURRENCY)

    async def _rewrite_one(index: int) -> None:
        insight = rewritten[index]
        if len(str(insight.get("insight_body") or "").strip()) < 10:
            return
        prompt = _roundtable_phase_insight_prompt(
            insight=insight,
            planned_turns=planned_turns,
            language=language,
            scenario_question=scenario_question,
        )
        phase = str(insight.get("phase") or "unknown")
        try:
            async with semaphore:
                with llm_request_scope(
                    quota_key=None,
                    purpose=f"roundtable_phase_insight_{phase}_{index}",
                    requests_per_minute=overrides.get("requests_per_minute"),
                    tokens_per_minute=overrides.get("tokens_per_minute"),
                    concurrency=overrides.get("concurrency"),
                    supports_structured_outputs_override=overrides.get(
                        "supports_structured_outputs_override"
                    ),
                    supports_native_search_override=overrides.get(
                        "supports_native_search_override"
                    ),
                    native_search_upstream_override=overrides.get(
                        "native_search_upstream_override"
                    ),
                ):
                    raw_output = await asyncio.wait_for(
                        llm_call(
                            prompt,
                            reasoning_effort="low",
                            temperature=0.45,
                            timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
                            model=overrides.get("model"),
                            api_key=overrides.get("api_key"),
                            base_url=overrides.get("base_url"),
                        ),
                        timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS + 1.0,
                    )
            normalized = _normalize_roundtable_phase_insight_output(
                raw_output,
                scenario_question=scenario_question,
            )
        except Exception as exc:
            logger.info(
                "Roundtable phase insight rewrite failed",
                extra={
                    "event": "roundtable_phase_insight_rewrite_failed",
                    "phase": phase,
                    "reason": type(exc).__name__,
                },
            )
            return
        if normalized is None:
            return
        insight["commentary"] = normalized
        insight["insight_body"] = normalized

    await asyncio.gather(*(_rewrite_one(index) for index in range(rewrite_count)))
    return rewritten


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
            "diplomat": ["退让底线先被碰穿了", "各方筹码先失了衡", "斡旋空间先缩没了"],
            "advisor": ["可选项先变窄了", "窗口期先被拖过去了", "代价曲线先变陡了"],
            "science": ["样本和假设先对不上了", "控制变量先被打乱了", "模型误差先开始放大"],
            "tech-visionary": [
                "原型交付先卡在第一批用户手里",
                "发布窗口先被真实延迟压住",
                "试点数据先把扩张计划拦住",
            ],
            "journalist": ["公开记录先露了缝", "关键消息源先改了口", "谁受益先变得太清楚"],
            "educator": ["问题定义先偏了", "关键概念先被误读了", "反例先把课堂秩序打破了"],
            "artist": ["表达和行动先失了焦", "构图先把裂缝显出来了", "共振先变成了噪声"],
            "entrepreneur": [
                "首批客户先没留下来",
                "试点成本先吃掉了现金余量",
                "下一轮实验先交不出结果",
            ],
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
            "diplomat": [
                "the red line was crossed before mediation found leverage",
                "the bargaining table lost balance before terms could hold",
                "the concession space closed before the room admitted it",
            ],
            "advisor": [
                "the option set narrowed before the decision was owned",
                "the window closed before the trade-off was named",
                "the cost curve steepened before counsel could slow it",
            ],
            "science": [
                "the sample and the assumption stopped matching",
                "the control variable broke before the model could defend itself",
                "the error term widened before anyone named the bias",
            ],
            "tech-visionary": [
                "prototype delivery stalled with the first users",
                "the launch window was pinned down by real delays",
                "pilot data stopped the expansion plan first",
            ],
            "journalist": [
                "the public record exposed the first contradiction",
                "the key source changed their line before the denial landed",
                "who benefited became visible before anyone took responsibility",
            ],
            "educator": [
                "the problem definition drifted before the lesson could hold",
                "the key concept was misread before the answer formed",
                "the counterexample broke the tidy frame first",
            ],
            "artist": [
                "expression and action fell out of focus first",
                "the composition made the fracture visible before the speech did",
                "the resonance turned into noise before the ending was named",
            ],
            "entrepreneur": [
                "the first customers failed to stay",
                "pilot costs ate through the cash buffer first",
                "the next experiment failed to produce a result",
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


def _participant_display_name(participant: EndingRoomParticipant, language: str) -> str:
    cleaned = sanitize_untrusted_text(participant.display_name, max_chars=80)
    role_hint = sanitize_untrusted_text(
        str((participant.persona_snapshot_json or {}).get("agent_role") or ""),
        max_chars=80,
    )
    cleaned_lower = cleaned.lower()
    is_archivist_name = bool(re.match(r"^archivist(?:\b|[_-])", cleaned_lower))
    if (
        language == "zh"
        and (
            role_hint.lower() == "archivist"
            or is_archivist_name
            or (
                participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
                and cleaned_lower == "archivist"
            )
        )
    ):
        return "档案官"
    if cleaned:
        return cleaned
    if participant.role_slot == EndingRoomRoleSlot.ARCHIVIST and language == "zh":
        return "档案官"
    return participant.role_slot.value


def _localized_archivist_text(
    participant: EndingRoomParticipant,
    language: str,
    value: Any,
) -> str:
    cleaned = sanitize_untrusted_text(str(value or ""), max_chars=180)
    if (
        language == "zh"
        and participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
        and cleaned.lower() == "archivist"
    ):
        return "档案官"
    return cleaned


_ASCII_TOKEN_PATTERN_CACHE: dict[str, "re.Pattern[str]"] = {}


def _has_ascii_token(text: str, token: str) -> bool:
    """W-12: match an ASCII keyword with word boundaries.

    Plain ``token in text`` lets ``"lord" in "warlord"`` slip through and
    mis-route entire personas (e.g. a *warlord* persona picks up the
    ``imperial`` voice).  We require ASCII keywords to sit on a word
    boundary; multi-word phrases keep substring semantics because spaces
    already act as separators.
    """
    if not token:
        return False
    if " " in token:
        return token in text
    pattern = _ASCII_TOKEN_PATTERN_CACHE.get(token)
    if pattern is None:
        pattern = re.compile(rf"\b{re.escape(token)}\b")
        _ASCII_TOKEN_PATTERN_CACHE[token] = pattern
    return pattern.search(text) is not None


def _matches_any_token(text: str, tokens: tuple[str, ...]) -> bool:
    """Match ASCII tokens by word boundary, CJK tokens by substring."""
    for token in tokens:
        if token.isascii():
            if _has_ascii_token(text, token):
                return True
        elif token in text:
            return True
    return False


def _oracle_role_voice_variant(role_hint: str | None, bio_hint: str | None) -> str:
    normalized = f"{role_hint or ''} {bio_hint or ''}".strip().lower()
    if _matches_any_token(
        normalized,
        (
            "tech visionary", "silicon valley", "futurist", "disruption",
            "paradigm shift", "exponential", "moonshot", "singularity",
        ),
    ):
        return "tech-visionary"
    if _matches_any_token(
        normalized,
        (
            "journalist", "reporter", "newsroom", "investigative",
            "sources confirm", "on the record", "breaking", "exclusive",
            "correspondent", "editorial desk",
        )
    ):
        return "journalist"
    if _matches_any_token(
        normalized,
        (
            "educator", "professor", "teacher", "lecturer", "instructor",
            "academic", "curriculum", "pedagogy", "let us unpack",
        )
    ):
        return "educator"
    if _matches_any_token(
        normalized,
        (
            "artist", "painter", "composer", "curator", "creative director",
            "aesthetic", "expression", "craft ", "resonance",
        )
    ):
        return "artist"
    if _matches_any_token(
        normalized,
        (
            "entrepreneur", "startup", "founder", "cofounder", "venture builder",
            "pivot", "runway", "traction", "iterate",
            "growth-stage", "product-market fit",
        )
    ):
        return "entrepreneur"
    if _matches_any_token(
        normalized,
        (
            "皇", "贵族", "公爵", "亲王", "王储",
            "king", "queen", "emperor", "crown", "court",
            "noble", "duke", "lord", "baron", "prince", "princess",
            "regent", "viceroy",
        )
    ):
        return "imperial"
    if _matches_any_token(
        normalized,
        (
            "将", "统帅", "指挥官", "舰队", "参谋", "军师", "元帅",
            "commander", "captain", "marshal", "fleet", "guard",
            "general", "warlord", "chieftain", "warrior", "admiral",
            "colonel", "sergeant", "lieutenant",
        )
    ):
        return "field"
    if _matches_any_token(
        normalized,
        (
            "银行", "行长", "财政", "金融", "清算", "流动性",
            "审计", "会计", "投资",
            "bank", "banker", "finance", "treasury", "settlement", "liquidity",
            "accountant", "auditor", "investor", "broker",
        )
    ):
        return "finance"
    if _matches_any_token(
        normalized,
        (
            "摊主", "商户", "商贩", "市场", "港口", "贸易", "货运",
            "店主", "掌柜", "酒馆", "农夫", "工匠", "手艺人",
            "vendor", "merchant", "market", "port", "trade", "freight",
            "shopkeeper", "innkeeper", "tavern", "farmer", "craftsman", "artisan",
        )
    ):
        return "market"
    if _matches_any_token(
        normalized,
        (
            "祭司", "祭坛", "神官", "修士", "神谕", "僧", "和尚", "主教", "教会",
            "priest", "cleric", "oracle", "temple", "faith", "ritual", "covenant",
            "monk", "bishop", "cardinal", "church", "monastery", "abbey",
        )
    ):
        return "faith"
    if _matches_any_token(
        normalized,
        (
            "工程", "工厂", "电网", "产能", "后勤", "调度",
            "技师", "矿", "工头",
            "engineer", "factory", "industrial", "grid", "throughput",
            "logistics", "plant",
            "technician", "mechanic", "foreman", "miner", "mining",
        )
    ):
        return "industry"
    if _matches_any_token(
        normalized,
        (
            "边疆", "拓荒", "殖民", "轨道", "补给舱", "生命维持",
            "宇航", "航天", "探险",
            "pilot", "orbital", "frontier", "colony", "expedition", "convoy",
            "airlock", "life support",
            "astronaut", "navigator", "explorer",
        )
    ):
        return "frontier"
    if _matches_any_token(
        normalized,
        (
            "避难", "药品", "口粮", "撤离", "医疗",
            "医生", "大夫", "护士",
            "scout", "medic", "refuge", "ration", "evacuation",
            "shelter", "survival",
            "doctor", "physician", "surgeon", "nurse", "paramedic",
        )
    ):
        return "survival"
    if _matches_any_token(
        normalized,
        (
            "史官", "书记官", "学者", "档案", "证人",
            "scribe", "scholar", "historian", "witness", "record", "ledger", "clerk",
        )
    ):
        return "scholar"
    if _matches_any_token(
        normalized,
        (
            "议长", "文书", "总督", "知府", "太守", "官员", "大臣", "县令",
            "speaker", "minister", "council",
            "governor", "mayor", "senator", "representative",
            "magistrate", "congressman", "alderman", "prefect",
        )
    ):
        return "civic"
    if _matches_any_token(
        normalized,
        (
            "外交", "大使", "使节", "使者", "领事",
            "diplomat", "ambassador", "envoy", "consul", "emissary", "negotiator",
        )
    ):
        return "diplomat"
    if _matches_any_token(
        normalized,
        (
            "顾问", "谋士", "谋臣", "幕僚", "参赞",
            "advisor", "strategist", "counselor", "aide", "consultant",
        )
    ):
        return "advisor"
    if _matches_any_token(
        normalized,
        (
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
    "tech-visionary": {
        "zh": "用词偏好：平台。只有后面立刻接具体动作或数字时才使用这个标志词；否则优先说原型、试点、发布日期或用户反馈。先说下一步执行，再说明愿景。情绪基调：高能、笃定、略带硅谷式急迫。",  # noqa: E501
        "en": "Vocabulary: platform. Use this marker only when it is immediately followed by a concrete action or number; otherwise prefer prototype, pilot, launch date, or user feedback. Name the next execution step before the vision. Tone: high-energy Silicon Valley urgency.",  # noqa: E501
    },
    "journalist": {
        "zh": "用词偏好：消息源证实、公开记录、独家、突发、采访、交叉核实。先给事实钩子，再指出谁受益、谁回避。情绪基调：紧凑、怀疑、追问到底。",  # noqa: E501
        "en": "Vocabulary: sources confirm, on the record, exclusive, breaking, interview, cross-check. Lead with the factual hook, then name who benefits and who dodges. Tone: tight investigative skepticism.",  # noqa: E501
    },
    "educator": {
        "zh": "用词偏好：反例、概念框架、把问题拆成两层、前提、边界、推导。先用一个具体例子或反例切入，避免开头先抛抽象框架。情绪基调：清晰、耐心、有课堂掌控感但不端架子。",  # noqa: E501
        "en": "Vocabulary: counterexample, conceptual frame, split the problem into two layers, premise, boundary, reasoning. Lead with a concrete example or counterexample; avoid opening with an abstract framework. Tone: clear, patient classroom control without stiffness.",  # noqa: E501
    },
    "artist": {
        "zh": "用词偏好：愿景、媒介、表达、技艺、共振、构图。先说感受形状，再说它如何改变行动。情绪基调：敏锐、审美化、克制地诗性。",  # noqa: E501
        "en": "Vocabulary: vision, medium, expression, craft, resonance, composition. Start with the felt shape, then how it changes action. Tone: perceptive, aesthetic, restrainedly lyrical.",  # noqa: E501
    },
    "entrepreneur": {
        "zh": "用词偏好：留存数字、下一轮实验；如需角色标志词，只用“试点客户”，且后面必须立刻接具体动作或数字。先判断可行性，再给下一轮实验。情绪基调：快速、务实、带创始人压力。",  # noqa: E501
        "en": "Vocabulary: retention number and next experiment; if a role marker is needed, use only 'pilot customer' and immediately follow it with a concrete action or number. Judge viability first, then name the next experiment. Tone: fast, pragmatic founder pressure.",  # noqa: E501
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
    scenario_question: str | None = None,
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
    question_prefix = _roundtable_question_prefix(scenario_question, language=language)
    if language == "zh":
        base = f"{question_prefix}《{title}》的关键转折在「{hook}」。"
        if insight and insight != hook:
            base += f"这之后的走向是「{insight}」。"
        return base
    base = (
        f"{question_prefix}the key turning point in {title} was '{hook}'."
        if question_prefix
        else f"The key turning point in {title} was '{hook}'."
    )
    if insight and insight != hook:
        base += f" From there it moved toward '{insight}'."
    return base


def _build_roundtable_crossfire_content(
    branch_cards: list[dict[str, Any]],
    *,
    language: str,
    scenario_question: str | None = None,
) -> str:
    """Pure factual contrast anchor for the crossfire turn.

    Returns a minimal hinge comparison; voice and tone differentiation
    are produced by the LLM generation layer.
    """
    question_prefix = _roundtable_question_prefix(scenario_question, language=language)
    if not branch_cards:
        return (
            f"{question_prefix}尚无可对比的世界线摘要。"
            if language == "zh"
            else (
                f"{question_prefix}no worldline summaries are available to compare yet."
                if question_prefix
                else "No worldline summaries available to compare yet."
            )
        )
    lead = branch_cards[0]
    lead_hook = _resolve_roundtable_hook(lead, participant=None, language=language)
    lead_title = _oracle_visible_text(lead.get("title"), language=language, limit=40) or (
        "当前世界线" if language == "zh" else "this ending"
    )
    rival = branch_cards[1] if len(branch_cards) > 1 else None
    if language == "zh":
        if rival is None:
            return f"{question_prefix}焦点：《{lead_title}》的关键转折——「{lead_hook}」。"
        rival_hook = _resolve_roundtable_hook(rival, participant=None, language=language)
        rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "另一条世界线"  # noqa: E501
        return (
            f"{question_prefix}对比：《{lead_title}》的转折在「{lead_hook}」；"
            f"《{rival_title}》的转折在「{rival_hook}」。"
        )
    if rival is None:
        return (
            f"{question_prefix}focus: the key hinge of {lead_title} was '{lead_hook}'."
            if question_prefix
            else f"Focus: the key hinge of {lead_title} was '{lead_hook}'."
        )
    rival_hook = _resolve_roundtable_hook(rival, participant=None, language=language)
    rival_title = _oracle_visible_text(rival.get("title"), language=language, limit=40) or "another ending"  # noqa: E501
    return (
        (
            f"{question_prefix}contrast: {lead_title} hinged on '{lead_hook}'; "
            if question_prefix
            else f"Contrast: {lead_title} hinged on '{lead_hook}'; "
        )
        + f"{rival_title} hinged on '{rival_hook}'."
    )

def _build_roundtable_verdict_content(
    branch_cards: list[dict[str, Any]],
    *,
    language: str,
    scenario_question: str | None = None,
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
    question_prefix = _roundtable_question_prefix(scenario_question, language=language)
    if language == "zh":
        if rival_title and rival_hinge:
            return (
                f"{question_prefix}这轮讨论更愿意把《{lead_title}》当作当前答案："
                f"先改变局面的，是「{lead_hinge}」。不过《{rival_title}》留下的"
                f"「{rival_hinge}」还在提醒我们，后面追问时不能把这条风险抹掉。"
            )
        return (
            f"{question_prefix}这轮讨论最后落在《{lead_title}》上："
            f"真正把局面推到这里的，是「{lead_hinge}」。后续追问可以从这个转折继续拆。"
        )
    lead_intro = "the table is leaning toward" if question_prefix else "The table is leaning toward"
    if rival_title and rival_hinge:
        return (
            f'{question_prefix}{lead_intro} "{lead_title}" for now: '
            f'"{lead_hinge}" is what first moved the situation. Still, '
            f'"{rival_title}" keeps "{rival_hinge}" on the table, so the next '
            "follow-up should keep that risk in view."
        )
    return (
        f'{question_prefix}{lead_intro} "{lead_title}": '
        f'"{lead_hinge}" is the turn that pushed this line into view. '
        "The next question can pick up from there."
    )


def _build_roundtable_witness_content(
    branch_card: dict[str, Any],
    *,
    witness: EndingRoomParticipant,
    branch_rows: list[dict[str, Any]],
    language: str,
    scenario_question: str | None = None,
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
    question_prefix = _roundtable_question_prefix(scenario_question, language=language)
    if language == "zh":
        identity = f"{witness.display_name}作为证人"
        if role_hint and role_hint.lower() not in {"证人", "witness"}:
            identity = f"{identity}，身份是{role_hint}"
        if bio_hint:
            identity = f"{identity}，{bio_hint}"
        parts: list[str] = [
            f"{question_prefix}{identity}，把《{branch_title}》的关键转折指向「{evidence_hook}」"
        ]
        if quote and latest_round > 0:
            parts.append(f"R{latest_round} 的原话是：「{quote}」")
        return "。".join(parts) + "。"
    identity_en = f"{witness.display_name} speaks as a witness"
    if role_hint and role_hint.lower() != "witness":
        identity_en = f"{identity_en}, as {role_hint}"
    if bio_hint:
        identity_en = f"{identity_en}, {bio_hint}"
    parts_en: list[str] = [
        f'{question_prefix}{identity_en}, and points to "{evidence_hook}" '
        f'as the hinge in "{branch_title}"'
    ]
    if quote and latest_round > 0:
        parts_en.append(f'In R{latest_round}, the line was: "{quote}"')
    return ". ".join(parts_en) + "."


def _followup_fallback_hinge(
    participant_evidence: dict[str, Any],
    *,
    language: str,
) -> str:
    for key, limit in (
        ("evidence_hook", 84),
        ("branch_insight", 84),
        ("branch_title", 60),
        ("latest_quote", 84),
    ):
        value = _oracle_visible_clause(
            participant_evidence.get(key),
            language=language,
            limit=limit,
        )
        if value:
            return value
    return ""


def _followup_role_suffix(role_hint: str, *, language: str) -> str:
    cleaned = sanitize_untrusted_text(role_hint, max_chars=40).strip()
    if not cleaned:
        return ""
    if language == "zh":
        lowered = cleaned.lower()
        if lowered == "archivist":
            return "（档案官）"
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9 _/-]{2,}", cleaned):
            return ""
        return f"（{cleaned}）"
    return f" ({cleaned})"


def _clean_followup_question_echo(user_content: str | None, *, language: str) -> str:
    cleaned = sanitize_untrusted_text(user_content or "", max_chars=120)
    if not cleaned:
        return ""
    if language == "zh":
        if cleaned.count("你问") > 1:
            return ""
        cleaned = re.sub(r"[\w\u4e00-\u9fff·\s]{1,40}：(?=你问|我先|这句)", "", cleaned)
        cleaned = re.sub(r"你问[「\"]\s*你问", "你问", cleaned)
        recursive_markers = ("我会把答案落在", "这不是旁枝", "桌面上真正能判")
        if cleaned.count("你问") > 1 or "你问「你问" in cleaned:
            return ""
    else:
        cleaned = re.sub(r"^[A-Za-z][A-Za-z0-9 ._-]{1,40}:\s*", "", cleaned)
        cleaned = re.sub(
            r"\bYou asked ['\"]?\s*You asked\b",
            "You asked",
            cleaned,
            flags=re.I,
        )
        recursive_markers = ("I would anchor the answer", "That is not side detail")
    if any(marker in cleaned for marker in recursive_markers):
        return ""
    return sanitize_untrusted_text(cleaned, max_chars=52)


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
    target_label = _participant_display_name(response_participant, room.language)
    addressed_label = " / ".join(
        _participant_display_name(participant, room.language)
        for participant in addressed_participants
    )
    is_archivist = response_participant.role_slot == EndingRoomRoleSlot.ARCHIVIST
    role_hint = str(participant_evidence.get("role_hint") or "").strip()
    bio_hint = str(participant_evidence.get("bio_hint") or "").strip()
    latest_quote = str(participant_evidence.get("latest_quote") or "").strip()
    latest_round = int(participant_evidence.get("latest_round") or 0)
    profile_focus_hint = _oracle_profile_focus_hint(room)

    is_zh = room.language == "zh"
    evidence_hint = _followup_fallback_hinge(participant_evidence, language=room.language)
    user_question = _clean_followup_question_echo(user_content, language=room.language)

    def _clean_sentence(value: str) -> str:
        return str(value or "").strip().strip("。.!?！？")

    def _zh_join(*parts: str) -> str:
        cleaned = [_clean_sentence(part) for part in parts if _clean_sentence(part)]
        return "。".join(cleaned) + ("。" if cleaned else "")

    def _en_join(*parts: str) -> str:
        cleaned = [_clean_sentence(part) for part in parts if _clean_sentence(part)]
        return ". ".join(cleaned) + ("." if cleaned else "")

    role_suffix = _followup_role_suffix(role_hint, language=room.language)
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
        speaker = f"我{role_suffix}"
        hinge_clause = f"「{evidence_hint}」" if evidence_hint else "这处转折"
        question_clause = f"你问「{user_question}」" if user_question else "这句追问"
        if interaction_mode == EndingRoomInteractionMode.THREAD_FOLLOWUP:
            return _zh_join(
                f"{question_clause}，我会把答案落在{hinge_clause}",
                quote_zh,
                "这不是旁枝，是这条线还能不能继续推进的门槛",
            )
        if interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
            return _zh_join(
                f"这张证据卡真正补上的，是{hinge_clause}",
                quote_zh,
                "它改变的不是气氛，而是这场争论里哪条因果链更硬",
            )
        if interaction_mode == EndingRoomInteractionMode.EPILOGUE:
            return _zh_join(
                f"往后三步看，先回来的还是{hinge_clause}这笔账",
                quote_zh,
                "它会继续压着人做选择，而不是在结局页就消失",
            )
        if is_archivist:
            target_clause = f"这句是追着{addressed_label}来的" if addressed_label else ""
            return _zh_join(
                "我先把这句追问钉住",
                target_clause,
                f"桌面上真正能判的转折，是{hinge_clause}",
                f"接下来要问的是它怎样改变{profile_focus_hint or '后果'}",
            )
        if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
            target = addressed_label if addressed_label and addressed_label != target_label else ""
            target_clause = (
                f"你点名{target}，其实是在追问{hinge_clause}"
                if target
                else f"这句追问落在{hinge_clause}"
            )
            return _zh_join(
                f"{speaker}会先回答这一点：{target_clause}",
                quote_zh,
                "我的回答是，这里撑不住，后面的判断也就站不稳",
            )
        return _zh_join(
            f"{speaker}只补一个角度，关键仍是{hinge_clause}",
            quote_zh or bio_hint,
            f"这会直接影响{profile_focus_hint or '后续代价'}",
        )

    speaker = f"I{role_suffix}"
    hinge_clause = f"'{evidence_hint}'" if evidence_hint else "that hinge"
    question_clause = f"You asked '{user_question}'" if user_question else "This follow-up"
    if interaction_mode == EndingRoomInteractionMode.THREAD_FOLLOWUP:
        return _en_join(
            f"{question_clause}, and I would anchor the answer on {hinge_clause}",
            quote_en,
            "That is not side detail; it is the threshold this line has to survive",
        )
    if interaction_mode == EndingRoomInteractionMode.EVIDENCE_CARD:
        return _en_join(
            f"This evidence card adds one thing that matters: {hinge_clause}",
            quote_en,
            "It changes which causal chain in the table can actually carry the verdict",
        )
    if interaction_mode == EndingRoomInteractionMode.EPILOGUE:
        return _en_join(
            f"Three moves later, the bill still comes due at {hinge_clause}",
            quote_en,
            "That pressure keeps forcing choices after the ending page",
        )
    if is_archivist:
        target_clause = f"This follows {addressed_label}'s answer" if addressed_label else ""
        return _en_join(
            "I would pin this follow-up to one hinge",
            target_clause,
            f"The table can actually judge the hinge: {hinge_clause}",
            f"The next question is how it changes {profile_focus_hint or 'the consequences'}",
        )
    if interaction_mode == EndingRoomInteractionMode.HOTSEAT:
        target = addressed_label if addressed_label and addressed_label != target_label else ""
        target_clause = (
            f"You named {target}, but the real question is {hinge_clause}"
            if target
            else f"The question lands on {hinge_clause}"
        )
        return _en_join(
            f"{speaker} would answer this first: {target_clause}",
            quote_en,
            "If that fails, the later judgment does not stand either",
        )
    return _en_join(
        f"{speaker} will add one angle; the hinge is still {hinge_clause}",
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


def _oracle_speaker_brief(participant: EndingRoomParticipant, *, language: str) -> str:
    snapshot = participant.persona_snapshot_json or {}
    pieces = [
        f"name={_participant_display_name(participant, language)}",
        f"role_slot={participant.role_slot.value}",
    ]
    if snapshot.get("agent_role"):
        pieces.append(
            f"role_hint={_localized_archivist_text(participant, language, snapshot['agent_role'])}"
        )
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
            "governance": "公共事务",
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
        f"speaker_name={_participant_display_name(participant, language)}",
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
        value=_localized_archivist_text(participant, language, snapshot.get("agent_role")),
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
        f"speaker={_oracle_speaker_brief(participant, language=room.language)}",
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


def _oracle_agent_stance_summary_lines(
    participants: list[EndingRoomParticipant],
    *,
    language: str,
) -> list[str]:
    lines: list[str] = []
    seen: set[str] = set()
    for participant in participants:
        if participant.role_slot in {EndingRoomRoleSlot.ARCHIVIST, EndingRoomRoleSlot.USER}:
            continue
        if participant.id in seen:
            continue
        seen.add(participant.id)
        snapshot = participant.persona_snapshot_json or {}
        name = sanitize_untrusted_text(participant.display_name, max_chars=80)
        if not name:
            continue
        role = _oracle_visible_text(snapshot.get("agent_role"), language=language, limit=80)
        stance = sanitize_untrusted_text(
            str(
                snapshot.get("agent_stance")
                or snapshot.get("branch_pressure")
                or snapshot.get("latest_quote")
                or snapshot.get("opening_quote")
                or ""
            ),
            max_chars=220,
        )
        branch_title = _oracle_visible_text(
            snapshot.get("branch_title") or snapshot.get("witness_branch_title"),
            language=language,
            limit=80,
        )
        details = [f"name={name}"]
        if role:
            details.append(f"role={role}")
        if branch_title:
            details.append(f"worldline={branch_title}")
        if stance:
            details.append(f"stance_summary={stance}")
        lines.append(f"agent_stance_{len(lines) + 1}=" + " | ".join(details))
        if len(lines) >= 6:
            break
    return lines


def _oracle_rich_simulation_context_digest(
    room: EndingRoom,
    *,
    participant: EndingRoomParticipant,
    scenario_question: str | None = None,
) -> str:
    lines: list[str] = []
    branch_id = room.anchor_branch_id or participant.source_branch_id
    branch: Branch | None = None
    question = scenario_question
    room_participants: list[EndingRoomParticipant] = []
    try:
        with Session(get_engine()) as session:
            scenario = session.get(Scenario, room.scenario_id)
            if question is None and scenario is not None:
                question = scenario.question
            if branch_id:
                branch_row = session.get(Branch, branch_id)
                if branch_row is not None and branch_row.scenario_id == room.scenario_id:
                    branch = branch_row
            room_participants = list(
                session.exec(
                    select(EndingRoomParticipant)
                    .where(EndingRoomParticipant.room_id == room.id)
                    .order_by(EndingRoomParticipant.role_slot, EndingRoomParticipant.id)
                ).all()
            )
    except Exception as exc:  # pragma: no cover - defensive context enrichment
        logger.debug(
            "Oracle rich simulation context unavailable",
            extra={
                "event": "oracle_rich_context_unavailable",
                "room_id": room.id,
                "room_type": room.room_type.value,
                "reason": str(exc),
            },
        )

    _append_oracle_context_text(
        lines,
        key="scenario_question",
        value=question,
        language=room.language,
        limit=500,
    )
    if branch is not None:
        _append_oracle_context_text(
            lines,
            key="anchor_branch_title",
            value=branch.title,
            language=room.language,
            limit=100,
        )
        if branch.probability is not None:
            lines.append(f"branch_probability={float(branch.probability):.3f}")
        _append_oracle_context_text(
            lines,
            key="branch_insight",
            value=branch.insight,
            language=room.language,
            limit=700,
        )
        _append_oracle_context_text(
            lines,
            key="branch_story_excerpt",
            value=branch.story,
            language=room.language,
            limit=2000,
        )
        for index, moment in enumerate(_parse_key_moments(branch.key_moments)[:3], start=1):
            _append_oracle_context_text(
                lines,
                key=f"key_moment_{index}",
                value=moment,
                language=room.language,
                limit=260,
            )
    lines.extend(
        _oracle_agent_stance_summary_lines(
            room_participants or [participant],
            language=room.language,
        )
    )
    return "\n".join(line for line in lines if line)


def _oracle_combined_context_digest(
    room: EndingRoom,
    *,
    participant: EndingRoomParticipant,
    user_content: str | None = None,
    context_hint: str | None = None,
    scenario_question: str | None = None,
    transcript_quotes: list[str] | None = None,
) -> str:
    return "\n".join(
        item
        for item in (
            _oracle_context_digest(
                room,
                participant=participant,
                user_content=user_content,
                context_hint=context_hint,
                scenario_question=scenario_question,
                transcript_quotes=transcript_quotes,
            ),
            _oracle_rich_simulation_context_digest(
                room,
                participant=participant,
                scenario_question=scenario_question,
            ),
        )
        if item
    )



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
                "Do not sound bureaucratic or defensive. One crisp frame, then a balanced wrap-up, shared takeaway, or next handoff."  # noqa: E501
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
        modern_voice_briefs = {
            "diplomat": (
                "Speak like a negotiator under pressure: measured, precise, and aware of leverage. "
                "Name stakeholders, red lines, concessions, or terms before abstractions."
            ),
            "advisor": (
                "Speak like a strategic counsel: options-first, cost-aware, and unsentimental. "
                "Name the window, trade-off, variable, or risk exposure before giving the verdict."
            ),
            "science": (
                "Speak like a cautious analyst: data-driven, hypothesis-aware, and allergic to overclaiming. "  # noqa: E501
                "Name samples, assumptions, bias, or reproducibility before moralizing."
            ),
            "tech-visionary": (
                "Speak like a high-energy builder with a concrete next step. "
                "Use 'platform' only when it is tied to a concrete action or number; otherwise ground claims in prototype, timing, user feedback, or execution."  # noqa: E501
            ),
            "journalist": (
                "Speak like an investigative reporter: tight, factual, and skeptical. "
                "Lead with the source hook, then name who benefits, who dodges, or what the record contradicts."  # noqa: E501
            ),
            "educator": (
                "Speak like a teacher under time pressure: clear, structured, and patient without being soft. "  # noqa: E501
                "Open with the concrete example or counterexample; let it expose the mistake "
                "before you explain the lesson."
            ),
            "artist": (
                "Speak like an artist reading a visible fracture: sensory, precise, and restrained. "  # noqa: E501
                "Name composition, medium, resonance, or expression only when it changes action."
            ),
            "entrepreneur": (
                "Speak like a founder judging viability: fast, practical, and experiment-minded. "
                "Name viability, a retention number, a pilot customer plus its next action "
                "or count, or the next experiment before ambition."
            ),
        }
        if variant in modern_voice_briefs:
            return modern_voice_briefs[variant]
        return (
            "Speak like a representative defending one specific worldline. "
            "Name the decisive hinge, why it mattered, and what it cost. Do not narrate the process."  # noqa: E501
        )
    if room.room_type == EndingRoomType.ENDING_CHAMBER and phase == EndingRoomPhase.VERDICT:
        if is_archivist:
            archivist_label = "档案官" if room.language == "zh" else "Archivist"
            return (
                f"Speak like an evaluative {archivist_label} delivering a verdict, "
                "not a clerk filing a note. Draw on specific events, name the agents "
                "involved, explain the turning point that made the ending feel earned, "
                "and sound like a person judging evidence aloud rather than filling "
                "a template."
                f"{profile_focus_clause}"
            )
        return (
            "Speak like a participant hearing the final verdict land. "
            "Name your own decision, the event it touched, and why that judgment "
            "does or does not match what you lived through."
        )
    if room.room_type == EndingRoomType.ONE_MOVE_ONLY:
        if phase == EndingRoomPhase.VERDICT:
            return (
                "Speak like a strategist naming the one leverage point that mattered most. "
                "Use the actual decision, the agents who made it, and the downstream cost; "
                "challenge the user to see which alternative move would have broken the chain."
            )
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
            "Use specific events and names when they are available; do not reduce the room "
            "to a mechanical one-sentence hinge unless the user asked for a quick route."
            f"{profile_focus_clause}"
        )
    return (
        "Speak like a current-worldline participant who still owns the consequences. "
        "Be concrete, slightly defensive, causal, and use domain-specific nouns instead of generic abstractions."  # noqa: E501
    )



def _oracle_banned_process_phrases(language: str) -> str:
    if language == "zh":
        return (
            "- 不要重复“我只顺着…回答 / 我只沿着…继续 / 我会继续沿着…这根线说下去 / 我先替你筛掉噪声”这类说法\n"  # noqa: E501
            "- 除非用户明确询问范围，不要逐字复述房间范围或权限\n"
            "- 当已有更具体的转折点时，不要把房间标题当成真实转折点\n"
            "- 避免“先失手的，不是终局… / 你点到的就是这一下… / 这轮热座先听…”这类固定开场，除非锚点文案确实需要\n"  # noqa: E501
            "- 避免“总的来说 / 综上所述 / 值得注意的是 / 让我们来看看 / 不得不说 / 需要强调的是 / 从某种角度来说”这类填充或过程话\n"  # noqa: E501
            "- 现场发言时避免“首先...其次...最后”或独立“首先 / 其次 / 最后”这类机械排序\n"  # noqa: E501
            "- 避免重复上一位发言者刚用过的句式节奏或开头分句\n"
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


def _oracle_plain_generation_text(result: Any) -> str:
    if isinstance(result, dict):
        return str(result.get("content") or "")
    text = str(result or "")
    stripped = text.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            payload = json.loads(stripped)
        except (TypeError, ValueError):
            return text
        if isinstance(payload, dict) and isinstance(payload.get("content"), str):
            return payload["content"]
    return text


async def _oracle_plain_stream_generation_text(
    prompt: str,
    *,
    llm_overrides: dict[str, Any] | None = None,
) -> str:
    import app.services.ending_room_service as _pkg

    overrides = llm_overrides or {}
    chunks: list[str] = []
    stream_iter = _pkg.llm_call_stream(
        prompt,
        reasoning_effort="medium",
        temperature=0.82,
        timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
        model=overrides.get("model"),
        api_key=overrides.get("api_key"),
        base_url=overrides.get("base_url"),
    ).__aiter__()
    try:
        while True:
            try:
                delta = await anext(stream_iter)
            except StopAsyncIteration:
                break
            if delta:
                chunks.append(delta)
    finally:
        await stream_iter.aclose()
    return "".join(chunks)


def _oracle_failure_reason(exc: Exception) -> str:
    message = sanitize_untrusted_text(str(exc), max_chars=260)
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


def _log_oracle_anchor_fallback(
    *,
    room: EndingRoom,
    phase: EndingRoomPhase,
    anchor_copy: str,
    purpose: str,
    reason: str,
) -> None:
    logger.warning(
        "Oracle deterministic anchor fallback returned verbatim",
        extra={
            "event": "oracle_anchor_fallback_verbatim",
            "room_id": room.id,
            "room_type": room.room_type.value,
            "turn_phase": phase.value,
            "purpose": purpose,
            "reason": reason,
            "anchor_copy_length": len(anchor_copy or ""),
        },
    )


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
        archivist_label = "档案官" if room.language == "zh" else "The Archivist"
        structural_note = (
            f"{archivist_label} should frame the hinge and route cleanly; "
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
            "Summarize the roundtable discussion: highlight the main perspectives, "
            "note where participants agreed or differed, and offer a balanced takeaway "
            "that directly addresses the original question."
        )
    elif room.room_type == EndingRoomType.ENDING_CHAMBER and phase == EndingRoomPhase.VERDICT:
        phase_note = (
            "For an Ending Chamber verdict, synthesize the key turning points into an "
            "evaluative judgment. Explain why this outcome became inevitable given the "
            "agents' decisions, reference specific events and names from the simulation, "
            "and close with 1-2 provocative follow-up questions that test what still feels "
            "unsettled."
        )
    elif room.room_type == EndingRoomType.ONE_MOVE_ONLY and phase == EndingRoomPhase.VERDICT:
        phase_note = (
            "For a One Move Only verdict, identify the single most critical decision point. "
            "Explain what makes it the leverage point, then challenge the user to think "
            "about what alternative move would have changed everything."
        )
    question_rule = (
        "- Avoid throwaway rhetorical questions; when the phase note asks for follow-up "
        "questions, make them specific, consequential, and grounded in the simulation\n"
        if (
            phase == EndingRoomPhase.VERDICT
            and room.room_type
            in {EndingRoomType.ENDING_CHAMBER, EndingRoomType.ONE_MOVE_ONLY}
        )
        else "- No rhetorical questions, no parallel sentence structures, no listicle patterns\n"
    )
    output_format_hint = (
        'Output strict JSON only: {"content":"..."}'
        if output_json
        else "Output plain text only with no JSON, bullets, or labels."
    )
    output_hint = (
        f"请用简体中文。{output_format_hint}"
        if room.language == "zh"
        else f"Write in English. Translate any Chinese fragments from context instead of leaving them inline. {output_format_hint}"  # noqa: E501
    )
    variant = _oracle_role_voice_variant(
        str(snapshot.get("agent_role") or ""),
        str(snapshot.get("bio_short") or snapshot.get("agent_persona") or ""),
    )
    vocab_section = _oracle_vocabulary_prompt_section(
        participant.role_slot, variant, room.language, snapshot
    )

    character_block = _build_character_identity_block(participant, language=room.language)

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
        "- Use first person; never refer to yourself by display name or in third person\n"
        "- For follow-up replies, choose a role-specific stance and opening rhythm; do not reuse another speaker's verdict phrasing\n"  # noqa: E501
        "- Reference the original scenario question and how this branch's events connect to it\n"
        "- Use specific names, events, numbers, and turning points from the simulation\n"
        "- Sound like a real person talking at a table, not an AI writing a report\n"
        "- Vary sentence structure — mix short decisive statements with longer explanations\n"
        f"{question_rule}"
        "- In roundtables, each speaker must sound noticeably different\n"
        "- Reference what other participants said by name — react to their specific points\n"
        "- Write as if speaking aloud: contractions OK, sentence fragments OK, mid-thought pivots OK\n"  # noqa: E501
        "- Keep it compact: one short paragraph, usually 2-4 sentences\n"
        f"{_oracle_banned_process_phrases(room.language)}"
        f"{structural_note}\n"
        f"{phase_note}\n"
        f"{output_hint}\n\n"
        f"{format_untrusted_text_block('Context', _oracle_combined_context_digest(room, participant=participant, user_content=user_content, context_hint=context_hint, scenario_question=scenario_question, transcript_quotes=transcript_quotes), max_chars=6200)}\n"  # noqa: E501
        f"{guardrail_section}"
        f"{format_untrusted_text_block('Recent Lines To Avoid Mimicking', _oracle_recent_lines_digest(recent_lines), max_chars=1200) if recent_lines else ''}\n"  # noqa: E501
        f"phase={phase.value}\n"
        f"thread_mode={(thread_mode.value if thread_mode is not None else 'room')}\n"
        f"scope_notice={_oracle_scope_notice(room, thread_mode=thread_mode)}\n"
    )


def _build_character_identity_block(
    participant: EndingRoomParticipant,
    *,
    language: str,
) -> str:
    snapshot = participant.persona_snapshot_json or {}
    lines = [f"Character: {_participant_display_name(participant, language)}"]
    role = _localized_archivist_text(participant, language, snapshot.get("agent_role"))[:80]
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
        archivist_label = "档案官" if room.language == "zh" else "the Archivist"
        structural_note = (
            f"For archivist-route follow-up, {archivist_label} should frame the hinge and route cleanly; "  # noqa: E501
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
            "Summarize the roundtable discussion: highlight the main perspectives, "
            "note where participants agreed or differed, and offer a balanced takeaway "
            "that directly addresses the original question."
        )
    elif room.room_type == EndingRoomType.ENDING_CHAMBER and phase == EndingRoomPhase.VERDICT:
        phase_note = (
            "For an Ending Chamber verdict, synthesize the key turning points into an "
            "evaluative judgment. Explain why this outcome became inevitable given the "
            "agents' decisions, reference specific events and names from the simulation, "
            "and close with 1-2 provocative follow-up questions that test what still feels "
            "unsettled."
        )
    elif room.room_type == EndingRoomType.ONE_MOVE_ONLY and phase == EndingRoomPhase.VERDICT:
        phase_note = (
            "For a One Move Only verdict, identify the single most critical decision point. "
            "Explain what makes it the leverage point, then challenge the user to think "
            "about what alternative move would have changed everything."
        )
    question_rule = (
        "- Avoid throwaway rhetorical questions; when the phase note asks for follow-up "
        "questions, make them specific, consequential, and grounded in the simulation\n"
        if (
            phase == EndingRoomPhase.VERDICT
            and room.room_type
            in {EndingRoomType.ENDING_CHAMBER, EndingRoomType.ONE_MOVE_ONLY}
        )
        else "- No rhetorical questions, no parallel sentence structures, no listicle patterns\n"
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
        "- Use first person; never refer to yourself by display name or in third person\n"
        "- For follow-up replies, choose a role-specific stance and opening rhythm; do not reuse another speaker's verdict phrasing\n"  # noqa: E501
        "- Preserve the factual scope and conclusion direction, but use completely fresh wording\n"
        "- Do not invent facts, branches, quotes, or motives not already in context\n"
        "- Sound like a real person talking at a table, not like an AI writing a report\n"
        "- Write as if you are genuinely thinking about this specific situation, "
        "not filling in a template\n"
        "- Use specific names, events, numbers, and turning points — never vague abstractions like 'the situation' or 'the outcome'\n"  # noqa: E501
        "- Use concrete names, numbers, and events from the anchor copy — never use generic placeholders\n"  # noqa: E501
        f"{question_rule}"
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
        f"{format_untrusted_text_block('Context', _oracle_combined_context_digest(room, participant=participant, user_content=user_content, context_hint=context_hint, scenario_question=scenario_question, transcript_quotes=transcript_quotes), max_chars=6200)}\n\n"  # noqa: E501
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
    llm_overrides: dict[str, Any] | None = None,
) -> str:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return anchor_copy
    overrides = llm_overrides or {}

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
        output_json=False,
    )
    try:
        with llm_request_scope(
            quota_key=None,
            purpose=purpose,
            requests_per_minute=overrides.get("requests_per_minute"),
            tokens_per_minute=overrides.get("tokens_per_minute"),
            concurrency=overrides.get("concurrency"),
            supports_structured_outputs_override=overrides.get(
                "supports_structured_outputs_override"
            ),
            supports_native_search_override=overrides.get(
                "supports_native_search_override"
            ),
            native_search_upstream_override=overrides.get(
                "native_search_upstream_override"
            ),
        ):
            import app.services.ending_room_service as _pkg
            legacy_call = (
                _pkg.llm_call_json_with_stream_fallback
                if streaming_first
                else _pkg.llm_call_json
            )
            if not str(getattr(legacy_call, "__module__", "")).startswith("app.services."):
                result = await asyncio.wait_for(
                    legacy_call(
                        gen_prompt,
                        reasoning_effort="medium",
                        temperature=0.82,
                    ),
                    timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
                )
            elif streaming_first:
                result = await asyncio.wait_for(
                    _oracle_plain_stream_generation_text(
                        gen_prompt,
                        llm_overrides=overrides,
                    ),
                    timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
                )
            else:
                result = await asyncio.wait_for(
                    _pkg.llm_call(
                        gen_prompt,
                        reasoning_effort="medium",
                        temperature=0.82,
                        model=overrides.get("model"),
                        api_key=overrides.get("api_key"),
                        base_url=overrides.get("base_url"),
                    ),
                    timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
                )
        polished = _strip_oracle_scope_boilerplate(
            _oracle_plain_generation_text(result),
            language=room.language,
        )
        content = _normalize_oracle_generated_content(
            polished, fallback="",
        )
        if content:
            return content
        logger.info(
            "Oracle generation-first returned empty content",
            extra={
                "event": "oracle_generation_tier_failed",
                "room_id": room.id,
                "room_type": room.room_type.value,
                "turn_phase": phase.value,
                "purpose": purpose,
                "reason": "empty_content",
            },
        )
    except Exception as gen_exc:
        logger.info(
            "Oracle generation-first failed; falling back to rewrite",
            extra={
                "event": "oracle_generation_tier_failed",
                "room_id": room.id,
                "room_type": room.room_type.value,
                "turn_phase": phase.value,
                "purpose": purpose,
                "reason": _oracle_failure_reason(gen_exc),
            },
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
        with llm_request_scope(
            quota_key=None,
            purpose=f"{purpose}:rewrite",
            requests_per_minute=overrides.get("requests_per_minute"),
            tokens_per_minute=overrides.get("tokens_per_minute"),
            concurrency=overrides.get("concurrency"),
            supports_structured_outputs_override=overrides.get(
                "supports_structured_outputs_override"
            ),
            supports_native_search_override=overrides.get(
                "supports_native_search_override"
            ),
            native_search_upstream_override=overrides.get(
                "native_search_upstream_override"
            ),
        ):
            import app.services.ending_room_service as _pkg
            result = await asyncio.wait_for(
                _pkg.llm_call_json(
                    rewrite_prompt,
                    reasoning_effort="medium",
                    temperature=0.78,
                    fallback_mode="agent_message",
                    model=overrides.get("model"),
                    api_key=overrides.get("api_key"),
                    base_url=overrides.get("base_url"),
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
        logger.info(
            "Oracle structured rewrite returned empty content",
            extra={
                "event": "oracle_rewrite_tier_failed",
                "room_id": room.id,
                "room_type": room.room_type.value,
                "turn_phase": phase.value,
                "purpose": purpose,
                "reason": "empty_content",
            },
        )
    except Exception as rewrite_exc:
        logger.info(
            "Oracle structured rewrite failed; falling back to plain text retry",
            extra={
                "event": "oracle_rewrite_tier_failed",
                "room_id": room.id,
                "room_type": room.room_type.value,
                "turn_phase": phase.value,
                "purpose": purpose,
                "reason": _oracle_failure_reason(rewrite_exc),
            },
        )
    try:
        with llm_request_scope(
            quota_key=None,
            purpose=f"{purpose}:plain_text_retry",
            requests_per_minute=overrides.get("requests_per_minute"),
            tokens_per_minute=overrides.get("tokens_per_minute"),
            concurrency=overrides.get("concurrency"),
            supports_structured_outputs_override=overrides.get(
                "supports_structured_outputs_override"
            ),
            supports_native_search_override=overrides.get(
                "supports_native_search_override"
            ),
            native_search_upstream_override=overrides.get(
                "native_search_upstream_override"
            ),
        ):
            import app.services.ending_room_service as _pkg
            plain_result = await asyncio.wait_for(
                _pkg.llm_call(
                        plain_rewrite_prompt,
                        reasoning_effort="low",
                        temperature=0.65,
                        model=overrides.get("model"),
                        api_key=overrides.get("api_key"),
                        base_url=overrides.get("base_url"),
                    ),
                timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
            )
        polished = _strip_oracle_scope_boilerplate(
            str(plain_result or ""),
            language=room.language,
        )
        content = _normalize_oracle_generated_content(
            polished, fallback="",
        )
        if content:
            return content
        logger.info(
            "Oracle plain text rewrite returned empty content",
            extra={
                "event": "oracle_plain_text_retry_failed",
                "room_id": room.id,
                "room_type": room.room_type.value,
                "turn_phase": phase.value,
                "purpose": purpose,
                "reason": "empty_content",
            },
        )
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
                    quota_key=None,
                    purpose=f"{purpose}:no_effort_retry",
                    requests_per_minute=overrides.get("requests_per_minute"),
                    tokens_per_minute=overrides.get("tokens_per_minute"),
                    concurrency=overrides.get("concurrency"),
                    supports_structured_outputs_override=overrides.get(
                        "supports_structured_outputs_override"
                    ),
                    supports_native_search_override=overrides.get(
                        "supports_native_search_override"
                    ),
                    native_search_upstream_override=overrides.get(
                        "native_search_upstream_override"
                    ),
                ):
                    import app.services.ending_room_service as _pkg_r
                    no_effort_result = await asyncio.wait_for(
                        _pkg_r.llm_call(
                            plain_rewrite_prompt,
                            reasoning_effort=None,
                            temperature=0.65,
                            model=overrides.get("model"),
                            api_key=overrides.get("api_key"),
                            base_url=overrides.get("base_url"),
                        ),
                        timeout=_ORACLE_LLM_REWRITE_TIMEOUT_SECONDS,
                    )
                polished = _strip_oracle_scope_boilerplate(
                    str(no_effort_result or ""),
                    language=room.language,
                )
                content = _normalize_oracle_generated_content(
                    polished, fallback="",
                )
                if content:
                    return content
                logger.info(
                    "Oracle no-effort rewrite returned empty content",
                    extra={
                        "event": "oracle_no_effort_retry_failed",
                        "room_id": room.id,
                        "room_type": room.room_type.value,
                        "turn_phase": phase.value,
                        "purpose": purpose,
                        "reason": "empty_content",
                    },
                )
            except Exception as no_effort_exc:
                logger.warning(
                    "Oracle LLM no-effort fallback for %s: %s",
                    purpose,
                    no_effort_exc,
                )
                _log_oracle_anchor_fallback(
                    room=room,
                    phase=phase,
                    anchor_copy=anchor_copy,
                    purpose=purpose,
                    reason=_oracle_failure_reason(no_effort_exc),
                )
                return anchor_copy
        else:
            logger.warning(
                "Oracle Chambers LLM all tiers failed for %s: plain=%s",
                purpose,
                plain_exc,
            )
            _log_oracle_anchor_fallback(
                room=room,
                phase=phase,
                anchor_copy=anchor_copy,
                purpose=purpose,
                reason=_oracle_failure_reason(plain_exc),
            )
            return anchor_copy
    _log_oracle_anchor_fallback(
        room=room,
        phase=phase,
        anchor_copy=anchor_copy,
        purpose=purpose,
        reason="empty_all_tiers",
    )
    return anchor_copy


async def _oracle_followup_streaming_supported(
    *,
    llm_overrides: dict[str, Any] | None = None,
) -> bool:
    if not settings.ORACLE_CHAMBERS_USE_LLM:
        return False
    overrides = llm_overrides or {}
    try:
        import app.services.ending_room_service as _pkg
        with llm_request_scope(
            quota_key=None,
            purpose="oracle_followup_stream_probe",
            requests_per_minute=overrides.get("requests_per_minute"),
            tokens_per_minute=overrides.get("tokens_per_minute"),
            concurrency=overrides.get("concurrency"),
            supports_structured_outputs_override=overrides.get(
                "supports_structured_outputs_override"
            ),
            supports_native_search_override=overrides.get(
                "supports_native_search_override"
            ),
            native_search_upstream_override=overrides.get(
                "native_search_upstream_override"
            ),
        ):
            probe = await _pkg.probe_streaming_support(
                model=overrides.get("model") or settings.LLM_MODEL_NAME,
                api_key=overrides.get("api_key"),
                base_url=overrides.get("base_url"),
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
    llm_overrides: dict[str, Any] | None = None,
) -> str:
    overrides = llm_overrides or {}
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
        with llm_request_scope(
            quota_key=None,
            purpose=purpose,
            requests_per_minute=overrides.get("requests_per_minute"),
            tokens_per_minute=overrides.get("tokens_per_minute"),
            concurrency=overrides.get("concurrency"),
            supports_structured_outputs_override=overrides.get(
                "supports_structured_outputs_override"
            ),
            supports_native_search_override=overrides.get(
                "supports_native_search_override"
            ),
            native_search_upstream_override=overrides.get(
                "native_search_upstream_override"
            ),
        ):
            import app.services.ending_room_service as _pkg
            stream_iter = _pkg.llm_call_stream(
                prompt,
                reasoning_effort="medium",
                temperature=0.75,
                timeout=_ORACLE_FOLLOWUP_STREAM_TIMEOUT_SECONDS,
                model=overrides.get("model"),
                api_key=overrides.get("api_key"),
                base_url=overrides.get("base_url"),
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
