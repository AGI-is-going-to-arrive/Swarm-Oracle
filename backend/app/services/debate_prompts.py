"""Deterministic debate copy builders for Track D / Phase D1.

The first backend slice avoids depending on an external LLM so the debate
domain stays testable, fast, and safe to iterate on. The API surface is still
structured for later prompt-driven upgrades.
"""

from __future__ import annotations

import re

from app.models import DebatePhase, DebateSide
from app.services.lang_detect import detect_language
from app.services.llm_client import UNTRUSTED_INPUT_GUARDRAIL, format_untrusted_text_block

_WHITESPACE_RE = re.compile(r"\s+")

_PROFILE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "law": ("law", "legal", "court", "judge", "constitution", "regulation", "ban", "veto", "审判", "法律", "法庭", "合宪", "禁令", "否决权"),  # noqa: E501
    "governance": ("governance", "democracy", "vote", "election", "state", "senate", "policy", "committee", "board", "budget", "政府", "治理", "民主", "选举", "议会", "委员会", "预算"),  # noqa: E501
    "war": ("war", "military", "army", "navy", "invasion", "battle", "战争", "军事", "入侵", "战役"),  # noqa: E501
    "empire": ("empire", "dynasty", "emperor", "imperial", "colonial", "帝国", "王朝", "皇帝", "殖民"),  # noqa: E501
    "industry": ("factory", "industry", "industrial", "automation", "energy", "工厂", "工业", "自动化", "电网"),  # noqa: E501
    "trade": ("trade", "market", "port", "tariff", "supply chain", "贸易", "市场", "关税", "物流"),
    "faith": ("faith", "religion", "church", "temple", "god", "宗教", "信仰", "神殿", "教会"),
    "ecology": ("climate", "forest", "river", "ecology", "pollution", "生态", "气候", "森林", "污染"),  # noqa: E501
    "frontier": ("frontier", "colony", "settlement", "mars", "expansion", "边疆", "殖民地", "拓荒", "火星"),  # noqa: E501
    "mythic": ("magic", "myth", "oracle", "curse", "dragon", "神话", "魔法", "预言", "禁术"),
    "survival": ("survival", "plague", "famine", "collapse", "refuge", "生存", "瘟疫", "饥荒", "避难"),  # noqa: E501
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

_PROFILE_STYLE_ZH: dict[str, dict[str, str]] = {
    "law": {
        "pro_case": "把争议装进可审查的条款和程序护栏",
        "con_case": "先例漂移、程序债和例外失控",
        "pressure": "裁量失衡与规则真空",
        "challenge": "哪一条条款、哪一级复核、哪一个举证门槛会先失守？",
        "plan": "日落条款、上诉窗口与更高举证标准",
        "close_pro": "真正值得推进的不是野路子突破，而是能被程序反复检验的改革路径。",
        "close_con": "当合法性与证据门槛还没站稳时，克制本身就是更稳的法政答案。",
        "judge_focus": "程序正义与证据纪律",
    },
    "governance": {
        "pro_case": "把分散压力转进可协调的治理节奏",
        "con_case": "治理过载、责任漂移和执行碎裂",
        "pressure": "失控的协调成本与政策空窗",
        "challenge": "谁来持续对齐委员会、预算和执行链，而不是只在开局高举口号？",
        "plan": "阶段问责、委员会节拍和可回滚授权",
        "close_pro": "动议的价值在于把混乱议题装进可治理、可纠偏的节奏。",
        "close_con": "若治理骨架还没准备好，提前加码只会把协同成本放大成系统性失灵。",
        "judge_focus": "协调能力与制度韧性",
    },
    "trade": {
        "pro_case": "把摩擦转成激励重组和供应链先手",
        "con_case": "成本转嫁、套利失衡和脆弱链路",
        "pressure": "被延后的供应链冲击与价格反噬",
        "challenge": "当运力、关税和清算链条承压时，谁来吞下第一轮成本？",
        "plan": "分层清算、价格缓冲与关键节点备援",
        "close_pro": "真正的贸易优势不是口头繁荣，而是能把成本换成更强的流动性与议价权。",
        "close_con": "若成本外溢无法被锁住，再漂亮的增长曲线也只是把账单往后推。",
        "judge_focus": "激励结构与成本归属",
    },
    "faith": {
        "pro_case": "把共同信念转成可持续的合法性与集体动员",
        "con_case": "神圣叙事反噬、信任破裂和秩序撕裂",
        "pressure": "失控的正当性竞争与群体裂痕",
        "challenge": "当仪式承诺和现实代价冲突时，谁来维护共同体的信任底线？",
        "plan": "仪式边界、共同誓约与渐进式授权",
        "close_pro": "信仰题面并不只关乎热情，而是能否把共同体的意义感稳稳落地。",
        "close_con": "一旦合法性透支，后续裂痕不会按剧本收束，只会成倍放大。",
        "judge_focus": "正当性与共同体稳定",
    },
    "ecology": {
        "pro_case": "提前修正阈值，换取更长的系统缓冲区",
        "con_case": "不可逆损耗、代际债和生态阈值误判",
        "pressure": "被拖延的生态阈值与连锁代价",
        "challenge": "一旦河流、森林或气候阈值跨过去，谁来承担那种不可逆后果？",
        "plan": "分区阈值、监测回路与代际成本记账",
        "close_pro": "生态议题的关键不是乐观口号，而是争取尚可修复的时间窗口。",
        "close_con": "若代价不可逆，再温和的承诺也掩盖不了这条世界线的长期债务。",
        "judge_focus": "阈值判断与长期代价",
    },
    "war": {
        "pro_case": "把高压局势转成可控制的战略主动权",
        "con_case": "补给透支、误判升级和反制失衡",
        "pressure": "被动扩大的战线与动员代价",
        "challenge": "当补给、战线和盟友承压时，哪一环会先崩，不是靠气势就能扛过去的。",
        "plan": "补给冗余、升级阈值与战线节奏控制",
        "close_pro": "战争题面的上限来自主动塑形，而不是无休止地等待更坏局面降临。",
        "close_con": "若升级链无法被约束，任何看似果断的推进都可能变成更昂贵的失控。",
        "judge_focus": "升级控制与战略可持续性",
    },
    "generic": {
        "pro_case": "把混乱议题收束成更可执行的世界线",
        "con_case": "执行代价、反噬速度和制度裂口",
        "pressure": "被低估的系统摩擦",
        "challenge": "如果这条世界线失手，第一批代价会落到谁头上？",
        "plan": "先护栏、后扩张、再校正",
        "close_pro": "动议的价值在于把不确定性转成可管理的选择。",
        "close_con": "当关键前提还没有闭合，克制依然是更可信的答案。",
        "judge_focus": "可执行性与后果清晰度",
    },
}

_PROFILE_STYLE_EN: dict[str, dict[str, str]] = {
    "law": {
        "pro_case": "turning the dispute into reviewable clauses and procedural guardrails",
        "con_case": "precedent drift, due-process debt, and uncontrolled exceptions",
        "pressure": "discretion drift and rule vacuums",
        "challenge": "Which clause, review layer, or burden-of-proof threshold fails first?",
        "plan": "sunset clauses, appeal windows, and a higher evidentiary threshold",
        "close_pro": "The real reform case is not improvisation but a pathway that survives repeated procedural review.",  # noqa: E501
        "close_con": "If legality and proof standards are still shaky, restraint remains the more defensible legal answer.",  # noqa: E501
        "judge_focus": "procedural legitimacy and evidence discipline",
    },
    "governance": {
        "pro_case": "converting scattered pressure into a governable coordination rhythm",
        "con_case": "governance overload, accountability drift, and execution fragmentation",
        "pressure": "runaway coordination costs and policy dead zones",
        "challenge": (
            "Who keeps committees, budgets, and operators aligned after the opening slogans fade?"
        ),
        "plan": "phased accountability, committee cadence, and reversible authority",
        "close_pro": (
            "The value of the motion is that it makes chaotic pressure governable and correctable."
        ),
        "close_con": "If the governing skeleton is not ready, acceleration only magnifies coordination failure.",  # noqa: E501
        "judge_focus": "coordination capacity and institutional resilience",
    },
    "trade": {
        "pro_case": "converting friction into incentive realignment and supply-chain leverage",
        "con_case": "cost pass-through, arbitrage imbalance, and brittle links",
        "pressure": "deferred supply shocks and price backlash",
        "challenge": (
            "When freight, tariffs, and settlement rails tighten, who absorbs the first cost wave?"
        ),
        "plan": "tiered settlement, price buffers, and backup nodes",
        "close_pro": "Trade upside is not rhetoric. It is the ability to convert cost into liquidity and bargaining power.",  # noqa: E501
        "close_con": (
            "If spillover cost is not contained, the growth curve is just a delayed invoice."
        ),
        "judge_focus": "incentive design and cost allocation",
    },
    "faith": {
        "pro_case": "turning shared belief into durable legitimacy and collective mobilization",
        "con_case": "sacred backlash, trust fractures, and order splitting along belief lines",
        "pressure": "uncontained legitimacy competition and social fracture",
        "challenge": "When ritual promises clash with material costs, who protects the community's trust floor?",  # noqa: E501
        "plan": "ritual boundaries, shared covenant, and gradual authorization",
        "close_pro": "Faith-driven motions are not only about passion. They are about whether meaning can be made durable.",  # noqa: E501
        "close_con": (
            "Once legitimacy is overdrawn, the later fracture will compound rather than settle."
        ),
        "judge_focus": "legitimacy and communal stability",
    },
    "ecology": {
        "pro_case": "correcting thresholds early enough to buy a larger ecological buffer",
        "con_case": "irreversible loss, intergenerational debt, and threshold misreads",
        "pressure": "delayed ecological thresholds and cascading cost",
        "challenge": "Once a river, forest, or climate threshold is crossed, who carries the irreversible cost?",  # noqa: E501
        "plan": "zoned thresholds, monitoring loops, and intergenerational cost accounting",
        "close_pro": (
            "Ecological upside comes from preserving a repair window, not from optimistic branding."
        ),
        "close_con": "If the damage is irreversible, even moderate promises cannot hide the debt of this worldline.",  # noqa: E501
        "judge_focus": "threshold judgment and long-horizon cost",
    },
    "war": {
        "pro_case": "turning high pressure into controlled strategic initiative",
        "con_case": "supply exhaustion, escalation error, and counterforce imbalance",
        "pressure": "widening fronts and mobilization debt",
        "challenge": "When logistics, fronts, and allies strain together, which link breaks first?",
        "plan": "logistics redundancy, escalation thresholds, and front-tempo control",
        "close_pro": (
            "War-adjacent upside comes from shaping the tempo before the worse option arrives."
        ),
        "close_con": "If the escalation ladder is not constrained, decisive-looking moves can become costlier disorder.",  # noqa: E501
        "judge_focus": "escalation control and strategic sustainability",
    },
    "generic": {
        "pro_case": "turning a chaotic question into a more executable worldline",
        "con_case": "execution cost, backlash speed, and institutional fracture lines",
        "pressure": "system friction that is being underestimated",
        "challenge": "If this worldline breaks, who pays the first cost?",
        "plan": "guardrails first, then expansion, then correction",
        "close_pro": "The motion matters because it converts uncertainty into a manageable choice.",
        "close_con": (
            "When the core premises are still open, restraint remains the more credible answer."
        ),
        "judge_focus": "executability and consequence clarity",
    },
}


def get_debate_profile_style(language: str, profile_id: str) -> dict[str, str]:
    if language == "zh":
        return _PROFILE_STYLE_ZH.get(profile_id, _PROFILE_STYLE_ZH["generic"])
    return _PROFILE_STYLE_EN.get(profile_id, _PROFILE_STYLE_EN["generic"])


def normalize_question(question: str, *, max_length: int = 160) -> str:
    compact = _WHITESPACE_RE.sub(" ", question).strip()
    if len(compact) <= max_length:
        return compact
    return f"{compact[: max_length - 1].rstrip()}..."


def phase_argument_goal(language: str, phase: DebatePhase, side: DebateSide) -> str:
    """Describe the rhetorical job of a turn without dictating exact wording."""
    if language == "zh":
        if phase == DebatePhase.OPENING:
            return "先立一个清晰主张，再说明这条主张会怎样影响制度、执行或代价分布。"
        if phase == DebatePhase.CROSSFIRE:
            return "抓住对方刚才最脆弱的一点，追问它会在现实里先伤到谁、卡在哪一环。"
        if phase == DebatePhase.REBUTTAL:
            return "正面回应上一轮最强质疑，补上缺口，同时把自己的方案讲得更可执行。"
        if phase == DebatePhase.CLOSING:
            return "收束争点，不重复前文，用一句更大的判断说明为什么这条世界线更稳或更危险。"
        return "以裁决者口吻点出胜负关键，至少引用两类具体优势或漏洞。"

    if phase == DebatePhase.OPENING:
        return (
            "Plant a clear thesis, then tie it to institutions, execution, or who absorbs the cost."
        )
    if phase == DebatePhase.CROSSFIRE:
        return "Hit the weakest point in the other side's latest case and ask where it breaks first in reality."  # noqa: E501
    if phase == DebatePhase.REBUTTAL:
        return "Answer the strongest criticism directly, repair the exposed gap, and make your path more executable."  # noqa: E501
    if phase == DebatePhase.CLOSING:
        return "Compress the dispute into one larger judgment instead of repeating earlier lines."
    return "Sound like a judge, naming at least two concrete reasons why one side wins."


def stock_opening_guard(language: str, phase: DebatePhase) -> str:
    """List openings the model should avoid repeating verbatim."""
    if phase == DebatePhase.VERDICT:
        return ""
    if language == "zh":
        return "避免使用这些开头：我方支持、我方反对、正方认为、反方认为、所谓、显然。"
    return "Avoid stock openings like: We support the motion, We oppose the motion, Proposition says, Opposition says, Obviously."  # noqa: E501


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


def _get_profile_style(language: str, profile_id: str) -> dict[str, str]:
    if language == "zh":
        return _PROFILE_STYLE_ZH.get(profile_id, _PROFILE_STYLE_ZH["generic"])
    return _PROFILE_STYLE_EN.get(profile_id, _PROFILE_STYLE_EN["generic"])


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
    style = _get_profile_style("zh", profile_id)
    if phase == DebatePhase.OPENING and side == DebateSide.PROPOSITION:
        return f"我方支持这项动议。若围绕“{compact_question}”主动布局，就能{style['pro_case']}，让{profile_label} 体系把不确定性压进更可治理的秩序。"  # noqa: E501
    if phase == DebatePhase.OPENING and side == DebateSide.OPPOSITION:
        return f"我方反对。动议把收益叙事说得过于轻松，却低估了{style['con_case']}。"
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.PROPOSITION:
        return f"反方不断强调风险，却没有说明在不推动这条世界线时，如何处理已经暴露的{style['pressure']}。"  # noqa: E501
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.OPPOSITION:
        return f"正方把愿景当成证据。请正面回答：{style['challenge']}"
    if phase == DebatePhase.REBUTTAL and side == DebateSide.PROPOSITION:
        return f"我方并非否认代价，而是主张分阶段落地：先布置{style['plan']}，再释放增量，这比长期犹豫更稳。"  # noqa: E501
    if phase == DebatePhase.REBUTTAL and side == DebateSide.OPPOSITION:
        return f"所谓分阶段落地并没有消除根本漏洞，只是把{style['con_case']}从显性冲突延后成更难收拾的系统债。"  # noqa: E501
    if phase == DebatePhase.CLOSING and side == DebateSide.PROPOSITION:
        return style["close_pro"]
    if phase == DebatePhase.CLOSING and side == DebateSide.OPPOSITION:
        return style["close_con"]
    if phase == DebatePhase.VERDICT:
        outcome = "正方" if winner == "proposition" else "反方"
        tone_label = {
            "order": "秩序",
            "balance": "均衡",
            "rupture": "断裂",
        }.get(verdict_tone or "", "均衡")
        return f"裁决：{outcome}获胜。本场主导判词是“{tone_label}”。双方都形成了有效张力，但胜方在{style['judge_focus']}上更能把论点落到可执行后果。"  # noqa: E501
    return motion


def build_turn_generation_prompt(
    *,
    language: str,
    phase: DebatePhase,
    side: DebateSide,
    speaker_name: str,
    speaker_role: str,
    motion: str,
    question: str,
    profile_id: str,
    anchor_copy: str,
    recent_turns: list[dict[str, str]],
    verdict_tone: str | None = None,
    winner: str | None = None,
) -> str:
    """Build an LLM prompt for a single debate turn.

    The deterministic anchor copy preserves the current design intent while
    letting the model rewrite it into something less templated.
    """
    phase_label = phase.value
    recent_lines = []
    for turn in recent_turns[-4:]:
        recent_lines.append(
            f"- {turn['phase']} / {turn['speaker_name']}: {turn['content']}"
        )
    recent_block = "\n".join(recent_lines) if recent_lines else "(none)"
    latest_opponent_turn = next(
        (
            turn["content"]
            for turn in reversed(recent_turns)
            if turn["speaker_name"] != speaker_name
        ),
        "",
    )
    verdict_hint = ""
    if phase == DebatePhase.VERDICT:
        verdict_hint = (
            f"\nRequired verdict: winner={winner or 'unknown'}, tone={verdict_tone or 'balance'}."
        )

    if language == "zh":
        return (
            "你正在为 SwarmOracle Debate Arena 生成一条结构化辩论台词。\n"
            f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
            f"角色：{speaker_name} / {speaker_role}\n"
            f"阶段：{phase_label}\n"
            f"立场：{side.value}\n"
            f"题材：{profile_id}\n"
            f"{verdict_hint}\n"
            f"本轮任务：{phase_argument_goal(language, phase, side)}\n"
            f"{stock_opening_guard(language, phase)}\n"
            f"{format_untrusted_text_block('辩题问题', question, max_chars=600)}\n"
            f"{format_untrusted_text_block('正式动议', motion, max_chars=600)}\n"
            f"{format_untrusted_text_block('最近辩论记录', recent_block, max_chars=1200)}\n"
            f"{format_untrusted_text_block('上一条对手发言', latest_opponent_turn or '(none)', max_chars=500)}\n"  # noqa: E501
            f"{format_untrusted_text_block('语义锚点', anchor_copy, max_chars=500)}\n"
            "任务：保留同样的立场、阶段目标和结论方向，但不要复读锚点文案本身，要写成更像真人现场辩论的即时回应。\n"
            "要求：\n"
            "- 2-4 句，必须至少包含一个具体机制、执行后果或责任链\n"
            "- 如果存在上一条对手发言，你必须正面回应其中一个具体点，而不是另起炉灶\n"
            "- 不要重复“我方支持/反对”这类开场套话，也不要直接改写语义锚点原句\n"
            "- 语气可以更像真人：允许有锋芒、反问、压迫感，但不要变成表演性口号\n"
            "- 句式要有起伏，至少有一句像在现场逼问或回击，而不是平铺直叙\n"
            "- 至少有一句短句（不超过18字）作为逼问、回击或落锤\n"
            "- 避免每句都很长；单句尽量不要堆超过三个并列分句\n"
            "- 不要引入与题目无关的新设定\n"
            "- 如果是 verdict，必须明确给出胜方与判词语气\n"
            "- 只输出严格 JSON：{\"content\": \"...\"}\n"
        )

    return (
        "You are generating one structured line for SwarmOracle Debate Arena.\n"
        f"{UNTRUSTED_INPUT_GUARDRAIL}\n"
        f"Speaker: {speaker_name} / {speaker_role}\n"
        f"Phase: {phase_label}\n"
        f"Side: {side.value}\n"
        f"Profile: {profile_id}\n"
        f"{verdict_hint}\n"
        f"Turn goal: {phase_argument_goal(language, phase, side)}\n"
        f"{stock_opening_guard(language, phase)}\n"
        f"{format_untrusted_text_block('Debate question', question, max_chars=600)}\n"
        f"{format_untrusted_text_block('Motion', motion, max_chars=600)}\n"
        f"{format_untrusted_text_block('Recent debate turns', recent_block, max_chars=1200)}\n"
        f"{format_untrusted_text_block('Latest opposing turn', latest_opponent_turn or '(none)', max_chars=500)}\n"  # noqa: E501
        f"{format_untrusted_text_block('Semantic anchor', anchor_copy, max_chars=500)}\n"
        "Task: keep the same stance, phase objective, and conclusion direction, but do not paraphrase the anchor line. Write it like a live response in an actual debate.\n"  # noqa: E501
        "Requirements:\n"
        "- 2-4 sentences with at least one concrete mechanism, execution consequence, or accountability chain\n"  # noqa: E501
        "- If there is a latest opposing turn, answer one specific point from it directly\n"
        "- Avoid stock openings and do not recycle anchor wording\n"
        "- Let the tone feel human: sharp, under pressure, and willing to press a contradiction instead of sounding like a report\n"  # noqa: E501
        "- Vary the rhythm so at least one sentence lands like a real challenge, counterpunch, or closing hit\n"  # noqa: E501
        "- Include at least one short sentence (about 3-8 words) that lands like a jab, pivot, or hammer blow\n"  # noqa: E501
        "- Do not let every sentence run long; avoid piling up more than three parallel clauses in one line\n"  # noqa: E501
        "- Do not invent unrelated world details\n"
        "- If this is the verdict, explicitly state winner and tone\n"
        "- Output strict JSON only: {\"content\": \"...\"}\n"
    )


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
    style = _get_profile_style("en", profile_id)
    if phase == DebatePhase.OPENING and side == DebateSide.PROPOSITION:
        return f"We support the motion. Around '{compact_question}', we can pursue {style['pro_case']} and convert uncertainty into governable leverage."  # noqa: E501
    if phase == DebatePhase.OPENING and side == DebateSide.OPPOSITION:
        return f"We oppose the motion. The upside story is overstated, while {style['con_case']} are being understated."  # noqa: E501
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.PROPOSITION:
        return f"Opposition keeps naming risks without explaining how the status quo handles {style['pressure']}."  # noqa: E501
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.OPPOSITION:
        return f"Proposition is treating aspiration as evidence. {style['challenge']}"
    if phase == DebatePhase.REBUTTAL and side == DebateSide.PROPOSITION:
        return f"We are not denying trade-offs. We are sequencing them through {style['plan']} before unlocking upside."  # noqa: E501
    if phase == DebatePhase.REBUTTAL and side == DebateSide.OPPOSITION:
        return f"Sequencing does not remove the core flaw. It merely delays {style['con_case']} until the system is more exposed."  # noqa: E501
    if phase == DebatePhase.CLOSING and side == DebateSide.PROPOSITION:
        return style["close_pro"]
    if phase == DebatePhase.CLOSING and side == DebateSide.OPPOSITION:
        return style["close_con"]
    if phase == DebatePhase.VERDICT:
        tone_label = {
            "order": "order",
            "balance": "balance",
            "rupture": "rupture",
        }.get(verdict_tone or "", "balance")
        winner_label = "Proposition" if winner == "proposition" else "Opposition"
        return f"Verdict: {winner_label} wins. The dominant tone is {tone_label}. Both sides produced tension, but the winner was stronger on {style['judge_focus']}."  # noqa: E501
    return motion
