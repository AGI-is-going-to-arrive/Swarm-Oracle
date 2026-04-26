/* ═══════════════════════════════════════════════════════════
   P6 Phase 2 — DAG Editorial Tokens
   CSS-in-JS constants for DAG node type styling,
   confidence tiers, and card layout.
   ═══════════════════════════════════════════════════════════ */

export const DAG_NODE_TYPE_COLORS: Record<string, { bg: string; border: string; accent: string; dark: { bg: string; border: string; accent: string } }> = {
  claim: { bg: '#fefce8', border: '#eab308', accent: '#ca8a04', dark: { bg: '#422006', border: '#eab308', accent: '#facc15' } },
  evidence: { bg: '#eff6ff', border: '#3b82f6', accent: '#2563eb', dark: { bg: '#172554', border: '#3b82f6', accent: '#60a5fa' } },
  rebuttal: { bg: '#fef2f2', border: '#ef4444', accent: '#dc2626', dark: { bg: '#450a0a', border: '#ef4444', accent: '#f87171' } },
  support: { bg: '#f0fdf4', border: '#22c55e', accent: '#16a34a', dark: { bg: '#052e16', border: '#22c55e', accent: '#4ade80' } },
  verdict: { bg: '#faf5ff', border: '#a855f7', accent: '#9333ea', dark: { bg: '#3b0764', border: '#a855f7', accent: '#c084fc' } },
  default: { bg: '#f8fafc', border: '#94a3b8', accent: '#64748b', dark: { bg: '#1e293b', border: '#94a3b8', accent: '#cbd5e1' } },
};

export const DAG_CONFIDENCE_TIERS = {
  high: { color: '#16a34a', label: 'High' },
  medium: { color: '#eab308', label: 'Medium' },
  low: { color: '#ef4444', label: 'Low' },
} as const;

export const DAG_CARD_STYLES = {
  borderRadius: 12,
  hoverShadow: '0 4px 12px rgba(0,0,0,0.08)',
  accentWidth: 4,
  maxSummaryLines: 2,
} as const;

export function resolveDAGNodeColors(nodeType: string, theme: 'light' | 'dark') {
  const colors = DAG_NODE_TYPE_COLORS[nodeType] ?? DAG_NODE_TYPE_COLORS.default;
  return theme === 'dark' ? colors.dark : colors;
}
