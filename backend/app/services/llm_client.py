"""Unified LLM client — supports both Chat Completions & Responses API."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# C-3 fix: pattern to detect API keys in error messages
_KEY_PATTERN = re.compile(r'(sk-[a-zA-Z0-9]{4})[a-zA-Z0-9]+', re.IGNORECASE)
_BEARER_PATTERN = re.compile(r'(Bearer\s+)[^\s"]+', re.IGNORECASE)


def _sanitize_error(msg: str) -> str:
    """Strip API keys and bearer tokens from error messages."""
    msg = _KEY_PATTERN.sub(r'\1****', msg)
    msg = _BEARER_PATTERN.sub(r'\1****', msg)
    return msg


def _is_chat_completions_api(url: str | None = None) -> bool:
    """Detect API mode at call time (not module load) for test flexibility."""
    target_url = url or settings.LLM_RESPONSES_URL
    return "chat/completions" in target_url


class LLMError(Exception):
    """Raised when LLM call fails."""


async def llm_call(
    input_text: str,
    *,
    reasoning_effort: str | None = None,
    model: str | None = None,
    timeout: float = 120.0,
    api_key: str | None = None,
    base_url: str | None = None,
) -> str:
    """Call LLM via Chat Completions or Responses API (auto-detected from URL).

    Args:
        input_text: The prompt / instruction to send.
        reasoning_effort: Override reasoning effort (low/medium/high).
        model: Override model name.
        timeout: Request timeout in seconds.
        api_key: BYOK — override API key for this call.
        base_url: BYOK — override base URL for this call.

    Returns:
        The text content from the LLM response.
    """
    target_url = base_url or settings.LLM_RESPONSES_URL
    target_key = api_key or settings.LLM_API_KEY
    is_chat = _is_chat_completions_api(target_url)

    payload: dict[str, Any] = {
        "model": model or settings.LLM_MODEL_NAME,
    }

    effort = reasoning_effort or settings.LLM_REASONING_EFFORT

    if is_chat:
        # ── Chat Completions API ──
        payload["messages"] = [{"role": "user", "content": input_text}]
        if effort:
            payload["reasoning_effort"] = effort
    else:
        # ── Responses API ──
        payload["input"] = input_text
        if effort:
            payload["reasoning"] = {"effort": effort}

    logger.debug("LLM request → %s [%s] (effort=%s, %d chars, byok=%s)",
                 payload["model"],
                 "chat" if is_chat else "responses",
                 effort, len(input_text), bool(api_key or base_url))

    async with httpx.AsyncClient(timeout=timeout) as client:
        max_retries = 3
        retry_delay = 1.0
        last_exc: Exception | None = None

        for attempt in range(max_retries + 1):
            try:
                resp = await client.post(
                    target_url,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {target_key}",
                        "Content-Type": "application/json",
                    },
                )
                resp.raise_for_status()
                break  # Success — exit retry loop
            except httpx.HTTPStatusError as exc:
                status_code = exc.response.status_code
                # Retry on 429 (rate limit) and 5xx (server errors)
                if status_code == 429 or status_code >= 500:
                    last_exc = exc
                    if attempt < max_retries:
                        wait = retry_delay * (2 ** attempt)
                        logger.warning(
                            "LLM HTTP %d (attempt %d/%d), retrying in %.1fs",
                            status_code, attempt + 1, max_retries + 1, wait,
                        )
                        await asyncio.sleep(wait)
                        continue
                # Non-retryable 4xx — raise immediately
                logger.error("LLM HTTP error %s: %s", exc.response.status_code,
                             _sanitize_error(exc.response.text[:500]))
                raise LLMError(f"LLM returned {exc.response.status_code}") from exc
            except httpx.RequestError as exc:
                last_exc = exc
                if attempt < max_retries:
                    wait = retry_delay * (2 ** attempt)
                    logger.warning(
                        "LLM connection error (attempt %d/%d), retrying in %.1fs: %s",
                        attempt + 1, max_retries + 1, wait, exc,
                    )
                    import asyncio
                    await asyncio.sleep(wait)
                    continue
                logger.error("LLM connection error: %s", _sanitize_error(str(exc)))
                raise LLMError(f"LLM connection failed: {_sanitize_error(str(exc))}") from exc
        else:
            # All retries exhausted
            logger.error("LLM call failed after %d attempts", max_retries + 1)
            raise LLMError(f"LLM call failed after {max_retries + 1} attempts") from last_exc

    data = resp.json()

    try:
        if is_chat:
            # choices[0].message.content
            text = data["choices"][0]["message"]["content"]
        else:
            # output[].type=="message" -> content[0].text
            outputs = data.get("output", [])
            msg = next((o for o in outputs if o.get("type") == "message"), None)
            if msg is None:
                msg = next((o for o in outputs if "content" in o), None)
            if msg is None:
                raise KeyError("No message block in output")
            text = msg["content"][0]["text"]
    except (KeyError, IndexError, TypeError, StopIteration) as exc:
        logger.error("Unexpected LLM response structure: %s",
                     json.dumps(data, ensure_ascii=False)[:500])
        raise LLMError("Unexpected response structure") from exc

    usage = data.get("usage", {})
    tok_in = usage.get("prompt_tokens") or usage.get("input_tokens", "?")
    tok_out = usage.get("completion_tokens") or usage.get("output_tokens", "?")
    logger.debug("LLM response ← %d chars (tokens: in=%s out=%s)",
                 len(text), tok_in, tok_out)

    return text


def _clean_json_text(raw: str) -> str:
    """Strip markdown code fences and illegal control characters from LLM JSON output.

    Also attempts to extract JSON by finding first '{' to last '}' as a fallback
    for LLM responses that include preamble text before the actual JSON.
    """

    cleaned = raw.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        if lines[-1].strip().startswith("```"):
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        cleaned = "\n".join(lines)

    # Remove illegal JSON control characters (0x00-0x1F) except \t \n \r
    # which are allowed whitespace in JSON strings.
    cleaned = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', cleaned)

    # M-6 fix: fallback — extract first '{' to last '}' if cleaned doesn't
    # start with '{' or '[', indicating LLM added preamble text
    stripped = cleaned.strip()
    if stripped and stripped[0] not in ('{', '['):
        first_brace = cleaned.find('{')
        last_brace = cleaned.rfind('}')
        if first_brace != -1 and last_brace > first_brace:
            cleaned = cleaned[first_brace:last_brace + 1]
        else:
            # Try array extraction
            first_bracket = cleaned.find('[')
            last_bracket = cleaned.rfind(']')
            if first_bracket != -1 and last_bracket > first_bracket:
                cleaned = cleaned[first_bracket:last_bracket + 1]

    return cleaned


def _recover_keyed_json_like_response(cleaned: str) -> dict[str, Any] | None:
    """Recover simple key/value JSON-like payloads from malformed text.

    This is intentionally conservative and primarily targets partially broken
    object payloads such as:
    {"content": "...", "emotion": "...", "diverge": "..."]
    """
    recovered: dict[str, Any] = {}

    def _extract_string_or_null(key: str) -> None:
        match = re.search(
            rf'"{key}"\s*:\s*(null|"(?:\\.|[^"\\])*")',
            cleaned,
            re.DOTALL,
        )
        if not match:
            return

        raw_value = match.group(1)
        if raw_value == "null":
            recovered[key] = None
            return

        try:
            recovered[key] = json.loads(raw_value)
        except json.JSONDecodeError:
            recovered[key] = raw_value.strip('"')

    for scalar_key in ("content", "emotion", "diverge", "story", "insight", "title"):
        _extract_string_or_null(scalar_key)

    key_moments_match = re.search(r'"key_moments"\s*:\s*(\[[\s\S]*?\])', cleaned)
    if key_moments_match:
        raw_array = key_moments_match.group(1)
        try:
            parsed = json.loads(raw_array)
            if isinstance(parsed, list):
                recovered["key_moments"] = parsed
        except json.JSONDecodeError:
            items = re.findall(r'"((?:\\.|[^"\\])*)"', raw_array)
            if items:
                recovered["key_moments"] = [json.loads(f'"{item}"') for item in items]

    return recovered or None


def _recover_agent_message_payload(cleaned: str) -> dict[str, Any] | None:
    """Best-effort fallback for agent message outputs when JSON framing is broken."""
    recovered = _recover_keyed_json_like_response(cleaned) or {}

    if not recovered.get("content"):
        content_patterns = [
            re.compile(r'"content"\s*:\s*"([\s\S]*?)(?=",\s*"emotion"|",\s*"diverge"|"\s*[}\]])'),
            re.compile(r'content\s*[:=]\s*([\s\S]*?)(?:\n(?:emotion|diverge)\s*[:=]|$)', re.IGNORECASE),
        ]
        for pattern in content_patterns:
            match = pattern.search(cleaned)
            if match:
                recovered["content"] = match.group(1).strip().strip('"')
                break

    if not recovered.get("content"):
        plain = cleaned.strip()
        if plain:
            recovered["content"] = plain[:500]

    if not recovered.get("emotion"):
        emotion_match = re.search(r'"emotion"\s*:\s*"?(?P<emotion>[A-Za-z_\-]+)', cleaned)
        if emotion_match:
            recovered["emotion"] = emotion_match.group("emotion")

    recovered.setdefault("emotion", "neutral")
    recovered.setdefault("diverge", None)

    return recovered if recovered.get("content") else None


async def llm_call_json(
    input_text: str,
    *,
    reasoning_effort: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    fallback_mode: str | None = None,
) -> dict:
    """Call LLM and parse the response as JSON.

    Strips markdown code fences if present.
    """
    raw = await llm_call(
        input_text, reasoning_effort=reasoning_effort, model=model,
        api_key=api_key, base_url=base_url,
    )

    cleaned = _clean_json_text(raw)

    try:
        return json.loads(cleaned, strict=False)
    except json.JSONDecodeError:
        pass  # try recovery strategies below

    # Strategy 2: try to extract any JSON object or array via regex
    import re as _re
    json_patterns = [
        _re.compile(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', _re.DOTALL),  # nested objects
        _re.compile(r'\[.*?\]', _re.DOTALL),  # arrays
    ]
    for pattern in json_patterns:
        matches = pattern.findall(cleaned)
        for match in matches:
            try:
                result = json.loads(match, strict=False)
                logger.warning("LLM JSON recovered via regex extraction (len=%d)", len(match))
                return result
            except json.JSONDecodeError:
                continue

    # Strategy 3: recover simple keyed payloads from malformed object text
    recovered = _recover_keyed_json_like_response(cleaned)
    if recovered is not None:
        logger.warning("LLM JSON recovered via keyed fallback (keys=%s)", ",".join(sorted(recovered.keys())))
        return recovered

    if fallback_mode == "agent_message":
        recovered = _recover_agent_message_payload(cleaned)
        if recovered is not None:
            logger.warning("LLM JSON recovered via agent-message fallback")
            return recovered

    # Strategy 4: give up with a descriptive error
    logger.error("Failed to parse LLM JSON after all recovery attempts:\n%s", cleaned[:500])
    raise LLMError(f"Invalid JSON from LLM after recovery attempts")


async def llm_call_stream(
    input_text: str,
    *,
    reasoning_effort: str | None = None,
    model: str | None = None,
    timeout: float = 120.0,
    api_key: str | None = None,
    base_url: str | None = None,
):
    """Stream LLM response token by token (async generator).

    Yields delta text chunks as they arrive via SSE.
    Only supports Chat Completions API with stream=true.
    """
    target_url = base_url or settings.LLM_RESPONSES_URL
    target_key = api_key or settings.LLM_API_KEY
    is_chat = _is_chat_completions_api(target_url)

    payload: dict[str, Any] = {
        "model": model or settings.LLM_MODEL_NAME,
        "stream": True,
    }

    effort = reasoning_effort or settings.LLM_REASONING_EFFORT

    if is_chat:
        payload["messages"] = [{"role": "user", "content": input_text}]
        if effort:
            payload["reasoning_effort"] = effort
    else:
        payload["input"] = input_text
        if effort:
            payload["reasoning"] = {"effort": effort}
        payload["stream"] = True

    logger.debug("LLM stream request → %s (effort=%s, %d chars, byok=%s)",
                 payload["model"], effort, len(input_text), bool(api_key or base_url))

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream(
                "POST",
                target_url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {target_key}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                        if is_chat:
                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content")
                        else:
                            # Responses API streaming format
                            content = chunk.get("delta", "")
                        if content:
                            yield content
                    except (json.JSONDecodeError, IndexError, KeyError):
                        continue
        except httpx.HTTPStatusError as exc:
            logger.error("LLM stream HTTP error %s: %s",
                         exc.response.status_code, _sanitize_error(exc.response.text[:500]))
            raise LLMError(f"LLM returned {exc.response.status_code}") from exc
        except httpx.RequestError as exc:
            logger.error("LLM stream connection error: %s", _sanitize_error(str(exc)))
            raise LLMError(f"LLM connection failed: {_sanitize_error(str(exc))}") from exc


async def llm_call_json_stream(
    input_text: str,
    *,
    reasoning_effort: str | None = None,
    model: str | None = None,
    on_delta: Any = None,
    api_key: str | None = None,
    base_url: str | None = None,
) -> dict:
    """Stream LLM response with real-time delta callback, then parse as JSON.

    Args:
        on_delta: async callable(text_chunk) called for each token delta.
    """
    full_text = ""
    async for delta in llm_call_stream(
        input_text, reasoning_effort=reasoning_effort, model=model,
        api_key=api_key, base_url=base_url,
    ):
        full_text += delta
        if on_delta:
            await on_delta(delta)

    cleaned = _clean_json_text(full_text)
    try:
        return json.loads(cleaned, strict=False)
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse streamed LLM JSON:\n%s", cleaned[:500])
        raise LLMError(f"Invalid JSON from LLM: {exc}") from exc


async def health_check(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> dict:
    """Verify LLM connectivity with a simple ping.

    When api_key / base_url / model are provided, tests those BYOK
    credentials instead of the server defaults.
    """
    effective_model = model or settings.LLM_MODEL_NAME
    try:
        result = await llm_call(
            "Respond with exactly: OK",
            reasoning_effort="low",
            api_key=api_key,
            base_url=base_url,
            model=model,
        )
        return {"status": "ok", "model": effective_model, "response": result.strip()}
    except LLMError as exc:
        return {"status": "error", "model": effective_model, "error": str(exc)}
