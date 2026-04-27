import { describe, expect, it } from 'vitest';
import {
  resolveDAGNodeColors,
  DAG_NODE_TYPE_COLORS,
  resolveCausalNodeColors,
  CAUSAL_NODE_TYPE_COLORS,
} from './dagEditorialTokens';

describe('dagEditorialTokens', () => {
  it('resolveDAGNodeColors returns light theme by default', () => {
    const colors = resolveDAGNodeColors('claim', 'light');
    expect(colors.bg).toBe('#fefce8');
    expect(colors.border).toBe('#eab308');
    expect(colors.accent).toBe('#ca8a04');
  });

  it('resolveDAGNodeColors returns dark theme colors', () => {
    const colors = resolveDAGNodeColors('evidence', 'dark');
    expect(colors.bg).toBe('#172554');
    expect(colors.border).toBe('#3b82f6');
    expect(colors.accent).toBe('#60a5fa');
  });

  it('falls back to default for unknown node type', () => {
    const colors = resolveDAGNodeColors('totally_unknown_type', 'light');
    expect(colors).toEqual(DAG_NODE_TYPE_COLORS.default);
    expect(colors.bg).toBe('#f8fafc');
  });
});

describe('resolveCausalNodeColors', () => {
  it('maps known causal types to DAG colors', () => {
    for (const [causalType, dagType] of Object.entries(CAUSAL_NODE_TYPE_COLORS)) {
      const result = resolveCausalNodeColors(causalType, 'light');
      const expected = resolveDAGNodeColors(dagType, 'light');
      expect(result).toEqual(expected);
    }
  });

  it('returns dark theme variant', () => {
    const colors = resolveCausalNodeColors('fork', 'dark');
    expect(colors).toEqual(DAG_NODE_TYPE_COLORS.claim.dark);
  });

  it('falls back to default for unknown causal type', () => {
    const colors = resolveCausalNodeColors('custom_type', 'light');
    expect(colors).toEqual(DAG_NODE_TYPE_COLORS.default);
  });

  it('falls back to default for empty string', () => {
    const colors = resolveCausalNodeColors('', 'dark');
    expect(colors).toEqual(DAG_NODE_TYPE_COLORS.default.dark);
  });
});
