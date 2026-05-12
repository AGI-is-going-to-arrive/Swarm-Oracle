"""Debate Argument Map service — F6 structured argument extraction.

Extracts claim/evidence/rebuttal units from debate turns and
builds a directed argument graph linked to the verdict.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import threading
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.config import settings
from app.models.checkpoint import DebateArgumentUnit
from app.models.database import get_engine
from app.models.debate import DebateTurn
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.llm_client import (
    format_untrusted_text_block,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
)

logger = logging.getLogger(__name__)
_snapshot_index_lock = threading.Lock()
_snapshot_index_urls: set[str] = set()
_enrichment_apply_lock = threading.Lock()
_verdict_link_lock = threading.Lock()

# ── Keyword sets for rule-based classification ──────────────

_REBUTTAL_KEYWORDS = re.compile(
    r"\b(however|but|although|nevertheless|nonetheless|on the contrary)\b"
    r"|但是|然而|不过|虽然",
    re.IGNORECASE,
)
_EVIDENCE_KEYWORDS = re.compile(
    r"\b(because|evidence|study|studies|data|research|survey|experiment|statistic)\b"
    r"|研究|数据|证据|调查|实验|统计",
    re.IGNORECASE,
)

# Sentence-split pattern: ASCII sentence punctuation + whitespace,
# Chinese sentence punctuation, or newline.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|[。！？]|\n+")
_VALID_UNIT_TYPES = {"claim", "evidence", "rebuttal", "counter"}
_VALID_STANCES = {"supports_proposition", "supports_opposition", "neutral"}
_enrichment_tasks: set[asyncio.Task[Any]] = set()


def _split_sentences(content: str) -> list[str]:
    """Split content into non-empty trimmed sentences."""
    parts = _SENTENCE_SPLIT.split(content)
    return [s.strip() for s in parts if s.strip()]


def _classify_sentence(sentence: str) -> str:
    """Classify a sentence as claim / evidence / rebuttal."""
    if _REBUTTAL_KEYWORDS.search(sentence):
        return "rebuttal"
    if _EVIDENCE_KEYWORDS.search(sentence):
        return "evidence"
    return "claim"


def _semantic_hash(text: str) -> str:
    normalized = _normalize_unit_text(text).lower()
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def _normalize_unit_text(text: str) -> str:
    return " ".join((text or "").strip().split())


def _normalize_unit_type(value: str | None, fallback: str) -> str:
    normalized = (value or "").strip().lower()
    return normalized if normalized in _VALID_UNIT_TYPES else fallback


def _normalize_stance(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    return normalized if normalized in _VALID_STANCES else "neutral"


def _normalize_confidence(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, numeric))


def _claim_priority_key(
    *,
    round_number: int | None,
    sentence_index: int | None,
    node_key: str,
) -> tuple[int, int, str]:
    return (
        round_number or -1,
        sentence_index if sentence_index is not None else -1,
        node_key,
    )


def _select_opponent_claim_id(
    claims: list[dict[str, Any]],
    current_side: str,
) -> str | None:
    candidates = [
        claim
        for claim in claims
        if claim.get("speaker_side") and claim["speaker_side"] != current_side
    ]
    if not candidates:
        return None
    selected = max(
        candidates,
        key=lambda claim: _claim_priority_key(
            round_number=claim.get("round_number"),
            sentence_index=claim.get("sentence_index"),
            node_key=str(claim.get("node_key") or ""),
        ),
    )
    return str(selected["node_id"])


def _safe_parse_json(s: str | None):
    """Parse JSON safely; return None on failure."""
    if not s:
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return None


def _load_payload(payload_json: str | None) -> dict[str, Any]:
    if not payload_json:
        return {}
    try:
        loaded = json.loads(payload_json)
    except (TypeError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _normalize_side_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw or "").strip().lower()


def _load_latest_snapshot(session: Session, debate_id: str) -> GraphSnapshot | None:
    if session.connection().dialect.name == "sqlite":
        row = session.connection().exec_driver_sql(
            """
            SELECT id
            FROM graph_snapshot
            WHERE owner_type = ? AND owner_id = ? AND graph_kind = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
            """,
            ("debate", debate_id, "argument_map"),
        ).fetchone()
        return session.get(GraphSnapshot, row[0]) if row is not None else None

    stmt = select(GraphSnapshot).where(
        GraphSnapshot.owner_type == "debate",
        GraphSnapshot.owner_id == debate_id,
        GraphSnapshot.graph_kind == "argument_map",
    ).order_by(GraphSnapshot.created_at.desc(), GraphSnapshot.id.desc())
    return session.exec(stmt).first()


def _build_turn_metadata(
    session: Session,
    turn_ids: set[str],
) -> dict[str, dict[str, Any]]:
    if not turn_ids:
        return {}

    turns = session.exec(
        select(DebateTurn).where(DebateTurn.id.in_(turn_ids))
    ).all()
    metadata: dict[str, dict[str, Any]] = {}
    for turn in turns:
        sentence_positions: dict[str, int] = {}
        for index, sentence in enumerate(_split_sentences(turn.content or "")):
            sentence_positions.setdefault(_semantic_hash(sentence), index)
        metadata[turn.id] = {
            "sequence": turn.sequence,
            "speaker_side": _normalize_side_value(turn.speaker_side),
            "sentence_positions": sentence_positions,
        }
    return metadata


def _is_judge_side(side: str | None) -> bool:
    return (side or "").strip().lower() == "judge"


def _unit_rebuild_sort_key(
    *,
    unit: DebateArgumentUnit,
    node: GraphNode,
    turn_metadata: dict[str, dict[str, Any]],
) -> tuple[bool, int, bool, int, Any, str, str]:
    payload = _load_payload(node.payload_json)
    metadata = turn_metadata.get(unit.turn_id, {})
    turn_order = metadata.get("sequence")
    if turn_order is None:
        turn_order = node.round_number
    sentence_index = metadata.get("sentence_positions", {}).get(unit.semantic_hash)
    if sentence_index is None:
        payload_sentence_index = payload.get("sentence_index")
        if isinstance(payload_sentence_index, int):
            sentence_index = payload_sentence_index
    return (
        turn_order is None,
        turn_order or 0,
        sentence_index is None,
        sentence_index or 0,
        unit.created_at,
        node.node_key,
        unit.id,
    )


def _unit_verdict_sort_key(
    *,
    unit: DebateArgumentUnit,
    node: GraphNode | None,
    turn_metadata: dict[str, dict[str, Any]],
) -> tuple[bool, int, bool, int, Any, str]:
    payload = _load_payload(node.payload_json if node else None)
    metadata = turn_metadata.get(unit.turn_id, {})
    turn_order = metadata.get("sequence")
    if turn_order is None and node is not None:
        turn_order = node.round_number
    sentence_index = metadata.get("sentence_positions", {}).get(unit.semantic_hash)
    if sentence_index is None:
        payload_sentence_index = payload.get("sentence_index")
        if isinstance(payload_sentence_index, int):
            sentence_index = payload_sentence_index
    return (
        turn_order is None,
        turn_order or 0,
        sentence_index is None,
        sentence_index or 0,
        unit.created_at,
        unit.id,
    )


def _load_units_for_enrichment_sync(
    debate_id: str,
    turn_id: str,
) -> list[dict[str, str]]:
    with Session(get_engine()) as session:
        units = session.exec(
            select(DebateArgumentUnit).where(
                DebateArgumentUnit.debate_id == debate_id,
                DebateArgumentUnit.turn_id == turn_id,
            )
            .order_by(DebateArgumentUnit.created_at, DebateArgumentUnit.id)
        ).all()
    return [
        {
            "id": unit.id,
            "node_id": unit.node_id,
            "canonical_text": unit.canonical_text,
            "unit_type": unit.unit_type,
        }
        for unit in units
        if unit.canonical_text.strip()
    ]


def _rebuild_snapshot_edges_sync(
    session: Session,
    *,
    snapshot_id: str,
) -> None:
    existing_edges = session.exec(
        select(GraphEdge).where(
            GraphEdge.snapshot_id == snapshot_id,
            GraphEdge.edge_type.in_(["supports", "rebuts"]),
        )
    ).all()
    for edge in existing_edges:
        session.delete(edge)

    unit_rows = session.exec(
        select(DebateArgumentUnit, GraphNode)
        .join(GraphNode, GraphNode.id == DebateArgumentUnit.node_id)
        .where(GraphNode.snapshot_id == snapshot_id)
    ).all()

    if not unit_rows:
        return

    turn_metadata = _build_turn_metadata(
        session,
        {unit.turn_id for unit, _ in unit_rows if unit.turn_id},
    )
    unit_rows.sort(
        key=lambda row: _unit_rebuild_sort_key(
            unit=row[0],
            node=row[1],
            turn_metadata=turn_metadata,
        )
    )

    processed_claims: list[dict[str, Any]] = []
    current_turn_id: str | None = None
    last_claim_id: str | None = None
    for unit, node in unit_rows:
        payload = _load_payload(node.payload_json)
        speaker_side = str(payload.get("side") or "")
        if _is_judge_side(speaker_side):
            continue

        if unit.turn_id != current_turn_id:
            current_turn_id = unit.turn_id
            last_claim_id = None

        if unit.unit_type == "claim":
            last_claim_id = node.id
            processed_claims.append({
                "node_id": node.id,
                "speaker_side": speaker_side,
                "round_number": node.round_number,
                "sentence_index": (
                    payload.get("sentence_index")
                    if isinstance(payload.get("sentence_index"), int)
                    else None
                ),
                "node_key": node.node_key,
            })
        elif unit.unit_type == "evidence":
            target_id = last_claim_id
            if target_id is None:
                continue
            session.add(GraphEdge(
                snapshot_id=snapshot_id,
                source_node_id=node.id,
                target_node_id=target_id,
                edge_type="supports",
                weight=0.7,
                confidence_tier="medium",
                source_ref="rule_extraction",
            ))
        elif unit.unit_type in {"rebuttal", "counter"}:
            opp_claim = _select_opponent_claim_id(processed_claims, speaker_side)
            if opp_claim:
                session.add(GraphEdge(
                    snapshot_id=snapshot_id,
                    source_node_id=node.id,
                    target_node_id=opp_claim,
                    edge_type="rebuts",
                    weight=0.8,
                    confidence_tier="medium",
                    source_ref="rule_extraction",
                ))


def _apply_enriched_units_sync(
    *,
    speaker_side: str,
    unit_refs_by_text: dict[str, dict[str, str]],
    enriched_units: list[dict[str, Any]],
) -> int:
    updated = 0
    snapshot_id: str | None = None
    with _enrichment_apply_lock:
        with Session(get_engine()) as session:
            for item in enriched_units:
                if not isinstance(item, dict):
                    continue
                normalized_text = _normalize_unit_text(str(item.get("text", "")))
                if not normalized_text:
                    continue

                original_unit = unit_refs_by_text.get(normalized_text)
                if original_unit is None:
                    continue

                unit = session.get(DebateArgumentUnit, original_unit["id"])
                if unit is None:
                    continue

                next_type = _normalize_unit_type(item.get("type"), unit.unit_type)
                stance = _normalize_stance(item.get("stance"))
                confidence = _normalize_confidence(item.get("confidence"))

                node = session.get(GraphNode, original_unit["node_id"])
                if node is None:
                    continue
                if snapshot_id is None:
                    snapshot_id = node.snapshot_id

                unit.unit_type = next_type
                node.node_type = next_type

                payload = _load_payload(node.payload_json)
                payload["side"] = payload.get("side") or speaker_side
                payload["stance"] = stance
                payload["confidence"] = confidence
                payload["enriched_by"] = "llm"
                node.payload_json = json.dumps(payload, ensure_ascii=False)

                session.add(unit)
                session.add(node)
                updated += 1

            if updated:
                if snapshot_id is not None:
                    _rebuild_snapshot_edges_sync(
                        session,
                        snapshot_id=snapshot_id,
                    )
                session.commit()
    return updated


def _build_enrichment_prompt(
    *,
    debate_id: str,
    turn_id: str,
    speaker_side: str,
    language: str,
    unit_texts: list[str],
) -> str:
    unit_lines = [
        {"text": text, "speaker_side": speaker_side}
        for text in unit_texts
    ]
    return (
        "You are enriching an existing debate argument map.\n"
        f"Debate ID: {debate_id}\n"
        f"Turn ID: {turn_id}\n"
        f"Language: {language or 'auto'}\n"
        "Task:\n"
        "- Review the existing extracted argument units for this turn.\n"
        "- Keep one output item per input sentence.\n"
        "- Preserve the exact original text in the `text` field.\n"
        "- Reclassify `type` using only: claim, evidence, rebuttal, counter.\n"
        "- Assign `stance` using only: supports_proposition, supports_opposition, neutral.\n"
        "- Set `confidence` between 0 and 1.\n"
        "- If uncertain, keep the classification conservative.\n"
        "- Output strict JSON only in this shape: "
        "{\"units\":[{\"text\":\"...\",\"type\":\"claim\",\"stance\":\"neutral\",\"confidence\":0.5}]}\n"
        f"{format_untrusted_text_block('Existing argument units', json.dumps(unit_lines, ensure_ascii=False), max_chars=5000)}\n"  # noqa: E501
    )


def _find_opponent_last_claim(
    session: Session, snapshot_id: str, current_side: str,
) -> str | None:
    """Find the most recent opposing claim using turn/round plus sentence order."""
    stmt = (
        select(GraphNode)
        .where(
            GraphNode.snapshot_id == snapshot_id,
            GraphNode.node_type == "claim",
        )
        .order_by(
            GraphNode.round_number.desc().nulls_last(),
            GraphNode.node_key.asc(),
        )
    )
    candidates: list[dict[str, Any]] = []
    for node in session.exec(stmt):
        payload = _safe_parse_json(node.payload_json)
        candidates.append({
            "node_id": node.id,
            "speaker_side": str(payload.get("side") or "") if payload else "",
            "round_number": node.round_number,
            "sentence_index": payload.get("sentence_index") if payload else None,
            "node_key": node.node_key,
        })
    return _select_opponent_claim_id(candidates, current_side)


def _has_unique_index_columns(
    session: Session,
    *,
    table_name: str,
    expected_columns: tuple[str, ...],
) -> bool:
    indexes = session.connection().exec_driver_sql(
        f"PRAGMA index_list('{table_name}')"
    ).fetchall()
    for index in indexes:
        if not index[2]:
            continue
        index_name = index[1]
        columns = session.connection().exec_driver_sql(
            f"PRAGMA index_info('{index_name}')"
        ).fetchall()
        if tuple(row[2] for row in columns) == expected_columns:
            return True
    return False


def _dedupe_argument_map_snapshots(session: Session) -> None:
    duplicate_groups = session.connection().exec_driver_sql(
        """
        SELECT owner_type, owner_id, graph_kind
        FROM graph_snapshot
        GROUP BY owner_type, owner_id, graph_kind
        HAVING COUNT(*) > 1
        """
    ).fetchall()

    for owner_type, owner_id, graph_kind in duplicate_groups:
        snapshot_ids = [
            row[0]
            for row in session.connection().exec_driver_sql(
                """
                SELECT id
                FROM graph_snapshot
                WHERE owner_type = ? AND owner_id = ? AND graph_kind = ?
                ORDER BY created_at DESC, rowid DESC
                """,
                (owner_type, owner_id, graph_kind),
            ).fetchall()
        ]
        if len(snapshot_ids) < 2:
            continue

        duplicate_ids = snapshot_ids[1:]
        duplicate_node_ids = session.exec(
            select(GraphNode.id).where(GraphNode.snapshot_id.in_(duplicate_ids))
        ).all()

        if duplicate_node_ids:
            duplicate_units = session.exec(
                select(DebateArgumentUnit).where(DebateArgumentUnit.node_id.in_(duplicate_node_ids))
            ).all()
            for unit in duplicate_units:
                session.delete(unit)

            duplicate_edges = session.exec(
                select(GraphEdge).where(
                    (GraphEdge.snapshot_id.in_(duplicate_ids))
                    | (GraphEdge.source_node_id.in_(duplicate_node_ids))
                    | (GraphEdge.target_node_id.in_(duplicate_node_ids))
                )
            ).all()
        else:
            duplicate_edges = session.exec(
                select(GraphEdge).where(GraphEdge.snapshot_id.in_(duplicate_ids))
            ).all()

        for edge in duplicate_edges:
            session.delete(edge)

        duplicate_nodes = session.exec(
            select(GraphNode).where(GraphNode.snapshot_id.in_(duplicate_ids))
        ).all()
        for node in duplicate_nodes:
            session.delete(node)

        for duplicate_id in duplicate_ids:
            session.connection().exec_driver_sql(
                "DELETE FROM graph_snapshot WHERE id = ?",
                (duplicate_id,),
            )


def _ensure_argument_map_snapshot_index(engine) -> None:
    db_key = str(engine.url)
    with _snapshot_index_lock:
        if db_key in _snapshot_index_urls:
            return

        with Session(engine) as session:
            if session.connection().dialect.name == "sqlite":
                try:
                    if not _has_unique_index_columns(
                        session,
                        table_name="graph_snapshot",
                        expected_columns=("owner_type", "owner_id", "graph_kind"),
                    ):
                        _dedupe_argument_map_snapshots(session)
                        session.connection().exec_driver_sql(
                            "CREATE UNIQUE INDEX IF NOT EXISTS uq_graph_snapshot_owner_kind "
                            "ON graph_snapshot (owner_type, owner_id, graph_kind)"
                        )
                        session.commit()

                    if _has_unique_index_columns(
                        session,
                        table_name="graph_snapshot",
                        expected_columns=("owner_type", "owner_id", "graph_kind"),
                    ):
                        _snapshot_index_urls.add(db_key)
                        return
                    session.rollback()
                except Exception:
                    session.rollback()
                    logger.debug(
                        "argument_map snapshot unique index ensure failed",
                        exc_info=True,
                    )
                    return

        _snapshot_index_urls.add(db_key)


def _get_or_create_snapshot(
    session: Session, debate_id: str,
) -> GraphSnapshot:
    """Return existing argument_map snapshot or create a new one."""
    snapshot = _load_latest_snapshot(session, debate_id)
    if snapshot is None:
        try:
            with session.begin_nested():
                snapshot = GraphSnapshot(
                    owner_type="debate",
                    owner_id=debate_id,
                    graph_kind="argument_map",
                )
                session.add(snapshot)
                session.flush()  # ensure id is populated
        except IntegrityError:
            snapshot = _load_latest_snapshot(session, debate_id)
            if snapshot is None:
                raise
    return snapshot


def extract_argument_units(
    debate_id: str, turn_id: str, content: str, speaker_side: str,
    *, turn_sequence: int | None = None,
) -> list[str]:
    """Extract argument units from a debate turn, return created unit IDs.

    Rule-based v1 (no LLM):
    - Split into sentences
    - Classify each as claim / evidence / rebuttal
    - Deduplicate by semantic_hash within the same turn
    - Create GraphNode + DebateArgumentUnit per sentence
    """
    sentences = _split_sentences(content)
    if not sentences:
        return []

    created_ids: list[str] = []
    engine = get_engine()
    _ensure_argument_map_snapshot_index(engine)
    with Session(engine) as session:
        snapshot = _get_or_create_snapshot(session, debate_id)

        # Load existing hashes for dedup within this turn.
        existing_stmt = select(DebateArgumentUnit.semantic_hash).where(
            DebateArgumentUnit.debate_id == debate_id,
            DebateArgumentUnit.turn_id == turn_id,
        )
        existing_hashes: set[str] = set(session.exec(existing_stmt).all())

        turn_nodes: list[tuple[str, str]] = []  # (node_id, unit_type)

        for sentence_index, sentence in enumerate(sentences):
            h = _semantic_hash(sentence)
            if h in existing_hashes:
                continue

            unit_type = _classify_sentence(sentence)

            try:
                with session.begin_nested():
                    node = GraphNode(
                        snapshot_id=snapshot.id,
                        node_key=h,
                        node_type=unit_type,
                        label=sentence[:120],
                        round_number=turn_sequence,
                        ref_model="debate_turn",
                        ref_id=turn_id,
                        payload_json=json.dumps({
                            "side": speaker_side,
                            "sentence_index": sentence_index,
                        }),
                    )
                    session.add(node)
                    session.flush()

                    unit = DebateArgumentUnit(
                        debate_id=debate_id,
                        turn_id=turn_id,
                        node_id=node.id,
                        unit_type=unit_type,
                        status="standing",
                        canonical_text=sentence,
                        semantic_hash=h,
                    )
                    session.add(unit)
                    session.flush()
            except IntegrityError as exc:
                exc_msg = str(getattr(exc, "orig", exc)).lower()
                if (
                    "uq_debate_argument_unit_debate_turn_hash" in exc_msg
                    or "uq_debate_argument_unit_debate_hash" in exc_msg
                    or "semantic_hash" in exc_msg
                ):
                    logger.info(
                        "extract_argument_units dedup race debate=%s turn=%s hash=%s",
                        debate_id, turn_id, h,
                    )
                    continue
                raise

            existing_hashes.add(h)
            created_ids.append(unit.id)
            turn_nodes.append((node.id, unit_type))

        # A7: Same-turn intra-edges (evidence→claim, rebuttal→opponent claim)
        if not _is_judge_side(speaker_side):
            last_claim_id: str | None = None
            for nid, utype in turn_nodes:
                if utype == "claim":
                    last_claim_id = nid
                elif utype == "evidence" and last_claim_id is not None:
                    session.add(GraphEdge(
                        snapshot_id=snapshot.id, source_node_id=nid,
                        target_node_id=last_claim_id, edge_type="supports", weight=0.7,
                        confidence_tier="medium", source_ref="rule_extraction",
                    ))
                elif utype in {"rebuttal", "counter"}:
                    opp_claim = _find_opponent_last_claim(session, snapshot.id, speaker_side)
                    if opp_claim:
                        session.add(GraphEdge(
                            snapshot_id=snapshot.id, source_node_id=nid,
                            target_node_id=opp_claim, edge_type="rebuts", weight=0.8,
                            confidence_tier="medium", source_ref="rule_extraction",
                        ))

        session.commit()

    logger.info(
        "extract_argument_units debate=%s turn=%s created=%d",
        debate_id, turn_id, len(created_ids),
    )
    return created_ids


async def enrich_argument_units_for_turn(
    *,
    debate_id: str,
    turn_id: str,
    speaker_side: str,
    language: str,
    llm_overrides: dict[str, Any] | None = None,
    quota_key: str | None = None,
) -> int:
    """Optionally enrich one turn's argument units with a single LLM call.

    This updates unit/node types and stores stance/confidence in node payloads,
    while preserving the existing rule-based extraction as the fallback source
    of truth.
    """
    if not settings.ARGUMENT_MAP_LLM_ENRICHMENT:
        return 0

    units = await asyncio.to_thread(
        _load_units_for_enrichment_sync,
        debate_id,
        turn_id,
    )
    if not units:
        return 0

    unit_texts = [unit["canonical_text"] for unit in units]
    if not unit_texts:
        return 0

    prompt = _build_enrichment_prompt(
        debate_id=debate_id,
        turn_id=turn_id,
        speaker_side=speaker_side,
        language=language,
        unit_texts=unit_texts,
    )
    overrides = llm_overrides or {}

    with llm_request_scope(
        quota_key=f"user:{quota_key}" if quota_key else None,
        purpose="debate_argument_map_enrichment",
        requests_per_minute=overrides.get("requests_per_minute"),
        tokens_per_minute=overrides.get("tokens_per_minute"),
    ):
        result = await llm_call_json_with_stream_fallback(
            prompt,
            reasoning_effort=overrides.get("reasoning_effort") or "low",
            model=overrides.get("model"),
            api_key=overrides.get("api_key"),
            base_url=overrides.get("base_url"),
        )

    enriched_units = result.get("units")
    if not isinstance(enriched_units, list):
        return 0

    by_text: dict[str, dict[str, str]] = {
        _normalize_unit_text(unit["canonical_text"]): unit
        for unit in units
    }
    updated = await asyncio.to_thread(
        _apply_enriched_units_sync,
        speaker_side=speaker_side,
        unit_refs_by_text=by_text,
        enriched_units=enriched_units,
    )

    if updated:
        logger.info(
            "enrich_argument_units_for_turn debate=%s turn=%s updated=%d",
            debate_id, turn_id, updated,
        )
    return updated


def _finalize_enrichment_task(task: asyncio.Task[Any]) -> None:
    _enrichment_tasks.discard(task)
    try:
        task.result()
    except Exception:
        logger.debug("argument map enrichment failed (non-blocking)", exc_info=True)


def schedule_argument_enrichment_for_turn(
    *,
    debate_id: str,
    turn_id: str,
    speaker_side: str,
    language: str,
    llm_overrides: dict[str, Any] | None = None,
    quota_key: str | None = None,
) -> bool:
    """Schedule a fire-and-forget enrichment task for one debate turn."""
    if not settings.ARGUMENT_MAP_LLM_ENRICHMENT:
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False

    task = loop.create_task(
        enrich_argument_units_for_turn(
            debate_id=debate_id,
            turn_id=turn_id,
            speaker_side=speaker_side,
            language=language,
            llm_overrides=llm_overrides,
            quota_key=quota_key,
        )
    )
    _enrichment_tasks.add(task)
    task.add_done_callback(_finalize_enrichment_task)
    return True


def link_verdict(debate_id: str, verdict_data: dict) -> None:
    """Link a verdict to the argument map — truly idempotent.

    Re-queries ALL units (not just standing), resets all statuses,
    creates/reuses verdict node, clears+rebuilds verdict edges.
    unit.status and edge_type are always aligned (no dual semantics).
    """
    rationale = verdict_data.get("judge_rationale") or verdict_data
    raw_turns = rationale.get("supporting_turns", [])
    supporting_turn_ids: set[str] = set()
    for item in raw_turns:
        if isinstance(item, dict):
            turn_id = item.get("id", "")
            if turn_id:
                supporting_turn_ids.add(str(turn_id))
        elif isinstance(item, str):
            supporting_turn_ids.add(item)
    winner = str(verdict_data.get("winner") or "").strip().lower()

    engine = get_engine()
    _ensure_argument_map_snapshot_index(engine)
    with _verdict_link_lock, Session(engine) as session:
        snapshot = _get_or_create_snapshot(session, debate_id)

        # Step 1: Re-query ALL units for full re-evaluation
        all_debate_units = session.exec(
            select(DebateArgumentUnit)
            .where(DebateArgumentUnit.debate_id == debate_id)
            .order_by(DebateArgumentUnit.created_at.asc(), DebateArgumentUnit.id.asc())
        ).all()

        node_ids = list({unit.node_id for unit in all_debate_units if unit.node_id})
        node_map: dict[str, GraphNode] = {}
        if node_ids:
            nodes = session.exec(
                select(GraphNode).where(GraphNode.id.in_(node_ids))
            ).all()
            node_map = {node.id: node for node in nodes}

        all_units = [
            unit
            for unit in all_debate_units
            if not unit.node_id
            or unit.node_id not in node_map
            or node_map[unit.node_id].snapshot_id == snapshot.id
        ]
        turn_metadata = _build_turn_metadata(
            session,
            {unit.turn_id for unit in all_units if unit.turn_id},
        )
        all_units.sort(
            key=lambda unit: _unit_verdict_sort_key(
                unit=unit,
                node=node_map.get(unit.node_id),
                turn_metadata=turn_metadata,
            )
        )
        turn_side_map = {
            turn_id: _normalize_side_value(metadata.get("speaker_side"))
            for turn_id, metadata in turn_metadata.items()
            if metadata.get("speaker_side") is not None
        }
        node_side_map: dict[str, str] = {}
        for node_id, node in node_map.items():
            if node.snapshot_id != snapshot.id:
                continue
            payload = _load_payload(node.payload_json)
            side = _normalize_side_value(payload.get("side"))
            if not side and node.ref_id:
                side = turn_side_map.get(node.ref_id, "")
            node_side_map[node_id] = side

        rebuts_edges = session.exec(
            select(GraphEdge).where(
                GraphEdge.snapshot_id == snapshot.id,
                GraphEdge.edge_type == "rebuts",
            )
        ).all()
        rebutted_node_ids = {
            edge.target_node_id
            for edge in rebuts_edges
            if (
                node_side_map.get(edge.source_node_id)
                and node_side_map.get(edge.target_node_id)
                and node_side_map[edge.source_node_id] != node_side_map[edge.target_node_id]
            )
        }

        # Step 2: Reset ALL unit statuses — aligned with edge types below
        for unit in all_units:
            side = node_side_map.get(unit.node_id, "") or turn_side_map.get(unit.turn_id, "")
            is_winner = side == winner
            is_known_loser = bool(side and winner and side != winner)
            has_rebuts = unit.node_id in rebutted_node_ids
            in_supporting = unit.turn_id in supporting_turn_ids

            if in_supporting and (is_winner or not side):
                unit.status = "accepted"
            elif has_rebuts and is_known_loser:
                unit.status = "rejected"
            elif has_rebuts and is_winner:
                unit.status = "rebutted"
            elif is_winner:
                unit.status = "standing"
            else:
                unit.status = "unaddressed"

        if not supporting_turn_ids:
            winner_standing = [
                unit
                for unit in all_units
                if unit.status == "standing" and unit.unit_type == "claim"
            ]
            for unit in winner_standing[:3]:
                unit.status = "accepted"

        for unit in all_units:
            session.add(unit)

        # Step 3: Idempotent verdict node (reuse by fixed node_key)
        verdict_key = f"verdict_{debate_id}"
        existing_verdict_nodes = session.exec(
            select(GraphNode).where(
                GraphNode.snapshot_id == snapshot.id,
                GraphNode.node_key == verdict_key,
            ).order_by(GraphNode.id.asc())
        ).all()
        existing_verdict = existing_verdict_nodes[0] if existing_verdict_nodes else None
        winner_raw = str(verdict_data.get("winner") or "").strip()
        tone_raw = str(verdict_data.get("verdict_tone") or "Verdict").strip()
        if winner_raw:
            verdict_label_text = f"{winner_raw} · {tone_raw}"
        else:
            verdict_label_text = tone_raw
        payload_json = json.dumps({
            "winner": verdict_data.get("winner"),
            "verdict_tone": verdict_data.get("verdict_tone"),
            "judge_summary": str(
                verdict_data.get("judge_summary") or verdict_data.get("best_argument") or ""
            )[:300],
        })

        if existing_verdict:
            verdict_node = existing_verdict
            verdict_node.label = verdict_label_text[:120]
            verdict_node.payload_json = payload_json
            session.add(verdict_node)
            # Clear ALL edges from verdict nodes before rebuild (covers legacy
            # types and any duplicates left by older/concurrent runs).
            old_verdict_ids = [node.id for node in existing_verdict_nodes]
            old_edges = session.exec(
                select(GraphEdge).where(
                    GraphEdge.snapshot_id == snapshot.id,
                    GraphEdge.source_node_id.in_(old_verdict_ids),
                )
            ).all()
            for oe in old_edges:
                session.delete(oe)
            for duplicate in existing_verdict_nodes[1:]:
                session.delete(duplicate)
            session.flush()
        else:
            verdict_node = GraphNode(
                snapshot_id=snapshot.id,
                node_key=verdict_key,
                node_type="verdict",
                label=verdict_label_text[:120],
                payload_json=payload_json,
            )
            session.add(verdict_node)
            session.flush()

        # Step 4: Rebuild edges — edge_type MATCHES unit.status
        for unit in all_units:
            if not unit.node_id or unit.node_id not in node_side_map:
                continue
            session.add(GraphEdge(
                snapshot_id=snapshot.id,
                source_node_id=verdict_node.id,
                target_node_id=unit.node_id,
                edge_type=unit.status, weight=1.0,
                confidence_tier="high",
                source_ref="verdict_linking",
            ))

        session.commit()

    logger.info(
        "link_verdict debate=%s supporting_turn_ids=%s units=%d",
        debate_id, supporting_turn_ids, len(all_units),
    )


def get_argument_map(debate_id: str) -> dict:
    """Return the serialized argument map graph for a debate.

    Returns ``{snapshot_id, nodes, edges, units}`` or an empty structure
    if no snapshot exists.
    """
    empty: dict = {"snapshot_id": None, "nodes": [], "edges": [], "units": []}

    engine = get_engine()
    _ensure_argument_map_snapshot_index(engine)
    with Session(engine) as session:
        snapshot = _load_latest_snapshot(session, debate_id)
        if snapshot is None:
            return empty

        nodes_stmt = select(GraphNode).where(
            GraphNode.snapshot_id == snapshot.id,
        )
        nodes = session.exec(nodes_stmt).all()

        edges_stmt = select(GraphEdge).where(
            GraphEdge.snapshot_id == snapshot.id,
        )
        node_ids = {node.id for node in nodes}
        edges = [
            edge for edge in session.exec(edges_stmt).all()
            if edge.source_node_id in node_ids and edge.target_node_id in node_ids
        ]

        units_stmt = (
            select(DebateArgumentUnit)
            .join(GraphNode, GraphNode.id == DebateArgumentUnit.node_id)
            .where(
                DebateArgumentUnit.debate_id == debate_id,
                GraphNode.snapshot_id == snapshot.id,
            )
        )
        units = session.exec(units_stmt).all()

        return {
            "snapshot_id": snapshot.id,
            "nodes": [
                {
                    "id": n.id,
                    "key": n.node_key,
                    "type": n.node_type,
                    "label": n.label,
                    "round": n.round_number,
                    "payload": _safe_parse_json(n.payload_json),
                }
                for n in nodes
            ],
            "edges": [
                {
                    "id": e.id,
                    "source": e.source_node_id,
                    "target": e.target_node_id,
                    "type": e.edge_type,
                    "weight": e.weight,
                    "label": e.label,
                    "evidence": {
                        "confidence_tier": e.confidence_tier,
                        "source_ref": e.source_ref,
                        "source_round_number": e.source_round_number,
                        "detail": e.evidence_json,
                    } if (
                        e.confidence_tier
                        or e.source_ref
                        or e.source_round_number is not None
                        or e.evidence_json
                    ) else None,
                }
                for e in edges
            ],
            "units": [
                {
                    "id": u.id,
                    "type": u.unit_type,
                    "status": u.status,
                    "text": u.canonical_text,
                    "turn_id": u.turn_id,
                    "node_id": u.node_id,
                }
                for u in units
            ],
        }
