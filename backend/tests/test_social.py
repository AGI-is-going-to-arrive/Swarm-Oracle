from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.social as social_api
from app.config import settings
from app.main import app
from app.models import (
    Agent,
    AgentMessage,
    Branch,
    BranchStatus,
    FactionEvent,
    FactionSnapshot,
    Round,
    Scenario,
    ScenarioStatus,
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.models.database import get_engine
from app.services.llm_client import LLMError


def _make_signed_session_token(secret: str, subject: str) -> str:
    payload = json.dumps({"sub": subject}, separators=(",", ":")).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    signing_input = f"v1.{payload_segment}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"v1.{payload_segment}.{signature_segment}"


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _seed_social_scenario(
    *,
    parsed_context: dict | None = None,
    user_id: str | None = None,
) -> str:
    with Session(get_engine()) as session:
        scenario = Scenario(
            question="What if Zheng He reached the Americas first?",
            status=ScenarioStatus.DONE,
            parsed_context=parsed_context or {"_language": "English"},
            user_id=user_id,
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id
        session.add(
            Agent(
                scenario_id=scenario_id,
                name="Harbor Envoy",
                role="Envoy",
                stance="coalition",
            )
        )
        session.add(
            Branch(
                scenario_id=scenario_id,
                title="Harbor coalition holds",
                probability=0.72,
                status=BranchStatus.COMPLETED,
                story="Trade cities coordinate supply and keep the route open.",
                insight="Ports, not courts, decide the outcome.",
            )
        )
        session.commit()
        return scenario_id


def _seed_model_profile(
    *,
    user_id: str,
    model: str = "profile-social-model",
    api_key: str = "sk-social-profile",
    base_url: str = "https://api.openai.com/v1",
    rpm: int | None = 13,
    tpm: int | None = 1300,
    concurrency: int | None = 3,
    supports_structured_outputs: bool | None = True,
    supports_native_search: bool | None = False,
    native_search_upstream: str | None = None,
) -> str:
    from app.models.model_profile import ModelProfile

    with Session(get_engine()) as session:
        profile = ModelProfile(
            user_id=user_id,
            name=f"{user_id} profile",
            provider="openai",
            base_url=base_url,
            model=model,
            api_key=api_key,
            rpm=rpm,
            tpm=tpm,
            concurrency=concurrency,
            supports_structured_outputs=supports_structured_outputs,
            supports_native_search=supports_native_search,
            native_search_upstream=native_search_upstream,
        )
        session.add(profile)
        session.commit()
        session.refresh(profile)
        return profile.id


def _request_social_copy(
    client: TestClient,
    method: str,
    scenario_id: str,
    *,
    body: dict | None = None,
    headers: dict | None = None,
):
    url = f"/api/scenario/{scenario_id}/social/x"
    if method == "GET":
        return client.get(url, headers=headers)
    return client.post(url, json=body or {}, headers=headers)


def test_social_projection_maps_legacy_betrayal_code_to_truthful_affect_proxy_copy():
    scenario = Scenario(
        id="social-affect-proxy",
        question="How will the coalition react?",
        status=ScenarioStatus.DONE,
    )
    branch = Branch(
        id="social-affect-branch",
        scenario_id=scenario.id,
        title="Coalition holds",
    )
    snapshot = FactionSnapshot(
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_number=2,
        faction_key="harbor",
        label="Harbor coalition",
        confidence=0.5,
    )
    event = FactionEvent(
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_number=2,
        event_type="betrayal",
        actor_agent_id="agent-1",
        faction_key="harbor",
    )
    projected = social_api._build_display_safe_social_events(
        scenario,
        [branch],
        [snapshot],
        [event],
    )

    assert projected[0]["event_type"] == "affect shift (proxy)"
    assert projected[0]["actor_label"] == "Unknown participant"
    assert "affect shift (proxy)" in projected[0]["summary"]
    assert "betrayal" not in projected[0]["summary"].lower()
    assert "agent-1" not in projected[0]["summary"]


def test_native_action_projection_uses_canonical_actor_and_safe_fallback():
    scenario = Scenario(
        id="native-action-canonical-subject",
        question="Who publishes the update?",
        status=ScenarioStatus.DONE,
        parsed_context={"_language": "English"},
    )
    branch = Branch(
        id="native-action-canonical-branch",
        scenario_id=scenario.id,
        title="Main",
    )
    actor = Agent(
        id="native-action-may",
        scenario_id=scenario.id,
        name="May",
    )
    actions = [
        SimulationAction(
            id="native-action-known-actor",
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id="native-action-round",
            round_number=1,
            sequence=1,
            agent_id=actor.id,
            action_type=SimulationActionType.POST,
            status=SimulationActionStatus.VERIFIED,
            content="The mayor publishes the correction.",
            payload_json="{}",
            idempotency_key="native-action:known",
        ),
        SimulationAction(
            id="native-action-missing-actor",
            scenario_id=scenario.id,
            branch_id=branch.id,
            round_id="native-action-round",
            round_number=1,
            sequence=2,
            agent_id="internal-actor-id-must-not-leak",
            action_type=SimulationActionType.POST,
            status=SimulationActionStatus.VERIFIED,
            content="A second correction is published.",
            payload_json="{}",
            idempotency_key="native-action:missing",
        ),
    ]

    projected = social_api._build_display_safe_action_events(
        scenario,
        [branch],
        [actor],
        actions,
    )

    assert {event["actor_label"] for event in projected} == {
        "May",
        "Unknown participant",
    }
    assert {event["faction_label"] for event in projected} == {
        "May",
        "Unknown participant",
    }
    assert {event["summary"] for event in projected} == {
        "May posted: The mayor publishes the correction.",
        "Unknown participant posted: A second correction is published.",
    }
    headlines = social_api._deterministic_headline_cards(projected)
    assert {card["headline"] for card in headlines} == {
        "May: post",
        "Unknown participant: post",
    }
    may_event = next(
        event for event in projected if event["actor_label"] == "May"
    )
    normalized = social_api._normalize_headline_cards(
        {
            "headline_cards": [
                {
                    "headline": "Mayor criticizes May",
                    "summary": "Officials say May may object",
                    "source_event_id": may_event["event_id"],
                }
            ]
        },
        projected,
    )
    assert normalized[0]["headline"] == "May: Mayor criticizes May"
    assert normalized[0]["summary"] == "May: Officials say May may object"
    assert "internal-actor-id-must-not-leak" not in json.dumps(projected)


def test_social_feed_distinguishes_affect_proxy_events_by_safe_actor(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario(parsed_context={"_language": "Chinese"})

    with Session(get_engine()) as session:
        branch = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).one()
        first_actor = session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).one()
        second_actor = Agent(
            scenario_id=scenario_id,
            name="公交监督员",
            role="Auditor",
            stance="oversight",
        )
        session.add(second_actor)
        session.flush()
        session.add(
            FactionSnapshot(
                scenario_id=scenario_id,
                branch_id=branch.id,
                round_number=3,
                faction_key="transit",
                label="公交联盟",
                confidence=0.6,
            )
        )
        shared_payload = json.dumps(
            {"center": 0.7, "delta": -0.08000000000000002, "new_center": 0.78}
        )
        session.add_all(
            [
                FactionEvent(
                    id="affect-event-first-actor",
                    scenario_id=scenario_id,
                    branch_id=branch.id,
                    round_number=3,
                    event_type="betrayal",
                    actor_agent_id=first_actor.id,
                    faction_key="transit",
                    payload_json=shared_payload,
                ),
                FactionEvent(
                    id="affect-event-second-actor",
                    scenario_id=scenario_id,
                    branch_id=branch.id,
                    round_number=3,
                    event_type="betrayal",
                    actor_agent_id=second_actor.id,
                    faction_key="transit",
                    payload_json=shared_payload,
                ),
            ]
        )
        session.commit()

    async def deterministic_headlines(scenario, events):
        return "deterministic", social_api._deterministic_headline_cards(
            events,
            language=social_api._resolve_social_language(scenario),
        )

    monkeypatch.setattr(
        social_api,
        "_generate_headline_cards",
        deterministic_headlines,
    )

    response = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert response.status_code == 200
    data = response.json()
    assert len(data["events"]) == 2
    assert {event["faction_label"] for event in data["events"]} == {"公交联盟"}
    assert {event["actor_label"] for event in data["events"]} == {
        "Harbor Envoy",
        "公交监督员",
    }
    assert len({event["summary"] for event in data["events"]}) == 2
    assert {card["headline"] for card in data["headline_cards"]} == {
        "Harbor Envoy（公交联盟）：情绪代理变化",
        "公交监督员（公交联盟）：情绪代理变化",
    }
    rendered = json.dumps(data, ensure_ascii=False)
    assert "0.7" not in rendered
    assert "-0.08000000000000002" not in rendered
    assert "0.78" not in rendered


def test_social_feed_projects_verified_native_actions_without_faction_events(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario()

    with Session(get_engine()) as session:
        branch = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).one()
        actor = session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).one()
        target = Agent(scenario_id=scenario_id, name="Harbor Archivist")
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add_all([target, round_row])
        session.flush()

        post_message = AgentMessage(
            round_id=round_row.id,
            agent_id=actor.id,
            content="The harbor council published its correction.",
        )
        follow_message = AgentMessage(
            round_id=round_row.id,
            agent_id=actor.id,
            content="The envoy follows the archivist.",
        )
        hidden_message = AgentMessage(
            round_id=round_row.id,
            agent_id=actor.id,
            content="This unavailable action must stay hidden.",
        )
        session.add_all([post_message, follow_message, hidden_message])
        session.flush()
        session.add_all(
            [
                SimulationAction(
                    id="feed-action-post",
                    scenario_id=scenario_id,
                    branch_id=branch.id,
                    round_id=round_row.id,
                    round_number=1,
                    sequence=1,
                    agent_id=actor.id,
                    message_id=post_message.id,
                    action_type=SimulationActionType.POST,
                    status=SimulationActionStatus.VERIFIED,
                    content="The harbor council published api_key=sk-action-secret correction.",
                    payload_json="{}",
                    idempotency_key="feed:post",
                ),
                SimulationAction(
                    id="feed-action-follow",
                    scenario_id=scenario_id,
                    branch_id=branch.id,
                    round_id=round_row.id,
                    round_number=1,
                    sequence=2,
                    agent_id=actor.id,
                    message_id=follow_message.id,
                    action_type=SimulationActionType.FOLLOW,
                    status=SimulationActionStatus.VERIFIED,
                    target_type="agent",
                    target_id=target.id,
                    payload_json="{}",
                    idempotency_key="feed:follow",
                ),
                SimulationAction(
                    id="feed-action-unavailable",
                    scenario_id=scenario_id,
                    branch_id=branch.id,
                    round_id=round_row.id,
                    round_number=1,
                    sequence=3,
                    agent_id=actor.id,
                    message_id=hidden_message.id,
                    action_type=SimulationActionType.POST,
                    status=SimulationActionStatus.UNAVAILABLE,
                    failure_code="ACTION_UNAVAILABLE",
                    content="This unavailable action must stay hidden.",
                    payload_json="{}",
                    idempotency_key="feed:unavailable",
                ),
            ]
        )
        session.commit()
        branch_id = branch.id
        actor_id = actor.id
        round_id = round_row.id

    llm_calls = 0

    async def fake_llm(*_args, **_kwargs):
        nonlocal llm_calls
        llm_calls += 1
        if llm_calls == 1:
            with Session(get_engine()) as session:
                scenario = session.get(Scenario, scenario_id)
                scenario.parsed_context = {
                    **(scenario.parsed_context or {}),
                    "concurrent_marker": "preserved",
                }
                session.add(scenario)
                session.commit()
        return json.dumps(
            {
                "headline_cards": [
                        {
                            "headline": "Harbor update",
                            "summary": "Visible social activity https://private.example",
                    }
                ]
            }
        )

    monkeypatch.setattr(social_api, "llm_call", fake_llm)

    first = client.get(f"/api/scenario/{scenario_id}/social-feed")
    second = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert first.status_code == 200
    assert second.status_code == 200
    first_data = first.json()
    second_data = second.json()
    assert llm_calls == 1
    assert first_data["events"] == second_data["events"]
    assert [event["event_type"] for event in first_data["events"]] == ["post", "follow"]
    assert len({event["event_id"] for event in first_data["events"]}) == 2
    payload = json.dumps(first_data, ensure_ascii=False)
    assert "Harbor Envoy" in payload
    assert "Harbor Archivist" in payload
    assert "This unavailable action must stay hidden" not in payload
    assert "sk-action-secret" not in payload
    assert "feed-action-" not in payload
    assert "Harbor Envoy posted:" in payload
    assert "Harbor Envoy followed Harbor Archivist" in payload

    with Session(get_engine()) as session:
        new_message = AgentMessage(
            round_id=round_id,
            agent_id=actor_id,
            content="A new verified post invalidates the cached headlines.",
        )
        session.add(new_message)
        session.flush()
        session.add(
            SimulationAction(
                id="feed-action-new-post",
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_id,
                round_number=1,
                sequence=4,
                agent_id=actor_id,
                message_id=new_message.id,
                action_type=SimulationActionType.POST,
                status=SimulationActionStatus.VERIFIED,
                content="A new verified post invalidates the cached headlines.",
                payload_json="{}",
                idempotency_key="feed:new-post",
            )
        )
        session.commit()

    third = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert third.status_code == 200
    assert llm_calls == 2
    assert [event["event_type"] for event in third.json()["events"]] == [
        "post",
        "follow",
        "post",
    ]
    with Session(get_engine()) as session:
        context = session.get(Scenario, scenario_id).parsed_context
    assert context["concurrent_marker"] == "preserved"
    cache_json = json.dumps(context["_social_headline_cache_v1"], ensure_ascii=False)
    assert len(cache_json.encode()) <= 8_192
    for forbidden in (
        "sk-action-secret",
        "https://",
        "llm_api_key",
        "base_url",
        "user_id",
    ):
        assert forbidden not in cache_json


def test_social_feed_returns_a_bounded_latest_window(client: TestClient, monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario()

    with Session(get_engine()) as session:
        branch = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).one()
        actor = session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).one()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        session.add_all(
            [
                SimulationAction(
                    id=f"bounded-feed-action-{sequence:03d}",
                    scenario_id=scenario_id,
                    branch_id=branch.id,
                    round_id=round_row.id,
                    round_number=sequence,
                    sequence=sequence,
                    agent_id=actor.id,
                    action_type=SimulationActionType.POST,
                    status=SimulationActionStatus.VERIFIED,
                    content=f"Bounded feed update {sequence}",
                    payload_json="{}",
                    idempotency_key=f"bounded-feed:{sequence}",
                )
                for sequence in range(1, 271)
            ]
        )
        session.commit()

    async def deterministic_headlines(*_args, **_kwargs):
        return "deterministic", []

    monkeypatch.setattr(
        social_api,
        "_generate_headline_cards",
        deterministic_headlines,
    )

    response = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert response.status_code == 200
    data = response.json()
    assert data["total_event_count"] == 270
    assert data["events_truncated"] is True
    assert len(data["events"]) == 256
    assert [event["round_number"] for event in data["events"]] == list(range(15, 271))
    summaries = {event["summary"] for event in data["events"]}
    assert "Harbor Envoy posted: Bounded feed update 1" not in summaries
    assert "Harbor Envoy posted: Bounded feed update 270" in summaries


def test_social_feed_latest_window_uses_creation_time_across_replay_rounds(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(social_api, "_SOCIAL_FEED_MAX_EVENTS", 3)
    scenario_id = _seed_social_scenario()
    base_time = datetime(2026, 1, 1, tzinfo=timezone.utc)

    with Session(get_engine()) as session:
        main_branch = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).one()
        replay_branch = Branch(
            scenario_id=scenario_id,
            title="Later replay",
            status=BranchStatus.COMPLETED,
            replay_kind="counterfactual",
            replay_source_branch_id=main_branch.id,
        )
        actor = session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).one()
        main_round = Round(branch_id=main_branch.id, round_number=10)
        replay_round = Round(branch_id=replay_branch.id, round_number=1)
        session.add_all([replay_branch, main_round, replay_round])
        session.flush()
        rows = [
            (main_branch.id, main_round.id, 8, "Older main 8", base_time),
            (main_branch.id, main_round.id, 9, "Older main 9", base_time + timedelta(seconds=1)),
            (main_branch.id, main_round.id, 10, "Older main 10", base_time + timedelta(seconds=2)),
            (
                replay_branch.id,
                replay_round.id,
                1,
                "Newest replay round 1",
                base_time + timedelta(seconds=3),
            ),
        ]
        session.add_all(
            [
                SimulationAction(
                    id=f"latest-window-action-{sequence}",
                    scenario_id=scenario_id,
                    branch_id=branch_id,
                    round_id=round_id,
                    round_number=round_number,
                    sequence=sequence,
                    agent_id=actor.id,
                    action_type=SimulationActionType.POST,
                    status=SimulationActionStatus.VERIFIED,
                    content=content,
                    payload_json="{}",
                    idempotency_key=f"latest-window:{sequence}",
                    created_at=created_at,
                )
                for sequence, (
                    branch_id,
                    round_id,
                    round_number,
                    content,
                    created_at,
                ) in enumerate(rows, start=1)
            ]
        )
        session.commit()

    async def deterministic_headlines(*_args, **_kwargs):
        return "deterministic", []

    monkeypatch.setattr(
        social_api,
        "_generate_headline_cards",
        deterministic_headlines,
    )

    response = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert response.status_code == 200
    data = response.json()
    assert data["events_truncated"] is True
    assert data["total_event_count"] == 4
    assert [event["round_number"] for event in data["events"]] == [9, 10, 1]
    summaries = [event["summary"] for event in data["events"]]
    assert all("Older main 8" not in summary for summary in summaries)
    assert any("Newest replay round 1" in summary for summary in summaries)


def test_chinese_faction_events_and_deterministic_headlines_do_not_leak_english_codes():
    scenario = Scenario(
        id="social-chinese-faction",
        question="阵营如何变化？",
        status=ScenarioStatus.DONE,
        parsed_context={"_language": "Chinese"},
    )
    branch = Branch(
        id="social-chinese-branch",
        scenario_id=scenario.id,
        title="主世界线",
    )
    snapshot = FactionSnapshot(
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_number=2,
        faction_key="harbor",
        label="港口联盟",
        confidence=0.6,
    )
    event = FactionEvent(
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_number=2,
        event_type="betrayal",
        actor_agent_id="agent-1",
        faction_key="harbor",
    )
    actor = Agent(
        id="agent-1",
        scenario_id=scenario.id,
        name="顾闻",
    )

    projected = social_api._build_display_safe_social_events(
        scenario,
        [branch],
        [snapshot],
        [event],
        agents=[actor],
    )
    headline_cards = social_api._deterministic_headline_cards(
        [
            {
                "event_id": "event-post",
                "round_number": 1,
                "event_type": "post",
                "branch_title": "主世界线",
                "faction_label": "顾闻",
                "summary": "顾闻发布了动态",
            },
            projected[0],
        ],
        language="Chinese",
    )

    assert "triggered" not in projected[0]["summary"]
    assert "affect shift" not in projected[0]["summary"]
    assert "情绪代理变化" in projected[0]["summary"]
    assert headline_cards[0]["headline"] == "顾闻（港口联盟）：情绪代理变化"
    assert headline_cards[1]["headline"] == "顾闻：发布动态"


def test_social_headline_generation_prioritizes_newest_events(monkeypatch):
    scenario = Scenario(
        id="scenario-latest-social-headlines",
        question="Which recent signal changes the outlook?",
        status=ScenarioStatus.DONE,
        parsed_context={
            "_language": "English",
            "llm_api_key": "sk-social-latest",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "headline-latest-model",
        },
    )
    events = [
        {
            "event_id": f"event-{index}",
            "round_number": index,
            "event_type": "post",
            "branch_title": "Main",
            "faction_label": f"Actor {index}",
            "summary": (
                ("OLDEST_ONLY_MARKER " if index == 1 else "")
                + ("NEWEST_ONLY_MARKER " if index == 40 else "")
                + (f"update {index} " * 35)
            ),
        }
        for index in range(1, 41)
    ]
    captured: dict[str, str] = {}

    async def empty_headlines(prompt: str, **_kwargs):
        captured["prompt"] = prompt
        return '{"headline_cards": []}'

    monkeypatch.setattr(social_api, "llm_call", empty_headlines)

    mode, cards = asyncio.run(social_api._generate_headline_cards(scenario, events))

    assert mode == "deterministic"
    assert [card["source_event_id"] for card in cards] == [
        "event-40",
        "event-39",
        "event-38",
        "event-37",
        "event-36",
    ]
    assert "NEWEST_ONLY_MARKER" in captured["prompt"]
    assert "OLDEST_ONLY_MARKER" not in captured["prompt"]


def test_llm_headlines_keep_canonical_actor_subjects_for_same_faction_events():
    events = [
        {
            "event_id": f"event-{actor}",
            "round_number": 2,
            "event_type": "affect shift (proxy)",
            "branch_title": "主线",
            "faction_label": "公交联盟",
            "actor_label": actor,
            "summary": f"{actor}（公交联盟）触发了情绪代理变化",
        }
        for actor in ("陈建国", "赵琳")
    ]
    raw = {
        "headline_cards": [
            {
                "headline": "联盟情绪出现变化",
                "summary": "同一阵营出现新的情绪信号",
                "source_event_id": event["event_id"],
            }
            for event in events
        ]
    }

    cards = social_api._normalize_headline_cards(raw, events, language="Chinese")

    assert [card["headline"] for card in cards] == [
        "陈建国（公交联盟）：联盟情绪出现变化",
        "赵琳（公交联盟）：联盟情绪出现变化",
    ]
    assert cards[0]["summary"].startswith("陈建国（公交联盟）：")
    assert cards[1]["summary"].startswith("赵琳（公交联盟）：")


def test_llm_headline_actor_match_is_boundary_aware_and_keeps_faction():
    events = [
        {
            "event_id": "event-may",
            "round_number": 3,
            "event_type": "affect shift (proxy)",
            "branch_title": "Main",
            "faction_label": "Transit coalition",
            "actor_label": "May",
            "summary": "May (Transit coalition) triggered an affect shift.",
        }
    ]
    raw = {
        "headline_cards": [
            {
                "headline": "Mayor changes course",
                "summary": "May publishes a response",
                "faction_label": "spoofed faction",
                "source_event_id": "event-may",
            }
        ]
    }

    cards = social_api._normalize_headline_cards(raw, events, language="English")

    assert cards[0]["headline"] == (
        "May (Transit coalition): Mayor changes course"
    )
    assert cards[0]["summary"] == (
        "May (Transit coalition): May publishes a response"
    )
    assert cards[0]["faction_label"] == "Transit coalition"


def test_chinese_action_subject_is_normalized_without_actor_duplication():
    events = [
        {
            "event_id": "event-gu-wen",
            "round_number": 2,
            "event_type": "post",
            "branch_title": "主线",
            "faction_label": "顾闻",
            "actor_label": "顾闻",
            "summary": "顾闻发布了动态",
        }
    ]
    raw = {
        "headline_cards": [
            {
                "headline": "顾闻发布更新",
                "summary": "顾闻说明进展",
                "source_event_id": "event-gu-wen",
            }
        ]
    }

    cards = social_api._normalize_headline_cards(raw, events, language="Chinese")

    assert cards[0]["headline"] == "顾闻：发布更新"
    assert cards[0]["summary"] == "顾闻：说明进展"


def test_long_canonical_subject_preserves_closed_faction_and_headline_body():
    actor = "A" * 72
    faction = "B" * 72
    full_subject = f"{actor} ({faction})"
    events = [
        {
            "event_id": "event-long-subject",
            "round_number": 4,
            "event_type": "affect shift (proxy)",
            "branch_title": "Main",
            "faction_label": faction,
            "actor_label": actor,
            "summary": f"{full_subject}: publishes audited evidence",
        }
    ]
    raw = {
        "headline_cards": [
            {
                "headline": f"{full_subject}: publishes audited evidence",
                "summary": f"{full_subject}: explains the verified change",
                "source_event_id": "event-long-subject",
            }
        ]
    }

    llm_cards = social_api._normalize_headline_cards(raw, events)
    deterministic_cards = social_api._deterministic_headline_cards(events)

    for headline in (
        llm_cards[0]["headline"],
        deterministic_cards[0]["headline"],
    ):
        assert len(headline) <= 96
        assert headline.startswith("A")
        assert "… (B" in headline
        assert "): " in headline
        assert headline.split("): ", 1)[1]

    assert "publishes audited evidence" in llm_cards[0]["headline"]
    assert "affect shift (proxy)" in deterministic_cards[0]["headline"]

    events_sha256 = social_api._social_events_fingerprint(events)
    cache_result = social_api._build_social_headline_cache(
        events_sha256=events_sha256,
        generation_mode="llm",
        headline_cards=llm_cards,
        events=events,
    )
    assert cache_result is not None
    cache_payload, _ = cache_result
    cached = social_api._read_social_headline_cache(
        {social_api._SOCIAL_HEADLINE_CACHE_KEY: cache_payload},
        events_sha256=events_sha256,
        events=events,
    )
    assert cached is not None
    assert cached[1][0]["headline"] == llm_cards[0]["headline"]


def test_social_feed_deterministic_fallback_is_retried_then_llm_result_is_cached(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "llm_api_key": "sk-social-recovery",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "social-recovery-model",
        }
    )

    with Session(get_engine()) as session:
        branch = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).one()
        actor = session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).one()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        session.add(
            SimulationAction(
                scenario_id=scenario_id,
                branch_id=branch.id,
                round_id=round_row.id,
                round_number=1,
                sequence=1,
                agent_id=actor.id,
                action_type=SimulationActionType.POST,
                status=SimulationActionStatus.VERIFIED,
                content="The provider should recover on the next request.",
                payload_json="{}",
                idempotency_key="social-recovery:1",
            )
        )
        session.commit()

    llm_calls = 0

    async def flaky_llm(*_args, **_kwargs):
        nonlocal llm_calls
        llm_calls += 1
        if llm_calls == 1:
            raise LLMError("transient headline failure")
        return json.dumps(
            {
                "headline_cards": [
                    {
                        "headline": "Provider recovered",
                        "summary": "The successful result may now be cached.",
                    }
                ]
            }
        )

    monkeypatch.setattr(social_api, "llm_call", flaky_llm)

    first = client.get(f"/api/scenario/{scenario_id}/social-feed")
    assert first.status_code == 200
    assert first.json()["generation_mode"] == "deterministic"
    with Session(get_engine()) as session:
        first_context = session.get(Scenario, scenario_id).parsed_context or {}
    assert social_api._SOCIAL_HEADLINE_CACHE_KEY not in first_context

    second = client.get(f"/api/scenario/{scenario_id}/social-feed")
    third = client.get(f"/api/scenario/{scenario_id}/social-feed")

    assert second.status_code == 200
    assert third.status_code == 200
    assert second.json()["generation_mode"] == "llm"
    assert second.json()["headline_cards"][0]["headline"] == (
        "Harbor Envoy: Provider recovered"
    )
    assert third.json()["headline_cards"] == second.json()["headline_cards"]
    assert llm_calls == 2


def test_social_headline_singleflight_reuses_one_generation_for_same_fingerprint(
    monkeypatch,
):
    scenario = Scenario(
        id="social-singleflight-scenario",
        question="What changed?",
        status=ScenarioStatus.DONE,
        parsed_context={"_language": "English"},
    )
    events = [
        {
            "event_id": "singleflight-event-1",
            "round_number": 1,
            "event_type": "post",
            "branch_title": "Main",
            "faction_label": "Harbor Envoy",
            "summary": "A verified update.",
        }
    ]
    events_sha256 = social_api._social_events_fingerprint(events)
    calls = 0
    persist_calls = 0

    async def exercise():
        started = asyncio.Event()
        release = asyncio.Event()

        async def blocked_generation(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return "llm", [
                {
                    "headline": "One shared result",
                    "summary": "Both waiters receive this result.",
                    "source_event_id": "singleflight-event-1",
                }
            ]

        def record_persist(*_args, **_kwargs):
            nonlocal persist_calls
            persist_calls += 1
            return True

        monkeypatch.setattr(social_api, "_generate_headline_cards", blocked_generation)
        monkeypatch.setattr(social_api, "_persist_social_headline_cache", record_persist)
        first = asyncio.create_task(
            social_api._generate_headline_cards_singleflight(
                scenario,
                events,
                events_sha256=events_sha256,
                expected_high_water=(0, "", 1, "action-1"),
            )
        )
        await started.wait()
        second = asyncio.create_task(
            social_api._generate_headline_cards_singleflight(
                scenario,
                events,
                events_sha256=events_sha256,
                expected_high_water=(0, "", 1, "action-1"),
            )
        )
        await asyncio.sleep(0)
        assert calls == 1
        release.set()
        return await asyncio.gather(first, second)

    first_result, second_result = asyncio.run(exercise())

    assert first_result == second_result
    assert calls == 1
    assert persist_calls == 1


def test_social_headline_singleflight_failure_does_not_poison_retry(monkeypatch):
    scenario = Scenario(
        id="social-singleflight-retry",
        question="Can the headline recover?",
        status=ScenarioStatus.DONE,
        parsed_context={"_language": "English"},
    )
    events = [
        {
            "event_id": "singleflight-retry-event",
            "round_number": 1,
            "event_type": "post",
            "branch_title": "Main",
            "faction_label": "Harbor Envoy",
            "summary": "A verified update.",
        }
    ]
    events_sha256 = social_api._social_events_fingerprint(events)
    calls = 0

    async def flaky_generation(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("transient failure")
        return "deterministic", social_api._deterministic_headline_cards(events)

    async def exercise():
        with pytest.raises(RuntimeError, match="transient failure"):
            await social_api._generate_headline_cards_singleflight(
                scenario,
                events,
                events_sha256=events_sha256,
                expected_high_water=(0, "", 1, "action-1"),
            )
        return await social_api._generate_headline_cards_singleflight(
            scenario,
            events,
            events_sha256=events_sha256,
            expected_high_water=(0, "", 1, "action-1"),
        )

    monkeypatch.setattr(social_api, "_generate_headline_cards", flaky_generation)

    mode, cards = asyncio.run(exercise())

    assert calls == 2
    assert mode == "deterministic"
    assert cards[0]["source_event_id"] == "singleflight-retry-event"


def test_social_headline_cache_cas_rejects_late_old_event_high_water():
    scenario_id = _seed_social_scenario()
    base_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with Session(get_engine()) as session:
        branch = session.exec(
            select(Branch).where(Branch.scenario_id == scenario_id)
        ).one()
        actor = session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).one()
        round_row = Round(branch_id=branch.id, round_number=1)
        session.add(round_row)
        session.flush()
        branch_id = branch.id
        actor_id = actor.id
        round_id = round_row.id
        old_action_id = f"{scenario_id}-cas-old"
        new_action_id = f"{scenario_id}-cas-new"
        session.add(
            SimulationAction(
                id=old_action_id,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_id,
                round_number=1,
                sequence=1,
                agent_id=actor_id,
                action_type=SimulationActionType.POST,
                status=SimulationActionStatus.VERIFIED,
                content="Old update",
                payload_json="{}",
                idempotency_key="social-cache-cas:old",
                created_at=base_time,
            )
        )
        session.commit()

    old_high_water: social_api._SocialHeadlineHighWater = (0, "", 1, old_action_id)
    with Session(get_engine()) as session:
        session.add(
            SimulationAction(
                id=new_action_id,
                scenario_id=scenario_id,
                branch_id=branch_id,
                round_id=round_id,
                round_number=2,
                sequence=2,
                agent_id=actor_id,
                action_type=SimulationActionType.POST,
                status=SimulationActionStatus.VERIFIED,
                content="New update",
                payload_json="{}",
                idempotency_key="social-cache-cas:new",
                created_at=base_time + timedelta(seconds=1),
            )
        )
        session.commit()

    def cache_payload(events_sha256: str, headline: str) -> dict:
        return {
            "version": 1,
            "events_sha256": events_sha256,
            "generation_mode": "llm",
            "headline_cards": [
                {
                    "headline": headline,
                    "summary": headline,
                    "source_event_id": f"event-{events_sha256}",
                }
            ],
        }

    assert social_api._persist_social_headline_cache(
        scenario_id,
        cache_payload("new", "New headline"),
        expected_high_water=(0, "", 2, new_action_id),
    )
    assert not social_api._persist_social_headline_cache(
        scenario_id,
        cache_payload("old", "Late old headline"),
        expected_high_water=old_high_water,
    )
    with Session(get_engine()) as session:
        context = session.get(Scenario, scenario_id).parsed_context
    assert context[social_api._SOCIAL_HEADLINE_CACHE_KEY]["events_sha256"] == "new"


@pytest.mark.parametrize(
    ("action_type", "content", "target_type", "payload", "expected"),
    [
        (SimulationActionType.POST, "港口更新", None, {}, "行动代理发布了动态：港口更新"),
        (
            SimulationActionType.COMMENT,
            "我同意",
            "post",
            {},
            "行动代理评论了一条动态：我同意",
        ),
        (
            SimulationActionType.REACTION,
            None,
            "post",
            {"reaction": "LIKE"},
            "行动代理对一条动态表达了“点赞”",
        ),
        (SimulationActionType.FOLLOW, None, "agent", {}, "行动代理关注了目标代理"),
        (SimulationActionType.MUTE, None, "agent", {}, "行动代理屏蔽了目标代理"),
        (SimulationActionType.SEARCH, "港口", "query", {}, "行动代理搜索了：港口"),
        (SimulationActionType.TREND, None, None, {}, "行动代理查看了热门话题"),
        (SimulationActionType.REFRESH, None, None, {}, "行动代理刷新了动态"),
    ],
)
def test_social_action_summary_localizes_chinese_without_changing_wire_type(
    action_type,
    content,
    target_type,
    payload,
    expected,
):
    scenario = Scenario(
        id="social-chinese",
        question="港口委员会应如何回应？",
        status=ScenarioStatus.DONE,
        parsed_context={"_language": "Chinese"},
    )
    branch = Branch(id="social-chinese-branch", scenario_id=scenario.id, title="港口线")
    actor = Agent(id="social-chinese-actor", scenario_id=scenario.id, name="行动代理")
    target = Agent(id="social-chinese-target", scenario_id=scenario.id, name="目标代理")
    action = SimulationAction(
        id=f"social-chinese-{action_type.value.lower()}",
        scenario_id=scenario.id,
        branch_id=branch.id,
        round_id="social-chinese-round",
        round_number=1,
        sequence=1,
        agent_id=actor.id,
        message_id="social-chinese-message",
        action_type=action_type,
        status=SimulationActionStatus.VERIFIED,
        content=content,
        target_type=target_type,
        target_id=(
            target.id
            if target_type == "agent"
            else ("social-chinese-post" if target_type else None)
        ),
        payload_json=json.dumps(payload),
        idempotency_key=f"social-chinese:{action_type.value}",
    )

    projected = social_api._build_display_safe_action_events(
        scenario,
        [branch],
        [actor, target],
        [action],
    )

    assert projected[0]["event_type"] == action_type.value.lower()
    assert projected[0]["summary"] == expected


def test_social_copy_request_accepts_model_profile_id():
    req = social_api.SocialCopyRequest(model_profile_id=" profile-social ")

    assert req.model_profile_id == "profile-social"


def test_social_copy_request_defaults_model_profile_id_to_none():
    assert social_api.SocialCopyRequest().model_profile_id is None


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_inherited_remote_byok_url_uses_server_default(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-server-default", raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "byok-profile-model",
            "user_id": "owner-1",
        }
    )

    async def fake_llm(_prompt: str, **kwargs):
        if (
            kwargs.get("api_key") is not None
            or kwargs.get("base_url") is not None
            or kwargs.get("model") is not None
        ):
            raise LLMError(f"expected server default provider, got {kwargs!r}")
        return "server default social copy"

    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(client, method, scenario_id)

    assert response.status_code == 200
    assert response.json()["copy"] == "server default social copy"


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_per_platform_endpoints_honor_feature_gate(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", False, raising=False)
    scenario_id = _seed_social_scenario()
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("feature gate should block before LLM work")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(client, method, scenario_id)

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "FEATURE_DISABLED"
    assert called is False


def test_social_copy_explicit_base_url_without_key_still_requires_key(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario()

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"llm_base_url": "https://api.openai.com/v1"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


def test_social_copy_explicit_local_base_url_without_key_is_forwarded(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    scenario_id = _seed_social_scenario()
    captured: dict[str, object] = {}

    async def fake_llm(_prompt: str, **kwargs):
        captured.update(kwargs)
        return "local social copy"

    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={
            "llm_base_url": "http://127.0.0.1:11434/v1",
            "llm_model": "llama3.2",
        },
    )

    assert response.status_code == 200
    assert response.json()["copy"] == "local social copy"
    assert captured["api_key"] is None
    assert captured["base_url"] == "http://127.0.0.1:11434/v1"
    assert captured["model"] == "llama3.2"


def test_social_copy_inherited_remote_byok_url_without_server_key_is_400(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "", raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
        }
    )
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("LLM should not be called without a server default key")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(client, "GET", scenario_id)

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    assert called is False


def test_social_copy_rejects_unowned_model_profile(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario_id = _seed_social_scenario(user_id="social-owner")
    profile_id = _seed_model_profile(user_id="different-owner")
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise LLMError("profile ownership should fail before LLM work")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"model_profile_id": profile_id},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "MODEL_PROFILE_NOT_FOUND"
    assert called is False


def test_social_copy_model_profile_threads_scope_and_provider(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario_id = _seed_social_scenario(user_id="social-owner")
    profile_id = _seed_model_profile(
        user_id="social-owner",
        model="profile-social-model",
        api_key="sk-social-profile",
        rpm=19,
        tpm=1900,
        concurrency=5,
        supports_structured_outputs=False,
        supports_native_search=True,
        native_search_upstream="xai_responses",
    )
    captured: dict = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **kwargs):
        captured["llm"] = dict(kwargs)
        return "profile social copy"

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"model_profile_id": profile_id},
    )

    assert response.status_code == 200
    assert response.json()["copy"] == "profile social copy"
    assert captured["llm"]["api_key"] == "sk-social-profile"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "profile-social-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_copy",
        "requests_per_minute": 19,
        "tokens_per_minute": 1900,
        "concurrency": 5,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": True,
        "native_search_upstream_override": "xai_responses",
    }


def test_social_copy_rehydrates_profile_from_parsed_context(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    profile_id = _seed_model_profile(
        user_id="social-owner",
        model="stored-social-model",
        api_key="sk-stored-social",
        rpm=37,
        tpm=3700,
        concurrency=6,
        supports_structured_outputs=False,
        supports_native_search=True,
        native_search_upstream="xai_responses",
    )
    scenario_id = _seed_social_scenario(
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": profile_id,
            "llm_concurrency": 1,
            "supports_structured_outputs": True,
            "supports_native_search": False,
        },
    )
    captured: dict[str, object] = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **kwargs):
        captured["llm"] = dict(kwargs)
        return "stored profile social copy"

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(client, "POST", scenario_id, body={})

    assert response.status_code == 200
    assert response.json()["copy"] == "stored profile social copy"
    assert captured["llm"]["api_key"] == "sk-stored-social"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "stored-social-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_copy",
        "requests_per_minute": 37,
        "tokens_per_minute": 3700,
        "concurrency": 6,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": True,
        "native_search_upstream_override": "xai_responses",
    }


def test_social_copy_recovered_remote_profile_rejects_key_only_override(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    profile_id = _seed_model_profile(
        user_id="social-mix-owner",
        model="provider-b-social-model",
        api_key="sk-provider-b-social",
    )
    scenario_id = _seed_social_scenario(
        user_id="social-mix-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": profile_id,
        },
    )
    llm_called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal llm_called
        llm_called = True
        raise AssertionError("key-only override must not use the recovered endpoint")

    monkeypatch.setattr("app.services.llm_client.llm_call", unexpected_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"llm_api_key": "sk-provider-a-session"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    assert llm_called is False


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_social_copy_stored_profile_missing_fails_closed(
    client: TestClient,
    monkeypatch,
    method: str,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-server-default", raising=False)
    scenario_id = _seed_social_scenario(
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": "deleted-social-profile",
            "llm_base_url": "https://legacy.example/v1",
            "llm_model": "legacy-social-model",
        },
    )

    async def unexpected_llm(_prompt: str, **_kwargs):
        raise AssertionError("missing stored profile must fail before LLM work")

    monkeypatch.setattr(social_api, "llm_call", unexpected_llm)

    response = _request_social_copy(client, method, scenario_id, body={})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


def test_social_copy_stored_profile_missing_rejects_key_only_override(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario_id = _seed_social_scenario(
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": "deleted-social-profile",
            "llm_base_url": "https://legacy.example/v1",
            "llm_model": "legacy-social-model",
        },
    )

    async def unexpected_llm(_prompt: str, **_kwargs):
        raise AssertionError("key-only override must not inherit legacy provider")

    monkeypatch.setattr(social_api, "llm_call", unexpected_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={"llm_api_key": "sk-new-request-key"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


def test_social_headline_cards_thread_profile_provider_and_runtime(monkeypatch):
    scenario = Scenario(
        id="scenario-social-headlines",
        question="What if harbor councils publish every correction?",
        status=ScenarioStatus.DONE,
        parsed_context={
            "_language": "English",
            "user_id": "social-owner",
            "llm_api_key": "sk-social-headline-profile",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "headline-profile-model",
            "llm_requests_per_minute": 23,
            "llm_tokens_per_minute": 2300,
            "llm_concurrency": 4,
            "supports_structured_outputs": False,
            "supports_native_search": None,
            "native_search_upstream": "openai_responses",
        },
    )
    events = [{
        "event_id": "event_1",
        "branch_id": "branch-1",
        "round_number": 1,
        "event_type": "stance_shift",
        "title": "Harbor correction",
        "summary": "The harbor coalition publishes every correction.",
        "faction_label": "Harbor coalition",
        "confidence": 0.5,
    }]
    captured: dict[str, object] = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(prompt: str, **kwargs):
        captured["prompt"] = prompt
        captured["llm"] = dict(kwargs)
        return json.dumps({
            "headline_cards": [
                {
                    "headline": "Harbor councils publish the receipts",
                    "summary": "The correction ledger becomes the visible pressure point.",
                    "source_event_id": "event_1",
                }
            ]
        })

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr(social_api, "llm_call", fake_llm)

    mode, cards = asyncio.run(social_api._generate_headline_cards(scenario, events))

    assert mode == "llm"
    assert cards[0]["headline"] == "Harbor councils publish the receipts"
    assert "legacy confidence field is faction member share" in str(captured["prompt"])
    assert "not model certainty" in str(captured["prompt"])
    assert captured["llm"]["api_key"] == "sk-social-headline-profile"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "headline-profile-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_headline_cards",
        "requests_per_minute": 23,
        "tokens_per_minute": 2300,
        "concurrency": 4,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": None,
        "native_search_upstream_override": "openai_responses",
    }


def test_social_headline_cards_rehydrates_profile_from_parsed_context(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    profile_id = _seed_model_profile(
        user_id="social-owner",
        model="stored-headline-model",
        api_key="sk-stored-headline",
        rpm=41,
        tpm=4100,
        concurrency=8,
        supports_structured_outputs=True,
        supports_native_search=False,
        native_search_upstream="xai_responses",
    )
    scenario = Scenario(
        id="scenario-social-headlines-stored-profile",
        question="What if harbor councils publish every correction?",
        status=ScenarioStatus.DONE,
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": profile_id,
            "llm_concurrency": 1,
            "supports_structured_outputs": False,
            "supports_native_search": True,
        },
    )
    events = [{
        "event_id": "event_1",
        "branch_id": "branch-1",
        "round_number": 1,
        "event_type": "stance_shift",
        "title": "Harbor correction",
        "summary": "The harbor coalition publishes every correction.",
        "faction_label": "Harbor coalition",
    }]
    captured: dict[str, object] = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **kwargs):
        captured["llm"] = dict(kwargs)
        return json.dumps({
            "headline_cards": [
                {
                    "headline": "Stored profile headline",
                    "summary": "The saved profile writes the headline.",
                    "source_event_id": "event_1",
                }
            ]
        })

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr(social_api, "llm_call", fake_llm)

    mode, cards = asyncio.run(social_api._generate_headline_cards(scenario, events))

    assert mode == "llm"
    assert cards[0]["headline"] == "Stored profile headline"
    assert captured["llm"]["api_key"] == "sk-stored-headline"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "stored-headline-model"
    assert captured["scope"] == {
        "quota_key": "user:social-owner",
        "purpose": "social_headline_cards",
        "requests_per_minute": 41,
        "tokens_per_minute": 4100,
        "concurrency": 8,
        "supports_structured_outputs_override": True,
        "supports_native_search_override": False,
        "native_search_upstream_override": "xai_responses",
    }


def test_social_headline_cards_stored_profile_missing_uses_deterministic_fallback(
    monkeypatch,
):
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    scenario = Scenario(
        id="scenario-social-headlines-missing-profile",
        question="What if harbor councils publish every correction?",
        status=ScenarioStatus.DONE,
        user_id="social-owner",
        parsed_context={
            "_language": "English",
            "model_profile_id": "deleted-headline-profile",
            "llm_base_url": "https://legacy.example/v1",
            "llm_model": "legacy-headline-model",
        },
    )
    events = [
        {
            "event_id": "event_1",
            "branch_id": "branch-1",
            "round_number": 1,
            "event_type": "stance_shift",
            "title": "Harbor correction",
            "summary": "The harbor coalition publishes every correction.",
            "faction_label": "Harbor coalition",
        }
    ]

    async def unexpected_llm(_prompt: str, **_kwargs):
        raise AssertionError("missing stored profile must not use fallback LLM")

    monkeypatch.setattr(social_api, "llm_call", unexpected_llm)

    mode, cards = asyncio.run(social_api._generate_headline_cards(scenario, events))

    assert mode == "deterministic"
    assert cards == social_api._deterministic_headline_cards(events)


def test_social_copy_quota_uses_authenticated_principal(
    client: TestClient,
    monkeypatch,
):
    secret = "social-secret"
    monkeypatch.setattr(settings, "FEATURE_SOCIAL_HEADLINES", True, raising=False)
    monkeypatch.setattr(settings, "SESSION_SECRET", secret, raising=False)
    scenario_id = _seed_social_scenario(
        parsed_context={
            "_language": "English",
            "user_id": "context-user",
        },
        user_id="social-owner",
    )
    captured: dict = {}
    original_scope = social_api.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **_kwargs):
        return "principal social copy"

    monkeypatch.setattr(social_api, "llm_request_scope", spy_scope)
    monkeypatch.setattr("app.services.llm_client.llm_call", fake_llm)

    response = _request_social_copy(
        client,
        "POST",
        scenario_id,
        body={},
        headers={
            "X-Session-Token": _make_signed_session_token(secret, "social-owner")
        },
    )

    assert response.status_code == 200
    assert response.json()["copy"] == "principal social copy"
    assert captured["scope"]["quota_key"] == "user:social-owner"
