"""Sync checks between the shared gameplay contract and backend card events."""

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
