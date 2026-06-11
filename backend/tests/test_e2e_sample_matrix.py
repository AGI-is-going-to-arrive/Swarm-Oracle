"""Regression checks for Track C fixed E2E sample matrices."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.visualization.scene_selector import select_scene

REPO_ROOT = Path(__file__).resolve().parents[2]
E2E_OUTPUT_ROOT = REPO_ROOT / "frontend" / "output" / "e2e"


def _load_samples(file_name: str) -> list[dict[str, object]]:
    sample_path = E2E_OUTPUT_ROOT / file_name
    if not sample_path.exists():
        pytest.skip(f"{file_name} is an optional generated E2E artifact")
    payload = json.loads(sample_path.read_text(encoding="utf-8"))
    return payload["samples"]


def test_main_sample_matrix_scene_themes_match_selector():
    for sample in _load_samples("sample_matrix.json"):
        assert sample["scene_theme"] == select_scene(sample["question"])


def test_variant_sample_matrix_scene_themes_match_selector():
    for sample in _load_samples("sample_matrix_variants.json"):
        assert sample["scene_theme"] == select_scene(sample["question"])
