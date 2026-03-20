import { beforeEach, describe, expect, it } from 'vitest';

import { mergeScenarioMetaAuthority, resetScenarioMetaGameplayCompat } from './scenarioAuthority';
import { loadScenarioMeta } from './scenarioMeta';

describe('scenarioAuthority helpers', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      },
    });
  });

  it('drops local gameplay compat fields when remote gameplay authority is present', () => {
    const meta = loadScenarioMeta('scenario-authority-reset');
    meta.cards.usageLog = [
      {
        cardId: 'public_hearing',
        profileId: 'law',
        branchId: 'branch-1',
        branchTitle: 'Open Hearing',
        round: 2,
        cost: 1,
        directive: 'Expose the hidden exception clause.',
        usedAt: '2026-03-19T00:00:00Z',
      },
    ];
    meta.archive.keyMoments = [
      'plain compat moment',
      'event:card:2:public_hearing',
      'event:commitment:2:Open%20Hearing',
    ];

    const reset = resetScenarioMetaGameplayCompat(meta, {
      cards: { usage_log: [] },
      betting: { bets: [] },
      archive: { key_moments: [], branch_snapshots: [] },
    });

    expect(reset.cards.usageLog).toEqual([]);
    expect(reset.cooldowns).toEqual({});
    expect(reset.archive.keyMoments).toEqual([
      'plain compat moment',
      'event:commitment:2:Open%20Hearing',
    ]);
  });

  it('merges remote gameplay and director authority through one helper', () => {
    const meta = loadScenarioMeta('scenario-authority-merge');

    const merged = mergeScenarioMetaAuthority(
      meta,
      {
        cards: {
          usage_log: [
            {
              card_id: 'public_hearing',
              profile_id: 'law',
              branch_id: 'branch-1',
              branch_title: 'Open Hearing',
              round: 2,
              cost: 1,
              directive: 'Expose the hidden exception clause.',
              used_at: '2026-03-19T00:00:00Z',
            },
          ],
        },
        betting: { bets: [] },
        archive: { key_moments: [], branch_snapshots: [] },
      },
      {
        objectives: {
          generated_for_question: 'What if the archive had to sync?',
          generated_for_profile: 'law',
          goals: [
            {
              id: 'goal-1',
              kind: 'signature_arc_step',
              target_card_id: 'public_hearing',
              reward_label: 'director_point',
              created_at: '2026-03-19T00:00:00Z',
            },
          ],
          last_updated_at: '2026-03-19T00:00:00Z',
        },
        commitment: {
          active: true,
          branch_id: 'branch-1',
          branch_title: 'Open Hearing',
          committed_at_round: 2,
          committed_at: '2026-03-19T00:00:00Z',
          outcome: 'pending',
        },
      },
    );

    expect(merged.cards.usageLog).toHaveLength(1);
    expect(merged.objectives.goals).toHaveLength(1);
    expect(merged.commitment.branchTitle).toBe('Open Hearing');
    expect(merged.archive.profileId).toBe('law');
  });
});
