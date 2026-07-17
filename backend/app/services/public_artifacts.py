"""Public scenario artifact schema and whitelist sanitizer."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlmodel import Session, select

from app.log_sanitize import _scrub_sensitive_text
from app.models import Agent, AgentMessage, Branch, BranchStatus, Round, Scenario

PUBLIC_ARTIFACT_SCHEMA_VERSION_V1 = "public_artifact.v1"
PUBLIC_ARTIFACT_SCHEMA_VERSION_V2 = "public_artifact.v2"
PUBLIC_ARTIFACT_SCHEMA_VERSION = PUBLIC_ARTIFACT_SCHEMA_VERSION_V2

MAX_QUESTION_CHARS = 320
MAX_LANGUAGE_CHARS = 8
MAX_AGENT_NAME_CHARS = 80
MAX_TITLE_CHARS = 120
MAX_VERDICT_CHARS = 240
MAX_EXCERPT_CHARS = 280
MAX_DOMAIN_CHARS = 253
MAX_AGENT_NAMES = 12
MAX_BRANCHES = 8
MAX_TRANSCRIPT_EXCERPTS = 12
MAX_SOURCE_DOMAINS = 12

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"\s+")
_SENSITIVE_KEY_NAMES = frozenset(
    {
        "agentidentityid",
        "apikey",
        "authorization",
        "baseurl",
        "bearer",
        "fullreport",
        "llmapikey",
        "llmbaseurl",
        "ownerid",
        "owneruserid",
        "password",
        "passwd",
        "persona",
        "privatememory",
        "rawreport",
        "secret",
        "token",
        "userid",
        "websearchapikey",
        "websearchbaseurl",
        "xapikey",
    }
)
_SENSITIVE_KEY_SUFFIXES = (
    "apikey",
    "baseurl",
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "bearer",
)
_SENSITIVE_VALUE_RE = re.compile(
    r"(authorization\s*:\s*)?bearer\s+\S+|"
    r"\b(?:api[_-]?key|base[_-]?url|token|secret)\s*[:=]|"
    r"\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|"
    r"xai-[A-Za-z0-9_-]{6,})\b|"
    r"\bhttps?://[^/?#\s@]+@[^/?#\s]+",
    re.IGNORECASE,
)
_UNLABELLED_CREDENTIAL_VALUE_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:gh[pous]_[A-Za-z0-9_]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_])|"
    r"\bAKIA[0-9A-Z]{16}\b|"
    r"(?<![A-Za-z0-9-])xox[bp]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])|"
    r"(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])|"
    r"(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])"
)


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BranchVerdict(_StrictModel):
    branch_index: int = Field(ge=1)
    title: str
    verdict: str
    confidence: Literal["high", "medium", "low"]


class BranchVerdictV2(_StrictModel):
    branch_index: int = Field(ge=1)
    title: str
    verdict: str
    confidence: Literal["high", "medium", "low"] | None


class ProbabilityBar(_StrictModel):
    branch_index: int = Field(ge=1)
    label: str
    probability: float = Field(ge=0.0, le=1.0)


class TranscriptExcerpt(_StrictModel):
    branch_index: int = Field(ge=1)
    round: int = Field(ge=0)
    agent_name: str
    excerpt: str


class SourceDomainSummary(_StrictModel):
    domain: str
    source_count: int = Field(ge=1)


class SourceSummary(_StrictModel):
    domains: list[SourceDomainSummary] = Field(default_factory=list)


class PublicArtifactV1(_StrictModel):
    schema_version: Literal["public_artifact.v1"]
    question: str
    language: str
    display_agent_names: list[str] = Field(default_factory=list)
    branch_verdicts: list[BranchVerdict] = Field(default_factory=list)
    probability_bars: list[ProbabilityBar] = Field(default_factory=list)
    transcript_excerpts: list[TranscriptExcerpt] = Field(default_factory=list)
    source_summary: SourceSummary

    @model_validator(mode="after")
    def validate_no_sensitive_material(self) -> "PublicArtifactV1":
        scan_public_artifact_for_secrets(self.model_dump(mode="json"))
        return self


class PublicArtifactV2(_StrictModel):
    schema_version: Literal["public_artifact.v2"]
    question: str
    language: str
    display_agent_names: list[str] = Field(default_factory=list)
    branch_verdicts: list[BranchVerdictV2] = Field(default_factory=list)
    probability_bars: list[ProbabilityBar] = Field(default_factory=list)
    transcript_excerpts: list[TranscriptExcerpt] = Field(default_factory=list)
    source_summary: SourceSummary

    @model_validator(mode="after")
    def validate_no_sensitive_material(self) -> "PublicArtifactV2":
        scan_public_artifact_for_secrets(self.model_dump(mode="json"))
        return self


def _normalize_key(key: Any) -> str:
    return str(key).strip().lower().replace("_", "").replace("-", "")


def _is_sensitive_key(key: Any) -> bool:
    normalized = _normalize_key(key)
    return normalized in _SENSITIVE_KEY_NAMES or normalized.endswith(_SENSITIVE_KEY_SUFFIXES)


def _clean_text(value: Any, *, max_chars: int) -> str:
    text = _UNLABELLED_CREDENTIAL_VALUE_RE.sub("[redacted-key]", str(value or ""))
    text = _scrub_sensitive_text(text)
    text = _CONTROL_CHARS_RE.sub("", text)
    text = _WHITESPACE_RE.sub(" ", text).strip()
    if max_chars >= 0:
        text = text[:max_chars]
    return text


def _clean_language(value: Any, question: str) -> str:
    raw = _clean_text(value, max_chars=MAX_LANGUAGE_CHARS).lower()
    if raw.startswith("zh") or raw in {"chinese", "mandarin", "中文"}:
        return "zh"
    if raw.startswith("en") or raw in {"english", "英文"}:
        return "en"
    if re.search(r"[\u3400-\u9fff]", question):
        return "zh"
    return "en"


def _clean_confidence(value: Any) -> Literal["high", "medium", "low"] | None:
    raw = _clean_text(value, max_chars=16).lower()
    if raw == "high":
        return "high"
    if raw == "medium":
        return "medium"
    if raw == "low":
        return "low"
    return None


def _clean_probability(value: Any) -> float:
    try:
        probability = float(value)
    except (TypeError, ValueError):
        probability = 0.0
    if probability < 0.0:
        return 0.0
    if probability > 1.0:
        return 1.0
    return probability


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _parsed_context(data: Mapping[str, Any]) -> Mapping[str, Any]:
    return _as_mapping(data.get("parsed_context"))


def _result_quality(data: Mapping[str, Any]) -> Mapping[str, Any]:
    return _as_mapping(_parsed_context(data).get("result_quality"))


def _branch_answers(data: Mapping[str, Any]) -> Mapping[str, Any]:
    return _as_mapping(_result_quality(data).get("branch_question_answers"))


def _source_domain(url: Any) -> str | None:
    if not isinstance(url, str):
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"}:
        return None
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        return None
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    return _clean_text(host, max_chars=MAX_DOMAIN_CHARS)


def _iter_source_urls(web_context: Any) -> list[str]:
    data = _as_mapping(web_context)
    urls: list[str] = []
    for key in ("snippets", "native_citations"):
        for item in _as_list(data.get(key)):
            item_map = _as_mapping(item)
            url = item_map.get("source_url")
            if isinstance(url, str):
                urls.append(url)
    family_context = _as_mapping(data.get("family_context"))
    for entry in family_context.values():
        entry_map = _as_mapping(entry)
        for item in _as_list(entry_map.get("items")):
            item_map = _as_mapping(item)
            url = item_map.get("url") or item_map.get("source_url")
            if isinstance(url, str):
                urls.append(url)
    return urls


def _source_summary(web_context: Any) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for url in _iter_source_urls(web_context):
        domain = _source_domain(url)
        if not domain:
            continue
        counts[domain] = counts.get(domain, 0) + 1
    domains = [
        {"domain": domain, "source_count": count}
        for domain, count in sorted(counts.items())[:MAX_SOURCE_DOMAINS]
    ]
    return {"domains": domains}


def _display_agent_names(agents: list[Any]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for item in agents:
        name = _clean_text(_as_mapping(item).get("name"), max_chars=MAX_AGENT_NAME_CHARS)
        if not name or name in seen:
            continue
        names.append(name)
        seen.add(name)
        if len(names) >= MAX_AGENT_NAMES:
            break
    return names


def _branch_rows(branches: list[Any]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    rows: list[dict[str, Any]] = []
    branch_index_by_id: dict[str, int] = {}
    sortable = []
    for raw in branches:
        branch = _as_mapping(raw)
        sortable.append(
            (
                -_clean_probability(branch.get("probability")),
                int(branch.get("fork_round") or 0),
                str(branch.get("title") or ""),
                str(branch.get("id") or ""),
                branch,
            )
        )
    for index, (_neg_probability, _fork_round, _title, _branch_id, branch) in enumerate(
        sorted(sortable, key=lambda item: item[:4])[:MAX_BRANCHES],
        start=1,
    ):
        branch_id = _clean_text(branch.get("id"), max_chars=160)
        if branch_id:
            branch_index_by_id[branch_id] = index
        title = _clean_text(branch.get("title"), max_chars=MAX_TITLE_CHARS)
        if not title:
            title = f"Branch {index}"
        rows.append(
            {
                "index": index,
                "id": branch_id,
                "title": title,
                "probability": _clean_probability(branch.get("probability")),
                "insight": _clean_text(branch.get("insight"), max_chars=MAX_VERDICT_CHARS),
            }
        )
    return rows, branch_index_by_id


def _branch_verdicts(
    data: Mapping[str, Any],
    branches: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    answers = _branch_answers(data)
    confidence = _clean_confidence(_result_quality(data).get("confidence"))
    scenario_verdict = _clean_text(
        _result_quality(data).get("verdict"),
        max_chars=MAX_VERDICT_CHARS,
    )
    verdicts: list[dict[str, Any]] = []
    for branch in branches:
        answer = _clean_text(answers.get(branch["id"]), max_chars=MAX_VERDICT_CHARS)
        verdict = answer or branch["insight"] or scenario_verdict
        verdicts.append(
            {
                "branch_index": branch["index"],
                "title": branch["title"],
                "verdict": verdict,
                "confidence": confidence,
            }
        )
    return verdicts


def _probability_bars(branches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "branch_index": branch["index"],
            "label": branch["title"],
            "probability": branch["probability"],
        }
        for branch in branches
    ]


def _transcript_excerpts(
    messages: list[Any],
    branch_index_by_id: Mapping[str, int],
) -> list[dict[str, Any]]:
    excerpts_by_branch: dict[int, list[dict[str, Any]]] = {
        branch_index: [] for branch_index in branch_index_by_id.values()
    }
    for raw_message in messages:
        raw = _as_mapping(raw_message)
        branch_id = _clean_text(raw.get("branch"), max_chars=160)
        branch_index = branch_index_by_id.get(branch_id)
        if branch_index is None:
            continue
        excerpt = _clean_text(raw.get("message"), max_chars=MAX_EXCERPT_CHARS)
        agent_name = _clean_text(raw.get("agent"), max_chars=MAX_AGENT_NAME_CHARS)
        if not excerpt or not agent_name:
            continue
        try:
            round_number = max(0, int(raw.get("round") or 0))
        except (TypeError, ValueError):
            round_number = 0
        excerpts_by_branch[branch_index].append(
            {
                "branch_index": branch_index,
                "round": round_number,
                "agent_name": agent_name,
                "excerpt": excerpt,
            }
        )

    for branch_excerpts in excerpts_by_branch.values():
        branch_excerpts.sort(
            key=lambda item: (item["round"], item["agent_name"])
        )

    excerpts: list[dict[str, Any]] = []
    next_index_by_branch = dict.fromkeys(excerpts_by_branch, 0)
    while len(excerpts) < MAX_TRANSCRIPT_EXCERPTS:
        added_excerpt = False
        for branch_index in sorted(excerpts_by_branch):
            next_index = next_index_by_branch[branch_index]
            branch_excerpts = excerpts_by_branch[branch_index]
            if next_index >= len(branch_excerpts):
                continue
            excerpts.append(branch_excerpts[next_index])
            next_index_by_branch[branch_index] = next_index + 1
            added_excerpt = True
            if len(excerpts) >= MAX_TRANSCRIPT_EXCERPTS:
                break
        if not added_excerpt:
            break
    return excerpts


def build_public_artifact_from_mapping(data: Mapping[str, Any]) -> dict[str, Any]:
    """Build a public artifact from an explicit whitelist of scenario fields."""
    question = _clean_text(data.get("question"), max_chars=MAX_QUESTION_CHARS)
    parsed_context = _parsed_context(data)
    language = _clean_language(
        data.get("language") or parsed_context.get("_language"),
        question,
    )
    agents = _as_list(data.get("agents"))
    branches, branch_index_by_id = _branch_rows(_as_list(data.get("branches")))
    payload = {
        "schema_version": PUBLIC_ARTIFACT_SCHEMA_VERSION,
        "question": question,
        "language": language,
        "display_agent_names": _display_agent_names(agents),
        "branch_verdicts": _branch_verdicts(data, branches),
        "probability_bars": _probability_bars(branches),
        "transcript_excerpts": _transcript_excerpts(
            _as_list(data.get("messages")),
            branch_index_by_id,
        ),
        "source_summary": _source_summary(data.get("web_search_context")),
    }
    return PublicArtifactV2.model_validate(payload).model_dump(mode="json")


def _decode_web_context(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        decoded = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    return decoded if isinstance(decoded, dict) else None


def build_public_artifact_for_scenario(
    session: Session,
    scenario: Scenario,
) -> dict[str, Any]:
    """Build a public artifact from database rows without using snapshot export."""
    agents = list(
        session.exec(
            select(Agent).where(
                Agent.scenario_id == scenario.id,
                Agent.source_type.is_(None) | (Agent.source_type != "world_event_source"),
            )
        ).all()
    )
    scenario_branches = list(
        session.exec(select(Branch).where(Branch.scenario_id == scenario.id)).all()
    )
    parent_branch_ids = {
        branch.parent_branch_id
        for branch in scenario_branches
        if branch.parent_branch_id
    }
    terminal_leaves = [
        branch
        for branch in scenario_branches
        if branch.status == BranchStatus.COMPLETED
        and branch.id not in parent_branch_ids
    ]
    branch_candidates = [
        {
            "id": branch.id,
            "title": branch.title,
            "probability": branch.probability,
            "insight": branch.insight,
            "fork_round": branch.fork_round,
        }
        for branch in terminal_leaves
    ]
    selected_branches, _branch_index_by_id = _branch_rows(branch_candidates)
    selected_branch_ids = [branch["id"] for branch in selected_branches if branch["id"]]
    agent_name_by_id = {agent.id: agent.name for agent in agents}
    message_rows: list[tuple[AgentMessage, str, int]] = []
    for branch_id in selected_branch_ids:
        branch_message_rows = session.exec(
            select(AgentMessage, Round.branch_id, Round.round_number)
            .join(Round, AgentMessage.round_id == Round.id)
            .where(Round.branch_id == branch_id)
            .order_by(Round.round_number.asc(), AgentMessage.id.asc())
            .limit(MAX_TRANSCRIPT_EXCERPTS)
        ).all()
        message_rows.extend(branch_message_rows)
    mapping = {
        "question": scenario.question,
        "parsed_context": (
            scenario.parsed_context
            if isinstance(scenario.parsed_context, dict)
            else {}
        ),
        "agents": [{"name": agent.name} for agent in agents],
        "branches": branch_candidates,
        "messages": [
            {
                "branch": branch_id,
                "round": round_number,
                "agent": agent_name_by_id.get(message.agent_id, "Unknown"),
                "message": message.content,
            }
            for message, branch_id, round_number in message_rows
        ],
        "web_search_context": _decode_web_context(scenario.web_context_json),
    }
    return build_public_artifact_from_mapping(mapping)


def scan_public_artifact_for_secrets(value: Any, path: str = "$") -> None:
    """Fail closed if a public artifact contains forbidden keys or secret values."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            if _is_sensitive_key(key):
                raise ValueError(f"sensitive key is not allowed at {path}.{key}")
            scan_public_artifact_for_secrets(item, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            scan_public_artifact_for_secrets(item, f"{path}[{index}]")
        return
    if isinstance(value, str) and (
        _SENSITIVE_VALUE_RE.search(value)
        or _UNLABELLED_CREDENTIAL_VALUE_RE.search(value)
    ):
        raise ValueError(f"sensitive value is not allowed at {path}")
