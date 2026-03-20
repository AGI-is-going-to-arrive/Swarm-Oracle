# SwarmOracle Frontend

> 文档类型：active reference
> 当前真值：否。产品范围以仓库根 `README.md` 为准；开发与签收命令以 `llmdoc/guides/development.md` 为准。

React + TypeScript frontend for SwarmOracle.

## Stack

- React 19
- TypeScript 5.9
- Vite 7
- Zustand
- i18next
- Phaser 3
  current default build/test path aliases bare `phaser` to `experiments/phaser-custom/entry.cjs`, so shipped builds no longer consume the package's full default ESM entry
- Playwright-based E2E scripts

## Routes

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `InputView` | Scenario input, quick starts, daily challenge, provider policy |
| `/sim/:id` / `/sim/replay` | `SimulationView` | Live simulation, Pixel Theater, replay, gameplay cards, structured bets, capture |
| `/result/:id` / `/result/replay` | `ResultView` | Result comparison, archive, campaign summary, share/export, replay import |
| `/debate/:id` | `DebateArenaView` | Debate live page with phase ribbon, momentum HUD, structured bet entry |
| `/debate/:id/result` / `/debate/replay/result` | `DebateResultView` | Debate result, supporting turns, replay digest, share/import |
| `/history` | `HistoryView` | Scenario history, filtering, deletion |
| `/leaderboard` | `LeaderboardView` | Prediction leaderboard |

## Key Frontend Systems

- `themeRegistry.ts`
  single source of truth for Theater / Debate themes and UI asset paths
- `scenarioReplay.ts / simulationReplay.ts / debateReplay.ts`
  replay URL building, token encoding/decoding, import helpers
- `scenarioMeta`
  compatibility/cache layer, not cross-device authority
  authority-backed replay snapshots now strip redundant `cards / bets / branchSnapshots`
- `useDebateWS` / `useSimulationWS`
  live event hydration
- `PhaserGameLoader` / `useScreenCapture`
  Theater-only loading and split capture runtime
- `experiments/phaser-custom/*`
  local curated Phaser entry, isolated spike configs, and repeatable custom-build validation scripts; current default `vite / vitest` also consume this entry, while `phaser3spectorjs-stub.cjs` keeps the build path quiet

## Validation

```bash
cd frontend
npm install
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run build
npm run assets:provenance:check
```

```bash
cd frontend
npm run release:signoff -- --headless
```

```bash
cd frontend
npm run test:spike:phaser-custom
npm run build:spike:phaser-custom
```

- Historical full baseline: `179 passed`.
- Current targeted frontend set: `104 passed`.
- Current custom Phaser runtime subset:
  - `src/game/PhaserGame.test.ts + src/game/PhaserGameLoader.test.ts + src/game/replaySync.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx`: `41 passed`
  - `npm run test:spike:phaser-custom`: `30 passed`
- Current default build shrinks the `phaser` chunk from about `1202.19 kB` to `718.11 kB` (`328.41 kB` → `202.34 kB` gzip).
- Default signoff contract:
  - targeted backend checks
  - backend `/metrics`
  - `tsc`
  - `build`
  - asset provenance check
  - `corners`
  - `mobile`
  - `cross-browser`
  - `debate-full`
- Safari is optional and not part of the default full signoff.
- Latest passing worktree signoff artifact: `output/e2e-spikes/phaser-custom-release-signoff-rerun/summary.json`.
- Current signoff script now re-reads `director_state / gameplay_state` revisions before roundtrip PUT, so `corners` no longer depends on historical samples staying at revision `0`.
- Current custom Phaser spike artifact root: `dist-spikes/phaser-custom/`.

## Asset Notes

- `frontend/public/assets/ASSET_CREDITS.md`
  is the current asset inventory/source reference.
- It is responsible only for asset scope and provenance, not for product scope or signoff status.

## Build

```bash
cd frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 18928
```
