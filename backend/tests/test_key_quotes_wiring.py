"""Regression coverage for rolling key_quotes wiring."""

from app.services.blackboard import Blackboard
from app.services.memory import format_briefing_for_context


def test_key_quotes_flow_from_compression_to_blackboard_to_prompt_rendering():
    board = Blackboard()
    board.post("Agent-A", "old short position", "alert")
    board.set_agent_group("Agent-A", "core")

    key_quotes = [
        "[Agent-A]: This exact line changes the incentives for every faction.",
        "[Agent-B]: The old bargain no longer protects us.",
    ]
    board.update_global_summary({
        "situation": "The coalition is splitting.",
        "active_debates": ["Whether to keep the bargain"],
        "key_quotes": key_quotes,
        "tension_points": ["Security bloc vs welfare bloc"],
        "consensus": "",
    })

    shared = board.get_shared_briefing()
    group = board.get_group_briefing("core")
    leaders = board.get_leaders_only_briefing()

    assert board.key_quotes == key_quotes
    assert shared["key_quotes"] == key_quotes
    assert group["key_quotes"] == key_quotes
    assert leaders["key_quotes"] == key_quotes

    rendered = format_briefing_for_context(shared, language="English")

    assert "[Key Quotes]" in rendered
    assert "[Agent-A]: This exact line changes the incentives for every faction." in rendered
    assert "[Agent-B]: The old bargain no longer protects us." in rendered


def test_key_quotes_rendering_is_top_n_bounded_and_upgrades_position_line():
    quotes = [
        "[Agent-A]: Exact quote should replace the stale position summary.",
        "[Agent-B]: Second exact quote.",
        "[Agent-C]: Third exact quote.",
        "[Agent-D]: Fourth exact quote should be omitted by the top-N cap.",
    ]
    rendered = format_briefing_for_context(
        {
            "positions": {"Agent-A": "stale 60-char-ish position summary (worried)"},
            "key_quotes": quotes,
        },
        language="English",
    )

    assert (
        "  Agent-A: [Agent-A]: Exact quote should replace the stale position summary."
        in rendered
    )
    assert "stale 60-char-ish position summary" not in rendered
    assert "[Agent-C]: Third exact quote." in rendered
    assert "[Agent-D]: Fourth exact quote should be omitted" not in rendered
