# Changelog

Notable public changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Until maintainers cut a versioned release, add entries under `Unreleased`; do not reconstruct release history from guesses.

## [Unreleased]

### Added

- Three bundled official samples that open as complete local runs without an API key, file picker, or model call; local `*.swarm` import remains available.
- A durable Director play loop spanning Gameplay Cards, prediction bets, worldline commitments, and the post-run Causal Archive.
- In-run Agent profiles that distinguish configured stance from observed emotion and show the matching worldline and round.
- Sanitized Snapshot demo path for browsing saved runs without a live LLM.
- Standalone result reports, model profiles, Local Packs, multi-run results, and public sharing artifacts.
- Bilingual screenshots, static showcase, and contributor/security guidance.

### Changed

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

### Fixed

- Prevented stale scenarios, WebSocket events, replay payloads, and automation state from crossing route or replay boundaries.
- Corrected Agent memory and emotion continuity across forks, nested replay, counterfactual replacement, resume, duplicate names, and branch round cutoffs.
- Expanded Snapshot and replay credential redaction, reference remapping, and import recovery without blocking localhost LLM URLs or ordinary natural-language uses of “bearer.”
- Made result-page analysis links follow actual scenario data and capability checks, with retryable availability errors and explicit empty states.
- Hardened BYOK URL validation, provider-error redaction, report retries, runtime-lock loss, and interrupted-run recovery.
- Kept replay, Snapshot, report, and share paths from exposing known credential fields.

[Unreleased]: https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/commits/main
