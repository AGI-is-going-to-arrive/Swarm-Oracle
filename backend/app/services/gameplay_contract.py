"""Shared gameplay contract loader."""

from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any

CONTRACT_PATH = Path(__file__).resolve().parents[3] / "shared" / "gameplay_contract.v1.json"
_CONTRACT_CACHE: tuple[int, dict[str, Any]] | None = None
_CONTRACT_CACHE_LOCK = Lock()


def load_gameplay_contract() -> dict[str, Any]:
    global _CONTRACT_CACHE

    try:
        mtime_ns = CONTRACT_PATH.stat().st_mtime_ns
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Gameplay contract file is missing: {CONTRACT_PATH}. "
            "Restore shared/gameplay_contract.v1.json before starting the backend."
        ) from exc
    with _CONTRACT_CACHE_LOCK:
        if _CONTRACT_CACHE is not None and _CONTRACT_CACHE[0] == mtime_ns:
            return _CONTRACT_CACHE[1]

        with CONTRACT_PATH.open("r", encoding="utf-8") as handle:
            contract = json.load(handle)
        _CONTRACT_CACHE = (mtime_ns, contract)
        return contract
