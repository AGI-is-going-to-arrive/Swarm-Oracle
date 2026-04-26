import { describe, expect, it } from 'vitest';
import { resolveDAGNodeColors, DAG_NODE_TYPE_COLORS } from './dagEditorialTokens';

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
