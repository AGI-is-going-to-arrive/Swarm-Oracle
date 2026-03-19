# SwarmOracle Frontend

React + TypeScript frontend for the SwarmOracle "What-If" prediction engine.

## Stack

- **React 19** + **TypeScript 5.9**
- **Vite 7** — build tooling
- **React Flow** (@xyflow/react) — branch tree visualization
- **Zustand** — state management
- **GSAP** — animations
- **i18next** — internationalization (EN / ZH)
- **Phaser 3** — GBC-style pixel art game engine (Pixel Theater)

## 3.0 Phase B: Visual Upgrade

- **GBC Palette** — 16 CSS custom properties (`--gbc-*`) for unified retro color scheme
- **Asset Regeneration** — 18 runtime sprites + 33 semantic scene backgrounds + 6 ending images (GBC pixel art)
- **TitleScene** — Typewriter subtitle, click-to-skip, shimmer scanline animation
- **WorldScene** — Mouse parallax, typewriter bubbles, vertical wipe transitions

## Quick Start

```bash
npm install
npm run dev     # → http://localhost:18928
```

## Pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `InputView` | Scenario input, daily challenge, quick starts; the landing route now reads a lightweight gameplay-profile summary helper for profile labels / hooks / badges instead of importing the deeper gameplay strategy table at runtime |
| `/debate/:id` | `DebateArenaView` | Debate Arena live page with fixed five-phase structure, readable momentum HUD, structured bets, screenshot hooks, mobile bottom CTA, UI language that syncs to `debate.language`, a lightweight counterplay layer that can prefill or directly submit a low-confidence hedge during the open betting window, plus live room-state cards / room map / stage map that now consume backend `phase_insights` directly |
| `/debate/:id/result` / `/debate/replay/result` | `DebateResultView` | Debate verdict page with score breakdown, replay digest, structured `judge_rationale`, key `supporting_turns`, prediction settlement, dedicated share modal, explicit counterplay result panel, and UI language that syncs to the result payload language; the result surface now also shows signal cards and a phase map backed by the same server `phase_insights` payload as the live room; replay route can hydrate from a token without fetching the live API, shows the current `adjudication_mode`, and can import the replay as a local debate run |
| `/sim/:id` / `/sim/replay` | `SimulationView` | Live simulation with Classic View / Pixel Theater, semantic scene selection, replay, gameplay cards, prediction entry, screenshot/GIF export, plus a compact director layer for `director goals / risk-resource tracks / worldline commitment`; goals and commitment now read/write backend `director_state` first, while local `scenarioMeta` remains a compatibility/cache layer; this session also removed the old “mirror backend authority back into localStorage” path, so the page now keeps the authority merge in memory and only uses local meta for compatibility / replay payloads; `/sim/replay` is a read-only replay surface that disables WS, prediction, intervention, and gameplay-card writes, but still keeps replay controls, capture, and import-to-local-run |
| `/result/:id` / `/result/replay` | `ResultView` | Multi-ending comparison, archive, campaign progress, prediction results, share/export; now also reads backend `director_state` first and still falls back to backend campaign scenario summary when local archive metadata is missing, showing objective completion, commitment outcome, and final system-track state; this session also removed the old local-`scenarioMeta` authority backfill and stopped writing derived archive/objective patches back into localStorage, so the result page now keeps that derivation in memory and uses local meta only as compatibility / replay input; `/result/replay` can hydrate from a backend short `share id` or a token fallback, skips `finalizeCampaign()`, and can import the replay as a local scenario run |
| `/history` | `HistoryView` | Scenario history, filtering, pagination, safe deletion |
| `/leaderboard` | `LeaderboardView` | Global prediction leaderboard |

## Key Components

- **BranchTree** — React Flow graph showing scenario branches
- **ClassicBranchTree** — classic-only wrapper that lazy-loads the branch tree stack
- **BranchNode** — Custom node with probability bar + intervene button
- **AgentPanel** — Agent roster with pixel avatars, emotion dots, speech bubbles
- **InterventionModal** — Butterfly Effect user intervention input
- **GameplayCardsModal** — 14 domain-driven “director cards” that inject high-priority branch events; beyond the original escalation cards, the modal now includes `Audit Reckoning / Intel Blowback / Mandate Snapback / Ceasefire Committee` as counterplay cards, and also shows a profile-specific three-step signature arc plus lightweight `risk / resource` tracks
- **DebateStageRibbon / DebateMomentumBar / DebateScoreCard** — Debate Arena stage, score, and side-state UI; the momentum HUD is now simplified for readability instead of relying on the old transparent frame overlay
- **DebateBetModal / DebateShareModal** — Debate-only structured bet and share surfaces, now with modal-level automation state for E2E; the bet modal supports counterplay presets, and the share copy now carries the counterplay summary, final hit/miss result, plus 1-2 key supporting-turn excerpts from the verdict
- **themeRegistry.ts** — single source of truth for the 33 Theater / Debate themes, their keyword routing, profile mapping, gameplay frame / badge paths, and Debate-specific UI asset paths
- **Director Campaign** — ResultView finalizes campaign progress against the backend and now also reads `/api/campaign/scenario/:id/summary` to recover archive-grade / resonance / most-used-card / bet result / daily-challenge fields when local storage is incomplete; InputView merges backend `daily-status` with local cache so the current daily challenge is not judged only by `localStorage`
- **gameplayProfileSummary.ts / gameplayProfileCatalog.ts** — the landing route now reads only lightweight profile copy (`label / hooks / badge`) while the deeper gameplay contract / strategy helpers stay behind later routes; `gameplayCards.ts` still reuses the shared catalog so labels stay consistent
- **Director Layer** — Theater goals and worldline commitment now persist through backend `Scenario.director_state_json`; `scenarioMeta` still caches points / cooldowns / card usage / bets / archive details locally so old runs and local-only gameplay state do not break, but it is no longer mirrored from backend authority on every page load, and ResultView no longer writes derived archive / objective patches back into localStorage
- **PredictionModal** — structured bets for branch winner / ending tone / theme resonance; this session it stopped reading local `scenarioMeta` directly for the committed branch and now prefers the parent page’s current merged meta
- **Debate Arena** — separate Track D mode using its own backend domain and frontend store/hook (`debateStore`, `useDebateWS`) rather than extending the main scenario state; live snapshot / result payload / WS now all expose explicit `counterplay` data, while local helper state remains only as a fallback; `debate_verdict` now also carries `phase_insights`, so the live room can land the final stage read without waiting for a fresh result fetch
- **Replay Helpers** — `scenarioReplay.ts / simulationReplay.ts / debateReplay.ts` now back the replay share flow; main mode prefers backend short `share id` via `ReplayArtifact`, token remains the fallback path, and replay pages can be imported into real local runs
- **PhaserGameLoader / useScreenCapture** — Theater engine and capture stack stay behind the Theater/capture path: `SimulationView` now only preloads Phaser after the user actually enters Theater, `PhaserGameLoader` itself is also lazy-loaded at the Theater boundary, Phaser preload now skips hidden / reduced-data / `saveData` / `2g` conditions, `BootScene` only preloads the first-view theme plus runtime sprites, later `scene_change` backgrounds and ending backdrops are loaded on demand, and `useScreenCapture` now keeps screenshot and GIF runtime paths split so a screenshot-only action no longer pulls the GIF renderer by default
- **TimelineBar** — compact replay timeline with fork/card/bet/result markers
- **ResultView** — Ending cards, probability bars, expandable stories, insights
- **ShareModal** — Social media copy generation (小红书/微博/知乎/Reddit/X); the envelope now carries replay permalink context when available
- **LanguageSwitcher** — Global language toggle (EN/ZH), fixed bottom-right

## Design

Follows the [Impeccable](https://impeccable.style) editorial design system. Supports dark-first theme with CSS custom properties.

## Testing

```bash
npm install
npm test          # Vitest + Testing Library
# release signoff expects a reachable backend/frontend pair at the target URL
npm run release:signoff -- --headless
npm run e2e:matrix
npm run e2e:variants
npm run e2e:corners
npm run e2e:full
npm run e2e:debate
npm run e2e:debate:desktop
npm run e2e:debate:mobile
npm run e2e:debate:full
```

- Historical full frontend baseline recorded in repo docs: **179 passed**
- `npm run release:signoff -- --headless` now runs:
  - targeted backend `pytest` (now including `tests/test_metrics.py`)
  - backend `/metrics` reachability check (expects Prometheus text output)
  - `npx tsc --noEmit -p tsconfig.app.json`
  - `npm run build`
  - `npm run assets:provenance:check`
  - `scripts/e2e-suite.mjs corners`
  - `scripts/e2e-suite.mjs cross-browser`
  - `scripts/e2e-debate-suite.mjs full`
- `release:signoff` now writes a rolling `summary.json` into the chosen output root, so partial progress and failures remain inspectable instead of living only in terminal logs
- Optional flags:
  - `--include-safari --scenario-id <id>`
  - `--skip-backend-checks`
  - `--skip-assets-check`
  - `--backend-python /absolute/path/to/python`
  - `--backend-url http://127.0.0.1:18927`
- Optional timeout env vars for slower Debate runs:
  - `SWARM_DEBATE_RESULT_TIMEOUT_MS`
  - `SWARM_DEBATE_STALL_TIMEOUT_MS`
  - `SWARM_DEBATE_RESULT_CTA_TIMEOUT_MS`
- Repo CI now includes a minimal guardrail workflow at `.github/workflows/ci.yml`:
  - backend targeted `pytest` (including `test_metrics.py`)
  - frontend `assets:provenance:check / build / targeted vitest`
  - `release-signoff-dry-run` to validate the signoff orchestration and `summary.json` contract
  - deterministic `debate-signoff-smoke` (`DEBATE_USE_LLM=false`, local backend/frontend, `e2e-debate-suite.mjs full`, artifact upload)
- Repo now also has `.github/workflows/release-signoff.yml`:
  - nightly + manual full signoff
  - secrets preflight for `LLM_RESPONSES_URL / LLM_API_KEY`
  - local backend/frontend boot + Playwright browser install + `npm run release:signoff -- --headless`
  - artifact upload for `summary.json` and backend/frontend logs
- This doc-sync pass re-ran:
  - `npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx` → **49 passed**
  - `npm run build` → passed
  - `npm run assets:provenance:check` → passed
- This session additionally re-ran the Debate counterplay path:
  - `npm test -- --run src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/hooks/useDebateWS.test.tsx src/components/DebateShareModal.test.tsx src/lib/debateShare.test.ts src/lib/debateCounterplay.test.ts` → **13 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
  - Debate desktop live/result/share smoke → `frontend/output/e2e/20260318-codex-audit-debate-live-counterplay-desktop/result.json`
- This session also re-ran replay share/import coverage:
  - `npm test -- --run src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx` → **21 passed**
  - `npm test -- --run src/pages/DebateResultView.test.tsx` → **3 passed**
  - `npm test -- --run src/lib/scenarioReplay.test.ts src/lib/simulationReplay.test.ts src/lib/debateReplay.test.ts` → **6 passed**
  - `npm test -- --run src/components/ShareModal.test.tsx src/components/DebateShareModal.test.tsx` → **2 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
- This session also re-ran the Debate judge-rationale / supporting-turn path:
  - `npm test -- --run src/lib/debateShare.test.ts src/components/DebateShareModal.test.tsx src/pages/DebateResultView.test.tsx` → **5 passed**
  - `npm test -- --run src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/lib/debateShare.test.ts src/lib/debateCounterplay.test.ts src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx` → **16 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
  - Debate desktop supporting-turn smoke → `frontend/output/e2e/20260319-debate-supporting-turns-desktop/result.json`
  - Debate full supporting-turn smoke → `frontend/output/e2e/20260319-debate-supporting-turns-full/result.json`
- This session also re-ran the Debate phase-insights / verdict-WS / counterplay-to-stage-commentary path:
  - `python -m pytest tests/test_debate_service.py tests/test_debate_api.py -q` → **12 passed**
  - `npm test -- --run src/stores/debateStore.test.ts src/hooks/useDebateWS.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx` → **16 passed**
  - `npm run build` → passed
  - Debate full black-box run → `frontend/output/e2e/20260319-debate-depth-full-v4/result.json`
  - The black-box result now explicitly records:
    - `live.overviewCardCount = 3`
    - `live.roomMapCount = 3`
    - `live.stageSummaryCount = 5`
    - `live.serverPhaseInsightCount = 5`
    - `result.signalCardCount = 4`
    - `result.phaseSummaryCount = 5`
    - `result.serverPhaseInsightCount = 5`
- This session also re-ran the director-state backendization path:
  - `npm test -- --run src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/lib/scenarioMeta.test.ts` → **21 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
  - Main-mode corners with `director_state_roundtrip` → `frontend/output/e2e/20260319-post-director-state-corners-v2/result.json`
  - Firefox / WebKit cross-browser smoke → `frontend/output/e2e/20260319-director-state-cross-browser/result.json`
  - Safari smoke → `frontend/output/e2e/20260319-director-state-safari/result.json`
- This session also re-ran the Theater load-gating + release-candidate path:
  - `npm test -- --run src/lib/scenarioGameplayState.test.ts src/components/PredictionModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx` → **43 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
  - Release artifacts:
    - `frontend/output/e2e/20260319-release-corners/`
    - `frontend/output/e2e/20260319-release-cross-browser/`
    - `frontend/output/e2e/20260319-release-debate-full/`
  - Current build posture:
    - Phaser still ships as a standalone engine chunk
    - it is now preloaded only after the user actually enters Theater
    - `html2canvas / gif.js / gif.worker` remain on-demand capture dependencies instead of default-route baggage
- This session also re-ran the bundle / `scenarioMeta` compatibility pass:
  - `npm test -- --run src/hooks/useScreenCapture.test.ts src/components/PredictionModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx` → **32 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
  - `npm run e2e:corners -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260319-post-bundle-scenariometa-corners --headless` → passed
  - `npm run e2e:cross-browser -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260319-post-bundle-scenariometa-cross-browser --headless` → passed
  - `npm run e2e:debate:full -- --url http://127.0.0.1:18928 --output-dir output/e2e/20260319-post-bundle-scenariometa-debate-full --headless` → passed
  - Current build posture in this pass:
    - `PhaserGameLoader` now ships as its own Theater-only loader chunk
    - `useScreenCapture` is now a light shell, while DOM capture / GIF logic lives in `screenCaptureRuntime`
- This session also added and exercised the release-signoff entry:
  - `npm run release:signoff -- --headless` → passed
    - artifacts: `frontend/output/e2e/2026-03-19T15-20-32-479Z-release-signoff/`
  - `npm run release:signoff -- --headless --include-safari --scenario-id 72ae364d-3ea1-4959-939c-8fe1dbeca1c9` → passed
    - artifacts: `frontend/output/e2e/2026-03-19T15-25-24-398Z-release-signoff/`
- This session also re-ran the landing-route bundle trim:
  - `npm test -- --run src/pages/InputView.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx` → **24 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
  - `npm run release:signoff -- --headless` → passed
    - artifacts: `frontend/output/e2e/2026-03-19T15-35-24-820Z-release-signoff/`
  - Current build posture in this pass:
    - `InputView` no longer chain-imports the deeper gameplay strategy table at runtime
    - deeper gameplay logic remains in later async chunks
    - `phaser` is still the largest remaining bundle target
- This session also tightened the remaining `scenarioMeta` boundary on the result route:
  - `ResultView` now keeps derived archive / objective patches in memory instead of writing them back into localStorage
  - `scenarioMeta.test.ts / ResultView.test.tsx` → **17 passed**
  - `npm run build` → passed
- This session also re-ran the upgraded signoff entry:
  - targeted backend `pytest` → **81 passed**
  - targeted frontend `vitest` (`scenarioMeta / archiveSummary / gameplayCards / gameplayContract / SimulationView / ResultView / GameplayCardsModal / DebateArenaView / DebateResultView / DebateBetModal / DebateShareModal / useDebateWS / locales`) → **79 passed**
  - `npm run build` → passed
  - `npm run assets:provenance:check` → passed
  - `npm run release:signoff -- --headless` → passed
    - artifacts: `frontend/output/e2e/2026-03-19T16-10-45-581Z-release-signoff/`
  - `npm run release:signoff -- --headless --include-safari --scenario-id 72ae364d-3ea1-4959-939c-8fe1dbeca1c9` → passed
    - artifacts: `frontend/output/e2e/2026-03-19T16-16-01-513Z-release-signoff/`
- This session also updated the release-signoff infrastructure:
  - targeted backend `pytest` → **81 passed**
  - targeted frontend `vitest` (`scenarioMeta / archiveSummary / gameplayCards / gameplayContract / SimulationView / ResultView / GameplayCardsModal / DebateArenaView / DebateResultView / DebateBetModal / DebateShareModal / useDebateWS / locales`) → **79 passed**
  - `node scripts/e2e-debate-suite.mjs desktop --url http://127.0.0.1:18928 --output-dir output/e2e/post-fix-debate-desktop --headless` → passed
    - artifacts: `frontend/output/e2e/post-fix-debate-desktop/`
  - `node scripts/release-signoff.mjs --dry-run --output-root output/e2e/release-signoff-summary-dry-run` → `summary.json` written successfully
  - `npm run release:signoff -- --headless --output-root output/e2e/post-fix-release-signoff` was restarted and confirmed to update `summary.json` step by step; this pass was not waited through to completion, so it should not be recorded as a full green signoff
- This session also closed the metrics + signoff gap:
  - targeted backend `pytest` (`test_campaign_api / test_campaign_service / test_debate_api / test_debate_service / test_config / test_predictions / test_card_events / test_gameplay_contract_sync / test_metrics`) → **82 passed**
  - live backend `/metrics` → `200 text/plain`
  - `node scripts/release-signoff.mjs --dry-run --headless --output-root output/e2e/current-audit-signoff-dry-run-v4` → passed
    - artifacts: `frontend/output/e2e/current-audit-signoff-dry-run-v4/summary.json`
  - `node scripts/release-signoff.mjs --headless --output-root output/e2e/current-audit-release-signoff-v2` → passed
    - artifacts: `frontend/output/e2e/current-audit-release-signoff-v2/summary.json`
- This session also re-ran the Theater first-enter / capture split path:
  - `npm test -- --run src/game/sceneAssetPlan.test.ts src/game/PhaserGameLoader.test.ts src/hooks/useScreenCapture.test.ts src/game/scenes/EndingScene.test.ts src/game/scenes/WorldScene.test.ts src/pages/SimulationView.test.tsx` → **59 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → passed
  - `npm run build` → passed
  - `node scripts/release-signoff.mjs --dry-run --headless --output-root output/e2e/current-post-change-dry-run` → passed
    - artifacts: `frontend/output/e2e/current-post-change-dry-run/summary.json`
  - Current build posture in this pass:
    - `BootScene` now preloads only the first-view Theater theme plus runtime sprites
    - later `scene_change` backgrounds and ending backdrops are loaded on demand
    - `capture-vendor` is now split into `capture-html / capture-gif / screenCaptureGifRuntime`
- Fixed matrix sample set: **15 scenarios** for the main pool, plus **3 variant scenarios** in `output/e2e/sample_matrix_variants.json`
- Latest Track C artifact bundles:
  - `frontend/output/e2e/20260317-track-c/matrix/`
  - `frontend/output/e2e/20260317-track-c/corners/`
  - `frontend/output/e2e/20260317-track-c/mobile/`
  - `frontend/output/e2e/20260317-track-c/variants/`
- Latest full baseline artifact: `frontend/output/e2e/20260318-post-director-goals-full/result.json`
- ResultView backend-summary smoke artifact: `frontend/output/e2e/20260318-result-backend-summary-smoke-v2/result-final.json`
- `scripts/e2e-suite.mjs` now writes `browser-launch.json` into the chosen output directory so you can see which browser launch profile actually ran
- `scripts/e2e-debate-suite.mjs` now provides a Debate-only baseline for `live -> bet -> result -> share`; the latest successful artifact bundles are `frontend/output/e2e/20260318-post-director-goals-debate-full/` and `frontend/output/e2e/20260319-debate-supporting-turns-full/`
- Debate result automation now explicitly requires `supporting_turns.length >= 1`; the final `result.json` also records `supportingTurns` and `supportingTurnCount`
- Because the richer Debate prompts take longer on real LLM runs, Debate E2E now uses progress-aware waits for `result_ready` and the result CTA, and it can be tuned with `SWARM_DEBATE_RESULT_TIMEOUT_MS / SWARM_DEBATE_STALL_TIMEOUT_MS / SWARM_DEBATE_RESULT_CTA_TIMEOUT_MS`
- `scripts/e2e-suite.mjs` and `scripts/e2e-automation.mjs` now normalize `frontend/output/...` arguments to the real frontend root, preventing future runs from writing nested `frontend/frontend/output/...` paths
- Matrix runs now also recreate samples when an old `scenario_id` resolves to a stale `scene_theme`, not only when the scenario is missing
- `capture-modes` now records `predictionModalBytes` and `gameplayModalBytes`, and replay recovery waits for `theater_ready === true` before marking the flow healthy again
- `SimulationView` automation output now includes `page.controls.capture_result_kind`, so black-box checks can distinguish a real GIF from `gif_fallback_png`
- `SimulationView` automation output now also includes `page.director.objectives / system_tracks / commitment`
- `ResultView` automation output now includes `archive_summary.profile_id / profile_resonance / completed_daily_challenge` and additionally `objective_completed_count / objective_total_count / commitment_outcome / risk_value / resource_value`
- `scripts/e2e-suite.mjs corners` now also includes `director_state_roundtrip`, so the result JSON directly captures `simulationDirector / resultArchiveSummary / directorGoalsCard / commitmentCard`
- Latest cross-browser findings from real runs:
  - Firefox: director-state live/result readback passed
  - WebKit: director-state readback passed; the previous ResultView archive-hero white block is fixed
  - Safari: director-state readback passed; if a browser translation plugin is enabled, it can still pollute screenshots even though the app itself is rendering correctly
- If Playwright screenshot capture stalls on font loading, the suite falls back to Chromium CDP capture instead of aborting the whole run
- Latest Docker runtime smoke: `docker compose up --build -d` succeeded, and a proxied `POST /api/scenario` request created a Theater scenario that reached `status = done`
- Repo-root progress heartbeat helper: `node scripts/codex-heartbeat.mjs --interval 30 --label implement-tail --log-file /tmp/upgrade-test-heartbeat.log`
  - It summarizes `git status`, the latest `frontend/output/e2e/**/result.json`, and the newest `progress.md` section in one line-oriented snapshot
- Latest `develop-web-game` evidence for the new director layer:
  - `frontend/output/web-game/20260318-director-layer-smoke-v2/state-0.json`
  - `frontend/output/web-game/20260318-director-layer-smoke-v2/shot-0.png`
- Language behavior:
  - UI labels follow the EN/ZH switcher
  - Debate pages are the exception: once a Debate payload arrives, the page switches UI language to match `debate.language`
  - agent replies and narration follow detected input language
  - daily challenge prompts now also respect the current EN/ZH UI language instead of leaking the Chinese source text into the English card

## Asset Generation

- Debate Arena and gameplay art generation helper:
  - `npm run generate:ui-assets -- --preset <preset> [--preset ...] --model gemini-3.1-flash-image-preview`
- UI / Theater asset generation helper: `frontend/scripts/generate-ui-assets.mjs`
- Legacy provenance helper scripts:
  - `npm run assets:provenance:backfill`
  - `npm run assets:provenance:check`
- The script tries `aiplatform.googleapis.com` first and falls back to `generativelanguage.googleapis.com` when the former rejects API-key-only calls
- Newly added assets in this pass include:
  - `public/assets/scenes/debate_arena_civic.png`
  - `public/assets/scenes/debate_arena_judicial.png`
  - `public/assets/scenes/debate_arena_forum.png`
  - `public/assets/ui/generated/debate_stage_banner.png`
  - `public/assets/ui/generated/debate_verdict_panel.png`
  - `public/assets/ui/generated/debate_score_meter.png`
  - `public/assets/ui/generated/debate_badge_proposition.png`
  - `public/assets/ui/generated/debate_badge_opposition.png`
  - `public/assets/ui/generated/debate_badge_judge.png`
  - `public/assets/ui/generated/debate_quote_frame.png`
  - `public/assets/ui/generated/gameplay_card_frame_generic.png`
  - `public/assets/scenes/law_court_variant.png`
  - `public/assets/scenes/faith_temple_variant.png`
  - `public/assets/scenes/switchboard_forum_variant.png`
- `frontend/public/assets/ui/generated + frontend/public/assets/scenes` now have sidecar provenance for all **62/62** PNG files
- Newly generated assets still keep the original `preset / model / provider / source / source_url / generated_at / output / prompt` record
- Older legacy assets were backfilled from an on-repo audit; those `.meta.json` files may legitimately use `unknown` / `null` fields together with `provenance_status` and `backfilled_at` instead of pretending the original generation metadata survived

## Build

```bash
npm run build   # outputs to dist/
```
