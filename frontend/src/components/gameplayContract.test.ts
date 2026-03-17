import { describe, expect, it } from 'vitest';

import { GAMEPLAY_CONTRACT } from '../lib/gameplayContract';

describe('gameplay contract', () => {
  it('defines cost, cooldown, and animation for every card', () => {
    for (const card of GAMEPLAY_CONTRACT.cards) {
      expect(card.cost).toBeGreaterThanOrEqual(0);
      expect(card.cooldown_rounds).toBeGreaterThanOrEqual(0);
      expect(card.auto_cooldown_rounds).toBeGreaterThanOrEqual(0);
      expect(card.animation_key).toBeTruthy();
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
