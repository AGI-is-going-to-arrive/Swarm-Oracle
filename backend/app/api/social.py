"""SwarmOracle API — Social media copy generation & export endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.api.helpers import parse_key_moments
from app.models import Agent, Branch, BranchStatus, Scenario
from app.models.database import get_engine
from app.services.lang_detect import detect_language
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_request_scope,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")
SOCIAL_COPY_MAX_CHARS = {
    "xiaohongshu": 4_000,
    "weibo": 2_000,
    "zhihu": 12_000,
    "reddit": 5_000,
    "x": 1_600,
}


class SocialCopyRequest(BaseModel):
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None
    user_id: str | None = None


# ── Social Platform Prompts (P6) ─────────────────────────

SOCIAL_PLATFORM_PROMPTS: dict[str, dict[str, dict[str, str]]] = {
    "xiaohongshu": {
        "name": {"Chinese": "小红书", "English": "Xiaohongshu"},
        "instruction": {
            "Chinese": (
                "你是一位小红书爆款文案写手。请根据以下推演结果，写一篇小红书帖子。\n"
                "要求：\n"
                "- 标题：≤20字，吸睛、有悬念，使用emoji开头\n"
                "- 正文：300-800字，口语化、有趣、有代入感\n"
                "- 大量使用emoji表情（每段至少2-3个）\n"
                "- 分段清晰，善用换行\n"
                "- 结尾加3-5个相关话题标签，格式：#话题#\n"
                "- 语气亲切，像在跟朋友聊天\n"
                "- 突出最有趣的结局对比\n"
            ),
            "English": (
                "You are a Xiaohongshu copywriter. Based on the simulation results below, "
                "write a Xiaohongshu-style post in English.\n"
                "Requirements:\n"
                "- Title: under 20 words, curiosity-driven, emoji opening allowed\n"
                "- Body: 300-800 words, vivid and conversational\n"
                "- Use clear paragraph breaks and a punchy, lifestyle-friendly tone\n"
                "- End with 3-5 topic tags in the format #topic\n"
                "- Highlight the most surprising branch contrast\n"
            ),
        },
    },
    "weibo": {
        "name": {"Chinese": "微博", "English": "Weibo"},
        "instruction": {
            "Chinese": (
                "你是一位微博大V文案写手。请根据以下推演结果，写一条微博。\n"
                "要求：\n"
                "- 正文控制在140字以内（含标点和空格）\n"
                "- 开头用一句抓人的问句或感叹句\n"
                "- 信息密度高，言简意赅\n"
                "- 结尾加2-3个话题标签，格式：#话题#\n"
                "- 语气犀利有态度\n"
                "- 如果内容特别丰富，可以写长微博版本（≤2000字），但默认写短微博\n"
            ),
            "English": (
                "You are a Weibo-style microblog writer. Based on the simulation results "
                "below, write a concise Weibo post in English.\n"
                "Requirements:\n"
                "- Keep the main post within 140 Chinese-style characters worth of brevity, roughly tweet-length in English\n"
                "- Open with a hook question or exclamation\n"
                "- Keep the information density high\n"
                "- End with 2-3 topic tags in the format #topic\n"
                "- Tone: sharp, opinionated, and concise\n"
            ),
        },
    },
    "zhihu": {
        "name": {"Chinese": "知乎", "English": "Zhihu"},
        "instruction": {
            "Chinese": (
                "你是一位知乎优质回答者。请根据以下推演结果，写一篇知乎回答/文章。\n"
                "要求：\n"
                "- 标题：提问式，引发思考\n"
                "- 正文：800-2000字，理性分析、逻辑清晰\n"
                "- 使用二级/三级标题分段\n"
                "- 引用推演中的具体情节作为论据\n"
                "- 语气专业但不枯燥\n"
                "- 结尾给出独到见解或开放性思考\n"
                "- 可以适度加粗重点内容\n"
            ),
            "English": (
                "You are a Zhihu-style long-form answer writer. Based on the simulation "
                "results below, write a thoughtful Zhihu answer in English.\n"
                "Requirements:\n"
                "- Use a question-style title\n"
                "- Body: 800-2000 words, analytical and well-structured\n"
                "- Use section headings\n"
                "- Cite concrete moments from the simulation as evidence\n"
                "- End with a distinctive takeaway or open question\n"
            ),
        },
    },
    "reddit": {
        "name": {"Chinese": "Reddit", "English": "Reddit"},
        "instruction": {
            "Chinese": (
                "你是一位 Reddit 资深用户。请根据以下推演结果，写一篇英文 Reddit 帖子。\n"
                "要求：\n"
                "- 标题：有吸引力、简洁，少于 300 字符\n"
                "- 正文：200-500 词，口语化但有分析感\n"
                "- 使用英文\n"
                "- 使用 markdown 格式\n"
                "- 结尾附 TL;DR\n"
                "- 可附 subreddit 提示，如 [r/whatif] 或 [r/alternatehistory]\n"
            ),
            "English": (
                "You are a Reddit power user. Based on the simulation results below, write a Reddit post.\n"
                "Requirements:\n"
                "- Title: Engaging, concise, under 300 characters\n"
                "- Body: 200-500 words, conversational and engaging\n"
                "- Write in English\n"
                "- Use markdown formatting (headers, bold, lists)\n"
                "- Include a TL;DR at the end\n"
                "- Tone: thoughtful, analytical, slightly casual\n"
                "- Reference specific simulation outcomes\n"
                "- Suggest subreddit tags like [r/whatif] or [r/alternatehistory]\n"
            ),
        },
    },
    "x": {
        "name": {"Chinese": "X (Twitter)", "English": "X (Twitter)"},
        "instruction": {
            "Chinese": (
                "你是一位擅长写爆款推文线程的作者。请根据以下推演结果，写一组英文 X 线程。\n"
                "要求：\n"
                "- 主帖：≤280 字符，抓人\n"
                "- 使用英文\n"
                "- 可选 2-4 条跟帖\n"
                "- 带 1-2 个话题标签\n"
                "- 以钩子问题或强判断开头\n"
                "- 突出最令人意外的结果\n"
                "- 格式：🧵 1/N, 2/N ...\n"
            ),
            "English": (
                "You are a viral tweet writer. Based on the simulation results below, write a tweet thread.\n"
                "Requirements:\n"
                "- Main tweet: ≤280 characters, punchy and attention-grabbing\n"
                "- Write in English\n"
                "- Optional: 2-4 follow-up tweets for a thread, each ≤280 chars\n"
                "- Use 1-2 relevant hashtags\n"
                "- Start with a hook question or bold statement\n"
                "- Include the most surprising outcome\n"
                "- Tone: witty, concise, thought-provoking\n"
                "- Format thread as: 🧵 1/N, 2/N, etc.\n"
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


def _trim_social_copy(platform: str, copy: str) -> str:
    limit = SOCIAL_COPY_MAX_CHARS.get(platform)
    trimmed = copy.strip()
    if limit is None or len(trimmed) <= limit:
        return trimmed

    boundary_markers = ("\n", "。", ".", "！", "!", "？", "?", " ")
    boundary = max(trimmed.rfind(marker, 0, limit) for marker in boundary_markers)
    if boundary < int(limit * 0.6):
        boundary = max(limit - 1, 1)
    return trimmed[:boundary].rstrip() + "…"


def _bound_social_generation_buffer(platform: str, copy: str) -> str:
    limit = SOCIAL_COPY_MAX_CHARS.get(platform)
    trimmed = copy.strip()
    if limit is None:
        return trimmed

    safety_limit = max(limit * 2, limit)
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


# ── Endpoints ────────────────────────────────────────────


async def _generate_social_copy(
    scenario_id: str,
    platform: str,
    req: SocialCopyRequest,
):
    """Generate platform-specific social media copy from simulation results."""
    from app.services.llm_client import (
        LLMBackpressureError,
        LLMCircuitOpenError,
        LLMError,
        llm_call,
    )

    if platform not in SOCIAL_PLATFORM_PROMPTS:
        raise HTTPException(
            400,
            f"Unsupported platform '{platform}'. "
            f"Supported: {', '.join(SOCIAL_PLATFORM_PROMPTS.keys())}",
        )
    platform_config = SOCIAL_PLATFORM_PROMPTS[platform]

    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")

        branches = list(session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).all())
        agents = list(session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).all())

    social_language = _resolve_social_language(scenario)
    context = _build_social_context(
        scenario,
        agents,
        branches,
        language=social_language,
    )
    provider_policy = scenario.parsed_context or {}
    effective_base_url = req.llm_base_url or provider_policy.get("llm_base_url")
    effective_model = req.llm_model or provider_policy.get("llm_model")
    effective_api_key = req.llm_api_key
    quota_key = req.user_id or provider_policy.get("user_id")

    platform_name = platform_config["name"].get(social_language, platform_config["name"]["English"])
    instruction = platform_config["instruction"].get(
        social_language,
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
        ):
            copy = await llm_call(
                prompt,
                timeout=60.0,
                api_key=effective_api_key,
                base_url=effective_base_url,
                model=effective_model,
            )
    except (LLMBackpressureError, LLMCircuitOpenError) as exc:
        raise HTTPException(503, f"LLM temporarily unavailable: {exc}") from exc
    except LLMError as exc:
        raise HTTPException(502, f"LLM generation failed: {exc}") from exc

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
):
    """Generate platform-specific social media copy without provider overrides."""
    return await _generate_social_copy(scenario_id, platform, SocialCopyRequest())


@router.post("/scenario/{scenario_id}/social/{platform}")
async def generate_social_copy_with_overrides(
    scenario_id: str,
    platform: str,
    req: SocialCopyRequest | None = None,
):
    """Generate platform-specific social media copy with provider overrides in the POST body."""
    return await _generate_social_copy(
        scenario_id,
        platform,
        req or SocialCopyRequest(),
    )


@router.get("/scenario/{scenario_id}/export")
async def export_scenario(scenario_id: str):
    """P4-C: Export scenario results as Markdown."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise HTTPException(404, "Scenario not found")

        agents = list(session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all())
        branches = list(session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.status == BranchStatus.COMPLETED,
            )
        ).all())

    # Build Markdown
    lines = [
        f"# SwarmOracle — {scenario.question}",
        "",
        f"> 状态: {scenario.status.value} | 创建时间: {scenario.created_at.isoformat()}",
        "",
        "## 参与角色",
        "",
        "| 角色 | 名称 | 定位 | 层级 |",
        "|------|------|------|------|",
    ]
    for a in agents:
        lines.append(f"| {a.role} | {a.name} | {a.stance} | {a.tier.value} |")

    lines.append("")
    lines.append("---")
    lines.append("")

    if not branches:
        lines.append("*尚无已完成的分支。*")
    else:
        for i, b in enumerate(branches, 1):
            lines.append(f"## 结局 {i}: {b.title}")
            lines.append("")
            lines.append(f"**概率**: {b.probability * 100:.1f}%")
            if b.fork_reason:
                lines.append(f"**分歧原因**: {b.fork_reason}")
            lines.append("")
            lines.append("### 故事")
            lines.append("")
            lines.append(b.story or "—")
            lines.append("")
            if b.insight:
                lines.append("### 洞察")
                lines.append("")
                lines.append(f"> {b.insight}")
                lines.append("")
            moments = parse_key_moments(b.key_moments)
            if moments:
                lines.append("### 关键时刻")
                lines.append("")
                for j, m in enumerate(moments, 1):
                    lines.append(f"{j}. {m}")
                lines.append("")
            lines.append("---")
            lines.append("")

    md_content = "\n".join(lines)
    return PlainTextResponse(content=md_content, media_type="text/markdown")
