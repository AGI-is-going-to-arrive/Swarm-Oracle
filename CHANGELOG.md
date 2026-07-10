# Changelog

Notable public changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Until maintainers cut a versioned release, add entries under `Unreleased`; do not reconstruct release history from guesses.

## [Unreleased]

### Added

- Sanitized Snapshot demo path for browsing saved runs without a live LLM.
- Standalone result reports, model profiles, Local Packs, multi-run results, and public sharing artifacts.
- Bilingual screenshots, static showcase, and contributor/security guidance.

### Changed

- Public documentation now separates project overview, usage, configuration, feature index, security, and promotional snapshots.
- Docker defaults bind frontend `18928` and backend `18927` to loopback.
- Production startup requires `ENV=production`, `SESSION_SECRET`, and `ADMIN_TOKEN`.
- Backend `init_db()` remains the database migration owner.
- Result probabilities use completed terminal leaf worldlines; fork parents are excluded.

### Fixed

- Hardened BYOK URL validation, provider-error redaction, report retries, runtime-lock loss, and interrupted-run recovery.
- Kept replay, Snapshot, report, and share paths from exposing known credential fields.

[Unreleased]: https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/commits/main
