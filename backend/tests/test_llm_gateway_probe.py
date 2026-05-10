"""Live gateway probe for local OpenAI-compatible endpoints.

Run manually:
    RUN_REAL_LLM_TESTS=1 python -m pytest tests/test_llm_gateway_probe.py -v -s
"""

from __future__ import annotations

import json
import os

import httpx
import pytest

from app.services.llm_client import llm_call_json_stream

LLM_URLS = ["http://127.0.0.1:8318/v1", "http://127.0.0.1:8317/v1"]
LLM_API_KEY = "sk-12345678"
LLM_MODEL = "gpt-5.4-mini"
_RUN_REAL_LLM_TESTS = os.getenv("RUN_REAL_LLM_TESTS") == "1"


async def _probe_non_stream(base_url: str) -> dict:
    headers = {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json",
    }
    chat_status = None
    responses_status = None
    chat_content = ""
    output_text = ""
    chat_error = None
    responses_error = None

    async with httpx.AsyncClient(timeout=30.0) as client:
        chat_resp = await client.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json={
                "model": LLM_MODEL,
                "messages": [{"role": "user", "content": 'Reply with exactly: {"ok":true}'}],
                "max_tokens": 32,
            },
        )
        chat_status = chat_resp.status_code
        if chat_resp.is_success:
            chat_data = chat_resp.json()
            chat_content = (
                ((chat_data.get("choices") or [{}])[0].get("message") or {}).get("content")
                or ""
            )
        else:
            chat_data = {}
            chat_error = chat_resp.text[:300]

        responses_resp = await client.post(
            f"{base_url}/responses",
            headers=headers,
            json={
                "model": LLM_MODEL,
                "input": 'Reply with exactly: {"ok":true}',
            },
        )
        responses_status = responses_resp.status_code
        if responses_resp.is_success:
            responses_data = responses_resp.json()
            outputs = responses_data.get("output") or []
            if outputs:
                msg = next((item for item in outputs if item.get("type") == "message"), None)
                if msg and msg.get("content"):
                    first = msg["content"][0]
                    output_text = first.get("text") or first.get("output_text") or ""
        else:
            responses_data = {}
            responses_error = responses_resp.text[:300]

    return {
        "base_url": base_url,
        "chat_status": chat_status,
        "responses_status": responses_status,
        "chat_has_content": bool(isinstance(chat_content, str) and chat_content.strip()),
        "responses_has_output_text": bool(isinstance(output_text, str) and output_text.strip()),
        "chat_error": chat_error,
        "responses_error": responses_error,
        "chat_usage": chat_data.get("usage"),
        "responses_usage": responses_data.get("usage"),
    }


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _RUN_REAL_LLM_TESTS,
    reason="set RUN_REAL_LLM_TESTS=1 to enable live probes",
)
async def test_live_gateway_non_stream_probe():
    observed = []
    for base_url in LLM_URLS:
        observed.append(await _probe_non_stream(base_url))

    print(json.dumps(observed, ensure_ascii=False, indent=2))
    assert len(observed) == len(LLM_URLS)
    assert all("chat_has_content" in item for item in observed)
    assert all("responses_has_output_text" in item for item in observed)


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _RUN_REAL_LLM_TESTS,
    reason="set RUN_REAL_LLM_TESTS=1 to enable live probes",
)
async def test_live_gateway_stream_json_probe():
    prompt = 'Reply with strict JSON only: {"ok": true, "source": "stream"}'
    errors: list[str] = []

    for base_url in LLM_URLS:
        try:
            result = await llm_call_json_stream(
                prompt,
                reasoning_effort="low",
                temperature=0.0,
                model=LLM_MODEL,
                api_key=LLM_API_KEY,
                base_url=base_url,
            )
        except Exception as exc:
            errors.append(f"{base_url}: {type(exc).__name__}: {exc}")
            continue

        assert result["ok"] is True
        assert result["source"] == "stream"
        return

    pytest.fail("No live gateway returned valid JSON via streaming:\n" + "\n".join(errors))
