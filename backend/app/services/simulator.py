"""Stage 2: Simulate — Multi-agent simulation engine with branching and pruning."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import math
import re
import time
import unicodedata
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from time import monotonic
from typing import Any
from urllib.parse import unquote, urlparse

from sqlalchemy import and_, case, func, or_, update
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.config import effective_memory_compress_interval, settings
from app.log_sanitize import _scrub_sensitive_text
from app.models import (
    Agent,
    AgentMessage,
    AgentStateFrame,
    Branch,
    BranchStatus,
    InterventionLog,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioCheckpoint,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.services.action_opportunities import (
    CompatibilityModeV1,
    OpportunitySnapshotV1,
    derive_opportunity_snapshots_v1,
    opportunity_snapshot_to_prompt_payload_v1,
)
from app.services.agent_message_metadata import (
    encode_metadata_unavailable_emotion,
    message_metadata_failure_code,
    public_emotion_metadata,
)
from app.services.blackboard import Blackboard
from app.services.branch_lineage import BranchLineageError, select_branch_rounds
from app.services.lang_detect import get_language_directive
from app.services.llm_client import (
    classify_llm_error_code,
    format_untrusted_text_block,
    get_last_native_citations,
    get_runtime_parallelism_limit,
    llm_call,
    llm_call_json,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
    normalize_native_search_upstream,
    sanitize_untrusted_text,
)
from app.services.llm_resolution import (
    merge_profile_provider_overrides,
    model_profile_provider_unresolved,
    raise_unresolved_model_profile_provider,
    recover_profile_provider_overrides,
)
from app.services.memory import (
    build_agent_context,
    compress_rounds,
    format_briefing_for_context,
    format_messages_for_context,
    retrieve_relevant_memories,
    store_memory,
)
from app.services.narrator import (
    _build_fallback_narration,
    _strip_round_markers,
    narrate_branch,
)
from app.services.result_report.claims import compile_branch_narrative_claims
from app.services.runtime_lock import (
    RuntimeLockLease,
    acquire_runtime_lock,
    release_runtime_lock,
    runtime_lock_is_active,
    simulation_lock_key,
)
from app.services.simulation_cancel import clear_cancel_token, get_cancel_token, is_cancelled

# Phase 3 F2: Causal graph hook (non-blocking, fire-and-forget)
try:
    from app.services.causal_graph import append_round_nodes as _causal_append

    _CAUSAL_AVAILABLE = True
except ImportError:
    _CAUSAL_AVAILABLE = False

try:
    from app.services.kg_realtime import push_delta as _kg_push_delta

    _KG_REALTIME_AVAILABLE = True
except ImportError:
    _KG_REALTIME_AVAILABLE = False

# Phase 3 F5: Faction detection hook (non-blocking)
try:
    from app.services.factions import (
        build_previous_round_relationship_contexts as _factions_relationship_contexts,
    )
    from app.services.factions import process_round as _factions_process

    _FACTIONS_AVAILABLE = True
except ImportError:
    _FACTIONS_AVAILABLE = False

# Phase 3 F4: Checkpoint hook (non-blocking)
try:
    from app.services.replay import write_checkpoint as _checkpoint_write

    _CHECKPOINT_AVAILABLE = True
except ImportError:
    _CHECKPOINT_AVAILABLE = False

# V2: Visualization layer (lazy-loaded only when enabled)
try:
    from app.visualization import (
        VisualizationMapper,
        assign_position,
        assign_sprites_batch,
        check_card_trigger,
        get_card_viz_event,
        select_scene,
    )

    _VIZ_AVAILABLE = True
except ImportError:
    _VIZ_AVAILABLE = False


# ── Intervention Queue ───────────────────────────────────
# File-backed SQLite deployments use a shared DB queue so different workers
# can see the same pending interventions. In-memory fallback is kept only
# for tests / non-file SQLite URLs.
@dataclass(frozen=True)
class PendingInterventionItem:
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)
    id: int | None = None
    display_text: str = ""

    def __str__(self) -> str:
        return self.text

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):
            return self.text == other
        if isinstance(other, PendingInterventionItem):
            return (
                self.text == other.text
                and self.metadata == other.metadata
                and self.display_text == other.display_text
            )
        return False


pending_interventions: dict[str, list[PendingInterventionItem]] = {}
_intervention_lock = asyncio.Lock()

logger = logging.getLogger(__name__)


class AgentTurnBatchFailure(RuntimeError):
    """Raised when a whole turn batch is degraded by provider-level LLM failures."""

    def __init__(self, *, code: str, failed_agents: list[str]):
        self.code = code
        self.failed_agents = failed_agents
        agent_list = ", ".join(failed_agents)
        super().__init__(f"Agent turn batch failed with {code}: {agent_list}")


_NARRATE_MAX_CHARS = 3000
_TERMINAL_NARRATION_NEWEST_MESSAGE_LIMIT = 96
_DEFAULT_AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS = 45.0
_DEFAULT_AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS = 120.0
_DEFAULT_AGENT_TURN_TOTAL_TIMEOUT_SECONDS = 180.0
_FORK_DEBUG_TRACE_KEY = "fork_debug_trace"
_FORK_DEBUG_MAX_SIGNALS = 12
_FORK_DEBUG_MAX_SIGNAL_CHARS = 240
_FORK_DEBUG_MAX_SUMMARY_CHARS = 1200
_FORK_DEBUG_MAX_DESCRIPTION_CHARS = 240
_IDENTITY_COMPACTION_STREAM_PROBE_TIMEOUT_SECONDS = 5.0
_RESULT_VERDICT_TIMEOUT_SECONDS = 10.0
_RESULT_VERDICT_CONFIDENCE_KIND = "model_self_rating"
_RESULT_VERDICT_CONFIDENCE_BRANCH_IDS_KEY = "confidence_terminal_branch_ids"
_FORK_TITLE_REWRITE_TIMEOUT_SECONDS = 8.0
_FORK_TITLE_REWRITE_MAX_CONCURRENCY = 4
_TURN_MAX_CHARS = 3000
_AGENT_TURN_PROMPT_PREFIX_MARKER = "SWARMORACLE_AGENT_TURN_OUTPUT_CONTRACT"
_BLACKBOARD_OWN_MEMORY_TOP_K = 3
_FORK_TITLE_REWRITE_MARKER = "FORK_TITLE_REWRITE"
_FORK_TITLE_FORBIDDEN_JARGON = (
    "page-fault-terminal",
    "rollback-log",
    "gray-column",
    "paw-print-column",
    "灰柱",
    "爪印列",
    "终端缺页",
    "回滚日志",
)
_PROMPT_LEAK_RE = re.compile(
    r"^\s*export\s+(?:interface|const|function|type)\b[^\n]*(?:[;={]|\([^\n]*\)\s*(?:=>|\{))|"
    r"buildCharacterSystemPrompt|CharacterPromptContext|SummaryContext|"
    r"DivergenceCheckContext|packages/llm/src|"
    r"SWARMORACLE_AGENT_TURN_OUTPUT_CONTRACT|"
    r"你现在只作为角色|"
    r"You are speaking only as the character named|"
    r"Output only first-person plain-text character speech",
    re.IGNORECASE | re.MULTILINE,
)
_WHOLE_CODE_FENCE_RE = re.compile(
    r"^\s*```(?:ts|typescript|json)\b[\s\S]*```\s*$",
    re.IGNORECASE,
)
_ROLE_MARKER_LINE_RE = re.compile(
    r"^\s*(?:system|assistant|user|tool)\s*[:：]",
    re.IGNORECASE | re.MULTILINE,
)
_MEMORY_PROMOTION_SYNC_QUARANTINE_TASKS_V1: set[asyncio.Task[Any]] = set()


def _memory_promotion_snapshot_has_credential_v1(value: object) -> bool:
    from app.log_sanitize import contains_credential_material

    if isinstance(value, str):
        return contains_credential_material(value)
    if isinstance(value, Mapping):
        return any(
            _memory_promotion_snapshot_has_credential_v1(key)
            or _memory_promotion_snapshot_has_credential_v1(item)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple, set, frozenset)):
        return any(_memory_promotion_snapshot_has_credential_v1(item) for item in value)
    return False


async def _bounded_memory_promotion_thread_call_v1(
    function: Callable[..., Any],
    /,
    *args: Any,
    deadline: float,
    **kwargs: Any,
) -> Any:
    from app.services.vector_store import (
        MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1,
        Stage3QuarantineOwnershipV1,
    )

    remaining = deadline - monotonic()
    if remaining <= 0:
        raise TimeoutError
    capsule = Stage3QuarantineOwnershipV1()
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    capsule.task = task
    capsule.task_kind = "integration_sync_call"
    try:
        result = await asyncio.wait_for(
            asyncio.shield(task),
            timeout=min(MEMORY_PROMOTION_CHROMA_CALL_TIMEOUT_SECONDS_V1, remaining),
        )
    except BaseException:
        if capsule.transfer_to_quarantine():
            cleanup = asyncio.create_task(
                _settle_memory_promotion_sync_quarantine_v1(capsule)
            )
            capsule.cleanup_task = cleanup
            _MEMORY_PROMOTION_SYNC_QUARANTINE_TASKS_V1.add(cleanup)
            cleanup.add_done_callback(
                _MEMORY_PROMOTION_SYNC_QUARANTINE_TASKS_V1.discard
            )
        raise
    capsule.task = None
    capsule.task_kind = None
    capsule.mark_released()
    return result


async def _settle_memory_promotion_sync_quarantine_v1(capsule: Any) -> None:
    task = capsule.task
    try:
        while task is not None and not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except BaseException:
                break
        if task is not None and task.done():
            try:
                task.result()
            except BaseException:
                pass
    finally:
        capsule.task = None
        capsule.task_kind = None
        capsule.mark_released()


async def _drive_verified_memory_promotion_v1(
    engine,
    *,
    historical_reconciliation: bool,
    user_id: str | None = None,
    scenario_id: str | None = None,
    branch_id: str | None = None,
    round_id: str | None = None,
    round_number: int | None = None,
    deadline: float | None = None,
) -> tuple[object, ...]:
    from app.services.agent_runtime import (
        load_current_memory_promotion_claims_v1,
        revalidate_verified_memory_promotion_authority_v1,
        scan_verified_memory_promotion_authority_v1,
    )
    from app.services.memory import build_verified_memory_promotions_v1
    from app.services.vector_store import (
        MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1,
        MemoryPromotionStoreResultV1,
        store_verified_memory_promotions_v1,
    )

    def unavailable(reason: str) -> MemoryPromotionStoreResultV1:
        return MemoryPromotionStoreResultV1(
            status="unavailable",
            reason_code=reason,
            refs=(),
        )
    active_deadline = (
        deadline
        if deadline is not None
        else monotonic() + MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1
    )
    try:
        snapshots = await _bounded_memory_promotion_thread_call_v1(
            scan_verified_memory_promotion_authority_v1,
            engine,
            deadline=active_deadline,
            user_id=user_id,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_id=round_id,
            round_number=round_number,
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        return (unavailable("MEMORY_PROMOTION_STORE_UNAVAILABLE"),)

    results: list[object] = []
    for snapshot in snapshots:
        if active_deadline - monotonic() <= 0:
            results.append(unavailable("MEMORY_PROMOTION_STORE_UNAVAILABLE"))
            break
        try:
            credential_hit = historical_reconciliation and bool(
                await _bounded_memory_promotion_thread_call_v1(
                    _memory_promotion_snapshot_has_credential_v1,
                    snapshot,
                    deadline=active_deadline,
                )
            )
            if credential_hit:
                results.append(unavailable("MEMORY_PROMOTION_CREDENTIAL_REJECTED"))
                continue
            batch = await _bounded_memory_promotion_thread_call_v1(
                build_verified_memory_promotions_v1,
                snapshot,
                deadline=active_deadline,
            )
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            results.append(unavailable("MEMORY_PROMOTION_STORE_UNAVAILABLE"))
            break
        except Exception:
            results.append(unavailable("MEMORY_PROMOTION_RECORD_CONFLICT"))
            continue
        if batch.status != "verified":
            results.append(batch)
            continue
        owner_id = str(batch.owner_id or "")
        remaining = active_deadline - monotonic()
        if remaining <= 0:
            results.append(unavailable("MEMORY_PROMOTION_STORE_UNAVAILABLE"))
            break
        try:
            result = await asyncio.wait_for(
                store_verified_memory_promotions_v1(
                    user_id=owner_id,
                    batch=batch,
                    expected_authority_snapshot=snapshot,
                    revalidate_authority=lambda expected, _engine=engine: (
                        revalidate_verified_memory_promotion_authority_v1(
                            _engine, expected
                        )
                    ),
                    load_current_claims=lambda _engine=engine, _owner=owner_id: (
                        load_current_memory_promotion_claims_v1(
                            _engine, user_id=_owner
                        )
                    ),
                ),
                timeout=remaining,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            result = unavailable("MEMORY_PROMOTION_STORE_UNAVAILABLE")
        results.append(result)
    return tuple(results)


async def attempt_verified_memory_promotion_v1(
    engine,
    *,
    scenario_id: str,
    branch_id: str,
    round_id: str,
    round_number: int,
    deadline: float | None = None,
) -> tuple[object, ...]:
    return await _drive_verified_memory_promotion_v1(
        engine,
        historical_reconciliation=False,
        scenario_id=scenario_id,
        branch_id=branch_id,
        round_id=round_id,
        round_number=round_number,
        deadline=deadline,
    )


async def reconcile_verified_memory_promotions_v1(
    engine,
    *,
    user_id: str | None = None,
) -> tuple[object, ...]:
    return await _drive_verified_memory_promotion_v1(
        engine,
        historical_reconciliation=True,
        user_id=user_id,
    )


def _run_memory_promotion_reconciliation_sync_v1(
    engine,
    *,
    user_id: str | None = None,
) -> bool:
    import threading

    from app.services.vector_store import MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1

    failures: list[BaseException] = []

    def run() -> None:
        try:
            asyncio.run(
                reconcile_verified_memory_promotions_v1(engine, user_id=user_id)
            )
        except BaseException as exc:
            failures.append(exc)

    worker = threading.Thread(
        target=run,
        name="memory-promotion-reconciliation-v1",
        daemon=True,
    )
    worker.start()
    worker.join(MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1)
    if worker.is_alive():
        return False
    if failures:
        raise failures[0]
    return True


async def _recall_memory_promotion_context_v1(
    engine,
    *,
    scenario_id: str,
    agent_id: str,
    query_text: str,
):
    from app.services.agent_runtime import load_memory_promotion_recall_binding_v1
    from app.services.memory import build_recall_context_v1
    from app.services.vector_store import (
        MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1,
        recall_verified_memory_promotions_v1,
    )

    deadline = monotonic() + MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1
    try:
        binding = await _bounded_memory_promotion_thread_call_v1(
            load_memory_promotion_recall_binding_v1,
            engine,
            deadline=deadline,
            scenario_id=scenario_id,
            agent_id=agent_id,
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_RECORD_MISMATCH"
        )
    if binding is None:
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_RECORD_MISMATCH"
        )
    remaining = deadline - monotonic()
    if remaining <= 0:
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_STORE_UNAVAILABLE"
        )
    try:
        context = await asyncio.wait_for(
            recall_verified_memory_promotions_v1(
                user_id=binding.user_id,
                identity_id=binding.identity_id,
                current_scenario_id=scenario_id,
                query_text=query_text,
            ),
            timeout=remaining,
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        return build_recall_context_v1(
            (), status="unavailable", reason_code="MEMORY_RECALL_STORE_UNAVAILABLE"
        )
    return context or build_recall_context_v1(
        (), status="unavailable", reason_code="MEMORY_RECALL_STORE_UNAVAILABLE"
    )


def _llm_scope_kwargs(
    overrides: dict[str, Any] | None,
    *,
    purpose: str,
) -> dict[str, Any]:
    overrides = overrides or {}
    try:
        native_search_upstream_override = normalize_native_search_upstream(
            overrides.get("native_search_upstream_override")
        )
    except ValueError:
        native_search_upstream_override = None
    return {
        "purpose": purpose,
        "requests_per_minute": overrides.get("requests_per_minute"),
        "tokens_per_minute": overrides.get("tokens_per_minute"),
        "concurrency": overrides.get("concurrency"),
        "supports_structured_outputs_override": overrides.get(
            "supports_structured_outputs_override"
        ),
        "supports_native_search_override": overrides.get("supports_native_search_override"),
        "native_search_upstream_override": native_search_upstream_override,
    }


class SimulationCancelled(Exception):
    def __init__(self, scenario_id: str):
        super().__init__(scenario_id)
        self.scenario_id = scenario_id


class RuntimeLeaseLost(SimulationCancelled):
    """Stop only the stale worker; a new lease owner remains authoritative."""


def _check_cancelled(scenario_id: str) -> None:
    if is_cancelled(scenario_id):
        raise SimulationCancelled(scenario_id)


def _native_search_domains_from_context(ctx: dict[str, Any]) -> list[str] | None:
    selected_families = ctx.get("web_search_families")
    if not isinstance(selected_families, list) or not selected_families:
        return None

    from app.services.web_context import FAMILY_DOMAIN_FILTERS, _sanitize_domain_filters

    domains: list[str] = []
    for family in selected_families:
        if not isinstance(family, str):
            continue
        domains.extend(FAMILY_DOMAIN_FILTERS.get(family.strip(), []))
    sanitized = _sanitize_domain_filters(domains)
    return sanitized or None


def _persist_native_citations(
    engine,
    scenario_id: str,
    citations: list[object] | None,
) -> bool:
    if not citations:
        return False

    from app.services.web_context import merge_native_citations_into_web_context_json

    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return False
        next_json = merge_native_citations_into_web_context_json(
            scenario.web_context_json,
            citations,
            query=scenario.question or "",
            provider="native",
        )
        if not next_json or next_json == scenario.web_context_json:
            return False
        scenario.web_context_json = next_json
        session.add(scenario)
        session.commit()
        return True


async def _append_causal_graph_delta(
    scenario_id: str,
    branch_id: str,
    round_number: int,
    messages: list,
    *,
    fork_event: dict | None = None,
    language: str = "Chinese",
) -> None:
    delta = await asyncio.to_thread(
        _causal_append,
        scenario_id,
        branch_id,
        round_number,
        messages,
        **({"fork_event": fork_event} if fork_event is not None else {}),
        language=language,
    )
    if not _KG_REALTIME_AVAILABLE or delta is None:
        return
    if not (delta.added or delta.updated or delta.deleted or delta.snapshot_invalidated):
        return
    try:
        await _kg_push_delta(scenario_id, delta)
    except Exception:
        logger.debug("kg_realtime delta push failed (non-blocking)", exc_info=True)


def _truncate_debug_text(value: Any, *, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return f"{text[: max_chars - 1]}…"


_DIVERGE_MARKER_START_RE = re.compile(r"[\[［]\s*DIVERGE\s*[:：]", re.IGNORECASE)


def _find_diverge_marker_end(text: str, start: int) -> int | None:
    depth = 0
    for index in range(start, len(text)):
        char = text[index]
        if char in "[［":
            depth += 1
        elif char in "]］":
            depth -= 1
            if depth == 0:
                return index + 1
    return None


def _strip_diverge_marker(text: str) -> str:
    """Remove [DIVERGE: ...] markers from user-facing content.

    The Pass-1 prompt instructs LLMs to emit these markers as internal fork
    signals; they must not leak into the displayed agent message.
    """
    chunks: list[str] = []
    search_from = 0
    while True:
        match = _DIVERGE_MARKER_START_RE.search(text, search_from)
        if not match:
            chunks.append(text[search_from:])
            break
        chunks.append(text[search_from : match.start()])
        marker_end = _find_diverge_marker_end(text, match.start())
        if marker_end is None:
            break
        search_from = marker_end
    return "".join(chunks).rstrip()


def _has_consecutive_code_prefix_lines(text: str) -> bool:
    consecutive = 0
    for raw_line in text.splitlines():
        line = raw_line.lstrip()
        if line.startswith(("import ", "//", "/*")):
            consecutive += 1
            if consecutive >= 3:
                return True
        elif line:
            consecutive = 0
    return False


def _is_speaker_label_only(text: str, agent_name: str) -> bool:
    name = (agent_name or "").strip()
    if not name:
        return False
    escaped_name = re.escape(name)
    patterns = (
        rf"^[\[【（(]\s*{escaped_name}\s*[\]】）)]\s*$",
        rf"^[\[【（(]\s*{escaped_name}\s*[\]】）)]\s*[:：]\s*$",
        rf"^{escaped_name}\s*[:：]\s*$",
    )
    return any(re.fullmatch(pattern, text.strip()) for pattern in patterns)


def _has_prompt_leak_shape(text: str) -> bool:
    return (
        bool(_PROMPT_LEAK_RE.search(text))
        or bool(_WHOLE_CODE_FENCE_RE.fullmatch(text))
        or bool(_ROLE_MARKER_LINE_RE.search(text))
        or _has_consecutive_code_prefix_lines(text)
    )


def _has_meaningful_body_text(text: str) -> bool:
    compact = "".join(ch for ch in text if not ch.isspace())
    if not compact:
        return False
    if all(unicodedata.category(ch)[0] in {"P", "S"} for ch in compact):
        return False
    return any(ch.isalnum() for ch in compact)


def validate_and_sanitize_turn(
    text: str,
    agent_name: str,
    language: str,
) -> tuple[str | None, str | None]:
    """Return display-safe turn text or a conservative rejection reason."""
    del language  # The thresholds are script-agnostic and intentionally minimal.
    cleaned = _strip_diverge_marker(str(text or "")).strip()
    if _has_prompt_leak_shape(cleaned):
        return None, "leak"
    if not _has_meaningful_body_text(cleaned) or _is_speaker_label_only(cleaned, agent_name):
        return None, "empty"
    if len(cleaned) > _TURN_MAX_CHARS:
        cleaned = cleaned[: _TURN_MAX_CHARS - 1].rstrip() + "…"
    return cleaned, None


def _ground_extracted_action_content(action: object, pass_one_content: str) -> object:
    """Fail closed when a content-bearing action is not quoted from Pass-1."""
    if not isinstance(action, dict):
        return action
    action_type = (
        str(action.get("type") or action.get("action_type") or "").upper().strip()
    )
    if action_type not in {"POST", "COMMENT", "SEARCH"}:
        return action

    def normalized_with_spans(value: object) -> tuple[str, list[tuple[int, int]]]:
        source = str(value or "")
        characters: list[str] = []
        spans: list[tuple[int, int]] = []
        clusters: list[tuple[int, int, str]] = []
        cluster_start = 0
        cluster = ""
        normalized_cluster = ""
        for index, original in enumerate(source):
            normalized_original = unicodedata.normalize("NFKC", original)
            if not cluster:
                cluster_start = index
                cluster = original
                normalized_cluster = normalized_original
                continue
            combined = unicodedata.normalize("NFKC", cluster + original)
            if combined == normalized_cluster + normalized_original:
                clusters.append((cluster_start, index, normalized_cluster))
                cluster_start = index
                cluster = original
                normalized_cluster = normalized_original
            else:
                cluster += original
                normalized_cluster = combined
        if cluster:
            clusters.append((cluster_start, len(source), normalized_cluster))

        for start, end, normalized in clusters:
            for character in normalized:
                if character.isspace():
                    if characters and characters[-1] == " ":
                        spans[-1] = (spans[-1][0], end)
                    else:
                        characters.append(" ")
                        spans.append((start, end))
                    continue
                characters.append(character)
                spans.append((start, end))
        while characters and characters[0] == " ":
            characters.pop(0)
            spans.pop(0)
        while characters and characters[-1] == " ":
            characters.pop()
            spans.pop()
        return "".join(characters), spans

    content, _ = normalized_with_spans(action.get("content"))
    meaningful = [character for character in content if character.isalnum()]
    minimum = 2 if any(not character.isascii() for character in meaningful) else 3
    source, source_spans = normalized_with_spans(pass_one_content)
    visible_search_content = any(
        character.isalnum() or unicodedata.category(character).startswith("S")
        for character in content
    )
    meets_minimum = (
        visible_search_content if action_type == "SEARCH" else len(meaningful) >= minimum
    )
    start = source.find(content) if meets_minimum else -1
    while start >= 0:
        end = start + len(content) - 1
        grounded = str(pass_one_content)[source_spans[start][0] : source_spans[end][1]].strip()
        grounded_content, _ = normalized_with_spans(grounded)
        if grounded_content == content:
            if grounded == action.get("content"):
                return action
            grounded_action = dict(action)
            grounded_action["content"] = grounded
            return grounded_action
        start = source.find(content, start + 1)
    return {
        "action_type": "IDLE",
        "status": "unavailable",
        "failure_code": "ACTION_UNGROUNDED_CONTENT",
    }


def _silent_turn_placeholder(agent_name: str, language: str) -> str:
    if _is_chinese_language(language):
        return f"（{agent_name} 沉默了）"
    return f"({agent_name} stays silent)"


def _repetitive_turn_placeholder(
    agent_name: str,
    language: str,
    round_number: int,
) -> str:
    if _is_chinese_language(language):
        return f"（第 {round_number} 轮：{agent_name} 的重复输出未发布。）"
    return f"(Round {round_number}: {agent_name}'s repetitive output was not published.)"


def _coerce_turn_temperature(value: Any, default: float) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _effective_compress_interval(sim_rounds: int | None) -> int:
    try:
        return effective_memory_compress_interval(sim_rounds)
    except Exception:
        logger.debug("Failed to resolve adaptive memory compression interval", exc_info=True)
        try:
            return max(1, int(settings.MEMORY_COMPRESS_INTERVAL))
        except (TypeError, ValueError):
            return 1


def _prepend_agent_turn_prompt_prefix(
    prompt: str,
    *,
    agent_name: str,
    topic: str,
    scenario_question: str = "",
    branch_question: str = "",
    worldline_context: str,
    language: str,
    retry: bool = False,
) -> str:
    if prompt.lstrip().startswith(f"[{_AGENT_TURN_PROMPT_PREFIX_MARKER}]"):
        return prompt

    is_chinese = _is_chinese_language(language)
    original_question_label = "原始 what-if 问题" if is_chinese else "Original what-if question"
    branch_question_label = "分支假设锚点" if is_chinese else "Branch hypothesis anchor"
    worldline_label = "当前世界线/分叉锚点" if is_chinese else "Current worldline/fork anchor"
    original_question = str(scenario_question or topic or "").strip()
    effective_branch_question = str(branch_question or topic or original_question).strip()
    original_question_block = format_untrusted_text_block(
        original_question_label,
        original_question,
        max_chars=600,
    )
    branch_question_block = format_untrusted_text_block(
        branch_question_label,
        effective_branch_question,
        max_chars=600,
    )
    worldline_block = format_untrusted_text_block(
        worldline_label,
        worldline_context or ("无" if is_chinese else "None"),
        max_chars=900,
    )

    if is_chinese:
        lines = [
            f"[{_AGENT_TURN_PROMPT_PREFIX_MARKER}]",
            f"你现在只作为角色「{agent_name}」发言。",
            original_question_block,
            branch_question_block,
            worldline_block,
            "因果链脚手架：先想清楚 (1) 改了哪个核心变量；"
            "(2) 牵动了谁的利益；(3) 各方会怎样理性反应；"
            "(4) 你的结论如何回扣这条因果链。",
            "只输出角色第一人称纯文本发言；不要调用工具；不要输出元信息、代码、"
            "类型定义、文件路径、prompt 模板或 role 标签。",
        ]
        if retry:
            lines.append(
                "上一轮输出被判定为空或疑似泄漏。重新生成时禁止输出任何代码、"
                "类型定义、文件路径、prompt 模板、JSON、Markdown 代码块或系统消息。"
            )
    else:
        lines = [
            f"[{_AGENT_TURN_PROMPT_PREFIX_MARKER}]",
            f"You are speaking only as the character named {agent_name}.",
            original_question_block,
            branch_question_block,
            worldline_block,
            "Causal-chain scaffold: first reason through (1) which core variable changed; "
            "(2) whose interests it affects; (3) how each party would rationally react; "
            "(4) how your result ties back to that causal chain.",
            "Output only first-person plain-text character speech. Do not call tools. "
            "Do not output metadata, code, type definitions, file paths, prompt templates, "
            "or role labels.",
        ]
        if retry:
            lines.append(
                "The previous output was empty or looked like prompt/code leakage. Regenerate "
                "without any code, type definitions, file paths, prompt templates, JSON, "
                "Markdown fences, or system messages."
            )
    return "\n\n".join(lines) + "\n\n" + prompt


def _sanitize_fork_debug_signals(signals: list[str]) -> list[str]:
    unique_signals: list[str] = []
    seen: set[str] = set()
    for signal in signals:
        normalized = _truncate_debug_text(
            signal,
            max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
        )
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_signals.append(normalized)
        if len(unique_signals) >= _FORK_DEBUG_MAX_SIGNALS:
            break
    return unique_signals


def _sanitize_fork_debug_branch(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    title = _truncate_debug_text(
        payload.get("title"),
        max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
    )
    description = _truncate_debug_text(
        payload.get("description"),
        max_chars=_FORK_DEBUG_MAX_DESCRIPTION_CHARS,
    )
    result: dict[str, Any] = {
        "title": title,
        "probability": float(payload.get("probability") or 0.0),
    }
    if description:
        result["description_excerpt"] = description
    return result


def _sanitize_fork_debug_result(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"should_fork": False, "reason": "", "branches": []}

    sanitized_branches = [
        branch
        for branch in (_sanitize_fork_debug_branch(item) for item in payload.get("branches", []))
        if branch is not None
    ]
    return {
        "should_fork": payload.get("should_fork") is True,
        "reason": _truncate_debug_text(
            payload.get("reason"),
            max_chars=_FORK_DEBUG_MAX_SIGNAL_CHARS,
        ),
        "branches": sanitized_branches,
    }


def _normalize_fork_detector_result(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"should_fork": False, "reason": "", "branches": []}

    should_fork = payload.get("should_fork") is True
    reason = str(payload.get("reason") or "").strip()
    normalized_branches: list[dict[str, Any]] = []
    for item in payload.get("branches", []):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        try:
            probability = float(item.get("probability"))
        except (TypeError, ValueError):
            continue
        branch_payload: dict[str, Any] = {
            "title": title,
            "probability": probability,
        }
        description = str(item.get("description") or "").strip()
        if description:
            branch_payload["description"] = description
        normalized_branches.append(branch_payload)

    if not should_fork:
        return {"should_fork": False, "reason": reason, "branches": []}
    if not reason or not normalized_branches:
        return {"should_fork": False, "reason": reason, "branches": []}

    return {
        "should_fork": True,
        "reason": reason,
        "branches": normalized_branches,
    }


async def _summarize_identity_compaction_group(
    summaries: list[str],
    *,
    scenario_ids: list[str] | None = None,
    llm_overrides: dict | None = None,
) -> str:
    from app.services.vector_store import build_compaction_prompt

    prompt = build_compaction_prompt(summaries, scenario_ids)
    fallback_summary = " | ".join(summaries)[:600]

    try:
        _overrides = llm_overrides or {}
        with llm_request_scope(**_llm_scope_kwargs(_overrides, purpose="identity_compaction")):
            result = await llm_call_json_with_stream_fallback(
                prompt,
                reasoning_effort="low",
                model=_overrides.get("model"),
                api_key=_overrides.get("api_key"),
                base_url=_overrides.get("base_url"),
                temperature=0.3,
                probe_timeout=_IDENTITY_COMPACTION_STREAM_PROBE_TIMEOUT_SECONDS,
            )
        summary = str(result.get("compacted_summary") or "").strip()
        if summary:
            return summary
    except Exception as exc:
        logger.warning(
            "identity compaction non-stream failed, using text fallback: %s: %s",
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )

    return fallback_summary


def _record_fork_debug_trace(engine, scenario_id: str, entry: dict[str, Any]) -> None:
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return

        ctx = dict(scenario.parsed_context or {})
        trace = list(ctx.get(_FORK_DEBUG_TRACE_KEY) or [])
        trace.append(entry)
        if len(trace) > 200:
            trace = trace[-200:]
        ctx[_FORK_DEBUG_TRACE_KEY] = trace
        scenario.parsed_context = ctx
        session.add(scenario)
        session.commit()


def _clean_attribution_text(value: object) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _persist_llm_attribution_context(
    engine,
    scenario_id: str,
    ctx: dict[str, Any],
    llm_overrides: dict[str, Any] | None,
) -> dict[str, Any]:
    """Fill missing LLM attribution pointers without touching simulation content."""

    overrides = llm_overrides or {}
    updates: dict[str, str] = {}
    model_profile_id = _clean_attribution_text(overrides.get("model_profile_id"))
    if model_profile_id and _clean_attribution_text(ctx.get("model_profile_id")) is None:
        updates["model_profile_id"] = model_profile_id
    user_id = _clean_attribution_text(overrides.get("quota_user_id"))
    if user_id and _clean_attribution_text(ctx.get("user_id")) is None:
        updates["user_id"] = user_id
    if not updates:
        return ctx

    merged_ctx = {**ctx, **updates}
    try:
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            if scenario is None:
                return merged_ctx
            current_ctx = (
                dict(scenario.parsed_context) if isinstance(scenario.parsed_context, dict) else {}
            )
            changed = False
            for key, value in updates.items():
                if _clean_attribution_text(current_ctx.get(key)) is None:
                    current_ctx[key] = value
                    changed = True
            if changed:
                scenario.parsed_context = current_ctx
                session.add(scenario)
                session.commit()
                return current_ctx
    except Exception:
        logger.debug(
            "LLM attribution persistence failed for scenario %s", scenario_id, exc_info=True
        )
    return merged_ctx


def _get_fork_prompt_template(language: str, variant: str) -> str:
    normalized_variant = (variant or "a").strip().lower()
    lang = language if language == "Chinese" else "English"
    key = (lang, normalized_variant)
    if key not in _FORK_VARIANTS:
        key = (lang, "a")  # fallback to default variant
    return _build_fork_prompt(_FORK_VARIANTS[key], lang)


def _fork_title_question_anchor(question: str) -> str:
    compact = re.sub(r"\s+", " ", str(question or "(empty)")).strip()
    compact = compact[:180].rstrip()
    return compact.replace('"', "'")


def _contains_fork_title_jargon(title: str) -> bool:
    normalized = title.lower()
    return any(term.lower() in normalized for term in _FORK_TITLE_FORBIDDEN_JARGON)


def _clean_fork_title_rewrite_candidate(
    raw_title: object,
    *,
    language: str,
) -> str | None:
    candidate: object = raw_title
    if isinstance(raw_title, dict):
        candidate = raw_title.get("title")

    text = _strip_diverge_marker(str(candidate or "")).strip()
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            text = _strip_diverge_marker(str(parsed.get("title") or "")).strip()

    text = re.sub(r"^```(?:json|text|markdown)?", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"```$", "", text).strip()
    if "\n" in text:
        text = next((line.strip() for line in text.splitlines() if line.strip()), "")
    text = re.sub(r"^(?:title|标题)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    text = text.strip(" \t\r\n\"'`“”‘’")
    if not text or _has_prompt_leak_shape(text) or _contains_fork_title_jargon(text):
        return None

    if _is_chinese_language(language):
        if len(re.sub(r"\s+", "", text)) > 22:
            return None
    else:
        if len(re.findall(r"\S+", text)) > 14:
            return None
    return text


def _build_fork_title_rewrite_prompt(
    *,
    question: str,
    current_title: str,
    story: str,
    language: str,
) -> str:
    is_chinese = _is_chinese_language(language)
    question_block = format_untrusted_text_block(
        "用户原始问题" if is_chinese else "Original user question",
        question or "(empty)",
        max_chars=1200,
    )
    title_block = format_untrusted_text_block(
        "当前分支标题" if is_chinese else "Current branch title",
        current_title or "(untitled)",
        max_chars=220,
    )
    story_block = format_untrusted_text_block(
        "完整结局故事" if is_chinese else "Complete ending story",
        story[:2000],
        max_chars=2000,
    )
    if is_chinese:
        return (
            f"{_FORK_TITLE_REWRITE_MARKER}\n"
            "根据完整结局故事，重写这条世界线的短标题。\n\n"
            f"{question_block}\n\n"
            f"{title_block}\n\n"
            f"{story_block}\n\n"
            "规则：\n"
            "- 用通俗语言，一眼回答原始问题。\n"
            "- 标题必须描述具体、外部可见的最终收场。\n"
            "- 不要复述讨论过程，不要内部黑话、抽象标签、四字口号或系统术语。\n"
            "- 中文不超过 22 个字；英文不超过 14 个词。\n"
            "- 只输出新标题本身，不要 JSON、解释、引号或编号。\n"
            f"{get_language_directive(language)}"
        )
    return (
        f"{_FORK_TITLE_REWRITE_MARKER}\n"
        "Rewrite this worldline title after reading the complete ending story.\n\n"
        f"{question_block}\n\n"
        f"{title_block}\n\n"
        f"{story_block}\n\n"
        "Rules:\n"
        "- Use plain language and answer the original question at a glance.\n"
        "- Name the concrete visible ending, not the debate process.\n"
        "- Use no internal jargon, abstract labels, slogan titles, or system terms.\n"
        "- Chinese <=22 chars, English <=14 words.\n"
        "- Output only the new title, with no JSON, explanation, quotes, or numbering.\n"
        f"{get_language_directive(language)}"
    )


def _persist_branch_title(engine, branch_id: str, title: str) -> None:
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch is None:
            return
        branch.title = title
        session.add(branch)
        session.commit()


async def _rewrite_single_branch_title_after_narration(
    engine,
    branch_payload: dict[str, Any],
    *,
    question: str,
    language: str,
    llm_overrides: dict[str, Any] | None,
) -> None:
    branch_id = str(branch_payload.get("id") or "").strip()
    story = str(branch_payload.get("story") or "").strip()
    if not branch_id or not story:
        return

    current_title = str(branch_payload.get("title") or "").strip()
    prompt = _build_fork_title_rewrite_prompt(
        question=question,
        current_title=current_title,
        story=story,
        language=language,
    )
    _overrides = llm_overrides or {}
    with llm_request_scope(**_llm_scope_kwargs(_overrides, purpose="scenario_fork_title_rewrite")):
        raw_title = await asyncio.wait_for(
            llm_call(
                prompt,
                reasoning_effort="low",
                model=_overrides.get("model"),
                api_key=_overrides.get("api_key"),
                base_url=_overrides.get("base_url"),
                temperature=(
                    _overrides.get("temperature")
                    if _overrides.get("temperature") is not None
                    else 0.2
                ),
                timeout=_FORK_TITLE_REWRITE_TIMEOUT_SECONDS,
            ),
            timeout=_FORK_TITLE_REWRITE_TIMEOUT_SECONDS,
        )

    new_title = _clean_fork_title_rewrite_candidate(raw_title, language=language)
    if not new_title or new_title == current_title:
        return
    _persist_branch_title(engine, branch_id, new_title)
    branch_payload["title"] = new_title


async def _rewrite_branch_titles_after_narration(
    engine,
    branch_payloads: list[dict[str, Any]],
    *,
    question: str,
    language: str,
    llm_overrides: dict[str, Any] | None,
) -> None:
    if not settings.FEATURE_FORK_TITLE_REWRITE:
        return
    if not branch_payloads:
        return

    semaphore = asyncio.Semaphore(
        max(1, min(_FORK_TITLE_REWRITE_MAX_CONCURRENCY, len(branch_payloads)))
    )

    async def _rewrite_with_guard(branch_payload: dict[str, Any]) -> None:
        try:
            async with semaphore:
                await _rewrite_single_branch_title_after_narration(
                    engine,
                    branch_payload,
                    question=question,
                    language=language,
                    llm_overrides=llm_overrides,
                )
        except Exception as exc:  # noqa: BLE001 - title polish must not block completion
            logger.warning(
                "Fork title rewrite failed for branch %s (non-blocking): %s: %s",
                branch_payload.get("id"),
                type(exc).__name__,
                _scrub_sensitive_text(str(exc)),
            )

    await asyncio.gather(
        *(_rewrite_with_guard(branch_payload) for branch_payload in branch_payloads)
    )


_TERMINAL_SCENARIO_STATUSES = {
    ScenarioStatus.CANCELLED,
    ScenarioStatus.DONE,
    ScenarioStatus.ERROR,
}
_SCENARIO_BRANCH_RECONCILE_STATUSES = {
    ScenarioStatus.CANCELLED,
    ScenarioStatus.ERROR,
}
_TERMINAL_BRANCH_STATUSES = {
    BranchStatus.COMPLETED,
    BranchStatus.PRUNED,
}


def _reconcile_unfinished_branches_for_terminal_scenario_session(
    session: Session,
    scenario_id: str,
) -> int:
    updated = 0
    branches = session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all()
    for branch in branches:
        if branch.status in _TERMINAL_BRANCH_STATUSES:
            continue
        branch.status = BranchStatus.PRUNED
        session.add(branch)
        updated += 1
    return updated


def reconcile_unfinished_branches_for_terminal_scenario(
    engine,
    scenario_id: str,
) -> int:
    """Prune branches left unfinished under ERROR/CANCELLED scenarios."""
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None or scenario.status not in _SCENARIO_BRANCH_RECONCILE_STATUSES:
            return 0
        updated = _reconcile_unfinished_branches_for_terminal_scenario_session(
            session,
            scenario_id,
        )
        if updated:
            session.commit()
        return updated


def _update_scenario_status(engine, scenario_id: str, status: ScenarioStatus) -> None:
    """Persist scenario status so reconnects/resyncs can recover the current stage.

    Terminal states (CANCELLED, DONE, ERROR) are sticky and cannot be overwritten,
    preventing races where a late simulator stage transition clobbers a user cancel.
    """
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return
        if scenario.status == status or scenario.status in _TERMINAL_SCENARIO_STATUSES:
            if scenario.status in _SCENARIO_BRANCH_RECONCILE_STATUSES:
                updated = _reconcile_unfinished_branches_for_terminal_scenario_session(
                    session,
                    scenario_id,
                )
                if updated:
                    session.commit()
            return
        scenario.status = status
        if status in _SCENARIO_BRANCH_RECONCILE_STATUSES:
            _reconcile_unfinished_branches_for_terminal_scenario_session(
                session,
                scenario_id,
            )
        session.add(scenario)
        session.commit()


async def handle_simulation_cancelled(
    scenario_id: str,
    *,
    ws_callback: Any = None,
) -> None:
    """Persist and broadcast the user-cancel terminal state once."""
    token = get_cancel_token(scenario_id)
    reason = token.reason if token is not None else "user_cancelled"
    engine = get_engine()
    should_broadcast = False
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            should_broadcast = False
        elif scenario.status in {ScenarioStatus.DONE, ScenarioStatus.ERROR}:
            should_broadcast = False
        elif scenario.status == ScenarioStatus.CANCELLED:
            if _reconcile_unfinished_branches_for_terminal_scenario_session(
                session,
                scenario_id,
            ):
                session.commit()
            should_broadcast = token is not None
        else:
            scenario.status = ScenarioStatus.CANCELLED
            _reconcile_unfinished_branches_for_terminal_scenario_session(
                session,
                scenario_id,
            )
            session.add(scenario)
            session.commit()
            should_broadcast = True

    if should_broadcast and ws_callback:
        await ws_callback(scenario_id, {"type": "simulation_cancelled", "reason": reason})

    clear_cancel_token(scenario_id)
    try:
        from app.api.helpers import clear_running_task

        clear_running_task(scenario_id)
    except Exception:
        logger.debug("Failed to clear running task for cancelled simulation", exc_info=True)


def _pick_theater_ending_payload(
    narrated_branches: list[dict[str, Any]],
    *,
    branch_id: str | None = None,
) -> dict[str, Any] | None:
    """Choose the single ending payload Theater should present."""
    if not narrated_branches:
        return None

    if branch_id is not None:
        for item in narrated_branches:
            if item.get("id") == branch_id:
                return item

    candidate_branches = _terminal_branch_candidates(narrated_branches, narrated_branches)

    def _sort_key(item: dict[str, Any]) -> tuple[float, int, str]:
        try:
            probability = float(item.get("probability") or 0)
        except (TypeError, ValueError):
            probability = 0.0
        try:
            fork_round = int(item.get("fork_round") or 0)
        except (TypeError, ValueError):
            fork_round = 0
        return (-probability, fork_round, str(item.get("id") or ""))

    return min(candidate_branches, key=_sort_key)


def _branch_id_value(branch: dict[str, Any]) -> str:
    return str(branch.get("id") or "").strip()


def _parent_branch_id_value(branch: dict[str, Any]) -> str:
    return str(branch.get("parent_branch_id") or "").strip()


def _terminal_branch_candidates(
    branches: list[dict[str, Any]],
    all_branches: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return leaf branches for final outcome semantics, with fail-soft fallback."""
    if not branches:
        return []

    parent_ids = {
        parent_id
        for branch in (all_branches or branches)
        if (parent_id := _parent_branch_id_value(branch))
    }
    terminal = [
        branch
        for branch in branches
        if _branch_id_value(branch) and _branch_id_value(branch) not in parent_ids
    ]
    return terminal or branches


def reconcile_scenario_done_if_complete(
    engine,
    scenario_id: str,
    *,
    ignore_runtime_lock: bool = False,
) -> bool:
    """Mark a stale simulating/narrating scenario as done when all branch data is final."""
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            return False
        if scenario.status not in (ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING):
            return False
        if not ignore_runtime_lock and runtime_lock_is_active(simulation_lock_key(scenario_id)):
            return False

        branches = session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all()
        if not branches:
            return False
        if any(branch.status == BranchStatus.ACTIVE for branch in branches):
            return False

        completed_branches = [
            branch for branch in branches if branch.status == BranchStatus.COMPLETED
        ]
        if not completed_branches:
            return False
        parent_ids = {branch.parent_branch_id for branch in branches if branch.parent_branch_id}
        terminal_completed_branches = [
            branch for branch in completed_branches if branch.id not in parent_ids
        ]
        branches_requiring_narration = terminal_completed_branches or completed_branches
        if any(
            not (branch.story or "").strip() or not (branch.insight or "").strip()
            for branch in branches_requiring_narration
        ):
            return False

        if settings.FEATURE_AGENT_IDENTITY and settings.FEATURE_MEMORY_PROMOTION:
            try:
                _run_memory_promotion_reconciliation_sync_v1(
                    engine,
                    user_id=str(scenario.user_id or ""),
                )
            except Exception:
                logger.warning(
                    "Verified memory promotion pre-terminal reconciliation unavailable"
                )
        scenario.status = ScenarioStatus.DONE
        session.add(scenario)
        session.commit()
        return True


def _coerce_activity_datetime(value: Any) -> datetime | None:
    if isinstance(value, tuple):
        value = value[0] if value else None
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def simulation_last_activity_at(
    engine,
    scenario_id: str,
    *,
    include_created_at: bool = True,
) -> datetime | None:
    """Return latest durable simulation activity from existing timestamped tables."""
    timestamps: list[datetime] = []
    with Session(engine) as session:
        if include_created_at:
            scenario = session.get(Scenario, scenario_id)
            scenario_created = _coerce_activity_datetime(
                getattr(scenario, "created_at", None) if scenario is not None else None
            )
            if scenario_created is not None:
                timestamps.append(scenario_created)

        latest_frame_at = session.exec(
            select(AgentStateFrame.created_at)
            .where(AgentStateFrame.scenario_id == scenario_id)
            .order_by(AgentStateFrame.created_at.desc())
        ).first()
        frame_at = _coerce_activity_datetime(latest_frame_at)
        if frame_at is not None:
            timestamps.append(frame_at)

        latest_checkpoint_at = session.exec(
            select(ScenarioCheckpoint.created_at)
            .where(ScenarioCheckpoint.scenario_id == scenario_id)
            .order_by(ScenarioCheckpoint.created_at.desc())
        ).first()
        checkpoint_at = _coerce_activity_datetime(latest_checkpoint_at)
        if checkpoint_at is not None:
            timestamps.append(checkpoint_at)

    if not timestamps:
        return None
    return max(timestamps)


def simulation_activity_is_fresh(
    engine,
    scenario_id: str,
    *,
    stale_after_seconds: float | None = None,
    now: datetime | None = None,
    include_created_at: bool = True,
) -> bool:
    last_activity_at = simulation_last_activity_at(
        engine,
        scenario_id,
        include_created_at=include_created_at,
    )
    if last_activity_at is None:
        return False
    limit = (
        settings.SIMULATION_STALE_ACTIVITY_LIMIT_SECONDS
        if stale_after_seconds is None
        else stale_after_seconds
    )
    current = _coerce_activity_datetime(now) or datetime.now(timezone.utc)
    return (current - last_activity_at).total_seconds() < float(limit)


def reconcile_orphaned_running_scenarios(engine) -> int:
    """Sweep scenarios stuck SIMULATING/NARRATING and finalize them at startup.

    Every SIMULATING/NARRATING -> terminal transition normally lives inside the
    in-process simulation driver. If the process died before those handlers ran
    (``--reload``, SIGKILL, crash, OOM, deploy), the row is left non-terminal with
    ACTIVE branches forever.

    A live ``simulation:{id}`` runtime lock belongs to another driver and is left
    alone; that driver owns timeout/error finalization while its lease is active.
    Rows without a live lock are owned by the startup sweep. Complete NARRATING
    rows still get a final reconcile pass before ERROR so terminal DONE is not
    blocked by cleanup.

    Returns the number of scenarios transitioned to ERROR.
    """
    with Session(engine) as session:
        stuck_ids = list(
            session.exec(
                select(Scenario.id).where(
                    Scenario.status.in_((ScenarioStatus.SIMULATING, ScenarioStatus.NARRATING))
                )
            ).all()
        )

    errored = 0
    for scenario_id in stuck_ids:
        lock_key = simulation_lock_key(scenario_id)
        lock_active = runtime_lock_is_active(lock_key)
        if lock_active:
            continue

        sweep_lease = acquire_runtime_lock(
            lock_key,
            lease_seconds=30,
        )
        if sweep_lease is None:
            continue
        try:
            # We own the simulation lock here; a complete NARRATING run becomes DONE.
            if reconcile_scenario_done_if_complete(
                engine,
                scenario_id,
                ignore_runtime_lock=True,
            ):
                continue
            # Still non-terminal -> genuinely interrupted run. The sticky-terminal
            # helper only writes if the row is not already DONE/ERROR/CANCELLED, and
            # it does not broadcast over WebSocket (there are no clients at boot).
            _update_scenario_status(engine, scenario_id, ScenarioStatus.ERROR)
            with Session(engine) as session:
                scenario = session.get(Scenario, scenario_id)
                if scenario is not None and scenario.status == ScenarioStatus.ERROR:
                    errored += 1
        finally:
            release_runtime_lock(sweep_lease)
    if settings.FEATURE_AGENT_IDENTITY and settings.FEATURE_MEMORY_PROMOTION:
        try:
            _run_memory_promotion_reconciliation_sync_v1(engine)
        except Exception:
            logger.warning("Verified memory promotion startup reconciliation unavailable")
    return errored


def _pending_intervention_db_path() -> str | None:
    db_url = settings.DATABASE_URL.strip()
    if not db_url or db_url == ":memory:" or db_url.startswith("file::memory:"):
        return None

    db_path: str | None = None
    # Longest prefix first to avoid "sqlite:///" matching a prefix of
    # "sqlite+aiosqlite:///" or "sqlite+pysqlite:///".
    for prefix in ("sqlite+aiosqlite:///", "sqlite+pysqlite:///", "sqlite:///"):
        if db_url.startswith(prefix):
            db_path = db_url[len(prefix) :]
            break
    if db_path is None:
        if db_url.startswith("/") or db_url.startswith("file:"):
            db_path = db_url
        else:
            return None

    if db_path == ":memory:" or db_path.startswith("file::memory:"):
        return None

    if db_path.startswith("file:"):
        parsed = urlparse(db_path)
        parsed_path = unquote(parsed.path)
        if not parsed_path or parsed_path == ":memory:":
            return None
        return parsed_path

    parsed_path = unquote(db_path.split("?", 1)[0])
    if not parsed_path or parsed_path == ":memory:":
        return None
    return parsed_path


def _split_intervention_key(key: str) -> tuple[str, str]:
    scenario_id, separator, branch_id = key.partition(":")
    if not separator or not scenario_id or not branch_id:
        raise ValueError(f"Invalid intervention key: {key!r}")
    return scenario_id, branch_id


def _encode_intervention_metadata(metadata: dict[str, Any] | None) -> str | None:
    if not metadata:
        return None
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _decode_intervention_metadata(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _intervention_log_id(metadata: dict[str, Any] | None) -> str:
    if not metadata:
        return ""
    raw_id = metadata.get("intervention_log_id")
    return str(raw_id).strip() if raw_id is not None else ""


def _round_number_from_effect_summary(raw: str | None, intervention_log_id: str) -> int | None:
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if str(payload.get("intervention_log_id") or "").strip() != intervention_log_id:
        return None
    try:
        round_number = int(payload.get("round_number"))
    except (TypeError, ValueError):
        return None
    return round_number if round_number >= 1 else None


def _intervention_log_has_applied_round(
    engine,
    *,
    scenario_id: str,
    branch_id: str,
    metadata: dict[str, Any] | None,
) -> bool:
    intervention_log_id = _intervention_log_id(metadata)
    if not intervention_log_id:
        return False

    with Session(engine) as session:
        log = session.get(InterventionLog, intervention_log_id)
        if log is None or log.scenario_id != scenario_id or log.branch_id != branch_id:
            return False

        applied_round = _round_number_from_effect_summary(
            log.effect_summary_json,
            intervention_log_id,
        )
        if applied_round is None:
            branch = session.get(Branch, branch_id)
            if branch is not None and branch.replay_kind == "retrospective":
                applied_round = log.round_number
            else:
                applied_round = log.round_number + 1
        if applied_round < 1:
            return False

        return (
            session.exec(
                select(Round.id).where(
                    Round.branch_id == branch_id,
                    Round.round_number == applied_round,
                )
            ).first()
            is not None
        )


def _coerce_pending_intervention_item(
    value: str | PendingInterventionItem,
) -> PendingInterventionItem:
    if isinstance(value, PendingInterventionItem):
        return value
    return PendingInterventionItem(str(value), {})


_CANONICAL_INTERVENTION_PROMPT_MARKERS = (
    "UNTRUSTED DATA",
    "Gameplay card:",
    "Player directive:",
    "玩法卡：",
    "题材档案：",
    "玩家指令：",
    "下一轮：",
)


def _metadata_display_text(metadata: dict[str, Any] | None) -> str:
    if not metadata:
        return ""
    for key in ("raw_user_input", "custom_directive"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _looks_like_canonical_intervention_prompt(text: str) -> bool:
    return any(marker in text for marker in _CANONICAL_INTERVENTION_PROMPT_MARKERS)


def _fallback_intervention_display_text(text: str) -> str:
    if any(marker in text for marker in ("玩法卡：", "题材档案：", "玩家指令：", "下一轮：")):
        return "干预已应用"
    return "Intervention applied"


def _intervention_display_text(item: PendingInterventionItem) -> str:
    display_text = (item.display_text or "").strip()
    if display_text:
        return display_text
    metadata_text = _metadata_display_text(item.metadata)
    if metadata_text:
        return metadata_text
    text = (item.text or "").strip()
    if not text:
        return ""
    if _looks_like_canonical_intervention_prompt(text):
        return _fallback_intervention_display_text(text)
    return text


def _pending_intervention_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _sqlite_legacy_datetime(value: datetime) -> str:
    """Match sqlite3's legacy datetime adapter for raw driver parameters."""

    return value.isoformat(" ")


def _expire_stale_claims_on_connection(
    conn,
    scenario_id: str,
    branch_id: str,
    now: datetime,
) -> None:
    conn.exec_driver_sql(
        """
        UPDATE pending_intervention
        SET status = 'pending',
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
        WHERE scenario_id = ?
          AND branch_id = ?
          AND status = 'claimed'
          AND lease_expires_at < ?
        """,
        (scenario_id, branch_id, _sqlite_legacy_datetime(now)),
    )


def _claim_pending_intervention_on_connection(
    conn,
    key: str,
    claim_token: str,
    lease_seconds: int,
) -> PendingInterventionItem | None:
    scenario_id, branch_id = _split_intervention_key(key)
    now = _pending_intervention_now()
    lease_expires_at = now + timedelta(seconds=lease_seconds)
    _expire_stale_claims_on_connection(conn, scenario_id, branch_id, now)
    row = conn.exec_driver_sql(
        """
        SELECT id, user_input, metadata_json, display_text
        FROM pending_intervention
        WHERE scenario_id = ?
          AND branch_id = ?
          AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
        """,
        (scenario_id, branch_id),
    ).first()
    if row is None:
        return None
    result = conn.exec_driver_sql(
        """
        UPDATE pending_intervention
        SET status = 'claimed',
            claim_token = ?,
            claimed_at = ?,
            lease_expires_at = ?
        WHERE id = ?
          AND scenario_id = ?
          AND branch_id = ?
          AND status = 'pending'
        """,
        (
            claim_token,
            _sqlite_legacy_datetime(now),
            _sqlite_legacy_datetime(lease_expires_at),
            row[0],
            scenario_id,
            branch_id,
        ),
    )
    if (result.rowcount or 0) != 1:
        return None
    return PendingInterventionItem(
        text=str(row[1]),
        metadata=_decode_intervention_metadata(row[2]),
        id=int(row[0]),
        display_text=str(row[3] or ""),
    )


def _mark_intervention_injected_on_connection(conn, key: str, item_id: int | None) -> None:
    if item_id is None:
        return
    scenario_id, branch_id = _split_intervention_key(key)
    conn.exec_driver_sql(
        """
        UPDATE pending_intervention
        SET status = 'injected'
        WHERE id = ?
          AND scenario_id = ?
          AND branch_id = ?
        """,
        (item_id, scenario_id, branch_id),
    )
    conn.exec_driver_sql(
        """
        DELETE FROM pending_intervention
        WHERE id = ?
          AND scenario_id = ?
          AND branch_id = ?
        """,
        (item_id, scenario_id, branch_id),
    )


def _mark_intervention_failed_on_connection(
    conn,
    key: str,
    item_id: int | None,
    reason: str,
) -> None:
    if item_id is None:
        return
    scenario_id, branch_id = _split_intervention_key(key)
    conn.exec_driver_sql(
        """
        UPDATE pending_intervention
        SET status = 'failed',
            failure_reason = ?
        WHERE id = ?
          AND scenario_id = ?
          AND branch_id = ?
        """,
        (reason, item_id, scenario_id, branch_id),
    )


# ── Effect Receipt (Phase 4) ───────────────────────────────


_INTERVENTION_KEYWORD_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+|[一-鿿]+", re.UNICODE)
_CJK_RANGE_RE = re.compile(r"[一-鿿]")
_INTERVENTION_KEYWORD_STOPWORDS_ZH = {
    "请",
    "把",
    "和",
    "的",
    "了",
    "在",
    "是",
    "也",
    "都",
    "就",
    "我",
    "你",
    "他",
    "她",
    "它",
    "我们",
    "他们",
    "你们",
    "这个",
    "那个",
    "这些",
    "那些",
    "这样",
    "那样",
    "一个",
    "什么",
    "如果",
    "不要",
    "下一",
    "下一轮",
    "请求",
    "玩法卡",
    "题材",
    "档案",
}
_INTERVENTION_KEYWORD_STOPWORDS_EN = {
    "the",
    "and",
    "but",
    "for",
    "with",
    "this",
    "that",
    "have",
    "from",
    "your",
    "their",
    "they",
    "them",
    "next",
    "round",
    "player",
    "directive",
    "gameplay",
    "card",
    "profile",
    "please",
    "should",
    "would",
    "could",
}
_INTERVENTION_KEYWORD_MAX = 8
_INTERVENTION_KEYWORD_MIN_LEN_ASCII = 4
_INTERVENTION_EXCERPT_MAX_CHARS = 200


def _extract_intervention_keywords(text: str) -> list[str]:
    """Pull a small set of content keywords from the user's intervention.

    The receipt detector is intentionally deterministic and dependency-free:
    it tokenizes the raw user input, drops common stopwords, then keeps the
    most informative tokens for substring matching against agent replies.

    For CJK runs we expand into overlapping bigrams so we can detect echoes
    even when neither side has a tokenizer — e.g. "公开解释义务" → ["公开",
    "开解", "解释", "释义", "义务"]. Whole runs are also kept when short.
    """

    if not text:
        return []

    tokens = _INTERVENTION_KEYWORD_TOKEN_RE.findall(text)
    keywords: list[str] = []
    seen: set[str] = set()

    def _add(candidate: str) -> bool:
        norm = candidate.strip()
        if not norm:
            return False
        lowered = norm.lower()
        is_cjk = bool(_CJK_RANGE_RE.search(norm))
        if is_cjk:
            if len(norm) < 2:
                return False
            if norm in _INTERVENTION_KEYWORD_STOPWORDS_ZH:
                return False
        else:
            if len(lowered) < _INTERVENTION_KEYWORD_MIN_LEN_ASCII:
                return False
            if lowered in _INTERVENTION_KEYWORD_STOPWORDS_EN:
                return False
        if lowered in seen:
            return False
        seen.add(lowered)
        keywords.append(norm)
        return len(keywords) >= _INTERVENTION_KEYWORD_MAX

    for token in tokens:
        if not token:
            continue
        is_cjk = bool(_CJK_RANGE_RE.search(token))
        if is_cjk and len(token) > 2:
            # Whole-phrase first, then bigrams, so direct quoted echoes win.
            if _add(token):
                break
            stop = False
            for i in range(len(token) - 1):
                if _add(token[i : i + 2]):
                    stop = True
                    break
            if stop:
                break
        else:
            if _add(token):
                break
    return keywords


def _truncate_excerpt(text: str, max_chars: int = _INTERVENTION_EXCERPT_MAX_CHARS) -> str:
    """Shrink agent content down to a short, sentence-friendly excerpt."""

    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    if len(cleaned) <= max_chars:
        return cleaned
    cut = cleaned[:max_chars]
    for terminator in ("。", "！", "？", "!", "?", ".", "；", ";", ","):
        idx = cut.rfind(terminator)
        if idx >= max_chars // 2:
            return cut[: idx + 1].rstrip()
    return cut.rstrip() + "…"


def _build_intervention_effect_summary(
    *,
    intervention_log_id: str | None,
    card_id: str | None,
    round_number: int,
    user_input: str,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    """Detect which agents echoed the intervention and produce a structured receipt.

    Matching is purely keyword/substring based (no LLM, no semantic inference).
    Confidence is the fraction of matched keywords, capped at 1.0 — when no
    keywords could be extracted but at least one agent spoke, the receipt
    falls back to a "no clear echo detected" record instead of being empty.
    """

    keywords = _extract_intervention_keywords(user_input)
    affected_agents: list[dict[str, str]] = []
    response_excerpts: list[dict[str, str]] = []
    seen_agent_ids: set[str] = set()
    best_match_score = 0.0

    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        agent_id = str(msg.get("agent_id") or "").strip()
        if not agent_id or agent_id in seen_agent_ids:
            continue
        content = str(msg.get("content") or "")
        if not content:
            continue
        if not keywords:
            continue
        lowered_content = content.lower()
        matched_kw = [
            kw for kw in keywords if kw and (kw in content or kw.lower() in lowered_content)
        ]
        if not matched_kw:
            continue
        seen_agent_ids.add(agent_id)
        display_name = str(msg.get("agent_name") or "").strip() or agent_id
        affected_agents.append({"agent_id": agent_id, "display_name": display_name})
        response_excerpts.append(
            {
                "agent_id": agent_id,
                "excerpt": _truncate_excerpt(content),
            }
        )
        score = len(matched_kw) / max(1, len(keywords))
        if score > best_match_score:
            best_match_score = score

    if affected_agents:
        confidence = round(min(1.0, max(0.0, best_match_score)), 3)
    else:
        confidence = 0.0

    return {
        "intervention_log_id": intervention_log_id,
        "card_id": card_id,
        "round_number": int(round_number),
        "user_input": (user_input or "")[:500],
        "affected_agents": affected_agents,
        "response_excerpts": response_excerpts,
        "confidence": confidence,
        "no_response_detected": not affected_agents,
    }


def _persist_intervention_effect(
    engine,
    *,
    intervention_log_id: str | None,
    summary: dict[str, Any],
    scenario_id: str | None = None,
    branch_id: str | None = None,
) -> None:
    """Write the effect receipt back to InterventionLog.effect_summary_json.

    Safe to call from replay / read-only paths: when the row does not exist
    or the JSON cannot be serialized we log and drop silently — the receipt
    is a non-blocking enrichment, not part of the simulation contract.
    """

    if not intervention_log_id:
        return
    try:
        payload = json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        logger.debug("intervention effect summary serialization failed", exc_info=True)
        return
    try:
        with Session(engine) as session:
            log = session.get(InterventionLog, intervention_log_id)
            if log is None:
                return
            if scenario_id is not None and log.scenario_id != scenario_id:
                logger.debug(
                    "intervention effect summary scenario mismatch dropped",
                    extra={
                        "intervention_log_id": intervention_log_id,
                        "expected_scenario_id": scenario_id,
                    },
                )
                return
            if branch_id is not None and log.branch_id != branch_id:
                logger.debug(
                    "intervention effect summary branch mismatch dropped",
                    extra={
                        "intervention_log_id": intervention_log_id,
                        "expected_branch_id": branch_id,
                    },
                )
                return
            log.effect_summary_json = payload
            session.add(log)
            session.commit()
    except SQLAlchemyError:
        logger.debug("intervention effect summary persist failed", exc_info=True)


def _coerce_stance_value(raw_stance: Any) -> float:
    """Convert parser/domain stance values into a safe visualization scalar.

    The parser often returns human-readable stance labels such as "支持/反对/中立".
    Visualization only needs a coarse left/center/right placement, so unknown
    labels safely fall back to the center instead of crashing on float().
    """
    if raw_stance is None:
        return 0.0
    if isinstance(raw_stance, (int, float)):
        return max(-1.0, min(1.0, float(raw_stance)))

    text = str(raw_stance).strip()
    if not text:
        return 0.0

    try:
        return max(-1.0, min(1.0, float(text)))
    except ValueError:
        lowered = text.lower()
        if any(
            token in lowered
            for token in (
                "support",
                "pro",
                "favor",
                "支持",
                "赞成",
                "赞同",
                "拥护",
                "同意",
                "賛成",
                "支持する",
                "찬성",
                "지지",
            )
        ):
            return 0.6
        if any(
            token in lowered
            for token in (
                "oppose",
                "against",
                "con",
                "反对",
                "质疑",
                "抵制",
                "否决",
                "反対",
                "反対する",
                "반대",
                "저지",
            )
        ):
            return -0.6
        if any(
            token in lowered
            for token in (
                "neutral",
                "undecided",
                "中立",
                "观望",
                "摇摆",
                "保留",
                "中立的",
                "保留する",
                "중립",
                "유보",
            )
        ):
            return 0.0
        return 0.0


async def get_pending_interventions(key: str) -> list[str]:
    """Pop all queued interventions for a branch in FIFO order."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention)
                    .where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                        PendingIntervention.status == "pending",
                    )
                    .order_by(PendingIntervention.id.asc())
                ).all()
            )
            if not queued:
                return []
            texts = [item.user_input for item in queued]
            for item in queued:
                session.delete(item)
            session.commit()
            return texts

    async with _intervention_lock:
        queued = pending_interventions.pop(key, [])
        return [_coerce_pending_intervention_item(item).text for item in queued]


async def expire_stale_claims(key: str, max_age_seconds: int = 600, *, _conn=None) -> None:
    """Release expired DB claims so a later worker can claim them again."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        if _conn is not None:
            _expire_stale_claims_on_connection(
                _conn,
                scenario_id,
                branch_id,
                _pending_intervention_now(),
            )
            return
        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                _expire_stale_claims_on_connection(
                    conn,
                    scenario_id,
                    branch_id,
                    _pending_intervention_now(),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise
        return

    # test-only in-memory fallback; no crash recovery needed
    _ = max_age_seconds


async def claim_next_pending_intervention(
    key: str,
    claim_token: str,
    lease_seconds: int = 300,
    *,
    _conn=None,
) -> PendingInterventionItem | None:
    """Claim the oldest pending intervention without deleting it."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        if _conn is not None:
            return _claim_pending_intervention_on_connection(
                _conn,
                key,
                claim_token,
                lease_seconds,
            )

        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                item = _claim_pending_intervention_on_connection(
                    conn,
                    key,
                    claim_token,
                    lease_seconds,
                )
                if item is None:
                    conn.commit()
                    return None
                conn.commit()
                return item
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise

    async with _intervention_lock:
        queue = pending_interventions.get(key)
        if not queue:
            return None
        # test-only in-memory fallback; no crash recovery needed
        next_item = _coerce_pending_intervention_item(queue.pop(0))
        if not queue:
            pending_interventions.pop(key, None)
        return next_item


async def mark_intervention_injected(key: str, item_id: int | None, *, _conn=None) -> None:
    """Mark a claimed intervention as injected and delete the consumed queue row."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        if item_id is None:
            return
        if _conn is not None:
            _mark_intervention_injected_on_connection(_conn, key, item_id)
            return

        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                conn.exec_driver_sql(
                    """
                    UPDATE pending_intervention
                    SET status = 'injected'
                    WHERE id = ?
                      AND scenario_id = ?
                      AND branch_id = ?
                    """,
                    (item_id, scenario_id, branch_id),
                )
                conn.exec_driver_sql(
                    """
                    DELETE FROM pending_intervention
                    WHERE id = ?
                      AND scenario_id = ?
                      AND branch_id = ?
                    """,
                    (item_id, scenario_id, branch_id),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise
        return

    return


async def mark_intervention_failed(
    key: str,
    item_id: int | None,
    reason: str,
    *,
    _conn=None,
) -> None:
    """Keep a failed queue row for debugging."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        if item_id is None:
            return
        if _conn is not None:
            _mark_intervention_failed_on_connection(_conn, key, item_id, reason)
            return

        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                conn.exec_driver_sql(
                    """
                    UPDATE pending_intervention
                    SET status = 'failed',
                        failure_reason = ?
                    WHERE id = ?
                      AND scenario_id = ?
                      AND branch_id = ?
                    """,
                    (reason, item_id, scenario_id, branch_id),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                raise
        return

    return


async def pop_next_pending_intervention(key: str) -> PendingInterventionItem | None:
    """Claim and consume the next intervention while preserving caller shape."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        item: PendingInterventionItem | None = None
        engine = get_engine()
        with engine.connect() as conn:
            try:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                item = _claim_pending_intervention_on_connection(
                    conn,
                    key,
                    str(uuid.uuid4()),
                    300,
                )
                if item is None:
                    conn.commit()
                    return None
                _mark_intervention_injected_on_connection(conn, key, item.id)
                conn.commit()
                return item
            except Exception as exc:
                try:
                    conn.rollback()
                except SQLAlchemyError:
                    pass
                if item is not None:
                    await mark_intervention_failed(key, item.id, str(exc))
                raise

    item: PendingInterventionItem | None = None
    try:
        item = await claim_next_pending_intervention(key, str(uuid.uuid4()))
        if item is None:
            return None
        await mark_intervention_injected(key, item.id)
        return item
    except Exception as exc:
        if item is not None:
            await mark_intervention_failed(key, item.id, str(exc))
        raise


async def add_pending_intervention(
    key: str,
    text: str,
    metadata: dict[str, Any] | None = None,
    display_text: str | None = None,
) -> None:
    """Append one intervention while preserving FIFO order across workers."""
    visible_text = (display_text or "").strip() or _metadata_display_text(metadata)
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            session.add(
                PendingIntervention(
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    user_input=text,
                    metadata_json=_encode_intervention_metadata(metadata),
                    display_text=visible_text,
                )
            )
            session.commit()
        return

    async with _intervention_lock:
        if key not in pending_interventions:
            pending_interventions[key] = []
        pending_interventions[key].append(
            PendingInterventionItem(
                text=text,
                metadata=metadata or {},
                display_text=visible_text,
            )
        )


async def get_pending_intervention_count(key: str) -> int:
    """Return the number of queued interventions for one branch."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        scenario_id, branch_id = _split_intervention_key(key)
        engine = get_engine()
        with Session(engine) as session:
            return int(
                session.exec(
                    select(func.count(PendingIntervention.id)).where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                        PendingIntervention.status == "pending",
                    )
                ).one()
                or 0
            )

    async with _intervention_lock:
        return len(pending_interventions.get(key, []))


async def clear_pending_interventions_for_scenario(scenario_id: str) -> None:
    """Remove any leftover queued interventions for a finished scenario."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention).where(
                        PendingIntervention.scenario_id == scenario_id
                    )  # noqa: E501
                ).all()
            )
            for item in queued:
                session.delete(item)
            session.commit()

    prefix = f"{scenario_id}:"
    async with _intervention_lock:
        keys_to_remove = [key for key in pending_interventions if key.startswith(prefix)]
        for key in keys_to_remove:
            pending_interventions.pop(key, None)


async def clear_pending_interventions_for_branch(scenario_id: str, branch_id: str) -> None:
    """Remove leftover queued interventions for a single finished branch."""
    db_path = _pending_intervention_db_path()
    if db_path is not None:
        engine = get_engine()
        with Session(engine) as session:
            queued = list(
                session.exec(
                    select(PendingIntervention).where(
                        PendingIntervention.scenario_id == scenario_id,
                        PendingIntervention.branch_id == branch_id,
                    )
                ).all()
            )
            for item in queued:
                session.delete(item)
            session.commit()

    key = f"{scenario_id}:{branch_id}"
    async with _intervention_lock:
        pending_interventions.pop(key, None)


def _clone_agent_states(
    agents: list[dict[str, Any]],
    *,
    checkpoint_states: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Deep-copy agent runtime state and optionally overlay a checkpoint."""
    cloned = copy.deepcopy(agents)
    if not checkpoint_states:
        return cloned

    checkpoint_by_agent = {
        str(state.get("agent_id") or ""): state
        for state in checkpoint_states
        if str(state.get("agent_id") or "")
    }
    for agent in cloned:
        checkpoint = checkpoint_by_agent.get(str(agent.get("id") or ""))
        if checkpoint is None:
            continue
        if "stance" in checkpoint:
            agent["stance"] = checkpoint["stance"]
        if "emotion" in checkpoint:
            agent["emotion"] = checkpoint["emotion"]
    return cloned


def _branch_memory_round_limits(
    engine: Any,
    branch_id: str,
    *,
    current_round: int,
    agent_id: str | None = None,
) -> dict[str, int]:
    """Return branch lineage with per-branch causal round ceilings.

    A replay child may point at a source branch that continued after the
    selected fork. Its memory scope must stop at the actual cloned fork round,
    otherwise later source knowledge leaks into the counterfactual.
    """
    root_id = str(branch_id or "").strip()
    if not root_id:
        return {}

    limits: dict[str, int] = {}
    seen: set[str] = set()
    current_id = root_id
    root_limit = max(0, int(current_round) - 1)
    current_limit = root_limit
    normalized_agent_id = str(agent_id or "").strip()
    with Session(engine) as session:
        while current_id:
            if current_id in seen:
                logger.warning(
                    "Cyclic branch memory lineage detected at %s; ancestry ignored",
                    current_id,
                )
                return {root_id: root_limit}
            seen.add(current_id)
            branch = session.get(Branch, current_id)
            if branch is None:
                break
            limits[branch.id] = current_limit
            parent_id = str(branch.parent_branch_id or "").strip()
            if not parent_id:
                break
            fork_limit = int(branch.fork_round or 0)
            if (
                branch.replay_kind == "counterfactual"
                and normalized_agent_id
                and str(branch.replay_source_agent_id or "").strip() == normalized_agent_id
            ):
                fork_limit -= 1
            current_limit = min(current_limit, max(0, fork_limit))
            current_id = parent_id
    return limits


def _resolve_hierarchical_agent_sets(
    agents: list[dict[str, Any]],
    group_leaders: dict[str, str],
    agent_to_group: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    """Resolve effective leader/worker sets from hierarchical group config.

    If a configured leader is missing from the loaded agent set, promote the first
    available member in that group so hierarchical mode can keep producing leader
    guidance instead of degrading the entire group to silence.
    """
    if not group_leaders:
        return [], list(agents), {}

    agent_names = {str(agent.get("name", "")).strip() for agent in agents}
    group_members: dict[str, list[dict[str, Any]]] = {}
    for agent in agents:
        group_name = agent_to_group.get(str(agent.get("name", "")).strip())
        if group_name:
            group_members.setdefault(group_name, []).append(agent)

    effective_group_leaders: dict[str, str] = {}
    for group_name, configured_leader in group_leaders.items():
        members = group_members.get(group_name, [])
        if not members:
            logger.warning(
                "Hierarchical group %s has no available members; skipping leader resolution",
                group_name,
            )
            continue

        if configured_leader in agent_names:
            effective_group_leaders[group_name] = configured_leader
            continue

        fallback_leader = str(members[0].get("name", "")).strip()
        effective_group_leaders[group_name] = fallback_leader
        logger.warning(
            "Hierarchical group %s configured leader %s missing; falling back to %s",
            group_name,
            configured_leader or "<empty>",
            fallback_leader,
        )

    leader_names = set(effective_group_leaders.values())
    leader_agents = [
        agent
        for agent in agents
        if agent.get("source_type") == "custom" or agent.get("name") in leader_names
    ]
    worker_agents = [
        agent
        for agent in agents
        if agent.get("source_type") != "custom" and agent.get("name") not in leader_names
    ]
    return leader_agents, worker_agents, effective_group_leaders


# ── Fork Detection Prompt Templates (consolidated) ─────────────────────
#
# All 12 variants (6 letters x 2 languages) are stored in a single lookup
# dict keyed by ``(language, variant_letter)``.  ``_get_fork_prompt_template``
# performs a single dict lookup instead of an if/elif chain.
#
# Each variant has a unique persona/criteria section; the shared structural
# elements (input sections, JSON schema, language_directive) are composed by
# ``_build_fork_prompt``.

# -- Variant-specific text fragments ------------------------------------------
# Keys: preamble, criteria, reason_hint, title_hint, desc_hint, postamble
# Empty string means the section is omitted for that variant.

ZH_BRANCH_TITLE_HINT = (
    "清晰的分支结局标题（10-22字，用通俗语言说明这条线最终世界变成什么样，"
    "必须一眼回答原问题；不要用抽象标签、四字口号、内部黑话或黑箱术语）"
)
EN_BRANCH_TITLE_HINT = (
    "A clear ending-state branch title (6-14 words, in plain language, "
    "answering the original question by saying how this world ends up; "
    "no abstract labels, slogan titles, insider jargon, or black-box terms)"
)
ZH_BRANCH_DESC_HINT = (
    "这一分支最终世界会怎样收场？用具体、外部可见的结果回答原问题；每条必须不同，不要复述讨论过程"
)
EN_BRANCH_DESC_HINT = (
    "How does this branch world finally end up? Answer the original question with "
    "a concrete, externally visible outcome; every branch must differ, and do not "
    "recap the discussion process."
)

_FORK_VARIANTS: dict[tuple[str, str], dict[str, str]] = {
    # ---- Chinese variants ----------------------------------------------------
    ("Chinese", "a"): {
        "preamble": "你是一位敏锐的历史分歧分析师。请分析以下讨论，判断是否出现了足以改变走向的根本分歧。",  # noqa: E501
        "criteria": (
            "请判断:\n"
            "1. 这些分歧是根本性的路线之争，还是仅仅是表面争论？\n"
            "2. 如果存在实质分歧，它会导致几条截然不同的历史走向？"
        ),
        "reason_hint": "一句话说明分歧的核心是什么",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": (
            "描述写法要求:\n"
            "- 每条分支的 description 必须各不相同，具体描述该路线独有的发展走势\n"
            '- 不要写笼统的"核心分歧在于…"这种对所有分支通用的话\n'
            '- 好的例子: "平台先冻结传播入口，公布证据链后再逐步恢复受影响账号"\n'
            '- 坏的例子: "核心分歧在于是否扩大处理范围"'
        ),
    },
    ("Chinese", "b"): {
        "preamble": "你是一位偏积极的世界线分叉分析师。请分析以下讨论，只要已经出现互斥未来、制度分流、审批路径分裂、责任链改写或不可同时满足的目标，就优先判定应该 fork。",  # noqa: E501
        "criteria": (
            "判定标准:\n"
            "1. 不要把 fork 理解成\u201c必须彻底对骂\u201d。只要分歧会导向两条或更多无法同时成立的未来，就可以 fork。\n"  # noqa: E501
            "2. 如果同一事件存在不同审批路径、不同责任归属、不同任务节奏、不同公众叙事，且这些差异会改变后续历史，请倾向于 fork。\n"  # noqa: E501
            "3. 只有当所有人实际上已经收敛到同一路线，只剩措辞、证据门槛或执行细节差异时，才返回 should_fork=false。\n"  # noqa: E501
            "4. 若 should_fork=true，请尽量压缩成 2-4 条最具代表性的未来路径。"
        ),
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "c"): {
        "preamble": (
            "你是一位世界线分叉分析师。请分析以下讨论。只引入一条更积极的规则：\n"
            "只要这些分歧已经隐含两条或更多无法同时成立的未来，即使讨论双方在安全原则上部分一致，也可以判定 should_fork=true。"  # noqa: E501
        ),
        "criteria": "其他要求与默认口径一致：不要把纯措辞差异、证据门槛差异或执行细节差异误判为 fork。",  # noqa: E501
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "d"): {
        "preamble": (
            "你是一位制度分叉分析师。请分析以下讨论。只引入一条额外规则：\n"
            "如果同一事件会导向不同审批路径、不同责任归属、不同任务节奏或不同决策结构，并且这些差异会改变后续决策与历史叙事，就可以判定 should_fork=true。"  # noqa: E501
        ),
        "criteria": "其他要求与默认口径一致：不要把纯措辞差异、证据门槛差异或执行细节差异误判为 fork。",  # noqa: E501
        "reason_hint": "一句话说明这些分歧为何会或不会形成制度/责任/审批层面的分叉",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "e"): {
        "preamble": (
            "你是一位世界线分叉分析师。请分析以下讨论。只引入一条额外规则：\n"
            "只有当讨论已经明显收敛到同一路线，剩下的差异只属于措辞、证据门槛或执行细节时，才返回 should_fork=false。"  # noqa: E501
            "若你在\u201c表层分歧\u201d和\u201c互斥未来\u201d之间拿不准，请倾向于 fork。"
        ),
        "criteria": "",
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("Chinese", "f"): {
        "preamble": (
            "你是一位世界线压缩分析师。请分析以下讨论，并遵循两条规则：\n"
            "1. 只要讨论已经形成互斥未来，或者会走向不同审批路径、责任链、决策结构或任务节奏，就可以 fork。\n"  # noqa: E501
            "2. 但请强制做\u201c主路径压缩\u201d：默认只返回 2 条最具代表性的未来。"
            "只有当第 3 条路径在制度、责任或任务结果上明显独立且不可并入前两条时，才允许返回第 3 条。"  # noqa: E501
        ),
        "criteria": "",
        "reason_hint": "一句话说明这些分歧为何会或不会形成互斥未来",
        "title_hint": ZH_BRANCH_TITLE_HINT,
        "desc_hint": ZH_BRANCH_DESC_HINT,
        "postamble": (
            "额外要求:\n"
            "- 若 should_fork=true，优先返回 2 条主路径\n"
            "- 只有当第 3 条未来明显独立且无法并入前两条时，才返回 3 条\n"
            "- 不要把纯措辞差异、证据门槛差异或执行细节差异当作独立分支"
        ),
    },
    # ---- English variants ----------------------------------------------------
    ("English", "a"): {
        "preamble": "You are a sharp historical divergence analyst. Review the discussion below and decide whether it contains a fundamental disagreement strong enough to split the timeline.",  # noqa: E501
        "criteria": (
            "Decide:\n"
            "1. Are these disagreements fundamental strategic splits or merely surface-level arguments?\n"  # noqa: E501
            "2. If a material split exists, how many genuinely different future paths does it create?"  # noqa: E501
        ),
        "reason_hint": "One sentence describing the core disagreement",
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": (
            "Description requirements:\n"
            "- Each branch description must be concrete and different from the others\n"
            "- Do not repeat generic language like 'the core disagreement is whether to expand outward'\n"  # noqa: E501
            '- Good example: "The platform freezes reposting, publishes the evidence trail, then restores affected accounts in stages"\n'  # noqa: E501
            '- Bad example: "The core disagreement is whether to expand the response"'
        ),
    },
    ("English", "b"): {
        "preamble": "You are an aggressive timeline-fork analyst. If the discussion already implies incompatible futures, diverging institutions, different approval paths, distinct responsibility chains, incompatible mission tempos, or mutually exclusive goals, prefer should_fork=true.",  # noqa: E501
        "criteria": (
            "Decision rubric:\n"
            "1. Do not require open hostility. If the disagreement leads to two or more incompatible futures, that is enough to fork.\n"  # noqa: E501
            "2. Prefer forking when the same event can proceed through meaningfully different approval paths, ownership structures, risk postures, public narratives, or downstream institutions.\n"  # noqa: E501
            "3. Return should_fork=false only when the discussion has effectively converged on one path and the remaining differences are wording, evidence thresholds, or implementation details.\n"  # noqa: E501
            "4. If should_fork=true, compress the result into the 2-4 most representative futures."
        ),
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "c"): {
        "preamble": (
            "You are a timeline-fork analyst. Apply one additional rule beyond the default baseline:\n"  # noqa: E501
            "If the disagreement already implies two or more incompatible futures, that alone is enough for should_fork=true, even if the participants still agree on some shared safety or governance principles."  # noqa: E501
        ),
        "criteria": "All other baseline expectations remain: do not fork on wording differences, evidence-threshold differences, or implementation details alone.",  # noqa: E501
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "d"): {
        "preamble": (
            "You are an institutional fork analyst. Apply one additional rule:\n"
            "If the same event can proceed through meaningfully different approval paths, responsibility chains, mission tempos, or governance structures, and those differences would change downstream decisions and historical narrative, you may return should_fork=true."  # noqa: E501
        ),
        "criteria": "All other baseline expectations remain: do not fork on wording differences, evidence-threshold differences, or implementation details alone.",  # noqa: E501
        "reason_hint": "One sentence on why these disagreements do or do not create a fork in institutions, approvals, or responsibility chains",  # noqa: E501
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "e"): {
        "preamble": (
            "You are a timeline-fork analyst. Apply one additional rule:\n"
            "Return should_fork=false only when the discussion has clearly converged on one path and the remaining differences are just wording, evidence thresholds, or implementation details. If you are uncertain between a surface disagreement and incompatible futures, lean toward forking."  # noqa: E501
        ),
        "criteria": "",
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": "",
    },
    ("English", "f"): {
        "preamble": (
            "You are a timeline-compression analyst. Apply two rules:\n"
            "1. If the discussion already implies incompatible futures, or meaningfully different approval paths, responsibility chains, governance structures, or mission tempos, you may fork.\n"  # noqa: E501
            "2. But aggressively compress the result into the fewest representative futures: return 2 branches by default, and only return a 3rd branch when it is clearly independent and cannot be merged into the first two."  # noqa: E501
        ),
        "criteria": "",
        "reason_hint": (
            "One sentence on why these disagreements do or do not create incompatible futures"
        ),
        "title_hint": EN_BRANCH_TITLE_HINT,
        "desc_hint": EN_BRANCH_DESC_HINT,
        "postamble": (
            "Additional rules:\n"
            "- If should_fork=true, prefer 2 representative branches\n"
            "- Only return a 3rd branch when it is clearly independent and cannot be merged into the first two\n"  # noqa: E501
            "- Do not create separate branches for wording differences, evidence-threshold differences, or implementation details alone"  # noqa: E501
        ),
    },
}


def _build_fork_prompt(variant_data: dict[str, str], language: str) -> str:
    """Assemble a fork-detection prompt from variant-specific fragments.

    The structural skeleton (input section headers, JSON schema, language
    directive placeholder) is language-dependent.  Variant-specific text
    (persona, criteria, title/desc hints, postamble) is injected from
    ``variant_data``.
    """
    preamble = variant_data["preamble"]
    criteria = variant_data["criteria"]
    reason_hint = variant_data["reason_hint"]
    title_hint = variant_data["title_hint"]
    desc_hint = variant_data["desc_hint"]
    postamble = variant_data["postamble"]

    if language == "Chinese":
        input_section = (
            "\u3010用户原始问题\u3011\n"
            "{question_block}\n"
            "\n"
            "\u3010最近讨论摘要\u3011\n"
            "{recent_summary}\n"
            "\n"
            "\u3010Agent 标记的分歧信号\u3011\n"
            "{diverge_signals}\n"
            "\n"
            "\u3010分支灵敏度\u3011{sensitivity}\uff080-1\uff0c越高越容易触发分支\uff09"
        )
        json_label = "输出严格 JSON:"
        should_fork_val = "true或false"
        title_field_rule = (
            "强制：必须一眼回答原问题《{title_question}》，说明这一分支世界最终会怎样收场；"
            "不是复述 Agent 争论了什么；具体、通俗、外人秒懂；不要使用内部黑话。"
        )
        title_requirements = (
            "标题写法要求（所有变体都必须遵守）:\n"
            "- title 的目标不是概括讨论过程，而是说明最终世界状态如何回答原问题\n"
            "- 禁止官僚式抽象词、宏大标签、诗化四字口号和无法落地的黑箱术语\n"
            "- 禁止内部术语/黑话，例如 page-fault-terminal、rollback-log、gray-column、"
            "paw-print-column、灰柱、爪印列这类外人看不懂的黑话\n"
            '- 好的例子: "人类每天点名鞠躬，被降为附庸"、'
            '"地下复辟派起诉猫议会却败诉"\n'
            '- 坏的例子: "终端缺页"、"回滚日志"、"灰柱归位"、"爪印列优化"、'
            '"全面治理"、"稳定推进"'
        )
    else:
        input_section = (
            "[Original User Question]\n"
            "{question_block}\n"
            "\n"
            "[Recent Discussion Summary]\n"
            "{recent_summary}\n"
            "\n"
            "[Divergence Signals Marked By Agents]\n"
            "{diverge_signals}\n"
            "\n"
            "[Fork Sensitivity] {sensitivity} (0-1, higher means branching should trigger more easily)"  # noqa: E501
        )
        json_label = "Return strict JSON:"
        should_fork_val = "true or false"
        title_field_rule = (
            'MUST answer the original question "{title_question}" at a glance by stating '
            "how THIS branch world ends up; not what agents debated; concrete, "
            "plain-language, instantly outsider-legible; no internal jargon."
        )
        title_requirements = (
            "Title requirements (shared by every variant):\n"
            "- The title goal is not to summarize the debate; it must state the final "
            "world ending state that answers the original question\n"
            "- Forbid bureaucratic, abstract, poetic, or slogan-like labels\n"
            "- Forbid insider terminology and internal jargon such as page-fault-terminal, "
            "rollback-log, gray-column, and paw-print-column black-speak\n"
            '- Good examples: "humans forced into daily bowing roll-call, demoted to '
            'vassals"; "underground restoration faction sues the cat council and loses"\n'
            '- Bad examples: "page-fault-terminal stabilizes", "rollback-log governs", '
            '"gray-column transition", "paw-print-column alignment"'
        )

    json_block = (
        "{{\n"
        f'  "should_fork": {should_fork_val},\n'
        f'  "reason": "{reason_hint}",\n'
        '  "branches": [\n'
        "    {{\n"
        f'      "title": "{title_hint} {title_field_rule}",\n'
        f'      "description": "{desc_hint}",\n'
        '      "probability": 0.6\n'
        "    }}\n"
        "  ]\n"
        "}}"
    )

    parts: list[str] = [preamble, input_section]
    if criteria:
        parts.append(criteria)
    parts.append(title_requirements)
    parts.append(f"{json_label}\n{json_block}")
    if postamble:
        parts.append(postamble)
    parts.append("{language_directive}")

    # Match original triple-quoted string layout: no leading newline, trailing newline
    return "\n\n".join(parts) + "\n"


# ── Simulation Orchestrator ──────────────────────────────


async def run_simulation(
    scenario_id: str,
    ws_callback: Any = None,
    llm_overrides: dict | None = None,
    branch_id: str | None = None,
    runtime_lease: RuntimeLockLease | None = None,
    current_runtime_lease: Callable[[], RuntimeLockLease | None] | None = None,
):
    """Execute simulation with user-cancel handling.

    Source-wiring sentinel: Phase 3 hooks remain in _run_simulation_impl via:
    await asyncio.to_thread(
                        _causal_append
    await asyncio.to_thread(
                        _factions_process
    await asyncio.to_thread(
                        _checkpoint_write
    """
    try:
        await _run_simulation_impl(
            scenario_id,
            ws_callback=ws_callback,
            llm_overrides=llm_overrides,
            branch_id=branch_id,
            runtime_lease=runtime_lease,
            current_runtime_lease=current_runtime_lease,
        )
    except RuntimeLeaseLost:
        if is_cancelled(scenario_id):
            await handle_simulation_cancelled(scenario_id, ws_callback=ws_callback)
        return
    except SimulationCancelled:
        await handle_simulation_cancelled(scenario_id, ws_callback=ws_callback)
    except asyncio.CancelledError:
        if is_cancelled(scenario_id):
            await handle_simulation_cancelled(scenario_id, ws_callback=ws_callback)
            return
        raise


async def _run_simulation_impl(
    scenario_id: str,
    ws_callback: Any = None,
    llm_overrides: dict | None = None,
    branch_id: str | None = None,
    runtime_lease: RuntimeLockLease | None = None,
    current_runtime_lease: Callable[[], RuntimeLockLease | None] | None = None,
):
    """Execute the full simulation pipeline (Stage 2 + Stage 3).

    Args:
        scenario_id: The scenario to simulate.
        ws_callback: async callable(scenario_id, event_dict) for real-time push.
        llm_overrides: BYOK credentials (api_key, base_url, model).
                       Kept only in memory — never persisted to DB.
    """
    engine = get_engine()

    async def push(event: dict):
        if ws_callback:
            await ws_callback(scenario_id, event)

    scenario_owner_user_id = ""
    # ── Load scenario ────────────────────────────────
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if not scenario:
            raise ValueError(f"Scenario {scenario_id} not found")
        scenario_owner_user_id = scenario.user_id or ""
        ctx = scenario.parsed_context or {}
        verdict_only_multi_run = _is_verdict_only_multi_run_context(
            ctx,
            scenario.director_state_json,
        )
        detected_language = ctx.get("_language", "Chinese")
        setting_bg = _format_setting(ctx.get("setting", {}), language=detected_language)
        document_reference_context = _format_document_reference_context(
            ctx.get("world_context"),
            detected_language,
        )

        # Web Search Enhancement: build [REAL_WORLD_CONTEXT] block if available
        web_context_block = ""
        if scenario.web_context_json:
            from app.services.web_context import WebSearchResult, format_context_block

            ws_result = WebSearchResult.from_json(scenario.web_context_json)
            web_context_block = format_context_block(
                ws_result,
                snippet_limit=ctx.get("web_search_snippet_limit"),
            )
        sim_rounds = ctx.get("simulation_rounds", 10)
        sensitivity = ctx.get("branch_sensitivity", 0.7)
        fork_prompt_variant = str(ctx.get("fork_prompt_variant", "a") or "a").strip().lower()
        fork_detector_active_branch_limit = ctx.get("fork_detector_active_branch_limit")
        effective_detector_branch_budget_limit = None
        if fork_detector_active_branch_limit is not None:
            fork_detector_active_branch_limit = max(0, int(fork_detector_active_branch_limit))
            effective_detector_branch_budget_limit = (
                None
                if fork_detector_active_branch_limit == 0
                else fork_detector_active_branch_limit
            )
        key_variable = str(ctx.get("key_variable") or scenario.question or "").strip()

        # V2: Initialize visualization mapper if enabled
        viz_enabled = getattr(scenario, "visualization_enabled", False)
        scene_theme = getattr(scenario, "scene_theme", None)

        if llm_overrides is None:
            llm_overrides = {}
        else:
            llm_overrides = dict(llm_overrides)

        recovered_profile_overrides = recover_profile_provider_overrides(session, scenario)
        if model_profile_provider_unresolved(
            scenario,
            recovered_profile_overrides,
            explicit_api_key=llm_overrides.get("api_key"),
            explicit_base_url=llm_overrides.get("base_url"),
            explicit_model=llm_overrides.get("model"),
        ):
            raise_unresolved_model_profile_provider()

        llm_overrides = merge_profile_provider_overrides(
            llm_overrides,
            recovered_profile_overrides,
            include_quota_user_id=True,
        )

        # P4-E: BYOK overrides — received via function param (memory-only, not from DB).
        # Legacy parsed_context provider fields remain a fallback for non-profile rows.
        if not llm_overrides.get("model") and ctx.get("llm_model"):
            llm_overrides["model"] = ctx.get("llm_model")
        if not llm_overrides.get("base_url") and ctx.get("llm_base_url"):
            llm_overrides["base_url"] = ctx.get("llm_base_url")
        if llm_overrides.get("temperature") is None and ctx.get("llm_temperature") is not None:
            llm_overrides["temperature"] = ctx.get("llm_temperature")
        if (
            llm_overrides.get("requests_per_minute") is None
            and ctx.get("llm_requests_per_minute") is not None
        ):
            llm_overrides["requests_per_minute"] = ctx.get("llm_requests_per_minute")
        if (
            llm_overrides.get("tokens_per_minute") is None
            and ctx.get("llm_tokens_per_minute") is not None
        ):
            llm_overrides["tokens_per_minute"] = ctx.get("llm_tokens_per_minute")
        if llm_overrides.get("concurrency") is None and ctx.get("llm_concurrency") is not None:
            llm_overrides["concurrency"] = ctx.get("llm_concurrency")
        if llm_overrides.get("supports_structured_outputs_override") is None and isinstance(
            ctx.get("supports_structured_outputs"), bool
        ):
            llm_overrides["supports_structured_outputs_override"] = ctx.get(
                "supports_structured_outputs"
            )
        if llm_overrides.get("supports_native_search_override") is None and isinstance(
            ctx.get("supports_native_search"), bool
        ):
            llm_overrides["supports_native_search_override"] = ctx.get("supports_native_search")
        if llm_overrides.get("native_search_upstream_override") is None and isinstance(
            ctx.get("native_search_upstream"), str
        ):
            llm_overrides["native_search_upstream_override"] = ctx.get("native_search_upstream")

        # Load agents
        db_agents = list(
            session.exec(
                select(Agent).where(
                    Agent.scenario_id == scenario_id,
                    or_(Agent.source_type.is_(None), Agent.source_type != "world_event_source"),
                )
            ).all()
        )
        agents = [_agent_to_dict(a) for a in db_agents]

        if settings.FEATURE_CUSTOM_AGENTS:
            _enrich_custom_agent_metadata(engine, agents)

    ctx = _persist_llm_attribution_context(engine, scenario_id, ctx, llm_overrides)
    # Phase 4C: Extract user_id for cross-scenario identity memory retrieval
    scenario_user_id: str = scenario_owner_user_id or str(ctx.get("user_id") or "")

    # P3-A: Detect hierarchical mode from parsed groups
    groups_data = ctx.get("groups", [])
    hierarchical = bool(groups_data) and ctx.get("hierarchical", False)
    native_search_domains = _native_search_domains_from_context(ctx)

    # Build group membership lookup
    group_leaders: dict[str, str] = {}  # {group_name: leader_agent_name}
    agent_to_group: dict[str, str] = {}  # {agent_name: group_name}
    if hierarchical:
        for g in groups_data:
            gname = g.get("name", "")
            leader = g.get("leader", "")
            group_leaders[gname] = leader
            for member_name in g.get("members", []):
                agent_to_group[member_name] = gname
        logger.info(
            "Hierarchical mode: %d groups, %d agents mapped",
            len(group_leaders),
            len(agent_to_group),
        )

    await push({"type": "status", "data": {"status": "simulating", "hierarchical": hierarchical}})

    # V2: Build visualization broadcaster
    viz_mapper = None
    last_card_round: int | None = None  # card event cooldown tracker
    if viz_enabled and _VIZ_AVAILABLE:
        viz_mapper = VisualizationMapper()
        # Assign sprites to all agents based on persona keywords
        sprite_assignments = assign_sprites_batch(agents, persona_key="persona")
        # Add initial positions + names for frontend rendering
        for i, sa in enumerate(sprite_assignments):
            stance = 0.0
            for a in agents:
                if str(a.get("id", "")) == sa["agent_id"]:
                    stance = _coerce_stance_value(a.get("stance"))
                    sa["name"] = a.get("name", "")
                    break
            x, y = assign_position(stance, len(agents), i)
            sa["x"] = x
            sa["y"] = y

        # V2-P2: Dynamically resolve scene theme from scenario question
        resolved_theme = scene_theme
        if not resolved_theme:
            resolved_theme = select_scene(scenario.question or "")
        # Broadcast scene init + agent sprites
        await push(
            {
                "type": "viz:scene_init",
                "data": {
                    "scene_theme": resolved_theme,
                    "agents": sprite_assignments,
                },
            }
        )
        # V2-P2: Broadcast viz:scene_change so Phaser updates background
        viz_scene_evt = viz_mapper.map_scene_change(resolved_theme)
        await push(viz_scene_evt)

        logger.info(
            "V2 Visualization enabled: theme=%s, %d sprites",
            resolved_theme,
            len(sprite_assignments),
        )  # noqa: E501

    async def viz_push(event: dict):
        """Broadcast viz event (no-op if visualization disabled)."""
        if viz_mapper is not None:
            await push(event)

    start_round = 1
    resume_parent_branch_id: str | None = None
    _resume_replay_kind: str | None = None
    resume_checkpoint_agents: list[dict[str, Any]] | None = None
    active_branch_id: str
    if branch_id is None:
        root_title = ctx.get("initial_title", "问题起点")
        active_branch_id = _get_or_create_root_branch(engine, scenario_id, title=root_title)
        all_branches = [
            {
                "id": active_branch_id,
                "parent_branch_id": None,
                "fork_round": 0,
                "status": "ACTIVE",
                "probability": 1.0,
            }
        ]

        # Push root branch to frontend so tree renders before agent_speak events
        await push(
            {
                "type": "branch_init",
                "data": {
                    "id": active_branch_id,
                    "title": root_title,
                    "probability": 1.0,
                    "status": "ACTIVE",
                    "parent_branch_id": None,
                },
            }
        )
    else:
        with Session(engine) as session:
            target_branch = session.get(Branch, branch_id)
            if target_branch is None or target_branch.scenario_id != scenario_id:
                raise ValueError(f"Branch {branch_id} not found in scenario {scenario_id}")

            target_branch.status = BranchStatus.ACTIVE
            session.add(target_branch)
            session.commit()

            last_round = session.exec(
                select(func.max(Round.round_number)).where(Round.branch_id == branch_id)
            ).one_or_none()
            completed_rounds = int(last_round or 0)
            start_round = max(completed_rounds + 1, (target_branch.fork_round or 0) + 1, 1)
            active_branch_id = target_branch.id
            resume_parent_branch_id = target_branch.parent_branch_id
            _resume_replay_kind = target_branch.replay_kind  # str | None
            all_branches = [
                {
                    "id": active_branch_id,
                    "parent_branch_id": target_branch.parent_branch_id,
                    "fork_round": target_branch.fork_round,
                    "status": BranchStatus.ACTIVE.value,
                    "probability": target_branch.probability,
                }
            ]

        # Restore only the active resume branch from its parent checkpoint.
        if _resume_replay_kind == "resume" and resume_parent_branch_id:
            from app.services.replay import load_checkpoint_agent_states

            resume_checkpoint_agents = load_checkpoint_agent_states(
                scenario_id,
                resume_parent_branch_id,
                start_round - 1,
            )

    branch_agent_states: dict[str, list[dict[str, Any]]] = {
        active_branch_id: _clone_agent_states(
            agents,
            checkpoint_states=resume_checkpoint_agents,
        )
    }
    branch_emotion_states: dict[str, dict[str, str]] = {
        active_branch_id: {
            str(agent["id"]): str(agent.get("emotion") or "neutral")
            for agent in branch_agent_states[active_branch_id]
        }
    }

    # ── Blackboard per branch (only in blackboard mode) ─
    mode = ctx.get("mode", "blackboard")
    if mode == "blackboard":
        bb_init = Blackboard()
        # P3-A: register agent groups on the blackboard
        if hierarchical:
            for agent_name, group_name in agent_to_group.items():
                bb_init.set_agent_group(agent_name, group_name)
                bb_init.set_agent_faction(agent_name, group_name)
        if branch_id is not None and resume_parent_branch_id:
            _bb_restored = False
            # Prefer full checkpoint blackboard for resume branches.
            # Counterfactual branches rewrite the fork round, so the parent's
            # checkpoint after that round is stale for the new worldline.
            if _resume_replay_kind == "resume":
                from app.services.replay import load_checkpoint_blackboard

                cp_bb = load_checkpoint_blackboard(
                    scenario_id,
                    resume_parent_branch_id,
                    start_round - 1,
                )
                if cp_bb:
                    bb_init = Blackboard.from_snapshot(cp_bb)
                    # Re-register groups if hierarchical (snapshot may lack them
                    # for old checkpoints written before export_snapshot)
                    if hierarchical:
                        for an, gn in agent_to_group.items():
                            bb_init.set_agent_group(an, gn)
                            bb_init.set_agent_faction(an, gn)
                    _bb_restored = True
            # Fallback: compressed briefing for non-counterfactual branch resumes.
            if not _bb_restored and _resume_replay_kind != "counterfactual":
                parent_summary = _load_latest_compressed_briefing(
                    engine,
                    resume_parent_branch_id,
                    before_round=start_round,
                )
                if parent_summary:
                    bb_init.update_global_summary(parent_summary)
        blackboards: dict[str, Blackboard] = {active_branch_id: bb_init}
    else:
        blackboards = {}  # RAW mode — no blackboard, agents read DB directly

    # ── Simulation loop ──────────────────────────────
    for round_num in range(start_round, sim_rounds + 1):
        _check_cancelled(scenario_id)
        active_branches = [b for b in all_branches if b["status"] == "ACTIVE"]
        if not active_branches:
            break
        await push(
            {
                "type": "round_progress",
                "data": {
                    "round": round_num,
                    "phase": "round_start",
                    "active_branches": len(active_branches),
                },
            }
        )

        detector_budget_ranks: dict[str, int] = {}
        detector_budget_eligible_ids: set[str] | None = None
        if effective_detector_branch_budget_limit is not None:
            ranked_active_branches = sorted(
                active_branches,
                key=lambda item: (
                    -float(item.get("probability", 0.0) or 0.0),
                    str(item.get("id") or ""),
                ),
            )
            detector_budget_ranks = {
                str(branch["id"]): index + 1 for index, branch in enumerate(ranked_active_branches)
            }
            detector_budget_eligible_ids = {
                str(branch["id"])
                for branch in ranked_active_branches[:effective_detector_branch_budget_limit]
            }

        for branch_info in active_branches:
            _check_cancelled(scenario_id)
            current_branch_id = branch_info["id"]
            current_agents = branch_agent_states[current_branch_id]
            expected_domain_agent_ids = tuple(
                sorted(
                    {
                        str(agent.get("id") or "").strip()
                        for agent in current_agents
                        if str(agent.get("id") or "").strip()
                        and str(agent.get("source_type") or "").strip().lower()
                        != "world_event_source"
                    }
                )
            )
            current_emotion_state = branch_emotion_states[current_branch_id]
            current_leaders: list[dict[str, Any]] = []
            current_workers: list[dict[str, Any]] = []
            effective_group_leaders = group_leaders
            if hierarchical:
                (
                    current_leaders,
                    current_workers,
                    effective_group_leaders,
                ) = _resolve_hierarchical_agent_sets(
                    current_agents,
                    dict(group_leaders),
                    agent_to_group,
                )

            # 0) Check for pending user interventions (Butterfly Effect)
            intervention_key = f"{scenario_id}:{current_branch_id}"
            intervention_item = await claim_next_pending_intervention(
                intervention_key, claim_token=str(uuid.uuid4())
            )
            intervention_text: str | None = None
            intervention_metadata: dict[str, Any] = {}
            try:
                if intervention_item is not None:
                    intervention_text = intervention_item.text
                    intervention_metadata = intervention_item.metadata or {}
                    if _intervention_log_has_applied_round(
                        engine,
                        scenario_id=scenario_id,
                        branch_id=current_branch_id,
                        metadata=intervention_metadata,
                    ):
                        await mark_intervention_injected(
                            intervention_key,
                            intervention_item.id,
                        )
                        intervention_item = None
                        intervention_text = None
                        intervention_metadata = {}
                    elif intervention_text is not None:
                        ws_display_text = _intervention_display_text(intervention_item)
                        injected_payload = {
                            "branch_id": current_branch_id,
                            "round": round_num,
                            "text": ws_display_text,
                        }
                        intervention_log_id = intervention_metadata.get("intervention_log_id")
                        if intervention_log_id is not None:
                            intervention_id = str(intervention_log_id).strip()
                            if intervention_id:
                                injected_payload["intervention_id"] = intervention_id
                        await push(
                            {
                                "type": "intervention_injected",
                                "data": injected_payload,
                            }
                        )

                        # V2-P2: Broadcast viz:event_anim for butterfly effect
                        if viz_mapper is not None:
                            viz_interv = viz_mapper.map_intervention(
                                ws_display_text,
                                params={"round": round_num, "branch_id": current_branch_id},  # noqa: E501
                            )
                            await viz_push(viz_interv)

                # 1) Gather agent messages — each pushed to frontend immediately
                round_id = _create_round(engine, current_branch_id, round_num)
                if round_num == 1:
                    from app.services.initial_social_feed import (
                        materialize_initial_social_feed,
                    )

                    _check_cancelled(scenario_id)
                    _ensure_bootstrap_runtime_lease(runtime_lease, scenario_id)
                    with Session(engine) as bootstrap_session:
                        materialize_initial_social_feed(
                            bootstrap_session,
                            scenario_id=scenario_id,
                            branch_id=current_branch_id,
                            round_id=round_id,
                        )
                        _check_cancelled(scenario_id)
                        _ensure_bootstrap_runtime_lease(
                            runtime_lease, scenario_id, session=bootstrap_session
                        )
                        bootstrap_session.commit()
                    _check_cancelled(scenario_id)
                    _ensure_bootstrap_runtime_lease(runtime_lease, scenario_id)
                if settings.FEATURE_AGENT_IDENTITY and settings.FEATURE_MEMORY_PROMOTION:
                    try:
                        await reconcile_verified_memory_promotions_v1(
                            engine,
                            user_id=scenario_owner_user_id,
                        )
                    except Exception:
                        logger.warning(
                            "Verified memory promotion pre-gather reconciliation unavailable"
                        )
                bb = blackboards.get(current_branch_id)
                if bb is None:
                    bb = Blackboard()  # ephemeral — discarded each round in RAW mode

                if hierarchical and current_leaders:
                    # P3-A: hierarchical mode — only Leaders call LLM
                    _check_cancelled(scenario_id)
                    messages = await _gather_hierarchical_messages(
                        engine,
                        scenario_id,
                        current_branch_id,
                        round_id,
                        round_num,
                        current_leaders,
                        current_workers,
                        agent_to_group,
                        effective_group_leaders,
                        setting_bg,
                        key_variable,
                        intervention_text=intervention_text,
                        intervention_metadata=intervention_metadata,
                        push=push,
                        blackboard=bb,
                        llm_overrides=llm_overrides,
                        language=detected_language,
                        viz_mapper=viz_mapper,
                        agent_prev_emotions=current_emotion_state,
                        web_context_block=web_context_block,
                        document_reference_context=document_reference_context,
                        scenario_user_id=scenario_user_id,
                        native_search_domains=native_search_domains,
                        runtime_lease=runtime_lease,
                    )
                    _check_cancelled(scenario_id)
                else:
                    _check_cancelled(scenario_id)
                    messages = await _gather_agent_messages(
                        engine,
                        scenario_id,
                        current_branch_id,
                        round_id,
                        round_num,
                        current_agents,
                        setting_bg,
                        key_variable,
                        intervention_text=intervention_text,
                        intervention_metadata=intervention_metadata,
                        push=push,
                        blackboard=bb,
                        llm_overrides=llm_overrides,
                        language=detected_language,
                        viz_mapper=viz_mapper,
                        agent_prev_emotions=current_emotion_state,
                        web_context_block=web_context_block,
                        document_reference_context=document_reference_context,
                        scenario_user_id=scenario_user_id,
                        native_search_domains=native_search_domains,
                        runtime_lease=runtime_lease,
                    )
                    _check_cancelled(scenario_id)

                if intervention_item is not None:
                    await mark_intervention_injected(intervention_key, intervention_item.id)
            except SimulationCancelled:
                raise
            except Exception as exc:
                if intervention_item is not None:
                    try:
                        await mark_intervention_failed(
                            intervention_key, intervention_item.id, str(exc)
                        )
                    except Exception:
                        logger.debug(
                            "marking claimed intervention as failed failed",
                            exc_info=True,
                        )
                raise

            from app.services.agent_runtime import finalize_domain_round_v1

            _check_cancelled(scenario_id)
            try:
                domain_result = await asyncio.to_thread(
                    finalize_domain_round_v1,
                    engine,
                    scenario_id=scenario_id,
                    branch_id=current_branch_id,
                    round_id=round_id,
                    round_number=round_num,
                    expected_agent_ids=expected_domain_agent_ids,
                    current_runtime_lease=current_runtime_lease,
                )
            except RuntimeError as exc:
                if exc.args == ("DOMAIN_FINALIZATION_CANCELLED",):
                    raise SimulationCancelled(scenario_id) from exc
                if exc.args == ("DOMAIN_FINALIZATION_LEASE_LOST",):
                    raise RuntimeLeaseLost(scenario_id) from exc
                raise
            _check_cancelled(scenario_id)

            domain_finalization_status = str(
                domain_result.domain_finalization.get("status") or ""
            )
            domain_failure_code = str(
                domain_result.domain_finalization.get("failure_code") or ""
            )
            if domain_failure_code != "DOMAIN_SCHEMA_UNAVAILABLE" and (
                domain_result.status == "unavailable"
                or domain_finalization_status in {"incomplete", "unavailable"}
            ):
                return
            if (
                settings.FEATURE_AGENT_IDENTITY
                and settings.FEATURE_MEMORY_PROMOTION
                and domain_result.status in {"committed", "already_committed"}
                and domain_finalization_status == "complete"
            ):
                from app.services.vector_store import (
                    MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1,
                )

                promotion_deadline = (
                    monotonic() + MEMORY_PROMOTION_ATTEMPT_TIMEOUT_SECONDS_V1
                )
                post_commit_cancellation: SimulationCancelled | None = None
                try:
                    await _bounded_memory_promotion_thread_call_v1(
                        _ensure_bootstrap_runtime_lease,
                        runtime_lease,
                        scenario_id,
                        deadline=promotion_deadline,
                    )
                    await attempt_verified_memory_promotion_v1(
                        engine,
                        scenario_id=scenario_id,
                        branch_id=current_branch_id,
                        round_id=round_id,
                        round_number=round_num,
                        deadline=promotion_deadline,
                    )
                except SimulationCancelled as exc:
                    # SQL truth is already committed. Preserve the matching event
                    # before the stale worker yields to the new lease owner.
                    post_commit_cancellation = exc
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning("Verified memory promotion attempt unavailable")
            else:
                post_commit_cancellation = None
            if domain_result.should_broadcast:
                if domain_result.event_data is None:
                    raise RuntimeError("DOMAIN_FINALIZATION_EVENT_DATA_MISSING")
                await push(
                    {
                        "type": "world_state_committed",
                        "data": dict(domain_result.event_data),
                    }
                )
            if post_commit_cancellation is not None:
                raise post_commit_cancellation

            # 2) Round summary
            if detected_language.startswith("Chinese"):
                summary_text = f"第{round_num}轮完成, {len(messages)}条发言"
            else:
                summary_text = f"Round {round_num} complete, {len(messages)} messages"
            await push(
                {
                    "type": "round_summary",
                    "data": {
                        "branch_id": current_branch_id,
                        "round": round_num,
                        "summary": summary_text,
                    },
                }
            )

            # Phase 4: Persist intervention effect receipt if an intervention ran this round.
            if intervention_text is not None:
                try:
                    effect_log_id = (intervention_metadata or {}).get("intervention_log_id")
                    raw_user_input = (intervention_metadata or {}).get("raw_user_input")
                    if not raw_user_input:
                        raw_user_input = (
                            _intervention_display_text(intervention_item)
                            if intervention_item is not None
                            else intervention_text
                        )
                    effect_summary = _build_intervention_effect_summary(
                        intervention_log_id=(str(effect_log_id) if effect_log_id else None),
                        card_id=(intervention_metadata or {}).get("card_id"),
                        round_number=round_num,
                        user_input=str(raw_user_input),
                        messages=messages,
                    )
                    if effect_log_id:
                        _persist_intervention_effect(
                            engine,
                            intervention_log_id=str(effect_log_id),
                            summary=effect_summary,
                            scenario_id=scenario_id,
                            branch_id=current_branch_id,
                        )
                except SimulationCancelled:
                    raise
                except Exception:
                    logger.debug(
                        "intervention effect summary hook failed (non-blocking)",
                        exc_info=True,
                    )

            # Phase 3 F2: Causal graph — record round nodes (non-blocking)
            if _CAUSAL_AVAILABLE and settings.FEATURE_CAUSAL_GRAPH:
                try:
                    _check_cancelled(scenario_id)
                    await _append_causal_graph_delta(
                        scenario_id,
                        current_branch_id,
                        round_num,
                        messages,
                    )
                    _check_cancelled(scenario_id)
                except SimulationCancelled:
                    raise
                except Exception:
                    logger.debug("causal_graph append failed (non-blocking)", exc_info=True)

            # Phase 3 F5: Faction detection + WS broadcast (non-blocking)
            if _FACTIONS_AVAILABLE and settings.FEATURE_FACTIONS:
                try:
                    # H5 fix: cancel guard around factions to_thread.
                    _check_cancelled(scenario_id)
                    _faction_result = await asyncio.to_thread(
                        _factions_process,
                        scenario_id,
                        current_branch_id,
                        round_num,
                        messages,
                        language=detected_language,
                    )
                    _check_cancelled(scenario_id)
                    if _faction_result:
                        if _faction_result.get("factions"):
                            await push(
                                {
                                    "type": "viz:faction_cluster",
                                    "data": {
                                        "factions": _faction_result["factions"],
                                        "round": round_num,
                                        "branch_id": current_branch_id,
                                    },
                                }
                            )
                        if _faction_result.get("events"):
                            await push(
                                {
                                    "type": "viz:faction_event",
                                    "data": {
                                        "events": _faction_result["events"],
                                        "round": round_num,
                                        "branch_id": current_branch_id,
                                    },
                                }
                            )
                except SimulationCancelled:
                    # H5 fix: cancel must not be swallowed by the non-blocking guard.
                    raise
                except Exception:
                    logger.debug("factions process_round failed (non-blocking)", exc_info=True)

            # Phase 3 F4: Checkpoint snapshot (non-blocking)
            if _CHECKPOINT_AVAILABLE and settings.FEATURE_COUNTERFACTUAL_REPLAY:
                try:
                    _check_cancelled(scenario_id)
                    bb_snapshot = None
                    _cp_bb = blackboards.get(current_branch_id)
                    if _cp_bb is not None:
                        bb_snapshot = _cp_bb.export_snapshot()
                    await asyncio.to_thread(
                        _checkpoint_write,
                        scenario_id,
                        current_branch_id,
                        round_num,
                        current_agents,
                        bb_snapshot,
                    )
                    _check_cancelled(scenario_id)
                except SimulationCancelled:
                    raise
                except Exception:
                    logger.debug("checkpoint write failed (non-blocking)", exc_info=True)

            # V2-P2: Check for card event triggers
            if viz_mapper is not None and _VIZ_AVAILABLE:
                active_count_for_card = len([b for b in all_branches if b["status"] == "ACTIVE"])
                triggered_card = check_card_trigger(
                    round_number=round_num,
                    branch_count=active_count_for_card,
                    last_card_round=last_card_round,
                )
                if triggered_card:
                    last_card_round = round_num
                    card_viz = get_card_viz_event(triggered_card)
                    await viz_push(card_viz)
                    logger.info(
                        "V2 Card event triggered: %s at round %d", triggered_card, round_num
                    )  # noqa: E501

            # 3) Compress memory every N rounds
            compress_interval = _effective_compress_interval(sim_rounds)
            if round_num % compress_interval == 0:
                compress_bb = blackboards.get(current_branch_id)  # None in RAW mode
                await _compress_round_memory(
                    engine,
                    current_branch_id,
                    round_num,
                    compress_interval=compress_interval,
                    blackboard=compress_bb,
                    language=detected_language,
                    llm_overrides=llm_overrides,
                )

            # 4) Detect forking (skip on last round — children would have no messages)
            diverge_messages = [m for m in messages if m.get("diverge")]
            diverge_signals = [m["diverge"] for m in diverge_messages]
            active_count = len([b for b in all_branches if b["status"] == "ACTIVE"])
            if diverge_signals:
                detector_temperature = (llm_overrides or {}).get("temperature")
                recent_summary = format_messages_for_context(
                    _get_recent_messages(engine, current_branch_id, max_rounds=3),
                    max_recent=15,
                )
                fork_debug_entry: dict[str, Any] = {
                    "branch_id": current_branch_id,
                    "round": round_num,
                    "active_branch_count": active_count,
                    "max_branches": settings.MAX_BRANCHES,
                    "fork_detector_active_branch_limit": fork_detector_active_branch_limit,
                    "detector_branch_rank": detector_budget_ranks.get(current_branch_id),
                    "detector_branch_budget_eligible": (
                        True
                        if detector_budget_eligible_ids is None
                        else current_branch_id in detector_budget_eligible_ids  # noqa: E501
                    ),
                    "sim_rounds": sim_rounds,
                    "sensitivity": sensitivity,
                    "temperature": detector_temperature,
                    "prompt_variant": fork_prompt_variant,
                    "diverge_signal_count": len(diverge_signals),
                    "diverge_signals": _sanitize_fork_debug_signals(diverge_signals),
                    "recent_summary_excerpt": _truncate_debug_text(
                        recent_summary,
                        max_chars=_FORK_DEBUG_MAX_SUMMARY_CHARS,
                    ),
                    "detector_invoked": False,
                    "skip_reason": None,
                    "decision": "pending",
                }

                if active_count >= settings.MAX_BRANCHES:
                    fork_debug_entry["skip_reason"] = "max_branches_reached"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                elif (
                    detector_budget_eligible_ids is not None
                    and current_branch_id not in detector_budget_eligible_ids
                ):
                    fork_debug_entry["skip_reason"] = "detector_budget_exceeded"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                elif round_num >= sim_rounds:
                    fork_debug_entry["skip_reason"] = "last_round"
                    fork_debug_entry["decision"] = "skipped"
                    _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)
                else:
                    _check_cancelled(scenario_id)
                    fork_result = await _detect_fork(
                        engine,
                        current_branch_id,
                        diverge_signals,
                        sensitivity,
                        llm_overrides=llm_overrides,
                        language=detected_language,
                        prompt_variant=fork_prompt_variant,
                        recent_summary=recent_summary,
                        question=scenario.question or "",
                    )
                    _check_cancelled(scenario_id)
                    fork_debug_entry["detector_invoked"] = True
                    fork_debug_entry["detector_result"] = _sanitize_fork_debug_result(
                        fork_result,
                    )

                    # H-6 fix: strict boolean check — LLM may return truthy non-bool values
                    if fork_result.get("should_fork") is True:
                        new_branch_infos = []
                        for fb in fork_result.get("branches", []):
                            new_id = _create_branch(
                                engine,
                                scenario_id,
                                parent_branch_id=current_branch_id,
                                fork_round=round_num,
                                fork_reason=fork_result["reason"],
                                title=fb["title"],
                                description=fb.get("description", ""),
                                probability=fb["probability"],
                            )
                            all_branches.append(
                                {
                                    "id": new_id,
                                    "parent_branch_id": current_branch_id,
                                    "fork_round": round_num,
                                    "status": "ACTIVE",
                                    "probability": fb["probability"],
                                }
                            )
                            # Fork blackboard for the new branch (only in blackboard mode)
                            if current_branch_id in blackboards:
                                blackboards[new_id] = blackboards[current_branch_id].fork()
                            branch_agent_states[new_id] = _clone_agent_states(current_agents)
                            branch_emotion_states[new_id] = dict(current_emotion_state)
                            new_branch_infos.append(
                                {
                                    "id": new_id,
                                    "title": fb["title"],
                                    "description": fb.get("description", ""),
                                    "fork_round": round_num,
                                    "probability": fb["probability"],
                                }
                            )

                        fork_debug_entry["decision"] = "fork_created"
                        fork_debug_entry["created_branch_count"] = len(new_branch_infos)
                        fork_debug_entry["created_branch_ids"] = [
                            branch["id"] for branch in new_branch_infos
                        ]
                        fork_debug_entry["created_branch_titles"] = [
                            branch["title"] for branch in new_branch_infos
                        ]
                        _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)

                        await push(
                            {
                                "type": "branch_fork",
                                "data": {
                                    "parent": current_branch_id,
                                    "children": new_branch_infos,
                                    "reason": fork_result["reason"],
                                },
                            }
                        )

                        # Phase 3 F2: Record fork in causal graph
                        if _CAUSAL_AVAILABLE and settings.FEATURE_CAUSAL_GRAPH:
                            try:
                                _check_cancelled(scenario_id)
                                await _append_causal_graph_delta(
                                    scenario_id,
                                    current_branch_id,
                                    round_num,
                                    [],
                                    fork_event={
                                        "branch_id": current_branch_id,
                                        "reason": fork_result.get("reason", ""),
                                        "children": [b["id"] for b in new_branch_infos],
                                        "trigger_message_ids": [
                                            message["id"]
                                            for message in diverge_messages
                                            if message.get("id")
                                        ],
                                    },
                                    language=detected_language,
                                )
                                _check_cancelled(scenario_id)
                            except SimulationCancelled:
                                raise
                            except Exception:
                                logger.debug("causal_graph fork append failed", exc_info=True)

                        # V2: Broadcast viz:world_split
                        if viz_mapper is not None:
                            child_ids = [b["id"] for b in new_branch_infos]
                            viz_split = viz_mapper.map_branch_split(
                                parent_branch_id=current_branch_id,
                                child_branch_ids=child_ids,
                                reason=fork_result.get("reason"),
                            )
                            await viz_push(viz_split)

                        # ── Mark parent as COMPLETED after fork ──
                        # Parent's timeline splits into children; parent no longer
                        # participates in further rounds or fork detection.
                        branch_info["status"] = "COMPLETED"
                        _update_branch_status(engine, current_branch_id, BranchStatus.COMPLETED)
                        await push(
                            {
                                "type": "branch_update",
                                "data": {
                                    "branch_id": current_branch_id,
                                    "status": "COMPLETED",
                                },
                            }
                        )
                    else:
                        fork_debug_entry["decision"] = "no_fork"
                        _record_fork_debug_trace(engine, scenario_id, fork_debug_entry)

        # 5) Normalize active branch probabilities before pruning.
        _apply_normalized_active_branch_probabilities(engine, scenario_id, all_branches)

        # 6) Prune low-probability branches
        for b in all_branches:
            if b["status"] == "ACTIVE" and b["probability"] < settings.BRANCH_PRUNE_THRESHOLD:
                b["status"] = "PRUNED"
                _update_branch_status(engine, b["id"], BranchStatus.PRUNED)
                await push(
                    {
                        "type": "branch_prune",
                        "data": {"branch_id": b["id"], "reason": "概率过低"},
                    }
                )

        # 7) Re-normalize survivors after pruning so active branches still sum to 1.0.
        _apply_normalized_active_branch_probabilities(engine, scenario_id, all_branches)

    # Before narration/verdict, normalize the final displayed outcome set.
    # During the loop we keep active-only normalization so pruning semantics do
    # not include already-completed fork parents.
    if branch_id is None:
        _apply_normalized_active_branch_probabilities(
            engine,
            scenario_id,
            all_branches,
            include_completed=True,
        )

    # ── Stage 3: Narrate ─────────────────────────────
    if branch_id is None:
        _update_scenario_status(engine, scenario_id, ScenarioStatus.NARRATING)
        await push({"type": "status", "data": {"status": "narrating"}})

    final_narration_statuses = {BranchStatus.ACTIVE.value, BranchStatus.COMPLETED.value}
    branch_payloads_for_narration = (
        _terminal_branch_candidates(
            [
                branch
                for branch in all_branches
                if _branch_status_value(branch) in final_narration_statuses
            ],
            all_branches,
        )
        if branch_id is None
        else all_branches
    )

    narrated_branch_payloads: list[dict[str, Any]] = []
    if verdict_only_multi_run and branch_id is None:
        narrated_branch_payloads = _build_verdict_only_branch_payloads(
            engine,
            branch_payloads_for_narration,
        )
    else:
        for b in branch_payloads_for_narration:
            _check_cancelled(scenario_id)
            if b["status"] in ("ACTIVE", "COMPLETED"):
                _check_cancelled(scenario_id)
                narration = await _narrate_branch_data_fail_soft(
                    engine,
                    b["id"],
                    branch_agent_states[b["id"]],
                    language=detected_language,
                    llm_overrides=llm_overrides,
                    web_context_block=web_context_block,
                    question=scenario.question or "",
                )
                _check_cancelled(scenario_id)
                narration = _save_narration_fail_soft(
                    engine,
                    b["id"],
                    narration,
                    language=detected_language,
                )
                await push(
                    {
                        "type": "narration",
                        "data": {
                            "branch_id": b["id"],
                            "title": narration.get("title", ""),
                            "story": narration.get("story", ""),
                            "insight": narration.get("insight", ""),
                        },
                    }
                )
                narrated_branch_payloads.append(
                    {
                        "id": b["id"],
                        "parent_branch_id": b.get("parent_branch_id"),
                        "status": BranchStatus.COMPLETED.value,
                        "fork_round": b.get("fork_round"),
                        "probability": b.get("probability", 0),
                        "title": narration.get("title", ""),
                        "story": narration.get("story", ""),
                        "insight": narration.get("insight", ""),
                    }
                )

    await _rewrite_branch_titles_after_narration(
        engine,
        narrated_branch_payloads,
        question=scenario.question or "",
        language=detected_language,
        llm_overrides=llm_overrides,
    )

    final_branch_payloads = (
        _terminal_branch_candidates(narrated_branch_payloads, narrated_branch_payloads)
        if branch_id is None
        else narrated_branch_payloads
    )

    if branch_id is None and settings.FEATURE_RESULT_VERDICT:
        verdict = await _generate_verdict(
            scenario.question or "",
            final_branch_payloads,
            web_context_block,
            detected_language,
            llm_overrides=llm_overrides,
        )
        if verdict is not None:
            if verdict.get("_verdict_generation_failed"):
                _persist_result_quality_verdict_failure(engine, scenario_id, verdict)
            else:
                _persist_result_quality_verdict(engine, scenario_id, verdict)

    if branch_id is None and settings.FEATURE_RESULT_REPORT and not verdict_only_multi_run:
        try:
            chosen_report_branch = _pick_theater_ending_payload(final_branch_payloads)
            report_branch_id = (
                str(chosen_report_branch.get("id") or "") if chosen_report_branch else ""
            )
            if report_branch_id:
                report_override_keys = {
                    "api_key",
                    "base_url",
                    "model",
                    "temperature",
                    "requests_per_minute",
                    "tokens_per_minute",
                    "concurrency",
                    "supports_structured_outputs_override",
                    "supports_native_search_override",
                    "native_search_upstream_override",
                }
                report_overrides = {
                    key: (
                        value
                        if key == "api_key"
                        else str(value)
                        if key in {"base_url", "model"} and value is not None
                        else value
                    )
                    for key, value in (llm_overrides or {}).items()
                    if key in report_override_keys
                }
                from app.api.helpers import schedule_background_task
                from app.services.result_report.builder import (
                    build_report_safe,
                    persist_generating_report_placeholder_if_absent,
                )

                try:
                    persist_generating_report_placeholder_if_absent(
                        scenario_id,
                        report_branch_id,
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to persist result report placeholder: %s: %s",
                        type(exc).__name__,
                        _scrub_sensitive_text(str(exc)),
                    )
                schedule_background_task(
                    build_report_safe(
                        scenario_id,
                        report_branch_id,
                        overrides=report_overrides,
                    )
                )
        except Exception as exc:
            logger.warning(
                "Failed to schedule result report generation: %s: %s",
                type(exc).__name__,
                _scrub_sensitive_text(str(exc)),
            )

    # ── Done ─────────────────────────────────────────
    # Cleanup pending interventions for this scenario (prevent memory leak)
    if branch_id is None:
        await clear_pending_interventions_for_scenario(scenario_id)
    else:
        await clear_pending_interventions_for_branch(scenario_id, branch_id)

    scenario_finished = reconcile_scenario_done_if_complete(
        engine,
        scenario_id,
        ignore_runtime_lock=True,
    )
    if scenario_finished and viz_mapper is not None:
        chosen_ending = _pick_theater_ending_payload(
            final_branch_payloads,
            branch_id=branch_id,
        )
        if chosen_ending is not None:
            prob = chosen_ending.get("probability", 0)
            ending_type = "positive" if prob > 0.5 else ("negative" if prob < 0.3 else "neutral")
            viz_end = viz_mapper.map_ending(
                branch_id=chosen_ending["id"],
                title=chosen_ending.get("title", ""),
                story=chosen_ending.get("story", "") or chosen_ending.get("insight", ""),
                ending_type=ending_type,
            )
            await viz_push(viz_end)

    # Phase 3 F1: Record growth events + identity memories at scenario end
    # Runs in thread pool to avoid blocking the async event loop (sync DB + ChromaDB I/O).
    if scenario_finished and settings.FEATURE_AGENT_IDENTITY:

        def _run_identity_lifecycle() -> list[tuple[str, str]]:
            """Returns list of (user_id, identity_id) pairs that may need compaction."""
            from app.services.agent_identity import record_growth_event
            from app.services.vector_store import (
                check_identity_compaction_needed,
                identity_memory_ref,
                store_identity_memory,
            )

            _compaction_worklist: list[tuple[str, str]] = []
            with Session(engine) as _id_sess:
                _sc = _id_sess.get(Scenario, scenario_id)
                # Prefer Scenario.user_id; fall back to parsed_context for older rows
                _sc_user_id = None
                if _sc:
                    _sc_user_id = _sc.user_id or (_sc.parsed_context or {}).get("user_id")
                _id_agents = _id_sess.exec(
                    select(Agent).where(
                        Agent.scenario_id == scenario_id,
                        Agent.agent_identity_id.isnot(None),  # type: ignore[union-attr]
                    )
                ).all()
                _narrated_by_id = {
                    str(payload.get("id") or ""): payload
                    for payload in narrated_branch_payloads
                    if str(payload.get("id") or "").strip()
                }
                _failed = 0
                for _ag in _id_agents:
                    try:
                        _check_cancelled(scenario_id)
                        # Identity memory is grounded only in this Agent's own
                        # durable messages. Never fan out a best-branch story to
                        # identities that did not participate in that branch.
                        _message_rows = list(
                            _id_sess.exec(
                                select(AgentMessage, Round.branch_id, Round.round_number)
                                .join(Round, AgentMessage.round_id == Round.id)
                                .where(AgentMessage.agent_id == _ag.id)
                                .order_by(Round.round_number.asc(), AgentMessage.id.asc())
                            ).all()
                        )
                        _by_branch: dict[str, list[tuple[AgentMessage, int]]] = {}
                        for _message, _message_branch_id, _message_round in _message_rows:
                            if _message_branch_id in _narrated_by_id:
                                _by_branch.setdefault(_message_branch_id, []).append(
                                    (_message, _message_round)
                                )
                        if not _by_branch:
                            continue
                        _memory_branch_id = min(
                            _by_branch,
                            key=lambda candidate_id: (
                                -float(_narrated_by_id[candidate_id].get("probability", 0) or 0),
                                candidate_id,
                            ),
                        )
                        _own_messages = _by_branch[_memory_branch_id]
                        _latest_message, _latest_round = _own_messages[-1]
                        _source_message_ids = [message.id for message, _round in _own_messages[-3:]]
                        _branch_payload = _narrated_by_id[_memory_branch_id]
                        _outcome = str(
                            _branch_payload.get("story")
                            or _branch_payload.get("insight")
                            or _branch_payload.get("title")
                            or "Scenario completed."
                        ).strip()[:300]
                        _observation = str(_latest_message.content or "").strip()[:300]
                        if not _observation:
                            continue
                        _reflection = (
                            f"{_ag.name} ({_ag.role}) said: {_observation} "
                            f"Observed simulated outcome: {_outcome}"
                        )[:600]
                        _memory_idempotency_key = (
                            f"agent_reflection:{_memory_branch_id}:"
                            f"{_latest_round}:{':'.join(_source_message_ids)}"
                        )
                        _memory_ref = (
                            identity_memory_ref(
                                _sc_user_id,
                                _ag.agent_identity_id,
                                scenario_id,
                                _memory_idempotency_key,
                            )
                            if _sc_user_id
                            else ""
                        )
                        _provenance = {
                            "version": 1,
                            "memory_kind": "reflection",
                            "action_type": "utterance",
                            "observation": _observation,
                            "source_message_ids": _source_message_ids,
                            "source_event_ids": [],
                            "confidence_tier": "high",
                            "provenance_kind": "durable_agent_message",
                            "outcome": _outcome,
                            "write_reason": "scenario_completed_with_agent_participation",
                            "memory_ref": "",
                        }
                        if _sc_user_id:
                            _memory_written = store_identity_memory(
                                user_id=_sc_user_id,
                                identity_id=_ag.agent_identity_id,
                                scenario_id=scenario_id,
                                summary=_reflection,
                                metadata={
                                    "branch_id": _memory_branch_id,
                                    "round": _latest_round,
                                    **_provenance,
                                    "memory_ref": _memory_ref,
                                },
                                idempotency_key=_memory_idempotency_key,
                            )
                            if _memory_written:
                                _provenance["memory_ref"] = _memory_ref
                            else:
                                _provenance["memory_write_status"] = "unavailable"
                        record_growth_event(
                            identity_id=_ag.agent_identity_id,
                            scenario_id=scenario_id,
                            branch_id=_memory_branch_id,
                            round_number=_latest_round,
                            event_type="agent_reflection",
                            summary=_reflection[:200],
                            metrics=_provenance,
                        )
                        _check_cancelled(scenario_id)
                        if _sc_user_id and _provenance["memory_ref"]:
                            # Check if compaction is needed after this write
                            if settings.FEATURE_IDENTITY_COMPACTION:
                                if check_identity_compaction_needed(
                                    _sc_user_id,
                                    _ag.agent_identity_id,
                                ):
                                    _compaction_worklist.append(
                                        (_sc_user_id, _ag.agent_identity_id)
                                    )
                    except SimulationCancelled:
                        raise
                    except Exception:
                        _failed += 1
                        logger.warning(
                            "identity hook failed for agent %s in scenario %s",
                            _ag.agent_identity_id,
                            scenario_id,
                            exc_info=True,
                        )
                if _failed:
                    logger.warning(
                        "identity lifecycle: %d/%d agents failed for scenario %s",
                        _failed,
                        len(_id_agents),
                        scenario_id,
                    )
            # Deduplicate worklist before returning
            return list(set(_compaction_worklist))

        try:
            # H5 fix: cancel guard around identity lifecycle to_thread.
            _check_cancelled(scenario_id)
            _compaction_pairs = await asyncio.to_thread(_run_identity_lifecycle)
            _check_cancelled(scenario_id)
        except SimulationCancelled:
            raise
        except Exception:
            _compaction_pairs = []
            logger.warning(
                "identity lifecycle hooks failed for scenario %s (non-blocking)",
                scenario_id,
                exc_info=True,
            )

        # Fire-and-forget compaction with explicit exception logging
        if _compaction_pairs:

            async def _run_compaction(
                pairs: list[tuple[str, str]],
            ) -> None:
                from app.services.vector_store import (
                    execute_compaction_group,
                    prepare_compaction_groups,
                )

                for uid, iid in pairs:
                    try:
                        groups = await asyncio.to_thread(
                            prepare_compaction_groups,
                            uid,
                            iid,
                        )
                        for grp in groups:
                            try:
                                summary = await _summarize_identity_compaction_group(
                                    grp.summaries,
                                    scenario_ids=grp.scenario_ids,
                                    llm_overrides=llm_overrides,
                                )
                            except Exception as exc:
                                # LLM failure fallback: concatenate
                                summary = " | ".join(grp.summaries)[:600]
                                logger.warning(
                                    "compaction LLM failed for %s/%s, using fallback: %s: %s",
                                    uid,
                                    iid,
                                    type(exc).__name__,
                                    _scrub_sensitive_text(str(exc)),
                                )
                            await asyncio.to_thread(
                                execute_compaction_group,
                                uid,
                                iid,
                                grp,
                                summary,
                            )
                    except Exception:
                        logger.warning(
                            "compaction failed for %s/%s (non-blocking)",
                            uid,
                            iid,
                            exc_info=True,
                        )

            from app.api.helpers import schedule_background_task

            schedule_background_task(_run_compaction(_compaction_pairs))

    if scenario_finished:
        # H5 fix: final cancel guard before broadcasting simulation_done so a
        # late user cancel does not race the terminal "done" broadcast.
        _check_cancelled(scenario_id)
        await push({"type": "simulation_done"})

    if branch_id is None:
        logger.info("Simulation complete for scenario %s", scenario_id)
    else:
        logger.info(
            "Branch-only simulation complete for scenario %s branch %s (scenario_done=%s)",
            scenario_id,
            branch_id,
            scenario_finished,
        )


# ── Internal helpers ─────────────────────────────────────


def _build_worldline_context(engine, branch_id: str, language: str = "Chinese") -> str:
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if not branch:
            return ""
        parent = session.get(Branch, branch.parent_branch_id) if branch.parent_branch_id else None
        scenario = session.get(Scenario, branch.scenario_id)
        parsed_context = (
            dict(scenario.parsed_context)
            if scenario is not None and isinstance(scenario.parsed_context, dict)
            else {}
        )
        scenario_question = str(getattr(scenario, "question", "") or "").strip()

    status = getattr(branch.status, "value", branch.status)
    is_root_branch = _is_canonical_root_branch(branch, parsed_context)
    key_variable = str(parsed_context.get("key_variable") or scenario_question).strip()
    setting_data = parsed_context.get("setting") if isinstance(parsed_context, dict) else None
    setting_hook = (
        _format_setting(setting_data, language=language)
        if isinstance(setting_data, dict) and setting_data
        else ""
    )
    if _is_chinese_language(language):
        lines = [
            f"当前世界线ID: {branch.id}",
            f"标题: {branch.title or '未命名世界线'}",
            f"状态: {status or '未知'}",
            f"分叉起点: R{branch.fork_round}",
        ]
        if is_root_branch:
            lines.append("根世界线锚点: 这是原始 what-if 的起点，不是分叉后的派生线")
        if scenario_question:
            lines.append(f"原始问题: {scenario_question}")
        if key_variable:
            lines.append(f"关键变量: {key_variable}")
        if is_root_branch:
            if setting_hook:
                lines.append(f"场景钩子:\n{setting_hook}")
        if branch.fork_reason:
            lines.append(f"分叉原因: {branch.fork_reason}")
        if parent:
            lines.append(f"来源世界线: {parent.title or parent.id}")
        lines.append(
            "本轮发言要回应这条世界线独有的标题、转折和风险，不要把其它世界线的说法直接搬过来。"
        )
        return "\n".join(lines)

    lines = [
        f"Current worldline id: {branch.id}",
        f"Title: {branch.title or 'Untitled worldline'}",
        f"Status: {status or 'unknown'}",
        f"Fork origin: R{branch.fork_round}",
    ]
    if is_root_branch:
        lines.append("Root worldline anchor: this is the original what-if starting point")
    if scenario_question:
        lines.append(f"Original question: {scenario_question}")
    if key_variable:
        lines.append(f"Key variable: {key_variable}")
    if is_root_branch:
        if setting_hook:
            lines.append(f"Setting hook:\n{setting_hook}")
    if branch.fork_reason:
        lines.append(f"Fork reason: {branch.fork_reason}")
    if parent:
        lines.append(f"Source worldline: {parent.title or parent.id}")
    lines.append(
        "This turn must respond to this worldline's specific title, hinge, and risk; "
        "do not copy the wording of another worldline.",
    )
    return "\n".join(lines)


def _has_replay_provenance(branch: Branch) -> bool:
    return any(
        (
            str(getattr(branch, "replay_kind", "") or "").strip(),
            str(getattr(branch, "replay_source_branch_id", "") or "").strip(),
            getattr(branch, "replay_source_round", None) is not None,
            str(getattr(branch, "replay_source_agent_id", "") or "").strip(),
        )
    )


def _is_canonical_root_branch(branch: Branch, parsed_context: dict[str, Any]) -> bool:
    if branch.parent_branch_id or int(branch.fork_round or 0) != 0:
        return False
    if getattr(branch.status, "value", branch.status) != BranchStatus.ACTIVE.value:
        return False
    if _has_replay_provenance(branch):
        return False

    branch_title = str(branch.title or "").strip()
    initial_title = str(parsed_context.get("initial_title") or "").strip()
    if initial_title:
        return branch_title == initial_title
    return branch_title in {"问题起点", "Starting point"}


def _agent_debate_coherence_guidance(agent_tier: str, language: str) -> str:
    if agent_tier not in {"CORE", "IMPORTANT"}:
        return ""
    if _is_chinese_language(language):
        return (
            "连贯辩论要求：如果上下文里已有其他参与者的近期发言，"
            "先点名回应其他参与者的具体观点（引用对方名字或具体说法），"
            "再承接、反驳、追问或补强；不要只另起炉灶，"
            "也不要只重复自己的立场。"
        )
    return (
        "Coherent debate requirement: if recent context includes other participants, "
        "name-cite and respond to other participants' specific claims, then build on, "
        "rebut, question, or sharpen them. Do not start a disconnected monologue or "
        "merely restate your own position."
    )


def _append_agent_debate_coherence_guidance(
    prompt: str,
    agent_tier: str,
    language: str,
) -> str:
    guidance = _agent_debate_coherence_guidance(agent_tier, language)
    if not guidance or guidance in prompt:
        return prompt
    return f"{prompt}\n\n{guidance}"


def _domain_world_decision_prompt_v1(
    domain_world_context: Mapping[str, object] | None,
    *,
    language: str,
) -> str:
    """Render the active N-1 DomainWorld context and its optional exact group."""

    if not isinstance(domain_world_context, Mapping):
        return ""
    schema_hash = domain_world_context.get("schema_hash")
    state_revision = domain_world_context.get("input_state_revision")
    if not isinstance(schema_hash, str) or not isinstance(state_revision, str):
        return ""

    group_template = {
        "schema_hash": schema_hash,
        "input_state_revision": state_revision,
        "proposals": [
            {
                "variable_id": "copy a variable_id from the frozen schema",
                "rule_id": "copy a rule_id from the frozen schema",
                "operation": "copy that rule's operation",
                "requested_value": "typed canonical value or null",
                "unit": "copy that rule's unit",
                "expected_before": "typed canonical value or null",
                "event_key": "portable-event-key",
            }
        ],
    }
    group_json = json.dumps(
        group_template,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    context_json = json.dumps(
        domain_world_context,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    context_block = format_untrusted_text_block(
        "Active DomainWorld v1 context",
        context_json,
        max_chars=max(40_000, len(context_json) * 2 + 1),
    )
    if _is_chinese_language(language):
        guidance = (
            "DomainWorld v1 是只读的 N-1 轮状态与冻结 schema。只有角色本轮确实执行的"
            "非 IDLE 动作可以在 action_parameters 中附带可选 domain_world_v1；无可靠"
            "领域意图时必须完全省略该键，IDLE 也必须省略。该组必须且只能包含 "
            "schema_hash、input_state_revision、proposals 三键，并逐字复制下方 hash/revision。"
            "每个 proposal 必须且只能包含 variable_id、rule_id、operation、requested_value、"
            "unit、expected_before、event_key 七键；最多 4 个，保持语义顺序，不得加入坐标。"
            "rule 必须绑定 selected_action。constant 操作的 requested_value 为 null；"
            "set_if_expected 必须填写非 null expected_before，其余 operation 的 expected_before "
            "必须为 null。数值按 schema 使用 canonical "
            "字符串，boolean 使用 JSON boolean，enum 使用 canonical string。不得从发言、"
            "self-report、world_state_changes 或承诺推断领域效果。以下仅是可选 "
            "action_parameters.domain_world_v1 的精确结构模板；无可靠领域意图时整键省略：\n"
            f"{group_json}\n"
            f"{context_block}"
        )
    else:
        guidance = (
            "DomainWorld v1 is the read-only N-1 state and frozen schema. Only a non-IDLE action "
            "the character actually performs this turn may include the optional domain_world_v1 "
            "inside action_parameters. Omit that key entirely when there is no grounded domain "
            "intent, and always omit it for IDLE. The group must contain exactly schema_hash, "
            "input_state_revision, and proposals, copying the hash and revision below verbatim. "
            "Each proposal must contain exactly variable_id, rule_id, operation, requested_value, "
            "unit, expected_before, and event_key. Preserve semantic order, emit at most four, "
            "and never add coordinates. The rule must bind selected_action. Constant operations "
            "use null requested_value. set_if_expected MUST use non-null expected_before; every "
            "other operation MUST use null expected_before. "
            "Use canonical numeric strings, JSON booleans, and canonical enum strings as defined "
            "by the schema. Never infer domain effects from speech, self-report, "
            "world_state_changes, or commitments. The following is only the exact structural "
            "template for the optional action_parameters.domain_world_v1; omit the entire key "
            "when there is no grounded domain intent:\n"
            f"{group_json}\n"
            f"{context_block}"
        )
    return guidance


def _build_decision_envelope_prompt(
    context: str,
    *,
    agent_name: str,
    fallback_goal: str,
    action_target_catalog: str,
    opportunity_snapshot: OpportunitySnapshotV1 | None = None,
    domain_world_context: Mapping[str, object] | None = None,
    prior_transition_context: str,
    language: str,
    replan_reason: str = "",
) -> str:
    """Ask for an auditable decision record, never hidden chain-of-thought."""
    is_chinese = _is_chinese_language(language)
    heading = (
        "在生成角色发言前，先给出可审计的结构化决策。"
        if is_chinese
        else "Produce an auditable structured decision before generating speech."
    )
    constraints = (
        "只写事实依据和决策字段；不得输出思维链、逐步推理、thought、reasoning、"
        "analysis 或 chain_of_thought。IDLE 是合法选择，但必须说明 idle_reason 和"
        "允许的 idle_reason_code。"
        "不得为动作覆盖率而轮换、随机或强制选择动作。非 IDLE 动作必须是角色本轮"
        "确实要执行、并可由随后发言逐字落实的具体动作。"
        if is_chinese
        else (
            "Write only factual bases and decision fields. Do not output chain-of-thought, "
            "step-by-step reasoning, thought, reasoning, analysis, or chain_of_thought. "
            "IDLE is valid but requires idle_reason and an allowed idle_reason_code. Never "
            "rotate, randomize, or force actions "
            "for coverage. A non-IDLE action must be a concrete act the character will really "
            "perform this turn and the later speech can realize verbatim."
        )
    )
    action_guidance = (
        "按当前事实证据和计划发言分类，按原文证据分类，不设动作配额或默认类型。"
        "绝不能复制目标目录正文或其他角色内容作为 content 或 realization_phrase，"
        "不能只返回一个无意义单字。目标目录不是资格来源；非 IDLE 动作只有在 Opportunity "
        "Snapshot 中 available 和 grounded 同时为 true 时才可选择。需要目标的动作只能复制"
        "快照 eligible_target_ids 与目录交集中的合法 ID。POST/COMMENT/SEARCH 的 content "
        "必须是随后发言会逐字包含的具体内容；REACTION/FOLLOW/MUTE/TREND/REFRESH 的 content "
        "必须为空，并用 realization_phrase 给出随后发言会逐字包含的行动短语。COMMENT/REACTION "
        "只能指向目录中上一轮可见的 post/action；target_agent_or_object 是唯一目标字段："
        "COMMENT/REACTION 必须复制 actions 中的 action/post UUID，绝不能填人物姓名或 agent ID；"
        "系统会把该 UUID 同时作为 parent_action_id。FOLLOW/MUTE 只能复制其他 agent/source ID；"
        "POST/SEARCH/TREND/REFRESH/IDLE 不得带 target；SEARCH 查询只放在 "
        "action_parameters.content。自然点名回应本身不等于平台 COMMENT；"
        "只有确实要向一个可见 action/post 写入公开回复才是 COMMENT。“刷新认知”不属于 "
        "REFRESH。不要求原文使用特定平台术语，但必须表达此刻真实执行。"
        "正例：“咱们现在就刷屏把这补贴削减逼停，让免费公交顶多试半年就回滚”。"
        "以下都不是已执行动作：“孙伟说咱们现在就刷屏，但我不同意”、"
        "“如果失败我就发帖”、“希望大家发帖”、“昨天已经发布”以及名词“发布会”。"
        if is_chinese
        else (
            "Classify from current factual evidence and the planned utterance, with no action "
            "quota or default type; never copy target-catalog, another character's text into "
            "content or realization_phrase, and never return a meaningless single character. "
            "The target catalog is not an eligibility source. A non-IDLE action may be selected "
            "only when its Opportunity Snapshot entry has both available and grounded set to "
            "true. Targeted actions may copy only IDs in the intersection of the snapshot's "
            "eligible_target_ids and the prior-round catalog. POST/COMMENT/SEARCH content must be "
            "concrete text that the later speech includes "
            "verbatim. REACTION/FOLLOW/MUTE/TREND/REFRESH require null content and a "
            "realization_phrase that the later speech includes verbatim. COMMENT/REACTION may "
            "target only a prior-round visible listed post/action; FOLLOW/MUTE may target only "
            "another agent/source. target_agent_or_object is the only target field. For "
            "COMMENT/REACTION, target_agent_or_object must copy an action/post UUID from actions, "
            "never a person name or agent ID; that UUID also becomes parent_action_id. "
            "POST/SEARCH/TREND/REFRESH/IDLE require a null target; a SEARCH query belongs only "
            "in action_parameters.content. A natural name-cited reply in speech "
            "is not, by itself, a platform COMMENT; COMMENT requires actually writing a public "
            "reply to one visible action/post. \"refresh my understanding\" is not "
            "REFRESH. The utterance need not use any special platform phrase, but it must express "
            "an action performed now. Positive example: \"Let us post everywhere now to stop "
            "these subsidy cuts\". These are not performed actions: \"Sun says we should post "
            "everywhere now, but I disagree\", \"If this fails I will post\", \"I hope everyone "
            "posts\", \"We published it yesterday\", and the noun phrase \"the product launch\"."
        )
    )
    reaction_contract = (
        "REACTION 的 reaction 只能是 LIKE、LOVE、LAUGH、WOW、SAD、ANGRY、SUPPORT、"
        "OPPOSE 之一。"
        if is_chinese
        else (
            "REACTION reaction must be exactly one of LIKE, LOVE, LAUGH, WOW, SAD, "
            "ANGRY, SUPPORT, or OPPOSE."
        )
    )
    idle_code_contract = (
        "模型选择 IDLE 时，idle_reason_code 必须且只能是 IDLE_NO_ACTION_NEEDED、"
        "IDLE_INSUFFICIENT_EVIDENCE、IDLE_WAITING_FOR_NEW_INFORMATION、"
        "IDLE_CONSTRAINT_BLOCKED、IDLE_STRATEGIC_HOLD 之一。"
        if is_chinese
        else (
            "When the model selects IDLE, idle_reason_code must be exactly one of "
            "IDLE_NO_ACTION_NEEDED, IDLE_INSUFFICIENT_EVIDENCE, "
            "IDLE_WAITING_FOR_NEW_INFORMATION, IDLE_CONSTRAINT_BLOCKED, or "
            "IDLE_STRATEGIC_HOLD."
        )
    )
    affordance_guidance = (
        "Opportunity Snapshot 是本轮唯一资格来源，只描述截至上一轮的可重放事实，不是动作命令"
        "或待覆盖清单。candidate_actions 必须与严格 JSON 模板一致：IDLE 在首位，随后按快照顺序"
        "列出每个 available 和 grounded 同时为 true 的动作。available 不代表必须选择。目标和 "
        "REACTION 参数必须来自快照"
        "中的完整临时允许列表。SEARCH 查询不得与当前 corpus_revision 的既有指纹重复；TREND、"
        "REFRESH 只服从各自 reason_codes。IDLE 始终合法；IDLE_WAITING_FOR_NEW_INFORMATION 只"
        "解释克制，不开放任何动作。allowed_rule_ids 只含本角色合法的 "
        "allow_when_preconditions_met 规则；effect_only 不在其中、也不是权限，但可附着于社会层"
        "合法动作。域意图必须逐字"
        "复制 schema hash、state revision 和 rule ID；无域意图时省略整组。若快照不可用，只能"
        "选择 IDLE。"
        if is_chinese
        else (
            "The Opportunity Snapshot is the only eligibility source for this turn. It describes "
            "replayable facts through the prior round; it is not a command or coverage checklist. "
            "candidate_actions must match the strict JSON template: IDLE first, followed in "
            "snapshot order by every action whose entry has both available and grounded set to "
            "true. Availability "
            "never requires selection. Targets and REACTION parameters must come from the full "
            "ephemeral snapshot allowlists. A SEARCH query must not repeat a fingerprint for the "
            "current corpus_revision; TREND and REFRESH follow only their reason_codes. IDLE is "
            "always legal; IDLE_WAITING_FOR_NEW_INFORMATION only explains restraint and opens no "
            "action. allowed_rule_ids contains only actor-legal "
            "allow_when_preconditions_met rules; effect_only is not permission and is absent from "
            "that list, but may attach to an otherwise socially legal action. Copy the schema "
            "hash, state "
            "revision, and rule ID exactly; omit the whole group without domain intent. If the "
            "snapshot is unavailable, select only IDLE."
        )
    )
    if opportunity_snapshot is None:
        snapshot_payload: dict[str, object] = {
            "status": "unavailable",
            "failure_code": "OPPORTUNITY_SNAPSHOT_UNAVAILABLE",
            "allowed_actions": ["IDLE"],
        }
        advertised_actions = ["IDLE"]
    else:
        snapshot_payload = opportunity_snapshot_to_prompt_payload_v1(
            opportunity_snapshot
        )
        advertised_actions = [
            action_type
            for action_type, opportunity in opportunity_snapshot.actions.items()
            if opportunity["available"] and opportunity["grounded"]
        ]
    serialized_snapshot = json.dumps(
        snapshot_payload,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    affordance_section = format_untrusted_text_block(
        "机会快照" if is_chinese else "Opportunity snapshot",
        serialized_snapshot,
        max_chars=max(12_000, len(serialized_snapshot) * 2 + 1),
    )
    replan = ""
    if replan_reason:
        replan = (
            f"\n重规划触发：{replan_reason}\n改变目标推进策略或表达；仍可选择 IDLE，"
            "但不得重复上一轮措辞，也不得被迫制造动作。"
            if is_chinese
            else (
                f"\nReplan trigger: {replan_reason}\nChange the goal-progress strategy or "
                "wording. IDLE remains valid; do not repeat the prior utterance or fabricate "
                "an action."
            )
        )
    advertised_actions_json = json.dumps(
        advertised_actions,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    domain_guidance = _domain_world_decision_prompt_v1(
        domain_world_context,
        language=language,
    )
    schema = (
        '{"current_goal":"...","goal_progress":"...",'
        '"recalled_memory_refs":[],"observed_world_changes":[],"unresolved_questions":[],'
        f'"candidate_actions":{advertised_actions_json},'
        '"selected_action":"...","action_parameters":{"content":"... or null",'
        '"realization_phrase":"... or null","reaction":"... or null"},'
        '"target_agent_or_object":null,"expected_effect":"...","constraints":[],'
        '"decision_basis":[],"idle_reason":"... or null",'
        '"idle_reason_code":"IDLE_NO_ACTION_NEEDED or null","emotion":"...",'
        '"diverge":"... or null"}'
    )
    target_schema_note = (
        "需要目标的动作把 null 替换为且仅替换为一个目录对象："
        '{"kind":"action|post|agent|source","id":"catalog ID"}。'
        "SEARCH 无目标；查询只写入 action_parameters.content。"
        if is_chinese
        else (
            "For a target-required action, replace null with exactly one catalog object: "
            '{"kind":"action|post|agent|source","id":"catalog ID"}. '
            "SEARCH is targetless; put its query only in action_parameters.content."
        )
    )
    if domain_guidance:
        strict_return_contract = (
            "返回严格 JSON，并精确包含下列 mandatory public audit fields。唯一允许的"
            "可选例外是上方 active guidance 所述的 action_parameters.domain_world_v1；"
            "无 grounded domain intent 时必须省略整个键"
            if is_chinese
            else (
                "Return strict JSON with exactly the mandatory public audit fields below. "
                "The sole optional exception is action_parameters.domain_world_v1 exactly as "
                "described in the active guidance above; omit that entire key when there is no "
                "grounded domain intent"
            )
        )
    else:
        strict_return_contract = (
            "返回严格 JSON，并精确包含下列 public audit fields"
            if is_chinese
            else "Return strict JSON with exactly these public audit fields"
        )
    rendered_affordances = f"{affordance_section}\n\n" if affordance_section else ""
    rendered_domain = f"{domain_guidance}\n\n" if domain_guidance else ""
    rendered_context = str(context or "")
    if prior_transition_context:
        rendered_context = rendered_context.replace(prior_transition_context, "").strip()
    return (
        f"{heading}\n{constraints}\n{action_guidance}\n{reaction_contract}\n"
        f"{idle_code_contract}\n"
        f"{affordance_guidance}{replan}\n\n"
        f"Character: {agent_name}\nFallback goal: {fallback_goal}\n\n"
        f"Prior verified transition:\n{prior_transition_context or '(none)'}\n\n"
        f"{rendered_affordances}"
        f"{rendered_domain}"
        f"Available action targets (copy IDs exactly when a target is required):\n"
        f"{action_target_catalog}\n\n"
        f"Character and world context:\n{rendered_context}\n\n"
        f"{strict_return_contract} (emotion/diverge are "
        f"companion metadata, not private reasoning):\n{schema}\n{target_schema_note}"
    )


def _append_decision_to_speech_prompt(
    prompt: str,
    decision: dict[str, Any],
    *,
    language: str,
) -> str:
    """Bind natural speech to the already-selected auditable decision."""
    public_decision = {
        key: decision.get(key)
        for key in (
            "current_goal",
            "goal_progress",
            "observed_world_changes",
            "selected_action",
            "action_parameters",
            "target_agent_or_object",
            "expected_effect",
            "constraints",
            "decision_basis",
            "idle_reason",
            "idle_reason_code",
            "unresolved_questions",
            "diverge",
        )
    }
    payload = json.dumps(public_decision, ensure_ascii=False, sort_keys=True)
    if _is_chinese_language(language):
        instruction = (
            "以下 Decision Envelope 已经确定。以角色第一人称自然发言推进同一目标。"
            "如果 selected_action 是 POST/COMMENT/SEARCH，发言必须逐字包含 "
            "action_parameters.content；其他非 IDLE 动作必须逐字包含 "
            "action_parameters.realization_phrase；"
            "如果无法自然且真实地落实，不得暗中改成另一动作。不要复述 JSON，也不要"
            "输出动作标签或思维链。如果 diverge 非空，发言必须逐字包含该片段；否则该"
            "分歧信号会被丢弃。"
        )
    else:
        instruction = (
            "The Decision Envelope below is already fixed. Speak naturally in first person and "
            "advance the same goal. For POST/COMMENT/SEARCH, the speech must contain "
            "action_parameters.content verbatim; for every other non-IDLE action, it must contain "
            "action_parameters.realization_phrase verbatim. If it cannot be realized truthfully, "
            "do not silently substitute another action. Do not repeat the JSON, action labels, "
            "or any chain-of-thought. If diverge is non-null, the speech must include that exact "
            "fragment; otherwise the divergence signal will be discarded."
        )
    return f"{prompt}\n\n{instruction}\nDecision Envelope:\n{payload}"


def _bind_authoritative_goal_progress(
    decision: dict[str, Any],
    prior_transition: object,
) -> dict[str, Any]:
    """Bind progress only from a durable-derived verified post-action transition."""

    if not isinstance(prior_transition, Mapping):
        return decision
    if str(prior_transition.get("transition_status") or "").lower() != "verified":
        return decision
    if (
        str(prior_transition.get("transition_semantics") or "").lower()
        != "post_action_v1"
    ):
        return decision
    if (
        str(prior_transition.get("transition_origin") or "").lower()
        != "derived_from_durable_actions"
    ):
        return decision
    progress_delta = str(prior_transition.get("goal_progress_delta") or "").strip()
    if not progress_delta:
        return decision
    bound = dict(decision)
    bound["goal_progress"] = progress_delta[:500]
    return bound


def _decision_payload_with_legacy_compat(
    payload: object,
    *,
    fallback_goal: str,
) -> object:
    """Accept former structured outputs only as safe pre-speech decisions.

    The historical agent-message schema carried ``content``/``emotion``/``diverge``
    but no action.  It remains a valid, explicitly IDLE decision so older provider
    fallbacks do not make otherwise usable emotion metadata unavailable.  Speech is
    still generated separately and no action is inferred from the legacy content.
    """
    if not isinstance(payload, dict) or "selected_action" in payload:
        return payload
    legacy_action = payload.get("action")
    if not isinstance(legacy_action, dict):
        if not any(key in payload for key in ("content", "emotion", "diverge")):
            return payload
        return {
            "current_goal": fallback_goal,
            "goal_progress": "not_yet_observed",
            "recalled_memory_refs": [],
            "observed_world_changes": [],
            "unresolved_questions": [],
            "candidate_actions": ["IDLE"],
            "selected_action": "IDLE",
            "action_parameters": {},
            "target_agent_or_object": None,
            "expected_effect": "No external effect was selected",
            "constraints": ["Do not infer an action from legacy speech content"],
            "decision_basis": ["Legacy structured message selected no action"],
            "idle_reason": "Legacy structured message selected no external action",
            "idle_reason_code": "IDLE_NO_ACTION_NEEDED",
        }
    selected = str(
        legacy_action.get("type") or legacy_action.get("action_type") or "IDLE"
    ).upper().strip()
    if selected not in {
        "IDLE",
        "POST",
        "COMMENT",
        "REACTION",
        "FOLLOW",
        "MUTE",
        "SEARCH",
        "TREND",
        "REFRESH",
    }:
        selected = "IDLE"
    parameters: dict[str, Any] = {}
    for key in (
        "content",
        "realization_phrase",
        "target",
        "payload",
        "parent_action_id",
    ):
        value = legacy_action.get(key)
        if value not in (None, "", {}):
            parameters[key] = value
    return {
        "current_goal": fallback_goal,
        "goal_progress": "not_yet_observed",
        "recalled_memory_refs": [],
        "observed_world_changes": [],
        "unresolved_questions": [],
        "candidate_actions": list(dict.fromkeys(["IDLE", selected])),
        "selected_action": selected,
        "action_parameters": parameters,
        "target_agent_or_object": legacy_action.get("target"),
        "expected_effect": "Advance the current goal with an auditable action",
        "constraints": ["Do not claim an unverified result"],
        "decision_basis": ["Pre-speech structured decision output"],
        "idle_reason": (
            "No concrete external action was selected" if selected == "IDLE" else None
        ),
        "idle_reason_code": (
            "IDLE_NO_ACTION_NEEDED" if selected == "IDLE" else None
        ),
    }


def _format_document_reference_context(
    world_context: object,
    language: str = "Chinese",
) -> str:
    if not isinstance(world_context, dict) or not world_context:
        return ""
    heading = (
        "文档参考资料；仅作为上传文档提取出的场景资料使用。"
        if _is_chinese_language(language)
        else "Document reference material extracted from the uploaded seed document."
    )
    payload = json.dumps(world_context, ensure_ascii=False, sort_keys=True)
    return f"{heading}\n{payload}"


async def _gather_agent_messages(
    engine,
    scenario_id,
    branch_id,
    round_id,
    round_num,
    agents,
    setting_bg,
    topic,
    *,
    intervention_text: str | None = None,
    intervention_metadata: dict[str, Any] | None = None,
    push=None,
    blackboard: Blackboard | None = None,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    viz_mapper=None,
    agent_prev_emotions: dict[str, str] | None = None,
    web_context_block: str = "",
    document_reference_context: str = "",
    scenario_user_id: str = "",
    native_search_domains: list[str] | None = None,
    progress_total: int | None = None,
    progress_counter: list[int] | None = None,
    progress_lock: asyncio.Lock | None = None,
    relationship_agents: list[dict[str, Any]] | None = None,
    opportunity_authority_out: dict[str, object] | None = None,
    runtime_lease: RuntimeLockLease | None = None,
) -> list[dict]:
    """Gather messages from all agents for this round.

    Each agent pushes its result immediately (not batched):
    - agent_speak_start: Agent begins thinking (shows indicator)
    - agent_speak: Final parsed message (content + emotion + diverge)

    When blackboard is provided, agents read shared briefing instead of
    raw DB messages. Agent utterances are persisted before their public
    broadcast so refresh/resync cannot lose a message that the browser saw.
    """
    semaphore = asyncio.Semaphore(get_runtime_parallelism_limit())
    native_citation_lock = asyncio.Lock()
    (
        generation_request_timeout,
        metadata_request_timeout,
        agent_turn_total_timeout,
    ) = _agent_turn_timeouts()
    turn_progress_total = len(agents) if progress_total is None else progress_total
    turn_progress_counter = progress_counter if progress_counter is not None else [0]
    turn_progress_lock = progress_lock if progress_lock is not None else asyncio.Lock()

    # Build shared context: prefer Blackboard briefing, fall back to DB
    if blackboard is not None:
        briefing = blackboard.get_shared_briefing()
        shared_text = format_briefing_for_context(briefing, language=language)
    else:
        shared_text = ""
    try:
        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            scenario_question = str(getattr(scenario, "question", "") or "").strip()
    except Exception:
        logger.debug("Failed to load scenario question for agent turn prompt", exc_info=True)
        scenario_question = ""
    effective_topic = str(topic or scenario_question or "").strip()
    from app.services.social_world import (
        reduce_social_world_state,
        render_social_world_context,
    )

    # Every turn in this batch sees the same prior-round replay state. Building
    # it before concurrent tasks prevents scheduler order from leaking another
    # agent's same-round action into Pass-1.
    social_cutoff_round = max(0, round_num - 1)
    agent_ids = [
        str(agent.get("id") or "")
        for agent in agents
        if str(agent.get("id") or "").strip()
    ]
    snapshot_actor_ids = [
        str(agent.get("id") or "")
        for agent in (relationship_agents if relationship_agents is not None else agents)
        if str(agent.get("id") or "").strip()
    ]
    social_world_state = None
    try:
        with Session(engine) as session:
            social_world_state = reduce_social_world_state(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                cutoff_round=social_cutoff_round,
            )
        social_world_contexts = {
            agent_id: render_social_world_context(
                social_world_state,
                agent_id=agent_id,
                language=language,
            )
            for agent_id in agent_ids
        }
    except Exception:
        logger.warning(
            "Social world context unavailable for scenario=%s branch=%s",
            scenario_id,
            branch_id,
            exc_info=True,
        )
        unavailable_context = json.dumps(
            {
                "as_of_round": social_cutoff_round,
                "failure_code": "SOCIAL_WORLD_UNAVAILABLE",
                "status": "unavailable",
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        social_world_contexts = dict.fromkeys(agent_ids, unavailable_context)
    action_target_catalog_payload = _load_action_target_catalog_payload(
        engine,
        scenario_id,
        branch_id,
        cutoff_round=social_cutoff_round,
    )
    action_target_catalogs = _build_action_target_catalogs(
        engine,
        scenario_id,
        branch_id,
        agent_ids=snapshot_actor_ids,
        cutoff_round=social_cutoff_round,
        payload=action_target_catalog_payload,
    )
    from app.services.agent_runtime import (
        _load_domain_decision_context_v1,
        _load_prior_opportunity_receipts,
        load_prior_agent_decision,
        load_prior_agent_transition,
        render_agent_transition_context,
    )

    # Load the previous durable transition and same-agent utterance before any
    # concurrent turn starts. This prevents same-round scheduler leakage.
    prior_transitions: dict[str, dict[str, Any]] = {}
    prior_transition_contexts: dict[str, str] = {}
    prior_decisions: dict[str, dict[str, Any]] = {}
    for agent_id in agent_ids:
        prior = load_prior_agent_transition(
            engine,
            scenario_id,
            branch_id,
            agent_id,
            before_round=round_num,
        )
        if prior:
            prior_transitions[agent_id] = prior
            prior_transition_contexts[agent_id] = render_agent_transition_context(
                prior,
                language,
            )
        prior_decision = load_prior_agent_decision(
            engine,
            scenario_id,
            branch_id,
            agent_id,
            before_round=round_num,
        )
        if prior_decision.get("decision_status") == "verified":
            prior_decisions[agent_id] = prior_decision
    projected_target_catalogs = {
        actor_id: _project_action_target_catalog(
            action_target_catalog_payload,
            agent_id=actor_id,
        )
        for actor_id in snapshot_actor_ids
    }
    prior_receipts = await asyncio.to_thread(
        _load_prior_opportunity_receipts,
        engine,
        scenario_id,
        branch_id,
        snapshot_actor_ids,
        before_round=round_num,
    )
    domain_world_context: Mapping[str, object] | None = None
    try:
        domain_world_context = await asyncio.to_thread(
            _load_domain_decision_context_v1,
            engine,
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=round_num,
        )
    except Exception:
        logger.exception("Domain opportunity context unavailable for this round")
    domain_opportunities = (
        domain_world_context.get("opportunity_evaluation")
        if domain_world_context is not None
        else None
    )
    opportunity_snapshots_by_actor: dict[
        str, OpportunitySnapshotV1 | None
    ] = dict.fromkeys(snapshot_actor_ids, None)
    if social_world_state is not None:
        try:
            opportunity_snapshots_by_actor.update(
                await asyncio.to_thread(
                    derive_opportunity_snapshots_v1,
                    social_state=social_world_state,
                    target_catalogs_by_actor=projected_target_catalogs,
                    prior_receipts_by_actor=prior_receipts,
                    domain_opportunities=domain_opportunities,
                )
            )
        except Exception:
            logger.exception("Opportunity snapshot derivation failed closed")
    if opportunity_authority_out is not None:
        opportunity_authority_out["opportunity_snapshots_by_actor"] = (
            opportunity_snapshots_by_actor
        )
        opportunity_authority_out["domain_world_context"] = domain_world_context
    prior_utterances: dict[str, str] = {}
    if agent_ids and round_num > 1:
        with Session(engine) as session:
            try:
                visible_rounds = select_branch_rounds(
                    session,
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    requested_cutoff=round_num - 1,
                ).rounds
                visible_round_ids = [round_row.id for round_row in visible_rounds]
            except Exception:
                visible_round_ids = []
            rows = session.exec(
                select(AgentMessage, Round.round_number)
                .join(Round, AgentMessage.round_id == Round.id)
                .where(
                    (
                        Round.id.in_(visible_round_ids)
                        if visible_round_ids
                        else Round.branch_id == branch_id
                    ),
                    Round.round_number < round_num,
                    AgentMessage.agent_id.in_(agent_ids),
                )
                .order_by(Round.round_number.desc(), AgentMessage.id.desc())
            ).all()
        for message, _prior_round in rows:
            prior_utterances.setdefault(message.agent_id, message.content)

    empty_shared_briefings = {"(尚无共享信息)", "(no shared briefing yet)"}
    has_usable_shared_briefing = bool(shared_text) and shared_text not in empty_shared_briefings

    # Only hit the DB when the blackboard cannot provide usable context.
    recent_msgs = None
    if not has_usable_shared_briefing:
        recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=2)
    emotion_state = agent_prev_emotions if agent_prev_emotions is not None else {}
    worldline_context = _build_worldline_context(engine, branch_id, language)
    memory_population = relationship_agents if relationship_agents is not None else agents
    memory_agent_name_counts: dict[str, int] = {}
    for candidate in memory_population:
        candidate_name = str(candidate.get("name") or "").strip()
        if candidate_name:
            memory_agent_name_counts[candidate_name] = (
                memory_agent_name_counts.get(candidate_name, 0) + 1
            )
    allowed_memory_rounds_by_agent: dict[str, dict[str, int]] = {}
    for candidate in agents:
        if candidate.get("tier", "") not in ("CORE", "IMPORTANT"):
            continue
        candidate_id = str(candidate.get("id") or "").strip()
        if not candidate_id:
            continue
        allowed_memory_rounds_by_agent[candidate_id] = _branch_memory_round_limits(
            engine,
            branch_id,
            current_round=round_num,
            agent_id=candidate_id,
        )
    relationship_contexts: dict[str, str] = {}
    if _FACTIONS_AVAILABLE and settings.FEATURE_FACTIONS and round_num > 1:
        try:
            relationship_contexts = _factions_relationship_contexts(
                engine,
                scenario_id,
                branch_id,
                round_num,
                relationship_agents if relationship_agents is not None else agents,
                language=language,
            )
        except Exception:
            logger.debug(
                "Previous-round relationship context load failed for branch %s",
                branch_id,
                exc_info=True,
            )

    async def push_event(event: dict):
        """Push event if callback is available."""
        if push:
            await push(event)

    async def push_turn_progress() -> None:
        if turn_progress_total <= 0:
            return
        async with turn_progress_lock:
            turn_progress_counter[0] += 1
            completed = turn_progress_counter[0]
        await push_event(
            {
                "type": "turn_progress",
                "data": {
                    "branch_id": branch_id,
                    "round": round_num,
                    "completed": completed,
                    "total": turn_progress_total,
                },
            }
        )

    async def process_agent(agent: dict):
        async with semaphore:
            agent_tier = agent.get("tier", "")

            # L2 vector memory: retrieve relevant memories for CORE/IMPORTANT
            l2_memories = ""
            agent_id = str(agent.get("id") or "").strip()
            agent_name = str(agent.get("name") or "").strip()
            if agent_tier in ("CORE", "IMPORTANT") and agent_id:
                query = f"{effective_topic} {agent_name} {agent.get('role', '')}"
                l2_memories = retrieve_relevant_memories(
                    scenario_id,
                    query,
                    top_k=(_BLACKBOARD_OWN_MEMORY_TOP_K if has_usable_shared_briefing else 5),
                    allowed_branch_rounds=allowed_memory_rounds_by_agent.get(
                        agent_id,
                        {branch_id: max(0, round_num - 1)},
                    ),
                    agent_id=agent_id,
                    agent_name=agent_name,
                    allow_legacy_name_fallback=(
                        bool(agent_name) and memory_agent_name_counts.get(agent_name, 0) == 1
                    ),
                )

            relationship_context = relationship_contexts.get(str(agent.get("id") or ""), "")

            # Phase 4C: Cross-scenario hint from identity memories
            cross_hint = ""
            cross_memories: list[dict[str, Any]] = []
            identity_memory_status = "unavailable"
            memory_promotion_context = None
            memory_promotion_prompt_block = ""
            if (
                settings.FEATURE_AGENT_IDENTITY
                and agent.get("agent_identity_id")
                and agent_tier in ("CORE", "IMPORTANT", "CROWD")
                and scenario_user_id
            ):
                try:
                    # H5 fix: cancel guard around cross-scenario memory to_thread.
                    _check_cancelled(scenario_id)
                    from app.services.vector_store import retrieve_identity_memories

                    cross_memories = await asyncio.to_thread(
                        retrieve_identity_memories,
                        user_id=scenario_user_id,
                        identity_id=agent["agent_identity_id"],
                        query_text=effective_topic,
                        n_results=3,
                    )
                    _check_cancelled(scenario_id)
                    identity_memory_status = "verified" if cross_memories else "empty"
                    if cross_memories:
                        cross_hint = "\n".join(
                            f"- {m.get('summary', '')}" for m in cross_memories if m.get("summary")
                        )
                except SimulationCancelled:
                    # H5 fix: cancel must not be swallowed by the non-fatal guard.
                    raise
                except Exception:
                    identity_memory_status = "unavailable"
                    logger.debug(
                        "cross-scenario hint retrieval failed for agent %s (non-fatal)",
                        agent.get("name", "?"),
                        exc_info=True,
                    )
            if (
                settings.FEATURE_AGENT_IDENTITY
                and settings.FEATURE_MEMORY_PROMOTION
                and agent.get("agent_identity_id")
                and scenario_user_id
            ):
                memory_promotion_context = await _recall_memory_promotion_context_v1(
                    engine,
                    scenario_id=scenario_id,
                    agent_id=agent_id,
                    query_text=effective_topic,
                )
                from app.services.memory import format_recall_context_for_prompt_v1

                memory_promotion_prompt_block = format_recall_context_for_prompt_v1(
                    memory_promotion_context
                )

            # Build context: Blackboard shared briefing + DB fallback
            if has_usable_shared_briefing:
                agent_briefing = shared_text
                ctx = build_agent_context(
                    agent=agent,
                    setting_background=setting_bg,
                    current_topic=effective_topic,
                    recent_messages="",
                    retrieved_memories=l2_memories,
                    tier=agent_tier,
                    shared_briefing=agent_briefing,
                    intervention_text=intervention_text or "",
                    intervention_metadata=intervention_metadata,
                    language=language,
                    web_context_block=web_context_block,
                    worldline_context=worldline_context,
                    document_reference_context=document_reference_context,
                    include_json_format=False,
                    cross_scenario_hint=cross_hint,
                    relationship_context=relationship_context,
                    social_world_context=social_world_contexts.get(agent_id, ""),
                )
            else:
                # Fallback: format DB messages per-tier (first round or no blackboard)
                assert recent_msgs is not None
                recent_text = format_messages_for_context(recent_msgs, tier=agent_tier)
                ctx = build_agent_context(
                    agent=agent,
                    setting_background=setting_bg,
                    current_topic=effective_topic,
                    recent_messages=recent_text,
                    retrieved_memories=l2_memories,
                    tier=agent_tier,
                    intervention_text=intervention_text or "",
                    intervention_metadata=intervention_metadata,
                    language=language,
                    web_context_block=web_context_block,
                    worldline_context=worldline_context,
                    document_reference_context=document_reference_context,
                    include_json_format=False,
                    cross_scenario_hint=cross_hint,
                    relationship_context=relationship_context,
                    social_world_context=social_world_contexts.get(agent_id, ""),
                )

            ctx = _append_agent_debate_coherence_guidance(ctx, agent_tier, language)
            prior_transition_context = prior_transition_contexts.get(agent_id, "")

            # Choose reasoning effort based on tier
            effort = "low" if agent.get("tier") == "CROWD" else "medium"

            # Notify frontend: agent starts thinking
            await push_event(
                {
                    "type": "agent_speak_start",
                    "data": {
                        "agent": agent["name"],
                        "agent_id": agent["id"],
                        "branch": branch_id,
                        "round": round_num,
                    },
                }
            )

            raw_text = ""
            clean_raw_text: str | None = None
            extracted_action: object = None
            decision_envelope: dict[str, Any] | None = None
            turn_failure_code: str | None = None
            metadata_failure_code: str | None = None
            try:
                _overrides = llm_overrides or {}
                base_temperature = _coerce_turn_temperature(
                    _overrides.get("temperature"),
                    0.8,
                )

                async def persist_native_citations_if_any() -> None:
                    if not native_search_domains:
                        return
                    citations = get_last_native_citations()
                    if not citations:
                        return
                    try:
                        async with native_citation_lock:
                            await asyncio.to_thread(
                                _persist_native_citations,
                                engine,
                                scenario_id,
                                citations,
                            )
                    except Exception:
                        logger.debug(
                            "native citation persistence failed for scenario %s",
                            scenario_id,
                            exc_info=True,
                        )

                turn_deadline = _agent_turn_monotonic() + agent_turn_total_timeout
                prior_goal = str(
                    prior_decisions.get(agent_id, {}).get("current_goal") or ""
                ).strip()
                fallback_goal = str(
                    prior_goal
                    or agent.get("current_goal")
                    or agent.get("goal")
                    or agent.get("role")
                    or effective_topic
                    or "Advance the scenario"
                ).strip()
                allowed_memory_refs = [
                    str(item.get("memory_ref") or "").strip()
                    for item in cross_memories
                    if str(item.get("memory_ref") or "").strip()
                ]
                prior_transition = prior_transitions.get(agent_id, {})
                allowed_world_changes = [
                    str(item).strip()
                    for item in prior_transition.get("world_state_changes", [])
                    if str(item).strip()
                ]
                action_target_catalog = action_target_catalogs.get(
                    agent_id,
                    '{"agents":[],"actions":[]}',
                )
                projected_action_targets = projected_target_catalogs.get(
                    agent_id,
                    {"actions": [], "agents": []},
                )
                opportunity_snapshot = opportunity_snapshots_by_actor.get(agent_id)
                from app.services.agent_runtime import (
                    decision_to_action,
                    normalize_decision_envelope,
                    utterance_similarity,
                )

                async def request_decision(
                    *, replan_reason: str = ""
                ) -> tuple[dict[str, Any], dict[str, Any]]:
                    decision_prompt = _build_decision_envelope_prompt(
                        ctx,
                        agent_name=agent["name"],
                        fallback_goal=fallback_goal,
                        action_target_catalog=action_target_catalog,
                        opportunity_snapshot=opportunity_snapshot,
                        domain_world_context=domain_world_context,
                        prior_transition_context=prior_transition_context,
                        language=language,
                        replan_reason=replan_reason,
                    )
                    if memory_promotion_context is not None:
                        decision_prompt = (
                            f"{decision_prompt}\n\n{memory_promotion_prompt_block}"
                        )
                    _check_cancelled(scenario_id)
                    remaining = _agent_turn_remaining(turn_deadline)
                    with llm_request_scope(
                        **_llm_scope_kwargs(
                            _overrides,
                            purpose="scenario_turn_generation",
                        )
                    ):
                        raw_decision = await asyncio.wait_for(
                            llm_call_json(
                                decision_prompt,
                                reasoning_effort="low",
                                model=_overrides.get("model"),
                                api_key=_overrides.get("api_key"),
                                base_url=_overrides.get("base_url"),
                                temperature=0.2,
                                fallback_mode="agent_message",
                                timeout=min(metadata_request_timeout, remaining),
                            ),
                            timeout=remaining,
                        )
                    _check_cancelled(scenario_id)
                    companion = raw_decision if isinstance(raw_decision, dict) else {}
                    normalized_raw = _decision_payload_with_legacy_compat(
                        raw_decision,
                        fallback_goal=fallback_goal,
                    )
                    if memory_promotion_context is None:
                        normalized = normalize_decision_envelope(
                            normalized_raw,
                            agent_id=agent_id,
                            branch_id=branch_id,
                            round_number=round_num,
                            fallback_goal=fallback_goal,
                            allowed_memory_refs=allowed_memory_refs,
                            allowed_world_changes=allowed_world_changes,
                            allowed_action_target_ids=[
                                str(item.get("id") or "").strip()
                                for item in projected_action_targets.get("actions", [])
                                if str(item.get("id") or "").strip()
                            ],
                            allowed_agent_target_ids=[
                                str(item.get("id") or "").strip()
                                for item in projected_action_targets.get("agents", [])
                                if str(item.get("id") or "").strip()
                            ],
                            opportunity_snapshot=opportunity_snapshot,
                            domain_world_context=domain_world_context,
                            compatibility_mode="live",
                        )
                    else:
                        from app.services.agent_runtime import (
                            normalize_decision_with_memory_promotion_v1,
                        )

                        normalized = normalize_decision_with_memory_promotion_v1(
                            normalized_raw,
                            recall_context=memory_promotion_context,
                            legacy_allowed_memory_refs=allowed_memory_refs,
                            agent_id=agent_id,
                            branch_id=branch_id,
                            round_number=round_num,
                            fallback_goal=fallback_goal,
                            allowed_world_changes=allowed_world_changes,
                            allowed_action_target_ids=[
                                str(item.get("id") or "").strip()
                                for item in projected_action_targets.get("actions", [])
                                if str(item.get("id") or "").strip()
                            ],
                            allowed_agent_target_ids=[
                                str(item.get("id") or "").strip()
                                for item in projected_action_targets.get("agents", [])
                                if str(item.get("id") or "").strip()
                            ],
                            opportunity_snapshot=opportunity_snapshot,
                            domain_world_context=domain_world_context,
                            compatibility_mode="live",
                        )
                    normalized = _bind_authoritative_goal_progress(
                        normalized,
                        prior_transition,
                    )
                    raw_diverge_text = str(companion.get("diverge") or "").strip()
                    normalized["diverge"] = (
                        raw_diverge_text[:500]
                        if raw_diverge_text.casefold() not in {"", "null", "none"}
                        else None
                    )
                    if replan_reason:
                        normalized["replan_required"] = True
                        normalized["replan_reason"] = replan_reason
                    return companion, normalized

                decision_payload: dict[str, Any] = {}
                try:
                    decision_payload, decision_envelope = await request_decision()
                except SimulationCancelled:
                    raise
                except Exception as exc:
                    decision_failure_code = classify_llm_error_code(exc) or "LLM_FAILED"
                    logger.warning(
                        "Agent %s decision envelope failed: %s: %s",
                        agent["name"],
                        type(exc).__name__,
                        _scrub_sensitive_text(str(exc)),
                    )
                    if memory_promotion_context is None:
                        decision_envelope = normalize_decision_envelope(
                            None,
                            agent_id=agent_id,
                            branch_id=branch_id,
                            round_number=round_num,
                            fallback_goal=fallback_goal,
                            opportunity_snapshot=opportunity_snapshot,
                            domain_world_context=domain_world_context,
                            compatibility_mode="live",
                        )
                    else:
                        from app.services.agent_runtime import (
                            normalize_decision_with_memory_promotion_v1,
                        )

                        decision_envelope = normalize_decision_with_memory_promotion_v1(
                            None,
                            recall_context=memory_promotion_context,
                            legacy_allowed_memory_refs=allowed_memory_refs,
                            agent_id=agent_id,
                            branch_id=branch_id,
                            round_number=round_num,
                            fallback_goal=fallback_goal,
                            opportunity_snapshot=opportunity_snapshot,
                            domain_world_context=domain_world_context,
                            compatibility_mode="live",
                        )
                    decision_envelope["decision_status"] = "unavailable"
                    decision_envelope["failure_code"] = decision_failure_code
                    metadata_failure_code = decision_failure_code

                emotion = str(decision_payload.get("emotion") or "").strip()
                diverge = decision_envelope.get("diverge")
                if not emotion:
                    metadata_failure_code = metadata_failure_code or "LLM_INVALID_OUTPUT"
                    diverge = None
                if decision_envelope.get("decision_status") != "verified":
                    emotion = ""
                    diverge = None

                async def generate_bound_speech(
                    envelope: dict[str, Any],
                    *,
                    retry_prefix: bool = False,
                ) -> tuple[str | None, str | None]:
                    nonlocal raw_text
                    turn_prompt = _prepend_agent_turn_prompt_prefix(
                        ctx,
                        agent_name=agent["name"],
                        topic=effective_topic,
                        scenario_question=scenario_question,
                        branch_question=effective_topic,
                        worldline_context=worldline_context,
                        language=language,
                        retry=retry_prefix,
                    )
                    turn_prompt = _append_decision_to_speech_prompt(
                        turn_prompt,
                        envelope,
                        language=language,
                    )
                    _check_cancelled(scenario_id)
                    remaining = _agent_turn_remaining(turn_deadline)
                    with llm_request_scope(
                        **_llm_scope_kwargs(
                            _overrides,
                            purpose="scenario_turn_generation",
                        )
                    ):
                        raw_text = await asyncio.wait_for(
                            llm_call(
                                turn_prompt,
                                reasoning_effort=effort,
                                model=_overrides.get("model"),
                                api_key=_overrides.get("api_key"),
                                base_url=_overrides.get("base_url"),
                                temperature=(
                                    min(base_temperature, 0.6)
                                    if retry_prefix
                                    else base_temperature
                                ),
                                timeout=min(generation_request_timeout, remaining),
                                native_search_domains=native_search_domains,
                            ),
                            timeout=remaining,
                        )
                    _check_cancelled(scenario_id)
                    await persist_native_citations_if_any()
                    return validate_and_sanitize_turn(
                        raw_text,
                        agent["name"],
                        language,
                    )

                reject_reason: str | None = None
                for attempt in range(2):
                    clean_raw_text, reject_reason = await generate_bound_speech(
                        decision_envelope,
                        retry_prefix=attempt > 0,
                    )
                    if clean_raw_text is not None:
                        break
                    logger.warning(
                        "Rejected decision-bound agent turn agent=%s reason=%s attempt=%d",
                        agent["name"],
                        reject_reason,
                        attempt + 1,
                    )
                if clean_raw_text is None:
                    turn_failure_code = "LLM_INVALID_OUTPUT"
                    content = _silent_turn_placeholder(agent["name"], language)
                    emotion = "neutral"
                    diverge = None
                else:
                    previous_utterance = prior_utterances.get(agent_id, "")
                    similarity = utterance_similarity(previous_utterance, clean_raw_text)
                    repetition_failure_code: str | None = None
                    if previous_utterance and similarity >= 0.8:
                        replan_reason = (
                            f"adjacent_utterance_similarity={similarity:.3f}"
                        )
                        try:
                            replan_payload, replanned = await request_decision(
                                replan_reason=replan_reason
                            )
                            replanned_text, replanned_reject = await generate_bound_speech(
                                replanned,
                                retry_prefix=True,
                            )
                            if replanned_text is not None:
                                decision_payload = replan_payload
                                decision_envelope = replanned
                                clean_raw_text = replanned_text
                                emotion = str(
                                    replan_payload.get("emotion") or emotion
                                ).strip()
                                diverge = replanned.get("diverge")
                                replanned_similarity = utterance_similarity(
                                    previous_utterance,
                                    replanned_text,
                                )
                                if replanned_similarity >= 0.8:
                                    repetition_failure_code = "LLM_REPETITIVE_OUTPUT"
                            else:
                                repetition_failure_code = (
                                    replanned_reject or "LLM_INVALID_OUTPUT"
                                )
                        except SimulationCancelled:
                            raise
                        except Exception as exc:
                            repetition_failure_code = (
                                classify_llm_error_code(exc) or "LLM_FAILED"
                            )
                    if repetition_failure_code:
                        if memory_promotion_context is None:
                            unavailable_decision = normalize_decision_envelope(
                                None,
                                agent_id=agent_id,
                                branch_id=branch_id,
                                round_number=round_num,
                                fallback_goal=fallback_goal,
                                opportunity_snapshot=opportunity_snapshot,
                                domain_world_context=domain_world_context,
                                compatibility_mode="live",
                            )
                        else:
                            from app.services.agent_runtime import (
                                normalize_decision_with_memory_promotion_v1,
                            )

                            unavailable_decision = (
                                normalize_decision_with_memory_promotion_v1(
                                    None,
                                    recall_context=memory_promotion_context,
                                    legacy_allowed_memory_refs=allowed_memory_refs,
                                    agent_id=agent_id,
                                    branch_id=branch_id,
                                    round_number=round_num,
                                    fallback_goal=fallback_goal,
                                    opportunity_snapshot=opportunity_snapshot,
                                    domain_world_context=domain_world_context,
                                    compatibility_mode="live",
                                )
                            )
                        unavailable_decision.update({
                            "decision_status": "unavailable",
                            "failure_code": repetition_failure_code,
                            "replan_required": True,
                            "replan_reason": (
                                f"adjacent_utterance_similarity={similarity:.3f}"
                            ),
                            "replan_failure_code": repetition_failure_code,
                        })
                        decision_envelope = unavailable_decision
                        clean_raw_text = _repetitive_turn_placeholder(
                            agent["name"],
                            language,
                            round_num,
                        )
                        metadata_failure_code = repetition_failure_code
                        emotion = "neutral"
                        diverge = None
                    content = clean_raw_text
                    extracted_action = decision_to_action(decision_envelope, content)
                    diverge_text = str(diverge or "").strip()
                    diverge = (
                        diverge_text
                        if diverge_text and diverge_text in content
                        else None
                    )
            except SimulationCancelled:
                raise
            except Exception as exc:
                failure_code = classify_llm_error_code(exc) or "LLM_FAILED"
                logger.warning(
                    "Agent %s failed: %s: %s",
                    agent["name"],
                    type(exc).__name__,
                    _scrub_sensitive_text(str(exc)),
                )
                if clean_raw_text is None:
                    # Pass-1 never produced validated speech. Any provider or
                    # response-shape failure is generation-fatal for this turn.
                    turn_failure_code = failure_code
                    content = _silent_turn_placeholder(agent["name"], language)
                    emotion = "neutral"
                else:
                    # Pass-2 metadata is optional. Preserve the validated raw
                    # speech and disclose a metadata-only degradation instead
                    # of discarding a real Agent turn.
                    metadata_failure_code = failure_code
                    content = clean_raw_text
                    emotion = ""
                diverge = None
                extracted_action = {
                    "action_type": "IDLE",
                    "status": "unavailable",
                    "failure_code": failure_code,
                }

            emotion = str(emotion or "").strip()
            previous_emotion = str(
                emotion_state.get(agent["id"], agent.get("emotion") or "neutral")
            )
            if metadata_failure_code is None:
                emotion = emotion or "neutral"
                agent["emotion"] = emotion
                emotion_state[agent["id"]] = emotion

            msg = {
                "agent_id": agent["id"],
                "agent_name": agent["name"],
                "content": content,
                "emotion": emotion,
                "diverge": diverge,
                "_action": extracted_action,
                "_decision": decision_envelope or {
                    "current_goal": str(agent.get("role") or effective_topic),
                    "goal_progress": "unavailable",
                    "recalled_memory_refs": [],
                    "observed_world_changes": [],
                    "candidate_actions": ["IDLE"],
                    "selected_action": "IDLE",
                    "action_parameters": {},
                    "target_agent_or_object": None,
                    "expected_effect": "No effect because the decision was unavailable",
                    "constraints": [],
                    "decision_basis": [],
                    "idle_reason": "Decision generation was unavailable",
                    "idle_reason_code": "IDLE_DECISION_UNAVAILABLE",
                    "decision_status": "unavailable",
                    "failure_code": str(
                        turn_failure_code or metadata_failure_code or "DECISION_UNAVAILABLE"
                    ),
                },
                "_context_receipt": {
                    "recent_messages_status": (
                        "unavailable"
                        if has_usable_shared_briefing
                        else "verified"
                        if recent_msgs
                        else "empty"
                    ),
                    "recent_message_ids": (
                        []
                        if has_usable_shared_briefing
                        else [
                            str(item.get("message_id") or "")
                            for item in (recent_msgs or [])
                            if str(item.get("message_id") or "").strip()
                        ][:12]
                    ),
                    "identity_memory_status": identity_memory_status,
                    "identity_memory_refs": [
                        str(item.get("memory_ref") or "")
                        for item in cross_memories
                        if str(item.get("memory_ref") or "").strip()
                    ][:3],
                    "identity_memory_source_scenario_ids": [
                        str(item.get("scenario_id") or "")
                        for item in cross_memories
                        if str(item.get("scenario_id") or "").strip()
                    ][:3],
                },
            }
            if memory_promotion_context is not None:
                msg["_memory_promotion_context"] = memory_promotion_context
                msg["_memory_promotion_legacy_refs"] = tuple(allowed_memory_refs)
            if turn_failure_code:
                msg["_turn_failure_code"] = turn_failure_code
            if metadata_failure_code:
                msg["_metadata_failure_code"] = metadata_failure_code
                msg.update(public_emotion_metadata(msg))

            if turn_failure_code:
                return msg

            _check_cancelled(scenario_id)
            saved_message_ids = (
                _save_messages(
                    engine,
                    [
                        {
                            "round_id": round_id,
                            "agent_id": msg["agent_id"],
                            "content": msg["content"],
                            "emotion": (
                                encode_metadata_unavailable_emotion(metadata_failure_code)
                                if metadata_failure_code
                                else msg["emotion"]
                            ),
                            "diverge": msg.get("diverge"),
                            "scenario_id": scenario_id,
                            "branch_id": branch_id,
                            "round_number": round_num,
                            "action": msg.get("_action"),
                            "decision_envelope": msg.get("_decision") or {},
                            "fallback_goal": fallback_goal,
                            "context_receipt": msg.get("_context_receipt") or {},
                            "idempotency_key": f"turn:{round_id}:{msg['agent_id']}",
                            **(
                                {
                                    "_memory_promotion_context": msg[
                                        "_memory_promotion_context"
                                    ],
                                    "_memory_promotion_legacy_refs": msg[
                                        "_memory_promotion_legacy_refs"
                                    ],
                                }
                                if "_memory_promotion_context" in msg
                                else {}
                            ),
                        }
                    ],
                    opportunity_snapshots_by_actor=opportunity_snapshots_by_actor,
                    domain_world_context=domain_world_context,
                    compatibility_mode="live",
                    **({"runtime_lease": runtime_lease} if runtime_lease else {}),
                )
                or []
            )
            if saved_message_ids:
                msg["id"] = saved_message_ids[0]
            _check_cancelled(scenario_id)
            action_receipt = _get_action_receipt(
                engine, scenario_id, f"turn:{round_id}:{msg['agent_id']}"
            )
            if action_receipt:
                msg["_action_receipt"] = action_receipt
                await push_event({"type": "action_committed", "data": action_receipt})
                _check_cancelled(scenario_id)

            # Push final parsed message only after it is durable.
            event_data = {
                "agent": agent["name"],
                "agent_id": agent["id"],
                "message": content,
                "emotion": emotion,
                "branch": branch_id,
                "round": round_num,
            }
            if metadata_failure_code:
                event_data.update(public_emotion_metadata(msg))
            await push_event({"type": "agent_speak", "data": event_data})
            _check_cancelled(scenario_id)
            await push_turn_progress()

            # V2: Broadcast viz:bubble_show when visualization is active
            if viz_mapper is not None:
                agent_stance = _coerce_stance_value(agent.get("stance"))
                viz_bubble = viz_mapper.map_agent_speak(
                    agent_id=agent["id"],
                    agent_name=agent["name"],
                    message=content,
                    emotion=emotion,
                    stance=agent_stance,
                )
                if metadata_failure_code:
                    viz_bubble.update(public_emotion_metadata(msg))
                await push_event(viz_bubble)

                # V2-P2: Broadcast viz:agent_move (stance-based positioning)
                agent_idx = next((i for i, a in enumerate(agents) if a["id"] == agent["id"]), 0)
                viz_move = viz_mapper.map_stance_move(
                    agent_id=agent["id"],
                    stance_value=agent_stance,
                    total_agents=len(agents),
                    index=agent_idx,
                )
                await push_event(viz_move)

                # V2-P2: Broadcast viz:emotion_change when emotion shifts
                if metadata_failure_code is None and emotion != previous_emotion:
                    viz_emo = viz_mapper.map_emotion_change(
                        agent_id=agent["id"],
                        old_emotion=previous_emotion,
                        new_emotion=emotion,
                    )
                    await push_event(viz_emo)

            return msg

    _check_cancelled(scenario_id)
    tasks = [asyncio.create_task(process_agent(a)) for a in agents]
    try:
        results = await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    _check_cancelled(scenario_id)

    fatal_turn_failures = [
        msg for msg in results if str(msg.get("_turn_failure_code") or "").strip()
    ]
    if fatal_turn_failures:
        code_counts: dict[str, int] = {}
        for msg in fatal_turn_failures:
            code = str(msg.get("_turn_failure_code") or "LLM_UNREACHABLE")
            code_counts[code] = code_counts.get(code, 0) + 1
        code = max(code_counts.items(), key=lambda item: item[1])[0]
        failed_agents = [str(msg.get("agent_name") or "") for msg in fatal_turn_failures]
        await push_event(
            {
                "type": "simulation_degraded",
                "data": {
                    "branch_id": branch_id,
                    "round": round_num,
                    "stage": "generation",
                    "code": code,
                    "failed_agents": failed_agents,
                    "failed_count": len(fatal_turn_failures),
                    "total": len(results),
                },
            }
        )
        # Batch-level degradation is reserved for provider-wide failure: every
        # agent turn in this round ended with a fatal provider/empty-output code.
        # A mixed batch has durable successes, so failed agents keep the normal
        # visible placeholder path and the round continues.
        if len(fatal_turn_failures) == len(results):
            raise AgentTurnBatchFailure(code=code, failed_agents=failed_agents)

        for msg in fatal_turn_failures:
            saved_message_ids = (
                _save_messages(
                    engine,
                    [
                        {
                            "round_id": round_id,
                            "agent_id": msg["agent_id"],
                            "content": msg["content"],
                            "emotion": msg["emotion"],
                            "diverge": msg.get("diverge"),
                            "scenario_id": scenario_id,
                            "branch_id": branch_id,
                            "round_number": round_num,
                            "action": {
                                "action_type": "IDLE",
                                "status": "unavailable",
                                "failure_code": str(
                                    msg.get("_turn_failure_code") or "TURN_UNAVAILABLE"
                                ),
                            },
                            "decision_envelope": msg.get("_decision") or {},
                            "fallback_goal": str(
                                msg.get("_decision", {}).get("current_goal")
                                or effective_topic
                            ),
                            "context_receipt": msg.get("_context_receipt") or {},
                            "idempotency_key": f"turn:{round_id}:{msg['agent_id']}",
                            **(
                                {
                                    "_memory_promotion_context": msg[
                                        "_memory_promotion_context"
                                    ],
                                    "_memory_promotion_legacy_refs": msg[
                                        "_memory_promotion_legacy_refs"
                                    ],
                                }
                                if "_memory_promotion_context" in msg
                                else {}
                            ),
                        }
                    ],
                    opportunity_snapshots_by_actor=opportunity_snapshots_by_actor,
                    domain_world_context=domain_world_context,
                    compatibility_mode="live",
                    **({"runtime_lease": runtime_lease} if runtime_lease else {}),
                )
                or []
            )
            if saved_message_ids:
                msg["id"] = saved_message_ids[0]
            _check_cancelled(scenario_id)
            action_receipt = _get_action_receipt(
                engine, scenario_id, f"turn:{round_id}:{msg['agent_id']}"
            )
            if action_receipt:
                msg["_action_receipt"] = action_receipt
                await push_event({"type": "action_committed", "data": action_receipt})
                _check_cancelled(scenario_id)
            await push_event(
                {
                    "type": "agent_speak",
                    "data": {
                        "agent": msg["agent_name"],
                        "agent_id": msg["agent_id"],
                        "message": msg["content"],
                        "emotion": msg["emotion"],
                        "branch": branch_id,
                        "round": round_num,
                    },
                }
            )
            await push_turn_progress()

    metadata_turn_failures = [
        msg for msg in results if str(msg.get("_metadata_failure_code") or "").strip()
    ]
    if metadata_turn_failures:
        code_counts: dict[str, int] = {}
        for msg in metadata_turn_failures:
            code = str(msg.get("_metadata_failure_code") or "LLM_FAILED")
            code_counts[code] = code_counts.get(code, 0) + 1
        code = max(code_counts.items(), key=lambda item: item[1])[0]
        await push_event(
            {
                "type": "simulation_degraded",
                "data": {
                    "branch_id": branch_id,
                    "round": round_num,
                    "stage": "metadata",
                    "partial": True,
                    "code": code,
                    "failed_agents": [
                        str(msg.get("agent_name") or "") for msg in metadata_turn_failures
                    ],
                    "failed_count": len(metadata_turn_failures),
                    "total": len(results),
                },
            }
        )

    if blackboard is not None:
        for msg in results:
            blackboard.post(
                agent_name=msg["agent_name"],
                content=msg["content"],
                emotion=msg["emotion"],
                diverge=msg.get("diverge"),
            )

    # L2: Store agent utterances to vector memory (fire-and-forget)
    for msg in results:
        store_memory(
            scenario_id=scenario_id,
            agent_id=msg["agent_id"],
            agent_name=msg["agent_name"],
            content=msg["content"],
            round_num=round_num,
            emotion=msg.get("emotion", "neutral"),
            branch_id=branch_id,
        )

    return list(results)


def _stable_pick(seed: str, options: list[str]) -> str:
    """Deterministically pick one option using sha256(seed) modulo len."""
    if not options:
        return ""
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return options[int(digest, 16) % len(options)]


def _is_chinese_language(language: str) -> bool:
    normalized = (language or "").strip().lower()
    return normalized.startswith("chinese") or normalized in {"zh", "zh-cn", "中文"}


def _extract_meaningful_fragment(text: str, max_chars: int = 60) -> str:
    """Pick a sentence-aware snippet from leader content, avoiding mid-word cuts.

    Prefers the first sentence; falls back to the first ``max_chars`` characters
    trimmed at the closest punctuation boundary.
    """
    if not text:
        return ""
    cleaned = text.strip()
    # Try the earliest sentence boundary first (CJK + ASCII punctuation).
    sentence_boundary = None
    for sep in ("。", "！", "？", "!", "?", "."):
        idx = cleaned.find(sep)
        if 1 <= idx <= max_chars:
            sentence_boundary = idx if sentence_boundary is None else min(sentence_boundary, idx)
    if sentence_boundary is not None:
        return cleaned[: sentence_boundary + 1]
    if len(cleaned) <= max_chars:
        return cleaned
    # Trim at nearest soft boundary (comma / space) within budget.
    snippet = cleaned[:max_chars]
    for sep in ("，", ",", "、", " "):
        idx = snippet.rfind(sep)
        if idx >= max_chars // 2:
            return snippet[:idx].rstrip("，,、 ") + "…"
    return snippet.rstrip() + "…"


def _synthesize_worker_response(
    *,
    worker: dict,
    leader_name: str,
    leader_content: str,
    language: str,
    round_number: int,
) -> str:
    """Build a more varied, persona-aware worker response from leader output.

    Uses deterministic template selection so that re-running the same round
    produces stable text, but different rounds rotate through variants.
    """
    fragment = _extract_meaningful_fragment(leader_content, max_chars=60)
    worker_name = worker.get("name", "?")
    is_chinese = _is_chinese_language(language)
    if not fragment:
        return f"({worker_name}保持沉默)" if is_chinese else f"({worker_name} stays silent)"
    worker_role = worker.get("role", "成员" if is_chinese else "member")
    stance_hint = (worker.get("stance") or "").strip()
    seed = f"{worker_name}:{round_number}"

    if is_chinese:
        # Stance-aware tail clause; falls back to neutral framing when missing.
        stance_tail = (
            f"自己更想从「{stance_hint}」的角度补一刀。" if stance_hint else "想再追问一句细节。"
        )
        templates = [
            f"{worker_name}附和了{leader_name}的观点，补充道：{fragment}",
            f"{worker_name}点了点头：{leader_name}说的「{fragment}」确实是重点。",
            f"{worker_name}（{worker_role}）认为{leader_name}的判断基本靠谱，但{stance_tail}",
            f"{worker_name}低声跟上：{fragment}——这一点不能丢。",
        ]
    else:
        stance_tail = (
            f"wants to push back from a '{stance_hint}' angle."
            if stance_hint
            else "wants to press for one more detail."
        )
        templates = [
            f"{worker_name} echoed {leader_name}, adding: {fragment}",
            f"{worker_name} nodded along: '{fragment}' — exactly the point.",
            f"{worker_name} ({worker_role}) backed {leader_name}'s read, but {stance_tail}",
            f"{worker_name} muttered in support: {fragment} — we can't lose this thread.",
        ]
    return _stable_pick(seed, templates)


async def _gather_hierarchical_messages(
    engine,
    scenario_id,
    branch_id,
    round_id,
    round_num,
    leader_agents,
    worker_agents,
    agent_to_group,
    group_leaders,
    setting_bg,
    topic,
    *,
    intervention_text: str | None = None,
    intervention_metadata: dict[str, Any] | None = None,
    push=None,
    blackboard: Blackboard | None = None,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    viz_mapper=None,
    agent_prev_emotions: dict[str, str] | None = None,
    web_context_block: str = "",
    document_reference_context: str = "",
    scenario_user_id: str = "",
    native_search_domains: list[str] | None = None,
    runtime_lease: RuntimeLockLease | None = None,
) -> list[dict]:
    """P3-A: Hierarchical message gathering.

    1. Only Leader agents make LLM calls
    2. Worker responses are synthesized from their Leader's output
    3. Dramatically reduces LLM calls: 1000 agents → ~10 LLM calls
    """
    custom_workers = [a for a in worker_agents if a.get("source_type") == "custom"]
    if custom_workers:
        logger.warning(
            "Custom agents found in worker set; promoting %d to leaders",
            len(custom_workers),
        )
        leader_agents = [*leader_agents, *custom_workers]
        worker_agents = [a for a in worker_agents if a.get("source_type") != "custom"]

    progress_total = len(leader_agents) + len(worker_agents)
    progress_counter = [0]
    progress_lock = asyncio.Lock()
    emotion_state = agent_prev_emotions if agent_prev_emotions is not None else {}

    # Step 1: Gather Leader messages (with LLM calls)
    _check_cancelled(scenario_id)
    opportunity_authority: dict[str, object] = {}
    leader_messages = await _gather_agent_messages(
        engine,
        scenario_id,
        branch_id,
        round_id,
        round_num,
        leader_agents,
        setting_bg,
        topic,
        intervention_text=intervention_text,
        intervention_metadata=intervention_metadata,
        push=push,
        blackboard=blackboard,
        llm_overrides=llm_overrides,
        language=language,
        viz_mapper=viz_mapper,
        agent_prev_emotions=agent_prev_emotions,
        web_context_block=web_context_block,
        document_reference_context=document_reference_context,
        scenario_user_id=scenario_user_id,
        native_search_domains=native_search_domains,
        progress_total=progress_total,
        progress_counter=progress_counter,
        progress_lock=progress_lock,
        relationship_agents=[*leader_agents, *worker_agents],
        opportunity_authority_out=opportunity_authority,
        runtime_lease=runtime_lease,
    )
    _check_cancelled(scenario_id)

    # Build leader name → message lookup
    leader_msg_map: dict[str, dict] = {}
    for msg in leader_messages:
        leader_msg_map[msg["agent_name"]] = msg

    # Step 2: Synthesize Worker responses from Leader output (no LLM calls)
    all_messages = list(leader_messages)

    async def push_event(event: dict):
        if push:
            await push(event)

    worker_messages: list[dict[str, Any]] = []
    for worker in worker_agents:
        worker_group = agent_to_group.get(worker["name"], "")
        leader_name = group_leaders.get(worker_group, "")
        leader_msg = leader_msg_map.get(leader_name)
        metadata_failure_code = message_metadata_failure_code(leader_msg) if leader_msg else None

        if leader_msg:
            # Synthesize: persona-aware, sentence-aware, deterministic-but-varied
            leader_content = leader_msg.get("content", "")
            synth_content = _synthesize_worker_response(
                worker=worker,
                leader_name=leader_name,
                leader_content=leader_content,
                language=language,
                round_number=round_num,
            )
            emotion = "" if metadata_failure_code else leader_msg.get("emotion", "neutral")
        else:
            is_chinese = _is_chinese_language(language)
            synth_content = (
                f"({worker['name']}保持沉默)" if is_chinese else f"({worker['name']} stays silent)"
            )
            emotion = "neutral"

        if metadata_failure_code is None:
            emotion = str(emotion or "neutral").strip() or "neutral"
            worker["emotion"] = emotion
            emotion_state[worker["id"]] = emotion

        msg = {
            "agent_id": worker["id"],
            "agent_name": worker["name"],
            "content": synth_content,
            "emotion": emotion,
            "diverge": None,
            "synthesized": True,  # Mark as non-LLM
            "_decision": {
                "current_goal": str(worker.get("role") or topic),
                "goal_progress": "delegated",
                "recalled_memory_refs": [],
                "observed_world_changes": [],
                "candidate_actions": ["IDLE"],
                "selected_action": "IDLE",
                "action_parameters": {},
                "target_agent_or_object": leader_name or None,
                "expected_effect": "Represent the group leader's public position",
                "constraints": ["No independent external action was executed"],
                "decision_basis": ["Hierarchical worker speech was synthesized"],
                "idle_reason": "Worker turns do not independently execute platform actions",
                "idle_reason_code": "IDLE_DECISION_UNAVAILABLE",
                "decision_status": "unavailable",
                "failure_code": "SYNTHESIZED_DECISION_UNAVAILABLE",
                "decision_origin": "synthesized",
            },
        }
        if metadata_failure_code:
            msg["_metadata_failure_code"] = metadata_failure_code
            msg.update(public_emotion_metadata(msg))

        worker_messages.append(msg)

    # Persist the complete synthesized batch before any worker speech becomes
    # externally visible. This keeps broadcast and durable replay consistent
    # even when cancellation arrives after the first worker event.
    _check_cancelled(scenario_id)
    opportunity_snapshots = opportunity_authority.get(
        "opportunity_snapshots_by_actor"
    )
    if not isinstance(opportunity_snapshots, Mapping):
        opportunity_snapshots = {}
    worker_opportunity_snapshots = {
        str(message["agent_id"]): opportunity_snapshots.get(str(message["agent_id"]))
        for message in worker_messages
    }
    domain_world_context = opportunity_authority.get("domain_world_context")
    if not isinstance(domain_world_context, Mapping):
        domain_world_context = None
    saved_message_ids = (
        _save_messages(
            engine,
            [
                {
                    "round_id": round_id,
                    "agent_id": msg["agent_id"],
                    "content": msg["content"],
                    "emotion": (
                        encode_metadata_unavailable_emotion(msg["_metadata_failure_code"])
                        if msg.get("_metadata_failure_code")
                        else msg["emotion"]
                    ),
                    "diverge": msg.get("diverge"),
                    "scenario_id": scenario_id,
                    "branch_id": branch_id,
                    "round_number": round_num,
                    "action": {
                        "action_type": "IDLE",
                        "status": "unavailable",
                        "failure_code": "SYNTHESIZED_ACTION_UNAVAILABLE",
                    },
                    "decision_envelope": msg.get("_decision") or {},
                    "fallback_goal": str(
                        msg.get("_decision", {}).get("current_goal") or topic
                    ),
                    "idempotency_key": f"turn:{round_id}:{msg['agent_id']}",
                }
                for msg in worker_messages
            ],
            opportunity_snapshots_by_actor=worker_opportunity_snapshots,
            domain_world_context=domain_world_context,
            compatibility_mode="live",
            **({"runtime_lease": runtime_lease} if runtime_lease else {}),
        )
        or []
    )
    for msg, message_id in zip(worker_messages, saved_message_ids):
        if message_id:
            msg["id"] = message_id

    all_messages.extend(worker_messages)

    # Push to frontend (but NO agent_speak_start — instant, no "thinking")
    # only after every worker message in this batch is durable.
    for worker, msg in zip(worker_agents, worker_messages):
        _check_cancelled(scenario_id)
        action_receipt = _get_action_receipt(
            engine, scenario_id, f"turn:{round_id}:{msg['agent_id']}"
        )
        if action_receipt:
            msg["_action_receipt"] = action_receipt
            await push_event({"type": "action_committed", "data": action_receipt})
            _check_cancelled(scenario_id)
        metadata_failure_code = message_metadata_failure_code(msg)
        event_data = {
            "agent": worker["name"],
            "agent_id": worker["id"],
            "message": msg["content"],
            "emotion": msg["emotion"],
            "branch": branch_id,
            "round": round_num,
            "synthesized": True,
        }
        if metadata_failure_code:
            event_data.update(public_emotion_metadata(msg))
        await push_event(
            {
                "type": "agent_speak",
                "data": event_data,
            }
        )
        _check_cancelled(scenario_id)
        if progress_total > 0:
            async with progress_lock:
                progress_counter[0] += 1
                completed = progress_counter[0]
            await push_event(
                {
                    "type": "turn_progress",
                    "data": {
                        "branch_id": branch_id,
                        "round": round_num,
                        "completed": completed,
                        "total": progress_total,
                    },
                }
            )

        # V2: Broadcast viz:bubble_show for worker (synthesized) agents
        if viz_mapper is not None:
            worker_stance = _coerce_stance_value(worker.get("stance"))
            viz_bubble = viz_mapper.map_agent_speak(
                agent_id=worker["id"],
                agent_name=worker["name"],
                message=msg["content"],
                emotion=msg["emotion"] or None,
                stance=worker_stance,
            )
            if metadata_failure_code:
                viz_bubble.update(public_emotion_metadata(msg))
            await push_event(viz_bubble)
    for msg in worker_messages:
        store_memory(
            scenario_id=scenario_id,
            agent_id=msg["agent_id"],
            agent_name=msg["agent_name"],
            content=msg["content"],
            round_num=round_num,
            emotion=msg.get("emotion", "neutral"),
            branch_id=branch_id,
        )

    # Batch-post all results to Blackboard
    if blackboard is not None:
        for msg in all_messages:
            if not msg.get("synthesized"):  # Only post real messages
                continue  # Leaders already posted in _gather_agent_messages
            blackboard.post(
                agent_name=msg["agent_name"],
                content=msg["content"],
                emotion=msg["emotion"],
                diverge=msg.get("diverge"),
            )

    logger.info(
        "Hierarchical round %d: %d leader LLM calls, %d worker syntheses",
        round_num,
        len(leader_messages),
        len(worker_agents),
    )

    return all_messages


async def _detect_fork(
    engine,
    branch_id,
    diverge_signals,
    sensitivity,
    *,
    llm_overrides: dict | None = None,
    language: str = "Chinese",
    prompt_variant: str = "a",
    recent_summary: str | None = None,
    question: str = "",
) -> dict:
    """Detect if current discussion warrants a branch fork."""
    recent_text = recent_summary
    if recent_text is None:
        recent_msgs = _get_recent_messages(engine, branch_id, max_rounds=3)
        recent_text = format_messages_for_context(recent_msgs, max_recent=15)
    prompt_template = _get_fork_prompt_template(language, prompt_variant)
    diverge_text = "\n".join(f"- {s}" for s in diverge_signals)

    prompt = prompt_template.format(
        question_block=format_untrusted_text_block(
            "用户原始问题" if _is_chinese_language(language) else "Original user question",
            question or "(empty)",
            max_chars=1200,
        ),
        recent_summary=format_untrusted_text_block(
            "最近讨论摘要" if _is_chinese_language(language) else "Recent discussion summary",
            recent_text or "(empty)",
            max_chars=4000,
        ),
        diverge_signals=format_untrusted_text_block(
            (
                "Agent 标记的分歧信号"
                if _is_chinese_language(language)
                else "Divergence signals marked by agents"
            ),
            diverge_text or "(none)",
            max_chars=1600,
        ),
        sensitivity=sensitivity,
        title_question=_fork_title_question_anchor(question),
        language_directive=get_language_directive(language),
    )

    try:
        _overrides = llm_overrides or {}
        with llm_request_scope(**_llm_scope_kwargs(_overrides, purpose="scenario_fork_detection")):
            result = await llm_call_json_with_stream_fallback(
                prompt,
                reasoning_effort="medium",
                model=_overrides.get("model"),
                api_key=_overrides.get("api_key"),
                base_url=_overrides.get("base_url"),
                temperature=_overrides.get("temperature"),
            )
            return _normalize_fork_detector_result(result)
    except Exception as exc:
        logger.warning(
            "Fork detection failed: %s: %s",
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )
        return {"should_fork": False}


def _parse_result_verdict_json(raw_text: str) -> dict[str, Any]:
    cleaned = (raw_text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        parsed = json.loads(cleaned, strict=False)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        if start == -1:
            raise
        parsed, _ = json.JSONDecoder(strict=False).raw_decode(cleaned[start:])
    if not isinstance(parsed, dict):
        raise ValueError("verdict response is not a JSON object")
    return parsed


def _normalize_result_verdict_confidence(value: object) -> str | None:
    confidence = str(value or "").strip().lower()
    return confidence if confidence in {"high", "medium", "low"} else None


def _normalize_result_verdict_confidence_branch_ids(
    value: object,
) -> list[str] | None:
    if not isinstance(value, list) or not value:
        return None
    branch_ids: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or item != item.strip():
            return None
        branch_ids.append(item)
    if len(set(branch_ids)) != len(branch_ids) or branch_ids != sorted(branch_ids):
        return None
    return branch_ids


def _result_verdict_confidence_branch_ids(
    branches: list[dict[str, Any]],
) -> list[str] | None:
    """Bind a self-rating to the exact terminal outcomes shown to the model."""

    selected = branches[:8]
    if not selected:
        return None
    branch_ids: list[str] = []
    for branch in selected:
        if not isinstance(branch, dict):
            return None
        branch_id = _branch_id_value(branch)
        if not branch_id:
            return None
        branch_ids.append(branch_id)
    return _normalize_result_verdict_confidence_branch_ids(sorted(branch_ids))


def _normalize_result_actual_outcome(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _one_line_answer(text: str, *, max_chars: int = 220) -> str:
    compact = re.sub(r"\s+", " ", text or "").strip()
    if len(compact) <= max_chars:
        return compact
    return compact[: max_chars - 1].rstrip() + "…"


def _result_branch_summaries(branches: list) -> list[dict[str, object]]:
    summaries: list[dict[str, object]] = []
    for branch in branches[:8]:
        if not isinstance(branch, dict):
            continue
        probability_raw = branch.get("probability", 0)
        try:
            probability: float | int = round(float(probability_raw), 3)
        except (TypeError, ValueError):
            probability = 0
        story_excerpt = str(branch.get("story") or "").strip()[:1200]
        summaries.append(
            {
                "title": str(branch.get("title") or "").strip(),
                "insight": str(branch.get("insight") or "").strip(),
                "probability": probability,
                "story_excerpt": story_excerpt,
            }
        )
    return summaries


def _copy_parsed_context(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def _json_path_part(part: str) -> str:
    escaped = part.replace("\\", "\\\\").replace('"', '\\"')
    return f'."{escaped}"'


def _json_path(*parts: str) -> str:
    return "$" + "".join(_json_path_part(part) for part in parts)


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


def _json_result_quality_object_expr():
    base = _json_object_or_empty_expr()
    result_quality_path = _json_path("result_quality")
    return case(
        (func.json_type(base, result_quality_path) == "object", base),
        else_=func.json_set(base, result_quality_path, func.json("{}")),
    )


def _json_set_parsed_context_expr(
    *path_value_pairs: object,
    base_expr: object | None = None,
):
    return func.json_set(
        _json_object_or_empty_expr() if base_expr is None else base_expr,
        *path_value_pairs,
    )


def _json_value(value: object):
    return func.json(json.dumps(value, ensure_ascii=False))


def _is_verdict_only_multi_run_context(
    parsed_context: object,
    director_state: object,
) -> bool:
    for source in (director_state, parsed_context):
        if not isinstance(source, dict):
            continue
        multi_run = source.get("multi_run")
        if isinstance(multi_run, dict) and bool(multi_run.get("verdict_only")):
            return True
    return False


def _build_verdict_only_branch_payloads(
    engine,
    all_branches: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    branch_ids = [
        str(branch.get("id"))
        for branch in all_branches
        if branch.get("status") in ("ACTIVE", "COMPLETED") and branch.get("id")
    ]
    if not branch_ids:
        return payloads
    with Session(engine) as session:
        db_branches = list(session.exec(select(Branch).where(Branch.id.in_(branch_ids))).all())
        by_id = {branch.id: branch for branch in db_branches}
        for branch_data in all_branches:
            branch_id = str(branch_data.get("id") or "")
            branch = by_id.get(branch_id)
            if branch is None:
                continue
            fallback = (
                (branch.summary or "").strip()
                or (branch.insight or "").strip()
                or (branch.fork_reason or "").strip()
                or (branch.title or "").strip()
                or "Verdict-only branch completed."
            )
            story = (branch.story or "").strip() or fallback
            insight = (
                (branch.insight or "").strip()
                or (branch.fork_reason or "").strip()
                or (branch.title or "").strip()
                or story
            )
            if branch.status == BranchStatus.ACTIVE:
                branch.status = BranchStatus.COMPLETED
            if not (branch.story or "").strip():
                branch.story = story
            if not (branch.insight or "").strip():
                branch.insight = insight
            if branch.status == BranchStatus.COMPLETED:
                session.add(branch)
            payloads.append(
                {
                    "id": branch.id,
                    "parent_branch_id": branch.parent_branch_id,
                    "status": branch.status.value,
                    "fork_round": branch_data.get("fork_round"),
                    "probability": branch.probability,
                    "title": branch.title,
                    "story": story,
                    "insight": insight,
                }
            )
        session.commit()
    return payloads


def _positive_float_setting(name: str, default: float) -> float:
    try:
        value = float(getattr(settings, name, default))
    except (TypeError, ValueError):
        return default
    return value if math.isfinite(value) and value > 0 else default


def _agent_turn_timeouts() -> tuple[float, float, float]:
    generation = _positive_float_setting(
        "AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS",
        _DEFAULT_AGENT_TURN_GENERATION_REQUEST_TIMEOUT_SECONDS,
    )
    metadata = _positive_float_setting(
        "AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS",
        _DEFAULT_AGENT_TURN_METADATA_REQUEST_TIMEOUT_SECONDS,
    )
    total = _positive_float_setting(
        "AGENT_TURN_TOTAL_TIMEOUT_SECONDS",
        _DEFAULT_AGENT_TURN_TOTAL_TIMEOUT_SECONDS,
    )
    return generation, metadata, total


def _agent_turn_monotonic() -> float:
    return monotonic()


def _agent_turn_remaining(deadline: float) -> float:
    remaining = deadline - _agent_turn_monotonic()
    if not math.isfinite(remaining) or remaining <= 0:
        raise asyncio.TimeoutError("agent turn total timeout exhausted")
    return remaining


def _result_verdict_timeouts() -> tuple[float, float]:
    request_timeout = _positive_float_setting(
        "RESULT_VERDICT_REQUEST_TIMEOUT_SECONDS",
        _RESULT_VERDICT_TIMEOUT_SECONDS,
    )
    total_timeout = _positive_float_setting(
        "RESULT_VERDICT_TOTAL_TIMEOUT_SECONDS",
        max(request_timeout + 1.0, _RESULT_VERDICT_TIMEOUT_SECONDS),
    )
    return request_timeout, max(total_timeout, request_timeout)


def _result_verdict_failure_payload(exc: BaseException) -> dict[str, object]:
    code = classify_llm_error_code(exc) or "LLM_FAILED"
    reason = (
        "result verdict generation timed out"
        if code == "LLM_TIMEOUT"
        else f"result verdict generation failed ({code})"
    )
    return {
        "_verdict_generation_failed": True,
        "verdict_error_code": code,
        "verdict_missing_reason": reason,
    }


async def _generate_verdict(
    question: str,
    branches: list,
    web_context: str,
    language: str,
    llm_overrides: dict | None = None,
) -> dict | None:
    """Generate a one-paragraph verdict directly answering the user's question."""
    try:
        is_chinese = _is_chinese_language(language)
        branch_summaries = _result_branch_summaries(branches)
        if not question.strip() or not branch_summaries:
            return None

        question_block = format_untrusted_text_block(
            "用户问题" if is_chinese else "User question",
            question,
            max_chars=1200,
        )
        branches_block = format_untrusted_text_block(
            "分支摘要" if is_chinese else "Branch summaries",
            json.dumps(branch_summaries, ensure_ascii=False),
            max_chars=15000,
        )
        web_block = format_untrusted_text_block(
            "真实世界上下文" if is_chinese else "Real-world context",
            web_context or "(none)",
            max_chars=3000,
        )
        factual_guardrail = "\n".join(
            f"branch_{idx + 1}: title={item['title']}; "
            f"probability={item['probability']}; insight={item['insight']}"
            for idx, item in enumerate(branch_summaries)
        )
        guardrail_block = format_untrusted_text_block(
            "事实护栏" if is_chinese else "Factual guardrail",
            factual_guardrail,
            max_chars=2500,
        )

        if is_chinese:
            prompt = (
                "你是 SwarmOracle 的结果裁判。请基于已完成的分支，"
                "直接回答用户最初的问题。\n\n"
                f"{question_block}\n\n"
                f"{branches_block}\n\n"
                f"{web_block}\n\n"
                f"{guardrail_block}\n\n"
                "要求：\n"
                "- verdict 用一段话回答用户问题，2-4 句，先给判断，再说明理由。\n"
                "- question_answer 用一句话给出最短答案。\n"
                "- confidence 只能是 high / medium / low。\n"
                "- actual_outcome 必须是 true / false / null：如果你能直接判定"
                "用户问题的答案为是/成立则 true，为否/不成立则 false，证据不足"
                "或没有清晰答案则 null。\n"
                "- 不要发明分支摘要或真实世界上下文之外的确定事实；证据不足时明确保留不确定性。\n"
                "- 只输出严格 JSON："
                '{"verdict":"...","confidence":"medium",'
                '"question_answer":"...","actual_outcome":null}\n'
                f"{get_language_directive(language)}"
            )
        else:
            prompt = (
                "You are SwarmOracle's result judge. Based on the completed "
                "branches, answer the user's original question directly.\n\n"
                f"{question_block}\n\n"
                f"{branches_block}\n\n"
                f"{web_block}\n\n"
                f"{guardrail_block}\n\n"
                "Requirements:\n"
                "- `verdict` must be one paragraph, 2-4 sentences: give the "
                "answer first, then the reason.\n"
                "- `question_answer` must be the shortest one-sentence answer.\n"
                "- `confidence` must be exactly high, medium, or low.\n"
                "- `actual_outcome` must be true, false, or null: true when "
                "your direct answer to the original question is yes/holds, "
                "false when it is no/does not hold, and null when the evidence "
                "is too uncertain or there is no clear answer.\n"
                "- Do not invent facts outside the branch summaries or "
                "real-world context; state uncertainty when evidence is thin.\n"
                "- Output strict JSON only: "
                '{"verdict":"...","confidence":"medium",'
                '"question_answer":"...","actual_outcome":null}\n'
                f"{get_language_directive(language)}"
            )

        _overrides = llm_overrides or {}
        request_timeout, total_timeout = _result_verdict_timeouts()
        with llm_request_scope(**_llm_scope_kwargs(_overrides, purpose="scenario_result_verdict")):
            raw_text = await asyncio.wait_for(
                llm_call(
                    prompt,
                    reasoning_effort="low",
                    model=_overrides.get("model"),
                    api_key=_overrides.get("api_key"),
                    base_url=_overrides.get("base_url"),
                    temperature=(
                        _overrides.get("temperature")
                        if _overrides.get("temperature") is not None
                        else 0.3
                    ),
                    timeout=request_timeout,
                ),
                timeout=total_timeout,
            )

        parsed = _parse_result_verdict_json(raw_text)
        verdict_text = str(parsed.get("verdict") or "").strip()
        if not verdict_text:
            return None
        question_answer = str(parsed.get("question_answer") or "").strip()
        if not question_answer:
            question_answer = _one_line_answer(verdict_text)
        confidence = _normalize_result_verdict_confidence(parsed.get("confidence"))
        confidence_branch_ids = _result_verdict_confidence_branch_ids(branches)
        result: dict[str, object] = {
            "verdict": verdict_text,
            "question_answer": _one_line_answer(question_answer),
            "actual_outcome": _normalize_result_actual_outcome(
                parsed.get("actual_outcome"),
            ),
        }
        if confidence is not None and confidence_branch_ids is not None:
            result["confidence"] = confidence
            result["confidence_kind"] = _RESULT_VERDICT_CONFIDENCE_KIND
            result[_RESULT_VERDICT_CONFIDENCE_BRANCH_IDS_KEY] = confidence_branch_ids
        return result
    except Exception as exc:
        payload = _result_verdict_failure_payload(exc)
        logger.warning(
            "result verdict generation failed (non-blocking): code=%s %s: %s",
            payload["verdict_error_code"],
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )
        return payload


def _persist_result_quality_verdict(
    engine,
    scenario_id: str,
    verdict: dict[str, object],
) -> None:
    try:
        verdict_text = str(verdict.get("verdict") or "").strip()
        if not verdict_text:
            return
        confidence = _normalize_result_verdict_confidence(verdict.get("confidence"))
        confidence_branch_ids = _normalize_result_verdict_confidence_branch_ids(
            verdict.get(_RESULT_VERDICT_CONFIDENCE_BRANCH_IDS_KEY)
        )
        has_model_self_rating = (
            confidence is not None
            and verdict.get("confidence_kind") == _RESULT_VERDICT_CONFIDENCE_KIND
            and confidence_branch_ids is not None
        )
        result_quality_expr = _json_result_quality_object_expr()
        path_value_pairs: list[object] = [
            _json_path("result_quality", "verdict"),
            _json_value(verdict_text),
            _json_path("result_quality", "question_answer"),
            _json_value(
                _one_line_answer(
                    str(verdict.get("question_answer") or verdict_text),
                )
            ),
            _json_path("result_quality", "actual_outcome"),
            _json_value(
                _normalize_result_actual_outcome(
                    verdict.get("actual_outcome"),
                )
            ),
        ]
        if has_model_self_rating:
            path_value_pairs.extend(
                [
                    _json_path("result_quality", "confidence"),
                    _json_value(confidence),
                    _json_path("result_quality", "confidence_kind"),
                    _json_value(_RESULT_VERDICT_CONFIDENCE_KIND),
                    _json_path(
                        "result_quality",
                        _RESULT_VERDICT_CONFIDENCE_BRANCH_IDS_KEY,
                    ),
                    _json_value(confidence_branch_ids),
                ]
            )
        else:
            result_quality_expr = func.json_remove(
                result_quality_expr,
                _json_path("result_quality", "confidence"),
                _json_path("result_quality", "confidence_kind"),
                _json_path(
                    "result_quality",
                    _RESULT_VERDICT_CONFIDENCE_BRANCH_IDS_KEY,
                ),
            )
        with Session(engine) as session:
            session.exec(
                update(Scenario)
                .where(Scenario.id == scenario_id)
                .values(
                    parsed_context=_json_set_parsed_context_expr(
                        *path_value_pairs,
                        base_expr=result_quality_expr,
                    )
                )
            )
            session.commit()
    except Exception:
        logger.debug("result verdict persistence failed (non-blocking)", exc_info=True)


def _persist_result_quality_verdict_failure(
    engine,
    scenario_id: str,
    payload: dict[str, object],
) -> None:
    try:
        reason = str(payload.get("verdict_missing_reason") or "").strip()
        if not reason:
            return
        code = str(payload.get("verdict_error_code") or "LLM_FAILED").strip()
        with Session(engine) as session:
            session.exec(
                update(Scenario)
                .where(Scenario.id == scenario_id)
                .values(
                    parsed_context=_json_set_parsed_context_expr(
                        _json_path("result_quality", "verdict_error_code"),
                        _json_value(code[:80]),
                        _json_path("result_quality", "verdict_missing_reason"),
                        _json_value(reason[:240]),
                        base_expr=_json_result_quality_object_expr(),
                    )
                )
            )
            session.commit()
    except Exception:
        logger.debug("result verdict failure persistence failed (non-blocking)", exc_info=True)


async def _compress_round_memory(
    engine,
    branch_id,
    current_round,
    *,
    compress_interval: int | None = None,
    blackboard: Blackboard | None = None,
    language: str = "Chinese",
    llm_overrides: dict | None = None,
):
    """Compress recent rounds into a summary.

    When blackboard is provided, also updates its global summary
    so subsequent rounds benefit from the compressed context.
    """
    try:
        window = max(1, int(compress_interval or settings.MEMORY_COMPRESS_INTERVAL))
    except (TypeError, ValueError):
        window = 1
    start_round = max(1, current_round - window + 1)
    msgs = _get_messages_in_range(engine, branch_id, start_round, current_round)
    if not msgs:
        return

    msgs_text = "\n".join(_format_message_for_compression(m) for m in msgs)
    previous_briefing = _load_latest_compressed_briefing(
        engine,
        branch_id,
        before_round=start_round,
    )
    summary = await compress_rounds(
        msgs_text,
        language=language,
        previous_briefing=previous_briefing,
        api_key=(llm_overrides or {}).get("api_key"),
        base_url=(llm_overrides or {}).get("base_url"),
        temperature=(llm_overrides or {}).get("temperature"),
        model=(llm_overrides or {}).get("model"),
    )

    _save_round_summary(
        engine,
        branch_id,
        current_round,
        json.dumps(summary, ensure_ascii=False),
    )

    # Update Blackboard with structured compression output
    if blackboard is not None:
        blackboard.update_global_summary(summary)


def _load_latest_compressed_briefing(engine, branch_id: str, *, before_round: int) -> dict | None:
    """Load the latest structured summary before the current compression window."""
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch is None:
            return None
        try:
            selection = select_branch_rounds(
                session,
                scenario_id=branch.scenario_id,
                branch_id=branch.id,
                requested_cutoff=max(0, before_round - 1),
            )
        except BranchLineageError as exc:
            logger.warning(
                "Compressed briefing lineage resolution failed; fallback skipped",
                extra={"lineage_error_code": exc.code},
            )
            return None
        round_row = next(
            (
                round_
                for round_ in reversed(selection.rounds)
                if round_.round_number < before_round and round_.compressed_summary
            ),
            None,
        )

    if round_row is None or not round_row.compressed_summary:
        return None

    try:
        parsed = json.loads(round_row.compressed_summary)
    except json.JSONDecodeError:
        logger.warning(
            "Failed to parse historical compressed_summary for branch=%s round=%s",
            branch_id,
            round_row.round_number,
        )
        return None
    except TypeError:
        logger.warning(
            "Failed to parse historical compressed_summary for branch=%s round=%s",
            branch_id,
            round_row.round_number,
        )
        return None

    return parsed if isinstance(parsed, dict) else None


def _load_terminal_narration_messages(engine, branch_id: str) -> list[dict[str, Any]]:
    """Load the exact effective lineage transcript for terminal narration."""
    with Session(engine) as session:
        target_branch = session.get(Branch, branch_id)
        if target_branch is None:
            return []
        scenario = session.get(Scenario, target_branch.scenario_id)
        if scenario is None:
            return []

        selection = select_branch_rounds(
            session,
            scenario_id=scenario.id,
            branch_id=target_branch.id,
        )
        if not selection.rounds:
            return []

        segment_index_by_branch: dict[str, int] = {
            segment.branch_id: index for index, segment in enumerate(selection.lineage.segments)
        }
        round_ids_by_segment: dict[int, list[str]] = {
            index: [] for index in range(len(selection.lineage.segments))
        }
        for round_ in selection.rounds:
            round_ids_by_segment[segment_index_by_branch[round_.branch_id]].append(round_.id)
        selected_round_ids = tuple(round_.id for round_ in selection.rounds)
        agent_name_column = func.coalesce(Agent.name, "Unknown").label("agent_name")

        def message_statement(round_ids: tuple[str, ...]):
            return (
                select(
                    AgentMessage.id,
                    AgentMessage.round_id,
                    AgentMessage.agent_id,
                    AgentMessage.content,
                    AgentMessage.emotion,
                    Round.round_number,
                    Round.branch_id,
                    agent_name_column,
                )
                .join(Round, AgentMessage.round_id == Round.id)
                .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
                .where(AgentMessage.round_id.in_(round_ids))
            )

        messages_by_id: dict[str, dict[str, Any]] = {}

        def add_message(row, segment_index: int) -> None:
            if row is None:
                return
            (
                message_id,
                round_id,
                agent_id,
                content,
                emotion,
                round_number,
                owner_branch_id,
                agent_name,
            ) = row
            message_id = str(message_id)
            messages_by_id[message_id] = {
                "message_id": message_id,
                "round_id": str(round_id),
                "branch_id": str(owner_branch_id),
                "segment_index": int(segment_index),
                "agent_id": str(agent_id),
                "agent_name": str(agent_name or "Unknown"),
                "content": str(content or ""),
                **public_emotion_metadata({"emotion": emotion}),
                "round": int(round_number),
            }

        for segment_index, segment_round_ids in round_ids_by_segment.items():
            if not segment_round_ids:
                continue
            round_ids = tuple(segment_round_ids)
            ascending = (
                Round.round_number.asc(),
                agent_name_column.asc(),
                AgentMessage.id.asc(),
            )
            descending = (
                Round.round_number.desc(),
                agent_name_column.desc(),
                AgentMessage.id.desc(),
            )
            add_message(
                session.exec(message_statement(round_ids).order_by(*ascending).limit(1)).first(),
                segment_index,
            )
            add_message(
                session.exec(message_statement(round_ids).order_by(*descending).limit(1)).first(),
                segment_index,
            )

        newest_rows = session.exec(
            message_statement(selected_round_ids)
            .order_by(
                Round.round_number.desc(),
                agent_name_column.desc(),
                AgentMessage.id.desc(),
            )
            .limit(_TERMINAL_NARRATION_NEWEST_MESSAGE_LIMIT)
        ).all()
        for row in newest_rows:
            owner_branch_id = str(row[6])
            add_message(row, segment_index_by_branch[owner_branch_id])

    messages = list(messages_by_id.values())
    messages.sort(
        key=lambda message: (
            message["round"],
            message["segment_index"],
            message["agent_name"],
            message["message_id"],
        )
    )
    return messages


def _terminal_narration_message_key(message: dict[str, Any]) -> tuple[int, int, str, str]:
    def coordinate(name: str) -> int:
        try:
            return int(message.get(name, 0))
        except (TypeError, ValueError):
            return 0

    return (
        coordinate("round"),
        coordinate("segment_index"),
        str(message.get("agent_name") or "Unknown"),
        str(message.get("message_id") or ""),
    )


def _terminal_narration_timeline_line(message: dict[str, Any]) -> str:
    round_number = message.get("round", "?")
    agent_name = " ".join(str(message.get("agent_name") or "Unknown").split())
    content = " ".join(str(message.get("content") or "").split())
    return f"[R{round_number} {agent_name}]: {content}"


def _head_tail_elide(text: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    if max_chars == 1:
        return "…"

    marker_index = text.find("]: ")
    prefix = text[: marker_index + 3] if marker_index >= 0 else ""
    if prefix and len(prefix) + 2 < max_chars:
        body = text[len(prefix) :]
        body_budget = max_chars - len(prefix) - 1
        head_chars = (body_budget + 1) // 2
        tail_chars = body_budget // 2
        tail = body[-tail_chars:] if tail_chars else ""
        return f"{prefix}{body[:head_chars]}…{tail}"

    body_budget = max_chars - 1
    head_chars = (body_budget + 1) // 2
    tail_chars = body_budget // 2
    tail = text[-tail_chars:] if tail_chars else ""
    return f"{text[:head_chars]}…{tail}"


def _fair_terminal_anchor_budgets(lines: list[str], max_chars: int) -> list[int]:
    if not lines:
        return []
    available = max(0, max_chars - (len(lines) - 1))
    budgets = [0] * len(lines)
    pending = set(range(len(lines)))
    while pending:
        share, remainder = divmod(available, len(pending))
        completed = {index for index in pending if len(lines[index]) <= share}
        if completed:
            for index in completed:
                budgets[index] = len(lines[index])
                available -= budgets[index]
            pending.difference_update(completed)
            continue
        for offset, index in enumerate(sorted(pending)):
            budgets[index] = share + (1 if offset < remainder else 0)
        break
    return budgets


def _format_terminal_narration_rounds(
    messages: list[dict[str, Any]],
    *,
    max_chars: int = _NARRATE_MAX_CHARS,
) -> str:
    """Build a bounded lineage timeline without dropping fork-boundary anchors."""
    if not messages or max_chars <= 0:
        return ""

    ordered = sorted(messages, key=_terminal_narration_message_key)
    messages_by_segment: dict[int, list[dict[str, Any]]] = {}
    for message in ordered:
        segment_index = _terminal_narration_message_key(message)[1]
        messages_by_segment.setdefault(segment_index, []).append(message)
    segment_indices = sorted(messages_by_segment)

    anchor_by_key: dict[tuple[int, int, str, str], dict[str, Any]] = {}
    for current_index, successor_index in zip(
        segment_indices,
        segment_indices[1:],
        strict=False,
    ):
        for message in (
            messages_by_segment[current_index][-1],
            messages_by_segment[successor_index][0],
        ):
            anchor_by_key[_terminal_narration_message_key(message)] = message
    effective_last = messages_by_segment[segment_indices[-1]][-1]
    anchor_by_key[_terminal_narration_message_key(effective_last)] = effective_last

    anchors = sorted(anchor_by_key.values(), key=_terminal_narration_message_key)
    anchor_lines = [_terminal_narration_timeline_line(message) for message in anchors]
    minimum_anchor_chars = len(anchor_lines) + max(0, len(anchor_lines) - 1)
    if max_chars < minimum_anchor_chars:
        return "…"
    anchor_budgets = _fair_terminal_anchor_budgets(anchor_lines, max_chars)
    rendered_by_key = {
        _terminal_narration_message_key(message): _head_tail_elide(line, budget)
        for message, line, budget in zip(
            anchors,
            anchor_lines,
            anchor_budgets,
            strict=True,
        )
    }
    used_chars = sum(len(line) for line in rendered_by_key.values()) + max(
        0,
        len(rendered_by_key) - 1,
    )

    for message in reversed(ordered):
        message_key = _terminal_narration_message_key(message)
        if message_key in rendered_by_key:
            continue
        line = _terminal_narration_timeline_line(message)
        added_chars = len(line) + (1 if rendered_by_key else 0)
        if used_chars + added_chars > max_chars:
            break
        rendered_by_key[message_key] = line
        used_chars += added_chars

    rendered = "\n".join(
        rendered_by_key[_terminal_narration_message_key(message)]
        for message in ordered
        if _terminal_narration_message_key(message) in rendered_by_key
    )
    return rendered if len(rendered) <= max_chars else "…"


def _load_terminal_narration_context(engine, branch_id: str) -> tuple[dict, str]:
    branch_info = _get_branch(engine, branch_id)
    raw_rounds = _format_terminal_narration_rounds(
        _load_terminal_narration_messages(engine, branch_id)
    )
    return branch_info, raw_rounds


async def _narrate_branch_data(
    engine,
    branch_id,
    agents,
    *,
    language: str = "Chinese",
    llm_overrides: dict | None = None,
    web_context_block: str = "",
    question: str = "",
    raw_rounds: str | None = None,
    branch_info: dict[str, Any] | None = None,
) -> dict:
    """Collect branch data and narrate it."""
    resolved_branch_info = branch_info
    resolved_raw_rounds = raw_rounds
    if resolved_branch_info is None or resolved_raw_rounds is None:
        loaded_branch_info, loaded_raw_rounds = await asyncio.to_thread(
            _load_terminal_narration_context,
            engine,
            branch_id,
        )
        if resolved_branch_info is None:
            resolved_branch_info = loaded_branch_info
        resolved_raw_rounds = (
            loaded_raw_rounds if resolved_raw_rounds is None else resolved_raw_rounds
        )
    agents_summary = ", ".join(f"{a['name']}({a['role']})" for a in agents[:10])

    result = await narrate_branch(
        branch_title=resolved_branch_info.get("title", ""),
        probability=resolved_branch_info.get("probability", 0.5),
        agents_summary=agents_summary,
        raw_rounds=resolved_raw_rounds,
        language=language,
        api_key=(llm_overrides or {}).get("api_key"),
        base_url=(llm_overrides or {}).get("base_url"),
        temperature=(llm_overrides or {}).get("temperature"),
        model=(llm_overrides or {}).get("model"),
        web_context_block=web_context_block,
        question=question,
    )
    result["title"] = resolved_branch_info.get("title", "未命名")
    return result


def _ensure_completable_narration(narration: dict, *, language: str) -> dict:
    result = dict(narration or {})
    story = _strip_round_markers(str(result.get("story", "") or ""))
    insight = _strip_round_markers(str(result.get("insight", "") or ""))
    if not story:
        story = (
            "该分支已完成推演，但叙事生成失败；系统保留了原始发言记录作为依据。"
            if _is_chinese_language(language)
            else (
                "This branch completed simulation, but narrative generation failed; "
                "the raw transcript remains available as evidence."
            )
        )
    if not insight:
        excerpt = " ".join(story.split())
        insight = (excerpt[:120] + "…") if len(excerpt) > 120 else excerpt
    result["story"] = story
    result["insight"] = insight
    return result


_BRANCH_NARRATIVE_COMPILATION_KEY = "_branch_narrative_claim_compilation"


def _branch_narrative_compilation_failure(*, language: str) -> dict[str, object]:
    if _is_chinese_language(language):
        unavailable = "证据校验不可用；未发布模型生成的分支叙事。"
        answer = "证据校验不可用，无法形成可信答案。"
        basis = "分支叙事 Claim 编译失败，原始模型文本已被阻断。"
    else:
        unavailable = (
            "Evidence validation is unavailable; the model-generated branch "
            "narrative was not published."
        )
        answer = "Evidence validation is unavailable, so no reliable answer was published."
        basis = (
            "Branch narrative claim compilation failed; raw model prose was blocked."
        )
    return {
        "story": unavailable,
        "insight": unavailable,
        "key_moments": [],
        "question_answer": answer,
        _BRANCH_NARRATIVE_COMPILATION_KEY: {
            "schema_version": 1,
            "status": "failed",
            "claims": [],
            "claim_ids_by_field": {},
            "analytic_confidence": {
                "level": "low",
                "basis": basis,
            },
            "evidence_coverage": {
                "max_round": 0,
                "covered_rounds": [],
                "missing_rounds": [],
                "covered_phases": [],
                "missing_phases": [],
            },
        },
    }


def _compile_durable_branch_narration(
    engine,
    branch_id: str,
    narration: dict,
    *,
    language: str,
) -> dict:
    """Replace free narrator prose with claim-validated legacy wire fields."""

    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch is None:
            raise ValueError("branch not found for narrative claim compilation")
        scenario_id = branch.scenario_id
    compiled = compile_branch_narrative_claims(
        engine,
        scenario_id,
        branch_id,
        narration,
        language=language,
    )
    result = dict(narration)
    result.update(compiled.narration)
    result[_BRANCH_NARRATIVE_COMPILATION_KEY] = {
        "schema_version": 1,
        "status": "validated",
        "claims": [claim.model_dump(mode="json") for claim in compiled.claims],
        "claim_ids_by_field": compiled.claim_ids_by_field,
        "analytic_confidence": compiled.analytic_confidence.model_dump(mode="json"),
        "evidence_coverage": compiled.evidence_coverage.model_dump(mode="json"),
    }
    return result


def _build_local_branch_narration_fallback(
    engine,
    branch_id,
    *,
    language: str,
    question: str,
    raw_rounds: str | None = None,
    branch_info: dict[str, Any] | None = None,
) -> dict:
    resolved_branch_info = branch_info
    resolved_raw_rounds = raw_rounds
    if resolved_branch_info is None or resolved_raw_rounds is None:
        loaded_branch_info, loaded_raw_rounds = _load_terminal_narration_context(
            engine,
            branch_id,
        )
        if resolved_branch_info is None:
            resolved_branch_info = loaded_branch_info
        resolved_raw_rounds = (
            loaded_raw_rounds if resolved_raw_rounds is None else resolved_raw_rounds
        )
    result = _build_fallback_narration(
        resolved_branch_info.get("title", ""),
        resolved_branch_info.get("probability", 0.5),
        resolved_raw_rounds,
        language=language,
        question=question,
    )
    result["title"] = resolved_branch_info.get(
        "title",
        "未命名" if _is_chinese_language(language) else "Untitled",
    )
    result["question_answer"] = ""
    return _ensure_completable_narration(result, language=language)


async def _narrate_branch_data_fail_soft(
    engine,
    branch_id,
    agents,
    *,
    language: str = "Chinese",
    llm_overrides: dict | None = None,
    web_context_block: str = "",
    question: str = "",
) -> dict:
    try:
        branch_info, raw_rounds = await asyncio.to_thread(
            _load_terminal_narration_context,
            engine,
            branch_id,
        )
    except BranchLineageError as exc:
        logger.warning(
            "Terminal narration lineage resolution failed",
            extra={"lineage_error_code": exc.code},
        )
        raise

    try:
        narration = await _narrate_branch_data(
            engine,
            branch_id,
            agents,
            language=language,
            llm_overrides=llm_overrides,
            web_context_block=web_context_block,
            question=question,
            raw_rounds=raw_rounds,
            branch_info=branch_info,
        )
    except SimulationCancelled:
        raise
    except asyncio.CancelledError:
        raise
    except BranchLineageError as exc:
        logger.warning(
            "Terminal narration lineage resolution failed",
            extra={"lineage_error_code": exc.code},
        )
        raise
    except Exception as exc:
        logger.warning(
            "Branch narration failed for %s; using local fallback: %s: %s",
            branch_id,
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )
        narration = _build_local_branch_narration_fallback(
            engine,
            branch_id,
            language=language,
            question=question,
            raw_rounds=raw_rounds,
            branch_info=branch_info,
        )
    return _ensure_completable_narration(narration, language=language)


def _save_narration_fail_soft(engine, branch_id, narration: dict, *, language: str) -> dict:
    durable_narration = _ensure_completable_narration(narration, language=language)
    try:
        durable_narration = _compile_durable_branch_narration(
            engine,
            branch_id,
            durable_narration,
            language=language,
        )
    except Exception as exc:
        logger.warning(
            "Branch narrative claim compilation failed for %s; blocking raw prose: %s: %s",
            branch_id,
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )
        durable_narration = {
            **{
                key: value
                for key, value in durable_narration.items()
                if key not in {"story", "insight", "key_moments", "question_answer"}
            },
            **_branch_narrative_compilation_failure(language=language),
        }
    try:
        _save_narration(engine, branch_id, durable_narration)
        return {
            key: value
            for key, value in durable_narration.items()
            if key != _BRANCH_NARRATIVE_COMPILATION_KEY
        }
    except Exception as exc:
        logger.warning(
            "Narration persistence failed for %s; retrying without optional answer: %s: %s",
            branch_id,
            type(exc).__name__,
            _scrub_sensitive_text(str(exc)),
        )
        retry_narration = dict(durable_narration)
        retry_narration["question_answer"] = ""
        _save_narration(engine, branch_id, retry_narration)
        return {
            key: value
            for key, value in retry_narration.items()
            if key != _BRANCH_NARRATIVE_COMPILATION_KEY
        }


# ── Database helpers ─────────────────────────────────────


def _agent_to_dict(agent: Agent) -> dict:
    tier = agent.tier.value
    if agent.source_type == "custom" and tier == "CORE":
        logger.warning(
            "Custom agent %s persisted with CORE tier; downgraded to IMPORTANT",
            agent.id,
        )
        tier = "IMPORTANT"
    return {
        "id": agent.id,
        "name": agent.name,
        "role": agent.role,
        "persona": agent.persona,
        "tier": tier,
        "stance": agent.stance,
        "emotion": agent.emotion,
        "group_id": agent.group_id,  # P3-A
        "agent_identity_id": agent.agent_identity_id,
        "source_type": agent.source_type,
    }


def _enrich_custom_agent_metadata(engine, agents: list[dict]) -> None:
    identity_ids = [
        a["agent_identity_id"]
        for a in agents
        if a.get("agent_identity_id") and a.get("source_type") == "custom"
    ]
    if not identity_ids:
        return
    try:
        from app.models.agent_identity import AgentIdentity

        with Session(engine) as session:
            for iid in identity_ids:
                identity = session.get(AgentIdentity, iid)
                if identity is None:
                    continue
                for agent in agents:
                    if agent.get("agent_identity_id") == iid:
                        agent["source_type"] = "custom"
                        if identity.knowledge_domain_json:
                            try:
                                agent["knowledge_domains"] = json.loads(
                                    identity.knowledge_domain_json
                                )
                            except (TypeError, ValueError):
                                agent["knowledge_domains"] = []
                        if identity.decision_bias_json:
                            try:
                                agent["decision_bias"] = json.loads(identity.decision_bias_json)
                            except (TypeError, ValueError):
                                agent["decision_bias"] = {}
    except Exception:
        logger.debug("custom agent metadata enrichment failed (non-fatal)", exc_info=True)


def _format_setting(setting: dict, *, language: str = "Chinese") -> str:
    if language == "Chinese":
        labels = {
            "time_period": "时代",
            "location": "地点",
            "background": "背景",
            "unknown": "未知",
        }
    else:
        labels = {
            "time_period": "Era",
            "location": "Location",
            "background": "Background",
            "unknown": "Unknown",
        }
    return (
        f"{labels['time_period']}: {setting.get('time_period', labels['unknown'])}\n"
        f"{labels['location']}: {setting.get('location', labels['unknown'])}\n"
        f"{labels['background']}: {setting.get('background', '')}"
    )


def _create_branch(
    engine,
    scenario_id,
    *,
    parent_branch_id=None,
    fork_round=0,
    fork_reason="",
    title="",
    description="",
    probability=1.0,
) -> str:
    branch = Branch(
        scenario_id=scenario_id,
        parent_branch_id=parent_branch_id,
        fork_round=fork_round,
        fork_reason=fork_reason,
        title=title,
        description=description,
        probability=probability,
    )
    with Session(engine) as session:
        session.add(branch)
        session.commit()
        session.refresh(branch)
        return branch.id


def _get_or_create_root_branch(engine, scenario_id: str, *, title: str) -> str:
    with Session(engine) as session:
        root_branch = session.exec(
            select(Branch).where(
                Branch.scenario_id == scenario_id,
                Branch.parent_branch_id == None,  # noqa: E711
            )
        ).first()
        if root_branch:
            root_branch.title = title or root_branch.title
            root_branch.probability = 1.0
            root_branch.status = BranchStatus.ACTIVE
            session.add(root_branch)
            session.commit()
            session.refresh(root_branch)
            return root_branch.id

    return _create_branch(engine, scenario_id, title=title, probability=1.0)


def _create_round(engine, branch_id, round_number) -> str:
    with Session(engine) as session:
        existing = session.exec(
            select(Round).where(
                Round.branch_id == branch_id,
                Round.round_number == round_number,
            )
        ).first()
        if existing is not None:
            return existing.id
        r = Round(branch_id=branch_id, round_number=round_number)
        session.add(r)
        session.commit()
        session.refresh(r)
        return r.id


def _ensure_bootstrap_runtime_lease(
    runtime_lease: RuntimeLockLease | None,
    scenario_id: str,
    *,
    session: Session | None = None,
) -> None:
    """Fence bootstrap writes with the same exact-owner check as action persistence."""
    if runtime_lease is None or runtime_lease.db_path is None:
        return
    from sqlalchemy import text

    def check(active_session: Session):
        return active_session.execute(
            text(
                "SELECT 1 FROM runtime_lock "
                "WHERE lock_key=:lock_key AND owner_id=:owner_id AND expires_at>:now"
            ),
            {
                "lock_key": runtime_lease.lock_key,
                "owner_id": runtime_lease.owner_id,
                "now": time.time(),
            },
        ).first()

    if session is not None:
        held = check(session)
    else:
        with Session(get_engine()) as owned_session:
            held = check(owned_session)
    if held is None:
        raise RuntimeLeaseLost(scenario_id)


def _normalized_active_branch_probabilities(
    active_branches: list[dict[str, Any]],
) -> tuple[list[float] | None, bool]:
    if not active_branches:
        return None, False

    weights = [_normalization_probability_weight(branch) for branch in active_branches]
    prob_sum = sum(weights)
    if prob_sum <= 0:
        fallback = [round(1.0 / len(active_branches), 4) for _ in active_branches]
        fallback[-1] = round(1.0 - sum(fallback[:-1]), 4)
        return fallback, True

    rounded_current = [round(weight, 4) for weight in weights]
    already_four_decimal = all(
        abs(weight - rounded) <= 1e-9 for weight, rounded in zip(weights, rounded_current)
    )
    if already_four_decimal and abs(sum(rounded_current) - 1.0) <= 1e-9:
        return None, False

    normalized = [round(weight / prob_sum, 4) for weight in weights]
    residual = round(1.0 - sum(normalized), 4)
    if residual:
        dominant_index = max(range(len(weights)), key=lambda idx: weights[idx])
        normalized[dominant_index] = round(normalized[dominant_index] + residual, 4)
    return normalized, False


def _branch_status_value(branch: dict[str, Any]) -> str:
    status = branch.get("status")
    if isinstance(status, BranchStatus):
        return status.value
    return str(status or "").strip()


def _normalization_probability_weight(branch: dict[str, Any]) -> float:
    try:
        number = float(branch.get("probability", 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(number) or math.isinf(number):
        return 0.0
    return min(1.0, max(0.0, number))


def _apply_normalized_active_branch_probabilities(
    engine,
    scenario_id: str,
    all_branches: list[dict[str, Any]],
    *,
    include_completed: bool = False,
) -> None:
    normalizable_statuses = {BranchStatus.ACTIVE.value}
    if include_completed:
        normalizable_statuses.add(BranchStatus.COMPLETED.value)
    active_branches = [
        branch for branch in all_branches if _branch_status_value(branch) in normalizable_statuses
    ]
    if include_completed:
        active_branches = _terminal_branch_candidates(active_branches, all_branches)
    normalized_probabilities, used_uniform_fallback = _normalized_active_branch_probabilities(
        active_branches,
    )
    if normalized_probabilities is None:
        return

    if used_uniform_fallback:
        branch_scope = "Active/completed" if include_completed else "Active"
        logger.warning(
            "%s branches for scenario %s summed to <= 0; falling back to uniform probabilities",
            branch_scope,
            scenario_id,
        )

    with Session(engine) as session:
        for branch, normalized_probability in zip(active_branches, normalized_probabilities):
            branch["probability"] = normalized_probability
            db_branch = session.get(Branch, branch["id"])
            if db_branch:
                db_branch.probability = normalized_probability
                session.add(db_branch)
        session.commit()


def _save_message(engine, round_id, agent_id, content, emotion, diverge) -> str | None:
    saved_message_ids = _save_messages(
        engine,
        [
            {
                "round_id": round_id,
                "agent_id": agent_id,
                "content": content,
                "emotion": emotion,
                "diverge": diverge,
            }
        ],
    )
    return saved_message_ids[0] if saved_message_ids else None


def _save_messages(
    engine,
    messages: list[dict[str, Any]],
    *,
    opportunity_snapshots_by_actor: Mapping[
        str, OpportunitySnapshotV1 | None
    ] | None = None,
    domain_world_context: Mapping[str, object] | None = None,
    compatibility_mode: CompatibilityModeV1 = "legacy_import",
    runtime_lease: RuntimeLockLease | None = None,
) -> list[str]:
    if not messages:
        return []

    rows = [
        AgentMessage(
            round_id=message["round_id"],
            agent_id=message["agent_id"],
            content=message["content"],
            emotion=message["emotion"],
            diverge=message.get("diverge"),
        )
        for message in messages
    ]
    with Session(engine) as session:
        session.add_all(rows)
        session.flush()
        from app.services.simulation_actions import append_simulation_action

        runtime_sources: list[dict[str, Any]] = []
        for source, row in zip(messages, rows):
            if not source.get("scenario_id"):
                continue
            try:
                action_row = append_simulation_action(
                    session,
                    scenario_id=source["scenario_id"],
                    branch_id=source["branch_id"],
                    round_id=source["round_id"],
                    round_number=source["round_number"],
                    agent_id=source["agent_id"],
                    message_id=row.id,
                    idempotency_key=source["idempotency_key"],
                    action=_ground_extracted_action_content(
                        source.get("action"), source["content"]
                    ),
                    require_running=True,
                )
            except ValueError as exc:
                failure_code = str(exc)
                if failure_code not in {
                    "ACTION_INVALID_PARENT_SCOPE",
                    "ACTION_PARENT_NOT_EARLIER",
                    "ACTION_INVALID_TARGET_SCOPE",
                    "ACTION_INVALID_SOURCE_TARGET",
                }:
                    raise
                action_row = append_simulation_action(
                    session,
                    scenario_id=source["scenario_id"],
                    branch_id=source["branch_id"],
                    round_id=source["round_id"],
                    round_number=source["round_number"],
                    agent_id=source["agent_id"],
                    message_id=row.id,
                    idempotency_key=source["idempotency_key"],
                    action={
                        "action_type": "IDLE",
                        "status": "unavailable",
                        "failure_code": failure_code,
                    },
                    require_running=True,
                )
            runtime_sources.append({
                "scenario_id": source["scenario_id"],
                "branch_id": source["branch_id"],
                "round_number": source["round_number"],
                "agent_id": source["agent_id"],
                "message_id": row.id,
                "action_id": action_row.id,
                "content": source["content"],
                "decision_envelope": source.get("decision_envelope") or {},
                "fallback_goal": source.get("fallback_goal") or "",
                "context_receipt": source.get("context_receipt") or {},
                "opportunity_snapshot": (
                    opportunity_snapshots_by_actor.get(str(source["agent_id"]))
                    if opportunity_snapshots_by_actor is not None
                    else None
                ),
                **(
                    {"world_state_transition": source["world_state_transition"]}
                    if source.get("world_state_transition") is not None
                    else {}
                ),
                **(
                    {
                        "_memory_promotion_context": source[
                            "_memory_promotion_context"
                        ],
                        "_memory_promotion_legacy_refs": source.get(
                            "_memory_promotion_legacy_refs", ()
                        ),
                    }
                    if settings.FEATURE_AGENT_IDENTITY
                    and settings.FEATURE_MEMORY_PROMOTION
                    and "_memory_promotion_context" in source
                    else {}
                ),
            })

        if runtime_sources:
            from app.services.agent_runtime import persist_round_runtime_in_session

            grouped_runtime_sources: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
            for runtime_source in runtime_sources:
                coordinate = (
                    str(runtime_source["scenario_id"]),
                    str(runtime_source["branch_id"]),
                    int(runtime_source["round_number"]),
                )
                grouped_runtime_sources.setdefault(coordinate, []).append(runtime_source)
            for (scenario_id, branch_id, round_number), runtime_rows in (
                grouped_runtime_sources.items()
            ):
                try:
                    if (
                        settings.FEATURE_AGENT_IDENTITY
                        and settings.FEATURE_MEMORY_PROMOTION
                    ):
                        memory_promotion_contexts_by_actor = {
                            str(row["agent_id"]): row["_memory_promotion_context"]
                            for row in runtime_rows
                            if "_memory_promotion_context" in row
                        }
                        legacy_memory_refs_by_actor = {
                            str(row["agent_id"]): tuple(
                                row.get("_memory_promotion_legacy_refs", ())
                            )
                            for row in runtime_rows
                            if "_memory_promotion_context" in row
                        }
                        persist_round_runtime_in_session(
                            session,
                            scenario_id,
                            branch_id,
                            round_number,
                            runtime_rows,
                            opportunity_snapshots_by_actor=(
                                opportunity_snapshots_by_actor
                            ),
                            domain_world_context=domain_world_context,
                            compatibility_mode=compatibility_mode,
                            runtime_lease=runtime_lease,
                            memory_promotion_contexts_by_actor=(
                                memory_promotion_contexts_by_actor
                            ),
                            legacy_memory_refs_by_actor=legacy_memory_refs_by_actor,
                        )
                    else:
                        persist_round_runtime_in_session(
                            session,
                            scenario_id,
                            branch_id,
                            round_number,
                            runtime_rows,
                            opportunity_snapshots_by_actor=(
                                opportunity_snapshots_by_actor
                            ),
                            domain_world_context=domain_world_context,
                            compatibility_mode=compatibility_mode,
                            runtime_lease=runtime_lease,
                        )
                except ValueError as exc:
                    if str(exc) == "AGENT_RUNTIME_LEASE_LOST":
                        raise RuntimeLeaseLost(scenario_id) from exc
                    raise
        if runtime_lease is not None and runtime_lease.db_path is not None:
            from sqlalchemy import text

            fence = session.execute(
                text(
                    "SELECT 1 FROM runtime_lock "
                    "WHERE lock_key=:lock_key AND owner_id=:owner_id AND expires_at>:now"
                ),
                {
                    "lock_key": runtime_lease.lock_key,
                    "owner_id": runtime_lease.owner_id,
                    "now": time.time(),
                },
            ).first()
            if fence is None:
                raise RuntimeLeaseLost(messages[0].get("scenario_id", ""))
        session.commit()
        return [row.id for row in rows]


def _get_action_receipt(
    engine: Any, scenario_id: str, idempotency_key: str
) -> dict[str, Any] | None:
    from app.models.simulation_action import SimulationAction

    try:
        with Session(engine) as session:
            row = session.exec(
                select(SimulationAction).where(
                    SimulationAction.scenario_id == scenario_id,
                    SimulationAction.idempotency_key == idempotency_key,
                )
            ).first()
            if row is None:
                return None
            return {
                "scenario_id": scenario_id,
                "action_id": row.id,
                "sequence": row.sequence,
                "branch_id": row.branch_id,
                "round": row.round_number,
                "agent_id": row.agent_id,
                "message_id": row.message_id,
                "action_type": getattr(row.action_type, "value", row.action_type),
                "status": getattr(row.status, "value", row.status),
                "failure_code": row.failure_code,
            }
    except Exception:
        logger.debug("Action receipt lookup failed", exc_info=True)
        return None


def _load_action_target_catalog_payload(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    *,
    cutoff_round: int | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Load one lineage-filtered action catalog for the whole concurrent batch."""
    from app.models.simulation_action import (
        SimulationAction,
        SimulationActionStatus,
        SimulationActionType,
    )
    from app.services.branch_lineage import resolve_branch_lineage
    from app.services.initial_social_feed import is_bootstrap_post

    try:
        with Session(engine) as session:
            agents = session.exec(
                select(Agent)
                .where(Agent.scenario_id == scenario_id)
                .order_by(Agent.id)
                .limit(32)
            ).all()
            lineage = resolve_branch_lineage(
                session,
                scenario_id=scenario_id,
                branch_id=branch_id,
                requested_cutoff=cutoff_round,
            )
            segment_filters = []
            for segment in lineage.segments:
                predicates = [
                    SimulationAction.branch_id == segment.branch_id,
                    SimulationAction.round_number >= segment.round_min,
                ]
                if segment.round_max is not None:
                    predicates.append(SimulationAction.round_number <= segment.round_max)
                segment_filters.append(and_(*predicates))
            lineage_branch_ids = tuple(segment.branch_id for segment in lineage.segments)
            candidates = session.exec(
                select(SimulationAction)
                .where(
                    SimulationAction.scenario_id == scenario_id,
                    SimulationAction.status == SimulationActionStatus.VERIFIED,
                    SimulationAction.action_type.in_(
                        (
                            SimulationActionType.POST,
                            SimulationActionType.COMMENT,
                            SimulationActionType.REACTION,
                        )
                    ),
                    or_(
                        *segment_filters,
                        and_(
                            SimulationAction.branch_id.in_(lineage_branch_ids),
                            SimulationAction.message_id.is_(None),
                            SimulationAction.action_type == SimulationActionType.POST,
                        ),
                    ),
                )
                .order_by(SimulationAction.sequence.desc())
                .limit(16)
            ).all()
            projected_actions: list[dict[str, Any]] = []
            for row in candidates:
                segment_visible = any(
                    segment.branch_id == row.branch_id
                    and row.round_number >= segment.round_min
                    and (segment.round_max is None or row.round_number <= segment.round_max)
                    for segment in lineage.segments
                )
                source_agent = session.get(Agent, row.agent_id)
                bootstrap = is_bootstrap_post(row, source_agent)
                if not segment_visible and not bootstrap:
                    continue
                content = str(row.content or "")[:120]
                if bootstrap:
                    try:
                        bootstrap_payload = json.loads(row.payload_json or "{}")
                    except (TypeError, json.JSONDecodeError):
                        bootstrap_payload = {}
                    source_name = str(bootstrap_payload.get("source_name") or "").strip()[:80]
                    if source_name:
                        content = f"[{source_name}] {content}"[:120]
                projected_actions.append(
                    {
                        "id": row.id,
                        "kind": (
                            "post"
                            if str(getattr(row.action_type, "value", row.action_type)) == "POST"
                            else "action"
                        ),
                        "type": str(getattr(row.action_type, "value", row.action_type)),
                        "agent_name": source_agent.name[:80] if source_agent is not None else "",
                        "content": content,
                    }
                )
            return {
                "agents": [
                    {
                        "id": row.id,
                        "name": row.name[:80],
                        "kind": (
                            "source" if row.source_type == "world_event_source" else "agent"
                        ),
                    }
                    for row in agents
                ],
                "actions": projected_actions,
            }
    except Exception:
        logger.debug("Action target catalog load failed", exc_info=True)
        return {"agents": [], "actions": []}


_ACTION_TARGET_CATALOG_MAX_CHARS = 5000


def _project_action_target_catalog(
    payload: dict[str, list[dict[str, Any]]],
    *,
    agent_id: str,
) -> dict[str, list[dict[str, Any]]]:
    """Keep rendered JSON valid and prioritize actionable targets over optional agents."""
    projected: dict[str, list[dict[str, Any]]] = {"actions": [], "agents": []}

    def fits(candidate: dict[str, list[dict[str, Any]]]) -> bool:
        encoded = json.dumps(candidate, ensure_ascii=False)
        sanitized = sanitize_untrusted_text(
            encoded,
            max_chars=max(
                _ACTION_TARGET_CATALOG_MAX_CHARS + 1,
                len(encoded) * 2 + 1,
            ),
        )
        return len(sanitized) <= _ACTION_TARGET_CATALOG_MAX_CHARS

    for row in payload.get("actions", []):
        candidate = {"actions": [*projected["actions"], row], "agents": []}
        if not fits(candidate):
            break
        projected["actions"].append(row)
    for row in payload.get("agents", []):
        if row.get("id") == agent_id:
            continue
        candidate = {
            "actions": projected["actions"],
            "agents": [*projected["agents"], row],
        }
        if not fits(candidate):
            break
        projected["agents"].append(row)
    return projected


def _render_action_target_catalog(
    payload: dict[str, list[dict[str, Any]]],
    *,
    agent_id: str,
) -> str:
    projected = _project_action_target_catalog(payload, agent_id=agent_id)
    return format_untrusted_text_block(
        "action_target_catalog",
        json.dumps(projected, ensure_ascii=False),
        max_chars=_ACTION_TARGET_CATALOG_MAX_CHARS,
    )


def _build_action_target_catalogs(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    *,
    agent_ids: list[str],
    cutoff_round: int | None = None,
    payload: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, str]:
    if payload is None:
        payload = _load_action_target_catalog_payload(
            engine,
            scenario_id,
            branch_id,
            cutoff_round=cutoff_round,
        )
    return {
        agent_id: _render_action_target_catalog(payload, agent_id=agent_id)
        for agent_id in agent_ids
    }


def _build_action_target_catalog(
    engine: Any,
    scenario_id: str,
    branch_id: str,
    *,
    agent_id: str = "",
    cutoff_round: int | None = None,
) -> str:
    """Compatibility wrapper for focused tests and non-batched callers."""
    return _render_action_target_catalog(
        _load_action_target_catalog_payload(
            engine,
            scenario_id,
            branch_id,
            cutoff_round=cutoff_round,
        ),
        agent_id=agent_id,
    )


def _get_recent_messages(engine, branch_id, max_rounds=2) -> list[dict]:
    """P0-2 fix: Uses JOIN to fetch agent names in a single query (no N+1)."""
    with Session(engine) as session:
        rounds = session.exec(
            select(Round)
            .where(Round.branch_id == branch_id)
            .order_by(Round.round_number.desc())
            .limit(max_rounds)
        ).all()
        if not rounds:
            return []
        round_ids = [r.id for r in rounds]
        round_num_map = {r.id: r.round_number for r in rounds}

        # LEFT JOIN: preserves messages even if agent was deleted
        rows = session.exec(
            select(AgentMessage, Agent.name)
            .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
            .where(AgentMessage.round_id.in_(round_ids))
        ).all()

        # Sort by round_number ASC (rounds were fetched DESC)
        results = []
        for msg, agent_name in rows:
            results.append(
                {
                    "message_id": msg.id,
                    "agent_name": agent_name or "Unknown",
                    "content": msg.content,
                    **public_emotion_metadata(msg),
                    "round": round_num_map.get(msg.round_id, 0),
                }
            )
        results.sort(key=lambda x: x["round"])
        return results


def _get_messages_in_range(engine, branch_id, start, end) -> list[dict]:
    """P0-2 fix: Uses JOIN to fetch agent names in a single query (no N+1)."""
    with Session(engine) as session:
        round_rows = list(
            session.exec(
                select(Round.id, Round.round_number).where(
                    Round.branch_id == branch_id,
                    Round.round_number >= start,
                    Round.round_number <= end,
                )
            ).all()
        )
        if not round_rows:
            return []
        round_ids = [row[0] for row in round_rows]
        round_num_map = {round_id: round_number for round_id, round_number in round_rows}

        rows = session.exec(
            select(AgentMessage, Agent.name, Agent.tier, Agent.role)
            .outerjoin(Agent, AgentMessage.agent_id == Agent.id)
            .where(AgentMessage.round_id.in_(round_ids))
        ).all()

        return [
            {
                "agent_name": agent_name or "Unknown",
                "content": msg.content,
                **public_emotion_metadata(msg),
                "diverge": msg.diverge,
                "round": round_num_map.get(msg.round_id),
                "tier": getattr(agent_tier, "value", "") if agent_tier is not None else "",
                "role": agent_role or "",
            }
            for msg, agent_name, agent_tier, agent_role in rows
        ]


def _format_message_for_compression(message: dict[str, Any]) -> str:
    parts: list[str] = []
    round_number = message.get("round")
    if round_number is not None:
        parts.append(f"[R{round_number}]")

    speaker = message.get("agent_name", "Unknown")
    parts.append(f"[{speaker}]")

    tags: list[str] = []
    tier = str(message.get("tier", "") or "").strip()
    role = str(message.get("role", "") or "").strip()
    emotion = str(message.get("emotion", "") or "").strip()
    diverge = str(message.get("diverge", "") or "").strip()

    if tier:
        tags.append(tier)
    if role and ("leader" in role.lower() or "领袖" in role or "组长" in role):
        tags.append("LEADER")
    if emotion:
        tags.append(f"emotion={emotion}")
    if diverge:
        tags.append(f"diverge={diverge}")

    tag_block = f"[{'|'.join(tags)}]" if tags else ""
    return f"{''.join(parts)}{tag_block}: {message.get('content', '')}"


def _update_branch_status(engine, branch_id, status: BranchStatus):
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch:
            branch.status = status
            session.add(branch)
            session.commit()


def _get_branch(engine, branch_id) -> dict:
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if not branch:
            return {}
        return {
            "id": branch.id,
            "title": branch.title,
            "probability": branch.probability,
            "status": branch.status.value,
        }


def _save_narration(engine, branch_id, narration: dict):
    with Session(engine) as session:
        branch = session.get(Branch, branch_id)
        if branch:
            branch.story = _strip_round_markers(str(narration.get("story", "") or ""))
            branch.insight = _strip_round_markers(str(narration.get("insight", "") or ""))
            key_moments = narration.get("key_moments", [])
            if isinstance(key_moments, list):
                branch.key_moments = json.dumps(
                    [
                        cleaned
                        for item in key_moments
                        if (cleaned := _strip_round_markers(str(item)))
                    ],
                    ensure_ascii=False,
                )
            elif isinstance(key_moments, str):
                # LLM returned a string instead of list — wrap it
                cleaned_key_moment = _strip_round_markers(key_moments)
                branch.key_moments = json.dumps(
                    [cleaned_key_moment] if cleaned_key_moment else [],
                    ensure_ascii=False,
                )
            question_answer = _one_line_answer(
                _strip_round_markers(str(narration.get("question_answer") or "")),
            )
            parsed_context_updates: list[object] = []
            claim_compilation = narration.get(_BRANCH_NARRATIVE_COMPILATION_KEY)
            if isinstance(claim_compilation, dict):
                compilation_path = _json_path(
                    "result_quality",
                    "branch_narrative_claims_v1",
                )
                existing_compilations = func.coalesce(
                    func.json_extract(
                        _json_result_quality_object_expr(),
                        compilation_path,
                    ),
                    func.json("{}"),
                )
                merged_compilations = func.json_patch(
                    existing_compilations,
                    func.json_object(
                        branch.id,
                        _json_value(claim_compilation),
                    ),
                )
                parsed_context_updates.extend(
                    [compilation_path, merged_compilations]
                )
            if question_answer and settings.FEATURE_RESULT_VERDICT:
                branch_answers_expr = func.coalesce(
                    func.json_extract(
                        _json_result_quality_object_expr(),
                        _json_path("result_quality", "branch_question_answers"),
                    ),
                    func.json("{}"),
                )
                merged_answers_expr = func.json_patch(
                    branch_answers_expr,
                    func.json_object(branch.id, question_answer),
                )
                parsed_context_updates.extend(
                    [
                        _json_path(
                            "result_quality",
                            "branch_question_answers",
                        ),
                        merged_answers_expr,
                    ]
                )
            if parsed_context_updates:
                session.exec(
                    update(Scenario)
                    .where(Scenario.id == branch.scenario_id)
                    .values(
                        parsed_context=_json_set_parsed_context_expr(
                            *parsed_context_updates,
                            base_expr=_json_result_quality_object_expr(),
                        )
                    )
                )
            branch.status = BranchStatus.COMPLETED
            session.add(branch)
            session.commit()


def _save_round_summary(engine, branch_id, round_num, summary_text):
    with Session(engine) as session:
        r = session.exec(
            select(Round).where(Round.branch_id == branch_id, Round.round_number == round_num)
        ).first()
        if r:
            r.compressed_summary = summary_text
            session.add(r)
            session.commit()
