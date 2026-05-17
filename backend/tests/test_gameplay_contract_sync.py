"""Sync checks between the shared gameplay contract and backend card events."""

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import pytest

from app.services.gameplay_contract import load_gameplay_contract
from app.visualization.card_events import CARD_TYPES

REPO_ROOT = Path(__file__).resolve().parents[2]
THEME_REGISTRY_PATH = REPO_ROOT / "frontend" / "src" / "lib" / "themeRegistry.ts"


def _frontend_gameplay_profile_ids() -> set[str]:
    source = THEME_REGISTRY_PATH.read_text(encoding="utf-8")
    match = re.search(r"export type GameplayProfileId\s*=(?P<body>.*?);", source, re.S)
    assert match is not None
    return set(re.findall(r"'([^']+)'", match.group("body")))


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


def test_gameplay_contract_profiles_cover_frontend_profile_ids():
    contract = load_gameplay_contract()
    contract_profile_ids = {profile["id"] for profile in contract["profiles"]}
    frontend_profile_ids = _frontend_gameplay_profile_ids()

    assert frontend_profile_ids - {"generic"} <= contract_profile_ids


def test_gameplay_contract_profile_directives_cover_all_cards():
    contract = load_gameplay_contract()
    card_ids = {card["id"] for card in contract["cards"]}

    for profile in contract["profiles"]:
        assert set(profile["default_directives"]) == card_ids


def test_gameplay_contract_profile_recommendations_exist_in_cards():
    contract = load_gameplay_contract()
    card_ids = {card["id"] for card in contract["cards"]}

    for profile in contract["profiles"]:
        assert set(profile["recommended_cards"]) <= card_ids


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


def test_gameplay_contract_missing_file_raises_clear_error(tmp_path, monkeypatch):
    missing_path = tmp_path / "missing.json"

    monkeypatch.setattr("app.services.gameplay_contract.CONTRACT_PATH", missing_path)
    monkeypatch.setattr("app.services.gameplay_contract._CONTRACT_CACHE", None)

    with pytest.raises(RuntimeError, match="Gameplay contract file is missing"):
        load_gameplay_contract()


def test_gameplay_contract_cache_refresh_is_thread_safe(tmp_path, monkeypatch):
    contract_path = tmp_path / "gameplay_contract.v1.json"
    contract_path.write_text('{"cards": [{"id": "alpha"}]}', encoding="utf-8")

    monkeypatch.setattr("app.services.gameplay_contract.CONTRACT_PATH", contract_path)
    monkeypatch.setattr("app.services.gameplay_contract._CONTRACT_CACHE", None)

    real_open = Path.open
    open_count = 0
    open_count_lock = Lock()

    def delayed_open(self, *args, **kwargs):
        nonlocal open_count
        if self == contract_path:
            with open_count_lock:
                open_count += 1
            time.sleep(0.05)
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", delayed_open)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: load_gameplay_contract(), range(8)))

    assert open_count == 8
    assert all(result == results[0] for result in results)
    assert results[0]["cards"][0]["id"] == "alpha"


def test_gameplay_contract_uses_opened_file_stat_for_cache_key(tmp_path, monkeypatch):
    contract_path = tmp_path / "gameplay_contract.v1.json"
    contract_path.write_text('{"cards": [{"id": "alpha"}]}', encoding="utf-8")

    monkeypatch.setattr("app.services.gameplay_contract.CONTRACT_PATH", contract_path)
    monkeypatch.setattr("app.services.gameplay_contract._CONTRACT_CACHE", None)
    monkeypatch.setattr(Path, "stat", lambda self: (_ for _ in ()).throw(
        AssertionError("load_gameplay_contract should not call Path.stat")
    ))

    contract = load_gameplay_contract()
    assert contract["cards"][0]["id"] == "alpha"
