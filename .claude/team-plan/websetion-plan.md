# Web Search / Source Family P0-P5 Status Update

> Updated: 2026-05-14
> Scope: P0-P5 Web Search / Source Family status after native-search review/fix.
> Source of truth: current code, current tests, and this status note.
> `.claude/team-plan/websearch-source-family-implementation-plan.md` is now a
> historical implementation plan plus carry-forward checklist, not the primary
> current-truth source.

## P0 / P1 Status

- ✅ DONE — P0 baseline hardening is implemented. Completed: 2026-05-13.
  - `WEB_SEARCH_PROVIDER=native` no longer preflight-passes as an implemented
    provider; it reports warn.
  - LLM payload regression tests lock current non-native-search behavior.
  - Web Search BYOK and LLM BYOK request fields remain separated.
- ✅ DONE — P1 app-layer / Source Family contract hardening is implemented for
  backend contract and homepage submission gate.
  Completed: 2026-05-13.
  - Provider capability registry exists for `tavily / exa / searxng / xai /
    native`.
  - xAI app-layer search now uses `filters.allowed_domains` and URL post-filter.
  - SearXNG domains are normalized before `site:` query construction.
  - Source Family URL filtering now requires `http/https`, handles IDN/punycode,
    and rejects suffix lookalikes.
  - Base search and family search run in independent `try` blocks.
  - `failed` and `unsupported_provider` states can now be produced by the
    backend path, not only parsed.
  - InputView clears selected families when web search or domain-filter support
    closes, and payload families are gated by web search + domain filter support.

## Validation Snapshot

- Backend full suite: `2988 passed, 2 skipped`.
- Backend targeted Web Search / native-search hardening suite: passed in-session before full suite.
- Backend lint: `ruff check .` passed.
- Frontend full vitest: `184 files / 2038 tests passed`.
- Frontend `tsc`, `lint`, and `build`: passed.
- i18n parity: `2506/2506`.
- Browser smoke: `e2e:native-search` passed for Chromium / Firefox / WebKit
  desktop + mobile. WebKit Tab-to-links remains a platform limitation and is
  recorded by the script.
- Legacy release sweep: `e2e:web-search` used real Tavily / Exa / xAI-local /
  SearXNG-local calls; `e2e:new-source-ingestion-live` passed desktop + mobile
  live source ingestion; `e2e:capability-matrix` passed `30/30` gates.

## Codex Review Closure

- W1/W2/W5 are closed by P4a/P4b:
  provider-aware Source Family gating, disabled reasons, new state cards, and
  native citation UI are implemented.
- W3/W4 are covered by current backend/frontend regression tests for
  non-native payloads, LLM/Web Search BYOK separation, and request body shape.
  Keep them as regression intent if these tests are rewritten.

## Readiness

- P2 native/proxy fallback contract: done.
  - `detect_provider()` rejects malformed/non-http URLs and does not native-enable unknown proxy hosts.
  - `_search_with_provider()` now returns structured outcome state, including `429 -> search_skipped`, `4xx -> unsupported_provider`, and `5xx -> failed`.
- P3 xAI native search pilot: done for xAI.
  - `llm_call(native_search_domains=...)` injects tools only for recognized Responses API providers.
  - `native_search_adapters.py` parses top-level citations and annotations, and sanitizes domains/citation URLs.
  - OpenAI adapter has structural/fixture-level support; no live OpenAI provider signoff was included here.
- P4b native citation UI: done.
  - `native_citations` roundtrip through `web_context_json`.
  - `WebSourcesSection` filters malformed text/URL before rendering native links.
- P5 release validation: done.
  - Full backend/frontend/lint/type/build/i18n passed.
  - Named `e2e:native-search` exists and covers Chromium / Firefox / WebKit
    desktop + mobile.
  - Provider fixtures cover xAI + OpenAI success/error/tool-call/citation cases.
  - Native-search `max_tool_calls` is enforced fail-closed; citation cap truncates
    after provider parsing.
  - Legacy release sweep has been rerun with real provider calls.

## New Debt

- OpenAI and other native adapters should stay backlog until official response
  fixtures and live-provider constraints are reviewed.
- SearXNG live E2E depends on a JSON-enabled instance; the checked script handles
  explicit empty/failed states, but local setup still has to provide `json`
  output for full ready-state coverage.
