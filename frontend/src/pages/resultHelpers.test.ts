import { describe, it, expect, beforeEach } from 'vitest';
import { ApiError } from '../api/client';
import {
  buildMomentHighlights,
  buildCampaignFinalizeCacheEntryKey,
  buildCampaignSummaryFromExistingData,
  buildStoryKeyMoments,
  classifyCampaignFinalizeError,
  getBetOutcomeClass,
  getBetOutcomeLabel,
  getCampaignBadgeCopy,
  getCampaignBoundaryMessage,
  getEndingRoomCandidateAvatar,
  readCachedCampaignFinalizeResult,
  writeCachedCampaignFinalizeResult,
} from './resultHelpers';

describe('resultHelpers', () => {
  describe('buildCampaignFinalizeCacheEntryKey', () => {
    it('joins three parts with ::', () => {
      expect(buildCampaignFinalizeCacheEntryKey('s1', 'u1', 'p1')).toBe('s1::u1::p1');
    });
  });

  describe('getBetOutcomeLabel', () => {
    const t = (key: string) => key;
    it('maps hit/miss/pending', () => {
      expect(getBetOutcomeLabel('hit', t)).toBe('result.bet_status_hit');
      expect(getBetOutcomeLabel('miss', t)).toBe('result.bet_status_miss');
      expect(getBetOutcomeLabel('pending', t)).toBe('result.bet_status_pending');
    });
  });

  describe('getBetOutcomeClass', () => {
    it('returns correct class names', () => {
      expect(getBetOutcomeClass('hit')).toBe('bet-outcome-chip bet-outcome-chip--hit');
      expect(getBetOutcomeClass('miss')).toBe('bet-outcome-chip bet-outcome-chip--miss');
    });
  });

  describe('getEndingRoomCandidateAvatar', () => {
    it('returns a path with .png extension', () => {
      const path = getEndingRoomCandidateAvatar('diplomat', 'Alice');
      expect(path).toMatch(/^\/assets\/characters\/.*\.png$/);
    });
  });

  describe('getCampaignBadgeCopy', () => {
    it('returns known badge in zh', () => {
      const copy = getCampaignBadgeCopy('daily_challenge', true);
      expect(copy).toEqual({ label: '每日挑战', description: expect.any(String) });
    });
    it('returns known badge in en', () => {
      const copy = getCampaignBadgeCopy('bet_winner', false);
      expect(copy).toEqual({ label: 'Bet Winner', description: expect.any(String) });
    });
    it('returns fallback for unknown badge', () => {
      const copy = getCampaignBadgeCopy('unknown_badge', false);
      expect(copy).toEqual({ label: 'unknown_badge', description: expect.any(String) });
    });
  });

  describe('classifyCampaignFinalizeError', () => {
    it('returns missing for 404', () => {
      expect(classifyCampaignFinalizeError(new ApiError(404, 'not_found', 'Not found'))).toBe('missing');
    });
    it('returns conflict for 409', () => {
      expect(classifyCampaignFinalizeError(new ApiError(409, 'conflict', 'Conflict'))).toBe('conflict');
    });
    it('returns other for generic errors', () => {
      expect(classifyCampaignFinalizeError(new Error('fail'))).toBe('other');
    });
  });

  describe('getCampaignBoundaryMessage', () => {
    it('returns message for missing', () => {
      expect(getCampaignBoundaryMessage('missing', false)).toContain('temporary');
    });
    it('returns message for conflict', () => {
      expect(getCampaignBoundaryMessage('conflict', true)).toContain('另一位');
    });
  });

  describe('buildStoryKeyMoments', () => {
    it('deduplicates moments across branches', () => {
      const story = {
        branches: [
          { key_moments: ['A', 'B'] },
          { key_moments: ['B', 'C'] },
        ],
      } as never;
      expect(buildStoryKeyMoments(story)).toEqual(['A', 'B', 'C']);
    });
    it('filters empty moments', () => {
      const story = { branches: [{ key_moments: ['A', '', '  '] }] } as never;
      expect(buildStoryKeyMoments(story)).toEqual(['A']);
    });
  });

  describe('buildMomentHighlights', () => {
    it('turns encoded gameplay records into useful debrief moments', () => {
      expect(buildMomentHighlights([
        'event:card:2:public_hearing',
        'event:bet:3:Archive%20Branch',
        'event:commitment:4:Archive%20Branch',
      ], false)).toEqual([
        expect.objectContaining({
          kind: 'card',
          label: 'Public Hearing',
          round: 2,
        }),
        expect.objectContaining({
          kind: 'bet',
          label: 'Archive Branch',
          round: 3,
        }),
        expect.objectContaining({
          kind: 'commitment',
          label: 'Archive Branch',
          round: 4,
        }),
      ]);
    });

    it('keeps raw story moments and removes duplicates', () => {
      expect(buildMomentHighlights(['Same hinge', 'Same hinge', 'Another hinge'], true)).toEqual([
        expect.objectContaining({ kind: 'story', label: 'Same hinge' }),
        expect.objectContaining({ kind: 'story', label: 'Another hinge' }),
      ]);
    });
  });

  describe('sessionStorage cache', () => {
    beforeEach(() => {
      window.sessionStorage.clear();
    });

    it('round-trips a finalize result', () => {
      const result = {
        scenario_id: 's1',
        already_finalized: false,
        campaign_score_delta: 10,
        profile: {},
        mastery: {},
        badges: [],
        newly_unlocked_badges: [],
      } as never;
      writeCachedCampaignFinalizeResult('s1', 'u1', 'p1', result);
      const read = readCachedCampaignFinalizeResult('s1', 'u1', 'p1');
      expect(read).toEqual(result);
    });

    it('returns null for missing cache', () => {
      expect(readCachedCampaignFinalizeResult('s1', 'u1', 'p1')).toBeNull();
    });

    it('returns null for scenario_id mismatch', () => {
      const result = { scenario_id: 'other' } as never;
      writeCachedCampaignFinalizeResult('s1', 'u1', 'p1', result);
      expect(readCachedCampaignFinalizeResult('s1', 'u1', 'p1')).toBeNull();
    });
  });

  describe('buildCampaignSummaryFromExistingData', () => {
    it('returns null when mastery not found', () => {
      const result = buildCampaignSummaryFromExistingData(
        { scenario_id: 's1', profile_id: 'p1', campaign_score_delta: 5 } as never,
        {} as never,
        [],
        [],
      );
      expect(result).toBeNull();
    });

    it('builds summary when mastery matches', () => {
      const result = buildCampaignSummaryFromExistingData(
        { scenario_id: 's1', profile_id: 'p1', campaign_score_delta: 5 } as never,
        { profile_id: 'p1' } as never,
        [{ profile_id: 'p1', level: 2 }] as never,
        [],
      );
      expect(result).not.toBeNull();
      expect(result!.already_finalized).toBe(true);
      expect(result!.scenario_id).toBe('s1');
      expect(result!.score_breakdown).toEqual([]);
    });
  });
});
