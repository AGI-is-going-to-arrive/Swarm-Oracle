from app.models import DebatePhase, DebateSide
from app.services.debate_prompts import (
    build_cast,
    build_turn_generation_prompt,
    get_participant_persona,
)


def test_build_turn_generation_prompt_zh_includes_pacing_constraints():
    system_msg, user_prompt = build_turn_generation_prompt(
        language="zh",
        phase=DebatePhase.CROSSFIRE,
        side=DebateSide.PROPOSITION,
        speaker_name="正方席",
        speaker_role="治理推进派",
        motion="动议",
        question="如果每一笔紧急预算都要外部审计，会更稳吗？",
        profile_id="governance",
        recent_turns=[{"phase": "opening", "speaker_name": "反方席", "content": "这会拖慢执行。"}],
        verdict_tone="balance",
        winner="proposition",
        persona="资深政策架构师",
    )

    assert "说人话" in user_prompt
    assert "长短句混着来" in user_prompt
    # System message carries identity/persona
    assert "正方席" in system_msg
    # Anti-template instruction in system message
    assert "饭桌" in system_msg or "套话" in system_msg
    # Anchor copy must NOT be present
    assert "语义锚点" not in user_prompt


def test_build_turn_generation_prompt_en_includes_pacing_constraints():
    system_msg, user_prompt = build_turn_generation_prompt(
        language="en",
        phase=DebatePhase.REBUTTAL,
        side=DebateSide.OPPOSITION,
        speaker_name="Opposition",
        speaker_role="Governance Skeptic",
        motion="Motion",
        question="Should every emergency budget be reviewed by a permanent external audit chamber?",
        profile_id="governance",
        recent_turns=[{"phase": "crossfire", "speaker_name": "Proposition", "content": "You still have no control chain."}],  # noqa: E501
        verdict_tone="balance",
        winner="proposition",
        persona="Former inspector general who lived through institutional collapse",
    )

    assert "real person arguing" in user_prompt
    assert "Mix short and long" in user_prompt
    assert "Opposition" in system_msg
    # Anti-jargon instruction present
    assert "NEVER use jargon" in user_prompt or "dinner table" in system_msg
    assert "Semantic anchor" not in user_prompt


def test_build_turn_generation_prompt_pro_and_con_have_asymmetric_instructions():
    pro_system, pro_user = build_turn_generation_prompt(
        language="en",
        phase=DebatePhase.OPENING,
        side=DebateSide.PROPOSITION,
        speaker_name="Proposition",
        speaker_role="Senior policy architect",
        motion="Motion",
        question="Should the council adopt this reform?",
        profile_id="governance",
        recent_turns=[],
        persona="Senior policy architect",
    )
    con_system, con_user = build_turn_generation_prompt(
        language="en",
        phase=DebatePhase.OPENING,
        side=DebateSide.OPPOSITION,
        speaker_name="Opposition",
        speaker_role="Former inspector general",
        motion="Motion",
        question="Should the council adopt this reform?",
        profile_id="governance",
        recent_turns=[],
        persona="Former inspector general",
    )

    # Pro side should be about advocating
    assert "Proposition directives" in pro_user
    assert "advocate" in pro_user.lower()
    # Con side should be about taking apart
    assert "Opposition directives" in con_user
    assert "take this apart" in con_user.lower() or "take apart" in con_user.lower()
    # Must differ
    assert pro_user != con_user


def test_build_cast_returns_persona_for_each_participant():
    cast = build_cast(
        "zh", "governance",
        question="如果每一笔紧急预算都要外部审计，会更稳吗？",
    )
    assert set(cast.keys()) == {"proposition", "opposition", "judge"}
    for side_key in ("proposition", "opposition", "judge"):
        entry = cast[side_key]
        assert {"name", "role", "persona"} <= set(entry.keys())
        assert len(entry["persona"]) > 30

    cast_en = build_cast("en", "trade", question="Should ports publish their tariff ledger?")
    pro_text = (
        cast_en["proposition"]["role"] + " " + cast_en["proposition"]["persona"]
    ).lower()
    assert any(kw in pro_text for kw in ("supply-chain", "tariff", "strategist", "port"))
    assert cast_en["proposition"]["persona"] != cast_en["opposition"]["persona"]
    assert cast_en["judge"]["persona"] != cast_en["proposition"]["persona"]


def test_get_participant_persona_is_deterministic():
    persona_a = get_participant_persona(
        language="en",
        profile_id="war",
        side=DebateSide.PROPOSITION,
        question="Should the front advance?",
    )
    persona_b = get_participant_persona(
        language="en",
        profile_id="war",
        side=DebateSide.PROPOSITION,
        question="Different question text entirely.",
    )
    assert persona_a == persona_b
    persona_con = get_participant_persona(
        language="en",
        profile_id="war",
        side=DebateSide.OPPOSITION,
        question="Should the front advance?",
    )
    assert persona_con != persona_a


def test_build_cast_falls_back_to_generic_for_unknown_profile():
    cast = build_cast("zh", "unknown_profile_xyz")
    assert cast["proposition"]["persona"]
    assert cast["opposition"]["persona"]
    assert cast["judge"]["persona"]
