"""Shared gameplay contract loader."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

CONTRACT_PATH = Path(__file__).resolve().parents[3] / "shared" / "gameplay_contract.v1.json"


@lru_cache(maxsize=1)
def load_gameplay_contract() -> dict[str, Any]:
    with CONTRACT_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)
