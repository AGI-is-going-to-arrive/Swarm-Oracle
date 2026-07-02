"""Fail-soft builder for ``Scenario.parsed_context.full_report``."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import case, func, update
from sqlmodel import Session, select

from app.config import settings
from app.log_sanitize import _scrub_sensitive_text
from app.models import Agent, AgentMessage, Branch, BranchStatus, Round, Scenario
from app.models.database import get_engine
from app.services.llm_client import (
    format_untrusted_text_block,
    is_local_provider_url,
    llm_call_json,
    llm_request_scope,
    normalize_native_search_upstream,
)
from app.services.result_report.reducer import TARGET_BRANCH_SORT, ReducerResult
from app.services.result_report.reducer import reduce as reduce_report
from app.services.result_report.schema import (
    AnalyticConfidence,
    Chart,
    FullReport,
    I18nText,
    IndicatorToWatch,
    InterviewStatus,
    LanguageStatus,
    Likelihood,
    ReportSection,
    ReportStatus,
    ReportTier,
    ResultReportSSEEvent,
    SectionFailureReason,
    SectionTier,
    ToolTraceSummary,
    Verdict,
    encode_sse_event,
    utf8_json_size_bytes,
    validate_full_report_payload,
)
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    refresh_runtime_lock,
    release_runtime_lock,
    runtime_lock_is_active,
)
from app.services.web_context import _sanitize_url

logger = logging.getLogger(__name__)

# ``SectionTier`` / ``SectionFailureReason`` are imported from schema so the
# per-section observability contract (S9) stays single-sourced.
ProgressCallback = Callable[[ResultReportSSEEvent], Awaitable[None] | None]

_ALLOWED_SECTION_IDS = (
    "timeline",
    "factions",
    "conflicts",
    "premortem",
    "indicators",
    "sources",
)
_CHART_SECTION_PREFERENCES: dict[str, tuple[str, ...]] = {
    "probability_bar": ("timeline", "indicators", "sources", "factions", "conflicts"),
    "faction_share": ("factions", "conflicts", "timeline", "sources", "indicators"),
}
_TIER_ORDER: dict[SectionTier, int] = {"generation": 0, "rewrite": 1, "static": 2}
_REPORT_LOCKS: dict[str, asyncio.Lock] = {}
_SSE_HEARTBEAT_INTERVAL_SECONDS = 15.0
_REPORT_RUNTIME_LOCK_REFRESH_FRACTION = 0.4
_REPORT_RUNTIME_LOCK_MAX_REFRESH_INTERVAL_SECONDS = 15.0
_AUTO_REPORT_MAX_ATTEMPTS = 3
_AUTO_REPORT_RETRY_BASE_DELAY_SECONDS = 1.0
_AUTO_REPORT_RETRY_MAX_DELAY_SECONDS = 8.0
_INTERVIEW_AGENT_BUDGET = 3
_INTERVIEW_CANDIDATE_LIMIT = 8
_INTERVIEW_EVIDENCE_PER_AGENT_CAP = 5


@dataclass(frozen=True, slots=True)
class ReportGenerationOverrides:
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    quota_user_id: str | None = None
    requests_per_minute: int | None = None
    tokens_per_minute: int | None = None
    concurrency: int | None = None
    supports_structured_outputs_override: bool | None = None
    supports_native_search_override: bool | None = None
    native_search_upstream_override: str | None = None
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


@dataclass(frozen=True, slots=True)
class InterviewCandidate:
    branch_index: int
    round_number: int
    agent_name: str
    persona: str
    excerpt: str


class ResultReportBuilderError(RuntimeError):
    """Raised for build-time failures that should stay local to the report."""

    def __init__(self, *args: object, reason: SectionFailureReason | None = None) -> None:
        super().__init__(*args)
        # Optional structured failure classification (S9) so the section
        # fallback path can surface *why* it dropped to the static tier.
        self.reason = reason


class ResultReportAlreadyRunningError(ResultReportBuilderError):
    """Raised when another worker already owns the report generation lease."""


class ResultReportRuntimeLockLostError(ResultReportBuilderError):
    """Raised when report generation no longer owns its durable lease."""


def _classify_section_failure(exc: BaseException | None) -> SectionFailureReason:
    """Map a section-generation exception to a structured failure reason (S9)."""

    if exc is None:
        return "other"
    if isinstance(exc, TimeoutError | asyncio.TimeoutError):
        return "timeout"
    reason = getattr(exc, "reason", None)
    if reason is not None:
        return reason
    return "other"


def _report_runtime_lock_key(scenario_id: str) -> str:
    return f"result-report:{scenario_id}"


def report_generation_is_active(scenario_id: str) -> bool:
    """Return whether a visible ``generating`` report still has a live lease."""

    return runtime_lock_is_active(_report_runtime_lock_key(scenario_id))


def _drop_report_lock_if_idle(scenario_id: str, lock: asyncio.Lock) -> None:
    if lock.locked():
        return
    waiters = getattr(lock, "_waiters", None)
    if waiters:
        return
    if _REPORT_LOCKS.get(scenario_id) is lock:
        _REPORT_LOCKS.pop(scenario_id, None)


def _report_runtime_lock_lease_seconds() -> float:
    return max(0.01, float(settings.REPORT_RUNTIME_LOCK_LEASE_SECONDS))


def _report_runtime_lock_refresh_interval(
    lease: RuntimeLockLease | None,
    *,
    lease_seconds: float,
) -> float:
    remaining_seconds = max(0.01, float(lease_seconds))
    if lease is not None:
        remaining_seconds = max(0.01, lease.expires_at - time.time())
    return max(
        0.01,
        min(
            _REPORT_RUNTIME_LOCK_MAX_REFRESH_INTERVAL_SECONDS,
            min(float(lease_seconds), remaining_seconds)
            * _REPORT_RUNTIME_LOCK_REFRESH_FRACTION,
        ),
    )


def _report_runtime_lock_is_alive(
    lease_holder: list[RuntimeLockLease | None] | None,
) -> bool:
    if lease_holder is None:
        return True
    lease = lease_holder[0]
    return lease is not None and lease.expires_at > time.time()


def _ensure_report_runtime_lock_alive(
    lease_holder: list[RuntimeLockLease | None] | None,
) -> None:
    if not _report_runtime_lock_is_alive(lease_holder):
        raise ResultReportRuntimeLockLostError("Result report runtime lock was lost")


async def _run_report_runtime_lock_heartbeat(
    lease_holder: list[RuntimeLockLease | None],
    *,
    lease_seconds: float,
) -> None:
    while True:
        current_lease = lease_holder[0]
        if current_lease is None:
            return
        refresh_interval = _report_runtime_lock_refresh_interval(
            current_lease,
            lease_seconds=lease_seconds,
        )
        await asyncio.sleep(refresh_interval)
        current_lease = lease_holder[0]
        if current_lease is None:
            return
        if current_lease.expires_at <= time.time():
            lease_holder[0] = None
            logger.warning("Result report runtime lock lease expired before refresh")
            return
        try:
            refreshed = await asyncio.to_thread(
                refresh_runtime_lock,
                current_lease,
                lease_seconds=lease_seconds,
            )
        except Exception:  # noqa: BLE001 - lock loss must stop report writes
            lease_holder[0] = None
            logger.exception("Result report runtime lock lease refresh failed")
            return
        if refreshed is None:
            lease_holder[0] = None
            logger.warning("Result report runtime lock lease could not be refreshed")
            return
        lease_holder[0] = refreshed


def _report_sse_stall_timeout_seconds() -> float:
    """Maximum visible silence before a manual SSE retry fails closed."""

    timed_calls_per_tier = min(max(settings.REPORT_MAX_TOOL_CALLS_PER_SECTION, 1), 2)
    section_silence_budget = (
        timed_calls_per_tier
        * max(settings.REPORT_SECTION_TIMEOUT_SECONDS, 0.01)
        * 2
    )
    return max(
        _report_runtime_lock_lease_seconds() + 5.0,
        max(settings.REPORT_PLAN_TIMEOUT_SECONDS, 0.01)
        + section_silence_budget
        + 5.0,
    )


def _report_llm_scope_kwargs(
    context: BuilderContext,
    overrides: ReportGenerationOverrides | None,
) -> dict[str, object]:
    scope_kwargs: dict[str, object] = {"purpose": "result_report"}
    parsed_context = context.parsed_context if isinstance(context.parsed_context, dict) else {}
    effective_base_url = (
        (overrides.base_url if overrides else None)
        or parsed_context.get("llm_base_url")
    )
    user_id = (overrides.quota_user_id if overrides else None) or parsed_context.get(
        "user_id"
    )
    disable_user_quota = bool(parsed_context.get("disable_user_quota"))
    if disable_user_quota and is_local_provider_url(effective_base_url):
        scope_kwargs["quota_key"] = None
    elif user_id:
        scope_kwargs["quota_key"] = f"user:{user_id}"
    scope_kwargs["requests_per_minute"] = (
        overrides.requests_per_minute
        if overrides and overrides.requests_per_minute is not None
        else parsed_context.get("llm_requests_per_minute")
    )
    scope_kwargs["tokens_per_minute"] = (
        overrides.tokens_per_minute
        if overrides and overrides.tokens_per_minute is not None
        else parsed_context.get("llm_tokens_per_minute")
    )
    scope_kwargs["concurrency"] = (
        overrides.concurrency
        if overrides and overrides.concurrency is not None
        else parsed_context.get("llm_concurrency")
    )
    scope_kwargs["supports_structured_outputs_override"] = (
        overrides.supports_structured_outputs_override
        if overrides and overrides.supports_structured_outputs_override is not None
        else _normalize_optional_bool(parsed_context.get("supports_structured_outputs"))
    )
    scope_kwargs["supports_native_search_override"] = (
        overrides.supports_native_search_override
        if overrides and overrides.supports_native_search_override is not None
        else _normalize_optional_bool(parsed_context.get("supports_native_search"))
    )
    scope_kwargs["native_search_upstream_override"] = (
        overrides.native_search_upstream_override
        if overrides and overrides.native_search_upstream_override is not None
        else _normalize_native_search_upstream(parsed_context.get("native_search_upstream"))
    )
    return scope_kwargs


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
    try:
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
            lease_holder: list[RuntimeLockLease | None] = [lease]
            heartbeat_task = asyncio.create_task(
                _run_report_runtime_lock_heartbeat(
                    lease_holder,
                    lease_seconds=lease_seconds,
                ),
                name=f"result-report-runtime-lock:{scenario_id}",
            )

            try:
                return await _build_report_unlocked(
                    scenario_id,
                    dominant_branch_id,
                    overrides=normalized_overrides,
                    progress=progress,
                    report_lock_holder=lease_holder,
                )
            except Exception:  # noqa: BLE001 - fail-soft marker before releasing lease
                if _report_runtime_lock_is_alive(lease_holder):
                    try:
                        await asyncio.to_thread(
                            _persist_failed_report_if_absent,
                            scenario_id,
                            dominant_branch_id,
                        )
                    except Exception:  # noqa: BLE001 - preserve original builder error
                        logger.warning("Failed to persist result report failure marker")
                else:
                    logger.warning(
                        "Skipping result report failure marker after runtime lock loss"
                    )
                raise
            finally:
                heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await heartbeat_task
                try:
                    await asyncio.to_thread(release_runtime_lock, lease_holder[0])
                except Exception:  # noqa: BLE001 - do not mask the report outcome
                    logger.warning("Failed to release result report runtime lock")
    finally:
        _drop_report_lock_if_idle(scenario_id, lock)


async def _build_report_unlocked(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    overrides: ReportGenerationOverrides | None,
    progress: ProgressCallback | None,
    report_lock_holder: list[RuntimeLockLease | None] | None = None,
) -> FullReport:
    engine = get_engine()
    reducer_result = await asyncio.to_thread(
        reduce_report,
        engine,
        scenario_id,
        max_evidence=settings.REPORT_MAX_EVIDENCE_PER_SECTION,
        dominant_branch_id=dominant_branch_id,
    )
    # M-1 (W1-1 follow-up): defer to the reducer's resolved anchor. ``_pick_target``
    # already rejected a content-less dominant leaf and chose a viable
    # content-bearing leaf; honoring it here keeps the header / builder context /
    # evidence-reuse key all on the same branch the reducer anchored evidence,
    # confidence, and dissent on. Only fall back to the raw endpoint dominant id
    # when the reducer produced none (degenerate single/empty-branch shapes).
    target_branch_id = reducer_result.target_branch_id or dominant_branch_id
    if not target_branch_id:
        raise ResultReportBuilderError("No dominant branch is available")

    context = await asyncio.to_thread(_load_builder_context, scenario_id, target_branch_id)
    outline = await plan_outline(
        context,
        reducer_result,
        overrides=overrides,
    )
    reusable_sections, reusable_tiers = _reusable_existing_sections(
        scenario_id,
        target_branch_id,
        outline,
    )
    completed_sections: list[ReportSection] = list(reusable_sections)
    section_tiers: list[SectionTier] = list(reusable_tiers)
    failed_sections = 0
    report = _assemble_report(
        context,
        reducer_result,
        outline,
        sections=completed_sections,
        status="generating",
        tier=_worst_tier(section_tiers) if completed_sections else "generation",
    )
    report = _fit_report_to_byte_cap(report)
    _ensure_report_runtime_lock_alive(report_lock_holder)
    _persist_report_payload(scenario_id, report.model_dump(mode="json"))

    reused_section_ids = {section.id for section in reusable_sections}

    for section_plan in outline.sections:
        _ensure_report_runtime_lock_alive(report_lock_holder)
        if section_plan.section_id in reused_section_ids:
            continue
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
            _ensure_report_runtime_lock_alive(report_lock_holder)
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
        _ensure_report_runtime_lock_alive(report_lock_holder)
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
    final_tier = _worst_tier(section_tiers)
    final_sections = completed_sections
    if final_status == "failed" and not completed_sections and outline.sections:
        final_sections = _outline_failure_placeholder_sections(outline)
    llm_indicators: list[IndicatorToWatch] | None = None
    if final_status == "failed":
        interview_evidence: list[dict[str, Any]] = []
        interview_status = InterviewStatus(
            status="skipped",
            requested_agents=0,
            completed_agents=0,
            truncated_agents=0,
            message="Report sections failed before interviews could run.",
        )
    else:
        # M-2: the interview-evidence and indicators-to-watch LLM calls share no
        # state (indicators does not consume interview_evidence; both take the same
        # inputs) and both are independently fail-soft, so run them concurrently to
        # reclaim one serial LLM round-trip on the success path. Concurrency is safe
        # because the LLM scope and native-citation state are ContextVars
        # (llm_client._REQUEST_CONTEXT / _last_native_citations); asyncio copies the
        # context per Task, so each gathered coroutine gets an isolated copy with no
        # cross-contamination. return_exceptions keeps one failure from aborting the
        # whole report — a raised error degrades to the same skipped/None tiers the
        # failed path uses.
        interview_result, indicators_result = await asyncio.gather(
            _build_interview_evidence(context, reducer_result, overrides=overrides),
            _build_indicators_llm(context, reducer_result, overrides=overrides),
            return_exceptions=True,
        )
        if isinstance(interview_result, BaseException):
            logger.warning(
                "Result report interview evidence failed concurrently: %s",
                _safe_error_message(
                    interview_result
                    if isinstance(interview_result, Exception)
                    else None
                ),
            )
            interview_evidence = []
            interview_status = InterviewStatus(
                status="skipped",
                requested_agents=0,
                completed_agents=0,
                truncated_agents=0,
                message="Interview evidence generation failed.",
            )
        else:
            interview_evidence, interview_status = interview_result
        if isinstance(indicators_result, BaseException):
            logger.warning(
                "Result report indicators generation failed concurrently: %s",
                _safe_error_message(
                    indicators_result
                    if isinstance(indicators_result, Exception)
                    else None
                ),
            )
            llm_indicators = None
        else:
            llm_indicators = indicators_result
    report = _assemble_report(
        context,
        reducer_result,
        outline,
        sections=final_sections,
        status=final_status,
        tier=final_tier,
        interview_evidence=interview_evidence,
        interview_status=interview_status,
        indicators_to_watch=llm_indicators,
    )
    report = _fit_report_to_byte_cap(report)
    _ensure_report_runtime_lock_alive(report_lock_holder)
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

    max_attempts = _auto_report_max_attempts()
    for attempt in range(1, max_attempts + 1):
        try:
            report = await build_report(
                scenario_id,
                dominant_branch_id,
                overrides=overrides,
                progress=progress,
            )
        except ResultReportAlreadyRunningError:
            logger.info("Result report generation skipped because another worker owns the lease")
            return await asyncio.to_thread(_load_existing_full_report, scenario_id)
        except ResultReportRuntimeLockLostError:
            logger.info("Result report generation stopped after losing the runtime lock")
            return await asyncio.to_thread(_load_existing_full_report, scenario_id)
        except Exception as exc:  # noqa: BLE001 - auto report generation is best-effort
            if attempt < max_attempts:
                logger.info(
                    "Result report generation failed on attempt %d/%d; retrying: %s",
                    attempt,
                    max_attempts,
                    type(exc).__name__,
                )
                await _prepare_auto_report_retry(
                    scenario_id,
                    dominant_branch_id,
                    attempt=attempt,
                )
                continue
            logger.info(
                "Result report generation failed after %d attempts; ensuring failed marker: %s",
                max_attempts,
                type(exc).__name__,
            )
            try:
                return await asyncio.to_thread(
                    _persist_failed_report_if_lock_available,
                    scenario_id,
                    dominant_branch_id,
                )
            except Exception:  # noqa: BLE001 - simulator completion must stay fail-soft
                logger.warning("Failed to persist result report failure marker")
                return None

        if not _auto_report_should_retry(report):
            return report
        if attempt >= max_attempts:
            return await _finalize_auto_report_retry_exhausted(
                scenario_id,
                dominant_branch_id,
                fallback_report=report,
            )
        logger.info(
            "Result report generation produced failed report on attempt %d/%d; retrying",
            attempt,
            max_attempts,
        )
        await _prepare_auto_report_retry(
            scenario_id,
            dominant_branch_id,
            attempt=attempt,
        )
    return await asyncio.to_thread(_load_existing_full_report, scenario_id)


def _auto_report_max_attempts() -> int:
    return max(1, _AUTO_REPORT_MAX_ATTEMPTS)


def _auto_report_retry_delay_seconds(attempt: int) -> float:
    delay = _AUTO_REPORT_RETRY_BASE_DELAY_SECONDS * (2 ** max(0, attempt - 1))
    return min(_AUTO_REPORT_RETRY_MAX_DELAY_SECONDS, max(0.0, delay))


def _auto_report_should_retry(report: FullReport | None) -> bool:
    if report is None:
        return True
    if report.status in {"failed", "generating"}:
        return True
    return not _report_has_llm_enhanced_sections(report)


def _report_has_llm_enhanced_sections(report: FullReport) -> bool:
    return any(section.tier in {"generation", "rewrite"} for section in report.sections)


async def _finalize_auto_report_retry_exhausted(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    fallback_report: FullReport | None,
) -> FullReport | None:
    try:
        failed = await asyncio.to_thread(
            _persist_failed_report_after_auto_retry_exhausted,
            scenario_id,
            dominant_branch_id,
        )
        return failed or fallback_report
    except Exception:  # noqa: BLE001 - simulator completion must stay fail-soft
        logger.warning("Failed to persist exhausted result report retry marker")
        return fallback_report


async def _prepare_auto_report_retry(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    attempt: int,
) -> None:
    try:
        await asyncio.to_thread(
            _persist_generating_report_placeholder_for_retry,
            scenario_id,
            dominant_branch_id,
        )
    except Exception:  # noqa: BLE001 - retry should proceed even if marker repair fails
        logger.warning("Failed to restore result report retry placeholder")
    delay = _auto_report_retry_delay_seconds(attempt)
    if delay > 0:
        await asyncio.sleep(delay)


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
    last_heartbeat = time.monotonic()
    last_progress = last_heartbeat
    stall_timeout_seconds = _report_sse_stall_timeout_seconds()

    try:
        while not task.done() or not queue.empty():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=0.05)
            except TimeoutError:
                now = time.monotonic()
                if not task.done() and now - last_progress >= stall_timeout_seconds:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                    with contextlib.suppress(Exception):
                        await asyncio.to_thread(
                            _persist_failed_report_if_lock_available,
                            scenario_id,
                            dominant_branch_id,
                        )
                    yield encode_sse_event(
                        ResultReportSSEEvent(
                            event="report_failed",
                            data={
                                "report_id": scenario_id,
                                "status": "failed",
                                "error_code": "REPORT_TIMEOUT",
                                "message": "Result report generation timed out",
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
                if now - last_heartbeat >= _SSE_HEARTBEAT_INTERVAL_SECONDS:
                    last_heartbeat = now
                    yield ": keepalive\n\n"
                continue
            last_progress = time.monotonic()
            yield encode_sse_event(event)

        try:
            report = await task
        except ResultReportAlreadyRunningError:
            yield encode_sse_event(
                ResultReportSSEEvent(
                    event="report_failed",
                    data={
                        "report_id": scenario_id,
                        "status": "failed",
                        "error_code": "REPORT_ALREADY_RUNNING",
                        "message": "Result report generation is already running",
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
        with llm_request_scope(**_report_llm_scope_kwargs(context, overrides)):
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
    except Exception as exc:  # noqa: BLE001 - plan fallback must not abort
        outline_reason: SectionFailureReason = _classify_section_failure(exc)
        if outline_reason == "timeout":
            outline_reason = "plan_outline_timeout"
        logger.warning(
            "Result report outline planning failed; using fallback outline (reason=%s)",
            outline_reason,
        )
        return _fallback_outline(context, reducer_result)


async def generate_section_react(
    context: BuilderContext,
    section: SectionPlan,
    reducer_result: ReducerResult,
    *,
    overrides: ReportGenerationOverrides | None,
) -> SectionBuildResult:
    """Generate one section using a bounded ReACT-style tool loop."""

    # Track the most recent LLM-tier failure so the static fallback can report
    # *why* it had to drop offline (S9 observability).
    failure_reason: SectionFailureReason = "other"
    try:
        return await _generate_section_tier(
            context,
            section,
            reducer_result,
            overrides=overrides,
            tier="generation",
        )
    except Exception as exc:  # noqa: BLE001 - classify then fall through to rewrite
        failure_reason = _classify_section_failure(exc)
        logger.info(
            "Result report section '%s' generation tier failed (reason=%s)",
            section.section_id,
            failure_reason,
        )
    try:
        return await _generate_section_tier(
            context,
            section,
            reducer_result,
            overrides=overrides,
            tier="rewrite",
        )
    except Exception as exc:  # noqa: BLE001 - classify then fall through to static
        failure_reason = _classify_section_failure(exc)
        logger.info(
            "Result report section '%s' rewrite tier failed (reason=%s)",
            section.section_id,
            failure_reason,
        )
    logger.warning(
        "Result report section '%s' fell back to static tier (reason=%s)",
        section.section_id,
        failure_reason,
    )
    return _static_section_from_context(
        context,
        section,
        reducer_result,
        failure_reason=failure_reason,
    )


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
    # The section tool re-serves the same reducer evidence on every call, so we
    # track which evidence ids have already been surfaced. The first tool call
    # adds them all (progress); any later call adds nothing (no progress) and the
    # loop pivots to a forced final answer instead of spending another timed
    # iteration on an empty spin that would otherwise time out into a static tier.
    served_evidence_ids: set[str] = set()
    force_final = False
    max_steps = max(1, settings.REPORT_MAX_TOOL_CALLS_PER_SECTION)
    for iteration in range(1, max_steps + 1):
        prompt = _build_section_prompt(
            context,
            section,
            reducer_result,
            tier=tier,
            history=history,
            force_final=force_final,
        )
        with llm_request_scope(**_report_llm_scope_kwargs(context, overrides)):
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
            raise ResultReportBuilderError(
                "Section payload must be an object",
                reason="json_parse_error",
            )

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
            if force_final:
                # The model already received an explicit final-only directive but
                # called the tool again. There is no new evidence to gain, so stop
                # here rather than spend more timed iterations; the rewrite/static
                # tiers below still cover this section.
                raise ResultReportBuilderError(
                    "Section ignored final-only directive after no-progress tool call",
                    reason="tool_budget_exhausted",
                )
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
            served_ids = {
                evidence.id
                for evidence in reducer_result.evidence[
                    : settings.REPORT_MAX_EVIDENCE_PER_SECTION
                ]
            }
            served_evidence_ids |= served_ids
            # _tool_query_branch_messages is a deterministic re-serve of the same
            # reducer evidence, so the first call already surfaces everything there
            # is to gain. Any subsequent call would add nothing new — demand a final
            # answer on the very next pass rather than funding another timed empty
            # spin that risks a timeout into the static tier. (The subset guard is a
            # defensive double-check in case the tool ever returns a narrower set.)
            if served_evidence_ids and (
                not served_ids or served_ids <= served_evidence_ids
            ):
                force_final = True
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

        raise ResultReportBuilderError(
            f"Unsupported section action: {action or '<empty>'}",
            reason="unsupported_action",
        )

    raise ResultReportBuilderError(
        "Section generation exceeded tool budget",
        reason="tool_budget_exhausted",
    )


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
            "title_i18n must be a final publication title. Do not use 提纲, 大纲, "
            "纲要, outline, report outline, or any planning label in the title.",
            "summary_i18n must use completed voice. Do not write 本报告将..., 报告将..., "
            "This report will..., or any future-tense planning summary.",
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


def _polish_report_title_summary(
    title_i18n: I18nText,
    summary_i18n: I18nText,
) -> tuple[I18nText, I18nText]:
    return (
        I18nText(
            zh=_strip_planning_title(title_i18n.zh),
            en=_strip_planning_title(title_i18n.en),
        ),
        I18nText(
            zh=_rewrite_planning_summary(summary_i18n.zh),
            en=_rewrite_planning_summary(summary_i18n.en),
        ),
    )


def _strip_planning_title(value: str) -> str:
    original = str(value or "").strip()
    cleaned = original
    replacements = [
        r"\s*[:：\-]\s*SwarmOracle(?:分析)?报告(?:提纲|大纲|纲要)\s*$",
        r"\s*[:：\-]\s*SwarmOracle\s+(?:Analysis\s+)?Report\s+Outline\s*$",
        r"\s*[:：\-]\s*Report\s+Outline\s*$",
        r"\s*[:：]\s*.+\bOutline\s*$",
        r"\s+SwarmOracle\s+(?:Analysis\s+)?Report\s+Outline\s*$",
        r"\s+Report\s+Outline\s*$",
        r"(?:分析)?报告(?:提纲|大纲|纲要)\s*$",
    ]
    for pattern in replacements:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE).strip()
    cleaned = cleaned.rstrip("：:- ").strip()
    return cleaned or original


def _rewrite_planning_summary(value: str) -> str:
    text = str(value or "").strip()
    zh_patterns = [
        (r"^本报告将围绕(.+?)展开", r"本报告围绕\1展开"),
        (r"^本报告将(评估|核查|分析|审视|检验|讨论|比较|追踪)", r"本报告\1"),
        (r"^报告将(评估|核查|分析|审视|检验|讨论|比较|追踪)", r"报告\1"),
    ]
    for pattern, replacement in zh_patterns:
        rewritten = re.sub(pattern, replacement, text)
        if rewritten != text:
            return rewritten
    en_verbs = {
        "examine": "examines",
        "assess": "assesses",
        "evaluate": "evaluates",
        "analyze": "analyzes",
        "analyse": "analyses",
        "review": "reviews",
        "discuss": "discusses",
        "trace": "traces",
        "compare": "compares",
        "test": "tests",
    }
    for subject in ("This report", "The report"):
        for base, present in en_verbs.items():
            prefix = f"{subject} will {base} "
            if text.lower().startswith(prefix.lower()):
                return f"{subject} {present} {text[len(prefix):]}"
    return text


def _build_section_prompt(
    context: BuilderContext,
    section: SectionPlan,
    reducer_result: ReducerResult,
    *,
    tier: SectionTier,
    history: list[str],
    force_final: bool = False,
) -> str:
    evidence_digest = _evidence_digest(reducer_result, max_items=6)
    history_block = "\n\n".join(history[-settings.REPORT_MAX_TOOL_CALLS_PER_SECTION:])
    web_block = "\n\n".join(context.web_context_blocks[:3])
    # No-progress escape hatch: the section tool only re-serves the same reducer
    # evidence batch, so once it has run there is nothing new to fetch. Rather than
    # spend another timed iteration on an empty spin (and risk timing out into a
    # static fallback), the loop sets force_final to demand the answer be written
    # from the material already gathered.
    force_final_directive = (
        "You already have all available evidence and the query tool cannot return "
        "anything new. Write the final_section now from the evidence and tool "
        "history below; do NOT call any tool."
        if force_final
        else ""
    )
    return "\n\n".join(
        item
        for item in [
            "REPORT_SECTION_REACT",
            f"tier={tier}",
            force_final_directive,
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
        zh=f"{context.branch_title}：完整报告",
        en=f"{context.branch_title}: Full report",
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
            "zh": f"{context.branch_title}：完整报告",
            "en": f"{context.branch_title}: Full report",
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
        tier=tier,
        failure_reason=None,
    )
    return SectionBuildResult(section=report_section, tier=tier, tool_trace=trace)


def _static_section_from_context(
    context: BuilderContext,
    section: SectionPlan,
    reducer_result: ReducerResult,
    *,
    failure_reason: SectionFailureReason = "other",
) -> SectionBuildResult:
    probability = reducer_result.likelihood.probability
    evidence_refs = [item.id for item in reducer_result.evidence[:2]]
    has_source_body = bool(context.branch_insight or context.branch_story)
    # When neither insight nor story exists, the static body is just the
    # boilerplate fallback line — record that as ``empty_body`` so diagnostics
    # can tell "LLM failed but we had content" from "LLM failed AND no content".
    resolved_reason: SectionFailureReason = (
        failure_reason if has_source_body else "empty_body"
    )
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
        tier="static",
        failure_reason=resolved_reason,
    )
    return SectionBuildResult(section=report_section, tier="static", tool_trace=[])


def _outline_failure_placeholder_sections(outline: ReportOutline) -> list[ReportSection]:
    return [
        ReportSection(
            id=section.section_id,
            title=section.title_i18n.get("en") or section.section_id,
            title_i18n=I18nText.model_validate(section.title_i18n),
            intent=section.intent,
            body_md_i18n=I18nText(
                zh="本章未能生成内容；保留该报告大纲位置以显示原计划结构。",
                en="This section could not be generated; its outline placeholder is retained.",
            ),
            evidence_refs=[],
            charts=[],
            tier="static",
            failure_reason="empty_outline",
        )
        for section in outline.sections
    ]


def _assemble_report(
    context: BuilderContext,
    reducer_result: ReducerResult,
    outline: ReportOutline,
    *,
    sections: list[ReportSection],
    status: ReportStatus,
    tier: ReportTier,
    interview_evidence: list[dict[str, Any]] | None = None,
    interview_status: InterviewStatus | None = None,
    indicators_to_watch: list[IndicatorToWatch] | None = None,
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
    title_i18n, summary_i18n = _polish_report_title_summary(
        I18nText.model_validate(outline.title_i18n),
        I18nText.model_validate(outline.summary_i18n),
    )
    sections_with_charts = _attach_reducer_charts(sections, reducer_result)
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
            disclaimer=reducer_result.verdict_disclaimer,
        ),
        sections=sections_with_charts,
        evidence=_safe_evidence_refs(reducer_result),
        indicators_to_watch=_safe_indicators_to_watch(
            context,
            reducer_result,
            llm_indicators=indicators_to_watch,
        ),
        dissenting=reducer_result.dissenting,
        key_participants=reducer_result.key_participants,
        follow_ups=_follow_ups(context),
        limitations=(
            "Report content is generated from a bounded simulation transcript, "
            "deterministic reducer stats, and available evidence coordinates."
        ),
        interview_evidence=interview_evidence or [],
        interview_status=interview_status,
        premortem=[],
        language_status=LanguageStatus(zh="available", en="available"),
    )
    return report


async def _build_interview_evidence(
    context: BuilderContext,
    reducer_result: ReducerResult,
    *,
    overrides: ReportGenerationOverrides | None,
) -> tuple[list[dict[str, Any]], InterviewStatus]:
    candidates = await asyncio.to_thread(
        _load_interview_candidates,
        context,
        reducer_result,
    )
    requested_agents = len(candidates)
    truncated_agents = max(0, requested_agents - _INTERVIEW_AGENT_BUDGET)
    if not candidates:
        return [], InterviewStatus(
            status="skipped",
            requested_agents=0,
            completed_agents=0,
            truncated_agents=0,
            message="No interview candidates were available.",
        )

    prompt = _build_interview_prompt(context, candidates)
    try:
        with llm_request_scope(**_report_llm_scope_kwargs(context, overrides)):
            payload = await asyncio.wait_for(
                llm_call_json(
                    prompt,
                    api_key=overrides.api_key if overrides else None,
                    base_url=overrides.base_url if overrides else None,
                    model=overrides.model if overrides else None,
                    temperature=(
                        overrides.temperature
                        if overrides and overrides.temperature is not None
                        else 0.25
                    ),
                    reasoning_effort="low",
                ),
                timeout=settings.REPORT_SECTION_TIMEOUT_SECONDS,
            )
        evidence = _normalize_interview_payload(payload, candidates)
    except Exception:  # noqa: BLE001 - interviews are non-critical report garnish
        logger.info("Result report interview generation failed; continuing without interviews")
        return [], InterviewStatus(
            status="failed",
            requested_agents=requested_agents,
            completed_agents=0,
            truncated_agents=truncated_agents,
            error_code="INTERVIEW_LLM_FAILED",
            message="Interview generation failed; report sections remain available.",
        )

    completed_agents = len(
        {
            str(item.get("agent_name") or "")
            for item in evidence
            if item.get("agent_name")
        }
    )
    expected_agents = min(requested_agents, _INTERVIEW_AGENT_BUDGET)
    status: Literal["complete", "partial"] = (
        "complete" if completed_agents >= expected_agents else "partial"
    )
    return evidence, InterviewStatus(
        status=status,
        requested_agents=requested_agents,
        completed_agents=completed_agents,
        truncated_agents=truncated_agents,
        message=(
            "Interview evidence generated from bounded transcript excerpts."
            if completed_agents
            else "No interview evidence was returned by the model."
        ),
    )


def _load_interview_candidates(
    context: BuilderContext,
    reducer_result: ReducerResult,
) -> list[InterviewCandidate]:
    branch_index_by_id = {
        str(item.get("branch_id")): index
        for index, item in enumerate(reducer_result.branch_distribution)
        if isinstance(item, dict) and item.get("branch_id")
    }
    branch_index = branch_index_by_id.get(context.branch_id, 0)
    candidates: list[InterviewCandidate] = []
    seen_agents: set[str] = set()

    with Session(get_engine()) as session:
        rows = session.exec(
            select(AgentMessage, Round, Agent)
            .join(Round, AgentMessage.round_id == Round.id)
            .join(Agent, AgentMessage.agent_id == Agent.id)
            .where(
                Round.branch_id == context.branch_id,
                Agent.scenario_id == context.scenario_id,
            )
            .order_by(Round.round_number.asc(), Agent.name.asc(), AgentMessage.id.asc())
        ).all()

    for message, round_, agent in rows:
        if agent.id in seen_agents:
            continue
        excerpt = _truncate_text(
            message.content,
            settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS,
        )
        if not excerpt or excerpt == "Unavailable.":
            continue
        seen_agents.add(agent.id)
        candidates.append(
            InterviewCandidate(
                branch_index=branch_index,
                round_number=round_.round_number,
                agent_name=_truncate_text(agent.name, 120),
                persona=_truncate_text(agent.persona or agent.role or agent.name, 900),
                excerpt=excerpt,
            )
        )
        if len(candidates) >= _INTERVIEW_CANDIDATE_LIMIT:
            break
    return candidates


def _build_interview_prompt(
    context: BuilderContext,
    candidates: list[InterviewCandidate],
) -> str:
    candidate_blocks = []
    for index, candidate in enumerate(candidates, start=1):
        coordinate = json.dumps(
            {
                "branch_index": candidate.branch_index,
                "round": candidate.round_number,
                "agent_name": candidate.agent_name,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        candidate_blocks.append(
            "\n".join(
                [
                    f"Candidate {index}: {coordinate}",
                    format_untrusted_text_block(
                        "Interview agent persona",
                        candidate.persona,
                        max_chars=900,
                    ),
                    format_untrusted_text_block(
                        "Interview transcript excerpt",
                        candidate.excerpt,
                        max_chars=settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS,
                    ),
                ]
            )
        )

    return "\n\n".join(
        [
            "REPORT_INTERVIEWS",
            "Return strict JSON only.",
            "Action: interview_agents.",
            (
                "Select at most 3 agents and at most 5 evidence rows per agent. "
                "Use only the supplied transcript excerpts; do not invent chat, "
                "questions, answers, coordinates, or agent names."
            ),
            "Required JSON shape: "
            '{"action":"interview_agents","interview_evidence":['
            '{"agent_name":"...","excerpt":"..."}]}',
            format_untrusted_text_block("User question", context.question, max_chars=1200),
            "\n\n".join(candidate_blocks),
        ]
    )


def _normalize_interview_payload(
    payload: object,
    candidates: list[InterviewCandidate],
) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ResultReportBuilderError("Interview payload must be an object")
    if str(payload.get("action") or "").strip() != "interview_agents":
        raise ResultReportBuilderError("Interview payload action is invalid")
    raw_entries = payload.get("interview_evidence")
    if not isinstance(raw_entries, list):
        raise ResultReportBuilderError("Interview evidence must be a list")

    candidates_by_name = {candidate.agent_name: candidate for candidate in candidates}
    selected_agents: set[str] = set()
    rows_by_agent: dict[str, int] = {}
    evidence: list[dict[str, Any]] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            continue
        agent_name = _truncate_text(str(raw_entry.get("agent_name") or ""), 120)
        candidate = candidates_by_name.get(agent_name)
        if candidate is None:
            continue
        if candidate.agent_name not in selected_agents:
            if len(selected_agents) >= _INTERVIEW_AGENT_BUDGET:
                continue
            selected_agents.add(candidate.agent_name)
        if rows_by_agent.get(candidate.agent_name, 0) >= _INTERVIEW_EVIDENCE_PER_AGENT_CAP:
            continue
        excerpt = _truncate_text(
            str(raw_entry.get("excerpt") or candidate.excerpt),
            settings.REPORT_EVIDENCE_EXCERPT_MAX_CHARS,
        )
        evidence.append(
            {
                "branch_index": candidate.branch_index,
                "round": candidate.round_number,
                "agent_name": candidate.agent_name,
                "excerpt": excerpt,
            }
        )
        rows_by_agent[candidate.agent_name] = rows_by_agent.get(candidate.agent_name, 0) + 1
        if len(selected_agents) >= _INTERVIEW_AGENT_BUDGET and all(
            rows_by_agent.get(agent_name, 0) >= _INTERVIEW_EVIDENCE_PER_AGENT_CAP
            for agent_name in selected_agents
        ):
            break
    return evidence


def _attach_reducer_charts(
    sections: list[ReportSection],
    reducer_result: ReducerResult,
) -> list[ReportSection]:
    if not sections or not reducer_result.charts:
        return sections

    reducer_charts = [
        chart
        for chart in reducer_result.charts
        if chart.type in _CHART_SECTION_PREFERENCES
    ]
    if not reducer_charts:
        return sections

    assignments = _assign_chart_sections(sections, reducer_charts)
    reducer_chart_types = {chart.type for chart in reducer_charts}
    updated_sections: list[ReportSection] = []
    for section in sections:
        next_charts = [
            chart
            for chart in section.charts
            if chart.type not in reducer_chart_types
        ]
        next_charts.extend(
            chart
            for chart in reducer_charts
            if assignments.get(chart.type) == section.id
        )
        updated_sections.append(section.model_copy(update={"charts": next_charts}))
    return updated_sections


def _assign_chart_sections(
    sections: list[ReportSection],
    reducer_charts: list[Chart],
) -> dict[str, str]:
    section_ids = [section.id for section in sections]
    available = set(section_ids)
    assignments: dict[str, str] = {}
    for chart in reducer_charts:
        preferences = _CHART_SECTION_PREFERENCES.get(chart.type, ())
        target_section_id = next(
            (section_id for section_id in preferences if section_id in available),
            section_ids[0],
        )
        assignments[chart.type] = target_section_id
    return assignments


# S3 anti-slop blacklist (AC-4): generic, says-nothing indicator phrasing that the
# proposal explicitly flagged. If the LLM tier produces any of these, we reject its
# output and fall back to the evidence-inlined template tier rather than ship slop.
_INDICATOR_SLOP_BLACKLIST: tuple[str, ...] = (
    "如果这个信号持续出现",
    "它会强化主导路线",
    "同一议题被另一位参与者",
    "下一次后续更新周期",
    "持续关注",
    "挑战与机遇并存",
    "综上所述",
    "值得注意的是",
    "if this signal persists",
    "reinforces the dominant branch",
    "the same issue is repeated by another participant",
    "next follow-up cycle",
    "continue to monitor",
    "challenges and opportunities",
    "it is worth noting",
)


def _indicator_text_is_slop(value: str) -> bool:
    lowered = str(value or "").lower()
    return any(token.lower() in lowered for token in _INDICATOR_SLOP_BLACKLIST)


def _indicator_question_focus(question: str, language: str) -> str:
    """Short, sanitized anchor of the original what-if question for tripwire copy."""

    cleaned = _scrub_sensitive_text(str(question or "").strip())
    if not cleaned:
        return "这个推演问题" if language == "zh" else "this what-if question"
    limit = 36 if language == "zh" else 80
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit].rstrip() + ("…" if language == "zh" else "...")


def _safe_indicators_to_watch(
    context: BuilderContext,
    reducer_result: ReducerResult,
    *,
    llm_indicators: list[IndicatorToWatch] | None = None,
) -> list[IndicatorToWatch]:
    # S3 three-tier fail-soft:
    #   tier 1 — ``llm_indicators`` (pre-computed by the async LLM tier in
    #            ``_build_report_unlocked``) when the model produced viable rows;
    #   tier 2 — evidence-inlined template (``_build_indicators_to_watch``);
    #   tier 3 — empty list, only when even the template raises.
    if llm_indicators:
        return llm_indicators
    try:
        return _build_indicators_to_watch(context, reducer_result)
    except Exception:  # noqa: BLE001 - S4 indicators must not fail the report
        logger.info("Result report indicators failed; leaving indicators_to_watch empty")
        return []


async def _build_indicators_llm(
    context: BuilderContext,
    reducer_result: ReducerResult,
    *,
    overrides: ReportGenerationOverrides | None,
) -> list[IndicatorToWatch] | None:
    """S3 tier 1: generate indicators-to-watch with the LLM (fail-soft → None).

    Each indicator is grounded on real reducer evidence coordinates + real reducer
    probability/consensus stats and tied back to the original what-if question, with
    a concrete flip/reinforce tripwire. Untrusted text is wrapped via
    ``format_untrusted_text_block`` and the call reuses the existing report LLM scope
    (no new ``validate_llm_base_url`` bypass — AC-12).
    """

    if not reducer_result.evidence:
        # Without at least one real evidence coordinate the LLM tier cannot bind
        # tripwires to anything verifiable; let the template tier handle it.
        return None

    try:
        prompt = _build_indicators_prompt(context, reducer_result)
        with llm_request_scope(**_report_llm_scope_kwargs(context, overrides)):
            payload = await asyncio.wait_for(
                llm_call_json(
                    prompt,
                    api_key=overrides.api_key if overrides else None,
                    base_url=overrides.base_url if overrides else None,
                    model=overrides.model if overrides else None,
                    temperature=(
                        overrides.temperature
                        if overrides and overrides.temperature is not None
                        else 0.5
                    ),
                    reasoning_effort="low",
                ),
                timeout=settings.REPORT_SECTION_TIMEOUT_SECONDS,
            )
        indicators = _normalize_indicators_payload(payload, context, reducer_result)
    except Exception:  # noqa: BLE001 - indicators are non-critical; fall back to template
        logger.info(
            "Result report LLM indicators failed; falling back to template indicators"
        )
        return None
    return indicators or None


def _build_indicators_prompt(
    context: BuilderContext,
    reducer_result: ReducerResult,
) -> str:
    language = "zh" if context.language == "zh" else "en"
    evidence_digest = _evidence_digest(
        reducer_result, max_items=settings.REPORT_MAX_EVIDENCE_PER_SECTION
    )
    distribution = json.dumps(
        reducer_result.branch_distribution[:5], ensure_ascii=False, separators=(",", ":")
    )
    result_quality = (
        context.parsed_context.get("result_quality")
        if isinstance(context.parsed_context.get("result_quality"), dict)
        else {}
    )
    stats = json.dumps(
        {
            "likelihood_probability": round(reducer_result.likelihood.probability, 4),
            "likelihood_wep": reducer_result.likelihood.wep,
            "confidence_level": reducer_result.analytic_confidence.level,
            "polarization": reducer_result.polarization.value,
            "agent_consensus": reducer_result.agent_consensus.value,
            "result_quality_confidence": result_quality.get("confidence"),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    allowed_ids = [item.id for item in reducer_result.evidence]
    if language == "zh":
        directive = (
            "你是情报分析师，为这份「如果…会怎样」推演报告写『后续观察指标 "
            "(Indicators to Watch)』。生成 3-4 条指标，严格返回 JSON。每条必须："
            "(1) 直接回指原问题；(2) signal 是一个具体、可观测、可预先登记的事件，"
            "不是泛泛的『持续关注』；(3) threshold 给出明确的翻盘/强化触发条件 "
            "(tripwire)，写清什么新信息会让结论被推翻或被强化；(4) evidence_refs "
            "只能引用下方给定的真实证据 id；(5) 每条指标信息密度高、彼此不同，"
            "不要套话。禁止出现：『如果这个信号持续出现，它会强化主导路线』、"
            "『同一议题被另一位参与者再次提及』、『下一次后续更新周期』、"
            "『持续关注』、『综上所述』、『值得注意的是』这类放之四海皆准的话术。"
        )
    else:
        directive = (
            "You are an intelligence analyst writing the 'Indicators to Watch' "
            "section of this what-if forecast report. Produce 3-4 indicators and "
            "return strict JSON only. Each indicator must: (1) point back to the "
            "original question; (2) have a 'signal' that is a concrete, observable, "
            "pre-registered event, not a vague 'keep monitoring'; (3) give a "
            "'threshold' with an explicit flip/reinforce tripwire — what new "
            "information would overturn or strengthen the verdict; (4) only cite "
            "evidence ids from the supplied real evidence; (5) be high-density and "
            "differentiated. Forbidden boilerplate: 'if this signal persists it "
            "reinforces the dominant branch', 'the same issue is repeated by another "
            "participant', 'next follow-up cycle', 'continue to monitor', "
            "'it is worth noting'."
        )
    shape = (
        'Required JSON shape: {"action":"indicators_to_watch","indicators":['
        '{"signal":"...","direction":"up|down","note":"...","threshold":"...",'
        '"observation":"...","time_horizon":"...","rationale":"...",'
        '"evidence_refs":["ev_001"]}]}'
    )
    return "\n\n".join(
        item
        for item in [
            "REPORT_INDICATORS",
            directive,
            shape,
            f"Allowed evidence ids (use only these): {json.dumps(allowed_ids)}",
            format_untrusted_text_block(
                "Original what-if question", context.question, max_chars=1200
            ),
            format_untrusted_text_block(
                "Verdict / question answer (for anchoring only)",
                "\n".join(
                    str(result_quality.get(key) or "").strip()
                    for key in ("question_answer", "verdict")
                ).strip(),
                max_chars=1600,
            ),
            format_untrusted_text_block(
                "Reducer evidence (real coordinates)", evidence_digest, max_chars=3200
            ),
            format_untrusted_text_block(
                "Branch probability distribution", distribution, max_chars=1600
            ),
            format_untrusted_text_block("Reducer stats", stats, max_chars=800),
        ]
        if item
    )


def _normalize_indicators_payload(
    payload: object,
    context: BuilderContext,
    reducer_result: ReducerResult,
) -> list[IndicatorToWatch]:
    if not isinstance(payload, dict):
        raise ResultReportBuilderError("Indicators payload must be an object")
    if str(payload.get("action") or "").strip() != "indicators_to_watch":
        raise ResultReportBuilderError("Indicators payload action is invalid")
    raw_entries = payload.get("indicators")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise ResultReportBuilderError("Indicators must be a non-empty list")

    language = "zh" if context.language == "zh" else "en"
    evidence_ids = {item.id for item in reducer_result.evidence}
    indicators: list[IndicatorToWatch] = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        signal = str(raw.get("signal") or "").strip()
        note = str(raw.get("note") or "").strip()
        threshold = str(raw.get("threshold") or "").strip()
        if not signal or not note or not threshold:
            # An indicator without a real signal + tripwire is exactly the slop we
            # are trying to kill; drop it.
            continue
        combined = " ".join(
            [
                signal,
                note,
                threshold,
                str(raw.get("observation") or ""),
                str(raw.get("rationale") or ""),
            ]
        )
        if _indicator_text_is_slop(combined):
            # Reject the whole LLM batch on any blacklist hit so we do not ship a
            # mix of grounded + slop rows (AC-4).
            raise ResultReportBuilderError("Indicators contain blacklisted slop phrasing")
        raw_refs = raw.get("evidence_refs")
        evidence_refs = (
            [str(ref) for ref in raw_refs if isinstance(ref, str)]
            if isinstance(raw_refs, list)
            else []
        )
        indicators.append(
            _indicator(
                signal=signal,
                direction=str(raw.get("direction") or "up"),
                note=note,
                threshold=threshold,
                observation=str(raw.get("observation") or "").strip(),
                time_horizon=str(raw.get("time_horizon") or "").strip(),
                rationale=str(raw.get("rationale") or "").strip(),
                evidence_refs=evidence_refs,
                allowed_evidence_ids=evidence_ids,
                language=language,
            )
        )
        if len(indicators) >= 5:
            break
    if not indicators:
        raise ResultReportBuilderError("Indicators payload yielded no usable rows")
    return indicators


def _build_indicators_to_watch(
    context: BuilderContext,
    reducer_result: ReducerResult,
) -> list[IndicatorToWatch]:
    # S3 fallback tier (挡2): used when the LLM indicator tier fails/times out.
    # Unlike the old template, every row inlines the *actual* evidence claim,
    # the *actual* reducer probability numbers, and ties the tripwire back to the
    # original what-if question instead of the generic "信号持续出现 → 强化主导路线"
    # / "同一议题被另一位参与者再次提及" boilerplate the proposal called out.
    indicators: list[IndicatorToWatch] = []
    evidence_ids = {item.id for item in reducer_result.evidence}
    language = "zh" if context.language == "zh" else "en"
    question_focus = _indicator_question_focus(context.question, language)

    for evidence in reducer_result.evidence[:2]:
        claim = _truncate_indicator_text(evidence.quote, 150, language)
        if language == "zh":
            signal = f"{evidence.agent_name}（第 {evidence.round_number} 轮）的主张是否被复现"
            note = (
                f"{evidence.agent_name} 在主导路线上断言：「{claim}」——"
                f"这是支撑「{question_focus}」结论的关键论据。"
            )
            threshold = (
                f"翻盘信号：出现与「{claim[:48]}」直接冲突的新证据，"
                f"或另一位参与者在后续轮次拿出更强的反例；"
                f"强化信号：另一条独立分支或来源复述同一主张。"
            )
            observation = f"第 {evidence.round_number} 轮 · {evidence.agent_name}：{claim}"
            time_horizon = "下一轮模拟或下一份证据刷新时复查"
            rationale = f"绑定主导路线证据 {evidence.id}（第 {evidence.round_number} 轮）。"
        else:
            signal = (
                f"Whether {evidence.agent_name}'s round-{evidence.round_number} claim "
                f"gets reproduced"
            )
            note = (
                f"{evidence.agent_name} asserts on the dominant branch: \"{claim}\" — "
                f"this is the load-bearing argument behind the answer to "
                f"\"{question_focus}\"."
            )
            threshold = (
                f"Flip signal: new evidence directly contradicting \"{claim[:48]}\", "
                f"or another participant lands a stronger counter-example in a later "
                f"round; reinforce signal: an independent branch or source restates "
                f"the same claim."
            )
            observation = (
                f"Round {evidence.round_number} · {evidence.agent_name}: {claim}"
            )
            time_horizon = "Re-check on the next simulated round or evidence refresh"
            rationale = (
                f"Bound to dominant-branch evidence {evidence.id} "
                f"(round {evidence.round_number})."
            )
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
                question_focus=question_focus,
            )
        )

    return indicators[:5]


def _insufficient_evidence_indicator(
    signal: str,
    *,
    allowed_evidence_ids: set[str],
    language: str,
    question_focus: str = "",
) -> IndicatorToWatch:
    focus = str(question_focus or "").strip()
    if language == "zh":
        anchor = f"对「{focus}」而言，" if focus else ""
        note = f"{anchor}这条主导路线条件目前没有可引用的消息级证据坐标。"
        threshold = (
            f"翻盘信号：后续模拟里出现一条带真实坐标、与「{signal}」相反的发言；"
            f"强化信号：后续更新用真实坐标复现该分支条件。"
        )
        observation = "诚实降级：该结论目前缺乏消息级证据坐标支撑。"
        time_horizon = "下一轮模拟或下一份证据刷新时复查"
        rationale = "尚无报告证据坐标可绑定到这条指标。"
    else:
        anchor = f"For \"{focus}\", " if focus else ""
        note = (
            f"{anchor}this dominant-branch condition has no citable "
            f"message-level evidence coordinate yet."
        )
        threshold = (
            f"Flip signal: a later simulated turn produces a real-coordinate "
            f"statement contradicting \"{signal}\"; reinforce signal: a follow-up "
            f"update reproduces the branch condition with a real coordinate."
        )
        observation = (
            "Honest downgrade: this claim currently lacks a message-level "
            "evidence coordinate."
        )
        time_horizon = "Re-check on the next simulated round or evidence refresh"
        rationale = "No report evidence coordinate can be bound to this indicator yet."
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
    competitive_leaves = [item for item in distribution if item.get("is_terminal_leaf")]
    if len(competitive_leaves) < 2:
        return None
    dominant = next(
        (item for item in competitive_leaves if item.get("dominant") is True),
        competitive_leaves[0],
    )
    dominant_branch_id = dominant.get("branch_id")
    runner_up = next(
        (
            item
            for item in competitive_leaves
            if item is not dominant and item.get("branch_id") != dominant_branch_id
        ),
        None,
    )
    if runner_up is None:
        return None
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
            _sync_payload_evidence_refs(payload)
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
        _shrink_payload_indicators(payload)
    if utf8_json_size_bytes(payload) > max_bytes:
        payload["evidence"] = payload.get("evidence", [])[:1]
    # S3: indicator copy is richer now (real evidence + tripwires); drop whole
    # indicator rows last so an oversize report can still fit the byte budget
    # instead of raising ResultReportTooLargeError.
    while payload.get("indicators_to_watch") and utf8_json_size_bytes(payload) > max_bytes:
        payload["indicators_to_watch"].pop()
    _sync_payload_evidence_refs(payload)
    return validate_full_report_payload(payload, max_bytes=max_bytes)


def _shrink_payload_indicators(payload: dict[str, Any]) -> None:
    """Tighten indicator text fields under byte pressure before dropping rows."""

    for indicator in payload.get("indicators_to_watch") or []:
        if not isinstance(indicator, dict):
            continue
        for field, limit in (
            ("signal", 120),
            ("note", 120),
            ("threshold", 140),
            ("observation", 120),
            ("time_horizon", 80),
            ("rationale", 120),
        ):
            if indicator.get(field):
                indicator[field] = _truncate_text(str(indicator.get(field) or ""), limit)


def _sync_payload_evidence_refs(payload: dict[str, Any]) -> None:
    evidence_ids = {
        str(item.get("id"))
        for item in (payload.get("evidence") or [])
        if isinstance(item, dict) and item.get("id")
    }
    for section in payload.get("sections") or []:
        if not isinstance(section, dict):
            continue
        refs = section.get("evidence_refs")
        section["evidence_refs"] = [
            str(ref)
            for ref in (refs if isinstance(refs, list) else [])
            if str(ref) in evidence_ids
        ]
    for indicator in payload.get("indicators_to_watch") or []:
        if not isinstance(indicator, dict):
            continue
        refs = indicator.get("evidence_refs")
        indicator["evidence_refs"] = [
            str(ref)
            for ref in (refs if isinstance(refs, list) else [])
            if str(ref) in evidence_ids
        ]


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


def _reusable_existing_sections(
    scenario_id: str,
    target_branch_id: str,
    outline: ReportOutline,
) -> tuple[list[ReportSection], list[SectionTier]]:
    existing = _load_existing_full_report(scenario_id)
    if (
        existing is None
        or existing.target_branch_id != target_branch_id
        or existing.status in {"failed", "skipped"}
    ):
        return [], []

    planned_intents = {
        section.section_id: section.intent
        for section in outline.sections
    }
    existing_by_id: dict[str, ReportSection] = {}
    for section in existing.sections:
        if section.id in existing_by_id:
            continue
        if planned_intents.get(section.id) != section.intent:
            continue
        existing_by_id[section.id] = section

    reusable = [
        existing_by_id[section.section_id]
        for section in outline.sections
        if section.section_id in existing_by_id
    ]
    if not reusable:
        return [], []
    return reusable, [section.tier for section in reusable]


def _persist_failed_report_if_absent(
    scenario_id: str,
    dominant_branch_id: str,
) -> FullReport:
    return _persist_placeholder_report_if_absent(
        scenario_id,
        dominant_branch_id,
        status="failed",
    )


def persist_generating_report_placeholder_if_absent(
    scenario_id: str,
    dominant_branch_id: str,
) -> FullReport:
    return _persist_placeholder_report_if_absent(
        scenario_id,
        dominant_branch_id,
        status="generating",
    )


def _persist_generating_report_placeholder_for_retry(
    scenario_id: str,
    dominant_branch_id: str,
) -> FullReport | None:
    lease = acquire_runtime_lock(
        _report_runtime_lock_key(scenario_id),
        lease_seconds=_report_runtime_lock_lease_seconds(),
    )
    if lease is None:
        logger.info(
            "Skipping result report retry placeholder because another worker owns the lease",
        )
        return _load_existing_full_report(scenario_id)
    try:
        return _persist_placeholder_report_if_absent(
            scenario_id,
            dominant_branch_id,
            status="generating",
            replace_failed=True,
            replace_unenhanced=True,
        )
    finally:
        release_runtime_lock(lease)


def _persist_failed_report_after_auto_retry_exhausted(
    scenario_id: str,
    dominant_branch_id: str,
) -> FullReport | None:
    lease = acquire_runtime_lock(
        _report_runtime_lock_key(scenario_id),
        lease_seconds=_report_runtime_lock_lease_seconds(),
    )
    if lease is None:
        logger.info(
            "Skipping exhausted result report marker because another worker owns the lease",
        )
        return _load_existing_full_report(scenario_id)
    try:
        return _persist_placeholder_report_if_absent(
            scenario_id,
            dominant_branch_id,
            status="failed",
            replace_unenhanced=True,
        )
    finally:
        release_runtime_lock(lease)


def _persist_placeholder_report_if_absent(
    scenario_id: str,
    dominant_branch_id: str,
    *,
    status: Literal["failed", "generating"],
    replace_failed: bool = False,
    replace_unenhanced: bool = False,
) -> FullReport:
    with Session(get_engine()) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise ResultReportBuilderError("Scenario not found while persisting report placeholder")

        parsed_context = (
            dict(scenario.parsed_context)
            if isinstance(scenario.parsed_context, dict)
            else {}
        )
        existing = _coerce_existing_full_report(parsed_context.get("full_report"))
        if existing is not None:
            if (
                status == "failed"
                and existing.status != "generating"
                and not (
                    replace_unenhanced
                    and not _report_has_llm_enhanced_sections(existing)
                )
            ):
                return existing
            if (
                status == "generating"
                and (existing.status != "failed" or not replace_failed)
                and not (
                    replace_unenhanced
                    and not _report_has_llm_enhanced_sections(existing)
                )
            ):
                return existing

        target_branch_id = _resolve_failed_report_target_branch_id(
            scenario_id,
            dominant_branch_id,
        )
        branch = _load_failed_report_branch(session, scenario_id, target_branch_id)
        payload = _placeholder_report_payload(
            scenario,
            parsed_context,
            branch,
            target_branch_id,
            status=status,
        )
    _persist_report_payload(scenario_id, payload)
    return validate_full_report_payload(
        payload,
        max_bytes=max(settings.REPORT_FULL_REPORT_MAX_BYTES, 1),
    )


def _persist_failed_report_if_lock_available(
    scenario_id: str,
    dominant_branch_id: str,
) -> FullReport | None:
    lease = acquire_runtime_lock(
        _report_runtime_lock_key(scenario_id),
        lease_seconds=_report_runtime_lock_lease_seconds(),
    )
    if lease is None:
        logger.info(
            "Skipping result report failure marker because another worker owns the lease",
        )
        return _load_existing_full_report(scenario_id)
    try:
        return _persist_failed_report_if_absent(scenario_id, dominant_branch_id)
    finally:
        release_runtime_lock(lease)


def _resolve_failed_report_target_branch_id(
    scenario_id: str,
    dominant_branch_id: str,
) -> str:
    try:
        reducer_result = reduce_report(
            get_engine(),
            scenario_id,
            max_evidence=0,
            dominant_branch_id=dominant_branch_id,
        )
    except Exception:  # noqa: BLE001 - failure marker must stay fail-soft
        logger.debug("Failed to resolve failed report target branch", exc_info=True)
        return dominant_branch_id
    return reducer_result.target_branch_id or dominant_branch_id


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


def _placeholder_report_payload(
    scenario: Scenario,
    parsed_context: dict[str, Any],
    branch: Branch | None,
    dominant_branch_id: str,
    *,
    status: Literal["failed", "generating"],
) -> dict[str, Any]:
    language = _detect_language(scenario.question or "", parsed_context)
    target_branch_id = branch.id if branch is not None else (dominant_branch_id or scenario.id)
    probability = _clamp_probability(branch.probability if branch is not None else 0.0)
    if status == "generating":
        title_i18n = I18nText(
            zh="完整报告生成中",
            en="Full report generating",
        )
        summary_i18n = I18nText(
            zh="完整报告正在生成，模拟结果已可正常查看。",
            en="The full report is being generated; the simulation result is available.",
        )
        headline_answer = (
            "完整报告正在生成，稍后将展示增强分析。"
            if language == "zh"
            else "The full report is being generated and enhanced analysis will appear shortly."
        )
        confidence_basis = (
            "The report builder has been scheduled but has not produced sections yet."
        )
        limitations = (
            "Report generation is in progress. This placeholder preserves the report "
            "contract until generated sections are persisted."
        )
        interview_status = InterviewStatus(
            status="skipped",
            requested_agents=0,
            completed_agents=0,
            truncated_agents=0,
            message="Report generation has not reached interview extraction yet.",
        )
    else:
        title_i18n = I18nText(
            zh="完整报告暂未生成",
            en="Full report unavailable",
        )
        summary_i18n = I18nText(
            zh="报告生成失败，模拟结果仍可正常查看。",
            en="Report generation failed; the simulation result remains available.",
        )
        headline_answer = (
            "报告生成失败，未能生成可展示章节。"
            if language == "zh"
            else "Report generation failed before renderable sections were produced."
        )
        confidence_basis = "The report builder failed before producing a renderable report."
        limitations = (
            "Report generation failed before any renderable section could be produced. "
            "Existing simulation results remain available."
        )
        interview_status = InterviewStatus(
            status="failed",
            requested_agents=0,
            completed_agents=0,
            truncated_agents=0,
            error_code="REPORT_FAILED",
            message="Report generation failed before interviews could run.",
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
        status=status,
        tier="static",
        verdict=Verdict(
            headline_answer=headline_answer,
            likelihood=Likelihood(
                probability=probability,
                interval=(probability, probability),
                wep="unavailable",
            ),
            analytic_confidence=AnalyticConfidence(
                level="low",
                basis=confidence_basis,
            ),
            disclaimer=None,
        ),
        sections=[],
        evidence=[],
        indicators_to_watch=[],
        dissenting=None,
        key_participants=[],
        follow_ups=[],
        limitations=limitations,
        interview_evidence=[],
        interview_status=interview_status,
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


def _json_object_or_empty_expr():
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


def _persist_report_payload(scenario_id: str, payload: dict[str, Any]) -> None:
    validate_full_report_payload(
        payload,
        max_bytes=max(settings.REPORT_FULL_REPORT_MAX_BYTES, 1),
    )
    with Session(get_engine()) as session:
        result = session.exec(
            update(Scenario)
            .where(Scenario.id == scenario_id)
            .values(
                parsed_context=func.json_set(
                    _json_object_or_empty_expr(),
                    "$.full_report",
                    func.json(json.dumps(payload, ensure_ascii=False)),
                )
            )
        )
        if getattr(result, "rowcount", 1) == 0:
            raise ResultReportBuilderError("Scenario not found while persisting report")
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
    raw_api_key = overrides.get("api_key")
    api_key = (
        raw_api_key.strip()
        if isinstance(raw_api_key, str)
        else str(raw_api_key or "").strip()
    )
    raw_base_url = overrides.get("base_url")
    base_url = (
        raw_base_url.strip()
        if isinstance(raw_base_url, str)
        else str(raw_base_url or "").strip()
    )
    raw_model = overrides.get("model")
    model = raw_model.strip() if isinstance(raw_model, str) else str(raw_model or "").strip()
    return ReportGenerationOverrides(
        api_key=api_key or None,
        base_url=base_url or None,
        model=model or None,
        quota_user_id=_normalize_optional_text(overrides.get("quota_user_id")),
        requests_per_minute=_normalize_positive_int(
            overrides.get("requests_per_minute")
        ),
        tokens_per_minute=_normalize_positive_int(overrides.get("tokens_per_minute")),
        concurrency=_normalize_positive_int(overrides.get("concurrency")),
        supports_structured_outputs_override=_normalize_optional_bool(
            overrides.get("supports_structured_outputs_override")
        ),
        supports_native_search_override=_normalize_optional_bool(
            overrides.get("supports_native_search_override")
        ),
        native_search_upstream_override=_normalize_native_search_upstream(
            overrides.get("native_search_upstream_override")
        ),
        temperature=normalized_temperature,
    )


def _normalize_optional_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _normalize_native_search_upstream(value: Any) -> str | None:
    try:
        return normalize_native_search_upstream(value)
    except ValueError:
        return None


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _normalize_positive_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return None
    return normalized if normalized > 0 else None


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
