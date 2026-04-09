"""Debate Argument Map service — F6 structured argument extraction.

Extracts claim/evidence/rebuttal units from debate turns and
builds a directed argument graph linked to the verdict.
"""

from __future__ import annotations

import hashlib
import logging
import re

from sqlmodel import Session, select

from app.models.checkpoint import DebateArgumentUnit
from app.models.database import get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot

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

        for sentence in sentences:
            h = _semantic_hash(sentence)
            if h in existing_hashes:
                continue
            existing_hashes.add(h)

            unit_type = _classify_sentence(sentence)

            node = GraphNode(
                snapshot_id=snapshot.id,
                node_key=h,
                node_type=unit_type,
                label=sentence[:120],
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
            created_ids.append(unit.id)

        session.commit()

    logger.info(
        "extract_argument_units debate=%s turn=%s created=%d",
        debate_id, turn_id, len(created_ids),
    )
    return created_ids


def link_verdict(debate_id: str, verdict_data: dict) -> None:
    """Link a verdict to the argument map — mark accepted/unaddressed units.

    If verdict_data has ``supporting_turns`` (list of turn_ids), units from
    those turns are marked ``accepted``; remaining ``standing`` units become
    ``unaddressed``.
    """
    # Extract supporting turn IDs from judge_rationale.
    # verdict_data may be finalized_summary (with nested judge_rationale)
    # or judge_rationale directly. supporting_turns may be list[str] or list[dict].
    rationale = verdict_data.get("judge_rationale") or verdict_data
    raw_turns = rationale.get("supporting_turns", [])
    supporting_turn_ids: set[str] = set()
    for item in raw_turns:
        if isinstance(item, dict):
            supporting_turn_ids.add(item.get("id", ""))
        elif isinstance(item, str):
            supporting_turn_ids.add(item)

    with Session(get_engine()) as session:
        stmt = select(DebateArgumentUnit).where(
            DebateArgumentUnit.debate_id == debate_id,
            DebateArgumentUnit.status == "standing",
        )
        standing_units = session.exec(stmt).all()

        for unit in standing_units:
            if unit.turn_id in supporting_turn_ids:
                unit.status = "accepted"
            else:
                unit.status = "unaddressed"
            session.add(unit)

        session.commit()

    logger.info(
        "link_verdict debate=%s supporting_turn_ids=%s standing=%d",
        debate_id, supporting_turn_ids, len(standing_units),
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
                    "node_key": n.node_key,
                    "node_type": n.node_type,
                    "label": n.label,
                    "ref_id": n.ref_id,
                    "payload_json": n.payload_json,
                }
                for n in nodes
            ],
            "edges": [
                {
                    "id": e.id,
                    "source_node_id": e.source_node_id,
                    "target_node_id": e.target_node_id,
                    "edge_type": e.edge_type,
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
                }
                for u in units
            ],
        }
