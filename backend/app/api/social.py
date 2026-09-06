"""SwarmOracle API — Social media copy generation & export endpoints."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from typing import Any, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, field_validator
from sqlalchemy import case, func, tuple_, update
from sqlmodel import Session, select

from app.api.errors import api_error, api_error_from_exception
from app.api.helpers import (
    SessionPrincipal,
    parse_key_moments,
    require_owned_scenario,
    require_session_principal,
    resolve_authenticated_user_id,
    verify_session,
)
from app.config import settings
from app.models import (
    Agent,
    Branch,
    BranchStatus,
    Scenario,
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.models.checkpoint import FactionEvent, FactionSnapshot
from app.models.database import get_engine
from app.services.lang_detect import detect_language, get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    is_local_provider_url,
    llm_call,
    llm_request_scope,
    validate_llm_base_url,
)
from app.services.llm_resolution import (
    merge_profile_provider_overrides,
    model_profile_provider_unresolved,
    raise_unresolved_model_profile_provider,
    recover_profile_provider_overrides,
    resolve_post_completion_llm_call_config,
)
from app.services.model_profiles import resolve_model_profile_policy

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", dependencies=[Depends(verify_session)])
SOCIAL_COPY_MAX_CHARS = {
    "xiaohongshu": 4_000,
    "weibo": 2_000,
    "zhihu": 12_000,
    "reddit": 5_000,
    "x": 1_600,
}
_SOCIAL_HEADLINE_CACHE_KEY = "_social_headline_cache_v1"
_SOCIAL_HEADLINE_CACHE_MAX_BYTES = 8_192
_SOCIAL_FEED_MAX_EVENTS = 256
_SOCIAL_HEADLINE_MAX_CANDIDATE_EVENTS = 32
_SOCIAL_HEADLINE_FINGERPRINT_VERSION = "latest-first-v4-bounded-subject"
_SOCIAL_HEADLINE_MAX_CHARS = 96
_SOCIAL_HEADLINE_SUBJECT_MAX_CHARS = 56
_SOCIAL_SUMMARY_MAX_CHARS = 220
_SOCIAL_SUMMARY_SUBJECT_MAX_CHARS = 120
_SOCIAL_HEADLINE_CACHE_FIELDS = {
    "version",
    "events_sha256",
    "generation_mode",
    "headline_cards",
}
_SocialHeadlineHighWater = tuple[int, str, int, str]
_SocialHeadlineResult = tuple[str, list[dict[str, Any]]]
_SOCIAL_HEADLINE_INFLIGHT: dict[
    tuple[int, str, str], asyncio.Task[_SocialHeadlineResult]
] = {}
_SOCIAL_HEADLINE_CARD_FIELDS = {
    "card_id",
    "headline",
    "summary",
    "branch_title",
    "round_number",
    "event_type",
    "faction_label",
    "source_event_id",
}
_CHINESE_REACTION_LABELS = {
    "LIKE": "点赞",
    "LOVE": "喜爱",
    "LAUGH": "觉得好笑",
    "WOW": "表示惊讶",
    "SAD": "表示难过",
    "ANGRY": "表示愤怒",
    "SUPPORT": "表示支持",
    "OPPOSE": "表示反对",
}
_CHINESE_SOCIAL_EVENT_TYPE_LABELS = {
    "post": "发布动态",
    "comment": "评论",
    "reaction": "互动回应",
    "follow": "关注",
    "mute": "静音",
    "search": "搜索",
    "trend": "追踪趋势",
    "refresh": "刷新动态",
    "alliance formed": "阵营形成",
    "alliance broken": "阵营解散",
    "affect shift (proxy)": "情绪代理变化",
}
_DISPLAY_SAFE_REDACTION_RE = re.compile(
    r"(?i)"
    r"(authorization\s*:\s*bearer\s+[^\s,;]+|"
    r"bearer\s+[^\s,;]+|"
    r"sk-[a-z0-9_\-]+|"
    r"\b(api[_-]?key|base[_-]?url|authorization|token|owner[_-]?id|"
    r"owner[_-]?user[_-]?id|user[_-]?id)\b\s*[:=]?\s*[^\s,;]*)"
)
_DISPLAY_SAFE_URL_RE = re.compile(r"(?i)\bhttps?://[^\s<>\"]+")
_DISPLAY_SAFE_FORBIDDEN_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "token",
    "base_url",
    "baseurl",
    "owner_id",
    "owner_user_id",
    "user_id",
    "full_report",
    "hidden_report_payload",
}


class SocialCopyRequest(BaseModel):
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_requests_per_minute: int | None = None
    llm_tokens_per_minute: int | None = None
    model_profile_id: str | None = None
    user_id: str | None = None

    @field_validator("llm_api_key", "llm_base_url", "llm_model", "model_profile_id")
    @classmethod
    def normalize_optional_byok(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None

    @field_validator("llm_requests_per_minute", "llm_tokens_per_minute")
    @classmethod
    def validate_optional_non_negative_limit(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("LLM rate limits must be >= 0")
        return value


# ── Social Platform Prompts (P6) ─────────────────────────

SOCIAL_ANTI_SLOP_GUARDRAILS = {
    "Chinese": (
        "统一反套话约束：\n"
        "- 不要使用「总的来说」「总而言之」「综上所述」「值得注意的是」"
        "「让我们来看看」「不得不说」「在当今」「从某种角度来说」"
        "「关键洞见在于」「深入探讨」「独到见解」「开放性思考」等套话。\n"
        "- 不写空洞排比三段式，不用「不是X而是Y」这类模板对仗。\n"
        "- 不要强制塞 emoji；只有确实贴合语气时才用，不要按段落凑数量。\n"
        "- 不堆破折号，不用绝对化词硬抬情绪；营销词必须跟具体动作或数字，"
        "否则删掉。\n"
        "- 让具体人物、机构或群体执行动作，不要让「趋势」「世界线」"
        "这类抽象词替人说话。\n"
        "- 判断必须落在推演证据上：引用具体分支标题、人物原话或概率数字；"
        "缺少证据时，删掉泛泛感叹和营销自夸词。\n"
    ),
    "English": (
        "Anti-cliche guardrails:\n"
        "- Avoid dead phrases such as \"In summary\", \"To sum up\", "
        "\"It's worth noting\", \"Let us examine\", \"Let us unpack\", "
        "\"It must be said\", \"In today's\", \"Fundamentally\", "
        "\"The key insight\", \"All things considered\", "
        "\"From a certain angle\", \"distinctive takeaway\", or \"open question\".\n"
        "- Do not use empty three-part lists, slogan cadence, or \"not X but Y\" contrasts.\n"
        "- Do not pad with emoji; use one only when it fits the platform voice.\n"
        "- Avoid dash-stacked sentences and broad every/always/never claims. If a "
        "buzzword appears, attach a concrete action or number; otherwise cut it.\n"
        "- Make specific people, institutions, or groups perform actions; do not let "
        "abstract trends speak for them.\n"
        "- Ground claims in simulation evidence: concrete branch titles, participant quotes, "
        "or probability numbers. Cut generic reactions and self-promotional marketing words.\n"
    ),
}

SOCIAL_PLATFORM_PROMPTS: dict[str, dict[str, dict[str, str]]] = {
    "xiaohongshu": {
        "name": {"Chinese": "小红书", "English": "Xiaohongshu"},
        "instruction": {
            "Chinese": (
                "目标：写一篇小红书帖子。读者愿意收藏或转发，是因为信息具体、"
                "像朋友认真讲清楚一件事；把口号式表达删掉。\n"
                "要求：\n"
                "- 标题：≤20字，用一个具体反差或细节制造悬念\n"
                "- 正文：300-800字，亲切、口语化，有真实观察感\n"
                "- 分段清晰，善用换行\n"
                "- 结尾加3-5个相关话题标签，格式：#话题#\n"
                "- 突出最有趣的结局对比，并说明它为什么会出现\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['Chinese']}"
            ),
            "English": (
                "Goal: write a Xiaohongshu-style post in English. Readers should save or "
                "share it when the details are concrete and useful; keep loud slogans out.\n"
                "Requirements:\n"
                "- Title: under 20 words, built around one concrete contrast or detail\n"
                "- Body: 300-800 words, warm, conversational, and observant\n"
                "- Use clear paragraph breaks\n"
                "- End with 3-5 topic tags in the format #topic\n"
                "- Highlight the most surprising branch contrast and explain why it happened\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['English']}"
            ),
        },
    },
    "weibo": {
        "name": {"Chinese": "微博", "English": "Weibo"},
        "instruction": {
            "Chinese": (
                "目标：写一条微博。读者愿意转发，是因为一句话抓住了推演里的"
                "具体转折和代价。\n"
                "要求：\n"
                "- 正文控制在140字以内（含标点和空格）\n"
                "- 开头直接点出一个具体反差、选择或后果\n"
                "- 信息密度高，言简意赅\n"
                "- 结尾加2-3个话题标签，格式：#话题#\n"
                "- 语气简短、有态度，但判断必须有事实锚点\n"
                "- 如果内容特别丰富，可以写长微博版本（≤2000字），但默认写短微博\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['Chinese']}"
            ),
            "English": (
                "Goal: write a concise Weibo post in English. Readers should repost it "
                "because one sentence names a concrete turn and its cost.\n"
                "Requirements:\n"
                "- Keep the main post within 140 Chinese-style characters worth of brevity, roughly tweet-length in English\n"  # noqa: E501
                "- Open with a concrete contrast, choice, or consequence\n"
                "- Keep the information density high\n"
                "- End with 2-3 topic tags in the format #topic\n"
                "- Tone: sharp and concise, with a factual anchor for the judgment\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['English']}"
            ),
        },
    },
    "zhihu": {
        "name": {"Chinese": "知乎", "English": "Zhihu"},
        "instruction": {
            "Chinese": (
                "目标：写一篇知乎回答/文章。读者继续读，是因为论证能把推演里的"
                "分支、选择和概率讲清楚。\n"
                "要求：\n"
                "- 标题：提问式，指向一个具体分歧\n"
                "- 正文：800-2000字，理性分析、逻辑清晰\n"
                "- 使用二级/三级标题分段\n"
                "- 引用推演中的具体情节作为论据\n"
                "- 语气专业但不枯燥\n"
                "- 结尾回答原问题，并说明这个回答依赖哪些分支证据\n"
                "- 可以适度加粗重点内容\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['Chinese']}"
            ),
            "English": (
                "Goal: write a Zhihu-style long-form answer in English. Readers should "
                "keep reading because the argument explains the simulation's branches, "
                "choices, and probabilities.\n"
                "Requirements:\n"
                "- Use a question-style title that points to a concrete disagreement\n"
                "- Body: 800-2000 words, analytical and well-structured\n"
                "- Use section headings\n"
                "- Cite concrete moments from the simulation as evidence\n"
                "- End by answering the original question and naming the branch evidence "
                "behind it\n"
                "- You may moderately bold key points\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['English']}"
            ),
        },
    },
    "reddit": {
        "name": {"Chinese": "Reddit", "English": "Reddit"},
        "instruction": {
            "Chinese": (
                "目标：写一篇 Reddit 帖子。帖子要像有人把推演细节带到讨论区，"
                "邀请别人围绕证据继续聊。\n"
                "要求：\n"
                "- 标题：有吸引力、简洁，少于 300 字符\n"
                "- 正文：200-500 词，口语化但有分析感\n"
                "- 使用 markdown 格式\n"
                "- 结尾附 TL;DR\n"
                "- 可附 subreddit 提示，如 [r/whatif] 或 [r/alternatehistory]\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['Chinese']}"
            ),
            "English": (
                "Goal: write a Reddit post. It should read like someone brought concrete "
                "simulation details into a discussion thread and wants replies about the "
                "evidence.\n"
                "Requirements:\n"
                "- Title: name a concrete branch title, probability number, or quoted decision; under 300 characters\n"  # noqa: E501
                "- Body: 200-500 words in a discussion-forum/subreddit voice, like a user inviting evidence-based replies\n"  # noqa: E501
                "- Write in English\n"
                "- Use markdown formatting (headers, bold, lists)\n"
                "- Include a TL;DR at the end\n"
                "- Cite branch titles, probability numbers, and character quotes from the simulation when available\n"  # noqa: E501
                "- Ask one grounded discussion question about the evidence or trade-off\n"
                "- Suggest subreddit tags like [r/whatif] or [r/alternatehistory]\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['English']}"
            ),
        },
    },
    "x": {
        "name": {"Chinese": "X (Twitter)", "English": "X (Twitter)"},
        "instruction": {
            "Chinese": (
                "目标：写一组 X 线程。读者愿意转发，是因为每条都给出一个"
                "具体判断或证据；不要靠口号推进。\n"
                "要求：\n"
                "- 主帖：≤280 字符，先给出最具体的反差或结论\n"
                "- 可选 2-4 条跟帖\n"
                "- 带 1-2 个话题标签\n"
                "- 跟帖逐条补分支标题、人物原话或概率数字\n"
                "- 突出最令人意外的结果，并交代它来自哪条分支\n"
                "- 格式：1/N, 2/N ...\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['Chinese']}"
            ),
            "English": (
                "Goal: write an X thread. Readers should share it because each post gives "
                "a concrete judgment or piece of evidence. Keep slogan-style phrasing out.\n"
                "Requirements:\n"
                "- Main tweet: ≤280 characters, opening with the most concrete contrast or conclusion\n"  # noqa: E501
                "- Write in English\n"
                "- Optional: 2-4 follow-up tweets for a thread, each ≤280 chars\n"
                "- Use 1-2 relevant hashtags\n"
                "- Use follow-ups to add branch titles, participant quotes, or probability "
                "numbers\n"
                "- Include the most surprising outcome and name the branch it came from\n"
                "- Tone: concise and alert\n"
                "- Format thread as: 1/N, 2/N, etc.\n"
                f"{SOCIAL_ANTI_SLOP_GUARDRAILS['English']}"
            ),
        },
    },
}


def _resolve_social_language(scenario: Scenario) -> str:
    return (
        scenario.parsed_context.get("_language")
        if isinstance(scenario.parsed_context, dict)
        else None
    ) or detect_language(scenario.question)


def _resolve_social_output_language(platform: str, scenario_language: str) -> str:
    """Explicit social-copy language policy.

    Current policy: social copy follows the scenario language for every platform.
    Chinese uses Chinese prompt wrappers; all other languages reuse the English
    scaffold plus an explicit output-language directive.
    """
    if platform not in SOCIAL_PLATFORM_PROMPTS:
        return scenario_language
    return scenario_language


def _trim_social_copy(platform: str, copy: str) -> str:
    limit = SOCIAL_COPY_MAX_CHARS.get(platform)
    trimmed = copy.strip()
    if limit is None or len(trimmed) <= limit:
        return trimmed
    if limit <= 1:
        return "…" if trimmed else ""

    boundary_markers = ("\n", "。", ".", "！", "!", "？", "?", " ")
    boundary = max(trimmed.rfind(marker, 0, limit) for marker in boundary_markers)
    boundary = max(boundary, 0)
    if boundary < int(limit * 0.6):
        boundary = max(limit - 1, 1)
    return trimmed[:boundary].rstrip() + "…"


def _bound_social_generation_buffer(platform: str, copy: str) -> str:
    limit = SOCIAL_COPY_MAX_CHARS.get(platform)
    trimmed = copy.strip()
    if limit is None:
        return trimmed

    safety_limit = limit * 2
    if len(trimmed) <= safety_limit:
        return trimmed
    return trimmed[: safety_limit - 1].rstrip() + "…"


def _build_social_context(
    scenario: Scenario,
    agents: list[Agent],
    branches: list[Branch],
    *,
    language: str,
) -> str:
    labels = {
        "question": "问题/假设" if language == "Chinese" else "Question / Hypothesis",
        "agents": "参与角色" if language == "Chinese" else "Participants",
        "ending": "结局" if language == "Chinese" else "Ending",
        "fork_reason": "分歧原因" if language == "Chinese" else "Fork Reason",
        "story": "故事" if language == "Chinese" else "Story",
        "insight": "洞察" if language == "Chinese" else "Insight",
    }
    context_lines = [
        f"{labels['question']}: {scenario.question}",
        f"{labels['agents']}: {', '.join(a.name + '(' + a.role + ')' for a in agents)}",
        "",
    ]
    for i, b in enumerate(branches, 1):
        context_lines.append(
            f"{labels['ending']}{i}: {b.title} ({b.probability * 100:.0f}%)"
        )
        if b.fork_reason:
            context_lines.append(f"  {labels['fork_reason']}: {b.fork_reason}")
        if b.story:
            story_preview = b.story[:500] + ("..." if len(b.story) > 500 else "")
            context_lines.append(f"  {labels['story']}: {story_preview}")
        if b.insight:
            context_lines.append(f"  {labels['insight']}: {b.insight}")
        context_lines.append("")
    return "\n".join(context_lines)


def _require_social_headlines_feature() -> None:
    if not settings.FEATURE_SOCIAL_HEADLINES:
        raise api_error(
            404,
            "FEATURE_DISABLED",
            "Feature 'social_headlines' is not enabled",
        )


def _display_safe_text(value: object, *, max_chars: int = 240) -> str:
    text = str(value or "").strip()
    text = _DISPLAY_SAFE_REDACTION_RE.sub("[redacted]", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _cache_safe_text(value: object, *, max_chars: int) -> str:
    return _DISPLAY_SAFE_URL_RE.sub(
        "[redacted-url]",
        _display_safe_text(value, max_chars=max_chars),
    )


def _load_json_object(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _safe_payload_summary(raw: str | None) -> str:
    payload = _load_json_object(raw)
    visible_parts: list[str] = []
    for key, value in payload.items():
        normalized_key = str(key).strip().lower().replace("-", "_")
        if normalized_key in _DISPLAY_SAFE_FORBIDDEN_KEYS:
            continue
        if isinstance(value, (str, int, float, bool)):
            visible_parts.append(_display_safe_text(value, max_chars=120))
    return "; ".join(part for part in visible_parts if part)[:240]


def _social_event_display_type(event_type: str) -> str:
    """Map legacy persistence codes to truthful user-facing descriptions."""
    normalized = event_type.strip().lower()
    if normalized == "betrayal":
        return "affect shift (proxy)"
    return normalized.replace("_", " ")


def _localized_social_event_type(event_type: str, *, use_chinese: bool) -> str:
    display_type = _social_event_display_type(event_type)
    if use_chinese:
        return _CHINESE_SOCIAL_EVENT_TYPE_LABELS.get(display_type, display_type)
    return display_type


def _canonical_social_subject(
    actor_label: object,
    faction_label: object,
    *,
    use_chinese: bool,
    subject_max_chars: int | None = None,
) -> tuple[str, str, str]:
    actor = _display_safe_text(actor_label, max_chars=80) or (
        "未知参与者" if use_chinese else "Unknown participant"
    )
    faction = _display_safe_text(faction_label, max_chars=80)
    distinct_faction = faction and actor.casefold() != faction.casefold()
    if distinct_faction:
        separator_chars = 2 if use_chinese else 3
        if subject_max_chars is not None:
            available = max(2, subject_max_chars - separator_chars)
            actor_budget = max(1, available // 2)
            faction_budget = max(1, available - actor_budget)
            actor_subject = _display_safe_text(actor, max_chars=actor_budget)
            faction_subject = _display_safe_text(faction, max_chars=faction_budget)
        else:
            actor_subject = actor
            faction_subject = faction
        subject = (
            f"{actor_subject}（{faction_subject}）"
            if use_chinese
            else f"{actor_subject} ({faction_subject})"
        )
    else:
        subject = (
            _display_safe_text(actor, max_chars=subject_max_chars)
            if subject_max_chars is not None
            else actor
        )
    return actor, faction, subject


def _canonical_subject_prefix_end(
    text: str,
    subject: str,
    *,
    use_chinese: bool,
) -> int | None:
    pattern = rf"{re.escape(subject)}"
    if not use_chinese:
        pattern += r"(?!\w)"
    match = re.match(pattern, text, flags=re.IGNORECASE)
    return match.end() if match is not None else None


def _canonicalize_social_card_text(
    text: object,
    *,
    full_subject: str,
    bounded_subject: str,
    use_chinese: bool,
    max_chars: int,
    fallback_body: str,
) -> str:
    safe_text = _display_safe_text(text, max_chars=max_chars * 4).lstrip()
    body = safe_text
    for candidate in (full_subject, bounded_subject):
        prefix_end = _canonical_subject_prefix_end(
            safe_text,
            candidate,
            use_chinese=use_chinese,
        )
        if prefix_end is not None:
            body = safe_text[prefix_end:].lstrip()
            body = re.sub(r"^[：:\-—–|]+\s*", "", body)
            break
    body = body or _display_safe_text(fallback_body, max_chars=max_chars)
    separator = "：" if use_chinese else ": "
    body_budget = max(1, max_chars - len(bounded_subject) - len(separator))
    bounded_body = _display_safe_text(body, max_chars=body_budget)
    return f"{bounded_subject}{separator}{bounded_body}"


def _stable_social_event_id(source_kind: str, source_id: str) -> str:
    digest = hashlib.sha256(f"{source_kind}:{source_id}".encode()).hexdigest()[:20]
    return f"event_{digest}"


def _snapshot_lookup(
    snapshots: list[FactionSnapshot],
) -> dict[tuple[str, int, str], FactionSnapshot]:
    return {
        (snapshot.branch_id, snapshot.round_number, snapshot.faction_key): snapshot
        for snapshot in snapshots
    }


def _build_display_safe_social_events(
    scenario: Scenario,
    branches: list[Branch],
    snapshots: list[FactionSnapshot],
    events: list[FactionEvent],
    *,
    agents: list[Agent] | None = None,
) -> list[dict[str, Any]]:
    branch_titles = {
        branch.id: _display_safe_text(branch.title, max_chars=120)
        for branch in branches
    }
    use_chinese = _resolve_social_language(scenario) == "Chinese"
    by_snapshot_key = _snapshot_lookup(snapshots)
    agents_by_id = {
        agent.id: agent
        for agent in (agents or [])
        if agent.scenario_id == scenario.id
    }
    display_events: list[dict[str, Any]] = []
    for event in events:
        snapshot = by_snapshot_key.get(
            (event.branch_id, event.round_number, event.faction_key)
        )
        faction_label = _display_safe_text(
            snapshot.label
            if snapshot is not None and snapshot.label
            else event.faction_key,
            max_chars=80,
        )
        actor = agents_by_id.get(event.actor_agent_id)
        actor_label, faction_label, subject_label = _canonical_social_subject(
            actor.name if actor is not None else "",
            faction_label,
            use_chinese=use_chinese,
        )
        display_event_type = _social_event_display_type(event.event_type)
        # Affect-proxy payloads are internal numeric vectors. Without field labels,
        # exposing them as prose is meaningless and produced duplicate-looking cards.
        payload_summary = (
            ""
            if display_event_type == "affect shift (proxy)"
            else _safe_payload_summary(event.payload_json)
        )
        event_type = _display_safe_text(
            display_event_type,
            max_chars=60,
        )
        event_type_label = _display_safe_text(
            _localized_social_event_type(event.event_type, use_chinese=use_chinese),
            max_chars=60,
        )
        branch_title = branch_titles.get(event.branch_id, "worldline")
        summary_parts = (
            [f"{subject_label}在{branch_title}触发了{event_type_label}"]
            if use_chinese
            else [
                f"{subject_label} triggered {event_type}",
                f"on {branch_title}",
            ]
        )
        if payload_summary:
            summary_parts.append(payload_summary)
        display_events.append(
            {
                "event_id": _stable_social_event_id("faction", event.id),
                "round_number": event.round_number,
                "event_type": event_type,
                "branch_title": branch_title,
                "faction_label": faction_label,
                "actor_label": actor_label,
                "confidence": (
                    max(0.0, min(1.0, float(snapshot.confidence)))
                    if snapshot is not None
                    else None
                ),
                "summary": _display_safe_text("; ".join(summary_parts), max_chars=280),
            }
        )
    return display_events


def _build_display_safe_action_events(
    scenario: Scenario,
    branches: list[Branch],
    agents: list[Agent],
    actions: list[SimulationAction],
) -> list[dict[str, Any]]:
    branches_by_id = {branch.id: branch for branch in branches}
    agents_by_id = {agent.id: agent for agent in agents}
    use_chinese = _resolve_social_language(scenario) == "Chinese"
    display_events: list[dict[str, Any]] = []
    for action in actions:
        status = str(getattr(action.status, "value", action.status)).lower()
        action_type = str(getattr(action.action_type, "value", action.action_type)).upper()
        actor = agents_by_id.get(action.agent_id)
        branch = branches_by_id.get(action.branch_id)
        if (
            status != SimulationActionStatus.VERIFIED.value
            or action_type == SimulationActionType.IDLE.value
            or action.scenario_id != scenario.id
            or branch is None
            or (actor is not None and actor.scenario_id != action.scenario_id)
            or branch.scenario_id != action.scenario_id
        ):
            continue
        branch_title = _display_safe_text(branch.title, max_chars=120)

        payload = _load_json_object(action.payload_json)
        raw_actor_label = actor.name if actor is not None else ""
        if (
            actor is not None
            and actor.source_type == "world_event_source"
            and action_type == SimulationActionType.POST.value
            and action.message_id is None
            and payload.get("bootstrap") is True
        ):
            raw_actor_label = payload.get("source_name") or actor.name
        actor_label, faction_label, subject_label = _canonical_social_subject(
            raw_actor_label,
            raw_actor_label,
            use_chinese=use_chinese,
        )
        faction_label = faction_label or actor_label
        content = _display_safe_text(action.content, max_chars=180)
        target = agents_by_id.get(str(action.target_id or ""))
        target_label = (
            _display_safe_text(target.name, max_chars=80)
            if target is not None and target.scenario_id == action.scenario_id
            else ""
        )

        if action_type == SimulationActionType.POST.value:
            if not content:
                continue
            summary = (
                f"{subject_label}发布了动态：{content}"
                if use_chinese
                else f"{subject_label} posted: {content}"
            )
        elif action_type == SimulationActionType.COMMENT.value:
            if not content:
                continue
            summary = (
                f"{subject_label}评论了一条动态：{content}"
                if use_chinese
                else f"{subject_label} commented on a prior post: {content}"
            )
        elif action_type == SimulationActionType.REACTION.value:
            reaction = _display_safe_text(payload.get("reaction"), max_chars=24)
            if use_chinese:
                reaction_label = _CHINESE_REACTION_LABELS.get(reaction.upper())
                summary = (
                    f"{subject_label}对一条动态表达了“{reaction_label}”"
                    if reaction_label
                    else f"{subject_label}对一条动态作出回应"
                )
            else:
                summary = f"{subject_label} reacted"
                if reaction:
                    summary += f" with {reaction}"
                summary += " to a prior post"
        elif action_type in {
            SimulationActionType.FOLLOW.value,
            SimulationActionType.MUTE.value,
        }:
            if not target_label or str(action.target_type or "").lower() != "agent":
                continue
            if use_chinese:
                verb = "关注了" if action_type == SimulationActionType.FOLLOW.value else "屏蔽了"
                summary = f"{subject_label}{verb}{target_label}"
            else:
                verb = (
                    "followed"
                    if action_type == SimulationActionType.FOLLOW.value
                    else "muted"
                )
                summary = f"{subject_label} {verb} {target_label}"
        elif action_type == SimulationActionType.SEARCH.value:
            if not content:
                continue
            summary = (
                f"{subject_label}搜索了：{content}"
                if use_chinese
                else f"{subject_label} searched for: {content}"
            )
        elif action_type == SimulationActionType.TREND.value:
            summary = (
                f"{subject_label}查看了热门话题"
                if use_chinese
                else f"{subject_label} checked trending topics"
            )
        elif action_type == SimulationActionType.REFRESH.value:
            summary = (
                f"{subject_label}刷新了动态"
                if use_chinese
                else f"{subject_label} refreshed the social feed"
            )
        else:
            continue

        display_events.append(
            {
                "event_id": _stable_social_event_id("action", action.id),
                "round_number": action.round_number,
                "event_type": action_type.lower(),
                "branch_title": branch_title,
                "faction_label": faction_label,
                "actor_label": actor_label,
                "confidence": None,
                "summary": _display_safe_text(summary, max_chars=280),
            }
        )
    return display_events


def _merge_display_safe_social_events(
    event_groups: list[list[dict[str, Any]]],
    *,
    sort_keys: dict[str, tuple[Any, ...]],
) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for event in (item for group in event_groups for item in group):
        event_id = str(event.get("event_id") or "")
        if event_id and event_id not in unique:
            unique[event_id] = event
    return sorted(
        unique.values(),
        key=lambda event: sort_keys.get(
            str(event.get("event_id") or ""),
            ("", 2, int(event.get("round_number") or 0), 0, str(event.get("event_id"))),
        ),
    )


def _social_events_fingerprint(events: list[dict[str, Any]]) -> str:
    canonical = json.dumps(
        events,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    versioned = f"{_SOCIAL_HEADLINE_FINGERPRINT_VERSION}\0{canonical}"
    return hashlib.sha256(versioned.encode()).hexdigest()


def _validated_cached_headline_cards(
    raw: object,
    events: list[dict[str, Any]],
) -> list[dict[str, Any]] | None:
    if not isinstance(raw, list) or len(raw) > 5 or (events and not raw):
        return None
    events_by_id = {str(event.get("event_id") or ""): event for event in events}
    cards: list[dict[str, Any]] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict) or not set(item).issubset(
            _SOCIAL_HEADLINE_CARD_FIELDS
        ):
            return None
        source_event_id = str(item.get("source_event_id") or "")
        source_event = events_by_id.get(source_event_id)
        if source_event is None:
            return None
        headline = _cache_safe_text(
            item.get("headline"),
            max_chars=_SOCIAL_HEADLINE_MAX_CHARS,
        )
        if not headline:
            return None
        round_number = source_event.get("round_number")
        if isinstance(round_number, bool) or (
            round_number is not None and not isinstance(round_number, int)
        ):
            return None
        cards.append(
            {
                "card_id": f"headline_{index}",
                "headline": headline,
                "summary": _cache_safe_text(
                    item.get("summary"),
                    max_chars=_SOCIAL_SUMMARY_MAX_CHARS,
                ),
                "branch_title": _display_safe_text(
                    source_event.get("branch_title"),
                    max_chars=120,
                ),
                "round_number": round_number,
                "event_type": _display_safe_text(
                    source_event.get("event_type"),
                    max_chars=60,
                ),
                "faction_label": _display_safe_text(
                    source_event.get("faction_label"),
                    max_chars=80,
                ),
                "source_event_id": source_event_id,
            }
        )
    return cards


def _read_social_headline_cache(
    parsed_context: object,
    *,
    events_sha256: str,
    events: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]] | None:
    if not isinstance(parsed_context, dict):
        return None
    cache = parsed_context.get(_SOCIAL_HEADLINE_CACHE_KEY)
    if not isinstance(cache, dict) or set(cache) != _SOCIAL_HEADLINE_CACHE_FIELDS:
        return None
    try:
        encoded = json.dumps(
            cache,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    except (TypeError, ValueError):
        return None
    if len(encoded) > _SOCIAL_HEADLINE_CACHE_MAX_BYTES:
        return None
    if cache.get("version") != 1 or cache.get("events_sha256") != events_sha256:
        return None
    generation_mode = cache.get("generation_mode")
    # A deterministic card is a temporary fail-soft response. Persisting it
    # would prevent a repaired or recovered Provider from ever being retried.
    if generation_mode != "llm":
        return None
    cards = _validated_cached_headline_cards(cache.get("headline_cards"), events)
    if cards is None:
        return None
    return generation_mode, cards


def _build_social_headline_cache(
    *,
    events_sha256: str,
    generation_mode: str,
    headline_cards: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    cards = _validated_cached_headline_cards(headline_cards, events)
    if cards is None or generation_mode != "llm":
        return None
    compact_cards = [
        {
            "headline": card["headline"],
            "summary": card["summary"],
            "source_event_id": card["source_event_id"],
        }
        for card in cards
    ]
    payload: dict[str, Any] = {
        "version": 1,
        "events_sha256": events_sha256,
        "generation_mode": generation_mode,
        "headline_cards": compact_cards,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    return (
        (payload, cards)
        if len(encoded) <= _SOCIAL_HEADLINE_CACHE_MAX_BYTES
        else None
    )


def _parsed_context_json_object_expr():
    return case(
        (
            func.json_valid(Scenario.parsed_context) == 1,
            case(
                (func.json_type(Scenario.parsed_context) == "object", Scenario.parsed_context),
                else_=func.json("{}"),
            ),
        ),
        else_=func.json("{}"),
    )


def _persist_social_headline_cache(
    scenario_id: str,
    payload: dict[str, Any],
    *,
    expected_high_water: _SocialHeadlineHighWater,
) -> bool:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    faction_count, faction_latest_id, action_count, action_latest_id = (
        expected_high_water
    )
    faction_count_query = (
        select(func.count(FactionEvent.id))
        .where(FactionEvent.scenario_id == scenario_id)
        .scalar_subquery()
    )
    faction_latest_query = (
        select(FactionEvent.id)
        .where(FactionEvent.scenario_id == scenario_id)
        .order_by(
            FactionEvent.created_at.desc(),
            FactionEvent.round_number.desc(),
            FactionEvent.id.desc(),
        )
        .limit(1)
        .scalar_subquery()
    )
    action_filter = (
        SimulationAction.scenario_id == scenario_id,
        SimulationAction.status == SimulationActionStatus.VERIFIED,
        SimulationAction.action_type != SimulationActionType.IDLE,
    )
    action_count_query = (
        select(func.count(SimulationAction.id))
        .where(*action_filter)
        .scalar_subquery()
    )
    action_latest_query = (
        select(SimulationAction.id)
        .where(*action_filter)
        .order_by(
            SimulationAction.created_at.desc(),
            SimulationAction.round_number.desc(),
            SimulationAction.sequence.desc(),
            SimulationAction.id.desc(),
        )
        .limit(1)
        .scalar_subquery()
    )
    with Session(get_engine()) as session:
        result = session.exec(
            update(Scenario)
            .where(
                Scenario.id == scenario_id,
                faction_count_query == faction_count,
                func.coalesce(faction_latest_query, "") == faction_latest_id,
                action_count_query == action_count,
                func.coalesce(action_latest_query, "") == action_latest_id,
            )
            .values(
                parsed_context=func.json_set(
                    _parsed_context_json_object_expr(),
                    f'$."{_SOCIAL_HEADLINE_CACHE_KEY}"',
                    func.json(encoded),
                )
            )
        )
        session.commit()
        return getattr(result, "rowcount", 0) == 1


def _deterministic_headline_cards(
    events: list[dict[str, Any]],
    *,
    language: str = "English",
) -> list[dict[str, Any]]:
    use_chinese = language == "Chinese"
    cards: list[dict[str, Any]] = []
    for index, event in enumerate(reversed(events[-5:]), start=1):
        faction_label = _display_safe_text(
            event.get("faction_label") or "Faction",
            max_chars=80,
        )
        raw_actor_label = event.get("actor_label")
        event_type = str(event.get("event_type") or "event")
        event_type_label = _localized_social_event_type(
            event_type,
            use_chinese=use_chinese,
        )
        branch_title = str(event.get("branch_title") or "worldline")
        full_subject = faction_label
        headline_subject = _display_safe_text(
            faction_label,
            max_chars=_SOCIAL_HEADLINE_SUBJECT_MAX_CHARS,
        )
        summary_subject = _display_safe_text(
            faction_label,
            max_chars=_SOCIAL_SUMMARY_SUBJECT_MAX_CHARS,
        )
        if raw_actor_label:
            _, faction_label, full_subject = _canonical_social_subject(
                raw_actor_label,
                faction_label,
                use_chinese=use_chinese,
            )
            _, _, headline_subject = _canonical_social_subject(
                raw_actor_label,
                faction_label,
                use_chinese=use_chinese,
                subject_max_chars=_SOCIAL_HEADLINE_SUBJECT_MAX_CHARS,
            )
            _, _, summary_subject = _canonical_social_subject(
                raw_actor_label,
                faction_label,
                use_chinese=use_chinese,
                subject_max_chars=_SOCIAL_SUMMARY_SUBJECT_MAX_CHARS,
            )
        summary_fallback = f"{event_type} on {branch_title}"
        cards.append(
            {
                "card_id": f"headline_{index}",
                "headline": _canonicalize_social_card_text(
                    event_type_label,
                    full_subject=full_subject,
                    bounded_subject=headline_subject,
                    use_chinese=use_chinese,
                    max_chars=_SOCIAL_HEADLINE_MAX_CHARS,
                    fallback_body=event_type,
                ),
                "summary": _canonicalize_social_card_text(
                    event.get("summary") or summary_fallback,
                    full_subject=full_subject,
                    bounded_subject=summary_subject,
                    use_chinese=use_chinese,
                    max_chars=_SOCIAL_SUMMARY_MAX_CHARS,
                    fallback_body=summary_fallback,
                ),
                "branch_title": _display_safe_text(branch_title, max_chars=120),
                "round_number": event.get("round_number"),
                "event_type": _display_safe_text(event_type, max_chars=60),
                "faction_label": _display_safe_text(faction_label, max_chars=80),
                "source_event_id": event.get("event_id"),
            }
        )
    return cards


def _normalize_headline_cards(
    raw: object,
    events: list[dict[str, Any]],
    *,
    language: str = "English",
) -> list[dict[str, Any]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
    if isinstance(raw, dict):
        raw_cards = raw.get("headline_cards") or raw.get("cards") or []
    else:
        raw_cards = raw
    if not isinstance(raw_cards, list):
        return []
    cards: list[dict[str, Any]] = []
    events_by_id = {str(event.get("event_id")): event for event in events}
    for index, item in enumerate(raw_cards[:5], start=1):
        if not isinstance(item, dict):
            continue
        source_event_id = str(item.get("source_event_id") or "")
        source_event = events_by_id.get(source_event_id)
        if source_event is None:
            source_event = events[index - 1] if index <= len(events) else {}
            source_event_id = str(source_event.get("event_id") or source_event_id)
        headline = _display_safe_text(
            item.get("headline"),
            max_chars=_SOCIAL_HEADLINE_MAX_CHARS,
        )
        summary = _display_safe_text(
            item.get("summary"),
            max_chars=_SOCIAL_SUMMARY_MAX_CHARS,
        )
        if not headline:
            continue
        actor_label = _display_safe_text(
            source_event.get("actor_label"),
            max_chars=80,
        )
        faction_label = _display_safe_text(
            source_event.get("faction_label"),
            max_chars=80,
        )
        if actor_label:
            _, _, full_subject = _canonical_social_subject(
                actor_label,
                faction_label,
                use_chinese=language == "Chinese",
            )
            _, _, headline_subject = _canonical_social_subject(
                actor_label,
                faction_label,
                use_chinese=language == "Chinese",
                subject_max_chars=_SOCIAL_HEADLINE_SUBJECT_MAX_CHARS,
            )
            _, _, summary_subject = _canonical_social_subject(
                actor_label,
                faction_label,
                use_chinese=language == "Chinese",
                subject_max_chars=_SOCIAL_SUMMARY_SUBJECT_MAX_CHARS,
            )
            event_type = _display_safe_text(
                source_event.get("event_type") or "event",
                max_chars=60,
            )
            branch_title = _display_safe_text(
                source_event.get("branch_title") or "worldline",
                max_chars=120,
            )
            headline = _canonicalize_social_card_text(
                item.get("headline"),
                full_subject=full_subject,
                bounded_subject=headline_subject,
                use_chinese=language == "Chinese",
                max_chars=_SOCIAL_HEADLINE_MAX_CHARS,
                fallback_body=event_type,
            )
            summary_fallback = f"{event_type} on {branch_title}"
            summary = _canonicalize_social_card_text(
                item.get("summary") or source_event.get("summary"),
                full_subject=full_subject,
                bounded_subject=summary_subject,
                use_chinese=language == "Chinese",
                max_chars=_SOCIAL_SUMMARY_MAX_CHARS,
                fallback_body=summary_fallback,
            )
        cards.append(
            {
                "card_id": f"headline_{index}",
                "headline": headline,
                "summary": summary
                or _display_safe_text(
                    source_event.get("summary"),
                    max_chars=_SOCIAL_SUMMARY_MAX_CHARS,
                ),
                "branch_title": _display_safe_text(
                    item.get("branch_title") or source_event.get("branch_title"),
                    max_chars=120,
                ),
                "round_number": item.get("round_number") or source_event.get("round_number"),
                "event_type": _display_safe_text(
                    item.get("event_type") or source_event.get("event_type"),
                    max_chars=60,
                ),
                "faction_label": faction_label,
                "source_event_id": source_event_id,
            }
        )
    return cards


async def _generate_headline_cards(
    scenario: Scenario,
    events: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    if not events:
        return "deterministic", []
    provider_policy = scenario.parsed_context if isinstance(scenario.parsed_context, dict) else {}
    language = _resolve_social_language(scenario)
    headline_events = list(
        reversed(events[-_SOCIAL_HEADLINE_MAX_CANDIDATE_EVENTS:])
    )
    question_block = format_untrusted_text_block(
        "Scenario question",
        _display_safe_text(scenario.question, max_chars=600),
        max_chars=800,
    )
    events_block = format_untrusted_text_block(
        "Unified social event feed",
        json.dumps(headline_events, ensure_ascii=False),
        max_chars=6000,
    )
    example_event_id = str(headline_events[0].get("event_id") or "")
    response_example = json.dumps(
        {
            "headline_cards": [
                {
                    "headline": "...",
                    "summary": "...",
                    "source_event_id": example_event_id,
                }
            ]
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    prompt = (
        "Generate display-safe headline cards for a SwarmOracle social feed.\n"
        "Compatibility note: the legacy confidence field is faction member share, "
        "not model certainty or statistical confidence.\n"
        f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
        f"{question_block}\n"
        f"{events_block}\n"
        f"Return strict JSON only: {response_example}\n"
        f"{get_language_directive(language)}"
    )
    try:
        context_api_key = provider_policy.get("llm_api_key")
        context_base_url = provider_policy.get("llm_base_url")
        context_model = provider_policy.get("llm_model")
        recovered_profile_overrides = None
        with Session(get_engine()) as session:
            recovered_profile_overrides = recover_profile_provider_overrides(
                session,
                scenario,
            )
        request_overrides = merge_profile_provider_overrides(
            {
                "api_key": context_api_key if isinstance(context_api_key, str) else None,
                "base_url": context_base_url if isinstance(context_base_url, str) else None,
                "model": context_model if isinstance(context_model, str) else None,
            },
            recovered_profile_overrides,
            include_quota_user_id=True,
        )
        if model_profile_provider_unresolved(
            scenario,
            recovered_profile_overrides,
            explicit_api_key=context_api_key,
            explicit_base_url=context_base_url,
            explicit_model=context_model,
        ):
            return "deterministic", _deterministic_headline_cards(
                events,
                language=language,
            )
        effective_llm = resolve_post_completion_llm_call_config(
            parsed_context=provider_policy,
            request_api_key=request_overrides.get("api_key"),
            request_base_url=request_overrides.get("base_url"),
            request_model=request_overrides.get("model"),
            request_requests_per_minute=request_overrides.get("requests_per_minute"),
            request_tokens_per_minute=request_overrides.get("tokens_per_minute"),
            request_concurrency=request_overrides.get("concurrency"),
            request_supports_structured_outputs_override=request_overrides.get(
                "supports_structured_outputs_override"
            ),
            request_supports_native_search_override=request_overrides.get(
                "supports_native_search_override"
            ),
            request_native_search_upstream_override=request_overrides.get(
                "native_search_upstream_override"
            ),
        )
        quota_user_id = request_overrides.get("quota_user_id") or provider_policy.get(
            "user_id"
        )
        with llm_request_scope(
            quota_key=f"user:{quota_user_id}" if quota_user_id else None,
            purpose="social_headline_cards",
            requests_per_minute=effective_llm.requests_per_minute,
            tokens_per_minute=effective_llm.tokens_per_minute,
            concurrency=effective_llm.concurrency,
            supports_structured_outputs_override=(
                effective_llm.supports_structured_outputs_override
            ),
            supports_native_search_override=effective_llm.supports_native_search_override,
            native_search_upstream_override=effective_llm.native_search_upstream_override,
        ):
            raw = await llm_call(
                prompt,
                timeout=30.0,
                api_key=effective_llm.api_key,
                base_url=effective_llm.base_url,
                model=effective_llm.model,
            )
        cards = _normalize_headline_cards(raw, headline_events, language=language)
        if cards:
            return "llm", cards
    except Exception as exc:
        logger.debug("social headline generation failed (non-blocking): %s", type(exc).__name__)
    return "deterministic", _deterministic_headline_cards(events, language=language)


# ── Endpoints ────────────────────────────────────────────


async def _generate_and_cache_headline_cards(
    scenario: Scenario,
    events: list[dict[str, Any]],
    *,
    events_sha256: str,
    expected_high_water: _SocialHeadlineHighWater,
) -> _SocialHeadlineResult:
    generation_mode, headline_cards = await _generate_headline_cards(scenario, events)
    cache_result = _build_social_headline_cache(
        events_sha256=events_sha256,
        generation_mode=generation_mode,
        headline_cards=headline_cards,
        events=events,
    )
    if cache_result is None:
        return generation_mode, headline_cards
    cache_payload, headline_cards = cache_result
    try:
        _persist_social_headline_cache(
            scenario.id,
            cache_payload,
            expected_high_water=expected_high_water,
        )
    except Exception as exc:
        logger.debug(
            "social headline cache persistence failed (non-blocking): %s",
            type(exc).__name__,
        )
    return generation_mode, headline_cards


def _forget_social_headline_task(
    key: tuple[int, str, str],
    task: asyncio.Task[_SocialHeadlineResult],
) -> None:
    if _SOCIAL_HEADLINE_INFLIGHT.get(key) is task:
        _SOCIAL_HEADLINE_INFLIGHT.pop(key, None)


async def _generate_headline_cards_singleflight(
    scenario: Scenario,
    events: list[dict[str, Any]],
    *,
    events_sha256: str,
    expected_high_water: _SocialHeadlineHighWater,
) -> _SocialHeadlineResult:
    loop = asyncio.get_running_loop()
    key = (id(loop), scenario.id, events_sha256)
    task = _SOCIAL_HEADLINE_INFLIGHT.get(key)
    if task is None:
        task = asyncio.create_task(
            _generate_and_cache_headline_cards(
                scenario,
                events,
                events_sha256=events_sha256,
                expected_high_water=expected_high_water,
            )
        )
        _SOCIAL_HEADLINE_INFLIGHT[key] = task
        task.add_done_callback(
            lambda completed, inflight_key=key: _forget_social_headline_task(
                inflight_key,
                completed,
            )
        )
    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            _forget_social_headline_task(key, task)


@router.get("/scenario/{scenario_id}/social-feed")
async def get_social_feed(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
) -> dict[str, Any]:
    """Return display-safe faction and verified native-action headline data."""
    _require_social_headlines_feature()
    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        action_filter = (
            SimulationAction.scenario_id == scenario_id,
            SimulationAction.status == SimulationActionStatus.VERIFIED,
            SimulationAction.action_type != SimulationActionType.IDLE,
        )
        faction_event_count = int(
            session.exec(
                select(func.count(FactionEvent.id)).where(
                    FactionEvent.scenario_id == scenario_id
                )
            ).one()
            or 0
        )
        action_count = int(
            session.exec(
                select(func.count(SimulationAction.id)).where(*action_filter)
            ).one()
            or 0
        )
        event_candidates = list(
            session.exec(
                select(FactionEvent)
                .where(FactionEvent.scenario_id == scenario_id)
                .order_by(
                    FactionEvent.created_at.desc(),
                    FactionEvent.round_number.desc(),
                    FactionEvent.id.desc(),
                )
                .limit(_SOCIAL_FEED_MAX_EVENTS)
            ).all()
        )
        action_candidates = list(
            session.exec(
                select(SimulationAction)
                .where(*action_filter)
                .order_by(
                    SimulationAction.created_at.desc(),
                    SimulationAction.round_number.desc(),
                    SimulationAction.sequence.desc(),
                    SimulationAction.id.desc(),
                )
                .limit(_SOCIAL_FEED_MAX_EVENTS)
            ).all()
        )
        headline_high_water: _SocialHeadlineHighWater = (
            faction_event_count,
            event_candidates[0].id if event_candidates else "",
            action_count,
            action_candidates[0].id if action_candidates else "",
        )

        candidate_rows: list[tuple[tuple[Any, ...], str, Any]] = [
            (
                (event.created_at.isoformat(), 0, event.round_number, 0, event.id),
                "faction",
                event,
            )
            for event in event_candidates
        ]
        candidate_rows.extend(
            (
                (
                    action.created_at.isoformat(),
                    1,
                    action.round_number,
                    action.sequence,
                    action.id,
                ),
                "action",
                action,
            )
            for action in action_candidates
        )
        selected_rows = sorted(candidate_rows, key=lambda item: item[0])[
            -_SOCIAL_FEED_MAX_EVENTS:
        ]
        events = [row for _, kind, row in selected_rows if kind == "faction"]
        actions = [row for _, kind, row in selected_rows if kind == "action"]

        branch_ids = {
            row.branch_id
            for _, _, row in selected_rows
            if isinstance(row.branch_id, str) and row.branch_id
        }
        branches = (
            list(
                session.exec(
                    select(Branch).where(
                        Branch.scenario_id == scenario_id,
                        Branch.id.in_(branch_ids),
                    )
                ).all()
            )
            if branch_ids
            else []
        )
        agent_ids = {
            event.actor_agent_id for event in events if event.actor_agent_id
        }
        agent_ids.update(action.agent_id for action in actions if action.agent_id)
        agent_ids.update(
            str(action.target_id)
            for action in actions
            if str(action.target_type or "").lower() == "agent" and action.target_id
        )
        agents = (
            list(
                session.exec(
                    select(Agent).where(
                        Agent.scenario_id == scenario_id,
                        Agent.id.in_(agent_ids),
                    )
                ).all()
            )
            if agent_ids
            else []
        )
        snapshot_keys = {
            (event.branch_id, event.round_number, event.faction_key)
            for event in events
        }
        snapshots = (
            list(
                session.exec(
                    select(FactionSnapshot).where(
                        FactionSnapshot.scenario_id == scenario_id,
                        tuple_(
                            FactionSnapshot.branch_id,
                            FactionSnapshot.round_number,
                            FactionSnapshot.faction_key,
                        ).in_(snapshot_keys),
                    )
                ).all()
            )
            if snapshot_keys
            else []
        )
        total_event_count = faction_event_count + action_count

    faction_display_events = _build_display_safe_social_events(
        scenario,
        branches,
        snapshots,
        events,
        agents=agents,
    )
    action_display_events = _build_display_safe_action_events(
        scenario,
        branches,
        agents,
        actions,
    )
    sort_keys = {
        _stable_social_event_id("faction", event.id): (
            event.created_at.isoformat(),
            0,
            event.round_number,
            0,
            event.id,
        )
        for event in events
    }
    sort_keys.update(
        {
            _stable_social_event_id("action", action.id): (
                action.created_at.isoformat(),
                1,
                action.round_number,
                action.sequence,
                action.id,
            )
            for action in actions
        }
    )
    display_events = _merge_display_safe_social_events(
        [faction_display_events, action_display_events],
        sort_keys=sort_keys,
    )
    events_sha256 = _social_events_fingerprint(display_events)
    if not display_events:
        generation_mode, headline_cards = "deterministic", []
    else:
        cached_headlines = _read_social_headline_cache(
            scenario.parsed_context,
            events_sha256=events_sha256,
            events=display_events,
        )
        if cached_headlines is not None:
            generation_mode, headline_cards = cached_headlines
        else:
            generation_mode, headline_cards = await _generate_headline_cards_singleflight(
                scenario,
                display_events,
                events_sha256=events_sha256,
                expected_high_water=headline_high_water,
            )
    return {
        "scenario_id": scenario.id,
        "question": _display_safe_text(scenario.question, max_chars=240),
        "generation_mode": generation_mode,
        "total_event_count": total_event_count,
        "events_truncated": total_event_count > len(selected_rows),
        "events": display_events,
        "headline_cards": headline_cards,
    }


async def _generate_social_copy(
    scenario_id: str,
    platform: str,
    req: SocialCopyRequest,
    principal: SessionPrincipal | None,
):
    """Generate platform-specific social media copy from simulation results."""
    from app.services.llm_client import (
        LLMBackpressureError,
        LLMCircuitOpenError,
        LLMError,
        llm_call,
    )

    # SSRF protection: validate BYOK base_url against allowlist
    if req.llm_base_url and not req.model_profile_id:
        validated_url = validate_llm_base_url(req.llm_base_url)
        if validated_url is None:
            raise api_error(400, "LLM_BASE_URL_NOT_ALLOWED", "Provided llm_base_url is not in the allowed provider list")  # noqa: E501
        if not req.llm_api_key and not is_local_provider_url(validated_url):
            raise api_error(400, "BYOK_API_KEY_REQUIRED", "An API key is required when using a custom LLM base URL")  # noqa: E501
        req.llm_base_url = validated_url

    if platform not in SOCIAL_PLATFORM_PROMPTS:
        raise api_error(
            400,
            "SOCIAL_PLATFORM_UNSUPPORTED",
            f"Unsupported platform '{platform}'. "
            f"Supported: {', '.join(SOCIAL_PLATFORM_PROMPTS.keys())}",
        )
    platform_config = SOCIAL_PLATFORM_PROMPTS[platform]

    engine = get_engine()
    model_profile_policy = None
    recovered_profile_overrides = None
    owner_user_id: str | None = None
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)
        owner_user_id = scenario.user_id or (principal.subject if principal else None)
        if req.model_profile_id:
            model_profile_policy = resolve_model_profile_policy(
                session,
                user_id=owner_user_id,
                model_profile_id=req.model_profile_id,
                explicit_api_key=req.llm_api_key,
                explicit_base_url=req.llm_base_url,
                explicit_model=req.llm_model,
                explicit_requests_per_minute=req.llm_requests_per_minute,
                explicit_tokens_per_minute=req.llm_tokens_per_minute,
            )
        else:
            recovered_profile_overrides = recover_profile_provider_overrides(
                session,
                scenario,
            )

        branches = list(session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).all())
        agents = list(session.exec(
            select(Agent).where(
                Agent.scenario_id == scenario_id,
                Agent.source_type.is_(None) | (Agent.source_type != "world_event_source"),
            )
        ).all())

    social_language = _resolve_social_language(scenario)
    output_language = _resolve_social_output_language(platform, social_language)
    context = _build_social_context(
        scenario,
        agents,
        branches,
        language=social_language,
    )
    provider_policy = scenario.parsed_context or {}
    recovered_quota_user_id: object = None
    if model_profile_policy is not None:
        effective_api_key = model_profile_policy.api_key
        effective_base_url = model_profile_policy.base_url
        effective_model = model_profile_policy.model
        effective_requests_per_minute = model_profile_policy.requests_per_minute
        effective_tokens_per_minute = model_profile_policy.tokens_per_minute
        effective_concurrency = model_profile_policy.concurrency
        effective_supports_structured_outputs = (
            model_profile_policy.supports_structured_outputs
        )
        effective_supports_native_search = model_profile_policy.supports_native_search
        effective_native_search_upstream = model_profile_policy.native_search_upstream
    else:
        request_overrides = merge_profile_provider_overrides(
            {
                "api_key": req.llm_api_key,
                "base_url": req.llm_base_url,
                "model": req.llm_model,
                "requests_per_minute": req.llm_requests_per_minute,
                "tokens_per_minute": req.llm_tokens_per_minute,
            },
            recovered_profile_overrides,
            include_quota_user_id=True,
        )
        if model_profile_provider_unresolved(
            scenario,
            recovered_profile_overrides,
            explicit_api_key=req.llm_api_key,
            explicit_base_url=req.llm_base_url,
            explicit_model=req.llm_model,
        ):
            raise_unresolved_model_profile_provider()
        recovered_quota_user_id = request_overrides.get("quota_user_id")
        effective_llm = resolve_post_completion_llm_call_config(
            parsed_context=provider_policy,
            request_api_key=request_overrides.get("api_key"),
            request_base_url=request_overrides.get("base_url"),
            request_model=request_overrides.get("model"),
            request_requests_per_minute=request_overrides.get("requests_per_minute"),
            request_tokens_per_minute=request_overrides.get("tokens_per_minute"),
            request_concurrency=request_overrides.get("concurrency"),
            request_supports_structured_outputs_override=request_overrides.get(
                "supports_structured_outputs_override"
            ),
            request_supports_native_search_override=request_overrides.get(
                "supports_native_search_override"
            ),
            request_native_search_upstream_override=request_overrides.get(
                "native_search_upstream_override"
            ),
        )
        effective_api_key = effective_llm.api_key
        effective_base_url = effective_llm.base_url
        effective_model = effective_llm.model
        effective_requests_per_minute = effective_llm.requests_per_minute
        effective_tokens_per_minute = effective_llm.tokens_per_minute
        effective_concurrency = effective_llm.concurrency
        effective_supports_structured_outputs = (
            effective_llm.supports_structured_outputs_override
        )
        effective_supports_native_search = effective_llm.supports_native_search_override
        effective_native_search_upstream = effective_llm.native_search_upstream_override
    quota_key = resolve_authenticated_user_id(req.user_id, principal)
    if quota_key is None:
        quota_key = owner_user_id
    if quota_key is None:
        quota_key = (
            recovered_quota_user_id
            if isinstance(recovered_quota_user_id, str)
            else None
        )
    if quota_key is None:
        context_user_id = provider_policy.get("user_id")
        quota_key = context_user_id if isinstance(context_user_id, str) else None

    prompt_language = "Chinese" if output_language == "Chinese" else "English"
    platform_name = platform_config["name"].get(output_language, platform_config["name"]["English"])
    instruction = platform_config["instruction"].get(
        prompt_language,
        platform_config["instruction"]["English"],
    )
    results_label = "推演结果如下" if social_language == "Chinese" else "Simulation results"
    final_instruction = (
        f"请直接输出{platform_name}平台的文案，不要加多余说明。"
        if social_language == "Chinese"
        else f"Output only the final {platform_name} copy. Do not add extra commentary."
    )

    prompt = (
        f"{instruction}\n"
        f"{get_language_directive(output_language)}\n"
        f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
        f"---\n"
        f"{results_label}:\n\n"
        f"{format_untrusted_text_block(results_label, context, max_chars=5000)}\n"
        f"---\n"
        f"{final_instruction}"
    )

    try:
        # M-10 fix: Pass BYOK credentials to llm_call
        with llm_request_scope(
            quota_key=f"user:{quota_key}" if quota_key else None,
            purpose="social_copy",
            requests_per_minute=effective_requests_per_minute,
            tokens_per_minute=effective_tokens_per_minute,
            concurrency=effective_concurrency,
            supports_structured_outputs_override=effective_supports_structured_outputs,
            supports_native_search_override=effective_supports_native_search,
            native_search_upstream_override=effective_native_search_upstream,
        ):
            copy = await llm_call(
                prompt,
                timeout=60.0,
                api_key=effective_api_key,
                base_url=effective_base_url,
                model=effective_model,
            )
    except (LLMBackpressureError, LLMCircuitOpenError) as exc:
        raise api_error_from_exception(503, "SOCIAL_LLM_TEMPORARILY_UNAVAILABLE", exc) from exc
    except LLMError as exc:
        raise api_error_from_exception(502, "SOCIAL_LLM_GENERATION_FAILED", exc) from exc

    copy = _bound_social_generation_buffer(platform, copy)
    return {
        "platform": platform,
        "platform_name": platform_name,
        "copy": _trim_social_copy(platform, copy),
    }


@router.get("/scenario/{scenario_id}/social/{platform}")
async def generate_social_copy(
    scenario_id: str,
    platform: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Generate platform-specific social media copy without provider overrides."""
    _require_social_headlines_feature()
    return await _generate_social_copy(
        scenario_id,
        platform,
        SocialCopyRequest(),
        principal=principal,
    )


@router.post("/scenario/{scenario_id}/social/{platform}")
async def generate_social_copy_with_overrides(
    scenario_id: str,
    platform: str,
    req: SocialCopyRequest | None = None,
    principal: SessionPrincipal | None = Depends(require_session_principal),
):
    """Generate platform-specific social media copy with provider overrides in the POST body."""
    _require_social_headlines_feature()
    return await _generate_social_copy(
        scenario_id,
        platform,
        req or SocialCopyRequest(),
        principal=principal,
    )


@router.get("/scenario/{scenario_id}/export")
async def export_scenario(
    scenario_id: str,
    principal: SessionPrincipal | None = Depends(require_session_principal),
    language: Literal["zh", "en"] | None = None,
):
    """P4-C: Export scenario results as Markdown."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)

        agents = list(
            session.exec(
                select(Agent).where(
                    Agent.scenario_id == scenario_id,
                    Agent.source_type.is_(None) | (Agent.source_type != "world_event_source"),
                )
            ).all()
        )
        branches = list(session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.status == BranchStatus.COMPLETED,
            )
        ).all())

    export_language = (
        "Chinese" if language == "zh" else "English" if language == "en"
        else _resolve_social_language(scenario)
    )
    labels = {
        "status": "状态" if export_language == "Chinese" else "Status",
        "created_at": "创建时间" if export_language == "Chinese" else "Created",
        "participants": "参与角色" if export_language == "Chinese" else "Participants",
        "role": "角色" if export_language == "Chinese" else "Role",
        "name": "名称" if export_language == "Chinese" else "Name",
        "stance": "定位" if export_language == "Chinese" else "Stance",
        "tier": "层级" if export_language == "Chinese" else "Tier",
        "no_branches": "尚无已完成的分支。" if export_language == "Chinese" else "No completed branches yet.",  # noqa: E501
        "ending": "结局" if export_language == "Chinese" else "Ending",
        "probability": "模拟权重" if export_language == "Chinese" else "Simulation weight",
        "fork_reason": "分歧原因" if export_language == "Chinese" else "Fork Reason",
        "story": "故事" if export_language == "Chinese" else "Story",
        "insight": "洞察" if export_language == "Chinese" else "Insight",
        "key_moments": "关键时刻" if export_language == "Chinese" else "Key Moments",
    }

    status_labels = {
        "parsing": ("准备中", "Preparing"),
        "simulating": ("推演中", "Simulating"),
        "narrating": ("叙事中", "Narrating"),
        "done": ("已完成", "Complete"),
        "error": ("失败", "Failed"),
        "cancelled": ("已取消", "Cancelled"),
    }
    status_label = status_labels.get(scenario.status.value, (scenario.status.value,) * 2)[
        0 if export_language == "Chinese" else 1
    ]
    original_notice = (
        "问题、角色名称和推演叙事保留存档原文；此导出仅调整系统标题和状态语言。"
        "分支权重是模拟结果，不是实测的现实发生概率。"
        if export_language == "Chinese"
        else "Questions, role names and simulation narratives keep their original saved text; "
        "this export localizes system headings and status only. "
        "Branch weights are simulation outputs, not measured real-world probabilities."
    )

    # Build Markdown
    lines = [
        f"# SwarmOracle — {scenario.question}",
        "",
        f"> {labels['status']}: {status_label} | {labels['created_at']}: {scenario.created_at.isoformat()}",  # noqa: E501
        "",
        f"> {original_notice}",
        "",
        f"## {labels['participants']}",
        "",
        f"| {labels['role']} | {labels['name']} | {labels['stance']} | {labels['tier']} |",
        "|------|------|------|------|",
    ]
    tier_labels = {
        "CORE": ("核心角色", "Core"),
        "IMPORTANT": ("重要角色", "Important"),
        "CROWD": ("群体角色", "Crowd"),
    }
    for a in agents:
        tier_label = tier_labels.get(a.tier.value, (a.tier.value,) * 2)[
            0 if export_language == "Chinese" else 1
        ]
        lines.append(f"| {a.role} | {a.name} | {a.stance} | {tier_label} |")

    lines.append("")
    lines.append("---")
    lines.append("")

    if not branches:
        lines.append(f"*{labels['no_branches']}*")
    else:
        for i, b in enumerate(branches, 1):
            lines.append(f"## {labels['ending']} {i}: {b.title}")
            lines.append("")
            lines.append(f"**{labels['probability']}**: {b.probability * 100:.1f}%")
            if b.fork_reason:
                lines.append(f"**{labels['fork_reason']}**: {b.fork_reason}")
            lines.append("")
            lines.append(f"### {labels['story']}")
            lines.append("")
            lines.append(b.story or "—")
            lines.append("")
            if b.insight:
                lines.append(f"### {labels['insight']}")
                lines.append("")
                lines.append(f"> {b.insight}")
                lines.append("")
            moments = parse_key_moments(b.key_moments)
            if moments:
                lines.append(f"### {labels['key_moments']}")
                lines.append("")
                for j, m in enumerate(moments, 1):
                    lines.append(f"{j}. {m}")
                lines.append("")
            lines.append("---")
            lines.append("")

    md_content = "\n".join(lines)
    return PlainTextResponse(
        content=md_content,
        media_type="text/markdown",
        headers={
            "Content-Disposition": (
                f'attachment; filename="swarmoracle-{scenario_id[:8]}.md"'
            )
        },
    )
