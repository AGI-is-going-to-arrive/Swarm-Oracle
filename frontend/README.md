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
- **Asset Regeneration** — 18 runtime sprites + 30 semantic scene backgrounds + 6 ending images (GBC pixel art)
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
| `/result/:id` | `ResultView` | Multi-ending comparison, archive, campaign progress, prediction results, share/export |
| `/history` | `HistoryView` | Scenario history, filtering, pagination, safe deletion |
| `/leaderboard` | `LeaderboardView` | Global prediction leaderboard |

## Key Components

- **BranchTree** — React Flow graph showing scenario branches
- **ClassicBranchTree** — classic-only wrapper that lazy-loads the branch tree stack
- **BranchNode** — Custom node with probability bar + intervene button
- **AgentPanel** — Agent roster with pixel avatars, emotion dots, speech bubbles
- **InterventionModal** — Butterfly Effect user intervention input
- **GameplayCardsModal** — 10 domain-driven “director cards” that inject high-priority branch events; the modal now also shows a profile-specific three-step signature arc plus lightweight `risk / resource` tracks
- **themeRegistry.ts** — single source of truth for the 30 Theater themes, their keyword routing, profile mapping, and gameplay frame / badge asset paths
- **Director Campaign** — ResultView finalizes campaign progress against the backend; InputView now merges backend `daily-status` with local cache so the current daily challenge is not judged only by `localStorage`
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
npm run e2e:variants
npm run e2e:corners
npm run e2e:full
```

- Current frontend test suite: **155 passed (155)** in the latest full run
- Fixed matrix sample set: **15 scenarios** for the main pool, plus **3 variant scenarios** in `output/e2e/sample_matrix_variants.json`
- Latest Track C artifact bundles:
  - `frontend/output/e2e/20260317-track-c/matrix/`
  - `frontend/output/e2e/20260317-track-c/corners/`
  - `frontend/output/e2e/20260317-track-c/mobile/`
  - `frontend/output/e2e/20260317-track-c/variants/`
- `scripts/e2e-suite.mjs` now writes `browser-launch.json` into the chosen output directory so you can see which browser launch profile actually ran
- Matrix runs now also recreate samples when an old `scenario_id` resolves to a stale `scene_theme`, not only when the scenario is missing
- If Playwright screenshot capture stalls on font loading, the suite falls back to Chromium CDP capture instead of aborting the whole run
- Latest Docker runtime smoke: `docker compose up --build -d` succeeded, and a proxied `POST /api/scenario` request created a Theater scenario that reached `status = done`
- Language behavior:
  - UI labels follow the EN/ZH switcher
  - agent replies and narration follow detected input language
  - daily challenge prompts now also respect the current EN/ZH UI language instead of leaking the Chinese source text into the English card

## Asset Generation

- UI / Theater asset generation helper: `frontend/scripts/generate-ui-assets.mjs`
- The script tries `aiplatform.googleapis.com` first and falls back to `generativelanguage.googleapis.com` when the former rejects API-key-only calls
- Newly added assets in this pass include:
  - `public/assets/ui/generated/gameplay_card_frame_generic.png`
  - `public/assets/scenes/law_court_variant.png`
  - `public/assets/scenes/faith_temple_variant.png`
  - `public/assets/scenes/switchboard_forum_variant.png`

## Build

```bash
npm run build   # outputs to dist/
```
