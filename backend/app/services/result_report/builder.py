"""Fail-soft builder for ``Scenario.parsed_context.full_report``."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlmodel import Session, select

from app.config import settings
from app.log_sanitize import _scrub_sensitive_text
from app.models import Branch, BranchStatus, Scenario
from app.models.database import get_engine
from app.services.llm_client import (
    format_untrusted_text_block,
    llm_call_json,
    llm_request_scope,
)
from app.services.result_report.reducer import TARGET_BRANCH_SORT, ReducerResult
from app.services.result_report.reducer import reduce as reduce_report
from app.services.result_report.schema import (
    AnalyticConfidence,
    FullReport,
    I18nText,
    IndicatorToWatch,
    LanguageStatus,
    Likelihood,
    ReportSection,
    ReportStatus,
    ReportTier,
    ResultReportSSEEvent,
    ToolTraceSummary,
    Verdict,
    encode_sse_event,
    utf8_json_size_bytes,
    validate_full_report_payload,
)
from app.services.runtime_lock import acquire_runtime_lock, release_runtime_lock
from app.services.web_context import _sanitize_url

logger = logging.getLogger(__name__)

SectionTier = Literal["generation", "rewrite", "static"]
ProgressCallback = Callable[[ResultReportSSEEvent], Awaitable[None] | None]

_ALLOWED_SECTION_IDS = (
    "timeline",
    "factions",
    "conflicts",
    "premortem",
    "indicators",
    "sources",
)
_TIER_ORDER: dict[SectionTier, int] = {"generation": 0, "rewrite": 1, "static": 2}
_REPORT_LOCKS: dict[str, asyncio.Lock] = {}
_NARRATIVE_DISCLAIMER = (
    "This is a narrative simulation probability, not a real-world forecast."
)


@dataclass(frozen=True, slots=True)
class ReportGenerationOverrides:
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    temperature: float | None = None


@dataclass(frozen=True, slots=True)
class SectionPlan:
    section_id: str
    title_i18n: dict[str, str]
    intent: str


@dataclass(frozen=True, slots=True)
class ReportOutline:
    title_i18n: dict[str, str]
    summary_i18n: dict[str, str]
    sections: list[SectionPlan]
    fallback: bool = False


@dataclass(frozen=True, slots=True)
class SectionBuildResult:
    section: ReportSection
    tier: SectionTier
    tool_trace: list[ToolTraceSummary]


@dataclass(frozen=True, slots=True)
class BuilderContext:
    scenario_id: str
    question: str
    language: str
    parsed_context: dict[str, Any]
    branch_id: str
    branch_title: str
    branch_story: str
    branch_insight: str
    web_context_blocks: list[str]


class ResultReportBuilderError(RuntimeError):
    """Raised for build-time failures that should stay local to the report."""


class ResultReportAlreadyRunningError(ResultReportBuilderError):
    """Raised when another worker already owns the report generation lease."""


def _report_runtime_lock_key(scenario_id: str) -> str:
    return f"result-report:{scenario_id}"


def _report_runtime_lock_lease_seconds() -> float:
    section_budget = (
        max(settings.REPORT_MAX_SECTIONS, settings.REPORT_MIN_SECTIONS)
        * max(settings.REPORT_MAX_TOOL_CALLS_PER_SECTION, 1)
        * max(settings.REPORT_SECTION_TIMEOUT_SECONDS, 0.01)
        * 2
    )
    return max(60.0, settings.REPORT_PLAN_TIMEOUT_SECONDS + section_budget + 60.0)


def resolve_dominant_branch_id(scenario_id: str) -> str | None:
    """Resolve the /story-equivalent dominant completed branch id."""

    with Session(get_engine()) as session:
        branches = session.exec(
            select(Branch)
            .where(
                Branch.scenario_id == scenario_id,
                Branch.status == BranchStatus.COMPLETED,
            )
            .order_by(Branch.probability.desc(), Branch.fork_round.asc(), Branch.id.asc())
        ).all()
        if not branches:
            branches = session.exec(
                select(Branch)
                .where(Branch.scenario_id == scenario_id)
                .order_by(Branch.probability.desc(), Branch.fork_round.asc(), Branch.id.asc())
            ).all()
        return branches[0].id if branches else None


async def build_report(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    overrides: Mapping[str, Any] | ReportGenerationOverrides | None,
    progress: ProgressCallback | None = None,
) -> FullReport:
    """Build and incrementally persist one full report for a scenario."""

    lock = _REPORT_LOCKS.setdefault(scenario_id, asyncio.Lock())
    async with lock:
        normalized_overrides = _normalize_overrides(overrides)
        lease_seconds = _report_runtime_lock_lease_seconds()
        lease = await asyncio.to_thread(
            acquire_runtime_lock,
            _report_runtime_lock_key(scenario_id),
            lease_seconds=lease_seconds,
        )
        if lease is None:
            raise ResultReportAlreadyRunningError(
                "Result report generation is already in progress",
            )

        try:
            return await _build_report_unlocked(
                scenario_id,
                dominant_branch_id,
                overrides=normalized_overrides,
                progress=progress,
            )
        except Exception:  # noqa: BLE001 - fail-soft marker before releasing lease
            try:
                await asyncio.to_thread(
                    _persist_failed_report_if_absent,
                    scenario_id,
                    dominant_branch_id,
                )
            except Exception:  # noqa: BLE001 - preserve original builder error
                logger.warning("Failed to persist result report failure marker")
            raise
        finally:
            try:
                await asyncio.to_thread(release_runtime_lock, lease)
            except Exception:  # noqa: BLE001 - do not mask the report outcome
                logger.warning("Failed to release result report runtime lock")


async def _build_report_unlocked(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    overrides: ReportGenerationOverrides | None,
    progress: ProgressCallback | None,
) -> FullReport:
    engine = get_engine()
    reducer_result = await asyncio.to_thread(
        reduce_report,
        engine,
        scenario_id,
        max_evidence=settings.REPORT_MAX_EVIDENCE_PER_SECTION,
    )
    target_branch_id = dominant_branch_id or reducer_result.target_branch_id
    if not target_branch_id:
        raise ResultReportBuilderError("No dominant branch is available")

    context = await asyncio.to_thread(_load_builder_context, scenario_id, target_branch_id)
    outline = await plan_outline(
        context,
        reducer_result,
        overrides=overrides,
    )
    report = _assemble_report(
        context,
        reducer_result,
        outline,
        sections=[],
        status="partial",
        tier="generation",
    )
    report = _fit_report_to_byte_cap(report)
    _persist_report_payload(scenario_id, report.model_dump(mode="json"))

    completed_sections: list[ReportSection] = []
    section_tiers: list[SectionTier] = []
    failed_sections = 0

    for section_plan in outline.sections:
        await _emit_progress(
            progress,
            ResultReportSSEEvent(
                event="report_section_delta",
                data={
                    "report_id": scenario_id,
                    "section_id": section_plan.section_id,
                    "status": "generating",
                },
            ),
        )
        section_result: SectionBuildResult | None = None
        for _attempt in range(2):
            try:
                section_result = await generate_section_react(
                    context,
                    section_plan,
                    reducer_result,
                    overrides=overrides,
                )
                break
            except Exception:  # noqa: BLE001 - fail-soft chapter boundary
                logger.info(
                    "Result report section failed; will%s retry",
                    "" if _attempt == 0 else " not",
                )

        if section_result is None:
            failed_sections += 1
            await _emit_progress(
                progress,
                ResultReportSSEEvent(
                    event="report_failed",
                    data={
                        "report_id": scenario_id,
                        "section_id": section_plan.section_id,
                        "status": "failed",
                        "error_code": "SECTION_FAILED",
                        "message": _safe_error_message(None),
                    },
                ),
            )
            report = _assemble_report(
                context,
                reducer_result,
                outline,
                sections=completed_sections,
                status=_status_for_sections(
                    completed=len(completed_sections),
                    failed=failed_sections,
                    total=len(outline.sections),
                ),
                tier=_worst_tier(section_tiers),
            )
            report = _fit_report_to_byte_cap(report)
            _persist_report_payload(scenario_id, report.model_dump(mode="json"))
            continue

        completed_sections.append(section_result.section)
        section_tiers.append(section_result.tier)
        report = _assemble_report(
            context,
            reducer_result,
            outline,
            sections=completed_sections,
            status=_status_for_sections(
                completed=len(completed_sections),
                failed=failed_sections,
                total=len(outline.sections),
            ),
            tier=_worst_tier(section_tiers),
        )
        report = _fit_report_to_byte_cap(report)
        _persist_report_payload(scenario_id, report.model_dump(mode="json"))
        await _emit_progress(
            progress,
            ResultReportSSEEvent(
                event="report_section_complete",
                data={
                    "report_id": scenario_id,
                    "section_id": section_plan.section_id,
                    "status": "complete",
                    "tool_trace": section_result.tool_trace,
                },
            ),
        )

    final_status = _status_for_sections(
        completed=len(completed_sections),
        failed=failed_sections,
        total=len(outline.sections),
    )
    report = _assemble_report(
        context,
        reducer_result,
        outline,
        sections=completed_sections,
        status=final_status,
        tier=_worst_tier(section_tiers),
    )
    report = _fit_report_to_byte_cap(report)
    _persist_report_payload(scenario_id, report.model_dump(mode="json"))
    return report


async def build_report_safe(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    overrides: Mapping[str, Any] | ReportGenerationOverrides | None,
    progress: ProgressCallback | None = None,
) -> FullReport | None:
    """Run report generation for fire-and-forget callers without surfacing errors."""

    try:
        return await build_report(
            scenario_id,
            dominant_branch_id,
            overrides=overrides,
            progress=progress,
        )
    except ResultReportAlreadyRunningError:
        logger.info("Result report generation skipped because another worker owns the lease")
        return await asyncio.to_thread(_load_existing_full_report, scenario_id)
    except Exception as exc:  # noqa: BLE001 - auto report generation is best-effort
        logger.info(
            "Result report generation failed; ensuring failed marker: %s",
            type(exc).__name__,
        )
        try:
            return await asyncio.to_thread(
                _persist_failed_report_if_absent,
                scenario_id,
                dominant_branch_id,
            )
        except Exception:  # noqa: BLE001 - simulator completion must stay fail-soft
            logger.warning("Failed to persist result report failure marker")
            return None


async def build_report_sse_stream(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    overrides: Mapping[str, Any] | ReportGenerationOverrides | None,
):
    """Yield frozen SSE frames while running ``build_report``."""

    yield encode_sse_event(
        ResultReportSSEEvent(
            event="report_started",
            data={"report_id": scenario_id, "status": "generating"},
        ),
    )
    queue: asyncio.Queue[ResultReportSSEEvent] = asyncio.Queue()

    async def progress(event: ResultReportSSEEvent) -> None:
        await queue.put(event)

    task = asyncio.create_task(
        build_report(
            scenario_id,
            dominant_branch_id,
            overrides=overrides,
            progress=progress,
        )
    )

    try:
        while not task.done() or not queue.empty():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except TimeoutError:
                continue
            yield encode_sse_event(event)

        try:
            report = await task
        except Exception:  # noqa: BLE001 - SSE should fail-soft
            yield encode_sse_event(
                ResultReportSSEEvent(
                    event="report_failed",
                    data={
                        "report_id": scenario_id,
                        "status": "failed",
                        "error_code": "REPORT_FAILED",
                        "message": _safe_error_message(None),
                    },
                ),
            )
            yield encode_sse_event(
                ResultReportSSEEvent(
                    event="report_complete",
                    data={"report_id": scenario_id, "status": "failed"},
                ),
            )
            return

        if report.status == "failed":
            yield encode_sse_event(
                ResultReportSSEEvent(
                    event="report_failed",
                    data={"report_id": scenario_id, "status": "failed"},
                ),
            )
        yield encode_sse_event(
            ResultReportSSEEvent(
                event="report_complete",
                data={"report_id": scenario_id, "status": report.status},
            ),
        )
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        elif not task.cancelled():
            with contextlib.suppress(Exception):
                task.exception()


async def plan_outline(
    context: BuilderContext,
    reducer_result: ReducerResult,
    *,
    overrides: ReportGenerationOverrides | None,
) -> ReportOutline:
    """Plan a bounded 2-5 section outline with one LLM call and fallback."""

    prompt = _build_outline_prompt(context, reducer_result)
    try:
        with llm_request_scope(purpose="result_report"):
            payload = await asyncio.wait_for(
                llm_call_json(
                    prompt,
                    api_key=overrides.api_key if overrides else None,
                    base_url=overrides.base_url if overrides else None,
                    model=overrides.model if overrides else None,
                    temperature=(
                        overrides.temperature
                        if overrides and overrides.temperature is not None
                        else 0.3
                    ),
                    reasoning_effort="medium",
                ),
                timeout=settings.REPORT_PLAN_TIMEOUT_SECONDS,
            )
        return _normalize_outline_payload(payload, context)
    except Exception:  # noqa: BLE001 - plan fallback must not abort
        return _fallback_outline(context, reducer_result)


async def generate_section_react(
    context: BuilderContext,
    section: SectionPlan,
    reducer_result: ReducerResult,
    *,
    overrides: ReportGenerationOverrides | None,
) -> SectionBuildResult:
    """Generate one section using a bounded ReACT-style tool loop."""

    try:
        return await _generate_section_tier(
            context,
            section,
            reducer_result,
            overrides=overrides,
            tier="generation",
        )
    except Exception:
        pass
    try:
        return await _generate_section_tier(
            context,
            section,
            reducer_result,
            overrides=overrides,
            tier="rewrite",
        )
    except Exception:
        pass
    return _static_section_from_context(context, section, reducer_result)


async def _generate_section_tier(
    context: BuilderContext,
    section: SectionPlan,
    reducer_result: ReducerResult,
    *,
    overrides: ReportGenerationOverrides | None,
    tier: SectionTier,
) -> SectionBuildResult:
    history: list[str] = []
    trace: list[ToolTraceSummary] = []
    max_steps = max(1, settings.REPORT_MAX_TOOL_CALLS_PER_SECTION)
    for iteration in range(1, max_steps + 1):
        prompt = _build_section_prompt(
            context,
            section,
            reducer_result,
            tier=tier,
            history=history,
        )
        with llm_request_scope(purpose="result_report"):
            payload = await asyncio.wait_for(
                llm_call_json(
                    prompt,
                    api_key=overrides.api_key if overrides else None,
                    base_url=overrides.base_url if overrides else None,
                    model=overrides.model if overrides else None,
                    temperature=(
                        overrides.temperature
                        if overrides and overrides.temperature is not None
                        else (0.55 if tier == "generation" else 0.4)
                    ),
                    reasoning_effort="medium",
                ),
                timeout=settings.REPORT_SECTION_TIMEOUT_SECONDS,
            )
        if not isinstance(payload, dict):
            raise ResultReportBuilderError("Section payload must be an object")

        if _looks_like_final_section(payload):
            return _section_result_from_payload(
                section,
                payload,
                reducer_result,
                tier=tier,
                trace=trace,
            )

        action = str(payload.get("action") or "").strip()
        params = payload.get("params")
        if not isinstance(params, dict):
            params = {}
        if action == "query_branch_messages":
            started = time.monotonic()
            tool_result, item_count = _tool_query_branch_messages(
                context,
                reducer_result,
                section,
            )
            elapsed_ms = int((time.monotonic() - started) * 1000)
            trace.append(
                ToolTraceSummary(
                    tool="query_branch_messages",
                    query=section.section_id,
                    item_count=item_count,
                    elapsed_ms=elapsed_ms,
                )
            )
            history.append(
                "\n\n".join(
                    [
                        json.dumps(
                            {"action": action, "params": params, "iteration": iteration},
                            ensure_ascii=False,
                        ),
                        format_untrusted_text_block(
                            f"Tool result {iteration}",
                            tool_result,
                            max_chars=settings.REPORT_SECTION_CONTENT_MAX_CHARS,
                        ),
                    ]
                )
            )
            continue

        raise ResultReportBuilderError(f"Unsupported section action: {action or '<empty>'}")

    raise ResultReportBuilderError("Section generation exceeded tool budget")


def _load_builder_context(scenario_id: str, branch_id: str) -> BuilderContext:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise ResultReportBuilderError("Scenario not found")
        branch = session.get(Branch, branch_id)
        if branch is None or branch.scenario_id != scenario_id:
            raise ResultReportBuilderError("Dominant branch not found")
        parsed_context = (
            dict(scenario.parsed_context)
            if isinstance(scenario.parsed_context, dict)
            else {}
        )
        return BuilderContext(
            scenario_id=scenario_id,
            question=scenario.question or "",
            language=_detect_language(scenario.question or "", parsed_context),
            parsed_context=parsed_context,
            branch_id=branch.id,
            branch_title=branch.title or "Dominant branch",
            branch_story=branch.story or "",
            branch_insight=branch.insight or "",
            web_context_blocks=_safe_web_context_blocks(scenario.web_context_json),
        )


def _build_outline_prompt(context: BuilderContext, reducer_result: ReducerResult) -> str:
    evidence_digest = _evidence_digest(reducer_result, max_items=4)
    branch_distribution = json.dumps(
        reducer_result.branch_distribution[:5],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "\n\n".join(
        [
            "REPORT_OUTLINE",
            "Plan a SwarmOracle full report. Return strict JSON only.",
            "Choose 2-5 unique section ids from: "
            + ", ".join(_ALLOWED_SECTION_IDS)
            + ".",
            "Required JSON shape: "
            '{"title_i18n":{"zh":"...","en":"..."},'
            '"summary_i18n":{"zh":"...","en":"..."},'
            '"sections":[{"id":"timeline","title_i18n":{"zh":"...","en":"..."},'
            '"intent":"..."}]}',
            format_untrusted_text_block("User question", context.question, max_chars=1200),
            format_untrusted_text_block(
                "Dominant branch",
                json.dumps(
                    {
                        "title": context.branch_title,
                        "story": context.branch_story,
                        "insight": context.branch_insight,
                    },
                    ensure_ascii=False,
                ),
                max_chars=3000,
            ),
            format_untrusted_text_block(
                "Reducer branch distribution",
                branch_distribution,
                max_chars=2000,
            ),
            format_untrusted_text_block("Evidence digest", evidence_digest, max_chars=2400),
        ]
    )


def _build_section_prompt(
    context: BuilderContext,
    section: SectionPlan,
    reducer_result: ReducerResult,
    *,
    tier: SectionTier,
    history: list[str],
) -> str:
    evidence_digest = _evidence_digest(reducer_result, max_items=6)
    history_block = "\n\n".join(history[-settings.REPORT_MAX_TOOL_CALLS_PER_SECTION:])
    web_block = "\n\n".join(context.web_context_blocks[:3])
    return "\n\n".join(
        item
        for item in [
            "REPORT_SECTION_REACT",
            f"tier={tier}",
            "Use tools only by returning "
            '{"action":"query_branch_messages","params":{"query":"..."}}. '
            "Finish by returning "
            '{"action":"final_section","body_md_i18n":{"zh":"...","en":"..."},'
            '"evidence_refs":["ev_001"]}.',
            "Do not invent probabilities or evidence ids. Use reducer probability only.",
            format_untrusted_text_block("User question", context.question, max_chars=1200),
            format_untrusted_text_block(
                "Section plan",
                json.dumps(
                    {
                        "id": section.section_id,
                        "title_i18n": section.title_i18n,
                        "intent": section.intent,
                    },
                    ensure_ascii=False,
                ),
                max_chars=1200,
            ),
            format_untrusted_text_block(
                "Dominant branch story",
                context.branch_story or context.branch_insight,
                max_chars=settings.REPORT_SECTION_CONTENT_MAX_CHARS,
            ),
            format_untrusted_text_block("Reducer evidence", evidence_digest, max_chars=3000),
            web_block,
            format_untrusted_text_block("Tool history", history_block, max_chars=3000)
            if history_block
            else "",
        ]
        if item
    )


def _normalize_outline_payload(payload: dict[str, Any], context: BuilderContext) -> ReportOutline:
    title_i18n = _coerce_i18n(
        payload.get("title_i18n"),
        zh=f"{context.branch_title} 深读报告",
        en=f"{context.branch_title} report",
    )
    summary_i18n = _coerce_i18n(
        payload.get("summary_i18n"),
        zh=context.branch_insight or "报告基于已完成模拟与证据坐标生成。",
        en=context.branch_insight or "The report is based on completed simulation evidence.",
    )
    sections_raw = payload.get("sections")
    sections: list[SectionPlan] = []
    seen: set[str] = set()
    if isinstance(sections_raw, list):
        for raw in sections_raw:
            if not isinstance(raw, dict):
                continue
            section_id = str(raw.get("id") or "").strip()
            if section_id not in _ALLOWED_SECTION_IDS or section_id in seen:
                continue
            seen.add(section_id)
            sections.append(
                SectionPlan(
                    section_id=section_id,
                    title_i18n=_coerce_i18n(
                        raw.get("title_i18n"),
                        zh=_default_section_title(section_id, "zh"),
                        en=_default_section_title(section_id, "en"),
                    ),
                    intent=str(raw.get("intent") or "").strip()
                    or _default_section_intent(section_id),
                )
            )
            if len(sections) >= settings.REPORT_MAX_SECTIONS:
                break

    if len(sections) < settings.REPORT_MIN_SECTIONS:
        fallback = _fallback_outline(context, None)
        for section in fallback.sections:
            if section.section_id not in seen:
                sections.append(section)
                seen.add(section.section_id)
            if len(sections) >= settings.REPORT_MIN_SECTIONS:
                break
    return ReportOutline(
        title_i18n=title_i18n,
        summary_i18n=summary_i18n,
        sections=sections[: settings.REPORT_MAX_SECTIONS],
    )


def _fallback_outline(
    context: BuilderContext,
    reducer_result: ReducerResult | None,
) -> ReportOutline:
    candidate_ids = ["timeline", "sources", "conflicts"]
    if reducer_result is not None and reducer_result.dissenting is None:
        candidate_ids = ["timeline", "sources"]
    desired_count = min(
        settings.REPORT_MAX_SECTIONS,
        len(candidate_ids),
        max(2, settings.REPORT_MIN_SECTIONS),
    )
    section_ids = candidate_ids[:desired_count]
    return ReportOutline(
        title_i18n={
            "zh": f"{context.branch_title} 深读报告",
            "en": f"{context.branch_title} report",
        },
        summary_i18n={
            "zh": context.branch_insight or "报告基于已完成模拟与可追溯证据生成。",
            "en": context.branch_insight
            or "The report is based on completed simulation evidence.",
        },
        sections=[
            SectionPlan(
                section_id=section_id,
                title_i18n={
                    "zh": _default_section_title(section_id, "zh"),
                    "en": _default_section_title(section_id, "en"),
                },
                intent=_default_section_intent(section_id),
            )
            for section_id in section_ids
        ],
        fallback=True,
    )


def _section_result_from_payload(
    section: SectionPlan,
    payload: dict[str, Any],
    reducer_result: ReducerResult,
    *,
    tier: SectionTier,
    trace: list[ToolTraceSummary],
) -> SectionBuildResult:
    body_i18n = _coerce_i18n(
        payload.get("body_md_i18n"),
        zh="本章未能生成足够内容。",
        en="This section could not generate enough content.",
    )
    body_i18n = {
        "zh": _truncate_text(body_i18n["zh"], settings.REPORT_SECTION_CONTENT_MAX_CHARS),
        "en": _truncate_text(body_i18n["en"], settings.REPORT_SECTION_CONTENT_MAX_CHARS),
    }
    allowed_refs = {item.id for item in reducer_result.evidence}
    raw_refs = payload.get("evidence_refs")
    evidence_refs = [
        str(item)
        for item in (raw_refs if isinstance(raw_refs, list) else [])
        if str(item) in allowed_refs
    ]
    if not evidence_refs and reducer_result.evidence:
        evidence_refs = [reducer_result.evidence[0].id]
    report_section = ReportSection(
        id=section.section_id,
        title=section.title_i18n.get("en") or section.section_id,
        title_i18n=I18nText.model_validate(section.title_i18n),
        intent=section.intent,
        body_md_i18n=I18nText.model_validate(body_i18n),
        evidence_refs=evidence_refs[: settings.REPORT_MAX_EVIDENCE_PER_SECTION],
        charts=[],
    )
    return SectionBuildResult(section=report_section, tier=tier, tool_trace=trace)


def _static_section_from_context(
    context: BuilderContext,
    section: SectionPlan,
    reducer_result: ReducerResult,
) -> SectionBuildResult:
    probability = reducer_result.likelihood.probability
    evidence_refs = [item.id for item in reducer_result.evidence[:2]]
    fallback_body = (
        context.branch_insight
        or context.branch_story
        or "该章节只能基于现有结局摘要生成。"
    )
    fallback_body_en = (
        context.branch_insight
        or context.branch_story
        or "This section is based on the existing ending summary."
    )
    zh = (
        f"### {section.title_i18n.get('zh', section.section_id)}\n\n"
        f"{fallback_body}\n\n"
        f"主导路线概率为 {probability:.0%}。这只是叙事推演概率，不是真实预测。"
    )
    en = (
        f"### {section.title_i18n.get('en', section.section_id)}\n\n"
        f"{fallback_body_en}\n\n"
        f"The dominant route probability is {probability:.0%}. "
        "This is a narrative simulation probability, not a real-world forecast."
    )
    report_section = ReportSection(
        id=section.section_id,
        title=section.title_i18n.get("en") or section.section_id,
        title_i18n=I18nText.model_validate(section.title_i18n),
        intent=section.intent,
        body_md_i18n=I18nText(zh=zh, en=en),
        evidence_refs=evidence_refs,
        charts=[],
    )
    return SectionBuildResult(section=report_section, tier="static", tool_trace=[])


def _assemble_report(
    context: BuilderContext,
    reducer_result: ReducerResult,
    outline: ReportOutline,
    *,
    sections: list[ReportSection],
    status: ReportStatus,
    tier: ReportTier,
) -> FullReport:
    result_quality = (
        context.parsed_context.get("result_quality")
        if isinstance(context.parsed_context.get("result_quality"), dict)
        else {}
    )
    headline = str(result_quality.get("question_answer") or "").strip()
    if not headline:
        headline = str(result_quality.get("verdict") or "").strip()
    if not headline:
        headline = context.branch_insight or context.branch_title
    language = "zh" if context.language == "zh" else "en"
    title_i18n = I18nText.model_validate(outline.title_i18n)
    summary_i18n = I18nText.model_validate(outline.summary_i18n)
    report = FullReport(
        version="1.0",
        generated_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        generation_mode=tier,
        target_branch_id=context.branch_id,
        target_branch_sort=list(reducer_result.target_branch_sort),
        language=language,
        available_languages=["zh", "en"],
        title=getattr(title_i18n, language),
        title_i18n=title_i18n,
        summary=getattr(summary_i18n, language),
        summary_i18n=summary_i18n,
        status=status,
        tier=tier,
        verdict=Verdict(
            headline_answer=headline,
            likelihood=reducer_result.likelihood,
            analytic_confidence=reducer_result.analytic_confidence,
            disclaimer=_NARRATIVE_DISCLAIMER,
        ),
        sections=sections,
        evidence=_safe_evidence_refs(reducer_result),
        indicators_to_watch=_safe_indicators_to_watch(context, reducer_result),
        dissenting=reducer_result.dissenting,
        key_participants=reducer_result.key_participants,
        follow_ups=_follow_ups(context),
        limitations=(
            "Report content is generated from a bounded simulation transcript, "
            "deterministic reducer stats, and available evidence coordinates."
        ),
        interview_evidence=[],
        premortem=[],
        language_status=LanguageStatus(zh="available", en="available"),
    )
    return report


def _safe_indicators_to_watch(
    context: BuilderContext,
    reducer_result: ReducerResult,
) -> list[IndicatorToWatch]:
    try:
        return _build_indicators_to_watch(context, reducer_result)
    except Exception:  # noqa: BLE001 - S4 indicators must not fail the report
        logger.info("Result report indicators failed; leaving indicators_to_watch empty")
        return []


def _build_indicators_to_watch(
    context: BuilderContext,
    reducer_result: ReducerResult,
) -> list[IndicatorToWatch]:
    indicators: list[IndicatorToWatch] = []
    evidence_ids = {item.id for item in reducer_result.evidence}
    language = "zh" if context.language == "zh" else "en"

    for evidence in reducer_result.evidence[:2]:
        if language == "zh":
            signal = f"第 {evidence.round_number} 轮信号：{evidence.agent_name}"
            note = "如果这个信号持续出现，它会强化主导路线。"
            threshold = "同一议题被另一位参与者、后续轮次或后续来源再次提及。"
            observation = (
                f"第 {evidence.round_number} 轮，{evidence.agent_name}：\n"
                f"{format_untrusted_text_block('Agent 原话', evidence.quote, max_chars=140)}"
            )
            time_horizon = "下一次后续更新周期"
            rationale = f"由主导路线上的证据 {evidence.id} 支持。"
        else:
            signal = f"Round {evidence.round_number} signal from {evidence.agent_name}"
            note = "If this signal persists, it reinforces the dominant branch."
            threshold = (
                "The same issue is repeated by another participant, later round, "
                "or follow-up source."
            )
            observation = (
                f"Round {evidence.round_number}, {evidence.agent_name}:\n"
                f"{format_untrusted_text_block('Agent quote', evidence.quote, max_chars=140)}"
            )
            time_horizon = "next follow-up cycle"
            rationale = f"Supported by evidence {evidence.id} on the dominant branch."
        indicators.append(
            _indicator(
                signal=signal,
                direction="up",
                note=note,
                threshold=threshold,
                observation=observation,
                time_horizon=time_horizon,
                rationale=rationale,
                evidence_refs=[evidence.id],
                allowed_evidence_ids=evidence_ids,
                language=language,
            )
        )

    probability_indicator = _probability_gap_indicator(
        reducer_result,
        allowed_evidence_ids=evidence_ids,
        language=language,
    )
    if probability_indicator is not None:
        indicators.append(probability_indicator)

    stat_indicator = _stat_signal_indicator(
        reducer_result,
        allowed_evidence_ids=evidence_ids,
        language=language,
    )
    if stat_indicator is not None:
        indicators.append(stat_indicator)

    for fallback_signal in [
        context.branch_insight or context.branch_title,
        context.branch_title,
    ]:
        if len(indicators) >= 2:
            break
        if not str(fallback_signal or "").strip():
            continue
        indicators.append(
            _insufficient_evidence_indicator(
                fallback_signal,
                allowed_evidence_ids=evidence_ids,
                language=language,
            )
        )

    return indicators[:5]


def _insufficient_evidence_indicator(
    signal: str,
    *,
    allowed_evidence_ids: set[str],
    language: str,
) -> IndicatorToWatch:
    if language == "zh":
        note = "观察主导路线条件是否再次出现。"
        threshold = "后续更新用真实坐标重复该分支条件。"
        observation = "这个信号还没有可引用的消息级证据坐标。"
        time_horizon = "下一次后续更新周期"
        rationale = "还没有报告证据坐标支持这个指标。"
    else:
        note = "Watch whether the dominant branch condition appears again."
        threshold = "A later update repeats the branch condition with a real coordinate."
        observation = "No message-level evidence coordinate is available for this signal."
        time_horizon = "next follow-up cycle"
        rationale = "No report evidence coordinate supports this indicator yet."
    return _indicator(
        signal=signal,
        direction="up",
        note=note,
        threshold=threshold,
        observation=observation,
        time_horizon=time_horizon,
        rationale=rationale,
        evidence_refs=[],
        allowed_evidence_ids=allowed_evidence_ids,
        language=language,
    )


def _probability_gap_indicator(
    reducer_result: ReducerResult,
    *,
    allowed_evidence_ids: set[str],
    language: str,
) -> IndicatorToWatch | None:
    distribution = reducer_result.branch_distribution
    if len(distribution) < 2:
        return None
    dominant = distribution[0]
    runner_up = distribution[1]
    dominant_probability = _coerce_probability(dominant.get("probability"))
    runner_up_probability = _coerce_probability(runner_up.get("probability"))
    gap = max(0.0, dominant_probability - runner_up_probability)
    gap_points = int(round(gap * 100))
    if gap >= 0.15:
        if language == "zh":
            signal = f"主导路线领先至少 {gap_points} 个百分点"
            note = "稳定领先支持继续将主导路线视为更可能。"
            threshold = f"概率差距保持在 >= {gap_points} 个百分点。"
            observation = (
                f"统计归约的概率差距为 {gap_points} 个百分点"
                f"（{dominant_probability:.0%} 对 {runner_up_probability:.0%}）。"
            )
            time_horizon = "下一次报告刷新"
            rationale = "统计归约概率信号没有该指标专属的消息坐标。"
        else:
            signal = f"Dominant branch lead remains at least {gap_points} percentage points"
            note = "A stable lead supports keeping the dominant branch favored."
            threshold = f"Probability gap stays >= {gap_points} percentage points."
            observation = (
                f"Reducer probability gap is {gap_points} percentage points "
                f"({dominant_probability:.0%} vs {runner_up_probability:.0%})."
            )
            time_horizon = "next report refresh"
            rationale = (
                "Reducer probability signal has no indicator-specific message coordinate."
            )
        return _indicator(
            signal=signal,
            direction="up",
            note=note,
            threshold=threshold,
            observation=observation,
            time_horizon=time_horizon,
            rationale=rationale,
            evidence_refs=[],
            allowed_evidence_ids=allowed_evidence_ids,
            language=language,
        )
    if language == "zh":
        signal = "第二路线缩小概率差距"
        note = "差距收窄会让主导路线不那么稳固。"
        threshold = "概率差距降到 15 个百分点以下。"
        observation = (
            f"统计归约的概率差距当前为 {gap_points} 个百分点"
            f"（{dominant_probability:.0%} 对 {runner_up_probability:.0%}）。"
        )
        time_horizon = "下一次报告刷新"
        rationale = "统计归约概率信号没有该指标专属的消息坐标。"
    else:
        signal = "Runner-up branch closes the probability gap"
        note = "A narrower gap would make the dominant branch less secure."
        threshold = "Probability gap falls below 15 percentage points."
        observation = (
            f"Reducer probability gap is currently {gap_points} percentage points "
            f"({dominant_probability:.0%} vs {runner_up_probability:.0%})."
        )
        time_horizon = "next report refresh"
        rationale = "Reducer probability signal has no indicator-specific message coordinate."
    return _indicator(
        signal=signal,
        direction="down",
        note=note,
        threshold=threshold,
        observation=observation,
        time_horizon=time_horizon,
        rationale=rationale,
        evidence_refs=[],
        allowed_evidence_ids=allowed_evidence_ids,
        language=language,
    )


def _stat_signal_indicator(
    reducer_result: ReducerResult,
    *,
    allowed_evidence_ids: set[str],
    language: str,
) -> IndicatorToWatch | None:
    if (
        reducer_result.polarization.status in {"available", "partial"}
        and reducer_result.polarization.value is not None
    ):
        value = _coerce_probability(reducer_result.polarization.value)
        status = _stat_status_label(reducer_result.polarization.status, language)
        if language == "zh":
            signal = f"分歧度接近 {value:.0%}"
            note = "高分歧会削弱主导路线；低分歧支持稳定。"
            threshold = f"分歧度 {'>=' if value >= 0.55 else '<'} 55%。"
            observation = f"统计归约分歧度={value:.0%}，状态={status}。"
            time_horizon = "后续 1-2 轮模拟或下一次报告刷新"
            rationale = "统计归约分歧信号没有消息级证据坐标。"
        else:
            signal = f"Polarization remains near {value:.0%}"
            note = (
                "High polarization weakens the dominant branch; low polarization "
                "supports stability."
            )
            threshold = f"Polarization is {'>=' if value >= 0.55 else '<'} 55%."
            observation = (
                f"Reducer polarization={value:.0%} "
                f"status={reducer_result.polarization.status}."
            )
            time_horizon = "next 1-2 simulated rounds or report refresh"
            rationale = "Reducer polarization signal has no message-level evidence coordinate."
        return _indicator(
            signal=signal,
            direction="down" if value >= 0.55 else "up",
            note=note,
            threshold=threshold,
            observation=observation,
            time_horizon=time_horizon,
            rationale=rationale,
            evidence_refs=[],
            allowed_evidence_ids=allowed_evidence_ids,
            language=language,
        )
    if (
        reducer_result.agent_consensus.status in {"available", "partial"}
        and reducer_result.agent_consensus.value is not None
    ):
        value = _coerce_probability(reducer_result.agent_consensus.value)
        status = _stat_status_label(reducer_result.agent_consensus.status, language)
        if language == "zh":
            signal = f"角色共识接近 {value:.0%}"
            note = "共识变化会影响主导路线是否稳固。"
            threshold = f"角色共识保持 {'>=' if value >= 0.55 else '<'} 55%。"
            observation = f"统计归约角色共识={value:.0%}，状态={status}。"
            time_horizon = "后续 1-2 轮模拟或下一次报告刷新"
            rationale = "统计归约共识信号没有消息级证据坐标。"
        else:
            signal = f"Agent consensus remains near {value:.0%}"
            note = "Consensus changes whether the dominant branch remains robust."
            threshold = f"Agent consensus stays {'>=' if value >= 0.55 else '<'} 55%."
            observation = (
                f"Reducer agent_consensus={value:.0%} "
                f"status={reducer_result.agent_consensus.status}."
            )
            time_horizon = "next 1-2 simulated rounds or report refresh"
            rationale = "Reducer consensus signal has no message-level evidence coordinate."
        return _indicator(
            signal=signal,
            direction="up" if value >= 0.55 else "down",
            note=note,
            threshold=threshold,
            observation=observation,
            time_horizon=time_horizon,
            rationale=rationale,
            evidence_refs=[],
            allowed_evidence_ids=allowed_evidence_ids,
            language=language,
        )
    return None


def _stat_status_label(status: str, language: str) -> str:
    if language != "zh":
        return status
    return {
        "available": "可用",
        "partial": "部分可用",
        "missing": "缺失",
    }.get(status, status)


def _indicator(
    *,
    signal: str,
    direction: str,
    note: str,
    threshold: str,
    observation: str,
    time_horizon: str,
    rationale: str,
    evidence_refs: list[str],
    allowed_evidence_ids: set[str],
    language: str,
) -> IndicatorToWatch:
    valid_refs = [item for item in evidence_refs if item in allowed_evidence_ids]
    cleaned_rationale = _truncate_indicator_text(rationale, 280, language)
    prefix = "证据不足" if language == "zh" else "insufficient evidence"
    if not valid_refs and not _has_insufficient_evidence_prefix(
        cleaned_rationale,
        language,
    ):
        separator = "：" if language == "zh" else ": "
        cleaned_rationale = f"{prefix}{separator}{cleaned_rationale}"
    return IndicatorToWatch(
        signal=_truncate_indicator_text(signal, 160, language),
        direction="down" if direction == "down" else "up",
        note=_truncate_indicator_text(note, 180, language),
        threshold=_truncate_indicator_text(threshold, 180, language),
        observation=_truncate_indicator_text(observation, 260, language),
        time_horizon=_truncate_indicator_text(time_horizon, 120, language),
        rationale=cleaned_rationale,
        evidence_refs=valid_refs,
    )


def _has_insufficient_evidence_prefix(value: str, language: str) -> bool:
    if language == "zh":
        return "证据不足" in value
    return "insufficient evidence" in value.lower()


def _truncate_indicator_text(value: str, max_chars: int, language: str) -> str:
    cleaned = _scrub_sensitive_text(str(value or "").strip())
    if len(cleaned) <= max_chars:
        if cleaned:
            return cleaned
        return "暂不可用。" if language == "zh" else "Unavailable."
    suffix = "\n\n[已截断]" if language == "zh" else "\n\n[truncated]"
    return cleaned[: max(1, max_chars - len(suffix))].rstrip() + suffix


def _coerce_probability(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return min(1.0, max(0.0, number))


def _fit_report_to_byte_cap(report: FullReport) -> FullReport:
    max_bytes = settings.REPORT_FULL_REPORT_MAX_BYTES
    payload = report.model_dump(mode="json")
    if utf8_json_size_bytes(payload) <= max_bytes:
        return report

    payload["status"] = "partial" if payload.get("status") != "failed" else "failed"
    payload["summary"] = _truncate_text(str(payload.get("summary") or ""), 180)
    payload["summary_i18n"] = _truncate_i18n(payload.get("summary_i18n"), 180)
    payload["limitations"] = (
        "Report was truncated to fit the configured UTF-8 byte budget."
    )
    for item in payload.get("evidence") or []:
        if isinstance(item, dict):
            item["quote"] = _truncate_text(str(item.get("quote") or ""), 160)
    for section in payload.get("sections") or []:
        if isinstance(section, dict):
            section["body_md_i18n"] = _truncate_i18n(section.get("body_md_i18n"), 700)

    for body_limit in (420, 220, 120):
        if utf8_json_size_bytes(payload) <= max_bytes:
            return validate_full_report_payload(payload, max_bytes=max_bytes)
        for section in payload.get("sections") or []:
            if isinstance(section, dict):
                section["body_md_i18n"] = _truncate_i18n(
                    section.get("body_md_i18n"),
                    body_limit,
                )

    while payload.get("sections") and utf8_json_size_bytes(payload) > max_bytes:
        payload["sections"].pop()
    if utf8_json_size_bytes(payload) > max_bytes:
            payload["evidence"] = payload.get("evidence", [])[:1]
    return validate_full_report_payload(payload, max_bytes=max_bytes)


def _load_existing_full_report(scenario_id: str) -> FullReport | None:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None or not isinstance(scenario.parsed_context, dict):
            return None
        return _coerce_existing_full_report(scenario.parsed_context.get("full_report"))


def _coerce_existing_full_report(payload: object) -> FullReport | None:
    if not isinstance(payload, dict):
        return None
    try:
        return validate_full_report_payload(
            payload,
            max_bytes=max(settings.REPORT_FULL_REPORT_MAX_BYTES, 1),
        )
    except Exception:  # noqa: BLE001 - invalid stale payload should not block repair
        return None


def _persist_failed_report_if_absent(
    scenario_id: str,
    dominant_branch_id: str,
) -> FullReport:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise ResultReportBuilderError("Scenario not found while persisting failed report")

        parsed_context = (
            dict(scenario.parsed_context)
            if isinstance(scenario.parsed_context, dict)
            else {}
        )
        existing = _coerce_existing_full_report(parsed_context.get("full_report"))
        if existing is not None:
            return existing

        branch = _load_failed_report_branch(session, scenario_id, dominant_branch_id)
        payload = _failed_report_payload(scenario, parsed_context, branch, dominant_branch_id)
        parsed_context["full_report"] = payload
        scenario.parsed_context = parsed_context
        session.add(scenario)
        session.commit()
        return validate_full_report_payload(
            payload,
            max_bytes=max(settings.REPORT_FULL_REPORT_MAX_BYTES, 1),
        )


def _load_failed_report_branch(
    session: Session,
    scenario_id: str,
    dominant_branch_id: str,
) -> Branch | None:
    if dominant_branch_id:
        branch = session.get(Branch, dominant_branch_id)
        if branch is not None and branch.scenario_id == scenario_id:
            return branch

    branches = session.exec(
        select(Branch)
        .where(
            Branch.scenario_id == scenario_id,
            Branch.status == BranchStatus.COMPLETED,
        )
        .order_by(Branch.probability.desc(), Branch.fork_round.asc(), Branch.id.asc())
    ).all()
    if not branches:
        branches = session.exec(
            select(Branch)
            .where(Branch.scenario_id == scenario_id)
            .order_by(Branch.probability.desc(), Branch.fork_round.asc(), Branch.id.asc())
        ).all()
    return branches[0] if branches else None


def _failed_report_payload(
    scenario: Scenario,
    parsed_context: dict[str, Any],
    branch: Branch | None,
    dominant_branch_id: str,
) -> dict[str, Any]:
    language = _detect_language(scenario.question or "", parsed_context)
    target_branch_id = branch.id if branch is not None else (dominant_branch_id or scenario.id)
    probability = _clamp_probability(branch.probability if branch is not None else 0.0)
    title_i18n = I18nText(
        zh="深读报告暂未生成",
        en="Deep-read report unavailable",
    )
    summary_i18n = I18nText(
        zh="报告生成失败，模拟结果仍可正常查看。",
        en="Report generation failed; the simulation result remains available.",
    )
    report = FullReport(
        version="1.0",
        generated_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        generation_mode="static",
        target_branch_id=target_branch_id,
        target_branch_sort=list(TARGET_BRANCH_SORT),
        language=language,
        available_languages=["zh", "en"],
        title=getattr(title_i18n, language),
        title_i18n=title_i18n,
        summary=getattr(summary_i18n, language),
        summary_i18n=summary_i18n,
        status="failed",
        tier="static",
        verdict=Verdict(
            headline_answer=(
                "报告生成失败，未能生成可展示章节。"
                if language == "zh"
                else "Report generation failed before renderable sections were produced."
            ),
            likelihood=Likelihood(
                probability=probability,
                interval=(probability, probability),
                wep="unavailable",
            ),
            analytic_confidence=AnalyticConfidence(
                level="low",
                basis="The report builder failed before producing a renderable report.",
            ),
            disclaimer=_NARRATIVE_DISCLAIMER,
        ),
        sections=[],
        evidence=[],
        indicators_to_watch=[],
        dissenting=None,
        key_participants=[],
        follow_ups=[],
        limitations=(
            "Report generation failed before any renderable section could be produced. "
            "Existing simulation results remain available."
        ),
        interview_evidence=[],
        premortem=[],
        language_status=LanguageStatus(zh="available", en="available"),
    )
    return _fit_report_to_byte_cap(report).model_dump(mode="json")


def _clamp_probability(value: float | int | None) -> float:
    try:
        probability = float(value)
    except (TypeError, ValueError):
        return 0.0
    return min(1.0, max(0.0, probability))


def _persist_report_payload(scenario_id: str, payload: dict[str, Any]) -> None:
    validate_full_report_payload(
        payload,
        max_bytes=max(settings.REPORT_FULL_REPORT_MAX_BYTES, 1),
    )
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise ResultReportBuilderError("Scenario not found while persisting report")
        parsed_context = (
            dict(scenario.parsed_context)
            if isinstance(scenario.parsed_context, dict)
            else {}
        )
        parsed_context["full_report"] = payload
        scenario.parsed_context = parsed_context
        session.add(scenario)
        session.commit()


def _tool_query_branch_messages(
    context: BuilderContext,
    reducer_result: ReducerResult,
    section: SectionPlan,
) -> tuple[str, int]:
    rows: list[dict[str, Any]] = []
    for evidence in reducer_result.evidence[: settings.REPORT_MAX_EVIDENCE_PER_SECTION]:
        rows.append(
            {
                "id": evidence.id,
                "branch_id": evidence.branch_id,
                "round_id": evidence.round_id,
                "round_number": evidence.round_number,
                "agent_id": evidence.agent_id,
                "agent_name": evidence.agent_name,
                "message_id": evidence.message_id,
                "quote": format_untrusted_text_block(
                    "Evidence quote",
                    evidence.quote,
                    max_chars=settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS,
                ),
            }
        )
    return json.dumps(
        {
            "section_id": section.section_id,
            "target_branch_id": context.branch_id,
            "evidence": rows,
        },
        ensure_ascii=False,
    ), len(rows)


def _safe_web_context_blocks(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return []
    snippets = payload.get("snippets") if isinstance(payload, dict) else None
    if not isinstance(snippets, list):
        return []
    blocks: list[str] = []
    for index, item in enumerate(snippets[:3], 1):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        safe_url = _sanitize_url(str(item.get("source_url") or ""))
        if not text:
            continue
        blocks.append(
            format_untrusted_text_block(
                f"Web source {index}",
                f"{text}\nSource: {safe_url}" if safe_url else text,
                max_chars=900,
            )
        )
    return blocks


def _evidence_digest(reducer_result: ReducerResult, *, max_items: int) -> str:
    rows = []
    for evidence in reducer_result.evidence[:max_items]:
        rows.append(
            {
                "id": evidence.id,
                "round_id": evidence.round_id,
                "round_number": evidence.round_number,
                "branch_id": evidence.branch_id,
                "agent_id": evidence.agent_id,
                "agent_name": evidence.agent_name,
                "message_id": evidence.message_id,
                "quote": _scrub_sensitive_text(
                    evidence.quote[: settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS],
                ),
            }
        )
    return json.dumps(rows, ensure_ascii=False, separators=(",", ":"))


def _normalize_overrides(
    overrides: Mapping[str, Any] | ReportGenerationOverrides | None,
) -> ReportGenerationOverrides | None:
    if overrides is None:
        return None
    if isinstance(overrides, ReportGenerationOverrides):
        return overrides
    temperature = overrides.get("temperature")
    try:
        normalized_temperature = (
            float(temperature) if temperature is not None else None
        )
    except (TypeError, ValueError):
        normalized_temperature = None
    return ReportGenerationOverrides(
        api_key=str(overrides.get("api_key") or "") or None,
        base_url=str(overrides.get("base_url") or "") or None,
        model=str(overrides.get("model") or "") or None,
        temperature=normalized_temperature,
    )


def _coerce_i18n(value: Any, *, zh: str, en: str) -> dict[str, str]:
    if isinstance(value, dict):
        zh_value = _scrub_sensitive_text(str(value.get("zh") or "").strip())
        en_value = _scrub_sensitive_text(str(value.get("en") or "").strip())
        return {
            "zh": zh_value or _scrub_sensitive_text(zh),
            "en": en_value or _scrub_sensitive_text(en),
        }
    return {"zh": _scrub_sensitive_text(zh), "en": _scrub_sensitive_text(en)}


def _truncate_i18n(value: Any, max_chars: int) -> dict[str, str]:
    coerced = _coerce_i18n(value, zh="", en="")
    return {
        "zh": _truncate_text(coerced["zh"], max_chars),
        "en": _truncate_text(coerced["en"], max_chars),
    }


def _truncate_text(value: str, max_chars: int) -> str:
    cleaned = _scrub_sensitive_text(str(value or "").strip())
    if len(cleaned) <= max_chars:
        return cleaned or "Unavailable."
    return cleaned[: max(1, max_chars - 18)].rstrip() + "\n\n[truncated]"


def _detect_language(question: str, parsed_context: dict[str, Any]) -> str:
    explicit = str(parsed_context.get("_language") or "").lower()
    if explicit.startswith("zh") or "chinese" in explicit:
        return "zh"
    if explicit.startswith("en") or "english" in explicit:
        return "en"
    return "zh" if any("\u4e00" <= char <= "\u9fff" for char in question) else "en"


def _default_section_title(section_id: str, language: str) -> str:
    zh = {
        "timeline": "关键转折",
        "factions": "阵营结构",
        "conflicts": "核心冲突",
        "premortem": "失败预演",
        "indicators": "后续信号",
        "sources": "证据来源",
    }
    en = {
        "timeline": "Turning points",
        "factions": "Faction structure",
        "conflicts": "Core conflicts",
        "premortem": "Premortem",
        "indicators": "Signals to watch",
        "sources": "Evidence sources",
    }
    return (zh if language == "zh" else en).get(section_id, section_id)


def _default_section_intent(section_id: str) -> str:
    return {
        "timeline": "Explain why the dominant branch won.",
        "factions": "Describe participant alignment and coalition shape.",
        "conflicts": "Explain the strongest tension in the branch.",
        "premortem": "Describe how this verdict could fail.",
        "indicators": "Name follow-up signals without real-world overclaiming.",
        "sources": "Summarize which simulated evidence supports the report.",
    }.get(section_id, "Explain the section from available evidence.")


def _looks_like_final_section(payload: dict[str, Any]) -> bool:
    return payload.get("action") == "final_section" or "body_md_i18n" in payload


def _worst_tier(tiers: list[SectionTier]) -> ReportTier:
    if not tiers:
        return "static"
    return max(tiers, key=lambda item: _TIER_ORDER[item])


def _status_for_sections(*, completed: int, failed: int, total: int) -> ReportStatus:
    if total <= 0 or completed == 0 and failed > 0:
        return "failed"
    if completed >= total and failed == 0:
        return "complete"
    return "partial"


def _follow_ups(context: BuilderContext) -> list[str]:
    if context.language == "zh":
        return ["哪些证据最可能推翻这条主导路线？"]
    return ["Which evidence would most likely overturn this dominant route?"]


def _safe_error_message(exc: Exception | None) -> str:
    if exc is None:
        return "Report generation failed"
    text = str(exc).strip() or exc.__class__.__name__
    text = _scrub_sensitive_text(text)
    return _truncate_text(text, 160)


def _safe_evidence_refs(reducer_result: ReducerResult):
    refs = []
    for evidence in reducer_result.evidence:
        refs.append(
            evidence.model_copy(
                update={
                    "quote": _truncate_text(
                        evidence.quote,
                        settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS,
                    )
                }
            )
        )
    return refs


async def _emit_progress(
    progress: ProgressCallback | None,
    event: ResultReportSSEEvent,
) -> None:
    if progress is None:
        return
    result = progress(event)
    if inspect.isawaitable(result):
        await result
