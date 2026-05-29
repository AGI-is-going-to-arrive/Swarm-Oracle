"""SwarmOracle API — Social media copy generation & export endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.api.errors import api_error, api_error_from_exception
from app.api.helpers import (
    SessionPrincipal,
    parse_key_moments,
    require_owned_scenario,
    require_session_principal,
    verify_session,
)
from app.models import Agent, Branch, BranchStatus, Scenario
from app.models.database import get_engine
from app.services.lang_detect import detect_language, get_language_directive
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    llm_request_scope,
    validate_llm_base_url,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", dependencies=[Depends(verify_session)])
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
    llm_requests_per_minute: int | None = None
    llm_tokens_per_minute: int | None = None
    user_id: str | None = None

    @field_validator("llm_api_key", "llm_base_url", "llm_model")
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


# ── Endpoints ────────────────────────────────────────────


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
    if req.llm_base_url:
        validated_url = validate_llm_base_url(req.llm_base_url)
        if validated_url is None:
            raise api_error(400, "LLM_BASE_URL_NOT_ALLOWED", "Provided llm_base_url is not in the allowed provider list")  # noqa: E501
        if not req.llm_api_key:
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
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)

        branches = list(session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).all())
        agents = list(session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
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
    effective_base_url = req.llm_base_url or provider_policy.get("llm_base_url")
    effective_model = req.llm_model or provider_policy.get("llm_model")
    effective_api_key = req.llm_api_key
    effective_requests_per_minute = (
        req.llm_requests_per_minute
        if req.llm_requests_per_minute is not None
        else provider_policy.get("llm_requests_per_minute")
    )
    effective_tokens_per_minute = (
        req.llm_tokens_per_minute
        if req.llm_tokens_per_minute is not None
        else provider_policy.get("llm_tokens_per_minute")
    )
    quota_key = req.user_id or provider_policy.get("user_id")

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
):
    """P4-C: Export scenario results as Markdown."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = require_owned_scenario(session, scenario_id, principal)

        agents = list(session.exec(select(Agent).where(Agent.scenario_id == scenario_id)).all())
        branches = list(session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.status == BranchStatus.COMPLETED,
            )
        ).all())

    language = _resolve_social_language(scenario)
    labels = {
        "status": "状态" if language == "Chinese" else "Status",
        "created_at": "创建时间" if language == "Chinese" else "Created",
        "participants": "参与角色" if language == "Chinese" else "Participants",
        "role": "角色" if language == "Chinese" else "Role",
        "name": "名称" if language == "Chinese" else "Name",
        "stance": "定位" if language == "Chinese" else "Stance",
        "tier": "层级" if language == "Chinese" else "Tier",
        "no_branches": "尚无已完成的分支。" if language == "Chinese" else "No completed branches yet.",  # noqa: E501
        "ending": "结局" if language == "Chinese" else "Ending",
        "probability": "概率" if language == "Chinese" else "Probability",
        "fork_reason": "分歧原因" if language == "Chinese" else "Fork Reason",
        "story": "故事" if language == "Chinese" else "Story",
        "insight": "洞察" if language == "Chinese" else "Insight",
        "key_moments": "关键时刻" if language == "Chinese" else "Key Moments",
    }

    # Build Markdown
    lines = [
        f"# SwarmOracle — {scenario.question}",
        "",
        f"> {labels['status']}: {scenario.status.value} | {labels['created_at']}: {scenario.created_at.isoformat()}",  # noqa: E501
        "",
        f"## {labels['participants']}",
        "",
        f"| {labels['role']} | {labels['name']} | {labels['stance']} | {labels['tier']} |",
        "|------|------|------|------|",
    ]
    for a in agents:
        lines.append(f"| {a.role} | {a.name} | {a.stance} | {a.tier.value} |")

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
