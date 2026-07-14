"""Contracts for durable, secret-free provider lifecycle telemetry."""

import asyncio
import json

import pytest
from sqlmodel import Session, select

from app.models import ProviderAttemptTelemetry, ProviderRequestTelemetry
from app.models.database import get_engine
from app.services import llm_client, provider_telemetry


def test_telemetry_separates_request_attempts_and_keeps_missing_cost_unknown():
    request_id = provider_telemetry.start_request(
        provider=provider_telemetry.safe_provider_name(
            "https://user:secret@example.com/private/byok/tenant"
        ),
        model="grok-4.5",
        purpose="simulation_turn",
    )
    tokens = provider_telemetry.bind_request(request_id)
    try:
        bound_request_id, attempt = provider_telemetry.next_attempt()
        provider_telemetry.finish_attempt(
            bound_request_id,
            attempt,
            status="succeeded",
            usage={"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
        )
        provider_telemetry.finish_request(request_id, status="succeeded")
    finally:
        provider_telemetry.unbind_request(tokens)

    with Session(get_engine()) as session:
        request = session.get(ProviderRequestTelemetry, request_id)
        attempts = session.exec(
            select(ProviderAttemptTelemetry).where(
                ProviderAttemptTelemetry.request_id == request_id
            )
        ).all()

    assert request is not None
    assert request.provider == "example.com"
    assert request.status == "succeeded"
    assert request.finished_at is not None
    assert len(attempts) == 1
    assert attempts[0].attempt == 1
    assert attempts[0].total_tokens == 14
    assert attempts[0].reported_cost_value is None
    assert attempts[0].reported_cost_unit is None
    assert attempts[0].cost_source is None


@pytest.mark.parametrize(
    ("raw_cost", "expected"),
    [
        (1250, 1250.0),
        (0.25, 0.25),
        (None, None),
        ("1250", None),
        (True, None),
        (-1, None),
        (float("nan"), None),
        (float("inf"), None),
    ],
)
def test_provider_reported_cost_is_strict_and_never_converted(raw_cost, expected):
    usage = {"input_tokens": 2, "output_tokens": 3}
    if raw_cost is not None:
        usage["cost_in_usd_ticks"] = raw_cost

    fields = llm_client._extract_provider_usage_fields({"usage": usage})

    assert fields["reported_cost_value"] == expected
    assert fields["reported_cost_unit"] == ("usd_ticks" if expected is not None else None)
    assert fields["cost_source"] == ("provider_reported" if expected is not None else None)


@pytest.mark.parametrize(
    ("is_chat", "chunk"),
    [
        (
            True,
            {
                "usage": {
                    "prompt_tokens": 4,
                    "completion_tokens": 2,
                    "cost_in_usd_ticks": 77,
                }
            },
        ),
        (
            False,
            {
                "response": {
                    "usage": {
                        "input_tokens": 4,
                        "output_tokens": 2,
                        "cost_in_usd_ticks": 77,
                    }
                }
            },
        ),
    ],
)
def test_stream_terminal_usage_extracts_provider_reported_cost(is_chat, chunk):
    fields = llm_client._extract_stream_usage_fields(chunk, is_chat=is_chat)

    assert fields is not None
    assert fields["total_tokens"] == 6
    assert fields["reported_cost_value"] == 77.0
    assert fields["reported_cost_unit"] == "usd_ticks"
    assert fields["cost_source"] == "provider_reported"


@pytest.mark.asyncio
async def test_llm_call_records_retry_usage_without_prompt_or_response(monkeypatch):
    class _FakeResponse:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload
            self.text = json.dumps(payload)
            self.headers = {}
            self.request = None

        def raise_for_status(self):
            if self.status_code >= 400:
                request = llm_client.httpx.Request("POST", "https://example.com/v1/responses")
                response = llm_client.httpx.Response(
                    self.status_code, request=request, json=self._payload
                )
                raise llm_client.httpx.HTTPStatusError(
                    "failed", request=request, response=response
                )

        def json(self):
            return self._payload

    class _FakeClient:
        def __init__(self):
            self.responses = [
                _FakeResponse(500, {"error": "secret raw provider error"}),
                _FakeResponse(
                    200,
                    {
                        "output_text": "usable answer",
                        "usage": {
                            "input_tokens": 8,
                            "output_tokens": 3,
                            "cost_in_usd_ticks": 42,
                        },
                    },
                ),
            ]

        async def post(self, *_args, **_kwargs):
            return self.responses.pop(0)

    fake_client = _FakeClient()

    async def _no_sleep(_delay):
        return None

    monkeypatch.setattr(llm_client, "_get_shared_async_client", lambda: fake_client)
    monkeypatch.setattr(asyncio, "sleep", _no_sleep)

    result = await llm_client.llm_call(
        "do not persist this prompt",
        model="grok-4.5",
        base_url="https://example.com/v1/responses",
        api_key="sk-do-not-persist",
    )
    assert result == "usable answer"

    with Session(get_engine()) as session:
        requests = session.exec(select(ProviderRequestTelemetry)).all()
        attempts = session.exec(
            select(ProviderAttemptTelemetry).order_by(ProviderAttemptTelemetry.attempt)
        ).all()

    assert len(requests) == 1
    assert requests[0].status == "succeeded"
    assert [row.status for row in attempts] == ["failed", "succeeded"]
    assert attempts[-1].total_tokens == 11
    assert attempts[-1].reported_cost_value == 42.0
    assert attempts[-1].reported_cost_unit == "usd_ticks"
    assert attempts[-1].cost_source == "provider_reported"
    serialized = " ".join(str(row.model_dump()) for row in [*requests, *attempts])
    assert "do not persist this prompt" not in serialized
    assert "sk-do-not-persist" not in serialized
    assert "secret raw provider error" not in serialized


def test_cancelled_request_has_cancel_timestamp_and_bounded_code():
    request_id = provider_telemetry.start_request(
        provider="localhost", model="grok-4.5", purpose="simulation_turn"
    )
    provider_telemetry.finish_request(
        request_id, status="cancelled", error_code="LLM_CANCELLED"
    )

    with Session(get_engine()) as session:
        request = session.get(ProviderRequestTelemetry, request_id)

    assert request is not None
    assert request.cancel_seen_at is not None
    assert request.finished_at == request.cancel_seen_at
    assert request.safe_error_code == "LLM_CANCELLED"
