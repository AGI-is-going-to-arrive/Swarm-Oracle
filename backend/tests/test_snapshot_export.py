"""Tests for S3-6 snapshot export/import service."""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import stat
import zipfile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.config import settings
from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    AgentTier,
    Branch,
    BranchStatus,
    InterventionLog,
    PendingIntervention,
    Round,
    Scenario,
    ScenarioStatus,
)
from app.models.database import get_engine
from app.models.graph import GraphEdge, GraphNode, GraphSnapshot
from app.services.snapshot_export import (
    SnapshotImportError,
    build_snapshot_manifest,
    export_snapshot_zip,
    import_snapshot_zip,
)

# ── helpers ──────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _enable_snapshot_feature(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SNAPSHOT_EXPORT", True)


@pytest.fixture
def client():
    return TestClient(app)


def _seed_scenario(
    *,
    question: str = "假设核聚变明天能量产，会怎么样？",
    user_id: str | None = "owner-1",
    api_key_in_context: bool = True,
) -> str:
    parsed_context: dict = {"mode": "blackboard", "simulation_rounds": 3}
    if api_key_in_context:
        parsed_context["api_key"] = "sk-secret-context"
        parsed_context["base_url"] = "https://malicious.example/v1"
    scenario = Scenario(
        question=question,
        status=ScenarioStatus.DONE,
        user_id=user_id,
        parsed_context=parsed_context,
    )
    with Session(get_engine()) as session:
        session.add(scenario)
        session.commit()
        return scenario.id


def _seed_branch_tree(scenario_id: str) -> tuple[str, str]:
    with Session(get_engine()) as session:
        root = Branch(
            scenario_id=scenario_id,
            title="主线",
            description="开局",
            summary="根分支",
            story="开篇",
            insight="洞察A",
            probability=0.6,
            status=BranchStatus.COMPLETED,
        )
        session.add(root)
        session.flush()
        child = Branch(
            scenario_id=scenario_id,
            parent_branch_id=root.id,
            fork_round=2,
            fork_reason="选择B",
            title="支线",
            summary="子分支",
            probability=0.4,
            status=BranchStatus.COMPLETED,
        )
        session.add(child)
        session.commit()
        return root.id, child.id


def _seed_agents(scenario_id: str) -> tuple[str, str]:
    with Session(get_engine()) as session:
        a1 = Agent(
            scenario_id=scenario_id,
            name="科学家",
            role="scientist",
            persona="冷静的物理学家",
            tier=AgentTier.CORE,
            stance="支持",
            emotion="curious",
        )
        a2 = Agent(
            scenario_id=scenario_id,
            name="政客",
            role="politician",
            persona="务实的决策者",
            tier=AgentTier.IMPORTANT,
        )
        session.add_all([a1, a2])
        session.commit()
        return a1.id, a2.id


def _seed_messages(branch_id: str, agent_id: str) -> None:
    with Session(get_engine()) as session:
        round_row = Round(branch_id=branch_id, round_number=1)
        session.add(round_row)
        session.flush()
        session.add(
            AgentMessage(
                round_id=round_row.id,
                agent_id=agent_id,
                content="第一回合发言",
                emotion="neutral",
            )
        )
        round_row2 = Round(branch_id=branch_id, round_number=2)
        session.add(round_row2)
        session.flush()
        session.add(
            AgentMessage(
                round_id=round_row2.id,
                agent_id=agent_id,
                content="第二回合发言",
                emotion="excited",
            )
        )
        session.commit()


def _seed_intervention_receipt(
    scenario_id: str,
    branch_id: str,
    *,
    agent_id: str = "agent-a",
    user_input: str = "请让审计官强制公开解释义务",
    round_number: int = 2,
) -> str:
    effect_summary = {
        "intervention_log_id": "original-log-id",
        "card_id": "human_takeover",
        "round_number": round_number,
        "user_input": user_input,
        "scenario_id": scenario_id,
        "branch_id": branch_id,
        "comparison": {"branch_id": "stale-branch-not-in-snapshot"},
        "affected_agents": [{"agent_id": agent_id, "display_name": "审计官"}],
        "response_excerpts": [
            {"agent_id": agent_id, "excerpt": "公开解释义务会改变下一轮表态。"},
        ],
        "confidence": 0.72,
        "no_response_detected": False,
        "api_key": "sk-receipt-leak",
        "base_url": "https://receipt-secret.example/v1",
    }
    with Session(get_engine()) as session:
        log = InterventionLog(
            scenario_id=scenario_id,
            branch_id=branch_id,
            round_number=round_number,
            user_input=user_input,
            effect_summary_json=json.dumps(effect_summary, ensure_ascii=False),
        )
        session.add(log)
        session.commit()
        return log.id


def _seed_causal_graph(scenario_id: str, branch_id: str, agent_id: str) -> None:
    with Session(get_engine()) as session:
        snapshot = GraphSnapshot(
            owner_type="scenario",
            owner_id=scenario_id,
            graph_kind="causal_review",
        )
        session.add(snapshot)
        session.flush()

        node_a = GraphNode(
            snapshot_id=snapshot.id,
            node_key=f"{scenario_id}_a",
            node_type="event",
            label="事件A",
            round_number=1,
            payload_json=json.dumps({"branch_id": branch_id, "agent_id": agent_id}),
        )
        node_b = GraphNode(
            snapshot_id=snapshot.id,
            node_key=f"{scenario_id}_b",
            node_type="stance_shift",
            label="转向",
            round_number=2,
            payload_json=json.dumps({"branch_id": branch_id, "agent_id": agent_id}),
        )
        session.add_all([node_a, node_b])
        session.flush()

        session.add(
            GraphEdge(
                snapshot_id=snapshot.id,
                source_node_id=node_a.id,
                target_node_id=node_b.id,
                edge_type="caused",
                weight=0.8,
                confidence_tier="high",
                source_ref="msg-1",
                source_round_number=1,
            )
        )
        session.commit()


def _build_snapshot_zip_from_payloads(payloads: dict[str, bytes]) -> bytes:
    """Build a minimal signed snapshot ZIP for malformed-import probes."""
    manifest = {
        "version": "1.0",
        "created_at": "2026-01-01T00:00:00+00:00",
        "scenario_id": "probe",
        "graph_schema_version": 1,
        "include_private": False,
        "files": {
            name: {
                "sha256": hashlib.sha256(blob).hexdigest(),
                "size": len(blob),
            }
            for name, blob in payloads.items()
        },
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        for name, blob in payloads.items():
            zf.writestr(name, blob)
        zf.writestr(
            "checksums.sha256",
            "\n".join(
                f"{meta['sha256']}  {name}"
                for name, meta in manifest["files"].items()
            ),
        )
    return out.getvalue()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _make_signed_token(secret: str, subject: str) -> str:
    payload = _b64url(json.dumps({"sub": subject}).encode("utf-8"))
    signing_input = f"v1.{payload}".encode("utf-8")
    signature = _b64url(hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest())
    return f"v1.{payload}.{signature}"


# ── service tests ────────────────────────────────────────


def test_export_empty_scenario_produces_valid_zip():
    scenario_id = _seed_scenario(api_key_in_context=False)
    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)

    payload = buffer.getvalue()
    assert payload, "ZIP must be non-empty"
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        names = zf.namelist()
        assert "manifest.json" in names
        assert "scenario.json" in names
        assert "branches.jsonl" in names
        assert "agents.jsonl" in names
        assert "messages.jsonl" in names
        assert "causal_graph.json" in names
        assert "intervention_receipts.jsonl" in names
        assert "checksums.sha256" in names

        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["version"] == "1.0"
        assert manifest["scenario_id"] == scenario_id
        assert "files" in manifest


def test_export_includes_branches_agents_messages():
    scenario_id = _seed_scenario(api_key_in_context=False)
    root_id, child_id = _seed_branch_tree(scenario_id)
    a1_id, _ = _seed_agents(scenario_id)
    _seed_messages(root_id, a1_id)

    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)

    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as zf:
        branches = [
            json.loads(line)
            for line in zf.read("branches.jsonl").decode("utf-8").splitlines()
            if line
        ]
        agents = [
            json.loads(line)
            for line in zf.read("agents.jsonl").decode("utf-8").splitlines()
            if line
        ]
        messages = [
            json.loads(line)
            for line in zf.read("messages.jsonl").decode("utf-8").splitlines()
            if line
        ]

    branch_ids = {b["id"] for b in branches}
    assert root_id in branch_ids
    assert child_id in branch_ids
    assert len(agents) == 2
    assert len(messages) == 2
    assert all(m["branch_id"] == root_id for m in messages)
    # ordered by branch_id, round_number
    assert messages[0]["round_number"] <= messages[1]["round_number"]


def test_export_includes_causal_graph_nodes_and_edges():
    scenario_id = _seed_scenario(api_key_in_context=False)
    root_id, _ = _seed_branch_tree(scenario_id)
    a1_id, _ = _seed_agents(scenario_id)
    _seed_causal_graph(scenario_id, root_id, a1_id)

    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)

    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as zf:
        graph = json.loads(zf.read("causal_graph.json"))

    assert graph["snapshot"] is not None
    assert graph["snapshot"]["graph_kind"] == "causal_review"
    assert len(graph["nodes"]) == 2
    assert len(graph["edges"]) == 1
    edge = graph["edges"][0]
    assert edge["edge_type"] == "caused"
    assert edge["confidence_tier"] == "high"


def test_export_includes_intervention_receipts_and_redacts_summary_secrets():
    scenario_id = _seed_scenario(api_key_in_context=False)
    root_id, _ = _seed_branch_tree(scenario_id)
    log_id = _seed_intervention_receipt(scenario_id, root_id)

    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)

    raw = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        rows = [
            json.loads(line)
            for line in zf.read("intervention_receipts.jsonl").decode("utf-8").splitlines()
            if line
        ]
        manifest = json.loads(zf.read("manifest.json"))

    assert "intervention_receipts.jsonl" in manifest["files"]
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == log_id
    assert row["scenario_id"] == scenario_id
    assert row["branch_id"] == root_id
    assert row["round_number"] == 2
    assert row["user_input"] == "请让审计官强制公开解释义务"
    assert row["created_at"]
    summary = json.loads(row["effect_summary_json"])
    assert summary["card_id"] == "human_takeover"
    assert summary["affected_agents"][0]["display_name"] == "审计官"
    assert "api_key" not in summary
    assert "base_url" not in summary
    assert b"sk-receipt-leak" not in raw
    assert b"receipt-secret.example" not in raw


def test_manifest_checksums_match_payload_bytes():
    scenario_id = _seed_scenario(api_key_in_context=False)
    _seed_branch_tree(scenario_id)
    _seed_agents(scenario_id)

    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)

    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        for name, meta in manifest["files"].items():
            blob = zf.read(name)
            assert len(blob) == meta["size"], f"size mismatch for {name}"
            import hashlib
            assert hashlib.sha256(blob).hexdigest() == meta["sha256"]


def test_redacts_user_id_and_secrets_by_default():
    scenario_id = _seed_scenario(api_key_in_context=True)
    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)

    raw = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        scenario_payload = json.loads(zf.read("scenario.json"))

    assert "user_id" not in scenario_payload
    parsed = scenario_payload.get("parsed_context") or {}
    assert "api_key" not in parsed
    assert "base_url" not in parsed
    # secrets must not leak as raw substrings either
    assert b"sk-secret-context" not in raw
    assert b"malicious.example" not in raw


def test_include_private_keeps_user_id_but_still_redacts_secrets():
    scenario_id = _seed_scenario(api_key_in_context=True)
    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session, include_private=True)

    raw = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        scenario_payload = json.loads(zf.read("scenario.json"))

    assert scenario_payload["user_id"] == "owner-1"
    parsed = scenario_payload.get("parsed_context") or {}
    assert "api_key" not in parsed
    assert b"sk-secret-context" not in raw


def test_import_creates_new_scenario_with_remapped_ids():
    scenario_id = _seed_scenario(api_key_in_context=False)
    root_id, child_id = _seed_branch_tree(scenario_id)
    a1_id, _ = _seed_agents(scenario_id)
    _seed_messages(root_id, a1_id)
    _seed_causal_graph(scenario_id, root_id, a1_id)

    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)
    blob = buffer.getvalue()

    with Session(get_engine()) as session:
        new_id = import_snapshot_zip(blob, "importer-2", session)

    assert new_id != scenario_id

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, new_id)
        assert scenario is not None
        assert scenario.user_id == "importer-2"
        # Branches were re-keyed, but all linked to the new scenario.
        new_branches = list(
            session.exec(select(Branch).where(Branch.scenario_id == new_id)).all()
        )
        assert len(new_branches) == 2
        assert all(b.id != root_id and b.id != child_id for b in new_branches)
        # Parent linkage preserved.
        children = [b for b in new_branches if b.parent_branch_id is not None]
        assert len(children) == 1
        assert children[0].parent_branch_id in {b.id for b in new_branches}

        new_agents = list(
            session.exec(select(Agent).where(Agent.scenario_id == new_id)).all()
        )
        assert len(new_agents) == 2

        # Causal graph remapped.
        snapshot = session.exec(
            select(GraphSnapshot).where(
                GraphSnapshot.owner_id == new_id,
                GraphSnapshot.owner_type == "scenario",
            )
        ).first()
        assert snapshot is not None
        nodes = list(
            session.exec(
                select(GraphNode).where(GraphNode.snapshot_id == snapshot.id)
            ).all()
        )
        edges = list(
            session.exec(
                select(GraphEdge).where(GraphEdge.snapshot_id == snapshot.id)
            ).all()
        )
        assert len(nodes) == 2
        assert len(edges) == 1
        node_ids = {n.id for n in nodes}
        assert edges[0].source_node_id in node_ids
        assert edges[0].target_node_id in node_ids


def test_import_restores_intervention_receipts_with_remapped_branch_ids():
    scenario_id = _seed_scenario(api_key_in_context=False)
    root_id, _ = _seed_branch_tree(scenario_id)
    a1_id, _ = _seed_agents(scenario_id)
    original_log_id = _seed_intervention_receipt(
        scenario_id,
        root_id,
        agent_id=a1_id,
    )

    with Session(get_engine()) as session:
        blob = export_snapshot_zip(scenario_id, session).getvalue()

    with Session(get_engine()) as session:
        new_id = import_snapshot_zip(blob, "importer-receipt", session)

    with Session(get_engine()) as session:
        imported_logs = list(
            session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == new_id)
            ).all()
        )
        assert len(imported_logs) == 1
        imported_log = imported_logs[0]
        assert imported_log.id != original_log_id
        assert imported_log.branch_id != root_id
        imported_branch = session.get(Branch, imported_log.branch_id)
        assert imported_branch is not None
        assert imported_branch.scenario_id == new_id
        assert imported_log.round_number == 2
        assert imported_log.user_input == "请让审计官强制公开解释义务"
        assert imported_log.effect_summary_json is not None
        summary = json.loads(imported_log.effect_summary_json)
        imported_agents = list(
            session.exec(select(Agent).where(Agent.scenario_id == new_id)).all()
        )
        imported_agent_ids = {agent.id for agent in imported_agents}
        assert summary["scenario_id"] == new_id
        assert summary["branch_id"] == imported_log.branch_id
        assert summary["comparison"]["branch_id"] is None
        assert summary["intervention_log_id"] == imported_log.id
        assert summary["card_id"] == "human_takeover"
        assert summary["affected_agents"][0]["display_name"] == "审计官"
        assert summary["affected_agents"][0]["agent_id"] in imported_agent_ids
        assert summary["affected_agents"][0]["agent_id"] != a1_id
        assert summary["response_excerpts"][0]["agent_id"] in imported_agent_ids
        assert "api_key" not in summary
        assert "base_url" not in summary


def test_import_old_snapshot_without_intervention_receipts_file_still_succeeds():
    payloads = {
        "scenario.json": json.dumps({"question": "legacy snapshot"}).encode("utf-8"),
        "branches.jsonl": b'{"id":"branch-legacy","title":"Legacy branch"}',
        "agents.jsonl": b"",
        "messages.jsonl": b"",
        "causal_graph.json": b'{"snapshot":null,"nodes":[],"edges":[]}',
    }
    blob = _build_snapshot_zip_from_payloads(payloads)

    with Session(get_engine()) as session:
        new_id = import_snapshot_zip(blob, "importer-legacy", session)

    with Session(get_engine()) as session:
        scenario = session.get(Scenario, new_id)
        assert scenario is not None
        logs = list(
            session.exec(
                select(InterventionLog).where(InterventionLog.scenario_id == new_id)
            ).all()
        )
        assert logs == []


def test_import_rejects_intervention_receipt_with_unmapped_branch():
    payloads = {
        "scenario.json": json.dumps({"question": "bad receipt branch"}).encode("utf-8"),
        "branches.jsonl": b"",
        "agents.jsonl": b"",
        "messages.jsonl": b"",
        "causal_graph.json": b'{"snapshot":null,"nodes":[],"edges":[]}',
        "intervention_receipts.jsonl": (
            b'{"branch_id":"missing-branch","round_number":1,'
            b'"user_input":"orphaned receipt","effect_summary_json":"{}"}'
        ),
    }
    blob = _build_snapshot_zip_from_payloads(payloads)

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(blob, "importer-bad-receipt", session)

    assert "intervention_receipts.branch_id" in str(excinfo.value)


def test_snapshot_import_does_not_reenqueue_pending_interventions():
    scenario_id = _seed_scenario(api_key_in_context=False)
    root_id, _ = _seed_branch_tree(scenario_id)
    with Session(get_engine()) as session:
        session.add(
            PendingIntervention(
                scenario_id=scenario_id,
                branch_id=root_id,
                user_input="pending action should not restart after import",
                metadata_json=json.dumps(
                    {
                        "intervention_log_id": "pending-log",
                        "card_id": "human_takeover",
                    }
                ),
            )
        )
        session.commit()

    with Session(get_engine()) as session:
        blob = export_snapshot_zip(scenario_id, session).getvalue()

    with Session(get_engine()) as session:
        new_id = import_snapshot_zip(blob, "importer-no-pending", session)

    with Session(get_engine()) as session:
        pending_rows = list(
            session.exec(
                select(PendingIntervention).where(
                    PendingIntervention.scenario_id == new_id
                )
            ).all()
        )
        assert pending_rows == []


def test_import_rejects_checksum_mismatch():
    scenario_id = _seed_scenario(api_key_in_context=False)
    _seed_branch_tree(scenario_id)
    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)
    blob = buffer.getvalue()

    # Mutate one file inside the ZIP, leaving the manifest untouched.
    src = zipfile.ZipFile(io.BytesIO(blob))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in src.namelist():
            data = src.read(name)
            if name == "branches.jsonl":
                data = data + b'\n{"id":"tampered","title":"x"}'
            zf.writestr(name, data)
    src.close()

    with pytest.raises(SnapshotImportError):
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-x", session)


def test_import_rejects_invalid_zip():
    with pytest.raises(SnapshotImportError):
        with Session(get_engine()) as session:
            import_snapshot_zip(b"not-a-zip-at-all", "importer-y", session)


def test_import_rejects_missing_manifest():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("scenario.json", "{}")
    with pytest.raises(SnapshotImportError):
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-z", session)


def test_import_rejects_path_traversal_member_name():
    payloads = {
        "../scenario.json": json.dumps({"question": "bad path"}).encode("utf-8"),
    }
    blob = _build_snapshot_zip_from_payloads(payloads)

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(blob, "importer-path", session)

    assert "unsafe" in str(excinfo.value).lower()


def test_import_rejects_duplicate_zip_member_name():
    scenario_blob = json.dumps({"question": "duplicate member"}).encode("utf-8")
    digest = hashlib.sha256(scenario_blob).hexdigest()
    manifest = {
        "version": "1.0",
        "created_at": "2026-01-01T00:00:00+00:00",
        "scenario_id": "probe",
        "graph_schema_version": 1,
        "include_private": False,
        "files": {
            "scenario.json": {
                "sha256": digest,
                "size": len(scenario_blob),
            },
        },
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("scenario.json", scenario_blob)
        with pytest.warns(UserWarning, match="Duplicate name"):
            zf.writestr("scenario.json", b'{"question":"shadow member"}')
        zf.writestr("checksums.sha256", f"{digest}  scenario.json")

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-dup-member", session)

    assert "duplicate zip member" in str(excinfo.value).lower()


def test_import_rejects_too_many_physical_zip_members():
    from app.services import snapshot_export as snapshot_export_module

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "version": "1.0",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "scenario_id": "probe",
                    "graph_schema_version": 1,
                    "include_private": False,
                    "files": {},
                }
            ),
        )
        zf.writestr("checksums.sha256", "")
        for i in range(snapshot_export_module.MAX_ZIP_MEMBER_COUNT):
            zf.writestr(f"extra-{i}.txt", b"x")

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-too-many-members", session)

    assert "too many members" in str(excinfo.value).lower()


def test_import_rejects_symlink_member():
    scenario_blob = json.dumps({"question": "symlink"}).encode("utf-8")
    manifest = {
        "version": "1.0",
        "created_at": "2026-01-01T00:00:00+00:00",
        "scenario_id": "probe",
        "graph_schema_version": 1,
        "include_private": False,
        "files": {
            "scenario.json": {
                "sha256": hashlib.sha256(scenario_blob).hexdigest(),
                "size": len(scenario_blob),
            },
        },
    }
    info = zipfile.ZipInfo("scenario.json")
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr(info, scenario_blob)
        zf.writestr(
            "checksums.sha256",
            f"{manifest['files']['scenario.json']['sha256']}  scenario.json",
        )

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-link", session)

    assert "symlink" in str(excinfo.value).lower()


def test_import_rejects_high_compression_ratio_member():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "version": "1.0",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "scenario_id": "x",
                    "graph_schema_version": 1,
                    "include_private": False,
                    "files": {},
                }
            ),
        )
        zf.writestr("high-ratio.bin", b"0" * (2 * 1024 * 1024))

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-ratio", session)

    assert "compression ratio" in str(excinfo.value).lower()


def test_import_rejects_manifest_file_without_sha256():
    scenario_blob = json.dumps({"question": "missing sha"}).encode("utf-8")
    manifest = {
        "version": "1.0",
        "created_at": "2026-01-01T00:00:00+00:00",
        "scenario_id": "probe",
        "graph_schema_version": 1,
        "include_private": False,
        "files": {
            "scenario.json": {
                "size": len(scenario_blob),
            },
        },
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("scenario.json", scenario_blob)
        zf.writestr(
            "checksums.sha256",
            f"{hashlib.sha256(scenario_blob).hexdigest()}  scenario.json",
        )

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-missing-sha", session)

    assert "sha256" in str(excinfo.value).lower()


def test_import_rejects_checksum_file_mismatch():
    scenario_blob = json.dumps({"question": "checksum mismatch"}).encode("utf-8")
    manifest = {
        "version": "1.0",
        "created_at": "2026-01-01T00:00:00+00:00",
        "scenario_id": "probe",
        "graph_schema_version": 1,
        "include_private": False,
        "files": {
            "scenario.json": {
                "sha256": hashlib.sha256(scenario_blob).hexdigest(),
                "size": len(scenario_blob),
            },
        },
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("scenario.json", scenario_blob)
        zf.writestr("checksums.sha256", f"{'0' * 64}  scenario.json")

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-checksum", session)

    assert "checksums.sha256 mismatch" in str(excinfo.value)


def test_import_rejects_malformed_numeric_fields():
    payloads = {
        "scenario.json": json.dumps({"question": "bad number"}).encode("utf-8"),
        "branches.jsonl": b'{"id":"b1","probability":"not-a-number"}',
        "agents.jsonl": b"",
        "messages.jsonl": b"",
        "causal_graph.json": b'{"snapshot":null,"nodes":[],"edges":[]}',
    }
    blob = _build_snapshot_zip_from_payloads(payloads)

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(blob, "importer-number", session)

    assert "probability" in str(excinfo.value)


def test_build_snapshot_manifest_lists_expected_files():
    scenario_id = _seed_scenario(api_key_in_context=False)
    with Session(get_engine()) as session:
        bundle = build_snapshot_manifest(scenario_id, session)
    assert set(bundle["payloads"]).issuperset(
        {
            "scenario.json",
            "branches.jsonl",
            "agents.jsonl",
            "messages.jsonl",
            "causal_graph.json",
        }
    )
    assert bundle["manifest"]["scenario_id"] == scenario_id


# ── API tests ────────────────────────────────────────────


def test_api_export_endpoint_returns_zip_when_enabled(client):
    scenario_id = _seed_scenario(api_key_in_context=False, user_id=None)
    response = client.get(f"/api/scenario/{scenario_id}/snapshot")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/zip")
    assert b"PK" in response.content[:4]  # ZIP magic bytes


def test_api_export_endpoint_404_when_feature_disabled(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SNAPSHOT_EXPORT", False)
    scenario_id = _seed_scenario(api_key_in_context=False, user_id=None)
    response = client.get(f"/api/scenario/{scenario_id}/snapshot")
    assert response.status_code == 404
    body = response.json()
    assert body.get("detail", {}).get("code") == "FEATURE_DISABLED"


def test_api_import_endpoint_404_when_feature_disabled(client, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SNAPSHOT_EXPORT", False)
    response = client.post(
        "/api/scenario/import-snapshot",
        files={"file": ("snap.zip", b"PK\x03\x04", "application/zip")},
    )
    assert response.status_code == 404
    body = response.json()
    assert body.get("detail", {}).get("code") == "FEATURE_DISABLED"


def test_api_import_endpoint_round_trip(client):
    scenario_id = _seed_scenario(api_key_in_context=False, user_id=None)
    _seed_branch_tree(scenario_id)
    _seed_agents(scenario_id)

    export_resp = client.get(f"/api/scenario/{scenario_id}/snapshot")
    assert export_resp.status_code == 200
    blob = export_resp.content

    import_resp = client.post(
        "/api/scenario/import-snapshot",
        files={"file": ("snap.zip", blob, "application/zip")},
    )
    assert import_resp.status_code == 200, import_resp.text
    body = import_resp.json()
    assert body["status"] == "imported"
    new_scenario_id = body["scenario_id"]
    assert new_scenario_id != scenario_id

    with Session(get_engine()) as session:
        new_branches = list(
            session.exec(
                select(Branch).where(Branch.scenario_id == new_scenario_id)
            ).all()
        )
        assert len(new_branches) == 2


def test_api_import_endpoint_rejects_empty_upload(client):
    response = client.post(
        "/api/scenario/import-snapshot",
        files={"file": ("snap.zip", b"", "application/zip")},
    )
    assert response.status_code == 422
    body = response.json()
    assert body.get("detail", {}).get("code") == "SNAPSHOT_FILE_EMPTY"


def test_api_import_endpoint_rejects_invalid_zip(client):
    response = client.post(
        "/api/scenario/import-snapshot",
        files={"file": ("snap.zip", b"not-a-zip", "application/zip")},
    )
    assert response.status_code == 422
    body = response.json()
    assert body.get("detail", {}).get("code") == "SNAPSHOT_IMPORT_INVALID"


@pytest.mark.asyncio
async def test_read_snapshot_upload_stops_after_size_limit():
    from app.api.scenarios import (
        MAX_IMPORT_SNAPSHOT_BYTES,
        SNAPSHOT_UPLOAD_CHUNK_BYTES,
        _read_snapshot_upload,
    )

    class OversizedUpload:
        def __init__(self) -> None:
            self.read_calls = 0

        async def read(self, size: int = -1) -> bytes:
            self.read_calls += 1
            assert size == SNAPSHOT_UPLOAD_CHUNK_BYTES
            return b"x" * SNAPSHOT_UPLOAD_CHUNK_BYTES

    upload = OversizedUpload()
    with pytest.raises(HTTPException) as excinfo:
        await _read_snapshot_upload(upload)  # type: ignore[arg-type]

    assert excinfo.value.status_code == 413
    max_allowed_reads = (MAX_IMPORT_SNAPSHOT_BYTES // SNAPSHOT_UPLOAD_CHUNK_BYTES) + 1
    assert upload.read_calls == max_allowed_reads


def test_api_export_allows_signed_owner_when_auth_enabled(client, monkeypatch):
    secret = "snapshot-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    scenario_id = _seed_scenario(api_key_in_context=False, user_id="owner-a")

    response = client.get(
        f"/api/scenario/{scenario_id}/snapshot",
        headers={"X-Session-Token": _make_signed_token(secret, "owner-a")},
    )

    assert response.status_code == 200, response.text


def test_api_export_rejects_cross_owner_when_auth_enabled(client, monkeypatch):
    secret = "snapshot-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    scenario_id = _seed_scenario(api_key_in_context=False, user_id="owner-a")

    response = client.get(
        f"/api/scenario/{scenario_id}/snapshot",
        headers={"X-Session-Token": _make_signed_token(secret, "owner-b")},
    )

    assert response.status_code == 404
    assert response.json().get("detail", {}).get("code") == "SCENARIO_NOT_FOUND"


def test_api_export_rejects_raw_secret_when_signed_principal_required(client, monkeypatch):
    secret = "snapshot-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    scenario_id = _seed_scenario(api_key_in_context=False, user_id="owner-a")

    response = client.get(
        f"/api/scenario/{scenario_id}/snapshot",
        headers={"X-Session-Token": secret},
    )

    assert response.status_code == 401
    assert response.json().get("detail", {}).get("code") == "SESSION_PRINCIPAL_REQUIRED"


def test_api_import_assigns_signed_principal_owner(client, monkeypatch):
    secret = "snapshot-secret"
    monkeypatch.setattr(settings, "SESSION_SECRET", secret)
    scenario_id = _seed_scenario(api_key_in_context=False, user_id="owner-a")
    _seed_branch_tree(scenario_id)

    export_resp = client.get(
        f"/api/scenario/{scenario_id}/snapshot",
        headers={"X-Session-Token": _make_signed_token(secret, "owner-a")},
    )
    assert export_resp.status_code == 200

    import_resp = client.post(
        "/api/scenario/import-snapshot",
        files={"file": ("snap.zip", export_resp.content, "application/zip")},
        headers={"X-Session-Token": _make_signed_token(secret, "importer-a")},
    )

    assert import_resp.status_code == 200, import_resp.text
    new_scenario_id = import_resp.json()["scenario_id"]
    with Session(get_engine()) as session:
        imported = session.get(Scenario, new_scenario_id)
    assert imported is not None
    assert imported.user_id == "importer-a"


# ── security regression tests (Critical/Warning fixes) ───


def _seed_agent_with_identity(scenario_id: str, identity_id: str) -> str:
    """Create one agent that points at an arbitrary identity row."""
    with Session(get_engine()) as session:
        agent = Agent(
            scenario_id=scenario_id,
            name="bound",
            role="role",
            persona="persona",
            tier=AgentTier.CORE,
            agent_identity_id=identity_id,
        )
        session.add(agent)
        session.commit()
        return agent.id


def test_import_clears_agent_identity_id_to_prevent_cross_user_binding():
    """Critical #1: importer must not inherit the exporter's identity link."""
    src_scenario_id = _seed_scenario(api_key_in_context=False)
    foreign_identity_id = "owner-A-identity-xyz"
    _seed_agent_with_identity(src_scenario_id, foreign_identity_id)

    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(src_scenario_id, session)
    blob = buffer.getvalue()

    # Sanity: the export does carry the original identity id (round-trip
    # bytes are inspected before import strips it).
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        agents_dump = zf.read("agents.jsonl").decode("utf-8")
    assert foreign_identity_id in agents_dump

    with Session(get_engine()) as session:
        new_id = import_snapshot_zip(blob, "importer-foreign", session)

    with Session(get_engine()) as session:
        new_agents = list(
            session.exec(select(Agent).where(Agent.scenario_id == new_id)).all()
        )
        assert new_agents, "import should have created at least one agent"
        for a in new_agents:
            assert a.agent_identity_id is None, (
                "agent_identity_id must be cleared on import to prevent "
                "cross-user identity binding"
            )


def test_import_ignores_zip_files_not_listed_in_manifest():
    """Warning #1: only manifest.files entries should be honoured."""
    scenario_id = _seed_scenario(api_key_in_context=False)
    _seed_branch_tree(scenario_id)
    with Session(get_engine()) as session:
        buffer = export_snapshot_zip(scenario_id, session)
    blob = buffer.getvalue()

    # Build a tampered ZIP that injects an extra unsigned file *after*
    # the manifest was sealed. Importer must drop it on the floor and
    # never read its bytes (it must NOT smuggle data into the new scenario).
    src = zipfile.ZipFile(io.BytesIO(blob))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in src.namelist():
            zf.writestr(name, src.read(name))
        zf.writestr("rogue.json", json.dumps({"injected": "data"}))
    src.close()

    with Session(get_engine()) as session:
        new_id = import_snapshot_zip(out.getvalue(), "importer-extra", session)

    # Import should succeed but ignore the rogue file.
    assert new_id

    # Re-read the imported ZIP via the validator to assert the extra file
    # is excluded from the contents map (only manifest-listed files are
    # returned; manifest.json itself is consumed but not exposed as content).
    from app.services.snapshot_export import _validate_zip_integrity
    contents = _validate_zip_integrity(out.getvalue())
    assert "rogue.json" not in contents
    assert "scenario.json" in contents


def test_redaction_is_case_insensitive_and_separator_insensitive():
    """Warning #2: ``apiKey``/``API-KEY``/``Authorization`` must be stripped."""
    scenario = Scenario(
        question="probe",
        status=ScenarioStatus.DONE,
        user_id="probe",
        parsed_context={
            "apiKey": "sk-camelcase-leak",
            "API-KEY": "sk-dashed-leak",
            "Authorization": "Bearer bearer-leak",
            "X-Api-Key": "sk-x-leak",
            "WEBSEARCHAPIKEY": "sk-webcap-leak",
            "Password": "pw-leak",
            "kept_field": "ok",
        },
    )
    with Session(get_engine()) as session:
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id

    with Session(get_engine()) as session:
        raw = export_snapshot_zip(scenario_id, session).getvalue()

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        scenario_payload = json.loads(zf.read("scenario.json"))

    parsed = scenario_payload.get("parsed_context") or {}
    assert "kept_field" in parsed
    forbidden = (
        "apiKey",
        "API-KEY",
        "Authorization",
        "X-Api-Key",
        "WEBSEARCHAPIKEY",
        "Password",
    )
    for key in forbidden:
        assert key not in parsed, f"{key} leaked through redaction"
    # Secret values must not survive as raw bytes either.
    for needle in (
        b"sk-camelcase-leak",
        b"sk-dashed-leak",
        b"bearer-leak",
        b"sk-x-leak",
        b"sk-webcap-leak",
        b"pw-leak",
    ):
        assert needle not in raw, f"{needle!r} leaked into export bytes"


def test_redaction_drops_common_secret_key_variants():
    """Provider-specific key names must be treated as secret material."""
    scenario = Scenario(
        question="provider secret variants",
        status=ScenarioStatus.DONE,
        parsed_context={
            "openai_api_key": "sk-openai-leak",
            "provider_token": "provider-token-leak",
            "xai_api_key": "sk-xai-leak",
            "safe_note": "keep me",
        },
    )
    with Session(get_engine()) as session:
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id

    with Session(get_engine()) as session:
        raw = export_snapshot_zip(scenario_id, session).getvalue()

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        scenario_payload = json.loads(zf.read("scenario.json"))

    parsed = scenario_payload.get("parsed_context") or {}
    assert parsed == {"safe_note": "keep me"}
    for needle in (b"sk-openai-leak", b"provider-token-leak", b"sk-xai-leak"):
        assert needle not in raw


def test_export_redacts_branch_key_moments_json_string():
    scenario_id = _seed_scenario(api_key_in_context=False)
    with Session(get_engine()) as session:
        branch = Branch(
            scenario_id=scenario_id,
            title="secret moments",
            key_moments=json.dumps(
                {
                    "summary": "visible",
                    "api_key": "sk-branch-leak",
                    "base_url": "https://branch-secret.example/v1",
                }
            ),
            status=BranchStatus.COMPLETED,
        )
        session.add(branch)
        session.commit()

    with Session(get_engine()) as session:
        raw = export_snapshot_zip(scenario_id, session).getvalue()

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        branches = [
            json.loads(line)
            for line in zf.read("branches.jsonl").decode("utf-8").splitlines()
            if line
        ]

    exported = json.loads(branches[0]["key_moments"])
    assert exported == {"summary": "visible"}
    assert b"sk-branch-leak" not in raw
    assert b"branch-secret.example" not in raw


def test_export_redacts_web_context_json_string():
    """Warning #2: ``web_context_json`` (JSON-encoded text) must also be scrubbed."""
    web_payload = {
        "provider": "tavily",
        "api_key": "sk-tavily-leak",
        "Authorization": "Bearer tav-bearer",
        "snippets": [
            {"text": "hi", "apiKey": "sk-snippet-leak"},
        ],
    }
    scenario = Scenario(
        question="probe-web",
        status=ScenarioStatus.DONE,
        parsed_context={"mode": "blackboard"},
        web_context_json=json.dumps(web_payload),
    )
    with Session(get_engine()) as session:
        session.add(scenario)
        session.commit()
        scenario_id = scenario.id

    with Session(get_engine()) as session:
        raw = export_snapshot_zip(scenario_id, session).getvalue()

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        scenario_payload = json.loads(zf.read("scenario.json"))

    web_str = scenario_payload.get("web_context_json")
    assert isinstance(web_str, str), "JSON-string fields stay encoded after redact"
    web = json.loads(web_str)
    assert web.get("provider") == "tavily", "non-secret fields must survive"
    assert "api_key" not in web
    assert "Authorization" not in web
    snippets = web.get("snippets") or []
    assert snippets and "apiKey" not in snippets[0]
    for needle in (b"sk-tavily-leak", b"tav-bearer", b"sk-snippet-leak"):
        assert needle not in raw


@pytest.mark.parametrize(
    ("filename", "payloads"),
    [
        (
            "scenario.json",
            {
                "scenario.json": b"\xff",
                "branches.jsonl": b"",
                "agents.jsonl": b"",
                "messages.jsonl": b"",
                "causal_graph.json": b'{"snapshot":null,"nodes":[],"edges":[]}',
            },
        ),
        (
            "branches.jsonl",
            {
                "scenario.json": json.dumps({"question": "bad jsonl"}).encode("utf-8"),
                "branches.jsonl": b"\xff",
                "agents.jsonl": b"",
                "messages.jsonl": b"",
                "causal_graph.json": b'{"snapshot":null,"nodes":[],"edges":[]}',
            },
        ),
        (
            "agents.jsonl",
            {
                "scenario.json": json.dumps({"question": "bad agents"}).encode("utf-8"),
                "branches.jsonl": b"",
                "agents.jsonl": b"\xff",
                "messages.jsonl": b"",
                "causal_graph.json": b'{"snapshot":null,"nodes":[],"edges":[]}',
            },
        ),
        (
            "messages.jsonl",
            {
                "scenario.json": json.dumps({"question": "bad messages"}).encode("utf-8"),
                "branches.jsonl": b"",
                "agents.jsonl": b"",
                "messages.jsonl": b"\xff",
                "causal_graph.json": b'{"snapshot":null,"nodes":[],"edges":[]}',
            },
        ),
        (
            "causal_graph.json",
            {
                "scenario.json": json.dumps({"question": "bad graph"}).encode("utf-8"),
                "branches.jsonl": b"",
                "agents.jsonl": b"",
                "messages.jsonl": b"",
                "causal_graph.json": b"\xff",
            },
        ),
    ],
)
def test_import_rejects_non_utf8_json_payloads(filename, payloads):
    blob = _build_snapshot_zip_from_payloads(payloads)

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(blob, "importer-utf8", session)

    assert filename in str(excinfo.value)
    assert "utf-8" in str(excinfo.value).lower()


def test_import_rejects_zip_bomb_oversized_member():
    """Warning #3: huge uncompressed members must be rejected up-front."""
    # Craft a manifest+huge.bin pair where huge.bin claims a giant uncompressed
    # size. Use a single zero byte as actual content; deflate ratio is 1:1
    # which is fine -- we are testing the file_size check (uncompressed).
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "version": "1.0",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "scenario_id": "x",
                    "graph_schema_version": 1,
                    "include_private": False,
                    "files": {},
                }
            ),
        )
        # Build a real (non-bomb) member but set an inflated file_size on the
        # ZipInfo so the guard treats it as oversized. We actually write a
        # huge buffer (compresses small) so file_size reflects the truth.
        from app.services.snapshot_export import (
            MAX_UNCOMPRESSED_MEMBER_BYTES,
        )
        oversized = MAX_UNCOMPRESSED_MEMBER_BYTES + 1024
        zf.writestr("huge.bin", b"0" * oversized)

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-bomb", session)
    assert "after decompression" in str(excinfo.value).lower() or "too large" in str(
        excinfo.value
    ).lower()


def test_import_rejects_zip_bomb_aggregate_size(monkeypatch):
    """Warning #3: many medium members must hit the aggregate cap."""
    import app.services.snapshot_export as snapshot_export_module

    monkeypatch.setattr(snapshot_export_module, "MAX_ZIP_COMPRESSION_RATIO", float("inf"))
    # Each member just under the per-file cap; need enough to exceed total.
    member_size = snapshot_export_module.MAX_UNCOMPRESSED_MEMBER_BYTES - 1024
    n_members = (snapshot_export_module.MAX_UNCOMPRESSED_TOTAL_BYTES // member_size) + 2

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "version": "1.0",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "scenario_id": "x",
                    "graph_schema_version": 1,
                    "include_private": False,
                    "files": {},
                }
            ),
        )
        # Compresses to almost nothing, but file_size still reflects truth.
        chunk = b"0" * member_size
        for i in range(n_members):
            zf.writestr(f"chunk_{i}.bin", chunk)

    with pytest.raises(SnapshotImportError) as excinfo:
        with Session(get_engine()) as session:
            import_snapshot_zip(out.getvalue(), "importer-bomb-agg", session)
    msg = str(excinfo.value).lower()
    assert "uncompressed" in msg or "too large" in msg
