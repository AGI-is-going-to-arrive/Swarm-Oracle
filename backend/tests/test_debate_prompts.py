from app.models import DebatePhase, DebateSide
from app.services.debate_prompts import build_turn_generation_prompt


def test_build_turn_generation_prompt_zh_includes_pacing_constraints():
    prompt = build_turn_generation_prompt(
        language="zh",
        phase=DebatePhase.CROSSFIRE,
        side=DebateSide.PROPOSITION,
        speaker_name="正方席",
        speaker_role="治理推进派",
        motion="动议",
        question="如果每一笔紧急预算都要外部审计，会更稳吗？",
        profile_id="governance",
        anchor_copy="锚点文案",
        recent_turns=[{"phase": "opening", "speaker_name": "反方席", "content": "这会拖慢执行。"}],
        verdict_tone="balance",
        winner="proposition",
    )

    assert "至少有一句短句" in prompt
    assert "避免每句都很长" in prompt


def test_build_turn_generation_prompt_en_includes_pacing_constraints():
    prompt = build_turn_generation_prompt(
        language="en",
        phase=DebatePhase.REBUTTAL,
        side=DebateSide.OPPOSITION,
        speaker_name="Opposition",
        speaker_role="Governance Skeptic",
        motion="Motion",
        question="Should every emergency budget be reviewed by a permanent external audit chamber?",
        profile_id="governance",
        anchor_copy="anchor copy",
        recent_turns=[{"phase": "crossfire", "speaker_name": "Proposition", "content": "You still have no control chain."}],  # noqa: E501
        verdict_tone="balance",
        winner="proposition",
    )

    assert "Include at least one short sentence" in prompt
    assert "Do not let every sentence run long" in prompt
