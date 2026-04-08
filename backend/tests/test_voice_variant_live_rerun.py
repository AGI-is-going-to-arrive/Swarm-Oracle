"""Live LLM observation rerun: real text generation with variant vocabulary hints.

Calls the real LLM to generate rewritten text for the SAME anchor copy
across 5 different agent variants. The only variable is the vocabulary hint
injected by the voice variant system.

Run: pytest tests/test_voice_variant_live_rerun.py -v -s
Requires: LLM at http://127.0.0.1:8318/v1 (or 8317 fallback)
"""

import httpx
import json
import pytest

from app.models.ending_room import (
    EndingRoom,
    EndingRoomParticipant,
    EndingRoomPhase,
    EndingRoomType,
)
from app.services.ending_room_service._content import (
    _build_oracle_rewrite_prompt,
    _oracle_role_voice_variant,
)
from app.services.ending_room_service import EndingRoomRoleSlot

LLM_URLS = ["http://127.0.0.1:8318/v1", "http://127.0.0.1:8317/v1"]
LLM_API_KEY = "sk-12345678"
LLM_MODEL = "gpt-5.4-mini"

# ── Same anchor copy for all agents (zh) ─────────────────────────────
ANCHOR_COPY_ZH = (
    "这条世界线的转折不在结尾，而在更早的地方——"
    "当关键资源的供给被切断后，所有人被迫在极短时间内做出选择，"
    "每一个决定都把代价推向了不同的方向。"
)

ANCHOR_COPY_EN = (
    "The real turning point of this worldline was not at the ending "
    "but much earlier — when the critical supply was severed, everyone "
    "was forced to choose under extreme pressure, and each decision "
    "pushed the cost in a different direction."
)

# ── Test agents: one per variant category ────────────────────────────
TEST_AGENTS = [
    {
        "label": "FINANCE (Treasury Secretary)",
        "role": "Treasury Secretary",
        "bio": "Federal Reserve liaison, bond market specialist",
        "variant_expected": "finance",
    },
    {
        "label": "FIELD (Retired General)",
        "role": "Retired General",
        "bio": "Former commander of the Northern Army, 30 years service",
        "variant_expected": "field",
    },
    {
        "label": "DIPLOMAT (Ambassador)",
        "role": "Ambassador",
        "bio": "Foreign affairs envoy, multilateral negotiations",
        "variant_expected": "diplomat",
    },
    {
        "label": "SCIENCE (Lead Researcher)",
        "role": "Lead Researcher",
        "bio": "Epidemiology laboratory, pandemic modeling",
        "variant_expected": "science",
    },
    {
        "label": "PLAIN (Civilian) — control",
        "role": "Civilian",
        "bio": "Caught in the crossfire, no formal role",
        "variant_expected": "plain",
    },
]


def _make_room(language: str) -> EndingRoom:
    return EndingRoom(
        scenario_id="obs-scenario-1",
        room_type=EndingRoomType.WORLDLINE_ROUNDTABLE,
        participant_set_hash="obs-hash",
        scope_fingerprint="obs-scope",
        title="Supply Chain Collapse",
        language=language,
    )


def _make_participant(agent: dict) -> EndingRoomParticipant:
    return EndingRoomParticipant(
        room_id="obs-room-1",
        role_slot=EndingRoomRoleSlot.REPRESENTATIVE,
        display_name=agent["role"],
        source_branch_id="obs-branch",
        source_agent_id="obs-agent",
        persona_snapshot_json={
            "branch_title": "Supply Chain Collapse",
            "agent_role": agent["role"],
            "agent_persona": agent["bio"],
            "bio_short": agent["bio"],
            "impact_score": 7,
            "tier": "core",
        },
    )


async def _call_llm(prompt: str) -> str:
    """Call real LLM via streaming (proxy returns content=null in non-stream)."""
    for base_url in LLM_URLS:
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream(
                    "POST",
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {LLM_API_KEY}"},
                    json={
                        "model": LLM_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.55,
                        "max_tokens": 400,
                        "stream": True,
                        "reasoning_effort": "low",
                    },
                ) as resp:
                    resp.raise_for_status()
                    parts: list[str] = []
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: ") or line == "data: [DONE]":
                            continue
                        chunk = json.loads(line[6:])
                        delta = chunk["choices"][0].get("delta", {})
                        c = delta.get("content")
                        if c:
                            parts.append(c)
                    content = "".join(parts).strip()
                    if content:
                        return content
        except Exception:
            continue
    return "[LLM UNAVAILABLE]"


@pytest.mark.asyncio
async def test_live_voice_variant_observation():
    """Generate real LLM text for 5 variants, print for blind comparison."""
    room_zh = _make_room("zh")

    print("\n" + "=" * 72)
    print("LIVE LLM OBSERVATION RERUN: Voice Variant Text Differentiation")
    print("Same anchor copy → 5 different agents → real LLM rewrite")
    print("=" * 72)

    results: list[dict] = []

    for agent in TEST_AGENTS:
        variant = _oracle_role_voice_variant(agent["role"], agent["bio"])
        assert variant == agent["variant_expected"], (
            f"{agent['label']}: expected {agent['variant_expected']}, got {variant}"
        )

        participant = _make_participant(agent)
        prompt = _build_oracle_rewrite_prompt(
            room=room_zh,
            participant=participant,
            phase=EndingRoomPhase.OPENING,
            anchor_copy=ANCHOR_COPY_ZH,
            output_json=False,
        )

        generated = await _call_llm(prompt)

        # Try to parse JSON if returned
        if generated.startswith("{"):
            try:
                parsed = json.loads(generated)
                generated = parsed.get("content", generated)
            except json.JSONDecodeError:
                pass

        results.append({
            "label": agent["label"],
            "variant": variant,
            "generated": generated,
        })

    # ── Print results ─────────────────────────────────────────────
    for r in results:
        print(f"\n{'─' * 72}")
        print(f"[{r['label']}]  variant={r['variant']}")
        print(f"{'─' * 72}")
        print(r["generated"])

    # ── Differentiation analysis ──────────────────────────────────
    print(f"\n{'=' * 72}")
    print("DIFFERENTIATION ANALYSIS")
    print("=" * 72)

    # Check vocabulary presence in generated text
    VARIANT_MARKERS = {
        "finance": ["头寸", "敞口", "清算", "信用", "流动", "对手方",
                     "exposure", "position", "clearing", "spread", "counterparty"],
        "field": ["防线", "粮道", "侧翼", "伤亡", "战损",
                  "line", "flank", "attrition", "supply", "casualties"],
        "diplomat": ["照会", "斡旋", "条款", "退让", "底线",
                     "mediation", "terms", "leverage", "concession", "stakeholder"],
        "science": ["样本", "置信", "变量", "偏差", "模型",
                    "sample", "confidence", "variable", "bias", "model"],
        "plain": [],  # control — no expected domain vocab
    }

    for r in results:
        variant = r["variant"]
        text = r["generated"]
        markers = VARIANT_MARKERS.get(variant, [])
        hits = [m for m in markers if m in text]
        miss_count = len(markers) - len(hits) if markers else 0
        print(f"\n  [{r['label']}]")
        print(f"    Variant markers found: {hits if hits else '(none — control or generic)'}")
        print(f"    Length: {len(text)} chars")
        if variant != "plain":
            print(f"    Domain vocab hit rate: {len(hits)}/{len(markers)}")

    # Soft assertion: non-plain agents should have at least SOME domain markers
    non_plain = [r for r in results if r["variant"] != "plain"]
    total_hits = sum(
        len([m for m in VARIANT_MARKERS.get(r["variant"], []) if m in r["generated"]])
        for r in non_plain
    )
    print(f"\n  Total domain vocab hits across 4 non-plain agents: {total_hits}")
    print(f"  (0 = no differentiation, higher = better)")

    # Don't hard-fail — this is observation, not regression
    if total_hits == 0:
        print("\n  ⚠ WARNING: Zero domain vocabulary detected in any agent output.")
        print("  This may indicate vocabulary hints are not being picked up by the LLM.")
    elif total_hits >= 4:
        print("\n  ✓ Domain vocabulary is being injected into LLM output.")
    else:
        print(f"\n  ~ Partial differentiation ({total_hits} markers found).")
