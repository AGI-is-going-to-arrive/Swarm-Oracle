"""Tests for local bilingual content packs."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.local_packs import (
    MAX_PACK_FILE_BYTES,
    LocalPackLoader,
    check_bilingual_parity,
    load_local_packs,
)


def _valid_pack(pack_id: str = "valid-pack") -> dict:
    return {
        "schema_version": 1,
        "id": pack_id,
        "genre": "technology",
        "title": {
            "zh": "海上电报城",
            "en": "The Telegraph Port City",
        },
        "description": {
            "zh": "一座海港先建起跨洋电报协定，贸易、劳工和教育随之重排。",
            "en": (
                "A port city builds a transoceanic telegraph compact first, "
                "then trade, labor, and education reorder around it."
            ),
        },
        "tags": [
            {"zh": "技术", "en": "technology"},
            {"zh": "城市", "en": "cities"},
        ],
        "scenario_templates": [
            {
                "id": "main",
                "question": {
                    "zh": "如果海港城市先建立公共电报网络，会怎样改变区域贸易？",
                    "en": (
                        "What if a port city built a public telegraph network "
                        "before its rivals?"
                    ),
                },
                "context": {
                    "zh": "商会、码头工人和学校都能低价发送短讯，但政府尚未决定监管规则。",
                    "en": (
                        "Guilds, dockworkers, and schools can send low-cost "
                        "messages before regulators decide the rules."
                    ),
                },
                "prompt": {
                    "zh": "推演通信成本下降后，谁获得新议价权，谁承担新风险。",
                    "en": (
                        "Explore who gains bargaining power and who carries "
                        "new risk after communication costs fall."
                    ),
                },
                "stakes": [
                    {"zh": "码头排班是否更公平", "en": "whether dock shifts become fairer"},
                    {"zh": "商会是否垄断线路", "en": "whether guilds monopolize the wires"},
                ],
            }
        ],
        "agent_casts": [
            {
                "id": "dock-organizer",
                "name": {"zh": "码头组织者", "en": "Dock Organizer"},
                "role": {"zh": "代表临时工协商排班", "en": "Bargains for casual labor shifts"},
                "perspective": {
                    "zh": "担心新网络只让雇主更快压价。",
                    "en": "Worries the new network lets employers cut wages faster.",
                },
            }
        ],
        "demo_snapshots": [
            {
                "id": "baseline",
                "label": {"zh": "基线演示", "en": "Baseline Demo"},
                "filename": "valid-pack-baseline.json",
            }
        ],
        "suggested_settings": {
            "num_agents": 8,
            "rounds": 6,
            "simulation_mode": "balanced",
            "language": "bilingual",
        },
        "source_metadata": {
            "curator": "SwarmOracle",
            "created_at": "2026-06-12",
            "license": "original",
            "notes": {
                "zh": "原创本地内容包，不依赖远程来源。",
                "en": "Original local content pack with no remote dependency.",
            },
        },
    }


def _write_pack(path: Path, pack: dict) -> None:
    path.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")


def _codes(registry) -> set[str]:
    return {diagnostic.code for diagnostic in registry.diagnostics}


def test_valid_pack_loads_and_returns_summary(tmp_path: Path):
    _write_pack(tmp_path / "valid.json", _valid_pack())

    registry = load_local_packs(tmp_path)

    assert [pack.id for pack in registry.packs] == ["valid-pack"]
    assert registry.diagnostics == []
    assert registry.summaries() == [
        {
            "schema_version": 1,
            "id": "valid-pack",
            "genre": "technology",
            "title": {"zh": "海上电报城", "en": "The Telegraph Port City"},
            "description": _valid_pack()["description"],
            "tags": _valid_pack()["tags"],
            "scenario_count": 1,
            "agent_cast_count": 1,
            "demo_snapshot_count": 1,
            "suggested_settings": _valid_pack()["suggested_settings"],
            "source_metadata": _valid_pack()["source_metadata"],
        }
    ]


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda pack: pack.update({"unexpected": True}), "UNKNOWN_FIELD"),
        (lambda pack: pack.update({"id": "Bad Id"}), "ILLEGAL_ID"),
        (
            lambda pack: pack["demo_snapshots"][0].update({"filename": "../escape.json"}),
            "PATH_TRAVERSAL",
        ),
        (lambda pack: pack["title"].update({"zh": "Same", "en": "Same"}), "BILINGUAL_PARITY"),
        (lambda pack: pack["scenario_templates"][0].update({"missing": True}), "UNKNOWN_FIELD"),
    ],
)
def test_schema_rejection_truth_table(tmp_path: Path, mutate, expected_code: str):
    pack = _valid_pack()
    mutate(pack)
    _write_pack(tmp_path / "bad.json", pack)

    registry = load_local_packs(tmp_path)

    assert registry.packs == []
    assert expected_code in _codes(registry)


@pytest.mark.parametrize(
    "bad_id",
    ["Bad-pack", "bad pack", "bad/pack", "bad\\pack", "bad..pack", "-bad", "bad-"],
)
def test_illegal_ids_reject_path_chars_case_whitespace_and_dotdot(
    tmp_path: Path,
    bad_id: str,
):
    pack = _valid_pack(bad_id)
    _write_pack(tmp_path / "bad.json", pack)

    registry = load_local_packs(tmp_path)

    assert registry.packs == []
    assert "ILLEGAL_ID" in _codes(registry)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda pack: pack["title"].update({"zh": "题" * 121}),
        lambda pack: pack["description"].update({"en": "description " * 90}),
        lambda pack: pack["scenario_templates"][0]["prompt"].update({"en": "template " * 230}),
    ],
)
def test_overlong_title_description_and_template_text_rejected(tmp_path: Path, mutate):
    pack = _valid_pack()
    mutate(pack)
    _write_pack(tmp_path / "bad.json", pack)

    registry = load_local_packs(tmp_path)

    assert registry.packs == []
    assert "TEXT_TOO_LONG" in _codes(registry)


def test_duplicate_id_rejected_without_breaking_first_valid_pack(tmp_path: Path):
    _write_pack(tmp_path / "a.json", _valid_pack("duplicate-pack"))
    _write_pack(tmp_path / "b.json", _valid_pack("duplicate-pack"))

    registry = load_local_packs(tmp_path)

    assert [pack.id for pack in registry.packs] == ["duplicate-pack"]
    assert "DUPLICATE_ID" in _codes(registry)


def test_malformed_json_and_oversized_files_are_diagnostics(tmp_path: Path):
    (tmp_path / "malformed.json").write_text("{not valid", encoding="utf-8")
    (tmp_path / "oversize.json").write_bytes(b"x" * (MAX_PACK_FILE_BYTES + 1))

    registry = load_local_packs(tmp_path)

    assert registry.packs == []
    assert {"MALFORMED_JSON", "FILE_TOO_LARGE"}.issubset(_codes(registry))


def test_bad_pack_isolation_keeps_valid_packs_loading(tmp_path: Path):
    _write_pack(tmp_path / "valid.json", _valid_pack("good-pack"))
    bad = _valid_pack("bad-pack")
    bad["title"]["en"] = ""
    _write_pack(tmp_path / "bad.json", bad)

    registry = load_local_packs(tmp_path)

    assert [pack.id for pack in registry.packs] == ["good-pack"]
    assert "BILINGUAL_PARITY" in _codes(registry)


def test_refresh_is_idempotent_and_read_only(tmp_path: Path):
    packs_dir = tmp_path / "packs"
    packs_dir.mkdir()
    _write_pack(packs_dir / "valid.json", _valid_pack())
    loader = LocalPackLoader(packs_dir)

    first = loader.refresh().to_response(include_diagnostics=True)
    second = loader.refresh().to_response(include_diagnostics=True)

    assert first == second
    assert sorted(path.name for path in packs_dir.iterdir()) == ["valid.json"]


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlink not supported")
def test_symlinked_pack_file_rejected(tmp_path: Path):
    target = tmp_path / "target.json"
    link = tmp_path / "linked.json"
    _write_pack(target, _valid_pack("target-pack"))
    try:
        link.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    registry = load_local_packs(tmp_path)

    assert [pack.id for pack in registry.packs] == ["target-pack"]
    assert "SYMLINK_PACK_FILE" in _codes(registry)


def test_endpoint_feature_gate_list_refresh_diagnostics_and_detail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import app.api.packs as packs_api

    _write_pack(tmp_path / "valid.json", _valid_pack())
    bad = _valid_pack("bad-pack")
    bad["id"] = "Bad Pack"
    _write_pack(tmp_path / "bad.json", bad)
    monkeypatch.setattr(packs_api.settings, "PACKS_DIR", tmp_path)

    client = TestClient(app)
    monkeypatch.setattr(packs_api.settings, "FEATURE_LOCAL_PACKS", False, raising=False)
    disabled = client.get("/api/packs")
    assert disabled.status_code == 404
    assert disabled.json()["detail"]["code"] == "FEATURE_DISABLED"

    monkeypatch.setattr(packs_api.settings, "FEATURE_LOCAL_PACKS", True, raising=False)
    listed = client.get("/api/packs")
    assert listed.status_code == 200
    assert listed.json()["count"] == 1
    assert listed.json()["packs"][0]["id"] == "valid-pack"
    assert "scenario_templates" not in listed.json()["packs"][0]

    detail = client.get("/api/packs/valid-pack")
    assert detail.status_code == 200
    assert detail.json()["id"] == "valid-pack"
    assert detail.json()["scenario_templates"][0]["id"] == "main"

    missing = client.get("/api/packs/missing-pack")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "PACK_NOT_FOUND"

    diagnostics = client.get("/api/packs/diagnostics")
    assert diagnostics.status_code == 200
    assert diagnostics.json()["count"] == 1
    assert diagnostics.json()["diagnostics"][0]["code"] == "ILLEGAL_ID"

    refreshed = client.post("/api/packs/refresh")
    assert refreshed.status_code == 200
    assert refreshed.json()["count"] == 1
    assert refreshed.json()["diagnostic_count"] == 1


def test_shipped_packs_parse_have_parity_and_avoid_red_line_themes():
    packs_dir = Path(__file__).resolve().parents[2] / "packs"
    raw_text = "\n".join(path.read_text(encoding="utf-8") for path in packs_dir.glob("*.json"))
    forbidden = [
        "Miro" + "Fish",
        "\u7ea2\u697c\u68a6",
        "Dream of the Red " + "Chamber",
        "\u6b66\u5927",
        "Wuhan " + "University",
    ]

    for forbidden_text in forbidden:
        assert forbidden_text not in raw_text

    registry = load_local_packs(packs_dir)

    assert 6 <= len(registry.packs) <= 10
    assert registry.diagnostics == []
    assert "zheng-he" in {pack.id for pack in registry.packs}
    for path in packs_dir.glob("*.json"):
        with path.open(encoding="utf-8") as handle:
            json.load(handle)
    for pack in registry.packs:
        assert check_bilingual_parity(pack) == []
        original = copy.deepcopy(pack.model_dump(mode="json"))
        assert original["title"]["zh"]
        assert original["title"]["en"]
