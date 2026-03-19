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
- `useDebateWS` / `useSimulationWS`
  live event hydration
- `PhaserGameLoader` / `useScreenCapture`
  Theater-only loading and split capture runtime

## Validation

```bash
cd frontend
npm install
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run build
npm run assets:provenance:check
```

```bash
cd frontend
npm run release:signoff -- --headless
```

- Historical full baseline: `179 passed`.
- Current targeted frontend set: `79 passed`.
- Default signoff contract:
  - targeted backend checks
  - backend `/metrics`
  - `tsc`
  - `build`
  - asset provenance check
  - `corners`
  - `cross-browser`
  - `debate-full`
- Safari is optional and not part of the default full signoff.
- Latest passing signoff artifact: `output/e2e/20260320-codex-live-signoff/summary.json`.

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
