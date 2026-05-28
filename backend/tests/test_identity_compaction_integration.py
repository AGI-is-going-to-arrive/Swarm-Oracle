"""Integration smoke test for identity compaction on real ChromaDB."""

from __future__ import annotations

from sqlmodel import Session

from app.config import settings
from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine
from app.services.agent_identity import get_identity_memories
from app.services.vector_store import (
    build_compaction_prompt,
    check_identity_compaction_needed,
    execute_compaction_group,
    get_vector_store,
    prepare_compaction_groups,
    store_identity_memory,
)


def _count_raw_and_compacted(metadatas: list[dict]) -> tuple[int, int]:
    raw = 0
    compacted = 0
    for meta in metadatas:
        if meta.get("doc_type") == "identity_profile":
            continue
        if meta.get("compacted") == "true":
            compacted += 1
        else:
            raw += 1
    return raw, compacted


def test_identity_compaction_smoke_real_chroma(monkeypatch):
    monkeypatch.setattr(settings, "IDENTITY_COMPACT_THRESHOLD", 50)
    monkeypatch.setattr(settings, "IDENTITY_COMPACT_BATCH_SIZE", 30)
    monkeypatch.setattr(settings, "IDENTITY_COMPACT_GROUP_SIZE", 10)

    user_id = "integration-user"
    identity_id = "integration-identity"

    engine = get_engine()
    with Session(engine) as session:
        session.add(AgentIdentity(
            id=identity_id,
            user_id=user_id,
            display_name="Integration Agent",
            role="Diplomat",
            persona="Tracks cross-scenario continuity",
            continuity_key="integration-key",
        ))
        session.commit()

    for idx in range(55):
        store_identity_memory(
            user_id=user_id,
            identity_id=identity_id,
            scenario_id=f"scenario-{idx % 3}",
            summary=f"Memory {idx:02d}: stance update across scenarios",
            metadata={"created_at": f"2026-04-01T00:{idx:02d}:00Z"},
        )

    assert check_identity_compaction_needed(user_id, identity_id) is True

    groups = prepare_compaction_groups(user_id, identity_id)
    assert groups
    first_group = groups[0]
    assert len(first_group.ids) == settings.IDENTITY_COMPACT_GROUP_SIZE
    assert first_group.summaries[0].startswith("Memory 00")
    assert first_group.summaries[-1].startswith("Memory 09")

    prompt = build_compaction_prompt(first_group.summaries)
    assert "Memory 1" in prompt
    assert "compacted_summary" in prompt

    store = get_vector_store()
    collection = store._client.get_collection(name="identity_integration_user")
    before = collection.get(where={"identity_id": identity_id})
    before_raw, before_compacted = _count_raw_and_compacted(before["metadatas"])
    assert before_raw == 55
    assert before_compacted == 0

    llm_result = {"compacted_summary": "Compacted summary from integration smoke test."}
    execute_compaction_group(
        user_id,
        identity_id,
        first_group,
        llm_result["compacted_summary"],
    )

    after = collection.get(where={"identity_id": identity_id})
    after_raw, after_compacted = _count_raw_and_compacted(after["metadatas"])
    assert after_raw == before_raw - len(first_group.ids)
    assert after_compacted == before_compacted + 1

    compacted_meta = next(
        meta for meta in after["metadatas"]
        if meta.get("compacted") == "true"
    )
    assert compacted_meta["source_ids_hash"] == first_group.source_ids_hash
    assert compacted_meta["compacted_count"] == str(len(first_group.ids))

    memories = get_identity_memories(identity_id, limit=50)
    # Compacted summaries are now returned as long-term identity memory, before raw rows.
    assert len(memories) == after_raw + after_compacted == 46
    assert any(
        m["summary"] == "Compacted summary from integration smoke test."
        and m["memory_type"] == "long_term_summary"
        and m["is_compacted"] is True
        for m in memories
    )
