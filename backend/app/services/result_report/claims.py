"""Deterministic claim compilation over verified simulation coordinates."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict
from sqlalchemy.engine import Engine
from sqlmodel import Session, col, select

from app.models import Agent, AgentMessage, Branch, Round
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.services.branch_lineage import resolve_branch_lineage, select_branch_rounds
from app.services.result_report.schema import (
    AnalyticConfidence,
    Claim,
    EvidenceRef,
    I18nText,
    ReportSection,
)


class _EvidenceCoverage(BaseModel):
    """Validated report-evidence coverage; never persisted in ``FullReport``."""

    model_config = ConfigDict(extra="forbid")

    max_round: int
    covered_rounds: list[int]
    missing_rounds: list[int]
    covered_phases: list[str]
    missing_phases: list[str]


class ClaimCompilationResult(BaseModel):
    """Report fields that can replace untrusted generated prose atomically."""

    model_config = ConfigDict(extra="forbid")

    claims: list[Claim]
    sections: list[ReportSection]
    analytic_confidence: AnalyticConfidence
    verdict_headline: str
    summary_i18n: I18nText | None = None
    evidence_coverage: _EvidenceCoverage


class BranchNarrativeCompilationResult(BaseModel):
    """Claim-validated replacement for the legacy Branch narrative fields."""

    model_config = ConfigDict(extra="forbid")

    story: str
    insight: str
    key_moments: list[str]
    question_answer: str
    claims: list[Claim]
    claim_ids_by_field: dict[str, list[str]]
    analytic_confidence: AnalyticConfidence
    evidence_coverage: _EvidenceCoverage

    @property
    def narration(self) -> dict[str, str | list[str]]:
        """Return the unchanged legacy wire shape consumed by branch views."""

        return {
            "story": self.story,
            "insight": self.insight,
            "key_moments": list(self.key_moments),
            "question_answer": self.question_answer,
        }


@dataclass(frozen=True)
class _Source:
    evidence: EvidenceRef
    content: str
    agent_name: str
    agent_role: str
    runtime_placeholder: bool = False


_QUOTE_PATTERNS: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (re.compile(r"“([^”\n]{2,})”"), "“", "”"),
    (re.compile(r"‘([^’\n]{2,})’"), "‘", "’"),
    (re.compile(r"「([^」\n]{2,})」"), "「", "」"),
    (re.compile(r"『([^』\n]{2,})』"), "『", "』"),
    (re.compile(r"«([^»\n]{2,})»"), "«", "»"),
    (re.compile(r'"([^"\n]{2,})"'), '"', '"'),
    (re.compile(r"(?<!\w)'([^'\n]{2,})'(?!\w)"), "'", "'"),
)
_MARKDOWN_PROTECTED_RE = re.compile(
    r"```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+|\]\([^\n)]*\)"
)
_EVOLUTION_RE = re.compile(
    r"\b(?:"
    r"evol(?:ve|ved|ving|ution)|change(?:d|s|ing)?\s+over|"
    r"shift(?:ed|s|ing)?|became|become|grew|grown|transition(?:ed|s|ing)?|"
    r"moved?\s+from|develop(?:ed|s|ing)?|strengthen(?:ed|s|ing)?|"
    r"weaken(?:ed|s|ing)?|over\s+time|across\s+(?:the\s+)?rounds?|"
    r"initially.{0,80}(?:later|eventually)"
    r")\b|演化|演变|跨轮|转向|转变|逐步(?:变化|增强|减弱)|"
    r"从.{0,40}(?:到|转为|变为)|由.{0,60}(?:收窄|扩大|升级|演进|转变)为|"
    r"随着.{0,20}轮|后来|"
    r"早期.{0,20}中期.{0,20}后期",
    re.IGNORECASE,
)
_EVOLUTION_DIRECTION_PATTERNS = (
    re.compile(
        r"\bfrom\s+(?P<source>[^,.;:]{1,80}?)\s+to\s+"
        r"(?P<target>[^,.;:]{1,80})(?:[,.;:]|$)",
        re.IGNORECASE,
    ),
    re.compile(
        r"从(?P<source>[^，。；：]{1,40}?)(?:到|转为|变为)"
        r"(?P<target>[^，。；：]{1,40})(?:[，。；：]|$)",
    ),
    re.compile(
        r"由(?P<source>[^，。；：]{1,60}?)(?:收窄|扩大|升级|演进|转变)为"
        r"(?P<target>[^，。；：]{1,60})(?:[，。；：]|$)",
    ),
)
_NEUTRAL_ATTRIBUTION_RE = re.compile(
    r"\b(?:according\s+to|said|says|saying|stated?|states|noted?|notes|"
    r"reported?|reports|argued?|argues|wrote|writes)\b|表示|声称|称|说|指出|认为",
    re.IGNORECASE,
)
_COLLECTIVE_RE = re.compile(
    r"\b(unanimous(?:ly)?|consensus|all\s+(?:agents?|parties)|"
    r"every\s+stakeholder)\b"
    r"|全体|各方|所有(?:代理|参与者|利益相关者)|一致(?:支持|反对|同意)",
    re.IGNORECASE,
)
_JOINT_NAMED_CLAIM_RE = re.compile(
    r"\b(?:together(?:\s+with)?|jointly|in\s+concert|co[- ](?:authored|signed)|"
    r"collaborat(?:ed|ing|ively))\b|共同|联合|联手|协同|一起",
    re.IGNORECASE,
)
_ROLE_COVERAGE_RE = re.compile(
    r"\b(?:all|every|each)\s+(?:agents?|parties|participants?|stakeholders?|roles?|members?)\b"
    r"|全体|各方|所有(?:代理|参与者|利益相关者|角色|成员)",
    re.IGNORECASE,
)
_RUNTIME_PLACEHOLDER_RE = re.compile(
    r"^\s*[（(].*(?:重复输出(?:不可用|未发布)|输出(?:不可用|未发布)|"
    r"等待重新规划|沉默了|repetitive\s+output\s+(?:is\s+unavailable|"
    r"was\s+not\s+published)|output\s+(?:is\s+unavailable|was\s+not\s+published)|"
    r"awaiting\s+replanning|stays\s+silent).*[）)]\s*$|"
    r"__swarmoracle_metadata_unavailable__",
    re.IGNORECASE,
)
_RUNTIME_FAILURE_RE = re.compile(
    r"输出(?:中断|不可用|失败|重复|未发布)|重复输出|等待重新规划|沉默了|"
    r"\b(?:repetitive|repeated|interrupted|unavailable|failed)\s+output\b|"
    r"\boutput\s+(?:interruption|failure|unavailable)\b|"
    r"\b(?:repetitive\s+)?output\s+was\s+not\s+published\b|"
    r"\bawaiting\s+replanning\b|\bstays\s+silent\b",
    re.IGNORECASE,
)
_RUNTIME_PLACEHOLDER_REFERENCE_RE = re.compile(
    r"重复输出|等待重新规划|沉默了|repetitive\s+output|"
    r"awaiting\s+replanning|stays\s+silent",
    re.IGNORECASE,
)
_WORLD_STATE_INFERENCE_RE = re.compile(
    r"孤立|立场|态度|支持|反对|联盟|同盟|阵营|关系|信任|演化|演变|转向|转变|"
    r"\b(?:isolat(?:ed|ion)|stance|attitude|support|opposition|alliance|"
    r"coalition|faction|relationship|trust|evolution|shift|transition)\b",
    re.IGNORECASE,
)
_MARKDOWN_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}(?:\s+|$)")
_MARKDOWN_RULE_RE = re.compile(r"^\s*(?:-{3,}|_{3,}|\*{3,})\s*$")
_DISPLAY_DISCLAIMER_RE = re.compile(
    r"^(?:\*\*|__)?\s*(?:display\s+disclaimer|faction\s+chart\s+limitation|"
    r"展示(?:说明|免责声明)|显示(?:说明|免责声明)|阵营图限制)"
    r"(?:\s*[:：])(?:\*\*|__)?(?:\s|$)",
    re.IGNORECASE,
)
_EVIDENCE_REF_LABEL_RE = re.compile(
    r"^(?:\*\*|__)?\s*(?:evidence\s*ref(?:erence)?|ev[_-]?\d+|证据引用)\b",
    re.IGNORECASE,
)
_DISPLAY_HEADING_RE = re.compile(
    r"^(?:\*\*|__)?\s*(?:verbatim(?:\s+(?:evidence|anchor)|\s+锚定)?|"
    r"evidence(?:\s+references?)?|key\s+evidence|analysis|findings?|"
    r"conclusions?|逐字证据|证据(?:引用)?|分析|结论)"
    r"\s*[:：]?(?:\*\*|__)?\s*$",
    re.IGNORECASE,
)
_LIST_PREFIX_RE = re.compile(r"^\s*(?:[-+*]|\d{1,3}[.)])\s+")
_ORDINAL_PREFIX_RE = re.compile(
    r"^\s*(?:\(?\d{1,3}[.)、]|[一二三四五六七八九十]+[.)、])\s*"
)
_PURE_DISPLAY_ORDINAL_RE = re.compile(
    r"^(?:\*\*|__)?\s*(?:\(?\d{1,3}[.)、]|"
    r"[一二三四五六七八九十]+[.)、])\s*(?:\*\*|__)?$"
)
_CONTINUITY_RE = re.compile(
    r"\b(?:repeatedly|repeated|continues?|continued|continuing|again|"
    r"multiple\s+times|over\s+multiple\s+rounds)\b|"
    r"反复|持续|继续|再次|多次|逐轮|一再|不断",
    re.IGNORECASE,
)
_ROLE_ALIAS_RE = re.compile(
    r"\b(?:mayor|governor|director|commissioner|planner|advocate|driver|merchant|"
    r"shop\s+owner|business\s+owner|treasurer|controller)\b|"
    r"市长|区长|县长|局长|处长|主任|负责人|司机|商户|店主|老板|财政官员",
    re.IGNORECASE,
)
_ROUND_RANGE_PATTERNS = (
    re.compile(r"第?\s*(\d+)\s*[-—–至到]\s*(\d+)\s*轮"),
    re.compile(
        r"\brounds?\s*(\d+)\s*(?:[-—–]|to|through)\s*(\d+)\b",
        re.IGNORECASE,
    ),
)
_ROUND_SINGLE_PATTERNS = (
    re.compile(r"第\s*(\d+)\s*轮"),
    re.compile(r"\brounds?\s*(\d+)\b", re.IGNORECASE),
)
_CHINESE_ROUND_TOKEN = r"[零〇一二两三四五六七八九十百]+"
_CHINESE_ROUND_RANGE_RE = re.compile(
    rf"第?\s*({_CHINESE_ROUND_TOKEN})\s*[-—–至到]\s*"
    rf"({_CHINESE_ROUND_TOKEN})\s*轮"
)
_CHINESE_ROUND_LIST_RE = re.compile(
    rf"第\s*({_CHINESE_ROUND_TOKEN}(?:\s*[、，,]\s*"
    rf"{_CHINESE_ROUND_TOKEN})+)\s*轮"
)
_CHINESE_ROUND_SINGLE_RE = re.compile(rf"第\s*({_CHINESE_ROUND_TOKEN})\s*轮")
_NEGATIVE_RE = re.compile(
    r"\b(?:no|not|never|cannot|can't|unable|unavailable|unknown|uncertain|"
    r"undetermined|insufficient|missing|lack(?:ed|ing|s)?|against|opposition|"
    r"oppose[ds]?|reject(?:ed|s|ion)?|fail(?:ed|s)?|skeptic(?:al|ism)?)\b"
    r"|不支持|反对|拒绝|失败|没有|无法|不可|未公开|尚未|未能|不确定|未知|"
    r"缺少|不足|无证据",
    re.IGNORECASE,
)
_POSITIVE_RE = re.compile(
    r"\b(?:support(?:ed|s)?|approval|approve[ds]?|agree[ds]?|defensible|"
    r"viable|formed)\b"
    r"|支持|批准|同意|可行|形成",
    re.IGNORECASE,
)
_EN_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "by",
        "for",
        "from",
        "has",
        "have",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "said",
        "says",
        "that",
        "the",
        "their",
        "this",
        "to",
        "was",
        "were",
        "with",
    }
)


def _ordered_unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _unprotected_markdown_segments(text: str) -> Iterable[tuple[int, str]]:
    cursor = 0
    for match in _MARKDOWN_PROTECTED_RE.finditer(text):
        if match.start() > cursor:
            yield cursor, text[cursor : match.start()]
        cursor = match.end()
    if cursor < len(text):
        yield cursor, text[cursor:]


def _quote_spans(text: str) -> list[tuple[str, str, str]]:
    spans: list[tuple[int, str, str, str]] = []
    for offset, segment in _unprotected_markdown_segments(text):
        for pattern, opening, closing in _QUOTE_PATTERNS:
            spans.extend(
                (offset + match.start(), opening, match.group(1), closing)
                for match in pattern.finditer(segment)
            )
    return [(opening, quote, closing) for _, opening, quote, closing in sorted(spans)]


def _remove_quote_marks(text: str, quotes: Iterable[str]) -> str:
    unique_quotes = _ordered_unique(quotes)
    if not unique_quotes:
        return text
    parts: list[str] = []
    cursor = 0
    for match in _MARKDOWN_PROTECTED_RE.finditer(text):
        segment = text[cursor : match.start()]
        for quote in unique_quotes:
            for _, opening, closing in _QUOTE_PATTERNS:
                segment = segment.replace(f"{opening}{quote}{closing}", quote)
        parts.extend((segment, match.group(0)))
        cursor = match.end()
    segment = text[cursor:]
    for quote in unique_quotes:
        for _, opening, closing in _QUOTE_PATTERNS:
            segment = segment.replace(f"{opening}{quote}{closing}", quote)
    parts.append(segment)
    return "".join(parts)


def _literal_protection_mask(text: str) -> list[bool]:
    """Mark Markdown internals and literal quote spans as non-boundaries."""
    protected = [False] * len(text)
    for match in _MARKDOWN_PROTECTED_RE.finditer(text):
        protected[match.start() : match.end()] = [True] * (match.end() - match.start())
    for offset, segment in _unprotected_markdown_segments(text):
        for pattern, _opening, _closing in _QUOTE_PATTERNS:
            for match in pattern.finditer(segment):
                start, end = offset + match.start(), offset + match.end()
                protected[start:end] = [True] * (end - start)
    return protected


def _split_localized_statements(text: str) -> list[str]:
    protected = _literal_protection_mask(text)
    statements: list[str] = []
    start = 0

    def append(end: int, *, include_boundary: bool) -> None:
        nonlocal start
        candidate = text[start : end + (1 if include_boundary else 0)].strip()
        if candidate:
            statements.append(candidate)
        start = end + 1

    for index, character in enumerate(text):
        if protected[index]:
            continue
        if character in "\n；;":
            append(index, include_boundary=False)
            continue
        if character in "。！？":
            append(index, include_boundary=True)
            continue
        if (
            character == "."
            and _PURE_DISPLAY_ORDINAL_RE.fullmatch(text[start : index + 1].strip())
        ):
            continue
        if character in ".!?" and (
            index + 1 == len(text) or text[index + 1].isspace()
        ):
            append(index, include_boundary=True)
    tail = text[start:].strip()
    if tail:
        statements.append(tail)
    return statements


def _strip_outer_strong_emphasis(text: str) -> str:
    candidate = text.strip()
    for marker in ("**", "__"):
        if (
            candidate.startswith(marker)
            and candidate.endswith(marker)
            and len(candidate) > len(marker) * 2
        ):
            return candidate[len(marker) : -len(marker)].strip()
    return candidate


def _normalize_claim_statement(statement: str) -> str | None:
    """Remove report presentation scaffolding without deleting propositions."""

    candidate = statement.strip()
    fully_emphasized = any(
        candidate.startswith(marker)
        and candidate.endswith(marker)
        and len(candidate) > len(marker) * 2
        for marker in ("**", "__")
    )
    if not candidate or _MARKDOWN_HEADING_RE.match(candidate):
        return None
    if _MARKDOWN_RULE_RE.fullmatch(candidate) or _PURE_DISPLAY_ORDINAL_RE.fullmatch(
        candidate
    ):
        return None

    candidate = re.sub(r"^(?:>\s*)+", "", candidate).strip()
    candidate = _LIST_PREFIX_RE.sub("", candidate, count=1).strip()
    fully_emphasized = fully_emphasized or any(
        candidate.startswith(marker)
        and candidate.endswith(marker)
        and len(candidate) > len(marker) * 2
        for marker in ("**", "__")
    )
    if (
        not candidate
        or _DISPLAY_DISCLAIMER_RE.match(candidate)
        or _EVIDENCE_REF_LABEL_RE.match(candidate)
        or _DISPLAY_HEADING_RE.fullmatch(candidate)
    ):
        return None

    candidate = _strip_outer_strong_emphasis(candidate)
    candidate = _ORDINAL_PREFIX_RE.sub("", candidate, count=1).strip()
    candidate = _strip_outer_strong_emphasis(candidate)
    if candidate.endswith(("**", "__")) and not candidate.startswith(("**", "__")):
        candidate = candidate[:-2].strip()
    if (
        not candidate
        or _DISPLAY_DISCLAIMER_RE.match(candidate)
        or _EVIDENCE_REF_LABEL_RE.match(candidate)
        or _DISPLAY_HEADING_RE.fullmatch(candidate)
    ):
        return None
    if fully_emphasized and not re.search(r"[。！？.!?][\"'”’]?$", candidate):
        return None
    return candidate


def _statements(
    section: ReportSection,
    *,
    language: str | None,
) -> list[str]:
    statements: list[str] = []
    localized_bodies = (
        [getattr(section.body_md_i18n, language).strip()]
        if language in {"zh", "en"}
        else [
            section.body_md_i18n.en.strip(),
            section.body_md_i18n.zh.strip(),
        ]
    )
    for localized_body in localized_bodies:
        if not localized_body:
            continue
        statements.extend(
            normalized
            for statement in _split_localized_statements(localized_body)
            if (normalized := _normalize_claim_statement(statement)) is not None
        )
    return _ordered_unique(statements)


def _text_without_literal_quotes(text: str) -> str:
    protected = _literal_protection_mask(text)
    return "".join(" " if protected[index] else char for index, char in enumerate(text))


def _is_runtime_placeholder_message(text: str) -> bool:
    return bool(_RUNTIME_PLACEHOLDER_RE.search(str(text or "")))


def _is_runtime_failure_world_inference(text: str) -> bool:
    searchable = _text_without_literal_quotes(str(text or ""))
    return bool(
        _RUNTIME_FAILURE_RE.search(searchable)
        and _WORLD_STATE_INFERENCE_RE.search(searchable)
    )


def _runtime_failure_disclosure(*, language: str) -> str:
    if language == "zh":
        return (
            "该轮模拟输出不可用；运行故障不能证明任何 Agent 的立场、关系、"
            "孤立状态或演化。"
        )
    return (
        "The simulated output for this round is unavailable; a runtime failure "
        "cannot establish any agent stance, relationship, isolation, or evolution."
    )


def _sanitize_runtime_failure_inferences(text: str, *, language: str) -> str:
    """Replace runtime-failure-to-world-state leaps without erasing audit Claims."""

    safe = str(text or "")
    disclosure = _runtime_failure_disclosure(language=language)
    if disclosure in safe:
        return safe
    for statement in _split_localized_statements(safe):
        normalized = _normalize_claim_statement(statement)
        if normalized is None or not _is_runtime_failure_world_inference(normalized):
            continue
        safe = safe.replace(statement, disclosure, 1)
    return safe


def _named_agents(text: str, agents: Sequence[Agent]) -> list[Agent]:
    searchable = _text_without_literal_quotes(text)
    matches: list[tuple[int, int, Agent]] = []
    for agent in agents:
        name = agent.name.strip()
        if not name:
            continue
        pattern = (
            re.escape(name)
            if re.search(r"[\u3400-\u9fff]", name)
            else rf"(?<!\w){re.escape(name)}(?!\w)"
        )
        match = re.search(pattern, searchable, re.IGNORECASE)
        if match:
            matches.append((match.start(), -len(name), agent))

    role_alias_agents: dict[str, list[Agent]] = {}
    for agent in agents:
        role = agent.role.strip()
        aliases = [role] if len(role) >= 3 else []
        aliases.extend(match.group(0) for match in _ROLE_ALIAS_RE.finditer(role))
        for alias in _ordered_unique(alias.strip() for alias in aliases):
            role_alias_agents.setdefault(alias.casefold(), []).append(agent)
    for alias_key, alias_agents in role_alias_agents.items():
        if len({agent.id for agent in alias_agents}) != 1:
            continue
        agent = alias_agents[0]
        alias = alias_key
        pattern = (
            re.escape(alias)
            if re.search(r"[\u3400-\u9fff]", alias)
            else rf"(?<!\w){re.escape(alias)}(?!\w)"
        )
        match = re.search(pattern, searchable, re.IGNORECASE)
        if match:
            matches.append((match.start(), -len(alias), agent))

    ordered: list[Agent] = []
    seen: set[str] = set()
    for _position, _specificity, agent in sorted(
        matches,
        key=lambda item: (item[0], item[1], item[2].id),
    ):
        if agent.id in seen:
            continue
        seen.add(agent.id)
        ordered.append(agent)
    return ordered


def _named_agent(text: str, agents: Sequence[Agent]) -> Agent | None:
    matches = _named_agents(text, agents)
    return matches[0] if matches else None


def _is_joint_named_claim(text: str, named_agents: Sequence[Agent]) -> bool:
    """Require all named speakers only for an explicit joint proposition."""

    if len(named_agents) < 2:
        return False
    searchable = _text_without_literal_quotes(text)
    if _JOINT_NAMED_CLAIM_RE.search(searchable):
        return True
    for left, right in zip(named_agents, named_agents[1:], strict=False):
        connector = (
            rf"{re.escape(left.name.strip())}\s*"
            rf"(?:,?\s*(?:and|&|with)\s+|[、与和及])\s*"
            rf"{re.escape(right.name.strip())}"
        )
        if re.search(connector, searchable, re.IGNORECASE):
            return True
    return False


def _parse_chinese_number(token: str) -> int | None:
    digits = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    token = token.strip()
    if not token:
        return None
    if "百" in token:
        left, right = token.split("百", 1)
        hundreds = digits.get(left, 1 if not left else -1)
        if hundreds < 0:
            return None
        remainder = _parse_chinese_number(right) if right else 0
        return None if remainder is None else hundreds * 100 + remainder
    if "十" in token:
        left, right = token.split("十", 1)
        tens = digits.get(left, 1 if not left else -1)
        ones = digits.get(right, 0 if not right else -1)
        if tens < 0 or ones < 0:
            return None
        return tens * 10 + ones
    if all(character in digits for character in token):
        value = 0
        for character in token:
            value = value * 10 + digits[character]
        return value
    return None


def _explicit_round_references(
    text: str,
    *,
    max_round: int,
) -> tuple[list[int], bool]:
    numbers: set[int] = set()
    has_out_of_range = False

    def add_number(number: int) -> None:
        nonlocal has_out_of_range
        if 1 <= number <= max_round:
            numbers.add(number)
        else:
            has_out_of_range = True

    def add_range(start: int, end: int) -> None:
        nonlocal has_out_of_range
        lower, upper = sorted((start, end))
        if lower < 1 or upper > max_round:
            has_out_of_range = True
        numbers.update(range(max(1, lower), min(max_round, upper) + 1))

    for pattern in _ROUND_RANGE_PATTERNS:
        for match in pattern.finditer(text):
            start, end = int(match.group(1)), int(match.group(2))
            add_range(start, end)
    for match in _CHINESE_ROUND_RANGE_RE.finditer(text):
        start = _parse_chinese_number(match.group(1))
        end = _parse_chinese_number(match.group(2))
        if start is not None and end is not None:
            add_range(start, end)
    for pattern in _ROUND_SINGLE_PATTERNS:
        for match in pattern.finditer(text):
            add_number(int(match.group(1)))
    for match in _CHINESE_ROUND_LIST_RE.finditer(text):
        for token in re.split(r"\s*[、，,]\s*", match.group(1)):
            number = _parse_chinese_number(token)
            if number is not None:
                add_number(number)
    for match in _CHINESE_ROUND_SINGLE_RE.finditer(text):
        number = _parse_chinese_number(match.group(1))
        if number is not None:
            add_number(number)
    return sorted(numbers), has_out_of_range


def _explicit_round_numbers(text: str, *, max_round: int) -> list[int]:
    return _explicit_round_references(text, max_round=max_round)[0]


def _terms(text: str) -> set[str]:
    terms: set[str] = set()
    for token in re.findall(r"[a-z0-9][a-z0-9_-]+", text.lower()):
        if token not in _EN_STOPWORDS:
            terms.add(token)
            if len(token) > 5 and token.endswith("ed"):
                terms.add(token[:-2])
            elif len(token) > 6 and token.endswith("ing"):
                terms.add(token[:-3])
            elif len(token) > 4 and token.endswith("s"):
                terms.add(token[:-1])
    for run in re.findall(r"[\u3400-\u9fff]{2,}", text):
        terms.update(run[index : index + 2] for index in range(len(run) - 1))
    return terms


def _stance_semantically_consistent(
    statement: str,
    source_texts: Iterable[str],
) -> bool:
    source_text = "\n".join(source_texts)
    statement_negative = bool(_NEGATIVE_RE.search(statement))
    source_negative = bool(_NEGATIVE_RE.search(source_text))
    statement_positive = bool(_POSITIVE_RE.search(statement))
    source_positive = bool(_POSITIVE_RE.search(source_text))
    return not (
        (statement_negative and source_positive and not source_negative)
        or (statement_positive and source_negative and not source_positive)
    )


def _semantically_supported(statement: str, source_texts: Iterable[str]) -> bool:
    source_texts = list(source_texts)
    source_text = "\n".join(source_texts)
    statement_terms = _terms(statement)
    source_terms = _terms(source_text)
    overlap = statement_terms & source_terms
    required = 1 if len(statement_terms) <= 3 else 2
    lexical_support = len(overlap) >= required and len(overlap) / max(
        len(statement_terms), 1
    ) >= 0.3
    if not lexical_support:
        return False
    return _stance_semantically_consistent(statement, source_texts)


def _outer_semantically_supported(
    statement: str,
    *,
    quoted_candidates: Sequence[str],
    named_agent: Agent | None,
    source_texts: Sequence[str],
) -> bool:
    outer = statement
    for candidate in quoted_candidates:
        for _, opening, closing in _QUOTE_PATTERNS:
            outer = outer.replace(f"{opening}{candidate}{closing}", " ")
    if named_agent is not None and named_agent.name.strip():
        outer = re.sub(
            re.escape(named_agent.name.strip()),
            " ",
            outer,
            flags=re.IGNORECASE,
        )
    outer = _NEUTRAL_ATTRIBUTION_RE.sub(" ", outer)
    outer = _CONTINUITY_RE.sub(" ", outer)
    for pattern in (*_ROUND_RANGE_PATTERNS, *_ROUND_SINGLE_PATTERNS):
        outer = pattern.sub(" ", outer)
    if not _terms(outer):
        return True
    return _semantically_supported(outer, source_texts)


def _evolution_direction(statement: str) -> tuple[str, str] | None:
    for pattern in _EVOLUTION_DIRECTION_PATTERNS:
        match = pattern.search(statement)
        if match:
            return (
                match.group("source").strip(),
                match.group("target").strip(),
            )
    return None


def _polarity(text: str) -> int:
    positive = bool(_POSITIVE_RE.search(text))
    negative = bool(_NEGATIVE_RE.search(text))
    if positive == negative:
        return 0
    return 1 if positive else -1


def _endpoint_matches_sources(
    endpoint: str,
    sources: Sequence[_Source],
    actions_by_message: dict[str, list[SimulationAction]],
) -> bool:
    source_texts = _source_texts(sources, actions_by_message)
    if _semantically_supported(endpoint, source_texts):
        return True
    endpoint_polarity = _polarity(endpoint)
    source_polarity = _polarity("\n".join(source_texts))
    return endpoint_polarity != 0 and endpoint_polarity == source_polarity


def _has_reversed_evolution_direction(
    statement: str,
    sources: Sequence[_Source],
    actions_by_message: dict[str, list[SimulationAction]],
) -> bool:
    direction = _evolution_direction(statement)
    round_numbers = sorted({source.evidence.round_number for source in sources})
    if direction is None or len(round_numbers) < 2:
        return False
    source_endpoint, target_endpoint = direction
    earliest = [
        source
        for source in sources
        if source.evidence.round_number == round_numbers[0]
    ]
    latest = [
        source
        for source in sources
        if source.evidence.round_number == round_numbers[-1]
    ]
    forward = _endpoint_matches_sources(
        source_endpoint,
        earliest,
        actions_by_message,
    ) and _endpoint_matches_sources(
        target_endpoint,
        latest,
        actions_by_message,
    )
    reverse = _endpoint_matches_sources(
        target_endpoint,
        earliest,
        actions_by_message,
    ) and _endpoint_matches_sources(
        source_endpoint,
        latest,
        actions_by_message,
    )
    return reverse and not forward


def _temporal_coverage(round_numbers: Sequence[int], max_round: int) -> list[str]:
    if max_round <= 0:
        return []
    first_boundary = max(1, max_round // 3)
    second_boundary = max(first_boundary, (2 * max_round + 2) // 3)
    phases: list[str] = []
    if any(round_number <= first_boundary for round_number in round_numbers):
        phases.append("early")
    if any(
        first_boundary < round_number <= second_boundary
        for round_number in round_numbers
    ):
        phases.append("middle")
    if any(round_number > second_boundary for round_number in round_numbers):
        phases.append("late")
    return phases


_COVERAGE_PHASES = ("early", "middle", "late")
_COVERAGE_PHASE_ZH = {
    "early": "早期",
    "middle": "中期",
    "late": "后期",
}
_COVERAGE_NOTICE_ZH_PREFIX = "证据坐标缺口（不等于这些轮次未发生事件）："
_COVERAGE_NOTICE_EN_PREFIX = (
    "Evidence-coordinate gaps (this does not mean those rounds did not occur):"
)
_SUMMARY_SAFETY_PREFIX_ZH = "证据有限的假设："
_SUMMARY_SAFETY_PREFIX_EN = "Evidence-limited hypothesis:"


def _evidence_coverage_from_rounds(
    round_numbers: Iterable[int],
    *,
    max_round: int,
) -> _EvidenceCoverage:
    bounded_max_round = max(0, int(max_round))
    covered_rounds = sorted(
        {
            int(round_number)
            for round_number in round_numbers
            if 1 <= int(round_number) <= bounded_max_round
        }
    )
    expected_rounds = list(range(1, bounded_max_round + 1))
    covered_round_set = set(covered_rounds)
    covered_phases = _temporal_coverage(covered_rounds, bounded_max_round)
    expected_phases = _temporal_coverage(expected_rounds, bounded_max_round)
    return _EvidenceCoverage(
        max_round=bounded_max_round,
        covered_rounds=covered_rounds,
        missing_rounds=[
            round_number
            for round_number in expected_rounds
            if round_number not in covered_round_set
        ],
        covered_phases=covered_phases,
        missing_phases=[
            phase for phase in _COVERAGE_PHASES
            if phase in expected_phases and phase not in covered_phases
        ],
    )


def _compact_round_ranges(round_numbers: Sequence[int], *, separator: str) -> str:
    ordered = sorted(set(round_numbers))
    if not ordered:
        return ""
    ranges: list[str] = []
    range_start = ordered[0]
    range_end = ordered[0]
    for round_number in ordered[1:]:
        if round_number == range_end + 1:
            range_end = round_number
            continue
        ranges.append(
            str(range_start)
            if range_start == range_end
            else f"{range_start}–{range_end}"
        )
        range_start = range_end = round_number
    ranges.append(
        str(range_start)
        if range_start == range_end
        else f"{range_start}–{range_end}"
    )
    return separator.join(ranges)


def _strip_coverage_notice_text(text: str, *, language: str) -> str:
    value = str(text or "").strip()
    notice_prefix = (
        _COVERAGE_NOTICE_ZH_PREFIX
        if language == "zh"
        else _COVERAGE_NOTICE_EN_PREFIX
    )
    terminator = "。" if language == "zh" else "."
    notice_index = value.find(notice_prefix)
    if notice_index < 0:
        return value
    end_index = value.find(terminator, notice_index + len(notice_prefix))
    before = value[:notice_index].rstrip()
    after = value[end_index + len(terminator):].lstrip() if end_index >= 0 else ""
    separator = "" if language == "zh" else " "
    value = f"{before}{separator if before and after else ''}{after}".strip()
    return value


def _strip_evidence_coverage_notice(summary_i18n: I18nText) -> I18nText:
    return I18nText(
        zh=_strip_coverage_notice_text(summary_i18n.zh, language="zh"),
        en=_strip_coverage_notice_text(summary_i18n.en, language="en"),
    )


def _coverage_notice(coverage: _EvidenceCoverage, *, language: str) -> str:
    if not coverage.missing_rounds and not coverage.missing_phases:
        return ""
    if language == "zh":
        details: list[str] = []
        if coverage.missing_phases:
            details.append(
                "阶段="
                + "、".join(
                    _COVERAGE_PHASE_ZH[phase]
                    for phase in coverage.missing_phases
                )
            )
        if coverage.missing_rounds:
            details.append(
                "轮次="
                + _compact_round_ranges(coverage.missing_rounds, separator="、")
            )
        return f"{_COVERAGE_NOTICE_ZH_PREFIX}{'；'.join(details)}。"
    details = []
    if coverage.missing_phases:
        details.append("phases=" + ", ".join(coverage.missing_phases))
    if coverage.missing_rounds:
        details.append(
            "rounds="
            + _compact_round_ranges(coverage.missing_rounds, separator=", ")
        )
    return f"{_COVERAGE_NOTICE_EN_PREFIX} {'; '.join(details)}."


def _prepend_coverage_notice_text(
    text: str,
    notice: str,
    *,
    language: str,
) -> str:
    value = _strip_coverage_notice_text(text, language=language)
    if not notice:
        return value
    safety_prefix = (
        _SUMMARY_SAFETY_PREFIX_ZH
        if language == "zh"
        else _SUMMARY_SAFETY_PREFIX_EN
    )
    if value.startswith(safety_prefix):
        remainder = value[len(safety_prefix):].lstrip()
        separator = "" if language == "zh" else " "
        suffix = f" {remainder}" if remainder else ""
        return f"{safety_prefix}{separator}{notice}{suffix}"
    return f"{notice} {value}".strip()


def _with_evidence_coverage_notice(
    summary_i18n: I18nText,
    coverage: _EvidenceCoverage,
    *,
    prepend: bool = False,
) -> I18nText:
    stripped = _strip_evidence_coverage_notice(summary_i18n)
    zh_notice = _coverage_notice(coverage, language="zh")
    en_notice = _coverage_notice(coverage, language="en")
    if not prepend:
        return I18nText(
            zh=f"{stripped.zh} {zh_notice}".strip() if zh_notice else stripped.zh,
            en=f"{stripped.en} {en_notice}".strip() if en_notice else stripped.en,
        )
    return I18nText(
        zh=_prepend_coverage_notice_text(
            stripped.zh,
            zh_notice,
            language="zh",
        ),
        en=_prepend_coverage_notice_text(
            stripped.en,
            en_notice,
            language="en",
        ),
    )


def _claim_type(statement: str, *, is_verdict: bool) -> str:
    if is_verdict:
        return "verdict"
    semantic_wrapper = _text_without_literal_quotes(statement)
    if _EVOLUTION_RE.search(semantic_wrapper):
        return "evolution"
    if _COLLECTIVE_RE.search(semantic_wrapper):
        return "collective"
    if _quote_spans(statement):
        return "quote"
    return "assertion"


def _validated_sources(
    session: Session,
    scenario_id: str,
    evidence: Sequence[EvidenceRef],
) -> dict[str, _Source]:
    valid: dict[str, _Source] = {}
    for item in evidence:
        message = session.get(AgentMessage, item.message_id)
        round_row = session.get(Round, item.round_id)
        agent = session.get(Agent, item.agent_id)
        branch = session.get(Branch, item.branch_id)
        if not message or not round_row or not agent or not branch:
            continue
        if (
            branch.scenario_id != scenario_id
            or agent.scenario_id != scenario_id
            or round_row.branch_id != branch.id
            or round_row.round_number != item.round_number
            or message.round_id != round_row.id
            or message.agent_id != agent.id
            or agent.name != item.agent_name
        ):
            continue
        valid[item.id] = _Source(
            evidence=item,
            content=message.content,
            agent_name=agent.name,
            agent_role=agent.role.strip(),
            runtime_placeholder=_is_runtime_placeholder_message(message.content),
        )
    return valid


def _validated_actions(
    session: Session,
    scenario_id: str,
    sources: Iterable[_Source],
) -> dict[str, list[SimulationAction]]:
    sources_by_message = {
        source.evidence.message_id: source for source in sources
    }
    if not sources_by_message:
        return {}
    actions = session.exec(
        select(SimulationAction)
        .where(SimulationAction.scenario_id == scenario_id)
        .where(col(SimulationAction.message_id).in_(list(sources_by_message)))
    ).all()
    valid: dict[str, list[SimulationAction]] = {}
    for action in actions:
        source = sources_by_message.get(action.message_id or "")
        if source is None or action.status != SimulationActionStatus.VERIFIED:
            continue
        if action.action_type == SimulationActionType.IDLE:
            continue
        coordinate = source.evidence
        if (
            action.branch_id != coordinate.branch_id
            or action.round_id != coordinate.round_id
            or action.round_number != coordinate.round_number
            or action.agent_id != coordinate.agent_id
        ):
            continue
        valid.setdefault(coordinate.message_id, []).append(action)
    for message_actions in valid.values():
        message_actions.sort(key=lambda action: (action.sequence, action.id))
    return valid


def _source_texts(
    sources: Sequence[_Source],
    actions_by_message: dict[str, list[SimulationAction]],
) -> list[str]:
    texts = [source.content for source in sources if not source.runtime_placeholder]
    for source in sources:
        if source.runtime_placeholder:
            continue
        for action in actions_by_message.get(source.evidence.message_id, []):
            action_type = action.action_type
            texts.append(action_type.value if hasattr(action_type, "value") else str(action_type))
            if action.content:
                texts.append(action.content)
    return texts


def _compile_claim(
    *,
    claim_id: str,
    statement: str,
    branch_id: str,
    max_round: int,
    sources: Sequence[_Source],
    actions_by_message: dict[str, list[SimulationAction]],
    agents: Sequence[Agent],
    roster_agent_ids: set[str],
    is_verdict: bool,
) -> tuple[Claim, list[str]]:
    substantive_sources = [source for source in sources if not source.runtime_placeholder]
    placeholder_sources = [source for source in sources if source.runtime_placeholder]
    named_agents = _named_agents(statement, agents)
    named_agent = named_agents[0] if named_agents else None
    named_agent_ids = {agent.id for agent in named_agents}
    placeholder_agent_ids = {
        source.evidence.agent_id for source in placeholder_sources
    }
    runtime_failure_inference = (
        bool(placeholder_sources)
        and _is_runtime_failure_world_inference(statement)
        and (
            bool(named_agent_ids & placeholder_agent_ids)
            or bool(_RUNTIME_PLACEHOLDER_REFERENCE_RE.search(statement))
        )
    )
    joint_named_claim = _is_joint_named_claim(statement, named_agents)
    required_named_agent_ids = (
        named_agent_ids
        if joint_named_claim
        else ({named_agent.id} if named_agent is not None else set())
    )
    source_agent_ids = _ordered_unique(
        source.evidence.agent_id for source in substantive_sources
    )
    resolved_agent_id = named_agent.id if named_agent else None
    resolved_speaker = named_agent.name if named_agent else None
    if named_agent is None and len(source_agent_ids) == 1 and substantive_sources:
        resolved_agent_id = source_agent_ids[0]
        resolved_speaker = substantive_sources[0].agent_name

    exact_quote: str | None = None
    quote_failure: str | None = None
    unsafe_quotes: list[str] = []
    quoted_candidates = [candidate for _, candidate, _ in _quote_spans(statement)]
    for candidate in quoted_candidates:
        matching = [
            source
            for source in substantive_sources
            if candidate in source.content
        ]
        if named_agent is not None:
            matching_speaker = [
                source
                for source in matching
                if source.evidence.agent_id == named_agent.id
            ]
            if matching_speaker and exact_quote is None:
                exact_quote = candidate
            elif matching:
                quote_failure = "speaker_mismatch"
                unsafe_quotes.append(candidate)
            else:
                quote_failure = quote_failure or "unsupported_by_evidence"
                unsafe_quotes.append(candidate)
        else:
            matching_agents = {source.evidence.agent_id for source in matching}
            if len(matching_agents) == 1 and exact_quote is None:
                source = matching[0]
                exact_quote = candidate
                resolved_agent_id = source.evidence.agent_id
                resolved_speaker = source.agent_name
            else:
                quote_failure = quote_failure or "unsupported_by_evidence"
                unsafe_quotes.append(candidate)

    # A statement containing mixed valid/invalid quotations is not safe to
    # present as a literal quote claim. Remove every quote mark in that
    # statement so no unaudited quotation survives behind one valid span.
    if quote_failure is not None:
        unsafe_quotes = _ordered_unique([*unsafe_quotes, *quoted_candidates])

    relevant_sources = list(substantive_sources)
    relevant_agent_ids = (
        named_agent_ids if joint_named_claim else required_named_agent_ids
    )
    if relevant_agent_ids:
        relevant_sources = [
            source
            for source in substantive_sources
            if source.evidence.agent_id in relevant_agent_ids
        ]
    speaker_coverage = required_named_agent_ids.issubset(
        {source.evidence.agent_id for source in relevant_sources}
    )
    relevant_source_texts = _source_texts(relevant_sources, actions_by_message)
    semantic_support = _semantically_supported(statement, relevant_source_texts)
    stance_consistent = _stance_semantically_consistent(
        statement,
        relevant_source_texts,
    )
    outer_semantic_support = _outer_semantically_supported(
        statement,
        quoted_candidates=quoted_candidates,
        named_agent=named_agent,
        source_texts=relevant_source_texts,
    )
    if exact_quote is not None:
        strength = (
            "strong"
            if quote_failure is None
            and stance_consistent
            and outer_semantic_support
            and speaker_coverage
            else "unsupported"
        )
    elif semantic_support and quote_failure is None and speaker_coverage:
        strength = "moderate"
    else:
        strength = "unsupported"
    if runtime_failure_inference:
        strength = "unsupported"

    explicit_rounds, has_out_of_range_round = _explicit_round_references(
        statement,
        max_round=max_round,
    )
    continuity_claim = bool(_CONTINUITY_RE.search(statement))
    coordinate_sources = list(relevant_sources)
    if runtime_failure_inference:
        coordinate_sources = list({
            source.evidence.id: source
            for source in [*coordinate_sources, *placeholder_sources]
        }.values())
    if exact_quote is not None and quote_failure is None:
        coordinate_sources = [
            source
            for source in relevant_sources
            if source.evidence.agent_id == resolved_agent_id
            and exact_quote in source.content
        ]
        if explicit_rounds:
            coordinate_sources = list({
                source.evidence.id: source
                for source in [
                    *coordinate_sources,
                    *(
                        source
                        for source in relevant_sources
                        if source.evidence.round_number in explicit_rounds
                    ),
                ]
            }.values())
        if continuity_claim:
            coordinate_sources = list({
                source.evidence.id: source
                for source in [
                    *coordinate_sources,
                    *(
                        source
                        for source in relevant_sources
                        if resolved_agent_id is None
                        or source.evidence.agent_id == resolved_agent_id
                    ),
                ]
            }.values())
    if runtime_failure_inference and placeholder_sources:
        coordinate_sources = list({
            source.evidence.id: source
            for source in [*coordinate_sources, *placeholder_sources]
        }.values())
    if not coordinate_sources:
        coordinate_sources = list(sources)
    message_ids = _ordered_unique(
        source.evidence.message_id for source in coordinate_sources
    )
    round_numbers = sorted(
        {source.evidence.round_number for source in coordinate_sources}
    )
    supporting_sources = [
        source for source in coordinate_sources if not source.runtime_placeholder
    ]
    supporting_round_numbers = sorted(
        {source.evidence.round_number for source in supporting_sources}
    )
    temporal_coverage = _temporal_coverage(supporting_round_numbers, max_round)
    role_coverage = _ordered_unique(
        source.agent_role for source in supporting_sources
    )
    claim_type = _claim_type(statement, is_verdict=is_verdict)
    covered_agent_ids = {
        source.evidence.agent_id for source in supporting_sources
    }
    reversed_evolution_direction = _has_reversed_evolution_direction(
        statement,
        relevant_sources,
        actions_by_message,
    )

    downgrade_reason: str | None = None
    if runtime_failure_inference:
        downgrade_reason = "runtime_placeholder_not_evidence"
    elif quote_failure == "speaker_mismatch":
        downgrade_reason = "speaker_mismatch"
    elif exact_quote is not None and not stance_consistent:
        downgrade_reason = "stance_semantic_mismatch"
    elif not speaker_coverage:
        downgrade_reason = "insufficient_speaker_coverage"
    elif (
        claim_type == "collective" or _ROLE_COVERAGE_RE.search(statement)
    ) and not roster_agent_ids.issubset(covered_agent_ids):
        downgrade_reason = "insufficient_roster_coverage"
    elif continuity_claim and len(set(supporting_round_numbers)) < 2:
        downgrade_reason = "insufficient_temporal_coverage"
    elif exact_quote is not None and not outer_semantic_support:
        downgrade_reason = "outer_semantic_mismatch"
    elif has_out_of_range_round or (
        explicit_rounds
        and not set(explicit_rounds).issubset(set(supporting_round_numbers))
    ):
        downgrade_reason = "insufficient_temporal_coverage"
    elif claim_type == "evolution" and reversed_evolution_direction:
        downgrade_reason = "temporal_direction_mismatch"
    elif claim_type == "evolution" and set(temporal_coverage) != {
        "early",
        "middle",
        "late",
    }:
        downgrade_reason = "insufficient_temporal_coverage"
    elif strength == "unsupported":
        downgrade_reason = "unsupported_by_evidence"

    missing_evolution_phases = claim_type == "evolution" and set(
        temporal_coverage
    ) != {"early", "middle", "late"}
    if missing_evolution_phases and (
        downgrade_reason is None or "temporal" not in downgrade_reason
    ):
        downgrade_reason = (
            "insufficient_temporal_coverage"
            if downgrade_reason is None
            else f"insufficient_temporal_coverage+{downgrade_reason}"
        )

    confidence = "low" if downgrade_reason else (
        "high" if strength == "strong" else "medium"
    )
    action_ids: list[str] = []
    if resolved_agent_id is not None:
        action_ids = _ordered_unique(
            action.id
            for source in supporting_sources
            if source.evidence.agent_id == resolved_agent_id
            for action in actions_by_message.get(source.evidence.message_id, [])
        )
    safe_statement = _remove_quote_marks(statement, unsafe_quotes)
    claim = Claim(
        claim_id=claim_id,
        claim_text=safe_statement,
        claim_type=claim_type,
        speaker=resolved_speaker,
        agent_id=resolved_agent_id,
        message_ids=message_ids,
        action_ids=action_ids,
        branch_id=branch_id,
        round_numbers=round_numbers,
        exact_quote=exact_quote if quote_failure is None else None,
        evidence_strength=strength,
        temporal_coverage=temporal_coverage,
        role_coverage=role_coverage,
        confidence=confidence,
        downgrade_reason=downgrade_reason,
    )
    return claim, unsafe_quotes


def _safe_section(
    section: ReportSection,
    *,
    claims: Sequence[Claim],
    unsafe_quotes: Iterable[str],
) -> ReportSection:
    zh = _remove_quote_marks(section.body_md_i18n.zh, unsafe_quotes)
    en = _remove_quote_marks(section.body_md_i18n.en, unsafe_quotes)
    has_runtime_placeholder_downgrade = any(
        "runtime_placeholder_not_evidence" in (claim.downgrade_reason or "")
        for claim in claims
    )
    if has_runtime_placeholder_downgrade:
        zh = _sanitize_runtime_failure_inferences(zh, language="zh")
        en = _sanitize_runtime_failure_inferences(en, language="en")
    reasons = {claim.downgrade_reason for claim in claims if claim.downgrade_reason}
    if reasons:
        if "speaker_mismatch" in reasons:
            zh_prefix, en_prefix = "**归因未经验证：** ", "**Unverified attribution:** "
        else:
            zh_prefix = "**证据有限的假设：** "
            en_prefix = "**Evidence-limited hypothesis:** "
        if not zh.startswith(zh_prefix):
            zh = f"{zh_prefix}{zh}"
        if not en.startswith(en_prefix):
            en = f"{en_prefix}{en}"
    return section.model_copy(
        update={"body_md_i18n": I18nText(zh=zh, en=en)},
        deep=True,
    )


def _safe_summary(
    summary_i18n: I18nText,
    *,
    claims: Sequence[Claim],
    unsafe_quotes: Iterable[str],
) -> I18nText:
    zh = _remove_quote_marks(summary_i18n.zh, unsafe_quotes)
    en = _remove_quote_marks(summary_i18n.en, unsafe_quotes)
    has_runtime_placeholder_downgrade = any(
        "runtime_placeholder_not_evidence" in (claim.downgrade_reason or "")
        for claim in claims
    )
    if has_runtime_placeholder_downgrade:
        zh = _sanitize_runtime_failure_inferences(zh, language="zh")
        en = _sanitize_runtime_failure_inferences(en, language="en")
    if any(claim.downgrade_reason for claim in claims):
        zh_prefix = "证据有限的假设："
        en_prefix = "Evidence-limited hypothesis:"
        if not zh.startswith(zh_prefix):
            zh = f"{zh_prefix}{zh}"
        if not en.startswith(en_prefix):
            en = f"{en_prefix} {en}"
    return I18nText(zh=zh, en=en)


def _evidence_limited_hypothesis_text(
    text: str,
    *,
    language: str | None,
) -> str:
    stripped = text.strip()
    prefix_check = stripped.lstrip("*_ ").casefold()
    if prefix_check.startswith(
        ("evidence-limited hypothesis:", "证据有限的假设：")
    ):
        return stripped
    use_chinese = language == "zh" or (
        language != "en" and bool(re.search(r"[\u3400-\u9fff]", stripped))
    )
    prefix = "证据有限的假设：" if use_chinese else "Evidence-limited hypothesis: "
    return f"{prefix}{stripped}"


def _apply_evidence_coverage_to_confidence(
    confidence: AnalyticConfidence,
    coverage: _EvidenceCoverage,
) -> AnalyticConfidence:
    if not coverage.missing_rounds:
        return confidence

    level = confidence.level
    if coverage.max_round >= 3 and coverage.missing_phases:
        level = "low"
    elif level == "high":
        level = "medium"

    missing_rounds_en = _compact_round_ranges(
        coverage.missing_rounds,
        separator=", ",
    )
    missing_rounds_zh = _compact_round_ranges(
        coverage.missing_rounds,
        separator="、",
    )
    if coverage.max_round >= 3 and coverage.missing_phases:
        missing_phases_en = ", ".join(coverage.missing_phases)
        missing_phases_zh = "、".join(
            _COVERAGE_PHASE_ZH[phase] for phase in coverage.missing_phases
        )
        coverage_basis_en = (
            "Whole evidence phases are missing: "
            f"{missing_phases_en}; missing rounds: {missing_rounds_en}."
        )
        coverage_basis_zh = (
            f"证据坐标缺少完整阶段：{missing_phases_zh}；"
            f"缺失轮次：{missing_rounds_zh}。"
        )
    else:
        coverage_basis_en = (
            "Partial round-coordinate gaps cap confidence at medium; "
            f"missing rounds: {missing_rounds_en}."
        )
        coverage_basis_zh = (
            "部分轮次坐标缺口使置信度最高为中等；"
            f"缺失轮次：{missing_rounds_zh}。"
        )
    existing_i18n = confidence.basis_i18n or I18nText(
        zh=confidence.basis,
        en=confidence.basis,
    )
    return confidence.model_copy(
        update={
            "level": level,
            "basis": f"{confidence.basis} {coverage_basis_en}".strip(),
            "basis_i18n": I18nText(
                zh=f"{existing_i18n.zh} {coverage_basis_zh}".strip(),
                en=f"{existing_i18n.en} {coverage_basis_en}".strip(),
            ),
        }
    )


def _analytic_confidence(
    claims: Sequence[Claim],
    *,
    evidence_coverage: _EvidenceCoverage,
) -> AnalyticConfidence:
    strong = sum(claim.evidence_strength == "strong" for claim in claims)
    downgraded = sum(claim.confidence == "low" for claim in claims)
    if not claims or downgraded:
        level = "low"
    elif strong == len(claims):
        level = "high"
    else:
        level = "medium"
    basis = (
        "No compiled claims remain."
        if not claims
        else f"{strong}/{len(claims)} claims have strong evidence support; {downgraded} downgraded."
    )
    confidence = AnalyticConfidence(
        level=level,
        basis=basis,
        basis_i18n=I18nText(
            zh=(
                "没有保留可编译结论。"
                if not claims
                else (
                    f"{len(claims)} 条结论中 {strong} 条有强证据支持，"
                    f"{downgraded} 条已降级。"
                )
            ),
            en=basis,
        ),
    )
    return _apply_evidence_coverage_to_confidence(confidence, evidence_coverage)


def compile_report_claims_in_session(
    session: Session,
    scenario_id: str,
    target_branch_id: str,
    sections: Sequence[ReportSection],
    evidence: Sequence[EvidenceRef],
    *,
    verdict_headline: str,
    max_round: int,
    language: str | None = None,
    summary_i18n: I18nText | None = None,
) -> ClaimCompilationResult:
    """Compile generated prose against rows visible in ``session``.

    Evidence identifiers are treated only as coordinates. Quote and semantic
    support are checked against raw ``AgentMessage.content`` and verified
    ``SimulationAction`` rows; ``EvidenceRef.quote`` is never trusted as source text.
    """

    normalized_sections = [ReportSection.model_validate(section) for section in sections]
    normalized_evidence = [EvidenceRef.model_validate(item) for item in evidence]
    branch = session.get(Branch, target_branch_id)
    if branch is None or branch.scenario_id != scenario_id:
        raise ValueError("target branch does not belong to scenario")
    lineage = resolve_branch_lineage(
        session,
        scenario_id=scenario_id,
        branch_id=target_branch_id,
    )
    normalized_evidence = [
        item
        for item in normalized_evidence
        if any(
            segment.branch_id == item.branch_id
            and item.round_number >= segment.round_min
            and (
                segment.round_max is None
                or item.round_number <= segment.round_max
            )
            for segment in lineage.segments
        )
    ]
    agents = list(
        session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id).order_by(Agent.id)
        ).all()
    )
    roster_agent_ids = {agent.id for agent in agents}
    sources_by_id = _validated_sources(
        session,
        scenario_id,
        normalized_evidence,
    )
    evidence_coverage = _evidence_coverage_from_rounds(
        (
            source.evidence.round_number
            for source in sources_by_id.values()
            if not source.runtime_placeholder
        ),
        max_round=max_round,
    )
    actions_by_message = _validated_actions(
        session,
        scenario_id,
        sources_by_id.values(),
    )

    claims: list[Claim] = []
    compiled_sections: list[ReportSection] = []
    compiled_verdict_headline = verdict_headline.strip()
    compiled_summary = (
        I18nText.model_validate(summary_i18n) if summary_i18n is not None else None
    )
    if compiled_summary is not None:
        compiled_summary = _strip_evidence_coverage_notice(compiled_summary)
    if verdict_headline.strip():
        verdict_claim, _ = _compile_claim(
            claim_id="claim-verdict-001",
            statement=verdict_headline.strip(),
            branch_id=target_branch_id,
            max_round=max_round,
            sources=list(sources_by_id.values()),
            actions_by_message=actions_by_message,
            agents=agents,
            roster_agent_ids=roster_agent_ids,
            is_verdict=True,
        )
        if verdict_claim.evidence_strength == "unsupported":
            verdict_claim = verdict_claim.model_copy(
                update={
                    "claim_type": "hypothesis",
                    "claim_text": _evidence_limited_hypothesis_text(
                        verdict_claim.claim_text,
                        language=language,
                    ),
                }
            )
        use_chinese_verdict = language == "zh" or (
            language != "en"
            and bool(re.search(r"[\u3400-\u9fff]", verdict_claim.claim_text))
        )
        verdict_language = "zh" if use_chinese_verdict else "en"
        compiled_verdict_headline = verdict_claim.claim_text
        if "runtime_placeholder_not_evidence" in (
            verdict_claim.downgrade_reason or ""
        ):
            compiled_verdict_headline = _sanitize_runtime_failure_inferences(
                compiled_verdict_headline,
                language=verdict_language,
            )
        claims.append(verdict_claim)

    if compiled_summary is not None:
        summary_section = ReportSection(
            id="summary",
            title="Summary",
            title_i18n=I18nText(zh="摘要", en="Summary"),
            intent="Compile the report summary against all durable evidence.",
            body_md_i18n=compiled_summary,
            evidence_refs=list(sources_by_id),
            charts=[],
        )
        summary_claims: list[Claim] = []
        summary_unsafe_quotes: list[str] = []
        for index, statement in enumerate(
            _statements(summary_section, language=language),
            start=1,
        ):
            claim, claim_unsafe_quotes = _compile_claim(
                claim_id=f"claim-summary-{index:03d}",
                statement=statement,
                branch_id=target_branch_id,
                max_round=max_round,
                sources=list(sources_by_id.values()),
                actions_by_message=actions_by_message,
                agents=agents,
                roster_agent_ids=roster_agent_ids,
                is_verdict=False,
            )
            if claim.evidence_strength == "unsupported":
                claim = claim.model_copy(update={"claim_type": "hypothesis"})
            summary_claims.append(claim)
            summary_unsafe_quotes.extend(claim_unsafe_quotes)
        claims.extend(summary_claims)
        compiled_summary = _safe_summary(
            compiled_summary,
            claims=summary_claims,
            unsafe_quotes=summary_unsafe_quotes,
        )

    for section in normalized_sections:
        section_sources = [
            sources_by_id[evidence_id]
            for evidence_id in section.evidence_refs
            if evidence_id in sources_by_id
        ]
        section_claims: list[Claim] = []
        unsafe_quotes: list[str] = []
        for index, statement in enumerate(
            _statements(section, language=language),
            start=1,
        ):
            claim, claim_unsafe_quotes = _compile_claim(
                claim_id=f"claim-{section.id}-{index:03d}",
                statement=statement,
                branch_id=target_branch_id,
                max_round=max_round,
                sources=section_sources,
                actions_by_message=actions_by_message,
                agents=agents,
                roster_agent_ids=roster_agent_ids,
                is_verdict=False,
            )
            section_claims.append(claim)
            unsafe_quotes.extend(claim_unsafe_quotes)
        unsafe_quote_set = set(unsafe_quotes)
        if unsafe_quote_set:
            propagated_reason = (
                "speaker_mismatch"
                if any(
                    claim.downgrade_reason == "speaker_mismatch"
                    for claim in section_claims
                )
                else "unsupported_by_evidence"
            )
            section_claims = [
                claim.model_copy(
                    update={
                        "claim_text": _remove_quote_marks(
                            claim.claim_text,
                            unsafe_quote_set,
                        ),
                        "exact_quote": None,
                        "evidence_strength": "unsupported",
                        "confidence": "low",
                        "downgrade_reason": propagated_reason,
                    }
                )
                if claim.exact_quote in unsafe_quote_set
                else claim
                for claim in section_claims
            ]
        claims.extend(section_claims)
        compiled_sections.append(
            _safe_section(
                section,
                claims=section_claims,
                unsafe_quotes=unsafe_quotes,
            )
        )

    if compiled_summary is not None:
        compiled_summary = _with_evidence_coverage_notice(
            compiled_summary,
            evidence_coverage,
        )
    return ClaimCompilationResult(
        claims=claims,
        sections=compiled_sections,
        analytic_confidence=_analytic_confidence(
            claims,
            evidence_coverage=evidence_coverage,
        ),
        verdict_headline=compiled_verdict_headline,
        summary_i18n=compiled_summary,
        evidence_coverage=evidence_coverage,
    )


def compile_report_claims(
    engine: Engine,
    scenario_id: str,
    target_branch_id: str,
    sections: Sequence[ReportSection],
    evidence: Sequence[EvidenceRef],
    *,
    verdict_headline: str,
    max_round: int,
    language: str | None = None,
    summary_i18n: I18nText | None = None,
) -> ClaimCompilationResult:
    """Compile report claims against committed database authority."""

    with Session(engine) as session:
        return compile_report_claims_in_session(
            session,
            scenario_id,
            target_branch_id,
            sections,
            evidence,
            verdict_headline=verdict_headline,
            max_round=max_round,
            language=language,
            summary_i18n=summary_i18n,
        )


def _branch_narrative_language_code(
    language: str | None,
    narration: Mapping[str, object],
) -> str:
    normalized = str(language or "").strip().casefold()
    if normalized in {"zh", "zh-cn", "chinese", "中文", "简体中文"}:
        return "zh"
    if normalized in {"en", "en-us", "english", "英文"}:
        return "en"
    combined = " ".join(str(value or "") for value in narration.values())
    return "zh" if re.search(r"[\u3400-\u9fff]", combined) else "en"


def _branch_narrative_key_moments(value: object) -> list[str]:
    if isinstance(value, str):
        stripped = value.strip()
        return [stripped] if stripped else []
    if not isinstance(value, Sequence):
        return []
    return [
        stripped
        for item in value
        if (stripped := str(item or "").strip())
    ]


def _branch_narrative_evidence_in_session(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
) -> tuple[list[EvidenceRef], int]:
    """Build exhaustive evidence from the effective lineage, not prompt samples."""

    selection = select_branch_rounds(
        session,
        scenario_id=scenario_id,
        branch_id=branch_id,
    )
    max_round = max(
        (round_row.round_number for round_row in selection.rounds),
        default=0,
    )
    round_ids = tuple(round_row.id for round_row in selection.rounds)
    if not round_ids:
        return [], max_round

    rows = session.exec(
        select(AgentMessage, Round, Agent)
        .join(Round, AgentMessage.round_id == Round.id)
        .join(Agent, AgentMessage.agent_id == Agent.id)
        .where(col(AgentMessage.round_id).in_(round_ids))
        .where(Agent.scenario_id == scenario_id)
        .order_by(Round.round_number.asc(), AgentMessage.id.asc())
    ).all()
    evidence: list[EvidenceRef] = []
    for message, round_row, agent in rows:
        content = str(message.content or "").strip()
        agent_name = str(agent.name or "").strip()
        if not content or not agent_name:
            continue
        evidence.append(
            EvidenceRef(
                id=f"branch-narrative-evidence-{message.id}",
                branch_id=round_row.branch_id,
                round_id=round_row.id,
                round_number=round_row.round_number,
                agent_id=agent.id,
                agent_name=agent_name,
                message_id=message.id,
                quote=content,
                kind="utterance",
            )
        )
    return evidence, max_round


def _branch_narrative_display_text(text: str) -> str:
    replacements = (
        (
            "**归因未经验证：** ",
            "证据有限的叙事假设（归因未经验证）：",
        ),
        ("**证据有限的假设：** ", "证据有限的叙事假设："),
        (
            "**Unverified attribution:** ",
            "Evidence-limited narrative hypothesis (unverified attribution): ",
        ),
        (
            "**Evidence-limited hypothesis:** ",
            "Evidence-limited narrative hypothesis: ",
        ),
    )
    stripped = text.strip()
    for source, target in replacements:
        if stripped.startswith(source):
            return f"{target}{stripped[len(source):].lstrip()}"
    return stripped


def _unsupported_branch_narrative_claim(
    *,
    claim_id: str,
    statement: str,
    branch_id: str,
    language: str,
) -> tuple[Claim, str]:
    """Fail closed when report presentation filtering yields no proposition."""

    safe_statement = re.sub(
        r"(?m)^\s{0,3}#{1,6}\s*",
        "",
        statement,
    ).strip()
    safe_statement = _strip_outer_strong_emphasis(safe_statement)
    safe_statement = _remove_quote_marks(
        safe_statement,
        [candidate for _opening, candidate, _closing in _quote_spans(safe_statement)],
    ).strip()
    if not safe_statement:
        safe_statement = (
            "未提供可审计的叙事命题。"
            if language == "zh"
            else "No auditable narrative proposition was provided."
        )
    claim = Claim(
        claim_id=claim_id,
        claim_text=safe_statement,
        claim_type=_claim_type(safe_statement, is_verdict=False),
        speaker=None,
        agent_id=None,
        message_ids=[],
        action_ids=[],
        branch_id=branch_id,
        round_numbers=[],
        exact_quote=None,
        evidence_strength="unsupported",
        temporal_coverage=[],
        role_coverage=[],
        confidence="low",
        downgrade_reason="unsupported_by_evidence",
    )
    prefixed = (
        f"**证据有限的假设：** {safe_statement}"
        if language == "zh"
        else f"**Evidence-limited hypothesis:** {safe_statement}"
    )
    return claim, _branch_narrative_display_text(prefixed)


def compile_branch_narrative_claims_in_session(
    session: Session,
    scenario_id: str,
    target_branch_id: str,
    narration: Mapping[str, object],
    *,
    language: str | None = None,
) -> BranchNarrativeCompilationResult:
    """Compile legacy Branch narrative prose through the report claim contract."""

    branch = session.get(Branch, target_branch_id)
    if branch is None or branch.scenario_id != scenario_id:
        raise ValueError("target branch does not belong to scenario")

    language_code = _branch_narrative_language_code(language, narration)
    raw_story = str(narration.get("story") or "").strip()
    raw_insight = str(narration.get("insight") or "").strip()
    raw_question_answer = str(narration.get("question_answer") or "").strip()
    raw_key_moments = _branch_narrative_key_moments(
        narration.get("key_moments")
    )

    field_specs: list[tuple[str, str, str]] = []
    for field_key, section_id, text in (
        ("story", "branch-narrative-story", raw_story),
        ("insight", "branch-narrative-insight", raw_insight),
        (
            "question_answer",
            "branch-narrative-question-answer",
            raw_question_answer,
        ),
    ):
        if text:
            field_specs.append((field_key, section_id, text))
    for index, text in enumerate(raw_key_moments, start=1):
        field_specs.append(
            (
                f"key_moments.{index - 1}",
                f"branch-narrative-key-moment-{index:03d}",
                text,
            )
        )

    evidence, max_round = _branch_narrative_evidence_in_session(
        session,
        scenario_id=scenario_id,
        branch_id=target_branch_id,
    )
    sections = [
        ReportSection(
            id=section_id,
            title=field_key,
            title_i18n=I18nText(zh=field_key, en=field_key),
            intent="Validate branch narrative prose against durable coordinates.",
            body_md_i18n=I18nText(zh=text, en=text),
            evidence_refs=[item.id for item in evidence],
            charts=[],
        )
        for field_key, section_id, text in field_specs
    ]
    compiled = compile_report_claims_in_session(
        session,
        scenario_id,
        target_branch_id,
        sections,
        evidence,
        verdict_headline="",
        max_round=max_round,
        language=language_code,
    )
    section_by_id = {section.id: section for section in compiled.sections}
    output_by_field: dict[str, str] = {}
    claim_ids_by_field: dict[str, list[str]] = {}
    compiled_claims = list(compiled.claims)
    for field_key, section_id, source_text in field_specs:
        section = section_by_id[section_id]
        claim_prefix = f"claim-{section_id}-"
        field_claim_ids = [
            claim.claim_id
            for claim in compiled_claims
            if claim.claim_id.startswith(claim_prefix)
        ]
        if not field_claim_ids:
            fallback_claim, fallback_text = _unsupported_branch_narrative_claim(
                claim_id=f"{claim_prefix}001",
                statement=source_text,
                branch_id=target_branch_id,
                language=language_code,
            )
            compiled_claims.append(fallback_claim)
            field_claim_ids = [fallback_claim.claim_id]
            output_by_field[field_key] = fallback_text
        else:
            localized = getattr(section.body_md_i18n, language_code)
            output_by_field[field_key] = _branch_narrative_display_text(localized)
        claim_ids_by_field[field_key] = field_claim_ids

    return BranchNarrativeCompilationResult(
        story=output_by_field.get("story", ""),
        insight=output_by_field.get("insight", ""),
        key_moments=[
            output_by_field[f"key_moments.{index}"]
            for index in range(len(raw_key_moments))
        ],
        question_answer=output_by_field.get("question_answer", ""),
        claims=compiled_claims,
        claim_ids_by_field=claim_ids_by_field,
        analytic_confidence=_analytic_confidence(
            compiled_claims,
            evidence_coverage=compiled.evidence_coverage,
        ),
        evidence_coverage=compiled.evidence_coverage,
    )


def compile_branch_narrative_claims(
    engine: Engine,
    scenario_id: str,
    target_branch_id: str,
    narration: Mapping[str, object],
    *,
    language: str | None = None,
) -> BranchNarrativeCompilationResult:
    """Compile branch narration against committed durable evidence."""

    with Session(engine) as session:
        return compile_branch_narrative_claims_in_session(
            session,
            scenario_id,
            target_branch_id,
            narration,
            language=language,
        )
