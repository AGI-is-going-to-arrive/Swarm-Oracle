# Web Search / Source Family P0-P5 Status Update

> Updated: 2026-05-13
> Scope: P0 + P1 Web Search / Source Family contract hardening review.
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

- Backend full suite: `2835 passed, 2 skipped`.
- Backend targeted Web Search / Source Family suite: `249 passed`.
- Backend URL scheme filtering narrow rerun: `28 passed`.
- Backend lint: `ruff check .` passed.
- Frontend full vitest: `184 files / 2004 tests passed`.
- Frontend InputView/API targeted suite: `76 passed`.
- Frontend `tsc`, `lint`, and `build`: passed.
- Browser smoke: desktop `1440px`, mobile `375px`, and Chromium / Firefox /
  WebKit headless Source Family checks passed.

## Codex Review Carry-Forward

- W1 → P4a: `provider_capability` currently describes the server default
  provider. If custom override must support a server-default `native` or future
  unsupported provider, expose per-provider capability and make InputView choose
  capability by active provider.
- W2 → P4a: disabled Source Family reason is currently surfaced through
  `title`; add visible or `sr-only` reason text with `aria-describedby` for
  mobile and assistive tech.
- W3 → test hardening: some native-search payload tests should assert that the
  fake client was actually called before checking forbidden keys.
- W4 → test hardening: the `web_search_key_not_passed_to_llm` test should spy
  the scenario background call to prove web-search-only requests do not populate
  LLM override fields.
- W5 → P4a/P4b boundary: ResultView / SourceCategoryCard still need explicit
  UI rendering for `failed / unsupported_provider / fallback_unconstrained /
  search_skipped`; keep native citation UI in P4b, not P4a.

## Readiness

- P2 native LLM search adapter: not ready to execute without separate approval.
  Preconditions still required:
  - freeze native/app-layer state schema,
  - add provider detection/profile layer,
  - define provider fallback and citation storage contract,
  - keep current non-native LLM payload tests as regression gates.
- P3 provider adapters / automatic discovery: not ready. Provider discovery is a
  P2 prerequisite, and xAI native pilot depends on P2 contracts.
- P4a frontend provider-aware rendering: ready to plan independently of P2 once
  this P0/P1 patch is accepted.
  - Include Source Family state cards, disabled reason a11y, active-provider
    capability selection, i18n parity, and mobile/desktop browser smoke.
- P4b native citation/proxy fallback UI: gated on P2 + P3.
- P5 validation:
  - P5a app-layer validation depends on P0/P1 + P4a.
  - P5b native-search validation depends on P2/P3/P4b.

## New Debt

- P1 does not yet implement a full `ProviderSearchOutcome` return object; the
  current patch keeps base search fail-soft and adds `swallow_errors=False` for
  family search. This is acceptable for P1, but P2 should introduce a structured
  outcome before native fallback mapping.
- `provider_capability` is not secret-bearing, but it is a coarse capability
  field. Per-provider capability will be cleaner before custom override grows
  beyond the four app-layer providers.
