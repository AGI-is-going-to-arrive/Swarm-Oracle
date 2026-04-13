/**
 * Shared design tokens for graph visualizations (ArgumentMap, CausalReviewView, NodeDetailPanel).
 * Single source of truth — all three components import from here.
 */

// ── Node Type Colors (OKLCH) ────────────────────────────────

export const NODE_TYPE_COLORS: Record<string, string> = {
  // Causal graph node types
  event: 'oklch(0.65 0.15 250)',       // blue
  intervention: 'oklch(0.7 0.16 55)',  // orange
  stance_shift: 'oklch(0.55 0.18 310)', // purple
  fork: 'oklch(0.6 0.2 25)',           // red
  round: 'oklch(0.72 0.17 155)',       // green
  verdict: 'oklch(0.82 0.15 90)',      // yellow
  // Argument map unit types
  claim: 'oklch(0.65 0.15 250)',       // blue (same as event)
  evidence: 'oklch(0.72 0.17 155)',    // green (same as round)
  rebuttal: 'oklch(0.6 0.2 25)',       // red (same as fork)
  counter: 'oklch(0.7 0.16 55)',       // orange (same as intervention)
};

// ── Unit Status Colors (OKLCH) ──────────────────────────────

export const STATUS_COLORS: Record<string, string> = {
  standing: 'oklch(0.72 0.17 155)',    // green
  rebutted: 'oklch(0.6 0.2 25)',       // red
  unaddressed: 'oklch(0.6 0.02 250)', // muted gray
  accepted: 'oklch(0.65 0.15 250)',    // blue
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
  rebuttal: '#e74c3c',
  counter: '#e67e22',
};

export const STATUS_COLORS_HEX: Record<string, string> = {
  standing: '#2ecc71',
  rebutted: '#e74c3c',
  unaddressed: '#888',
  accepted: '#4a90d9',
  rejected: '#e74c3c',
};

const BRIGHT_GRAPH_BACKGROUNDS = new Set(['#f1c40f', '#2ecc71']);

export function isBrightGraphBackground(color: string | undefined): boolean {
  return typeof color === 'string' && BRIGHT_GRAPH_BACKGROUNDS.has(color);
}
