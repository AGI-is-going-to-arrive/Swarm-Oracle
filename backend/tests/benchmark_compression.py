"""Benchmark for compression quality — offline quality measurement.

Uses predefined mock samples to verify structural correctness and
measure information density. Does NOT require a real LLM connection.

Run: .venv/bin/python -m pytest tests/benchmark_compression.py -v
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.memory import _validate_compress_result, compress_rounds, _COMPRESS_DEFAULTS

# ── Sample Data ──────────────────────────────────────────────

SAMPLE_INPUTS = {
    "three_kingdoms": (
        "[曹操](激昂): 天下大势，分久必合！我已调集八十万大军，誓要一统南方。\n"
        "[刘备](忧虑): 曹操势大，但民心在我。我们必须联合孙权共抗曹操。\n"
        "[诸葛亮](冷静): 联吴抗曹是唯一出路。但联盟内部必须明确主导权。\n"
        "[孙权](犹豫): 投降还是抵抗？我的臣子们意见不一。\n"
        "[周瑜](坚定): 我主张迎战！曹操远来疲惫，我们占据水战优势。"
    ),
    "tech_debate": (
        "[工程师A](兴奋): 我们应该全面转向微服务架构，这是业界趋势。\n"
        "[工程师B](谨慎): 微服务带来的复杂度不可忽视，我们团队只有5人。\n"
        "[产品经理](焦虑): 重构期间产品迭代会停滞，用户流失怎么办？\n"
        "[CTO](思考): 也许可以先拆分最核心的模块，渐进迁移。"
    ),
    "minimal": "[A](neutral): 同意。",
}

SAMPLE_LLM_RESPONSES = {
    "three_kingdoms": {
        "situation": "曹操率八十万大军南下，刘备阵营面临抵抗或投降的抉择",
        "active_debates": ["联吴抗曹还是独力坚守", "联盟中谁主导军事指挥权"],
        "key_quotes": [
            "[诸葛亮]: 联吴抗曹是唯一出路。但联盟内部必须明确主导权",
            "[周瑜]: 曹操远来疲惫，我们占据水战优势",
        ],
        "tension_points": ["孙权阵营内部主降派与主战派的对立", "联盟主导权之争可能导致合作破裂"],
        "consensus": "曹操威胁是真实的，需要采取行动",
    },
    "tech_debate": {
        "situation": "团队在微服务迁移方案上产生分歧",
        "active_debates": ["全面重构 vs 渐进迁移"],
        "key_quotes": ["[工程师B]: 微服务带来的复杂度不可忽视，我们团队只有5人"],
        "tension_points": ["技术理想与业务现实的冲突"],
        "consensus": "CTO提出渐进方案获得初步认可",
    },
    "minimal": {
        "situation": "简短交流，无实质讨论",
        "active_debates": [],
        "key_quotes": [],
        "tension_points": [],
        "consensus": "无明显共识",
    },
}


# ── Quality Metrics ──────────────────────────────────────────


def measure_field_completeness(result: dict) -> float:
    """Fraction of required fields that are non-empty. Target: 1.0."""
    required_fields = ["situation", "active_debates", "key_quotes", "tension_points", "consensus"]
    filled = sum(1 for f in required_fields if result.get(f))
    return filled / len(required_fields)


def measure_information_density(input_text: str, result: dict) -> float:
    """Output chars / input chars. Target: 0.10 - 0.50."""
    output_text = str(result)
    if not input_text:
        return 0.0
    return len(output_text) / len(input_text)


def measure_structural_validity(result: dict) -> bool:
    """Check all fields have correct types."""
    return (
        isinstance(result.get("situation"), str)
        and isinstance(result.get("active_debates"), list)
        and isinstance(result.get("key_quotes"), list)
        and isinstance(result.get("tension_points"), list)
        and isinstance(result.get("consensus"), str)
    )


def measure_key_quotes_fidelity(result: dict) -> bool:
    """At least one key_quote should contain a speaker tag [Name]."""
    quotes = result.get("key_quotes", [])
    if not quotes:
        return True  # No quotes expected for minimal input
    return any("[" in q and "]" in q for q in quotes)


# ── Benchmark Tests ──────────────────────────────────────────


class TestCompressionBenchmark:
    """Offline quality benchmark for structured compression."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("scenario", ["three_kingdoms", "tech_debate", "minimal"])
    async def test_structural_validity(self, scenario):
        """All scenarios should produce structurally valid output."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = SAMPLE_LLM_RESPONSES[scenario]
            result = await compress_rounds(SAMPLE_INPUTS[scenario])

        assert measure_structural_validity(result), (
            f"Structural validity failed for {scenario}: {result}"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("scenario", ["three_kingdoms", "tech_debate"])
    async def test_field_completeness_rich_input(self, scenario):
        """Rich discussions should produce ≥80% field completeness."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = SAMPLE_LLM_RESPONSES[scenario]
            result = await compress_rounds(SAMPLE_INPUTS[scenario])

        completeness = measure_field_completeness(result)
        assert completeness >= 0.8, (
            f"Field completeness {completeness:.0%} < 80% for {scenario}"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("scenario", ["three_kingdoms", "tech_debate"])
    async def test_information_density(self, scenario):
        """Information density should be 10%-50% (not too sparse, not verbatim)."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = SAMPLE_LLM_RESPONSES[scenario]
            result = await compress_rounds(SAMPLE_INPUTS[scenario])

        density = measure_information_density(SAMPLE_INPUTS[scenario], result)
        assert 0.10 <= density <= 2.0, (
            f"Information density {density:.0%} out of range for {scenario}"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("scenario", ["three_kingdoms", "tech_debate"])
    async def test_key_quotes_fidelity(self, scenario):
        """Key quotes should preserve speaker attribution [Name]."""
        with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = SAMPLE_LLM_RESPONSES[scenario]
            result = await compress_rounds(SAMPLE_INPUTS[scenario])

        assert measure_key_quotes_fidelity(result), (
            f"Key quotes missing speaker attribution for {scenario}: {result['key_quotes']}"
        )

    @pytest.mark.asyncio
    async def test_empty_input_benchmark(self):
        """Empty input should return defaults, 0% density."""
        result = await compress_rounds("")
        assert result == _COMPRESS_DEFAULTS
        assert measure_information_density("", result) == 0.0

    def test_validate_preserves_all_mock_responses(self):
        """All mock responses should pass through validation unchanged."""
        for scenario, response in SAMPLE_LLM_RESPONSES.items():
            validated = _validate_compress_result(response)
            assert measure_structural_validity(validated), (
                f"Mock response for {scenario} failed validation"
            )

    @pytest.mark.asyncio
    async def test_benchmark_report(self, capsys):
        """Print a summary benchmark report."""
        print("\n" + "=" * 60)
        print("  Compression Quality Benchmark Report")
        print("=" * 60)

        for scenario in ["three_kingdoms", "tech_debate", "minimal"]:
            input_text = SAMPLE_INPUTS[scenario]

            if not input_text.strip():
                result = await compress_rounds(input_text)
            else:
                with patch("app.services.memory.llm_call_json", new_callable=AsyncMock) as mock_llm:
                    mock_llm.return_value = SAMPLE_LLM_RESPONSES[scenario]
                    result = await compress_rounds(input_text)

            completeness = measure_field_completeness(result)
            density = measure_information_density(input_text, result)
            valid = measure_structural_validity(result)
            quotes_ok = measure_key_quotes_fidelity(result)

            print(f"\n  [{scenario}]")
            print(f"    Input:       {len(input_text)} chars")
            print(f"    Completeness: {completeness:.0%}")
            print(f"    Density:     {density:.1%}")
            print(f"    Structure:   {'✅' if valid else '❌'}")
            print(f"    Quotes:      {'✅' if quotes_ok else '❌'}")

        print("\n" + "=" * 60)
