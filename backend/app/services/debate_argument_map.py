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
from typing import Any

from sqlalchemy.exc import IntegrityError

from sqlmodel import Session, select

from app.config import settings
from app.models.checkpoint import DebateArgumentUnit
from app.models.database import get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.llm_client import (
    format_untrusted_text_block,
    llm_call_json_with_stream_fallback,
    llm_request_scope,
)

logger = logging.getLogger(__name__)

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

# Sentence-split pattern: period-space, Chinese period, or newline
_SENTENCE_SPLIT = re.compile(r"(?<=\.)\s+|。|\n")
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
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()[:16]


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


def _rebuild_turn_edges_sync(
    session: Session,
    *,
    snapshot_id: str,
    speaker_side: str,
    unit_refs: list[dict[str, str]],
) -> None:
    source_node_ids = [
        ref["node_id"]
        for ref in unit_refs
        if ref.get("node_id")
    ]
    if not source_node_ids:
        return

    existing_edges = session.exec(
        select(GraphEdge).where(
            GraphEdge.snapshot_id == snapshot_id,
            GraphEdge.source_node_id.in_(source_node_ids),
            GraphEdge.edge_type.in_(["supports", "rebuts"]),
        )
    ).all()
    for edge in existing_edges:
        session.delete(edge)

    last_claim_id: str | None = None
    for ref in unit_refs:
        unit = session.get(DebateArgumentUnit, ref["id"])
        node = session.get(GraphNode, ref["node_id"])
        if unit is None or node is None:
            continue

        if unit.unit_type == "claim":
            last_claim_id = node.id
        elif unit.unit_type == "evidence" and last_claim_id is not None:
            session.add(GraphEdge(
                snapshot_id=snapshot_id,
                source_node_id=node.id,
                target_node_id=last_claim_id,
                edge_type="supports",
                weight=0.7,
            ))
        elif unit.unit_type == "rebuttal":
            opp_claim = _find_opponent_last_claim(session, snapshot_id, speaker_side)
            if opp_claim:
                session.add(GraphEdge(
                    snapshot_id=snapshot_id,
                    source_node_id=node.id,
                    target_node_id=opp_claim,
                    edge_type="rebuts",
                    weight=0.8,
                ))


def _apply_enriched_units_sync(
    *,
    speaker_side: str,
    unit_refs_by_text: dict[str, dict[str, str]],
    unit_refs: list[dict[str, str]],
    enriched_units: list[dict[str, Any]],
) -> int:
    updated = 0
    snapshot_id: str | None = None
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
                _rebuild_turn_edges_sync(
                    session,
                    snapshot_id=snapshot_id,
                    speaker_side=speaker_side,
                    unit_refs=unit_refs,
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
    """Find most recent opposing claim. V1 heuristic.

    Strategy: highest round_number wins (= most recent turn).
    Same-round tiebreak: lowest node_key ASC (stable arbitrary;
    node_key is SHA-256 hash of sentence text, deterministic but
    NOT positional).
    """
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
    for node in session.exec(stmt):
        payload = _safe_parse_json(node.payload_json)
        if payload and payload.get("side") and payload["side"] != current_side:
            return node.id
    return None


def _get_or_create_snapshot(
    session: Session, debate_id: str,
) -> GraphSnapshot:
    """Return existing argument_map snapshot or create a new one."""
    stmt = select(GraphSnapshot).where(
        GraphSnapshot.owner_type == "debate",
        GraphSnapshot.owner_id == debate_id,
        GraphSnapshot.graph_kind == "argument_map",
    )
    snapshot = session.exec(stmt).first()
    if snapshot is None:
        snapshot = GraphSnapshot(
            owner_type="debate",
            owner_id=debate_id,
            graph_kind="argument_map",
        )
        session.add(snapshot)
        session.flush()  # ensure id is populated
    return snapshot


def extract_argument_units(
    debate_id: str, turn_id: str, content: str, speaker_side: str,
    *, turn_sequence: int | None = None,
) -> list[str]:
    """Extract argument units from a debate turn, return created unit IDs.

    Rule-based v1 (no LLM):
    - Split into sentences
    - Classify each as claim / evidence / rebuttal
    - Deduplicate by semantic_hash within the same debate
    - Create GraphNode + DebateArgumentUnit per sentence
    """
    sentences = _split_sentences(content)
    if not sentences:
        return []

    created_ids: list[str] = []
    with Session(get_engine()) as session:
        snapshot = _get_or_create_snapshot(session, debate_id)

        # Load existing hashes for dedup within this debate
        existing_stmt = select(DebateArgumentUnit.semantic_hash).where(
            DebateArgumentUnit.debate_id == debate_id,
        )
        existing_hashes: set[str] = set(session.exec(existing_stmt).all())

        turn_nodes: list[tuple[str, str]] = []  # (node_id, unit_type)

        for sentence in sentences:
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
                        payload_json=f'{{"side":"{speaker_side}"}}',
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
                if "uq_debate_argument_unit_debate_hash" in exc_msg or "semantic_hash" in exc_msg:
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
        last_claim_id: str | None = None
        for nid, utype in turn_nodes:
            if utype == "claim":
                last_claim_id = nid
            elif utype == "evidence" and last_claim_id is not None:
                session.add(GraphEdge(
                    snapshot_id=snapshot.id, source_node_id=nid,
                    target_node_id=last_claim_id, edge_type="supports", weight=0.7,
                ))
            elif utype == "rebuttal":
                opp_claim = _find_opponent_last_claim(session, snapshot.id, speaker_side)
                if opp_claim:
                    session.add(GraphEdge(
                        snapshot_id=snapshot.id, source_node_id=nid,
                        target_node_id=opp_claim, edge_type="rebuts", weight=0.8,
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
        unit_refs=units,
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
            supporting_turn_ids.add(item.get("id", ""))
        elif isinstance(item, str):
            supporting_turn_ids.add(item)

    with Session(get_engine()) as session:
        # Step 1: Re-query ALL units for full re-evaluation
        all_units_stmt = select(DebateArgumentUnit).where(
            DebateArgumentUnit.debate_id == debate_id,
        )
        all_units = session.exec(all_units_stmt).all()

        # Step 2: Reset ALL unit statuses — aligned with edge types below
        for unit in all_units:
            if unit.turn_id in supporting_turn_ids:
                unit.status = "accepted"
            else:
                unit.status = "unaddressed"
            session.add(unit)

        # Step 3: Idempotent verdict node (reuse by fixed node_key)
        snapshot = _get_or_create_snapshot(session, debate_id)
        verdict_key = f"verdict_{debate_id}"
        existing_verdict = session.exec(
            select(GraphNode).where(
                GraphNode.snapshot_id == snapshot.id,
                GraphNode.node_key == verdict_key,
            )
        ).first()

        if existing_verdict:
            verdict_node = existing_verdict
            verdict_node.label = str(verdict_data.get("verdict_tone", "Verdict"))[:120]
            verdict_node.payload_json = json.dumps({
                "winner": verdict_data.get("winner"),
                "verdict_tone": verdict_data.get("verdict_tone"),
            })
            session.add(verdict_node)
            # Clear ALL edges from verdict node before rebuild (covers legacy types)
            old_edges = session.exec(
                select(GraphEdge).where(
                    GraphEdge.snapshot_id == snapshot.id,
                    GraphEdge.source_node_id == verdict_node.id,
                )
            ).all()
            for oe in old_edges:
                session.delete(oe)
            session.flush()
        else:
            verdict_label = verdict_data.get("verdict_tone", "Verdict")
            verdict_node = GraphNode(
                snapshot_id=snapshot.id,
                node_key=verdict_key,
                node_type="verdict",
                label=str(verdict_label)[:120],
                payload_json=json.dumps({
                    "winner": verdict_data.get("winner"),
                    "verdict_tone": verdict_data.get("verdict_tone"),
                }),
            )
            session.add(verdict_node)
            session.flush()

        # Step 4: Rebuild edges — edge_type MATCHES unit.status
        for unit in all_units:
            if not unit.node_id:
                continue
            edge_type = "accepted" if unit.turn_id in supporting_turn_ids else "unaddressed"
            session.add(GraphEdge(
                snapshot_id=snapshot.id,
                source_node_id=verdict_node.id,
                target_node_id=unit.node_id,
                edge_type=edge_type, weight=1.0,
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

    with Session(get_engine()) as session:
        stmt = select(GraphSnapshot).where(
            GraphSnapshot.owner_type == "debate",
            GraphSnapshot.owner_id == debate_id,
            GraphSnapshot.graph_kind == "argument_map",
        )
        snapshot = session.exec(stmt).first()
        if snapshot is None:
            return empty

        nodes_stmt = select(GraphNode).where(
            GraphNode.snapshot_id == snapshot.id,
        )
        nodes = session.exec(nodes_stmt).all()

        edges_stmt = select(GraphEdge).where(
            GraphEdge.snapshot_id == snapshot.id,
        )
        edges = session.exec(edges_stmt).all()

        units_stmt = select(DebateArgumentUnit).where(
            DebateArgumentUnit.debate_id == debate_id,
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
