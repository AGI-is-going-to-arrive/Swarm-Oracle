import { describe, it, expect } from 'vitest';
import { getFormatForRecipe, getCastForRecipe, SELECTION_TO_FORMAT, SELECTION_TO_CAST } from './roundtableFormatHelpers';

describe('roundtableFormatHelpers', () => {
  it('maps all 6 recipes to format', () => {
    expect(getFormatForRecipe('representative')).toBe('deep_dive');
    expect(getFormatForRecipe('manual_shortlist')).toBe('deep_dive');
    expect(getFormatForRecipe('expert_witness')).toBe('deep_dive');
    expect(getFormatForRecipe('trait_mix')).toBe('clash_mode');
    expect(getFormatForRecipe('fault_line_first')).toBe('clash_mode');
    expect(getFormatForRecipe('witness_augmented')).toBe('deep_dive');
  });

  it('maps all 6 recipes to cast mode', () => {
    expect(getCastForRecipe('representative')).toBe('smart_pick');
    expect(getCastForRecipe('manual_shortlist')).toBe('custom');
    expect(getCastForRecipe('expert_witness')).toBe('custom');
    expect(getCastForRecipe('trait_mix')).toBe('smart_pick');
    expect(getCastForRecipe('fault_line_first')).toBe('smart_pick');
    expect(getCastForRecipe('witness_augmented')).toBe('custom');
  });

  it('falls back for unknown recipe', () => {
    expect(getFormatForRecipe('unknown')).toBe('deep_dive');
    expect(getCastForRecipe('unknown')).toBe('smart_pick');
  });

  it('maps cover all 6 known recipes', () => {
    expect(Object.keys(SELECTION_TO_FORMAT)).toHaveLength(6);
    expect(Object.keys(SELECTION_TO_CAST)).toHaveLength(6);
  });
});
