# SwarmOracle Frontend

> 文档类型：active reference
> 当前真值：否。产品范围以仓库根 `README.md` 为准；开发与签收命令以 `llmdoc/guides/development.md` 为准。

React + TypeScript frontend for SwarmOracle.

## Stack

- React 19
- TypeScript 5.9
- Vite 7
- `@vitejs/plugin-legacy` + `terser`
- Zustand
- i18next
- Phaser 3
  current default build/test path aliases bare `phaser` to `experiments/phaser-custom/entry.mjs`, and the curated entry no longer relies on top-level `await`
- Playwright-based E2E scripts

- production builds now also emit a legacy `nomodule` path for Chrome / Edge 79+, Firefox 78+, and Safari / iOS 12+.

## Routes

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `InputView` | Scenario input, progress indicator, quick starts, onboarding, launch confirmation, source families, provider policy, optional organization id, advanced/BYOK accordions, custom Agent attach panel, feature-gated snapshot import |
| `/admin/setup` | `SetupWizardView` | Three-step provider setup, API/base URL entry, and connection test |
| `/sim/:id` / `/sim/replay` | `SimulationView` | Live simulation, Pixel Theater, replay, gameplay cards, structured bets, capture |
| `/result/:id` / `/result/replay` | `ResultView` | Result comparison, Reader/Workbench modes, ledger-style archive, director debrief / campaign summary, share/export, prediction card, feature-gated snapshot export, replay import, resume checkpoint picker, source badges, plus the capability-gated `What's Next` bridge |
| `/replay/:id` | `ReplayView` | Replay trace timeline with pagination, branch filter, and unavailable/probe-error states |
| `/debate/:id` | `DebateArenaView` | Debate live page with phase ribbon, momentum HUD, structured bet entry |
| `/debate/:id/result` / `/debate/replay/result` | `DebateResultView` | Debate result, supporting turns, replay digest, share/import |
| `/history` | `HistoryView` | Scenario history, filtering, deletion |
| `/leaderboard` | `LeaderboardView` | Prediction leaderboard with URL-synced segment filters |
| `/agents` | `AgentLibrary` | Custom/generated Agent library, favorites filter, profile modal, persona import/export |
| `/agents/new` | `AgentWorkshopView` | Custom Agent creation/editing with manual and PDF document tabs |
| `/agents/identities/:id/memories` | `IdentityInspectorView` | Read-only identity memory inspector |
| `/me/journal` | `PersonalJournalView` | Personal prediction journal, resolve flow, and calibration chart |

## Key Frontend Systems

- `themeRegistry.ts`
  single source of truth for Theater / Debate themes and UI asset paths
- `scenarioReplay.ts / simulationReplay.ts / debateReplay.ts`
  replay URL building, token encoding/decoding, import helpers
- `oracleReplay.ts / replayCodec.ts`
  Oracle replay share now falls back to a local read-only link when artifact storage is unavailable and URL-token sharing is too large to ship
  new replay tokens are emitted as portable `plain.*` envelopes with a `4096` character budget; older `gz.*` links are still readable
- `compatUuid.ts`
  replay/director/prediction/scenario-meta local ids no longer assume `crypto.randomUUID()` is available; fallback order is `randomUUID` -> `getRandomValues` -> timestamp/random
- `WorldlineRoundtableView.tsx`
  launch payload now follows the latest `selectionMode` and current UI language instead of reusing stale callback state
- `e2e-ending-room-followup-suite.mjs`
  current followup flow uses API setup for hotseat / all-present / epilogue, submits evidence-card through the real UI drawer, and treats replay/import coverage as fail-closed rather than best-effort
- `useEndingRoomWS.ts`
  Oracle WS reconnect now reuses the latest connect callback instead of holding a stale self-reference
- `scenarioMeta`
  compatibility/cache layer, not cross-device authority
  authority-backed replay snapshots now strip redundant `cards / bets / branchSnapshots`
  localStorage no longer persists authority-backed `branchSnapshots` or runtime-only objective timestamps
- `scenarioAuthority.ts`
  shared authority merge/reset helper for `SimulationView` and `ResultView`
  keeps page-level fallback order in one place instead of duplicating the merge path in each screen
- `replayCodec.ts`
  shared replay token codec used by both `scenarioReplay.ts` and `simulationReplay.ts`
  current write path emits portable `plain.*` envelopes and keeps legacy gzip links readable
- `useDebateWS` / `useSimulationWS`
  live event hydration
  store-side phase / branch status now stay monotonic under out-of-order WS events
- `useAgentConversationWS.ts`
  thread-scoped node conversation WS now connects to `/ws/agent-conversation/{thread_id}`
  first-frame auth / `auth_ok` / `4001` / `4404` handling stays aligned with the shared backend contract
- `PhaserGameLoader` / `useScreenCapture`
  Theater-only loading and split capture runtime
- `predictionBetting.ts`
  structured bet helpers now fall back to the raw tone id when they receive an unknown ending tone label
- `ResumePanel.tsx`
  ResultView-side resume control for `POST /api/scenario/:id/resume`; prefers branch-scoped checkpoints when available, previews `compressed_summary`, falls back to round input when no checkpoint is available, locks after success, and is covered by the dedicated resume smoke script
- `AgentAttachPanel.tsx`
  homepage custom Agent picker; renders persona, domains, and decision bias as React text, caps selection at 5, and keeps loading/error/retry states visible
- `AgentLibrary.tsx / AgentCard.tsx`
  Agent library surface with owned-identity favorites, pressed-button filtering, profile/edit/export actions, and Unicode-safe long-persona truncation
- `AgentWorkshopView.tsx / DocumentUploader.tsx`
  custom Agent form; manual/document tabs use real tab semantics, and the document tab shows bounded PDF upload progress plus structured errors
- `PersonaExportImport.tsx`
  persona import/export UI; import success uses the string `identity_id` returned by the backend and refreshes the library
- `IdentityInspectorView.tsx`
  clears stale header state when identity ids change and keeps empty / infrastructure-error / loaded memory states distinct
- `SetupWizardView.tsx / components/Setup/*`
  local provider setup flow for `/admin/setup`; provider preset selection, API/base URL entry, and `/api/admin/test-llm` connection testing
- `OnboardingGuide.tsx / useOnboardingState.ts`
  first-run homepage carousel; completion is stored locally and storage failure does not block scenario launch
- `components/ui/alert-dialog.tsx`
  shared Radix AlertDialog wrapper for InputView launch confirmation and Simulation cancel confirmation
- `ConversationHistoryPicker.tsx`
  shared scenario conversation history picker for EndingChatModal, RoundtableAgentChat, and NodeConversationSheet
- `QuotaBadge.tsx`
  conversation/replay quota pill backed by `/api/quota/summary`
- `DecisionBiasSlider.tsx`
  five-axis Agent Workshop decision-bias control; the UI maps 0-100 sliders to the backend 0-1 payload
- `PersonalJournalView.tsx / components/Journal/*`
  journal page reads current-user journal/calibration data, resolves entries with visible result/Brier output, and keeps side panels as helper placeholders until Sprint 7 fills them with live data
- `LeaderboardView.tsx`
  segment filters sync to URL params; loading, empty, retry and row animation states are localized and respect reduced-motion settings
- `uiPreferencesStore.ts`
  localStorage-backed ResultView Reader/Workbench preference
- `experiments/phaser-custom/*`
  local curated Phaser entry, isolated spike configs, and repeatable custom-build validation scripts; current default `vite / vitest` also consume this entry, while `phaser3spectorjs-stub.cjs` keeps the build path quiet
- `scripts/lib/frontendPreflight.mjs`
  shared preview/deep-link preflight for graph E2E and `release-signoff`; it checks the SPA shell, entry-module fingerprint, and entry asset reachability before the browser flow starts
- `manualChunks.ts / scripts/lib/performanceBudgetConfig.mjs`
  build chunking keeps React in shared `vendor`, isolates the full G6 runtime in `g6-vendor`, keeps `html2canvas / gif.js` lazy, and leaves the React Flow stack to Rollup auto-splitting so the homepage preload path stays small; the perf budget gate now also covers the generated React Flow runtime / helper chunks instead of only the hand-named bundles
- `orgContext.ts / useOrgContext.ts`
  session-scoped `Organization ID` source of truth used by `InputView` and the API client; blank values remove the header instead of sending an empty `X-Org-Id`
- `NodeConversationSheet.tsx`
  sheet accessibility now relies on `SheetTitle / SheetDescription` instead of manual aria wiring, so Radix no longer warns about missing description metadata; transport / SSE parsing now sit behind a local hook, unmount abort is explicit, multiline `data:` frames no longer get dropped, and local rerenders no longer re-register the streaming bubble. On desktop, when a graph detail panel is open beside the sidecar, detail close / pane click / detail-focused `Escape` now dismiss the detail panel only; the sidecar stays open, and closing detail after switching nodes restores focus to the latest trigger
- `useNodeConversationTransport.ts`
  local transport hook for `NodeConversationSheet`; owns `/start` + `/turn`, AbortController cleanup, and SSE frame parsing
- `GlobalOfflineBanner.tsx`
  the WS-disconnect grace timer now uses an SSR-safe layout-effect fallback; current SPA behavior stays the same, and future SSR will not log the layout-effect warning
- `ResultView.tsx`
  the result surface now includes a ledger-style archive, director debrief, capability-gated `What's Next` bridge with locale-backed causal / replay / compare / workbench / agents / share copy, semantic disabled cards, historical source badges, and locale-backed faction-timeline lead copy
- `resultHelpers.ts`
  result-page pure helpers for bet badges, campaign cache, badge copy, and structured moment highlights used by the archive / debrief handoff
- `DirectorDebriefPanel.tsx`
  result-page director debrief panel that consumes backend score breakdown plus question, worldline, commitment, bet, intervention, moment, goal, and gameplay state to render score reasons, run readout, next-action cards, and newly unlocked badges
- `CausalReviewView.tsx`
  graph fetches now encode `scenarioId / branchId` before building request URLs; the guide / empty-state copy is now backed by the local `CAUSAL_COLORS` dark-surface palette, close/show controls expose a complete disclosure pattern, and long guide key-node labels stay visually compact while preserving the full label in `aria-label` / `title`
- `ArgumentMap.tsx`
  relation labels stay localized for `supports / rebuts / accepted / rejected / unaddressed`
  fail-soft `load_failed` responses stay on the Retry state and keep graph/export hidden
- `ExportPanel.tsx`
  native SVG export rebuild now clips long node labels and prefers full labels over truncated card text
- `ProgressIndicator.tsx`
  5-step journey pill used by InputView and ResultView; invalid step values are clamped
- `ShareArtifact.tsx`
  offscreen 1200x630 PNG export card; it only receives display-safe summary fields, not BYOK or session configuration
- `ShareModal.tsx / ShareablePredictionCard.tsx`
  share modal can download/copy a prediction card PNG when the browser supports it; social-copy requests are aborted on close/unmount, not on unrelated parent rerenders
- `SnapshotExportWizard.tsx / SnapshotImportDialog.tsx`
  feature-gated snapshot ZIP export/import UI; import rejects non-ZIP and files over 50 MB before calling the backend
- `ReACTReasoningPanel.tsx / PersonalityDriftWarning.tsx`
  roundtable analyst tool-chain surface and personality drift warning; the warning only shows risk data and does not block verdict rendering
- `HOPsAnimation.tsx`
  component, CSS, and reduced-motion test exist, but it is not yet imported by a production page; next Sprint 3 handoff starts from that wiring

## Validation

```bash
cd frontend
npm install
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/pages/resultHelpers.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/components/ShareModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/result/DirectorDebriefPanel.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
npm test -- --run src/i18n/config.test.ts src/components/LanguageSwitcher.test.tsx src/lib/replayCodec.test.ts src/lib/debateReplay.test.ts src/components/AgentProfileModal.test.tsx src/lib/legacyCssFallbacks.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run lint
npm run build
npm run perf:budgets:check
npm run assets:provenance:check
```

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 18927
```

```bash
cd frontend
npm run preview -- --host 127.0.0.1 --port 18928
```

```bash
cd frontend
npm run release:signoff -- --headless
```

```bash
cd frontend
node --test scripts/e2e-debate-suite.test.mjs scripts/e2e-frontend-preflight.test.mjs scripts/e2e-ending-room-followup-suite.test.mjs
```

```bash
cd frontend
npm run test:spike:phaser-custom
npm run build:spike:phaser-custom
```

- Current verification contract is maintained in `llmdoc/guides/development.md`.
- Latest Sprint 5-6 frontend verification:
  - `npx tsc --noEmit -p tsconfig.app.json`: pass
  - full vitest: `183 files / 1965 tests / 0 failed`
  - `npm run build`: pass, including performance budgets
  - i18n parity: `en=2354 zh=2354`
  - manual Chromium spot-check covered `/`, `/me/journal`, `/agents`, `/agents/new`, `/agents/identities/{id}/memories`, `/leaderboard`, and `/admin/setup` on desktop plus 375px mobile
- Older Sprint 0-4 rows below are historical artifacts, not the current pass-count source.
- Latest Sprint 0-2 browser matrix:
  - browser matrix: `72/72 PASS` at `output/e2e/sprint0-2-review-20260510-browser/summary.json`
- Latest Sprint 3 scoped verification:
  - `npm test -- --run src/api/client.test.ts src/components/Export/SnapshotExportDialogs.test.tsx src/components/ShareModal.test.tsx src/components/result/HOPsAnimation.test.tsx src/pages/InputView.test.tsx src/i18n/locales.test.ts --reporter=basic`: `6 files / 95 tests passed`
  - `npx tsc --noEmit -p tsconfig.app.json`: pass
  - `npm run lint`: pass
  - `npm run build`: pass, including performance budgets
  - `node --check scripts/e2e-result-share-fixture.mjs`: pass
  - `scripts/e2e-result-share-fixture.mjs full`: desktop/mobile Chromium `13/13` each
- Latest scoped reruns for the bridge / guide copy update:
  - `npm run test -- --run src/pages/CausalReviewView.test.tsx src/i18n/locales.test.ts --reporter=verbose`: `87 passed`
  - `npx tsc --noEmit`: pass
  - fixture-backed Playwright browser recheck for `ResultView` bridge copy + `CausalReviewView` compact guide labels: pass
- Broader recent frontend baseline remains documented in `llmdoc/overview/frontend.md`; this file is not the current source for pass counts.
- The default signoff target remains:
  - Chromium desktop/mobile
  - desktop Firefox / WebKit scoped regression
  - graph preflight before graph smoke
  - plus frontend `test / lint / typecheck / build / perf` gates
- Legacy compatibility is broader than the default signoff:
  - legacy bundle is emitted in production
  - replay/id/dialog/color fallbacks are covered by targeted unit tests
  - BrowserStack / Sauce style real old-browser smoke is still optional, not part of the default contract
- Latest targeted Oracle signoff artifacts:
  - `output/e2e/20260331-oracle-signoff-ending-room/summary.json`
  - `output/e2e/20260331-oracle-signoff-roundtable/summary.json`
- Current Oracle mobile targeted coverage now includes:
  - ending-room `hotseat / all_present / epilogue / crossline gallery / evidence_card` through the UI drawer, plus `artifact readonly / local readonly / local reload restore / import`
  - roundtable `trait_mix / fault_line_first / witness_augmented / hotseat thread switch / artifact/local readonly / reload restore / import`
- Current Oracle targeted QA also rechecked a true single-ending result page in a real browser:
  - no `Start Roundtable`
  - no `Crossline Gallery`
  - `Enter Chamber / One Move Only` both open correctly
  - single-ending chamber readonly replay still imports back into `/sim/:id`
  - English live-room copy no longer mixes raw Chinese hinge text into English sentences
- Current `e2e-ending-room-followup-suite.mjs` full run now writes one `summary.json` per invocation and is already part of the default full signoff contract.
- Current default build shrinks the `phaser` chunk from about `1202.19 kB` to `718.11 kB` (`328.41 kB` → `202.34 kB` gzip).
- Default signoff contract:
  - targeted backend checks
  - backend `/metrics`
  - `tsc`
  - `build`
  - `perf:budgets:check`
  - asset provenance check
  - `phase3_graph_preflight`
  - `corners`
  - `mobile`
  - `cross-browser`
  - phase3 graph default / `zh-CN`
  - phase3 graph desktop Firefox / WebKit
  - `node-conversation-live`
  - `kg-explorer-live`
  - `replay-view-live`
  - `ending-room-followup`
  - `roundtable-full`
  - `debate-full`
- CI now also includes `release-signoff-fixture`, a no-secrets deterministic full-flow signoff lane that runs the main scenario path against an isolated mock LLM on `18318` and forces deterministic Debate adjudication. The real LLM path still follows the configured `LLM_RESPONSES_URL`.
- Latest clean real full signoff artifact: `output/e2e/2026-04-10T14-07-43-466Z-release-signoff/summary.json`.
- That artifact currently records commit `7d643772888e88457fc14b678d837b087678e78b`, `passed` status, and a dirty worktree; always read the artifact's embedded git metadata as the source of truth.
- `corners` share generation and share retry waits now follow the longer frontend social-copy timeout, reducing false negatives under normal LLM latency.
- Treat `summary.json` git metadata as the source of truth for whether a specific checkout has been signed off.
- Current signoff script now re-reads `director_state / gameplay_state` revisions before roundtrip PUT, so `corners` no longer depends on historical samples staying at revision `0`.
- Current custom Phaser spike artifact root: `dist-spikes/phaser-custom/`.

## Asset Notes

- `frontend/public/assets/ASSET_CREDITS.md`
  is the current asset inventory/source reference.
- It is responsible only for asset scope and provenance, not for product scope or signoff status.
- Self-hosted fonts are served from `/fonts` via `src/fonts.css`; `scripts/download-fonts.sh` regenerates the font CSS and woff2 files.
- The latest Sprint 0-2 browser matrix is `72/72 PASS` at `output/e2e/sprint0-2-review-20260510-browser/summary.json`.

## Build

```bash
cd frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 18928
npm run e2e:resume -- full
```
