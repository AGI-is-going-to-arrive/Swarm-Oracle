# Wave 2.0 Truth and Reliability Design

**Status:** Approved on 2026-07-11

**Goal:** Make SwarmOracle truthful and dependable under real OpenAI-compatible provider failures before expanding Agent growth, Living World, and community growth features.

## Scope

Wave 2.0 fixes defects demonstrated by current-main tests or runtime evidence:

1. OpenAI-compatible streaming must not report truncated output as success.
2. Slow responses, rate limits, disconnects, cancellation, and recovery must have deterministic contracts and tests.
3. Agent identity continuity must persist without SQLite self-contention.
4. Stance, faction, and relationship projections must support multilingual signals and remain inside documented bounds.
5. Report generation must expose honest lifecycle progress and must not present branch weights as statistical confidence.
6. Result Agent profiles must retain the observation branch and round that support the displayed state.
7. First-run setup must distinguish a verified connection from an explicit unverified skip.
8. Local packs must import every field that the picker promises to use.
9. The result experience must remain usable at a 390 px viewport.
10. Release evidence and image publication must fail closed instead of claiming unexecuted work passed.

## Non-goals

- No database schema migration.
- No deletion or history rewrite of large assets.
- No restriction of localhost or private-network LLM endpoints.
- No broad event-sourcing rewrite.
- No MiroFish Zep/OASIS or dual-social-platform architecture.
- No dependency version upgrade without a separate risk decision. Reproducibility work may pin the already-tested set only after that decision.
- Agent growth timelines, durable Living World projections, gallery routing, new official showcases, and community contribution workflows remain Wave 2.1/2.2 unless a Wave 2.0 fix needs a small compatibility hook.

## Design principles

### Truth before spectacle

Every displayed state must name its evidence coordinates. A value derived from simulated branches is a scenario projection, not a real-world probability. Historical transcript excerpts are not newly conducted interviews. A dry run is planned work, not passed work.

### Existing storage before migration

Wave 2.0 uses existing scenario, branch, message, checkpoint, graph, faction, relationship, identity, and report records. Fixes must not require a new table or destructive migration.

### Provider behavior as a protocol

The LLM client treats an OpenAI-compatible stream as successful only after a valid terminal signal:

- `[DONE]`, or
- a parsed choice with a non-null `finish_reason`, or
- the equivalent terminal event for a supported Responses endpoint.

EOF before a terminal signal is a retryable provider failure when no irreversible application-side commit has occurred. Both `data:` and `data: ` SSE field forms are accepted. Rate-limit delays honor a valid bounded `Retry-After`; malformed or excessive values fall back to bounded exponential backoff.

Timeouts are explicit runtime settings with current behavior as the compatibility default. Cancellation remains observable between provider reads and retry waits. The test suite uses a protocol-faithful local fake HTTP provider rather than asserting on mocks.

### Transaction ownership for identity continuity

An identity creation transaction must not hold a SQLite writer lock while a second connection attempts to persist its vector profile. Relational identity state commits first; profile persistence then runs outside that write transaction. A profile failure is observable and retryable without rolling back the canonical identity.

### Bounded, explainable social projections

Stance extraction normalizes Unicode text and recognizes a documented multilingual vocabulary. Unknown labels remain neutral. Trust, opposition, alignment, and confidence-like outputs are clamped at their public contract boundary. Tests cover English, Simplified Chinese, mixed labels, empty labels, and repeated extreme evidence.

### Honest report lifecycle

Report status has distinct non-terminal and terminal meanings:

- `generating` or `partial`: generation is still progressing;
- `complete`: all intended sections reached a terminal result;
- `failed`: generation stopped with a recoverable error;
- `cancelled`: the user or runtime stopped work.

The frontend continues polling or listening while status is `partial`. SSE events update chapter progress, tool trace, excerpt/interview activity, uncertainty, and failure state. Historical excerpts are labelled as excerpts. A real supplemental interview, if later enabled, must be an explicit budgeted and cancellable operation.

Single-branch runs do not show a probability interval. Multi-branch weights are labelled as simulated branch distribution and never as statistical confidence or real-world likelihood.

### Evidence-aware Agent profiles

The result page derives the most recent message for the selected Agent within the active analysis branch and round, then passes an observation containing branch, round, emotion, and evidence identity to `AgentProfileSheet`. If no supported observation exists, the component explicitly renders a baseline state instead of silently inventing snapshot provenance.

### Explicit setup trust state

The setup wizard may finish only after either:

1. a successful connection test for the current provider/model/key/base URL tuple, or
2. an explicit user acknowledgement that configuration is being saved unverified.

Changing any connection field invalidates the prior successful result. Localhost remains permitted.

### Complete local-pack import

Applying a pack imports question, settings, context, system prompt, stakes, and Agent casts through one typed payload. Missing optional fields use existing defaults; they are never silently discarded after being previewed.

### Fail-closed release evidence

Release dry-run steps are `planned`/`skipped`, never `passed`. Browser teardown failure propagates to the suite result. Container publication must depend on the required verification gate for the exact commit. Local-only ignored build artifacts stay outside Docker context.

## Component boundaries

- **Backend provider reliability:** LLM client, simulator timeout configuration, and protocol-level tests.
- **Backend truth projections:** identity persistence, stance/faction derivation, report reducer/builder contracts, and focused tests.
- **Frontend truth UX:** report progress, Agent observations, setup verification, pack import, responsive result controls, and component tests.
- **Release integrity:** signoff script, E2E teardown, workflow dependency, Docker context rules, and script/workflow contract tests.

The four boundaries may be investigated in parallel, but implementation is integrated in small TDD commits. No two workers edit the same file concurrently.

## Test strategy

Each behavior follows RED-GREEN-REFACTOR:

1. Add one focused regression test and run it to observe the expected failure.
2. Make the smallest production change that satisfies the contract.
3. Re-run the focused test, then the containing test file/module.
4. Run one backend pytest process at a time.
5. Run frontend focused Vitest tests, then lint, `npx tsc -b`, and the full frontend suite.
6. Finish with the full backend suite, Docker builds, release signoff, and real browser E2E.

The fake LLM provider covers normal Chat Completions and Responses streams, slow chunks, valid and invalid `Retry-After`, HTTP 429/5xx, EOF before terminal signal, connection reset, cancellation, and long request bodies. At least one real configured OpenAI-compatible endpoint is re-tested after deterministic tests pass.

## Rollout and safety

- Keep `main` and `origin/main` traceable through small commits.
- Preserve user and parallel-agent changes; stop on overlapping dirty files.
- Do not touch MiroFish's dirty worktree.
- Do not delete the synthetic remote Zep graph without explicit confirmation.
- Treat dependency locking/version alignment and any future schema change as separate approval gates.
- If a fix changes a public response shape, preserve compatibility or stop for explicit API approval.

## Acceptance criteria

Wave 2.0 is complete only when:

- every confirmed defect has a regression test that was observed failing first;
- focused and full test gates pass;
- controlled provider fault tests and a real provider scenario pass;
- Docker and release evidence are truthful and reproducible within the approved dependency scope;
- desktop and 390 px browser E2E pass without result-page horizontal overflow;
- an independent final review reports no Critical or Important findings;
- user-facing English and Chinese documentation is synchronized after implementation approval, while `llmdoc` is updated only through the separately confirmed recorder option.
