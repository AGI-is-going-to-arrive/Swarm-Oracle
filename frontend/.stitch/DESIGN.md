# SwarmOracle Design System (Stitch DS-1 / Round 9)

> **Generation status**: Partial success. Stitch MCP (`stitch.googleapis.com/mcp`) successfully created project `swarmoracle-round9` (id `7576268024967914156`) and auto-generated a full `designTheme` (see §2 below) using model `GEMINI_3_1_PRO`. All 12 `generate_screen_from_text` calls timed out server-side; only the project thumbnail was recovered. Remaining 11 screens are captured as text-spec + ASCII wireframe (below) — per plan `DS-1 fallback branch`.
>
> - Project: `projects/7576268024967914156`
> - Model preference: `gemini-3.1-pro-preview` → `gemini-3.1-pro` (MCP enum maps to `GEMINI_3_1_PRO`)
> - Asset manifest: `.claude/assets/ui-prototypes/round9/manifest.json`
> - Real Stitch asset: `project-thumbnail.png` (512×410)
> - FE-2/3/4/5 MUST align to the tokens + text specs below; OKLCH source of truth still lives in `frontend/src/lib/graphTokens.ts`.

---

## 1. Creative North Star — "The Ethereal Observer"

Sanctuary of clarity for a multi-agent simulation platform. Data breathes; layers are separated by tonal depth, not rigid 1px borders. Intentional asymmetry (60/40 or 70/30 rhythms) guides the eye to primary insights. Premium, cinematic, deeply intentional. (Source: Stitch designMd, GEMINI_3_1_PRO output preserved verbatim.)

### Voice Rules
- Embrace negative space. Allow metrics to breathe.
- Mix typefaces: Inter for story, JetBrains Mono for facts.
- Use tonal surface layering instead of heavy box-shadows.
- Subtle motion: 300ms fade-and-slide on metric updates, never hard snaps.
- Forbidden: brutalism, heavy claymorphism, skeuomorphism, pure black (`#000`) base, 100% opaque borders, grid-snap decorative glows.

---

## 2. Design Tokens (Dark primary, Light counterpart)

All HEX values are authoritative for Stitch / AI prototyping. OKLCH tokens in `frontend/src/lib/graphTokens.ts` are the runtime source of truth — manually sync HEX → OKLCH here when Stitch redrifts.

### 2.1 Stitch-generated theme (DARK · VIBRANT)

| Token | Hex | Role |
|-------|-----|------|
| `background` | `#060e20` | App base (deep navy; NEVER `#000`) |
| `surface` | `#060e20` | Same as background for unified ground |
| `surface_container_lowest` | `#000000` | Only for ambient shadow casting |
| `surface_container_low` | `#091328` | Section divider via tone, not border |
| `surface_container` | `#0f1930` | Interactive card base |
| `surface_container_high` | `#141f38` | Elevated card |
| `surface_container_highest` | `#192540` | Floating popover + 20px backdrop-blur |
| `surface_bright` | `#1f2b49` | High-emphasis container |
| `surface_variant` | `#192540` | Frosted glass overlay @ 60% opacity |
| `primary` | `#85adff` | Primary accent (light blue tint of `#3b82f6`) |
| `primary_container` | `#6e9fff` | Gradient stop for CTA |
| `primary_dim` | `#699cff` | Muted primary |
| `secondary` | `#c180ff` | Secondary (violet) |
| `secondary_container` | `#6f00be` | Deep violet for containers |
| `secondary_dim` | `#9c48ea` | Muted secondary |
| `tertiary` | `#9bffce` | Success / emerald accent |
| `tertiary_container` | `#69f6b8` | Gradient stop |
| `error` | `#ff716c` | Destructive |
| `error_container` | `#9f0519` | Error surface |
| `on_surface` | `#dee5ff` | Primary text |
| `on_surface_variant` | `#a3aac4` | Secondary text |
| `outline` | `#6d758c` | Icon outline |
| `outline_variant` | `#40485d` | Ghost border @ 15% opacity only |

#### Override pins (pipelined from ui-prompts Master Prompt)
- `override_neutral_color`: `#0f172a`
- `override_primary_color`: `#3b82f6`
- `override_secondary_color`: `#a855f7`
- `override_tertiary_color`: `#10b981`

### 2.2 Light-theme counterparts (HC-28 `updateStyle` contract)

Use for `/result/:id` dashboard and Light-theme toggle. All Stitch-generated light tokens inherit from the same scale, applied per §1.

| Token | Hex (Light) |
|-------|-------------|
| `background` | `#f1f5f9` |
| `surface` | `#f8fafc` |
| `surface_container_low` | `#e2e8f0` |
| `surface_container` | `#cbd5e1` |
| `primary` | `#1d4ed8` |
| `secondary` | `#6d28d9` |
| `tertiary` | `#047857` |
| `error` | `#b91c1c` |
| `on_surface` | `#0f172a` |
| `on_surface_variant` | `#475569` |

### 2.3 Graph-specific (from `graphTokens.ts`)

| Node type | OKLCH | Hex fallback |
|-----------|-------|--------------|
| event | `oklch(0.65 0.15 250)` | `#4a90d9` |
| intervention | `oklch(0.73 0.16 55)` | `#e67e22` |
| stance_shift | `oklch(0.58 0.18 300)` | `#9b59b6` |
| fork | `oklch(0.62 0.2 25)` | `#e74c3c` |
| round | `oklch(0.74 0.17 155)` | `#2ecc71` |
| verdict | `oklch(0.84 0.14 92)` | `#f1c40f` |
| claim | `oklch(0.67 0.15 250)` | `#4a90d9` |
| evidence | `oklch(0.74 0.17 160)` | `#2ecc71` |
| rebuttal | `oklch(0.72 0.16 55)` | `#e6a21f` |
| counter | `oklch(0.61 0.18 18)` | `#c6514a` |

### 2.4 Faction / identity edge palette (§2 constellation spec)

| Layer | Hex | Role |
|-------|-----|------|
| Causal link | `#60a5fa` | Pale blue flow edge |
| Identity link | `#c4b5fd` | Pale violet flow edge |
| Faction A hub | `#f59e0b` | Amber hub avatar ring |
| Faction B hub | `#10b981` | Emerald hub avatar ring |
| Alliance edge | `linear-gradient(135deg, #f59e0b, #10b981)` | Amber → emerald |

---

## 3. Typography

| Role | Family | Weight / Size |
|------|--------|---------------|
| Display | Inter | 700 · 32–48px · letter-spacing −0.02em |
| Headline | Inter | 600 · 18–24px |
| Body | Inter | 400 · 14–16px |
| Caption | Inter | 500 · 11–12px |
| Metric / node label | JetBrains Mono | 500 · 10–11px |
| Metric value | JetBrains Mono | 700 · 18–28px |
| Code / status | JetBrains Mono | 500 · 12–13px |
| Label (chip / badge) | Space Grotesk | 500 · 10–12px (per `labelFont` hint) |

Pair a `display-md` metric with a `label-sm` subtitle in `on_surface_variant` for high-end asymmetric tension.

---

## 4. Elevation & Depth (Tonal Layering)

| Layer | Background | Blur | Usage |
|-------|------------|------|-------|
| Base | `#060e20` | — | App root |
| Section | `#091328` | — | Content zones (no border) |
| Interactive card | `#0f1930` | 0 | Default card resting state |
| Elevated card | `#141f38` | 8px | Active / focused |
| Floating overlay | `#192540` @ 60% | 20–24px | Sheets, popovers, dropdowns |

### Ambient Shadow recipe
- blur: 40–60px · opacity: 4–8% · color: tinted `on_surface` (blue tint, never pure black)

### Ghost Border (a11y fallback)
- `outline_variant` `#40485d` · opacity 15% · 1px · never 100%.

---

## 5. Component Inventory (shadcn/ui + custom)

| Component | Variant | Notes |
|-----------|---------|-------|
| `Card` | default / gradient | gradient uses Tailwind v4 utility `from-fuchsia-500 to-pink-500` |
| `Sheet` | `side="right"` (desktop 480px) · `side="bottom"` (mobile 40/70/100%) | Same component, prop swapped via `useMediaQuery('(max-width:768px)')` |
| `Tabs` | underlined + colored dot | For source categories |
| `ToggleGroup` | segmented control | "xyflow · G6 · Compare" |
| `ScrollArea` | inner-scroll | Transcripts, chat flow |
| `DropdownMenu` | compact | Layout / Export menu |
| `Dialog` | focus-trap | Intervention / auth prompts |
| `Alert` | info · warning · destructive | recovery banners |
| `Badge` | outline · solid · gradient | "LIVE", "US Only", "Senior Advisor" |
| `Button` | primary (gradient) · outline · ghost · destructive | Min 44×44 touch |
| `Skeleton` | shimmer 2s sweep | Card / list loading |
| `Spinner` | 16px circular countdown | Rate-limit |
| `Toast` (sonner) | top-right desktop · top-full mobile | Offline / expired |
| `StreamingBubble` (custom) | blinking cursor `█` @ 500ms | WS `turn_delta` |
| `SparklineChart` (custom) | 120×32 · recharts | Polymarket 24h trend |
| `MiniMap` (custom) | 160×120 · canvas | KG Explorer |
| `sr-only <table>` fallback | 50-row top-connected nodes | a11y for G6 Canvas |

### Minimum tap target: 44×44px across all interactive elements.

---

## 6. Twelve Screens — Summary + ASCII Wireframes

Each screen references the full spec in `.claude/team-plan/graph-playability-upgrade-ui-prompts.md` §1–§12. The Stitch MCP generation of individual PNGs timed out; the single real asset (`project-thumbnail.png`, 512×410) is used as the global style anchor.

### §1 · Dual-Stack Graph Comparison · Desktop 1920×1080
Route: `/kg-explorer/:id?compare=dual`. xyflow DAG left, G6 force-directed right, segmented control + Layout/Export toolbar.

```
┌──────────────────────────── Top toolbar 64 ────────────────────────────┐
│  [xyflow │ G6 │ Compare]                         [Layout ▾] [Export]   │
├─────────────────────────────── 1px divider ────────────────────────────┤
│                              │                                          │
│   [Premise A]──supports 0.8──┤    ●          ● hub(amber)               │
│        │                     │       ●  ●         ●                     │
│   [Rebuttal B]               │   ●         hub(emerald)●                │
│        │                     │        ●  ● ●     ●                      │
│   [Conclusion C]             │    ●     ●      ●                        │
│                              │                                          │
│     (xyflow · electric blue) │   (G6 force · cyber purple)              │
│                              │                               [MiniMap]  │
└──────────────────────────────┴─────────────────────────────────────────┘
```

### §2 · Mass Knowledge Graph · Desktop 1920×1080 immersive
Route: `/kg-explorer/:id`. ~1000-node constellation, radial vignette, floating overlays.

```
┌────────────────────────────────────────────────────────────────────────┐
│              [ 🔍 Search identity, faction, round... ]                  │
│                                   [All · Causal · Identity · Faction]  │
│       .  ·  .    ·  .    ● hub    ·  .  ·   .    ·                     │
│     ·  · ●hub· ·   · ·  ·  ·  ·   · ·  · ·  · ·                        │
│       .    ·  ·●  ·   ·     ·  ·    ·  ·  · ● hub                      │
│     ·   · · ·     ·     constellation ~1000 nodes                       │
│       .  ·  .    ·  ·   ·   ·   ·      ·   ·                           │
│                                                    ┌──MiniMap────┐     │
│                                                    │ ● . . · .  . │     │
│ [1,042 nodes · 3,218 edges · 12 factions]          └──────────────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

### §3 · Agent Replay Conversation Side Sheet · 1920×1080
Route: node click from §1/§2/ArgumentMap/FactionTimeline. Side Sheet right 480px, frosted glass over blurred graph.

```
                                         ┌──── Side Sheet 480 ─────┐
                                         │ ◉ Oracle Node-04      X │ 72h
  (blurred graph background)             │ [Senior Advisor]        │
                                         │ "...supports treaty..." │
                                         ├─────────────────────────┤
                                         │   [agent bubble]        │
                                         │   [citation pill · R4]  │
                                         │              [user ▸]   │
                                         │   [agent bubble]        │
                                         │                         │ scroll
                                         ├─────────────────────────┤
                                         │ ⓘ Draft restored  ✓ Keep│
                                         │ [textarea ...        ][→]│ 120h
                                         └─────────────────────────┘
```

### §4 · Empty State · 480×600 side panel section
Three quick-question pills, abstract spectral funnel illustration.

```
┌──── 480 ─────┐
│              │
│   ╭─────╮    │
│   │ ░░░ │    │  ← spectral funnel 160×160
│   ╰─────╯    │
│              │
│ Dive deeper  │
│ into the…    │
│ (subtitle)   │
│              │
│ ┌──────────┐ │
│ │✨ Why X? │ │
│ ├──────────┤ │
│ │✨ If Y?  │ │
│ ├──────────┤ │
│ │✨ Faction?│ │
│ └──────────┘ │
└──────────────┘
```

### §5 · Multi-Source Aggregation Dashboard · 1920×1080 light
Route: `/result/:id` sources section. 4-col masonry · Polymarket · arXiv · Semantic Scholar · NewsAPI.

```
┌ [ All · Prediction Markets · Academic · News ] ────────────────────────┐
│                                                                        │
│ ┌Polymarket ─┐  ┌arXiv ───┐  ┌News ──┐   ┌Semantic─┐                   │
│ │LIVE · US   │  │Paper    │  │[img]  │   │HIGH INF │                   │
│ │65% YES ▲   │  │Liu 2026 │  │Reuters│   │ 0.92    │                   │
│ │$1.2M ∿∿    │  │Abstract │  │2h ago │   │ graph   │                   │
│ └────────────┘  └─────────┘  └───────┘   └─────────┘                   │
│ ┌Polymarket ─┐  ┌arXiv ───┐  ┌News ──┐                                 │
│ │ ...        │  │ ...     │  │ ...   │                                 │
│ └────────────┘  └─────────┘  └───────┘                                 │
└────────────────────────────────────────────────────────────────────────┘
```

### §6 · Polymarket Geo-Gated · 360×240 card
Lock icon over blurred prediction content. Amber restricted banner.

```
┌─── 360 ───┐
│  ░░░░░░░  │  ← blurred "65% YES" outline
│     🔒    │
│  RESTRICTED REGION
│  US MARKET ONLY
│  (description) │
│   Learn more →
└───────────┘
```

### §7 · Source States Composite · 1920×1080
Skeleton · Rate-limit · Empty · Network-error · Global offline banner.

```
┌ [ Global Offline Banner 48h · amber · Reconnect ] ─────────────────────┐
│ ┌Skeleton─┐ ┌Skeleton─┐ ┌Skeleton─┐ ┌RateLimit─┐                       │
│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │⚡ 28s ⟳  │                       │
│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │▓▓▓▓▓▓▓▓│ │[Retry]   │                       │
│ └─────────┘ └─────────┘ └─────────┘ └──────────┘                       │
│ ┌Empty────┐ ┌NetError ─┐                                               │
│ │📁       │ │⚠ WiFiOff │                                               │
│ │No srcs  │ │Retry →   │                                               │
│ └─────────┘ └──────────┘                                               │
└────────────────────────────────────────────────────────────────────────┘
```

### §8 · Streaming WS · Mobile 393×852
Bottom Sheet 70%, blinking cursor `█`, Stop Generation button, disabled input.

```
┌──── 393 ────┐
│ (graph blur)│ 30%
├═════════════┤ ← handle 40×4
│Streaming · 142/8192│
│            [user]▸│
│[agent partial █]   │
│     [⏹ Stop]       │
│                    │ 70%
│[disabled input..]  │
└─────────────┘
```

### §9 · Result Action Card CTA · 1920×1080
Sticky bottom-right 420×160 gradient card (purple → pink), MessageSquare icon, →.

```
ResultView dashboard ... (top 60%)
┌─────────────────────────────────────────────────────────┐
│                                     ┌──── 420 ─────┐    │
│                                     │💬 Engage       ▸│   │
│                                     │  Immersive Replay│   │
│                                     └──────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### §10 · Mobile Bottom Sheet Source Panel · 393×852
Drag handle · Trending Sources list (arXiv/Polymarket/News/SemSch) · 44px taps.

```
┌──── 393 ────┐
│ Trending… ○  │ 30%
├═════════════┤
│ ═ handle ═   │
│ Trending Sources       X│
│ ┌──────────────┐        │
│ │arXiv · Liu   │→       │
│ │Polymarket 65%│→       │
│ │[img] Reuters │→       │
│ │SemSch · 0.92 │→       │
│ └──────────────┘        │
└─────────────┘ 70%
```

### §11 · Conversation Abort & Recovery · 480×600
Truncated agent bubble + dashed amber border + AlertCircle info card, Retry/Discard buttons.

```
┌──── 480 ─────┐
│ [user msg]  ▸│
│[agent cut...-]│ ← dashed amber border bottom + WifiOff
│               │
│┌──info card──┐│
││⚠ Generation  ││
││  interrupted ││
││ [Retry][Ghost]││
│└──────────────┘│
│                │
│[disabled input]│
└────────────────┘
```

### §12 · Draft Restored Indicator · 480×100
Blue info-banner variant + amber degraded variant for Safari Private Mode.

```
Primary (restored):
┌───────── 480 ─────────┐
│ ✓ Draft restored…   [Keep][Discard]│
└────────────────────────────────────┘
 ↓ textarea (Draft auto-saved 3 min ago)

Degraded (unavailable):
┌───────── 480 ─────────┐
│ ⚠ Draft auto-save unavailable (storage blocked)│
└────────────────────────────────────────────────┘
 ↓ textarea (Your text will only live in this tab)
```

---

## 7. Responsive Breakpoints (shared across all screens)

| Breakpoint | Width | Key shift |
|-----------|-------|-----------|
| Mobile | `<768px` | Bottom Sheet, single-column, ≤300 graph nodes auto-degrade |
| Tablet | `768–1279px` | Side Sheet 420px, stacked dual graph, drawer overlays |
| Desktop | `≥1280px` | Full split, 480px Side Sheet, masonry 4-col |

### a11y (applies everywhere)
- `role="dialog"` + `aria-modal="true"` on all Sheets.
- Close buttons `aria-label="Close conversation"` (B-minor fix).
- G6 Canvas must render sr-only `<table>` fallback with ≤50 top-connected nodes.
- Touch targets minimum 44×44px.
- `prefers-reduced-motion` → all `breathe`/`pulse`/`ambient` loops snap to static.

---

## 8. I18n contract

- All dynamic time strings use `Intl.RelativeTimeFormat` with `numeric: 'auto'` (zh: "3 分钟前" / en: "3 min ago"). NEVER dayjs.
- Currency + compact notation: `Intl.NumberFormat` with `{ notation: 'compact', style: 'currency', currency: 'USD' }`.
- ICU plurals for token counters, citations, retry seconds: `{count, plural, =0 {…} other {…}}`.
- 6 `turn_error` codes (application-layer) + 3 WS close codes (transport-layer) MUST map to distinct i18n keys per ui-prompts §8.

---

## 9. Known limits / Follow-up for FE-2/3/4/5

1. PNG prototypes for §1–§12 unavailable. FE must align from text-spec + wireframes + `project-thumbnail.png`.
2. When Stitch MCP stabilizes, rerun `mcp__stitch__generate_screen_from_text` with `modelId: GEMINI_3_1_PRO`; write outputs back into `.claude/assets/ui-prototypes/round9/` and bump this DESIGN.md.
3. Do NOT create `frontend/scripts/stitch-tokens-to-graphTokens.mjs` or `frontend/scripts/stitch-import.mjs` (user directive, plan DS-1 §14.4 DEPRECATED).
4. OKLCH source of truth stays in `frontend/src/lib/graphTokens.ts`; HEX fallbacks in §2 of this file.
