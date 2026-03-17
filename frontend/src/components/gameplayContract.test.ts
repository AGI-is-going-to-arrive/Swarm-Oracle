import { describe, expect, it } from 'vitest';

import { GAMEPLAY_CONTRACT } from '../lib/gameplayContract';

describe('gameplay contract', () => {
  it('defines cost, cooldown, and animation for every card', () => {
    for (const card of GAMEPLAY_CONTRACT.cards) {
      expect(card.cost).toBeGreaterThanOrEqual(0);
      expect(card.cooldown_rounds).toBeGreaterThanOrEqual(0);
      expect(card.auto_cooldown_rounds).toBeGreaterThanOrEqual(0);
      expect(card.animation_key).toBeTruthy();
      expect(card.branching_bonus).toBeGreaterThanOrEqual(0);
    }
  });

  it('defines modal input rules and prompt lines for every card', () => {
    for (const card of GAMEPLAY_CONTRACT.cards) {
      expect(typeof card.ui.requires_primary_agent).toBe('boolean');
      expect(typeof card.ui.requires_secondary_agent).toBe('boolean');
      expect(typeof card.ui.requires_source_branch).toBe('boolean');
      expect(card.ui.placeholder.zh.length).toBeGreaterThan(0);
      expect(card.ui.placeholder.en.length).toBeGreaterThan(0);
      expect(card.prompt_lines.zh.length).toBeGreaterThan(0);
      expect(card.prompt_lines.en.length).toBeGreaterThan(0);
    }
  });

  it('keeps profile recommendations inside the known card set', () => {
    const cardIds = new Set(GAMEPLAY_CONTRACT.cards.map((card) => card.id));
    for (const profile of GAMEPLAY_CONTRACT.profiles) {
      for (const cardId of profile.recommended_cards) {
        expect(cardIds.has(cardId)).toBe(true);
      }
    }
  });
});
