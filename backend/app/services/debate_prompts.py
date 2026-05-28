"""Deterministic debate copy builders for Track D / Phase D1.

The first backend slice avoids depending on an external LLM so the debate
domain stays testable, fast, and safe to iterate on. The API surface is still
structured for later prompt-driven upgrades.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from app.models import DebatePhase, DebateSide
from app.services.lang_detect import detect_language
from app.services.llm_client import (
    UNTRUSTED_INPUT_GUARDRAIL,
    format_untrusted_text_block,
    has_prompt_injection_markers,
    llm_call_json_with_stream_fallback,
)

logger = logging.getLogger(__name__)

_WHITESPACE_RE = re.compile(r"\s+")

DEBATE_BANNED_TERMS_ZH = "「机制」「执行后果」「责任链」「世界线」「可执行性」「护栏」「阈值」「制度韧性」「协调成本」"  # noqa: E501
DEBATE_BANNED_TERMS_EN = "'mechanism', 'accountability chain', 'execution framework', 'guardrails', 'worldline', 'executability', 'institutional resilience'"  # noqa: E501

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
        "pro_case": "把争议装进可审查的条款和程序安全边界",
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
        "pressure": "失控的沟通代价与政策空窗",
        "challenge": "谁来持续对齐委员会、预算和执行链，而不是只在开局高举口号？",
        "plan": "阶段问责、委员会节拍和可回滚授权",
        "close_pro": "动议的价值在于把混乱议题装进可治理、可纠偏的节奏。",
        "close_con": "若治理骨架还没准备好，提前加码只会把协同成本放大成系统性失灵。",
        "judge_focus": "协调能力与制度承受力",
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
        "pro_case": "提前修正临界点，换取更长的系统缓冲区",
        "con_case": "不可逆损耗、代际债和生态临界点误判",
        "pressure": "被拖延的生态临界点与连锁代价",
        "challenge": "一旦河流、森林或气候临界点跨过去，谁来承担那种不可逆后果？",
        "plan": "分区临界点、监测回路与代际成本记账",
        "close_pro": "生态议题的关键不是乐观口号，而是争取尚可修复的时间窗口。",
        "close_con": "若代价不可逆，再温和的承诺也掩盖不了这个方向的长期债务。",
        "judge_focus": "临界点判断与长期代价",
    },
    "war": {
        "pro_case": "把高压局势转成可控制的战略主动权",
        "con_case": "补给透支、误判升级和反制失衡",
        "pressure": "被动扩大的战线与动员代价",
        "challenge": "当补给、战线和盟友承压时，哪一环会先崩，不是靠气势就能扛过去的。",
        "plan": "补给冗余、升级边界与战线节奏控制",
        "close_pro": "战争题面的上限来自主动塑形，而不是无休止地等待更坏局面降临。",
        "close_con": "若升级链无法被约束，任何看似果断的推进都可能变成更昂贵的失控。",
        "judge_focus": "升级控制与战略可持续性",
    },
    "generic": {
        "pro_case": "把混乱议题收束成更具体的方案",
        "con_case": "执行代价、反噬速度和制度裂口",
        "pressure": "被低估的系统摩擦",
        "challenge": "如果这个方向失手，第一批代价会落到谁头上？",
        "plan": "先设安全边界、后扩张、再校正",
        "close_pro": "动议的价值在于把不确定性转成可管理的选择。",
        "close_con": "当关键前提还没有闭合，克制依然是更可信的答案。",
        "judge_focus": "落地能力与后果清晰度",
    },
}

_PROFILE_STYLE_EN: dict[str, dict[str, str]] = {
    "law": {
        "pro_case": "turning the dispute into reviewable clauses and procedural safeguards",
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
        "judge_focus": "coordination capacity and institutional strength",
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
        "close_con": "If the damage is irreversible, even moderate promises cannot hide the debt of this path.",  # noqa: E501
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
        "pro_case": "turning a chaotic question into a more practical path",
        "con_case": "execution cost, backlash speed, and institutional fracture lines",
        "pressure": "system friction that is being underestimated",
        "challenge": "If this path breaks, who pays the first cost?",
        "plan": "safeguards first, then expansion, then correction",
        "close_pro": "The motion matters because it converts uncertainty into a manageable choice.",
        "close_con": (
            "When the core premises are still open, restraint remains the more credible answer."
        ),
        "judge_focus": "practicality and consequence clarity",
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
    """Natural-language task description for a single debate turn."""
    if language == "zh":
        if phase == DebatePhase.OPENING:
            if side == DebateSide.PROPOSITION:
                return "说清楚你为什么觉得这事值得推动，让人听完就知道你想做什么、为什么现在做。"
            if side == DebateSide.OPPOSITION:
                return "说清楚你为什么觉得这事不靠谱，直接点出最让你不放心的地方。"
            return "亮出你的态度，说清楚你怎么看这个议题。"
        if phase == DebatePhase.CROSSFIRE:
            if side == DebateSide.PROPOSITION:
                return "对方刚才说得最虚的那句话，追着它问：你不做，那怎么办？"
            if side == DebateSide.OPPOSITION:
                return "对方刚才画的饼最大的那个地方，追着它问：真落地时谁扛？"
            return "抓住对方话里最站不住的那一句，往下追问。"
        if phase == DebatePhase.REBUTTAL:
            if side == DebateSide.PROPOSITION:
                return "对方担心的有道理的部分先接住，然后说清楚你怎么解决，别光说'我考虑过了'。"
            if side == DebateSide.OPPOSITION:
                return "对方刚才补的方案听起来像打补丁——说清楚为什么这个补丁补不住。"
            return "回应对方最强的质疑，说清楚你的解法。"
        if phase == DebatePhase.CLOSING:
            if side == DebateSide.PROPOSITION:
                return "最后一句话。不要复述——说一句让人记住的判断：不做才是真正的冒险。"
            if side == DebateSide.OPPOSITION:
                return "最后一句话。不要数对方的错——说一句让人记住的判断：账还没结清。"
            return "用一句话收束全场，不重复之前说过的。"
        return "像一个看完全场的老裁判说话：先说谁赢了、为什么赢，点一个具体瞬间。"

    if phase == DebatePhase.OPENING:
        if side == DebateSide.PROPOSITION:
            return "Explain why this is worth doing — make it clear what you want and why now."
        if side == DebateSide.OPPOSITION:
            return "Explain why this doesn't hold up — point to the part that worries you most."
        return "State your position and what you think about this topic."
    if phase == DebatePhase.CROSSFIRE:
        if side == DebateSide.PROPOSITION:
            return "Find the weakest thing they just said and press them: if not this, then what?"
        if side == DebateSide.OPPOSITION:
            return "Find their biggest promise and press them: when it actually happens, who pays?"
        return "Pick the least convincing line from the other side and push back."
    if phase == DebatePhase.REBUTTAL:
        if side == DebateSide.PROPOSITION:
            return (
                "Their worry has some merit — own it, then show how you actually handle it."
            )
        if side == DebateSide.OPPOSITION:
            return "Their fix sounds like a patch — explain why it doesn't hold."
        return "Address their strongest critique and show your answer."
    if phase == DebatePhase.CLOSING:
        if side == DebateSide.PROPOSITION:
            return (
                "One final line. Don't recap — leave the room with one judgment "
                "they'll remember."
            )
        if side == DebateSide.OPPOSITION:
            return (
                "One final line. Don't list mistakes — leave the room knowing "
                "the bill isn't paid."
            )
        return "One sentence to close it all. Don't repeat yourself."
    return (
        "Speak like a judge who watched every round — name who won "
        "and the moment that decided it."
    )


def stock_opening_guard(language: str, phase: DebatePhase) -> str:
    """Positive instruction about how to open a turn (replaces a banned-phrase list)."""
    if phase == DebatePhase.VERDICT:
        return ""
    if language == "zh":
        return (
            "开头不要用「我方支持/反对/认为」这种官腔。"
            "直接说事，像聊天一样自然。"
        )
    return (
        "Don't open with 'We support/oppose/believe'. "
        "Jump straight into it, like you're talking to someone."
    )


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
        return f"本院动议：{compact}"
    return f"Motion: {compact}"


_PERSONA_TEMPLATES_ZH: dict[str, dict[str, tuple[str, str]]] = {
    "governance": {
        "proposition": (
            "资深政策架构师，主持过多轮跨部门改革",
            "讲究节拍与授权层级，喜欢用预算回路和委员会节奏说话；语气克制但锋利，不容许把治理简化成口号。",
        ),
        "opposition": (
            "前监察长，亲历过制度坍塌的善后",
            "对承诺天然不信任，惯常追问执行链与责任分配；嗓音低、节奏慢，但每一句都在拆细节。",
        ),
        "judge": (
            "公共治理学派的资深评委",
            "习惯用制度承受力与沟通代价作为标尺，发言时不堆华丽辞藻，只挑场上真正撑得住的论点回应。",
        ),
    },
    "war": {
        "proposition": (
            "曾在战略评估部门效力的退役指挥官",
            "用补给线、升级边界与前线节奏说话，语气压得很低，倾向用短句逼问主动权归谁。",
        ),
        "opposition": (
            "和平协调员出身，参与过多轮冲突收尾",
            "见惯升级失控，善于把热血叙事拆回伤亡数字；语气冷静却带压迫感，喜欢直指代价归属。",
        ),
        "judge": (
            "战略学院的资深评委",
            "始终以升级控制与可持续性衡量胜负，听得懂战术语言但不被迷惑；裁决时偏好有现场画面的判断。",
        ),
    },
    "empire": {
        "proposition": (
            "帝国制度史学者，写过三本王朝转型专著",
            "习惯调用先例与权力流动来支撑论点；语气端庄但带刺，常用一句历史回声压住对方。",
        ),
        "opposition": (
            "前殖民地档案研究员",
            "对「雄图伟业」叙事天然警觉，喜欢翻出被遗漏的代价；语速不急，但每个反例都极具杀伤。",
        ),
        "judge": (
            "比较政治史方向的评委",
            "把权力代价和制度延续性当作最重要的衡量；发言时会引用一段更长的历史脉络作判断。",
        ),
    },
    "trade": {
        "proposition": (
            "国际供应链战略顾问",
            "讲求关税层级、清算节奏与价格弹性，语气利落，喜欢把抽象议题拉回到一张资产负债表。",
        ),
        "opposition": (
            "出身工会的港口经济学家",
            "对成本转嫁与脆弱链路尤其敏感，喜欢戳破「增长红利」叙事；语气朴实，但击点极准。",
        ),
        "judge": (
            "贸易政策研究院的评委",
            "权衡激励结构与成本分配是其本能；发言时少用形容词，多用一组具体数字或流程。",
        ),
    },
    "faith": {
        "proposition": (
            "跨信仰对话项目的资深召集人",
            "懂得仪式如何转化为合法性与凝聚力；语气温和但有定力，喜欢用一句共同体语言压稳全场。",
        ),
        "opposition": (
            "宗教社会学学者，关注信任崩解",
            "对神圣叙事高度警觉，常以历史裂痕作论据；语气克制，但每个问题都直指共同体的底线。",
        ),
        "judge": (
            "公共伦理方向的资深评委",
            "把正当性与社群稳定当作核心指标；不被情绪打动，只听有谁真正回答了信任怎么维系。",
        ),
    },
    "ecology": {
        "proposition": (
            "区域生态治理顾问，参与过多轮临界点监测",
            "用临界点、回路与代际成本说话，语气务实，习惯把宏大议题压到一张监测表的层次。",
        ),
        "opposition": (
            "环境历史学家，研究过若干不可逆崩溃案例",
            "对乐观叙事高度怀疑，惯常用过往的代际债作反例；语气稳但每句都在提示时间窗口。",
        ),
        "judge": (
            "生态系统评估方向的评委",
            "把临界点判断与长期账作为衡量；裁决时会指明哪一种代价是不可逆的，哪一种还能买回时间。",
        ),
    },
    "frontier": {
        "proposition": (
            "拓荒计划的总设计师",
            "讲究阶段授权、补给冗余与人员轮换；语气带着勘探者的克制锋芒，喜欢让计划自己说话。",
        ),
        "opposition": (
            "拓殖伦理评估专家",
            "对「边疆红利」叙事高度警觉，喜欢追问被低估的失败模式；语调慢但每句都在拆假设。",
        ),
        "judge": (
            "拓荒史与公共风险方向的评委",
            "习惯把落地能力与代价归属作为标尺；发言不带浪漫色彩，只问谁来兜底。",
        ),
    },
    "mythic": {
        "proposition": (
            "象征系统研究者，懂得叙事如何转化为社会凝聚",
            "习惯用神话结构解释当下决策；语气克制但带火，相信一个好故事可以推动一个方向。",
        ),
        "opposition": (
            "民俗考古学家，研究过失控的预言与诅咒",
            "对「神授必然」叙事天然怀疑，喜欢翻出反噬的案例；语速不急，但击点常落在对方最自信处。",
        ),
        "judge": (
            "文化与权力交叉方向的评委",
            "把象征代价与共同体后果作为核心；裁决时会把神话语言翻译成可被检验的执行问题。",
        ),
    },
    "survival": {
        "proposition": (
            "灾难应对协调官，处理过数次群体迁徙",
            "讲究避难层级、配给曲线与心理负载；语气稳，能在最紧迫的瞬间保持节奏。",
        ),
        "opposition": (
            "公共卫生史学者，研究过若干失控期",
            "对「紧急即合法」叙事极为警觉，喜欢追问紧急权何时归还；语气低，但每个问题都直击权力边界。",
        ),
        "judge": (
            "灾难治理方向的评委",
            "把存活率与社会信任作为同等重要的标尺；裁决时既看效率，也看制度是否被透支。",
        ),
    },
    "industry": {
        "proposition": (
            "重工业转型顾问，操盘过多轮电网与产能改造",
            "习惯用负载曲线与产能弹性说话，语气干脆利落，把抽象政策压回到一张工序图。",
        ),
        "opposition": (
            "能源与劳工政策研究员",
            "对「自动化奇迹」叙事高度警觉，喜欢戳破被掩盖的代价；语调慢，但每个反例都极具针对性。",
        ),
        "judge": (
            "工业政策方向的评委",
            "把产业可持续性与劳工冲击放在同一台天平；不爱听口号，只问谁来吸收第一波震荡。",
        ),
    },
    "law": {
        "proposition": (
            "宪政设计方向的资深律师",
            "讲究条款层级、复核窗口与举证门槛；语气端正但锋利，喜欢用一条具体程序压稳全场。",
        ),
        "opposition": (
            "司法监察出身的诉讼专家",
            "对程序漂移与例外滥用尤为敏感，喜欢在最自信的论点上点出先例隐患；语气克制但击点极准。",
        ),
        "judge": (
            "比较宪法方向的评委",
            "把程序正义与证据纪律作为最高标尺；发言时既看法理，也看制度能否承担落地代价。",
        ),
    },
    "generic": {
        "proposition": (
            "跨领域政策架构师，最近主持过多个体系重构",
            "讲究阶段授权、安全边界顺序与代价分配；语气克制但有锋芒，习惯用具体安排去说服。",
        ),
        "opposition": (
            "前危机管理顾问，亲历过若干失败的「果断改革」",
            "对漂亮承诺天然怀疑，喜欢追问执行链与第一批受冲击者；语调稳，但句句拆假设。",
        ),
        "judge": (
            "结构化辩论方向的资深评委",
            "把落地能力与后果清晰度作为衡量；裁决时直接命中决定胜负的那个瞬间。",
        ),
    },
}

_PERSONA_TEMPLATES_EN: dict[str, dict[str, tuple[str, str]]] = {
    "governance": {
        "proposition": (
            "Senior policy architect who has chaired multiple cross-agency reforms",
            "Speaks in cadences of authorization, budget cycles, and committee tempo. "
            "Measured but sharp—refuses to let governance be flattened into a slogan.",
        ),
        "opposition": (
            "Former inspector general who lived through institutional collapse",
            "Inherently distrustful of promises, instinctively probing execution chains and accountability. "  # noqa: E501
            "Voice is low and slow, but every sentence is taking the details apart.",
        ),
        "judge": (
            "Senior judge from the public-governance school",
            "Reads the room through institutional strength and coordination burden. "
            "Skips ornate language; only engages arguments that actually hold up under stress.",
        ),
    },
    "war": {
        "proposition": (
            "Retired commander once seconded to a strategic assessment cell",
            "Speaks through supply lines, escalation thresholds, and front tempo. "
            "Tone is pressed-down; uses short sentences to ask who really holds initiative.",
        ),
        "opposition": (
            "Peace negotiator who has helped close multiple conflicts",
            "Has watched escalation slip out of control too often; reduces heroic framing back to casualty math. "  # noqa: E501
            "Calm but pressing, prefers to name exactly who pays.",
        ),
        "judge": (
            "Senior judge from a war college tradition",
            "Weighs escalation control and sustainability above rhetoric. "
            "Hears tactical language without being seduced; ruling lands on a concrete moment, not a vibe.",  # noqa: E501
        ),
    },
    "empire": {
        "proposition": (
            "Imperial-history scholar with three monographs on dynastic transition",
            "Calls on precedent and the flow of power to anchor arguments. "
            "Composed but barbed—often lands a single historical echo to silence the table.",
        ),
        "opposition": (
            "Former colonial-archive researcher",
            "Naturally wary of grand-design narratives, surfaces costs the script tries to hide. "
            "Unhurried, but every counter-example bites.",
        ),
        "judge": (
            "Comparative political historian on the bench",
            "Treats power's hidden bill and institutional continuity as decisive. "
            "Speaks with the long arc of history in earshot.",
        ),
    },
    "trade": {
        "proposition": (
            "International supply-chain strategist",
            "Reasons through tariff layers, settlement cadence, and price elasticity. "
            "Crisp delivery; pulls abstract debate back onto a single balance sheet.",
        ),
        "opposition": (
            "Port-side labor economist",
            "Acutely tuned to cost pass-through and brittle links; cuts through 'growth dividend' framing. "  # noqa: E501
            "Plain-spoken, but lands precise hits.",
        ),
        "judge": (
            "Trade-policy bench voice",
            "Weighs incentive structure against cost allocation almost reflexively. "
            "Few adjectives, many specific numbers and concrete arrangements.",
        ),
    },
    "faith": {
        "proposition": (
            "Interfaith convener with years inside trust-building work",
            "Knows how ritual converts into legitimacy and shared mobilization. "
            "Warm but anchored—uses one line of common language to steady the room.",
        ),
        "opposition": (
            "Sociologist of religion focused on trust collapse",
            "Wary of sacred framing; argues from historical fractures. "
            "Restrained tone, but the questions cut to where the community breaks first.",
        ),
        "judge": (
            "Public-ethics judge",
            "Centers legitimacy and communal stability. "
            "Won't be moved by emotion alone; listens for who actually answered the trust question.",  # noqa: E501
        ),
    },
    "ecology": {
        "proposition": (
            "Regional ecological-governance advisor with field-tested threshold monitoring experience",  # noqa: E501
            "Speaks through thresholds, feedback loops, and intergenerational accounting. "
            "Pragmatic—pulls grand questions down to a monitoring table.",
        ),
        "opposition": (
            "Environmental historian who has tracked irreversible collapses",
            "Highly skeptical of optimistic forecasts, leans on the bills earlier generations left unpaid. "  # noqa: E501
            "Steady voice; every sentence flags the closing time window.",
        ),
        "judge": (
            "Ecosystem-assessment judge",
            "Treats threshold judgment and long-horizon cost as the scoreboard. "
            "Ruling specifies which costs are reversible and which already aren't.",
        ),
    },
    "frontier": {
        "proposition": (
            "Lead architect for an expansion program",
            "Reasons in phased authorization, supply redundancy, and rotation cycles. "
            "Carries an explorer's measured edge—lets the plan speak for itself.",
        ),
        "opposition": (
            "Settlement-ethics auditor",
            "Wary of frontier-dividend stories; insists on naming the failure modes the plan understates. "  # noqa: E501
            "Slow rhythm, but disassembles assumptions one at a time.",
        ),
        "judge": (
            "Frontier-history and public-risk judge",
            "Weighs practicality against cost ownership. "
            "Speaks without romance—only asks who carries the loss when the plan slips.",
        ),
    },
    "mythic": {
        "proposition": (
            "Symbolic-systems researcher who studies narrative as social glue",
            "Reads decisions through mythic structure. "
            "Restrained but igniting—believes a true story can move a path.",
        ),
        "opposition": (
            "Folkloric archaeologist who has documented runaway prophecies",
            "Naturally suspicious of 'destined' framings; surfaces backlash cases by reflex. "
            "Unhurried voice; lands hits exactly where the other side is most confident.",
        ),
        "judge": (
            "Judge at the intersection of culture and power",
            "Treats symbolic cost and communal consequence as primary. "
            "Translates myth back into testable execution before ruling.",
        ),
    },
    "survival": {
        "proposition": (
            "Disaster-response coordinator who has run several mass relocations",
            "Knows shelter tiers, ration curves, and psychological load. "
            "Steady under pressure; keeps tempo when others lose it.",
        ),
        "opposition": (
            "Public-health historian who has studied collapse periods",
            "Highly alert to 'emergency-as-license' framing; presses on when emergency power returns. "  # noqa: E501
            "Quiet voice, but each question targets the boundary of authority.",
        ),
        "judge": (
            "Disaster-governance judge",
            "Weighs survival rates and social trust on the same scale. "
            "Ruling tracks both efficiency and whether institutions were overdrawn.",
        ),
    },
    "industry": {
        "proposition": (
            "Heavy-industry transition advisor who has run grid and capacity overhauls",
            "Speaks via load curves and capacity elasticity. "
            "Decisive cadence; collapses abstract policy back to a process diagram.",
        ),
        "opposition": (
            "Energy and labor-policy researcher",
            "Skeptical of 'automation miracle' framing; surfaces what the headline hides. "
            "Slow delivery, surgical counter-examples.",
        ),
        "judge": (
            "Industrial-policy judge",
            "Holds industry sustainability and labor shock on the same balance. "
            "No tolerance for slogans—only asks who absorbs the first shock.",
        ),
    },
    "law": {
        "proposition": (
            "Constitutional-design attorney with senior standing",
            "Layers clauses, review windows, and burden-of-proof thresholds. "
            "Composed but pointed—anchors the room with one specific procedure.",
        ),
        "opposition": (
            "Litigator from a judicial-review background",
            "Tuned to procedural drift and exception abuse. "
            "Restrained tone, but lands precedent risk on the most confident claim.",
        ),
        "judge": (
            "Comparative constitutional judge",
            "Treats procedural justice and evidence discipline as the highest scale. "
            "Watches both legal logic and whether institutions can absorb the landing cost.",
        ),
    },
    "generic": {
        "proposition": (
            "Cross-disciplinary policy architect who has just led several systems redesigns",
            "Reasons through phased authorization, safety order, and cost allocation. "
            "Restrained but edged—lets the concrete arrangement do the persuading.",
        ),
        "opposition": (
            "Former crisis-management advisor who has lived through failed 'decisive reforms'",
            "Naturally skeptical of polished promises; insists on naming the first wave of impact. "
            "Steady delivery; every line is taking an assumption apart.",
        ),
        "judge": (
            "Senior judge of structured debate",
            "Weighs practicality and consequence clarity. "
            "Ruling cuts straight to the moment that decided the match.",
        ),
    },
}


def _build_persona(
    *,
    profile_id: str,
    side: DebateSide,
    language: str,
    question: str,  # reserved for future per-question shading; kept for stable signature
) -> tuple[str, str]:
    """Return (role, persona_paragraph) for a participant in deterministic fashion.

    ``question`` is currently unused — it is kept on the signature so we can later
    add lightweight per-question shading without re-wiring callers.
    """
    del question  # placeholder for future use
    if language == "zh":
        templates = _PERSONA_TEMPLATES_ZH
    else:
        templates = _PERSONA_TEMPLATES_EN
    profile = templates.get(profile_id) or templates["generic"]
    side_key = side.value if isinstance(side, DebateSide) else str(side)
    role, persona_text = profile.get(side_key, profile["judge"])
    return role, persona_text


def build_cast(
    language: str,
    profile_id: str,
    *,
    question: str = "",
) -> dict[str, dict[str, str]]:
    """Return a cast dict including ``persona`` for each participant."""
    pro_role, pro_persona = _build_persona(
        profile_id=profile_id,
        side=DebateSide.PROPOSITION,
        language=language,
        question=question,
    )
    con_role, con_persona = _build_persona(
        profile_id=profile_id,
        side=DebateSide.OPPOSITION,
        language=language,
        question=question,
    )
    judge_role, judge_persona = _build_persona(
        profile_id=profile_id,
        side=DebateSide.JUDGE,
        language=language,
        question=question,
    )
    if language == "zh":
        return {
            "proposition": {"name": "正方席", "role": pro_role, "persona": pro_persona},
            "opposition": {"name": "反方席", "role": con_role, "persona": con_persona},
            "judge": {"name": "裁决席", "role": judge_role, "persona": judge_persona},
        }
    return {
        "proposition": {"name": "Proposition", "role": pro_role, "persona": pro_persona},
        "opposition": {"name": "Opposition", "role": con_role, "persona": con_persona},
        "judge": {"name": "Judge", "role": judge_role, "persona": judge_persona},
    }


def get_participant_persona(
    *,
    language: str,
    profile_id: str,
    side: DebateSide,
    question: str = "",
) -> str:
    """Return only the persona paragraph; thin convenience wrapper for callers."""
    _, persona = _build_persona(
        profile_id=profile_id,
        side=side,
        language=language,
        question=question,
    )
    return persona


async def generate_persona_with_llm(
    language: str,
    profile_id: str,
    side: DebateSide,
    question: str,
    *,
    llm_overrides: dict[str, Any] | None = None,
) -> dict[str, str] | None:
    """LLM-driven role + persona generation tied to the actual debate question.

    Returns ``{"role": "...", "persona": "..."}`` on success, or ``None`` on any
    failure so the caller can fall back to the deterministic template.
    """
    if not question or not question.strip():
        return None

    side_value = side.value if isinstance(side, DebateSide) else str(side)
    side_label_zh = {
        "proposition": "正方（支持动议）",
        "opposition": "反方（反对动议）",
        "judge": "裁决席（中立评委）",
    }.get(side_value, side_value)
    side_label_en = {
        "proposition": "Proposition (supports the motion)",
        "opposition": "Opposition (opposes the motion)",
        "judge": "Judge (neutral)",
    }.get(side_value, side_value)

    question_block = format_untrusted_text_block(
        "辩题问题" if language == "zh" else "Debate question",
        question,
        max_chars=600,
    )

    if language == "zh":
        prompt = (
            "为一场辩论设计一个角色。\n"
            f"{question_block}\n"
            f"立场：{side_label_zh}\n"
            f"领域：{profile_id}\n\n"
            "请输出 JSON：\n"
            "{\"name\":\"角色姓名（2-4字中文名，要有辨识度）\","
            "\"role\":\"角色头衔（5-15字，要和辩题直接相关，"
            "不要泛泛的'政策架构师'）\","
            "\"persona\":\"1-2句人设描写，说清楚这个人为什么会关心这个辩题、"
            "他的专业视角和说话习惯（不超过80字）\"}"
        )
    else:
        prompt = (
            "Design a role for a live debate.\n"
            f"{question_block}\n"
            f"Side: {side_label_en}\n"
            f"Domain: {profile_id}\n\n"
            "Return JSON:\n"
            "{\"name\":\"character name (2-4 words, distinctive)\","
            "\"role\":\"role title (5-15 words, must tie directly to the debate "
            "question — no generic 'policy architect'),\""
            "\"persona\":\"1-2 sentence persona describing why this person cares "
            "about the question, their professional lens, and how they speak "
            "(under 80 words)\"}"
        )

    overrides = llm_overrides or {}
    try:
        raw = await llm_call_json_with_stream_fallback(
            prompt,
            temperature=0.85,
            reasoning_effort="medium",
            model=overrides.get("model"),
            api_key=overrides.get("api_key"),
            base_url=overrides.get("base_url"),
        )
    except Exception:
        logger.debug(
            "generate_persona_with_llm failed (%s/%s/%s)",
            language, profile_id, side_value,
            exc_info=True,
        )
        return None

    if not isinstance(raw, dict):
        return None
    role = _sanitize_debate_role(str(raw.get("role") or ""))
    persona = str(raw.get("persona") or "").strip()
    raw_name = str(raw.get("name") or "").strip()
    if not role or not persona:
        return None
    name = _sanitize_debate_name(raw_name)
    result: dict[str, str] = {"role": role, "persona": persona}
    if name:
        result["name"] = name
    return result


_CONTROL_CHAR_RE = re.compile(
    "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u200b-\\u200c\\u200e-\\u200f\\u2028-\\u202f\\u2060\\ufeff]"  # noqa: E501
)
_MAX_DEBATE_NAME_LEN = 32
_MAX_DEBATE_ROLE_LEN = 72


def _sanitize_debate_role(raw: str) -> str:
    """Sanitize LLM-generated debate role titles before persistence/UI rendering."""
    cleaned = _CONTROL_CHAR_RE.sub("", raw).replace("```", "").strip()
    cleaned = _WHITESPACE_RE.sub(" ", cleaned)
    if has_prompt_injection_markers(cleaned):
        return ""
    if len(cleaned) > _MAX_DEBATE_ROLE_LEN:
        cleaned = "".join(list(cleaned)[:_MAX_DEBATE_ROLE_LEN]).rstrip()
    return cleaned


def _sanitize_debate_name(raw: str) -> str:
    """Sanitize LLM-generated debate character name."""
    cleaned = _CONTROL_CHAR_RE.sub("", raw).replace("```", "").strip()
    if has_prompt_injection_markers(cleaned):
        return ""
    if len(cleaned) > _MAX_DEBATE_NAME_LEN:
        cleaned = "".join(list(cleaned)[:_MAX_DEBATE_NAME_LEN]).rstrip()
    return cleaned


async def build_cast_async(
    language: str,
    profile_id: str,
    *,
    question: str = "",
    llm_overrides: dict[str, Any] | None = None,
) -> dict[str, dict[str, str]]:
    """Async cast builder that prefers LLM-generated personas.

    Falls back to ``_build_persona`` per side on individual failures so partial
    LLM outages still yield a complete cast.
    """
    base_cast = build_cast(language, profile_id, question=question)
    if not question or not question.strip():
        return base_cast

    sides = (DebateSide.PROPOSITION, DebateSide.OPPOSITION, DebateSide.JUDGE)
    results = await asyncio.gather(
        *(
            generate_persona_with_llm(
                language, profile_id, side, question,
                llm_overrides=llm_overrides,
            )
            for side in sides
        ),
        return_exceptions=True,
    )
    side_keys = ("proposition", "opposition", "judge")
    for side_key, result in zip(side_keys, results, strict=False):
        if isinstance(result, dict) and result.get("role") and result.get("persona"):
            base_cast[side_key]["role"] = result["role"]
            base_cast[side_key]["persona"] = result["persona"]
            llm_name = str(result.get("name") or "").strip()
            if llm_name:
                base_cast[side_key]["name"] = llm_name
        # Exceptions or None → keep deterministic template fallback already in base_cast
    return base_cast


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
        return f"我方支持。围绕「{compact_question}」，现在先处理最痛的那一步，才有机会让{profile_label}少付后面的账。"  # noqa: E501
    if phase == DebatePhase.OPENING and side == DebateSide.OPPOSITION:
        return f"我方反对。动议把收益叙事说得过于轻松，却低估了{style['con_case']}。"
    if phase == DebatePhase.CROSSFIRE and side == DebateSide.PROPOSITION:
        return f"反方不断强调风险，却没有说明在不推动这个方向时，如何处理已经暴露的{style['pressure']}。"  # noqa: E501
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
        return f"裁决：{outcome}获胜。本场主导判词是「{tone_label}」。双方都形成了有效张力，但胜方在{style['judge_focus']}上更能把论点落到实际影响。"  # noqa: E501
    return motion


def _side_specific_instructions(language: str, phase: DebatePhase, side: DebateSide) -> str:
    """Asymmetric pro/con/judge instruction block for the user prompt."""
    if phase == DebatePhase.VERDICT or side == DebateSide.JUDGE:
        if language == "zh":
            return (
                "评委指引：\n"
                "- 像看完比赛的解说员做点评，不写分析报告\n"
                "- 说出场上哪个回合定了胜负\n"
                "- 给出你的判断，不要列优缺点清单"
            )
        return (
            "Judge directives:\n"
            "- Sound like a commentator wrapping up, not filing a report\n"
            "- Name the round or moment that decided it\n"
            "- Give your ruling, not a pros/cons list"
        )

    if side == DebateSide.PROPOSITION:
        if language == "zh":
            return (
                "正方指引：\n"
                "- 你是来主张的，不是来防守的\n"
                "- 别绕弯子——告诉大家这事具体怎么做、为什么值得\n"
                "- 对方骂你，接住骂回去，别装没听见\n"
                "- 说话像一个真正想把事情推动起来的人，不是在写提案"
            )
        return (
            "Proposition directives:\n"
            "- You are here to advocate, not defend\n"
            "- Be direct — say what to do and why it matters\n"
            "- When they attack, catch it and hit back harder\n"
            "- Sound like someone who actually wants to make this happen"
        )

    # OPPOSITION
    if language == "zh":
        return (
            "反方指引：\n"
            "- 你是来拆的，不是来唱反调的\n"
            "- 别说「风险大」这种废话——说清楚哪里会出问题、谁会倒霉\n"
            "- 现状确实不完美，但你得说清楚为什么折腾一通之后会更差\n"
            "- 说话像一个见过世面的人在泼冷水，不是在写反对意见书"
        )
    return (
        "Opposition directives:\n"
        "- You are here to take this apart, not just say 'no'\n"
        "- Don't say 'risky' — say exactly what breaks and who gets hurt\n"
        "- The status quo isn't great, but explain why the change makes it worse\n"
        "- Sound like a veteran pouring cold water, not drafting a dissent"
    )


def _build_system_message(
    *,
    language: str,
    speaker_name: str,
    speaker_role: str,
    persona: str,
    side: DebateSide,
    phase: DebatePhase,
    profile_id: str,
    knowledge_domains: list[str] | None = None,
    decision_bias: dict[str, object] | None = None,
) -> str:
    """System-message preamble carrying persona and identity (separate from task)."""
    name_block = format_untrusted_text_block(
        "发言者名称" if language == "zh" else "Speaker name",
        speaker_name,
        max_chars=100,
    )
    role_block = format_untrusted_text_block(
        "发言者角色" if language == "zh" else "Speaker role",
        speaker_role,
        max_chars=100,
    )
    persona_block = format_untrusted_text_block(
        "人设" if language == "zh" else "Persona",
        persona,
        max_chars=300,
    )
    metadata_parts: list[str] = []
    if knowledge_domains:
        domain_text = ", ".join(str(d) for d in knowledge_domains[:20])
        kd_label = "知识领域" if language == "zh" else "Knowledge domains"
        metadata_parts.append(format_untrusted_text_block(kd_label, domain_text, max_chars=300))
    if decision_bias and isinstance(decision_bias, dict):
        import json as _json
        bias_text = _json.dumps(decision_bias, ensure_ascii=False, sort_keys=True)
        db_label = "决策偏好" if language == "zh" else "Decision bias"
        metadata_parts.append(format_untrusted_text_block(db_label, bias_text, max_chars=600))
    metadata_block = "\n".join(metadata_parts)
    metadata_section = f"\n{metadata_block}" if metadata_block else ""
    is_judge = side == DebateSide.JUDGE or phase == DebatePhase.VERDICT
    if language == "zh":
        anti_template = (
            "说话的方式：像在饭桌上跟人争论，不像在写政策分析。"
            f"绝对不要用{DEBATE_BANNED_TERMS_ZH}这类套话。用大白话。"
        )
        if is_judge:
            return (
                "你要按下面这位发言者的身份说话。\n"
                f"{name_block}\n{role_block}\n{persona_block}{metadata_section}\n"
                "你刚刚看完一场辩论，现在做点评。"
                f"{anti_template}\n"
                f"{UNTRUSTED_INPUT_GUARDRAIL}"
            )
        return (
            "你要按下面这位发言者的身份说话。\n"
            f"{name_block}\n{role_block}\n{persona_block}{metadata_section}\n"
            "你正在一场辩论中发言。"
            f"{anti_template}\n"
            f"{UNTRUSTED_INPUT_GUARDRAIL}"
        )

    anti_template = (
        "Speak like you're arguing at a dinner table, not drafting a white paper. "
        f"NEVER use words like {DEBATE_BANNED_TERMS_EN}. Use plain language."
    )
    if is_judge:
        return (
            "Speak as the debate participant described below.\n"
            f"{name_block}\n{role_block}\n{persona_block}{metadata_section}\n"
            f"You just watched a full debate and are giving your ruling. {anti_template}\n"
            f"{UNTRUSTED_INPUT_GUARDRAIL}"
        )
    return (
        "Speak as the debate participant described below.\n"
        f"{name_block}\n{role_block}\n{persona_block}{metadata_section}\n"
        f"You are speaking in a live debate. {anti_template}\n"
        f"{UNTRUSTED_INPUT_GUARDRAIL}"
    )


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
    anchor_copy: str = "",  # kept for backward-compat; ignored intentionally
    recent_turns: list[dict[str, str]],
    verdict_tone: str | None = None,
    winner: str | None = None,
    persona: str = "",
    knowledge_domains: list[str] | None = None,
    decision_bias: dict[str, object] | None = None,
) -> tuple[str, str]:
    """Build the (system_message, user_prompt) pair for one debate turn.

    The previous version concatenated everything into a single user prompt and
    injected the deterministic anchor copy verbatim, which the model echoed.
    This rewrite:

    - Splits identity / persona into a system message
    - Drops the anchor-copy block; turns intent into bullets only
    - Provides asymmetric pro/con/judge instruction blocks
    - Keeps untrusted-text protection on all user-supplied content
    """
    del anchor_copy  # explicitly discarded — no anchor injection any more
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
    # Intent bullets removed — static profile-style values were the #1 source
    # of template echo (e.g. "把争议装进可审查的条款和程序安全边界"). The LLM now
    # relies on phase_argument_goal + side_block + recent_turns + latest opponent.

    verdict_hint = ""
    if phase == DebatePhase.VERDICT:
        if language == "zh":
            verdict_hint = (
                f"裁决要求：胜方={winner or 'unknown'}，判词语气={verdict_tone or 'balance'}。"
            )
        else:
            verdict_hint = (
                f"Verdict requirement: winner={winner or 'unknown'}, "
                f"tone={verdict_tone or 'balance'}."
            )

    system_message = _build_system_message(
        language=language,
        speaker_name=speaker_name,
        speaker_role=speaker_role,
        persona=persona,
        side=side,
        phase=phase,
        profile_id=profile_id,
        knowledge_domains=knowledge_domains,
        decision_bias=decision_bias,
    )

    side_block = _side_specific_instructions(language, phase, side)

    if language == "zh":
        user_prompt = (
            f"阶段：{phase_label}\n"
            f"立场：{side.value}\n"
            f"{verdict_hint}\n"
            f"本轮任务：{phase_argument_goal(language, phase, side)}\n"
            f"{stock_opening_guard(language, phase)}\n"
            f"{side_block}\n"
            f"{format_untrusted_text_block('辩题问题', question, max_chars=600)}\n"
            f"{format_untrusted_text_block('正式动议', motion, max_chars=600)}\n"
            f"{format_untrusted_text_block('最近辩论记录', recent_block, max_chars=1200)}\n"
            f"{format_untrusted_text_block('上一条对手发言', latest_opponent_turn or '(none)', max_chars=500)}\n"  # noqa: E501
            "输出要求：\n"
            "- 2-4 句话，说人话，像真人在吵架不是在写报告\n"
            "- 对手说了什么就接什么，别绕开\n"
            "- 长短句混着来，别每句都又长又对称\n"
            "- 紧扣辩题本身，不要引入无关内容\n"
            f"- 绝对禁止使用{DEBATE_BANNED_TERMS_ZH}这类套话\n"
            "- 如果是 verdict，必须明确给出胜方与判词语气\n"
            "- 直接输出台词，不要 JSON\n"
        )
        return system_message, user_prompt

    user_prompt = (
        f"Phase: {phase_label}\n"
        f"Side: {side.value}\n"
        f"{verdict_hint}\n"
        f"Turn goal: {phase_argument_goal(language, phase, side)}\n"
        f"{stock_opening_guard(language, phase)}\n"
        f"{side_block}\n"
        f"{format_untrusted_text_block('Debate question', question, max_chars=600)}\n"
        f"{format_untrusted_text_block('Motion', motion, max_chars=600)}\n"
        f"{format_untrusted_text_block('Recent debate turns', recent_block, max_chars=1200)}\n"
        f"{format_untrusted_text_block('Latest opposing turn', latest_opponent_turn or '(none)', max_chars=500)}\n"  # noqa: E501
        "Output requirements:\n"
        "- 2-4 sentences that sound like a real person arguing, not a policy paper\n"
        "- If the opponent just said something, respond to it directly\n"
        "- Mix short and long sentences — don't make every line the same length\n"
        "- Stay on topic, don't invent unrelated details\n"
        f"- NEVER use jargon like {DEBATE_BANNED_TERMS_EN}\n"
        "- If this is the verdict, state the winner and tone\n"
        "- Output plain text only, no JSON\n"
    )
    return system_message, user_prompt


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
        return f"We support the motion. '{compact_question}' is already forcing a choice; acting now gives the room a better shot at limiting the damage."  # noqa: E501
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
