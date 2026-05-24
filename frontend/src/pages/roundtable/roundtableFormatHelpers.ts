import type { RoundtableDiscussionFormat, RoundtableCastMode } from '../../types';

// Selection recipe to discussion format mapping
export const SELECTION_TO_FORMAT: Record<string, RoundtableDiscussionFormat> = {
  representative: 'deep_dive',
  manual_shortlist: 'deep_dive',
  expert_witness: 'deep_dive',
  trait_mix: 'clash_mode',
  fault_line_first: 'clash_mode',
  witness_augmented: 'deep_dive',
};

// Selection recipe to cast mode mapping
export const SELECTION_TO_CAST: Record<string, RoundtableCastMode> = {
  representative: 'smart_pick',
  manual_shortlist: 'custom',
  expert_witness: 'custom',
  trait_mix: 'smart_pick',
  fault_line_first: 'smart_pick',
  witness_augmented: 'custom',
};

export function getFormatForRecipe(recipe: string): RoundtableDiscussionFormat {
  return SELECTION_TO_FORMAT[recipe] ?? 'deep_dive';
}

export function getCastForRecipe(recipe: string): RoundtableCastMode {
  return SELECTION_TO_CAST[recipe] ?? 'smart_pick';
}
