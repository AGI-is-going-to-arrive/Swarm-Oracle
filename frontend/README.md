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
- **Asset Regeneration** — 18 runtime sprites + 27 semantic scene backgrounds + 6 ending images (GBC pixel art)
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
| `/` | `InputView` | Scenario input, daily challenge, quick starts |
| `/sim/:id` | `SimulationView` | Live simulation with Classic View / Pixel Theater, semantic scene selection, replay, gameplay cards, prediction entry, screenshot/GIF export |
| `/result/:id` | `ResultView` | Multi-ending comparison, archive, prediction results, share/export |
| `/history` | `HistoryView` | Scenario history, filtering, pagination, safe deletion |
| `/leaderboard` | `LeaderboardView` | Global prediction leaderboard |

## Key Components

- **BranchTree** — React Flow graph showing scenario branches
- **ClassicBranchTree** — classic-only wrapper that lazy-loads the branch tree stack
- **BranchNode** — Custom node with probability bar + intervene button
- **AgentPanel** — Agent roster with pixel avatars, emotion dots, speech bubbles
- **InterventionModal** — Butterfly Effect user intervention input
- **GameplayCardsModal** — 10 domain-driven “director cards” that inject high-priority branch events; the modal now also shows a profile-specific three-step signature arc plus lightweight `risk / resource` tracks
- **themeRegistry.ts** — single source of truth for the 27 Theater themes, their keyword routing, profile mapping, and gameplay frame / badge asset paths
- **PredictionModal** — structured bets for branch winner / ending tone / theme resonance
- **TimelineBar** — compact replay timeline with fork/card/bet/result markers
- **ResultView** — Ending cards, probability bars, expandable stories, insights
- **ShareModal** — Social media copy generation (小红书/微博/知乎/Reddit/X)
- **LanguageSwitcher** — Global language toggle (EN/ZH), fixed bottom-right

## Design

Follows the [Impeccable](https://impeccable.style) editorial design system. Supports dark-first theme with CSS custom properties.

## Testing

```bash
npm install
npm test          # Vitest + Testing Library
npm run e2e:matrix
npm run e2e:corners
npm run e2e:full
```

- Current frontend test suite: **151 tests**
- Fixed matrix sample set: **15 scenarios** (main themes + lightweight semantic variants)
- Latest full black-box regression artifact: `frontend/output/e2e/full-headless-20260317/result.json`
- `scripts/e2e-suite.mjs` now writes `browser-launch.json` into the chosen output directory so you can see which browser launch profile actually ran
- If Playwright screenshot capture stalls on font loading, the suite falls back to Chromium CDP capture instead of aborting the whole run
- Latest Docker runtime smoke: `docker compose up --build -d` succeeded, and a proxied `POST /api/scenario` request created a Theater scenario that reached `status = done`
- Language behavior:
  - UI labels follow the EN/ZH switcher
  - agent replies and narration follow detected input language

## Build

```bash
npm run build   # outputs to dist/
```
