/**
 * Shared design tokens for graph visualizations (ArgumentMap, CausalReviewView, NodeDetailPanel).
 * Single source of truth — all three components import from here.
 */

// ── Node Type Colors (OKLCH) ────────────────────────────────

export const NODE_TYPE_COLORS: Record<string, string> = {
  // Causal graph node types
  event: 'oklch(0.65 0.15 250)',        // blue
  intervention: 'oklch(0.73 0.16 55)',  // amber
  stance_shift: 'oklch(0.58 0.18 300)', // violet
  fork: 'oklch(0.62 0.2 25)',           // rose red
  round: 'oklch(0.74 0.17 155)',        // green
  outcome: 'oklch(0.67 0.14 185)',      // teal
  verdict: 'oklch(0.84 0.14 92)',       // yellow
  // Argument map unit types
  claim: 'oklch(0.67 0.15 250)',        // blue
  evidence: 'oklch(0.74 0.17 160)',     // green
  rebuttal: 'oklch(0.72 0.16 55)',      // amber
  counter: 'oklch(0.61 0.18 18)',       // red
};

// ── Unit Status Colors (OKLCH) ──────────────────────────────

export const STATUS_COLORS: Record<string, string> = {
  standing: 'oklch(0.58 0.06 255)',     // slate blue
  rebutted: 'oklch(0.63 0.16 345)',     // magenta rose
  unaddressed: 'oklch(0.78 0.12 92)',   // warm amber
  accepted: 'oklch(0.63 0.12 190)',     // teal
  rejected: 'oklch(0.57 0.16 28)',      // crimson
};

// ── Edge Styles ─────────────────────────────────────────────

export interface EdgeStyleDef {
  stroke: string;
  strokeDasharray?: string;
  animated: boolean;
  markerEnd?: string;
}

export const EDGE_STYLES: Record<string, EdgeStyleDef> = {
  temporal: { stroke: '#888', strokeDasharray: '4 4', animated: false },
  caused: { stroke: '#888', animated: false },
  supports: { stroke: '#2ecc71', animated: false },
  rebuts: { stroke: '#e67e22', strokeDasharray: '6 3', animated: true },
  attacks: { stroke: '#e74c3c', animated: true },
  accepted: { stroke: '#4a90d9', animated: false },
  unaddressed: { stroke: '#888', strokeDasharray: '2 4', animated: false },
  responds_to: { stroke: '#3498db', animated: false },
  supports_stance: { stroke: '#27ae60', animated: false },
  opposes_stance: { stroke: '#e74c3c', strokeDasharray: '6 3', animated: false },
};

// ── Lucide Icon Names (by node type) ────────────────────────

export const NODE_ICONS: Record<string, string> = {
  event: 'MessageSquare',
  intervention: 'Zap',
  stance_shift: 'ArrowLeftRight',
  fork: 'GitBranch',
  round: 'Clock',
  outcome: 'FileCheck',
  verdict: 'Gavel',
  claim: 'Flag',
  evidence: 'FileCheck',
  rebuttal: 'ShieldAlert',
  counter: 'Swords',
};

// ── Evidence Tier Colors ───────────────────────────────────

export const EVIDENCE_TIER_COLORS: Record<string, string> = {
  high: '#4caf50',
  medium: '#ffb300',
  low: '#9e9e9e',
};

// ── i18n Label Keys ─────────────────────────────────────────

export const TYPE_LABEL_I18N: Record<string, [string, string]> = {
  // Causal types
  event: ['causal.type_event', 'Event'],
  intervention: ['causal.type_intervention', 'Intervention'],
  stance_shift: ['causal.type_stance_shift', 'Stance Shift'],
  fork: ['causal.type_fork', 'Fork'],
  round: ['causal.type_round', 'Round'],
  outcome: ['causal.type_outcome', 'Outcome'],
  verdict: ['causal.type_verdict', 'Verdict'],
  // Argument types
  claim: ['argument.claim', 'Claim'],
  evidence: ['argument.evidence', 'Evidence'],
  rebuttal: ['argument.rebuttal', 'Rebuttal'],
  counter: ['argument.counter', 'Counter'],
};

export const STATUS_LABEL_I18N: Record<string, [string, string]> = {
  standing: ['argument.status_standing', 'Standing'],
  rebutted: ['argument.status_rebutted', 'Rebutted'],
  unaddressed: ['argument.status_unaddressed', 'Unaddressed'],
  accepted: ['argument.status_accepted', 'Accepted'],
  rejected: ['argument.status_rejected', 'Rejected'],
};

// ── Hex Fallbacks (for contexts that don't support OKLCH) ───

export const NODE_TYPE_COLORS_HEX: Record<string, string> = {
  event: '#4a90d9',
  intervention: '#e67e22',
  stance_shift: '#9b59b6',
  fork: '#e74c3c',
  round: '#2ecc71',
  outcome: '#1f9d88',
  verdict: '#f1c40f',
  claim: '#4a90d9',
  evidence: '#2ecc71',
  rebuttal: '#e6a21f',
  counter: '#c6514a',
};

export const KG_NODE_TYPE_FILLS: Record<string, string> = {
  event: '#9a8e85',
  intervention: '#b09050',
  stance_shift: '#7a8e7a',
  fork: '#a87060',
  round: '#6a8a8a',
  outcome: '#5f9f91',
  verdict: '#b0943a',
};

export const STATUS_COLORS_HEX: Record<string, string> = {
  standing: '#62748b',
  rebutted: '#c85d84',
  unaddressed: '#d6ad3d',
  accepted: '#1f9d88',
  rejected: '#b54a45',
};

// ── G6 Dual Tokens (light / dark HEX pairs) ─────────────────
// FE-2: G6 Canvas does not support OKLCH directly; we provide HEX pairs
// for light + dark themes. KGExplorerView reads the active theme from
// `document.documentElement.dataset.theme` (or falls back to light).

export interface G6DualHexTokens {
  background: string;
  nodeFill: string;
  nodeStroke: string;
  edgeStroke: string;
  label: string;
  selectedStroke: string;
  hoverStroke: string;
}

export const G6_TOKENS_LIGHT: G6DualHexTokens = {
  background: '#ffffff',
  nodeFill: '#f2f4f7',
  nodeStroke: '#4a90d9',
  edgeStroke: '#9aa3af',
  label: '#1f2937',
  selectedStroke: '#0ea5e9',
  hoverStroke: '#2563eb',
};

export const G6_TOKENS_DARK: G6DualHexTokens = {
  background: '#0f172a',
  nodeFill: '#1e293b',
  nodeStroke: '#60a5fa',
  edgeStroke: '#64748b',
  label: '#e2e8f0',
  selectedStroke: '#38bdf8',
  hoverStroke: '#93c5fd',
};

/** Resolve G6 HEX tokens based on a theme flag ("light" | "dark"). */
export function resolveG6Tokens(theme: 'light' | 'dark' = 'light'): G6DualHexTokens {
  return theme === 'dark' ? G6_TOKENS_DARK : G6_TOKENS_LIGHT;
}

export function isBrightGraphBackground(color: string | undefined): boolean {
  if (typeof color !== 'string') return false;
  const normalized = color.trim();
  if (!/^#([\da-f]{6}|[\da-f]{3})$/i.test(normalized)) return false;

  const hex = normalized.length === 4
    ? normalized
      .slice(1)
      .split('')
      .map((channel) => `${channel}${channel}`)
      .join('')
    : normalized.slice(1);

  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const luminanceChannels = channels.map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  const luminance =
    0.2126 * luminanceChannels[0] +
    0.7152 * luminanceChannels[1] +
    0.0722 * luminanceChannels[2];

  return luminance > 0.56;
}

// ── KG-Specific Editorial Tokens (cream + magenta) ─────────
// KG views use the project's "Impeccable Premium Editorial" palette
// rather than the generic cobalt-graph tokens shared with DAG views.
// Imported only by kgGraphConfig.ts; DAG views (CausalReviewView,
// ArgumentMap, FactionForceGraph, NodeDetailPanel) keep resolveG6Tokens.

export interface KgG6Tokens extends G6DualHexTokens {
  /** Soft, cream-aligned edge stroke at ~55% alpha for non-active edges. */
  edgeStrokeSubtle: string;
  /** Project brand color used for selected/locked node ring. */
  brandRing: string;
  /**
   * Translucent ghost color for node drag state. Reserved as a design token
   * for future G6 drag-state styling (drag-element-force ghost layer);
   * currently retained as part of the KG editorial token contract so themes
   * stay in sync once G6 exposes drag-ghost styling.
   */
  dragGhost: string;
  /** Background fill for edge label chip on this theme. */
  edgeLabelBg: string;
  /** Foreground fill for edge label text on this theme. */
  edgeLabelFg: string;
}

export const KG_G6_TOKENS_LIGHT: KgG6Tokens = {
  background: '#fcfcfa',                    // project --bg-surface (cream)
  nodeFill: '#f2eee7',                      // project --bg-hover (subtle node fill)
  nodeStroke: '#c61583',                    // project --color-primary (magenta brand)
  edgeStroke: '#c5beb1',                    // muted cream-aligned edge
  edgeStrokeSubtle: 'rgba(197,190,177,0.55)',
  label: '#181611',                         // project --text-primary
  selectedStroke: '#c61583',                // brand magenta
  hoverStroke: '#db589e',                   // project --color-primary-dim
  brandRing: '#c61583',
  dragGhost: 'rgba(198,21,131,0.18)',
  edgeLabelBg: 'rgba(252,252,250,0.95)',    // cream-tinted chip bg
  edgeLabelFg: '#58554f',                   // project --text-secondary
};

export const KG_G6_TOKENS_DARK: KgG6Tokens = {
  background: '#181611',                    // dark editorial mirror of cream
  nodeFill: '#28241e',
  nodeStroke: '#db589e',                    // primary-dim adapts to dark
  edgeStroke: '#5a544c',
  edgeStrokeSubtle: 'rgba(90,84,76,0.55)',
  label: '#f0eee9',                         // warm-tinted dark text
  selectedStroke: '#db589e',
  hoverStroke: '#c61583',
  brandRing: '#db589e',
  dragGhost: 'rgba(219,88,158,0.22)',
  edgeLabelBg: 'rgba(24,22,17,0.85)',
  edgeLabelFg: '#928f88',                   // project --text-muted
};

/** Resolve KG-specific editorial tokens (cream + magenta). */
export function resolveKGG6Tokens(theme: 'light' | 'dark' = 'light'): KgG6Tokens {
  return theme === 'dark' ? KG_G6_TOKENS_DARK : KG_G6_TOKENS_LIGHT;
}
