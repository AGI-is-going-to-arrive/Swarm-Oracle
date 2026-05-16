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
| `/` | `InputView` | Scenario input, progress indicator, quick starts, onboarding, launch confirmation, source families, search-depth selector, provider policy, optional organization id, advanced/BYOK accordions, preflight-aware submit loading, custom Agent attach panel, feature-gated snapshot import |
| `/admin/setup` | `SetupWizardView` | Three-step provider setup, API/base URL entry, and connection test |
| `/sim/:id` / `/sim/replay` | `SimulationView` | Live simulation, Pixel Theater, replay, gameplay cards, structured bets, capture |
| `/result/:id` / `/result/replay` | `ResultView` | Result comparison, Result Quality verdict panel when available, Reader/Workbench modes, ledger-style archive, director debrief / campaign summary, share/export, prediction card, feature-gated snapshot export, replay import, rewrite-one-line counterfactuals, resume checkpoint picker, resumed-branch source badges/links, plus the capability-gated `What's Next` bridge |
| `/workbench/:id` | `WorkbenchView` | Dedicated graph workbench for causal / split / KG layouts; preserves the analysis branch query and links back to the scenario result page |
| `/replay/:id` | `ReplayView` | Replay trace timeline with pagination, branch filter, and unavailable/probe-error states |
| `/debate/:id` | `DebateArenaView` | Debate live page with phase ribbon, momentum HUD, structured bet entry |
| `/debate/:id/result` / `/debate/replay/result` | `DebateResultView` | Debate result, supporting turns, replay digest, share/import |
| `/history` | `HistoryView` | Scenario history, filtering, deletion |
| `/leaderboard` | `LeaderboardView` | Prediction leaderboard with URL-synced segment filters |
| `/agents` | `AgentLibrary` | Custom/generated Agent library, favorites filter, profile modal, Agent backup export, and create-from-backup entry |
| `/agents/new` | `AgentWorkshopView` | Custom Agent creation/editing with manual and PDF document tabs; backup-based Agent creation is available when the capability is enabled, and edit mode can export the current identity |
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
  Theater-only loading and split capture runtime; TitleScene / EndingScene runtime copy now reads `game.*` locale keys instead of branching on `i18next.language`
- `AgentPanel.tsx`
  live agent roster and transcript panel; filtering one agent groups that agent's messages by worldline, sorts each group by round, and uses branch titles/descriptions for the group header
- `predictionBetting.ts`
  structured bet helpers now fall back to the raw tone id when they receive an unknown ending tone label
- `ResumePanel.tsx`
  ResultView-side resume control for `POST /api/scenario/:id/resume`; waits for a source branch before loading checkpoints, prefers branch-scoped checkpoints when available, turns structured `compressed_summary` data into a readable preview, falls back to round input when no checkpoint is available or checkpoint loading fails, locks after success, and is covered by the dedicated resume smoke script
- `CounterfactualPanel.tsx`
  ResultView-side counterfactual control for `POST /api/scenario/:id/counterfactual`; edits one persisted source message, restricts rounds and agents to the selected source branch, sends the original source message for backend matching, and shows status feedback when the source branch/round is selected
- `AgentAttachPanel.tsx`
  homepage custom Agent picker; renders persona, domains, and decision bias as React text, caps selection at 5, and keeps loading/error/retry states visible
- `AgentLibrary.tsx / AgentCard.tsx`
  Agent library surface with owned-identity favorites, pressed-button filtering, profile/edit/export actions, Unicode-safe long-persona truncation, a localized back action, and localized retry states for capability/favorite failures
- `AgentWorkshopView.tsx / DocumentUploader.tsx`
  custom Agent form; manual/document tabs use real tab semantics, the document tab shows bounded PDF upload progress, partial success, 0-agent and structured error states, and the header reuses `PersonaExportMenu` for capability-gated Agent backup tools
- `PersonaExportImport.tsx`
  Agent backup export / create-from-backup primitives; create-from-backup success uses the string `identity_id` returned by the backend, refreshes the library, and does not show raw backend errors to users. The JSON paste path is kept behind an advanced disclosure. `AgentWorkshop/PersonaExportMenu.tsx` now uses the same ExportButton / ImportDialog surface as Agent Library
- `IdentityInspectorView.tsx`
  clears stale header state when identity ids change, ignores late memory responses, and keeps empty / infrastructure-error / loaded memory states distinct
- `EducationTemplatePicker.tsx`
  feature-gated template dialog with category/difficulty filters, focus trap, empty/retry states, localized load errors, and request-id/cancel guards so late retry responses do not overwrite the current open state
- `QuickStartCards.tsx`
  homepage quick-start presets keep only structural metadata in TypeScript; question and subtitle copy come from `quickstart.*` locale keys
- `SetupWizardView.tsx / components/Setup/*`
  local provider setup flow for `/admin/setup`; provider preset selection, API/base URL entry, and `/api/admin/test-llm` connection testing
- `OnboardingGuide.tsx / useOnboardingState.ts`
  first-run homepage carousel; completion is stored locally and storage failure does not block scenario launch
- `components/ui/alert-dialog.tsx`
  shared Radix AlertDialog wrapper for InputView launch confirmation and Simulation cancel confirmation; the cancel dialog exposes busy state with `aria-busy` and a live status line while the cancel request is in flight
- `ConversationHistoryPicker.tsx`
  shared scenario conversation history picker for EndingChatModal, RoundtableAgentChat, and NodeConversationSheet
- `QuotaBadge.tsx`
  conversation/replay quota pill backed by `/api/quota/summary`
- `DecisionBiasSlider.tsx`
  five-axis Agent Workshop decision-bias control; the UI maps 0-100 sliders to the backend 0-1 payload
- `PersonalJournalView.tsx / components/Journal/*`
  journal page reads current-user journal/calibration data, resolves entries with visible result/Brier output, ignores stale refreshes, and keeps side panels as helper placeholders until Sprint 7 fills them with live data
- `LeaderboardView.tsx`
  segment filters sync to URL params; loading, empty, retry, back action, and row animation states are localized, ignore stale responses, and respect reduced-motion settings
- `uiPreferencesStore.ts`
  localStorage-backed ResultView Reader/Workbench preference
- `WorkbenchView.tsx`
  dedicated graph workbench shell; causal, split, and KG tabs keep separate capability gates, preserve the selected branch from the URL, and expose a stable back link to `/result/:id`
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
  the result surface now includes a capability-gated `ResultVerdictPanel`, prediction subtitle switching, branch-level question answers in `EndingCardsGrid`, a ledger-style archive, director debrief, capability-gated `What's Next` bridge with locale-backed causal / replay / compare / workbench / agents / share copy, semantic disabled cards, historical source badges, and locale-backed faction-timeline lead copy. Campaign boundary notices, newly unlocked badge copy, archive key moments, verdict labels, confidence copy, and debrief moment details also read `result.*` locale keys
- `resultHelpers.ts`
  result-page pure helpers for bet badges, campaign cache, locale-backed badge copy, and structured moment highlights used by the archive / debrief handoff
- `DirectorDebriefPanel.tsx`
  result-page director debrief panel that consumes backend score breakdown plus question, worldline, commitment, bet, intervention, moment, goal, and gameplay state to render score reasons, run readout, next-action cards, and newly unlocked badges
- `CausalReviewView.tsx`
  graph fetches now encode `scenarioId / branchId` before building request URLs; the guide / empty-state copy is now backed by the local `CAUSAL_COLORS` dark-surface palette, close/show controls expose a complete disclosure pattern, and long guide key-node labels stay visually compact while preserving the full label in `aria-label` / `title`
- `ArgumentMap.tsx`
  status labels stay localized for `accepted / standing / unaddressed / rebutted / rejected`; the graph uses a verdict -> claims -> evidence/rebuttals DAG, side-tinted nodes, filter count badges, keyboard shortcuts, and mobile graph/list mode
  fail-soft `load_failed` responses stay on the Retry state and keep graph/export hidden
- `ArgumentMapMobileList.tsx / ArgumentMapTour.tsx`
  compact argument-map list and first-visit guide; both use existing `argument.*` and `common.*` locale keys
- `ExportPanel.tsx`
  native SVG export rebuild now clips long node labels and prefers full labels over truncated card text
- `ProgressIndicator.tsx`
  5-step journey pill used by InputView and ResultView; invalid step values are clamped
- `ShareArtifact.tsx`
  offscreen 1200x630 PNG export card; it only receives display-safe summary fields, not BYOK or session configuration
- `ShareModal.tsx / ShareablePredictionCard.tsx`
  share modal can download/copy a prediction card PNG when the browser supports it; social-copy requests are aborted on close/unmount, not on unrelated parent rerenders
- `shareEnvelope.ts`
  currently keeps only the `ShareFlavorContext` type; frontend no longer prepends a local theme archive envelope to social copy or Markdown export
- `SnapshotExportWizard.tsx / SnapshotImportDialog.tsx`
  feature-gated snapshot ZIP export/import UI; import rejects non-ZIP and files over 50 MB before calling the backend
- `ReACTReasoningPanel.tsx / PersonalityDriftWarning.tsx`
  roundtable analyst tool-chain surface and personality drift warning; the warning only shows risk data and does not block verdict rendering
- `HOPsAnimation.tsx`
  component, CSS, reduced-motion test, and ResultView wiring exist; multi-branch results show the probability sampling explainer before the ending cards, while replay mode keeps it hidden

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
- Current frontend verification:
  - `npx tsc --noEmit`: pass
  - targeted ResultView / ResultVerdictPanel / locale vitest: `98 passed`
  - full vitest: `185 files / 2047 tests passed`
  - `npx eslint src/ --max-warnings=0`: pass
  - `npm run build`: pass, including performance budgets
  - i18n parity spot-check: `en=2509 zh=2509 equal=true`
  - browser recheck covered one new result with verdict and visible branch answers after local SQLite data backfill, plus one old result without verdict, desktop and `375x812` mobile, language switch, and no console JS errors
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
