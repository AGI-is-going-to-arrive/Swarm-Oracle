/* ═══════════════════════════════════════════════════════════
   S2-4 — Decision Bias constants & helpers (non-component module)
   Split out from DecisionBiasSlider.tsx to satisfy
   `react-refresh/only-export-components`.
   ═══════════════════════════════════════════════════════════ */

/** Canonical 5 decision_bias keys, must match backend `DECISION_BIAS_KEYS`. */
export const DECISION_BIAS_KEYS = [
  'caution',
  'optimism',
  'conservatism',
  'risk_tolerance',
  'creativity',
] as const;

export type DecisionBiasKey = (typeof DECISION_BIAS_KEYS)[number];

/** Default value for any missing key (matches backend `validate_decision_bias`). */
export const DECISION_BIAS_DEFAULT = 0.5;

/** Clamp a number into [0, 1] and coerce non-finite values to default. */
export function clampBias(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DECISION_BIAS_DEFAULT;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/** Build a complete record by merging supplied values over defaults (all 5 keys = 0.5). */
export function withDecisionBiasDefaults(
  partial: Record<string, unknown> | null | undefined,
): Record<DecisionBiasKey, number> {
  const out = {} as Record<DecisionBiasKey, number>;
  for (const key of DECISION_BIAS_KEYS) {
    out[key] = clampBias(partial?.[key]);
  }
  return out;
}
