"""SwarmOracle API — Social media copy generation & export endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from sqlmodel import Session, select

from app.models import Agent, Branch, BranchStatus, Scenario
from app.models.database import get_engine
from app.api.helpers import parse_key_moments

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


# ── Social Platform Prompts (P6) ─────────────────────────

SOCIAL_PLATFORM_PROMPTS: dict[str, dict[str, str]] = {
    "xiaohongshu": {
        "name": "小红书",
        "instruction": (
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
    },
    "weibo": {
        "name": "微博",
        "instruction": (
            "你是一位微博大V文案写手。请根据以下推演结果，写一条微博。\n"
            "要求：\n"
            "- 正文控制在140字以内（含标点和空格）\n"
            "- 开头用一句抓人的问句或感叹句\n"
            "- 信息密度高，言简意赅\n"
            "- 结尾加2-3个话题标签，格式：#话题#\n"
            "- 语气犀利有态度\n"
            "- 如果内容特别丰富，可以写长微博版本（≤2000字），但默认写短微博\n"
        ),
    },
    "zhihu": {
        "name": "知乎",
        "instruction": (
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
    },
    "reddit": {
        "name": "Reddit",
        "instruction": (
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
    "x": {
        "name": "X (Twitter)",
        "instruction": (
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
}


# ── Endpoints ────────────────────────────────────────────


@router.get("/scenario/{scenario_id}/social/{platform}")
async def generate_social_copy(
    scenario_id: str,
    platform: str,
    # M-10 fix: BYOK support for social copy generation
    llm_api_key: str | None = None,
    llm_base_url: str | None = None,
    llm_model: str | None = None,
):
    """Generate platform-specific social media copy from simulation results."""
    from app.services.llm_client import llm_call, LLMError

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

    # Build context from simulation results
    context_lines = [
        f"问题/假设: {scenario.question}",
        f"参与角色: {', '.join(a.name + '(' + a.role + ')' for a in agents)}",
        "",
    ]
    for i, b in enumerate(branches, 1):
        context_lines.append(f"结局{i}: {b.title} (概率 {b.probability * 100:.0f}%)")
        if b.fork_reason:
            context_lines.append(f"  分歧原因: {b.fork_reason}")
        if b.story:
            # Truncate long stories
            story_preview = b.story[:500] + ("..." if len(b.story) > 500 else "")
            context_lines.append(f"  故事: {story_preview}")
        if b.insight:
            context_lines.append(f"  洞察: {b.insight}")
        context_lines.append("")

    context = "\n".join(context_lines)

    prompt = (
        f"{platform_config['instruction']}\n"
        f"---\n"
        f"推演结果如下：\n\n{context}\n"
        f"---\n"
        f"请直接输出{platform_config['name']}平台的文案，不要加多余说明。"
    )

    try:
        # M-10 fix: Pass BYOK credentials to llm_call
        copy = await llm_call(
            prompt, timeout=60.0,
            api_key=llm_api_key, base_url=llm_base_url, model=llm_model,
        )
    except LLMError as exc:
        raise HTTPException(502, f"LLM generation failed: {exc}") from exc

    return {
        "platform": platform,
        "platform_name": platform_config["name"],
        "copy": copy.strip(),
    }


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
