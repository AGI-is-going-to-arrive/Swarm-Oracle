"""Shared gameplay contract loader."""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

CONTRACT_PATH = Path(__file__).resolve().parents[3] / "shared" / "gameplay_contract.v1.json"
_CONTRACT_CACHE: tuple[int, dict[str, Any]] | None = None
_CONTRACT_CACHE_LOCK = Lock()


def load_gameplay_contract() -> dict[str, Any]:
    global _CONTRACT_CACHE

    with _CONTRACT_CACHE_LOCK:
        try:
            with CONTRACT_PATH.open("r", encoding="utf-8") as handle:
                mtime_ns = os.fstat(handle.fileno()).st_mtime_ns
                if _CONTRACT_CACHE is not None and _CONTRACT_CACHE[0] == mtime_ns:
                    return _CONTRACT_CACHE[1]

                contract = json.load(handle)
        except FileNotFoundError as exc:
            raise RuntimeError(
                f"Gameplay contract file is missing: {CONTRACT_PATH}. "
                "Restore shared/gameplay_contract.v1.json before starting the backend."
            ) from exc

        _CONTRACT_CACHE = (mtime_ns, contract)
        return contract
