# Changelog

Notable public changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Until maintainers cut a versioned release, add entries under `Unreleased`; do not reconstruct release history from guesses.

## [Unreleased]

### Added

- A configurable initial world-event Feed with up to 20 untrusted, bounded entries, replayable source accounts, and nine native social actions: `POST`, `COMMENT`, `REACTION`, `FOLLOW`, `MUTE`, `SEARCH`, `TREND`, `REFRESH`, and `IDLE`.
- An owner-scoped Action Ledger panel in Causal Review for native actions, targets, and states, plus a separate evidence-ledger projection for persisted utterances, context observations, derived consequences, and hashed memory references without memory text.
- A bounded `domain_world_v1` whose model-proposed schema is frozen by code validation, whose state changes are deterministically adjudicated from verified durable actions, and whose Replay, Compare, Snapshot, Action Ledger, live state strip, threshold tooltips, IDLE attribution, and result outcomes share the same branch-scoped history.
- A pure domain-threshold opportunity layer that combines N−1 social opportunities with frozen domain preconditions before Agent decisions, without quotas, random actions, or forced rotation.
- A default-off backend verified-memory-promotion core with verified-only eligibility, deterministic idempotency keys, manifest-complete versioned Chroma records, stable hashed recall refs, non-destructive reader rollback, and bounded best-effort purge coverage. It has no capability, REST, or UI activation surface yet.
- Three bundled official samples that open as complete local runs without an API key, file picker, or model call; local `*.swarm` import remains available.
- A durable Director play loop spanning Gameplay Cards, prediction bets, worldline commitments, and the post-run Causal Archive.
- In-run Agent profiles that distinguish configured stance from observed emotion and show the matching worldline and round.
- Agent growth history with scenario, branch, round, and event-type coordinates; “Current” means the event matches the routed scenario and explicitly selected branch segment, while other classifiable events are “Past.”
- Truthful report lifecycle and saved-section tiers, fallback reasons, evidence coordinates, bounded per-section tool traces that survive refresh/reopen for generated, rewritten, and static-fallback output, transient live current-position progress, and model-synthesized historical excerpts labeled with simulation coordinates.
- A Setup completion gate that requires a successful test of the current connection or explicit acceptance of saving it unverified.
- Sanitized Snapshot demo path for browsing saved runs without a live LLM.
- Standalone result reports, model profiles, Local Packs, multi-run results, and public sharing artifacts.
- Clickable Local Pack `demo_snapshots` with catalog-whitelisted, validated direct import and explicit recovery for definite failures or unknown transport outcomes.
- Structured premortem analysis with explicit availability, failure modes, uncertainty, and per-mode evidence chains independent from ordinary report sections.
- Ordered Agent Pack v1 export and atomic import for portable Agent groups, excluding identity IDs, owner data, memories, growth history, conversations, and separately stored credentials while redacting common credential patterns.
- Offline Public Artifact sharing through redacted JSON, single-file HTML, Gallery hash links, and local-file loading; no hosted registry or community publishing is implied.
- Bilingual screenshots, static showcase, and contributor/security guidance.

### Changed

- Source accounts from the initial Feed can be followed or muted; muted sources are excluded from that Agent's subsequent Feed, search, and trend projections. Snapshots preserve and remap the Feed, source accounts, and native actions, while Replay respects effective lineage and cutoff.
- COMMENT, REACTION, FOLLOW, MUTE, SEARCH, TREND, and REFRESH decisions are now gated by a real prior-round opportunity snapshot; domain-bound actions additionally require the same schema, state revision, rule binding, and satisfied threshold.
- Agent turns now carry branch-scoped personal memory, inherited-but-isolated fork state, and bounded previous-round relationship signals.
- Campaign settlement now derives bets, objectives, commitments, archive grades, and rewards from persisted server state and completed terminal leaf worldlines.
- Official sample bundles are reproducibly generated and validated for complete results, replay coordinates, graph references, reports, and Agent state.
- The backend Docker image now bundles `packs/` and `samples/` for container-local use.
- Production text-processing, routing, and transitive utility dependencies were upgraded to patched releases.
- Public documentation now separates project overview, usage, configuration, feature index, security, and promotional snapshots.
- Docker defaults bind frontend `18928` and backend `18927` to loopback.
- Production startup requires `ENV=production`, `SESSION_SECRET`, and `ADMIN_TOKEN`.
- Backend `init_db()` remains the database migration owner.
- Result probabilities use completed terminal leaf worldlines; fork parents are excluded.
- Report likelihood and analytic confidence use completed terminal leaves and evidence counts only; fork parents and signed affect-convergence proxies do not raise analytic confidence.
- Exact-local OpenAI-compatible endpoints can run without a key or `Authorization` header; all other custom and remote endpoints remain key-required.
- BYOK connection testing now keeps provider fan-out explicit: `include_probe` defaults to false, fan-out requires caller-controlled credentials, an exact-local endpoint, or the configured admin token, parallel width is capped at four with at most ten additional provider calls, manual exact-local keyless tests remain available, and automatic launch checks do not fan out.
- Local Pack selection now atomically imports bounded question, language, settings, world context, stakes, and cast preview. Casts do not create persistent Agent identities, but their bounded fields enter the run as untrusted world context; author prompts remain explicitly untrusted reference evidence.
- Agent observations and branch-scoped causal, faction, report, Replay, and compare paths now use one effective root-to-leaf lineage and round cutoff. Eligible pre-fork ancestor rounds are included, while siblings, parent post-fork future data, and post-cutoff data are excluded; self-contained Replay branches stop at their Replay boundary. Legacy causal/faction `stance`, `trust`, and `opposition` fields remain disclosed as affect proxies derived from model-generated `emotion` / `diverge`.
- Pack demo entries now reference only shipped Snapshots that actually exist and provide a clickable direct-import action when Snapshot import is enabled.
- Release publication now verifies the exact CI-passed SHA, builds an immutable backend/frontend pair, promotes both tags only after both images succeed, triggers and verifies pair rollback if either promotion fails, requires an executed signoff for version tags, skips stale edge publication, labels dry-run work as planned, and propagates browser teardown failures.

### Fixed

- Kept legacy runs truthful by reporting missing context receipts as `unavailable` instead of inferring history, and kept memory receipts bounded to hashed references and source-scenario coordinates.
- Kept malformed or stale domain wire data, incomplete round history, missing compare sides, and unavailable world outcomes fail-closed instead of rendering partial values as authoritative; currency minor units are formatted with their ISO exponent rather than as raw storage units.
- Bounded Action Ledger and domain-history pagination, opportunity derivation, verified-memory recall, and reconciliation work while preserving stable ordering and exact receipt binding.
- Preserved portable Snapshot JSON number tokens during counterfactual payload rewriting, including high-precision, exponent, and negative-zero forms, while continuing to reject duplicate keys and non-finite numbers.
- Preserved successful Agent speech when second-pass emotion/stance parsing fails, propagated an explicit unavailable status through live, Replay, Snapshot, import/export, reports, and Pixel Theater, and stopped missing observations from being presented as neutral.
- Prevented stale scenarios, WebSocket events, replay payloads, and automation state from crossing route or replay boundaries.
- Corrected Agent memory and emotion continuity across forks, nested replay, counterfactual replacement, resume, duplicate names, and branch round cutoffs.
- Expanded Snapshot and replay credential redaction, reference remapping, and import recovery without blocking localhost LLM URLs or ordinary natural-language uses of “bearer.”
- Made result-page analysis links follow actual scenario data and capability checks, with retryable availability errors and explicit empty states.
- Hardened BYOK URL validation and report retries; made connection checks and provider probes require an explicit successful terminal signal plus visible text and ignore data after that terminal, kept text-required generation from accepting error envelopes, non-terminal completions, empty visible output, or incomplete streams while retaining completed native-tool/reasoning-only Responses, and scrubbed provider diagnostics and structured-log credentials before output.
- Made required Debate turns and judging, plus initial Ending Room core plans, fail closed after unusable LLM output instead of reporting deterministic anchors as successful model generation; explicitly disabled LLM modes and Ending Room follow-up retain their scoped deterministic or best-effort behavior.
- Enforced signed-principal ownership across an Agent Conversation thread, its Scenario, and its optional AgentIdentity for REST, list, and WebSocket paths; owner mismatches remain concealed and legacy ownerless rows are not adopted.
- Prevented runtime-lock loss and lock-release cleanup during parse, persist, broadcast, and handoff from overwriting sticky terminal states, successful responses, or original scheduling errors; finalized user cancellation during the initial broadcast, emitted post-parse failure events only after an atomic error transition, and retained interrupted-run recovery.
- Kept replay, Snapshot, report, and share paths from exposing known credential fields.
- Prevented an old profile secret, model, rate limit, or capability policy from following a changed endpoint or Debate role profile; detached the old profile on complete provider overrides; rejected partial session overrides before they can mix with a recovered scenario profile; kept unchanged profile mirrors out of result-page session overrides; required complete remote tuples for model edits; and prevented the server default key from being injected into an explicit keyless local request.
- Prevented Local Pack context and cast previews from leaking into a later Quick Start or other non-pack launch.
- Reloaded selected Local Pack detail after same-ID refresh, cleared stale detail/template/actions before switching, and prevented late detail responses from overwriting the new selection.
- Distinguished a definite Local Pack demo import failure from an unknown transport outcome, directing users to History before a retry when the request may already have committed.
- Rejected duplicate Agent, Message, and Graph Node source IDs, plus conflicting reuse of one Round source ID, before the first Snapshot import database write.
- Kept failed, cancelled, skipped, stalled, truncated, and partial report states visible without discarding saved sections or presenting historical excerpts as live interviews.
- Made counterfactual Agent and round selectors fit narrow phone viewports without horizontal overflow.

[Unreleased]: https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/commits/main
