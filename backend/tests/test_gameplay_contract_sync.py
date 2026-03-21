"""Sync checks between the shared gameplay contract and backend card events."""

import os

from app.services.gameplay_contract import load_gameplay_contract
from app.visualization.card_events import CARD_TYPES


def test_backend_card_types_match_contract_ids():
    contract = load_gameplay_contract()
    contract_ids = {card["id"] for card in contract["cards"]}
    assert set(CARD_TYPES) == contract_ids


def test_backend_trigger_modes_follow_contract():
    contract = load_gameplay_contract()
    contract_by_id = {card["id"]: card for card in contract["cards"]}

    for card_id, card_type in CARD_TYPES.items():
        expected_trigger = "auto" if contract_by_id[card_id]["auto_enabled"] else "manual"
        assert card_type["trigger"] == expected_trigger


def test_backend_branching_bonus_follows_contract():
    contract = load_gameplay_contract()
    contract_by_id = {card["id"]: card for card in contract["cards"]}

    for card_id, card_type in CARD_TYPES.items():
        assert card_type["branching_bonus"] == contract_by_id[card_id].get("branching_bonus", 0)


def test_gameplay_contract_reload_tracks_file_mtime(tmp_path, monkeypatch):
    contract_path = tmp_path / "gameplay_contract.v1.json"
    contract_path.write_text('{"cards": [{"id": "alpha"}]}', encoding="utf-8")

    monkeypatch.setattr("app.services.gameplay_contract.CONTRACT_PATH", contract_path)
    monkeypatch.setattr("app.services.gameplay_contract._CONTRACT_CACHE", None)

    first = load_gameplay_contract()
    assert first["cards"][0]["id"] == "alpha"

    contract_path.write_text('{"cards": [{"id": "beta"}]}', encoding="utf-8")
    stat = contract_path.stat()
    os.utime(contract_path, ns=(stat.st_atime_ns + 1_000_000, stat.st_mtime_ns + 1_000_000))

    second = load_gameplay_contract()
    assert second["cards"][0]["id"] == "beta"
