# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This repository currently has no reconstructed public version history in this
file; use `Unreleased` until maintainers cut a release tag.

## [Unreleased]

### Added

- Added release-surface README sections for badges, social preview, install
  tiers, Docker/BYOK setup, licensing, and migration ownership.
- Documented the Tier 2 keyless demo path for sanitized snapshot imports,
  including the flagship scenario "如果郑和比哥伦布先发现了美洲大陆".
- Added contribution guidance, issue templates, and an explicit content policy.
- Recent milestone from git history: deep-read result reports were added and
  then enabled by default (`8cba447`, `527344b`).
- Recent milestone from git history: bilingual screenshots, the intro page
  social-card metadata, and the Bilibili intro link were added to the public
  surface (`70bf0d9`, `211f67c`, `939ba6b`).
- Recent milestone from git history: a clean-checkout variant sample matrix was
  tracked for regression coverage (`00b38de`).

### Changed

- Migration owner decision: keep backend `init_db()` as the sole migration
  owner. FastAPI lifespan remains responsible for stamp/upgrade to head.
  Entrypoint Alembic is frozen; image entrypoints and Compose commands must not
  add `alembic upgrade head` unless a future migration-owner decision changes.
- Refined the Local Packs picker into genre segments plus one search channel,
  with auto-selected previews, filter status, clearer focus states, and updated
  public docs / landing copy.
- Documented simulation warmup feedback, interrupted-run recovery, and retry
  behavior across the public README, usage guide, feature catalog, and landing
  page.

### Fixed

- Recent milestone from git history: BYOK retry handling and localized report
  disclaimers were hardened (`7942ed1`, `70a7e9c`, `7b2cede`).
- Recent milestone from git history: deep-read report flow and release-audit
  remediation were hardened (`4c6dfda`, `160f814`).
- Recent milestone from git history: integration timing, roundtable locale
  fixtures, share fixtures, and ending-room fixture lookup were stabilized
  (`a66e85b`, `15d5238`, `7174851`, `50a180c`, `51701c9`).
- Recent milestone from git history: timeline-galaxy node labels were made more
  readable and the Chinese title was aligned to "星系" (`6c55484`).
- Fixed orphaned `simulating` / `narrating` scenarios so startup and polling can
  converge dead runs to a terminal state while live runtime locks are preserved.
