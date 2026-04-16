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
};

// ── Lucide Icon Names (by node type) ────────────────────────

export const NODE_ICONS: Record<string, string> = {
  event: 'MessageSquare',
  intervention: 'Zap',
  stance_shift: 'ArrowLeftRight',
  fork: 'GitBranch',
  round: 'Clock',
  verdict: 'Gavel',
  claim: 'Flag',
  evidence: 'FileCheck',
  rebuttal: 'ShieldAlert',
  counter: 'Swords',
};

// ── i18n Label Keys ─────────────────────────────────────────

export const TYPE_LABEL_I18N: Record<string, [string, string]> = {
  // Causal types
  event: ['causal.type_event', 'Event'],
  intervention: ['causal.type_intervention', 'Intervention'],
  stance_shift: ['causal.type_stance_shift', 'Stance Shift'],
  fork: ['causal.type_fork', 'Fork'],
  round: ['causal.type_round', 'Round'],
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
  verdict: '#f1c40f',
  claim: '#4a90d9',
  evidence: '#2ecc71',
  rebuttal: '#e6a21f',
  counter: '#c6514a',
};

export const STATUS_COLORS_HEX: Record<string, string> = {
  standing: '#62748b',
  rebutted: '#c85d84',
  unaddressed: '#d6ad3d',
  accepted: '#1f9d88',
  rejected: '#b54a45',
};

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
