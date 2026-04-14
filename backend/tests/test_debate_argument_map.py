"""Tests for debate_argument_map service (F6 — Phase C2)."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from sqlmodel import Session, select

from app.config import settings
from app.models.checkpoint import DebateArgumentUnit
from app.models.database import get_engine
from app.models.debate import DebateTurn
from app.services.debate_argument_map import (
    enrich_argument_units_for_turn,
    extract_argument_units,
    get_argument_map,
    link_verdict,
)

# ── extract_argument_units ──────────────────────────────────


def test_extract_claims_from_simple_text():
    """Simple sentences without keywords should be classified as claims."""
    ids = extract_argument_units(
        debate_id="d1", turn_id="t1",
        content="AI will change the world. Robots are useful.",
        speaker_side="proposition",
    )
    assert len(ids) == 2
    result = get_argument_map("d1")
    types = {u["type"] for u in result["units"]}
    assert types == {"claim"}


def test_extract_detects_rebuttals():
    """Sentences with however/but should be classified as rebuttal."""
    ids = extract_argument_units(
        debate_id="d-reb", turn_id="t1",
        content="This is fine. However the cost is too high. But we can adapt.",
        speaker_side="opposition",
    )
    assert len(ids) == 3
    result = get_argument_map("d-reb")
    rebuttal_count = sum(1 for u in result["units"] if u["type"] == "rebuttal")
    assert rebuttal_count == 2


def test_extract_detects_rebuttals_chinese():
    """Chinese rebuttal keywords should also be detected."""
    ids = extract_argument_units(
        debate_id="d-reb-zh", turn_id="t1",
        content="这很好。然而成本太高。不过可以适应。",
        speaker_side="opposition",
    )
    assert len(ids) == 3
    result = get_argument_map("d-reb-zh")
    rebuttal_count = sum(1 for u in result["units"] if u["type"] == "rebuttal")
    assert rebuttal_count == 2


def test_extract_detects_evidence_keywords():
    """Sentences with evidence/study/data should be classified as evidence."""
    ids = extract_argument_units(
        debate_id="d-evi", turn_id="t1",
        content="A 2024 study shows improvement. The data confirms the trend.",
        speaker_side="proposition",
    )
    assert len(ids) == 2
    result = get_argument_map("d-evi")
    evidence_count = sum(1 for u in result["units"] if u["type"] == "evidence")
    assert evidence_count == 2


def test_extract_splits_question_and_exclamation_sentences_in_english():
    ids = extract_argument_units(
        debate_id="d-punct-en",
        turn_id="t1",
        content="Will this work? Yes! It should.",
        speaker_side="proposition",
    )

    assert len(ids) == 3
    result = get_argument_map("d-punct-en")
    texts = {unit["text"] for unit in result["units"]}
    assert "Will this work?" in texts
    assert "Yes!" in texts
    assert "It should." in texts


def test_extract_splits_question_and_exclamation_sentences_in_chinese():
    ids = extract_argument_units(
        debate_id="d-punct-zh",
        turn_id="t1",
        content="这会成功吗？会！当然会。",
        speaker_side="proposition",
    )

    assert len(ids) == 3
    result = get_argument_map("d-punct-zh")
    texts = {unit["text"] for unit in result["units"]}
    assert "这会成功吗" in texts
    assert "会" in texts
    assert "当然会" in texts


def test_extract_deduplicates_by_semantic_hash():
    """Identical sentences (case-insensitive) should be deduplicated."""
    ids1 = extract_argument_units(
        debate_id="d-dedup", turn_id="t1",
        content="AI is great. AI is great.",
        speaker_side="proposition",
    )
    # Second call with same text from a different turn
    ids2 = extract_argument_units(
        debate_id="d-dedup", turn_id="t2",
        content="AI IS GREAT.",
        speaker_side="opposition",
    )
    assert len(ids1) == 1  # dedup within same turn content
    assert len(ids2) == 0  # dedup across turns


def test_extract_empty_content_returns_empty():
    """Empty or whitespace-only content should return no units."""
    ids = extract_argument_units(
        debate_id="d-empty", turn_id="t1",
        content="   ",
        speaker_side="proposition",
    )
    assert ids == []


# ── link_verdict ────────────────────────────────────────────


def test_link_verdict_marks_accepted_and_unaddressed():
    """Verdict marks matching turn units as accepted, rest as unaddressed."""
    extract_argument_units(
        debate_id="d-verdict", turn_id="t1",
        content="Claim from turn one.",
        speaker_side="proposition",
    )
    extract_argument_units(
        debate_id="d-verdict", turn_id="t2",
        content="Claim from turn two.",
        speaker_side="opposition",
    )

    link_verdict("d-verdict", {"supporting_turns": ["t1"]})

    result = get_argument_map("d-verdict")
    statuses = {u["turn_id"]: u["status"] for u in result["units"]}
    assert statuses["t1"] == "accepted"
    assert statuses["t2"] == "unaddressed"


def test_link_verdict_no_supporting_turns_marks_all_unaddressed():
    """Without supporting_turns, all standing units become unaddressed."""
    extract_argument_units(
        debate_id="d-vnosupp", turn_id="t1",
        content="Some claim.",
        speaker_side="proposition",
    )

    link_verdict("d-vnosupp", {})

    result = get_argument_map("d-vnosupp")
    assert all(u["status"] == "unaddressed" for u in result["units"])


def test_link_verdict_with_finalized_summary_dict_shape():
    """Verdict linking works with finalized_summary dict items in supporting_turns."""
    extract_argument_units(
        debate_id="d-vdict", turn_id="t10",
        content="AI improves productivity.",
        speaker_side="proposition",
    )
    extract_argument_units(
        debate_id="d-vdict", turn_id="t20",
        content="However, job losses are real.",
        speaker_side="opposition",
    )

    # Simulate the finalized_summary shape from _finalize_debate
    finalized_summary = {
        "winner": "proposition",
        "judge_rationale": {
            "winner_reason": "stronger evidence",
            "supporting_turns": [
                {"id": "t10", "phase": "opening", "speaker_side": "proposition",
                 "speaker_name": "Alice", "quote": "AI improves productivity.",
                 "why_it_matters": "key argument"},
            ],
        },
    }
    link_verdict("d-vdict", finalized_summary)

    result = get_argument_map("d-vdict")
    statuses = {u["turn_id"]: u["status"] for u in result["units"]}
    assert statuses["t10"] == "accepted"
    assert statuses["t20"] == "unaddressed"


# ── get_argument_map ────────────────────────────────────────


def test_get_argument_map_empty_when_no_data():
    """When no extraction happened, return empty structure."""
    result = get_argument_map("nonexistent-debate")
    assert result["snapshot_id"] is None
    assert result["nodes"] == []
    assert result["edges"] == []
    assert result["units"] == []


def test_get_argument_map_populated_after_extraction():
    """After extraction, map should contain nodes and units."""
    extract_argument_units(
        debate_id="d-pop", turn_id="t1",
        content="This is a claim. A study shows evidence. However that is wrong.",
        speaker_side="proposition",
    )
    result = get_argument_map("d-pop")
    assert result["snapshot_id"] is not None
    assert len(result["nodes"]) == 3
    assert len(result["units"]) == 3

    unit_types = {u["type"] for u in result["units"]}
    assert "claim" in unit_types
    assert "evidence" in unit_types
    assert "rebuttal" in unit_types

    # Every unit should have a corresponding node
    node_ids = {n["id"] for n in result["nodes"]}
    for unit in result["units"]:
        assert unit["node_id"] in node_ids
        assert unit["turn_id"] == "t1"


@pytest.mark.asyncio
async def test_enrich_argument_units_for_turn_updates_types_and_payload():
    extract_argument_units(
        debate_id="d-enrich",
        turn_id="t1",
        content="A 2024 study shows improvement. However the rollout remains fragile.",
        speaker_side="proposition",
    )

    previous = settings.ARGUMENT_MAP_LLM_ENRICHMENT
    settings.ARGUMENT_MAP_LLM_ENRICHMENT = True
    try:
        with patch(
            "app.services.debate_argument_map.llm_call_json_with_stream_fallback",
            new=AsyncMock(
                return_value={
                    "units": [
                        {
                            "text": "A 2024 study shows improvement.",
                            "type": "evidence",
                            "stance": "supports_proposition",
                            "confidence": 0.92,
                        },
                        {
                            "text": "However the rollout remains fragile.",
                            "type": "rebuttal",
                            "stance": "supports_opposition",
                            "confidence": 0.88,
                        },
                    ]
                }
            ),
        ):
            updated = await enrich_argument_units_for_turn(
                debate_id="d-enrich",
                turn_id="t1",
                speaker_side="proposition",
                language="en",
            )
    finally:
        settings.ARGUMENT_MAP_LLM_ENRICHMENT = previous

    assert updated == 2
    result = get_argument_map("d-enrich")
    node_types = {node["label"]: node["type"] for node in result["nodes"]}
    assert node_types["A 2024 study shows improvement."] == "evidence"
    assert node_types["However the rollout remains fragile."] == "rebuttal"
    payloads = {
        node["label"]: node["payload"]
        for node in result["nodes"]
    }
    assert payloads["A 2024 study shows improvement."]["stance"] == "supports_proposition"
    assert payloads["However the rollout remains fragile."]["enriched_by"] == "llm"


@pytest.mark.asyncio
async def test_enrich_argument_units_for_turn_removes_stale_edges_after_type_changes():
    extract_argument_units(
        debate_id="d-enrich-edges",
        turn_id="t1",
        content="This is the supporting evidence. This is the claim.",
        speaker_side="proposition",
    )

    previous = settings.ARGUMENT_MAP_LLM_ENRICHMENT
    settings.ARGUMENT_MAP_LLM_ENRICHMENT = True
    try:
        with patch(
            "app.services.debate_argument_map.llm_call_json_with_stream_fallback",
            new=AsyncMock(
                return_value={
                    "units": [
                        {
                            "text": "This is the supporting evidence.",
                            "type": "evidence",
                            "stance": "supports_proposition",
                            "confidence": 0.91,
                        },
                        {
                            "text": "This is the claim.",
                            "type": "claim",
                            "stance": "supports_proposition",
                            "confidence": 0.77,
                        },
                    ]
                }
            ),
        ):
            updated = await enrich_argument_units_for_turn(
                debate_id="d-enrich-edges",
                turn_id="t1",
                speaker_side="proposition",
                language="en",
            )
    finally:
        settings.ARGUMENT_MAP_LLM_ENRICHMENT = previous

    assert updated == 2
    result = get_argument_map("d-enrich-edges")
    supports = [edge for edge in result["edges"] if edge["type"] == "supports"]
    assert supports == []


@pytest.mark.asyncio
async def test_enrich_argument_units_for_turn_removes_cross_turn_stale_rebuttal_edges():
    extract_argument_units(
        debate_id="d-enrich-cross-turn",
        turn_id="t1",
        content="This is the original claim.",
        speaker_side="proposition",
        turn_sequence=1,
    )
    extract_argument_units(
        debate_id="d-enrich-cross-turn",
        turn_id="t2",
        content="However this fails.",
        speaker_side="opposition",
        turn_sequence=2,
    )

    initial = get_argument_map("d-enrich-cross-turn")
    assert [edge for edge in initial["edges"] if edge["type"] == "rebuts"]

    previous = settings.ARGUMENT_MAP_LLM_ENRICHMENT
    settings.ARGUMENT_MAP_LLM_ENRICHMENT = True
    try:
        with patch(
            "app.services.debate_argument_map.llm_call_json_with_stream_fallback",
            new=AsyncMock(
                return_value={
                    "units": [
                        {
                            "text": "This is the original claim.",
                            "type": "evidence",
                            "stance": "supports_proposition",
                            "confidence": 0.81,
                        },
                    ]
                }
            ),
        ):
            updated = await enrich_argument_units_for_turn(
                debate_id="d-enrich-cross-turn",
                turn_id="t1",
                speaker_side="proposition",
                language="en",
            )
    finally:
        settings.ARGUMENT_MAP_LLM_ENRICHMENT = previous

    assert updated == 1
    result = get_argument_map("d-enrich-cross-turn")
    rebuts = [edge for edge in result["edges"] if edge["type"] == "rebuts"]
    assert rebuts == []


@pytest.mark.asyncio
async def test_enrich_argument_units_for_turn_keeps_rebuttal_target_stable_after_rebuild():
    extract_argument_units(
        debate_id="d-enrich-stable-rebuttal",
        turn_id="t1",
        content="Alpha claim. Beta claim.",
        speaker_side="proposition",
        turn_sequence=1,
    )
    extract_argument_units(
        debate_id="d-enrich-stable-rebuttal",
        turn_id="t2",
        content="However this fails.",
        speaker_side="opposition",
        turn_sequence=2,
    )

    initial = get_argument_map("d-enrich-stable-rebuttal")
    labels_by_node = {node["id"]: node["label"] for node in initial["nodes"]}
    initial_rebuttal = next(edge for edge in initial["edges"] if edge["type"] == "rebuts")
    initial_target_label = labels_by_node[initial_rebuttal["target"]]

    previous = settings.ARGUMENT_MAP_LLM_ENRICHMENT
    settings.ARGUMENT_MAP_LLM_ENRICHMENT = True
    try:
        with patch(
            "app.services.debate_argument_map.llm_call_json_with_stream_fallback",
            new=AsyncMock(
                return_value={
                    "units": [
                        {
                            "text": "Alpha claim.",
                            "type": "claim",
                            "stance": "supports_proposition",
                            "confidence": 0.61,
                        },
                        {
                            "text": "Beta claim.",
                            "type": "claim",
                            "stance": "supports_proposition",
                            "confidence": 0.63,
                        },
                    ]
                }
            ),
        ):
            updated = await enrich_argument_units_for_turn(
                debate_id="d-enrich-stable-rebuttal",
                turn_id="t1",
                speaker_side="proposition",
                language="en",
            )
    finally:
        settings.ARGUMENT_MAP_LLM_ENRICHMENT = previous

    assert updated == 2
    result = get_argument_map("d-enrich-stable-rebuttal")
    labels_by_node = {node["id"]: node["label"] for node in result["nodes"]}
    rebuttal = next(edge for edge in result["edges"] if edge["type"] == "rebuts")
    assert labels_by_node[rebuttal["target"]] == initial_target_label


@pytest.mark.asyncio
async def test_enrich_rebuild_preserves_support_edge_with_tied_timestamps():
    extract_argument_units(
        debate_id="d-enrich-stable-order",
        turn_id="t1",
        content="Claim first. Data confirms it.",
        speaker_side="proposition",
        turn_sequence=1,
    )

    with Session(get_engine()) as session:
        session.add(
            DebateTurn(
                id="t1",
                debate_id="d-enrich-stable-order",
                sequence=1,
                phase="opening",
                speaker_side="proposition",
                speaker_name="Speaker",
                content="Claim first. Data confirms it.",
            )
        )
        units = {
            unit.canonical_text: unit
            for unit in session.exec(
                select(DebateArgumentUnit).where(
                    DebateArgumentUnit.debate_id == "d-enrich-stable-order",
                )
            ).all()
        }
        tied_timestamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
        claim_unit = units["Claim first."]
        evidence_unit = units["Data confirms it."]
        claim_unit.created_at = tied_timestamp
        evidence_unit.created_at = tied_timestamp
        claim_unit.id = "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"
        evidence_unit.id = "00000000-0000-0000-0000-000000000000"
        session.add(claim_unit)
        session.add(evidence_unit)
        session.commit()

    previous = settings.ARGUMENT_MAP_LLM_ENRICHMENT
    settings.ARGUMENT_MAP_LLM_ENRICHMENT = True
    try:
        with patch(
            "app.services.debate_argument_map.llm_call_json_with_stream_fallback",
            new=AsyncMock(
                return_value={
                    "units": [
                        {
                            "text": "Claim first.",
                            "type": "claim",
                            "stance": "supports_proposition",
                            "confidence": 0.72,
                        },
                        {
                            "text": "Data confirms it.",
                            "type": "evidence",
                            "stance": "supports_proposition",
                            "confidence": 0.84,
                        },
                    ]
                }
            ),
        ):
            updated = await enrich_argument_units_for_turn(
                debate_id="d-enrich-stable-order",
                turn_id="t1",
                speaker_side="proposition",
                language="en",
            )
    finally:
        settings.ARGUMENT_MAP_LLM_ENRICHMENT = previous

    assert updated == 2
    result = get_argument_map("d-enrich-stable-order")
    labels_by_node = {node["id"]: node["label"] for node in result["nodes"]}
    supports = [edge for edge in result["edges"] if edge["type"] == "supports"]
    assert len(supports) == 1
    assert labels_by_node[supports[0]["source"]] == "Data confirms it."
    assert labels_by_node[supports[0]["target"]] == "Claim first."


@pytest.mark.asyncio
async def test_enrich_argument_units_for_turn_keeps_rule_based_units_on_invalid_output():
    extract_argument_units(
        debate_id="d-enrich-invalid",
        turn_id="t1",
        content="This is a claim. Data confirms the trend.",
        speaker_side="opposition",
    )

    previous = settings.ARGUMENT_MAP_LLM_ENRICHMENT
    settings.ARGUMENT_MAP_LLM_ENRICHMENT = True
    try:
        with patch(
            "app.services.debate_argument_map.llm_call_json_with_stream_fallback",
            new=AsyncMock(return_value={"units": [{"text": "unknown", "type": "counter"}]}),
        ):
            updated = await enrich_argument_units_for_turn(
                debate_id="d-enrich-invalid",
                turn_id="t1",
                speaker_side="opposition",
                language="en",
            )
    finally:
        settings.ARGUMENT_MAP_LLM_ENRICHMENT = previous

    assert updated == 0
    result = get_argument_map("d-enrich-invalid")
    unit_types = {unit["text"]: unit["type"] for unit in result["units"]}
    assert unit_types["This is a claim."] == "claim"
    assert unit_types["Data confirms the trend."] == "evidence"


# ── A9: Serialization new field names ──────────────────────


def test_get_argument_map_uses_new_field_names():
    """Nodes should use key/type/round/payload; edges should use source/target/type."""
    extract_argument_units(
        debate_id="d-serial", turn_id="t1",
        content="AI will improve things.",
        speaker_side="proposition",
    )
    result = get_argument_map("d-serial")
    node = result["nodes"][0]
    assert "key" in node
    assert "type" in node
    assert "round" in node
    assert "payload" in node
    # Old field names should NOT exist
    assert "node_key" not in node
    assert "node_type" not in node
    assert "payload_json" not in node


def test_get_argument_map_edges_use_new_field_names():
    """Edges should use source/target/type instead of source_node_id/target_node_id/edge_type."""
    extract_argument_units(
        debate_id="d-serial-e", turn_id="t1",
        content="This is a claim. A study shows evidence.",
        speaker_side="proposition",
    )
    result = get_argument_map("d-serial-e")
    assert result["edges"]
    edge = result["edges"][0]
    assert "source" in edge
    assert "target" in edge
    assert "type" in edge
    assert "source_node_id" not in edge
    assert "target_node_id" not in edge
    assert "edge_type" not in edge


def test_get_argument_map_units_have_node_id():
    """Units should include node_id field."""
    extract_argument_units(
        debate_id="d-serial-u", turn_id="t1",
        content="Some statement.",
        speaker_side="proposition",
    )
    result = get_argument_map("d-serial-u")
    assert len(result["units"]) == 1
    assert "node_id" in result["units"][0]
    assert result["units"][0]["node_id"] is not None


# ── A7: Same-turn edges (supports/rebuts) ──────────────────


def test_evidence_supports_claim():
    """Evidence following a claim should create a supports edge."""
    extract_argument_units(
        debate_id="d-edge1", turn_id="t1",
        content="AI is beneficial. A study shows 80% improvement.",
        speaker_side="proposition",
    )
    result = get_argument_map("d-edge1")
    supports = [e for e in result["edges"] if e["type"] == "supports"]
    assert len(supports) >= 1


def test_rebuttal_rebuts_opponent():
    """Rebuttal should link to opponent's claim."""
    # First: proposition makes a claim
    extract_argument_units(
        debate_id="d-edge2", turn_id="t1",
        content="AI is great.",
        speaker_side="proposition",
    )
    # Then: opposition rebuts
    extract_argument_units(
        debate_id="d-edge2", turn_id="t2",
        content="However the cost is prohibitive.",
        speaker_side="opposition",
    )
    result = get_argument_map("d-edge2")
    rebuts = [e for e in result["edges"] if e["type"] == "rebuts"]
    assert len(rebuts) >= 1


def test_rebuttal_targets_latest_claim_from_opponent_turn():
    """A rebuttal should target the latest opposing claim from the same turn."""
    extract_argument_units(
        debate_id="d-edge3",
        turn_id="t1",
        content="Alpha claim. Beta claim.",
        speaker_side="proposition",
        turn_sequence=1,
    )
    extract_argument_units(
        debate_id="d-edge3",
        turn_id="t2",
        content="However nope.",
        speaker_side="opposition",
        turn_sequence=2,
    )

    result = get_argument_map("d-edge3")
    labels_by_node = {node["id"]: node["label"] for node in result["nodes"]}
    rebuttal = next(edge for edge in result["edges"] if edge["type"] == "rebuts")
    assert labels_by_node[rebuttal["target"]] == "Beta claim."


# ── A10: round_number from turn_sequence ───────────────────


def test_round_number_set_from_turn_sequence():
    """GraphNode.round_number should be set when turn_sequence is provided."""
    extract_argument_units(
        debate_id="d-rn1", turn_id="t1",
        content="First round claim.",
        speaker_side="proposition",
        turn_sequence=3,
    )
    result = get_argument_map("d-rn1")
    assert result["nodes"][0]["round"] == 3


# ── A8: Verdict idempotent ─────────────────────────────────


def test_verdict_idempotent():
    """Calling link_verdict twice with different supporting_turns re-evaluates all."""
    extract_argument_units(
        debate_id="d-videm", turn_id="t1",
        content="Claim A.",
        speaker_side="proposition",
    )
    extract_argument_units(
        debate_id="d-videm", turn_id="t2",
        content="Claim B.",
        speaker_side="opposition",
    )

    # First verdict: t1 is supported
    link_verdict("d-videm", {"supporting_turns": ["t1"]})
    result1 = get_argument_map("d-videm")
    statuses1 = {u["turn_id"]: u["status"] for u in result1["units"]}
    assert statuses1["t1"] == "accepted"
    assert statuses1["t2"] == "unaddressed"

    # Second verdict: t2 is supported instead
    link_verdict("d-videm", {"supporting_turns": ["t2"]})
    result2 = get_argument_map("d-videm")
    statuses2 = {u["turn_id"]: u["status"] for u in result2["units"]}
    assert statuses2["t1"] == "unaddressed"
    assert statuses2["t2"] == "accepted"


def test_verdict_idempotent_updates_verdict_node_metadata():
    extract_argument_units(
        debate_id="d-vmeta", turn_id="t1",
        content="Claim A.",
        speaker_side="proposition",
    )
    extract_argument_units(
        debate_id="d-vmeta", turn_id="t2",
        content="Claim B.",
        speaker_side="opposition",
    )

    link_verdict(
        "d-vmeta",
        {
            "supporting_turns": ["t1"],
            "winner": "proposition",
            "verdict_tone": "Measured",
        },
    )
    link_verdict(
        "d-vmeta",
        {
            "supporting_turns": ["t2"],
            "winner": "opposition",
            "verdict_tone": "Decisive",
        },
    )

    result = get_argument_map("d-vmeta")
    verdict_nodes = [n for n in result["nodes"] if n["type"] == "verdict"]
    assert len(verdict_nodes) == 1
    assert verdict_nodes[0]["label"] == "Decisive"
    assert verdict_nodes[0]["payload"]["winner"] == "opposition"
    assert verdict_nodes[0]["payload"]["verdict_tone"] == "Decisive"


def test_verdict_creates_verdict_node():
    """link_verdict should create a verdict node in the graph."""
    extract_argument_units(
        debate_id="d-vnode", turn_id="t1",
        content="Some claim.",
        speaker_side="proposition",
    )
    link_verdict("d-vnode", {"supporting_turns": ["t1"], "verdict_tone": "Decisive"})
    result = get_argument_map("d-vnode")
    verdict_nodes = [n for n in result["nodes"] if n["type"] == "verdict"]
    assert len(verdict_nodes) == 1
    assert "Decisive" in verdict_nodes[0]["label"]


def test_verdict_edges_match_unit_status():
    """Verdict edge_type should match unit.status (no dual semantics)."""
    extract_argument_units(
        debate_id="d-vedge", turn_id="t1",
        content="Accepted claim.",
        speaker_side="proposition",
    )
    extract_argument_units(
        debate_id="d-vedge", turn_id="t2",
        content="Unaddressed claim.",
        speaker_side="opposition",
    )
    link_verdict("d-vedge", {"supporting_turns": ["t1"]})

    result = get_argument_map("d-vedge")
    verdict_edges = [e for e in result["edges"]
                     if e["type"] in ("accepted", "unaddressed")]
    assert len(verdict_edges) >= 2
    edge_types = {e["type"] for e in verdict_edges}
    assert "accepted" in edge_types
    assert "unaddressed" in edge_types
