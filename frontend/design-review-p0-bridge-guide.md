# P0-1 Bridge Card + P0-2 Guide Card -- Deep Self-Audit Report

**Auditor**: Current-truth recheck
**Date**: 2026-04-24
**Scope**: ResultView bridge section, ResultView.css bridge styles, CausalReviewView guide panel, en/zh i18n keys

---

## Findings

### F1 -- Compare link same-branch fallback is still a dead path [Info]
**File**: `ResultView.tsx`
**Description**: The compare link still computes a fallback candidate even when only one branch exists, but the card stays disabled unless `branches.length > 1`, so users never reach a same-branch compare URL from the UI.
**Severity**: Info
**Fix**: Optional cleanup only. No current user-facing risk.

### F2 -- Disabled bridge semantics are now correct [Info]
**File**: `ResultView.tsx`
**Description**: Disabled bridge cards no longer render as bare `<a>` tags without `href`. The current DOM is `div[role="link"][aria-disabled="true"]`, which matches the intended non-interactive state much better.
**Severity**: Info (resolved)

### F3 -- URI encoding is now consistent across bridge and header CTAs [Info]
**File**: `ResultView.tsx`
**Description**: `activeScenarioId`, `branch_a`, and `branch_b` now go through `encodeURIComponent()` in both the bridge cards and the older causal/compare CTAs.
**Severity**: Info (resolved)

### F4 -- CausalReviewView colors are centralized, but still component-local [Warning]
**File**: `CausalReviewView.tsx`
**Description**: The guide / empty-state / input / error colors are no longer scattered inline. They now live in the local `CAUSAL_COLORS` block with AA-oriented comments. That removes the immediate drift risk. The remaining debt is that this palette still lives inside the component instead of the shared global theme token system.
**Severity**: Warning
**Fix**: Future design-system cleanup can move `CAUSAL_COLORS` into shared tokens. Not a release blocker for this slice.

### F5 -- `capLoading` FOUC guard remains correct [Info]
**File**: `ResultView.tsx`
**Description**: The bridge still waits for capability loading to settle before rendering, so there is no flash of disabled cards during initial page load.
**Severity**: Info

### F6 -- Disabled bridge contrast now stays readable [Info]
**File**: `ResultView.css`
**Description**: The disabled bridge state no longer uses whole-card opacity. Text colors stay readable, while the visual “disabled” cue now comes from a dashed border plus grayscale icon treatment.
**Severity**: Info (resolved)

### F7 -- Guide disclosure pattern is now complete [Info]
**File**: `CausalReviewView.tsx`
**Description**: The close and reopen controls now both expose `aria-expanded` and `aria-controls`, so the guide behaves like a complete disclosure surface instead of a half-wired one.
**Severity**: Info (resolved)

### F8 -- Faction timeline lead copy now uses i18n interpolation [Info]
**File**: `ResultView.tsx`, `en.json`, `zh.json`
**Description**: `factionTimelineLead` no longer relies on inline `isZh ? ... : ...` strings. The branch title now flows through locale keys with `{{title}}` interpolation.
**Severity**: Info (resolved)

### F9 -- i18n parity now covers the bridge, guide, and faction-timeline copy [Info]
**File**: `locales.test.ts`, `en.json`, `zh.json`
**Description**: The parity test now covers `empty_guide` and the new `result.faction_timeline_*` keys, including interpolation placeholders.
**Severity**: Info (resolved)

### F10 -- Guide key-node lookup is now cheap and explicit [Info]
**File**: `CausalReviewView.tsx`
**Description**: The previous `graphData.nodes.find(...)` inside the key-node mapping is gone. The guide now builds a `nodeById` map first, so the lookup path is clearer and avoids repeated scans.
**Severity**: Info (resolved)

### F11 -- `bridge_single_branch` fallback copy is still slightly inconsistent [Info]
**File**: `ResultView.tsx`, `en.json`
**Description**: The runtime i18n key is authoritative, so users see the locale resource, not the inline fallback. The fallback sentence is still a little different from the locale key, which is harmless but slightly untidy.
**Severity**: Info
**Fix**: Optional text cleanup only.

### F12 -- `guideOpen` still resets on remount [Info]
**File**: `CausalReviewView.tsx`
**Description**: The guide is open again after a full remount. That is still acceptable for a lightweight orientation panel.
**Severity**: Info

---

## Overall Quality Assessment

**Score: 8.8 / 10**

### Strengths
- Bridge semantics, disabled styling, and URL encoding are now aligned.
- Faction timeline lead copy now follows the i18n system instead of component-local bilingual ternaries.
- Guide copy and empty-state guidance are now backed by a single local color block, which makes the dark-surface contract much easier to reason about.
- Test coverage now includes the previously missing bridge loading state, guide disclosure aria state, and locale placeholder parity.

### Remaining Risks
1. **Component-local palette**: `CAUSAL_COLORS` is still local to `CausalReviewView`, not part of the shared design token system.
2. **Dead fallback paths**: The compare same-branch fallback and the `bridge_single_branch` fallback copy mismatch are still small readability debts for future maintainers.

---

## Current Validation Snapshot

- targeted vitest: `124 passed`
- full vitest: `1365 passed`
- target-file eslint: pass
- `tsc --noEmit -p tsconfig.app.json`: pass
- `npm run build`: pass
- Playwright browser recheck: pass

Browser recheck covered:
- ResultView bridge DOM + disabled styling
- localized faction timeline lead with branch-title interpolation
- CausalReviewView guide disclosure aria state
- no unexpected console errors during the fixture-backed preview flow
