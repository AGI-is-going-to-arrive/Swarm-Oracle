import { describe, it, expect } from 'vitest';
import {
  branchListChanged,
  buildDefaultManualShortlist,
  buildRoundtableAnchorId,
  buildRoundtablePhasePrompt,
  buildRoundtableQuotePrompt,
  buildRoundtableVerdictPrompt,
  chooseWitnessAugmentedSelection,
  describeRoundtableAnchor,
  getArchivistModeLabel,
  getParticipantImpactScore,
  getRepresentativeHotseatLabel,
  getRoundtableModeNote,
  getSelectionReasonLabel,
  getThreadLabel,
  isRoundtableParticipant,
  normalizeManualShortlist,
  sameWitnessSelection,
  trimQuoteSnippet,
} from './roundtableHelpers';

describe('roundtableHelpers', () => {
  describe('isRoundtableParticipant', () => {
    it('returns true for representative role_slot', () => {
      expect(isRoundtableParticipant({ role_slot: 'representative' } as never)).toBe(true);
    });
    it('returns false for archivist role_slot', () => {
      expect(isRoundtableParticipant({ role_slot: 'archivist' } as never)).toBe(false);
    });
  });

  describe('getThreadLabel', () => {
    it('returns main table label for room thread in zh', () => {
      expect(getThreadLabel({ mode: 'room', title: 'Table 1' } as never, true)).toBe('主桌记录');
    });
    it('returns thread title for non-room thread', () => {
      expect(getThreadLabel({ mode: 'followup', title: 'Thread A' } as never, false)).toBe('Thread A');
    });
  });

  describe('getParticipantImpactScore', () => {
    it('extracts impact_score from persona snapshot', () => {
      expect(getParticipantImpactScore({ persona_snapshot_json: { impact_score: 0.85 } } as never)).toBe(0.85);
    });
    it('returns 0 when persona_snapshot_json is null', () => {
      expect(getParticipantImpactScore({ persona_snapshot_json: null } as never)).toBe(0);
    });
  });

  describe('getSelectionReasonLabel', () => {
    it('returns localized label for user_selected', () => {
      expect(getSelectionReasonLabel('user_selected', true)).toBe('你点的');
      expect(getSelectionReasonLabel('user_selected', false)).toBe('Your pick');
    });
    it('returns localized label for top_impact', () => {
      expect(getSelectionReasonLabel('top_impact', false)).toBe('High impact');
    });
    it('returns empty string for empty reason', () => {
      expect(getSelectionReasonLabel('', true)).toBe('');
    });
    it('returns fallback for unknown reason', () => {
      expect(getSelectionReasonLabel('custom_reason', false)).toBe('custom_reason');
    });
  });

  describe('getArchivistModeLabel / getRepresentativeHotseatLabel', () => {
    it('returns zh labels', () => {
      expect(getArchivistModeLabel(true)).toBe('档案官主持');
      expect(getRepresentativeHotseatLabel(true)).toBe('点名代表');
    });
    it('returns en labels', () => {
      expect(getArchivistModeLabel(false)).toBe('Archivist lead');
      expect(getRepresentativeHotseatLabel(false)).toBe('Question one representative');
    });
  });

  describe('getRoundtableModeNote', () => {
    it('returns hotseat note with selected name', () => {
      const note = getRoundtableModeNote('hotseat', true, 'Alice');
      expect(note).toContain('Alice');
    });
    it('returns archivist_route default note', () => {
      const note = getRoundtableModeNote('archivist_route', false);
      expect(note).toContain('Archivist');
    });
    it('returns thread_followup note', () => {
      const note = getRoundtableModeNote('thread_followup', false);
      expect(note).toContain('follow-up thread');
    });
  });

  describe('buildRoundtableVerdictPrompt', () => {
    it('builds prompt with summary in zh', () => {
      expect(buildRoundtableVerdictPrompt('和平收束', true)).toContain('和平收束');
    });
    it('builds fallback prompt for empty summary', () => {
      expect(buildRoundtableVerdictPrompt('', false)).toContain('roundtable settle');
    });
  });

  describe('buildRoundtablePhasePrompt', () => {
    it('includes phase label and stakes', () => {
      const prompt = buildRoundtablePhasePrompt('Opening', 'Resource allocation', false);
      expect(prompt).toContain('Opening');
      expect(prompt).toContain('Resource allocation');
    });
  });

  describe('buildRoundtableAnchorId', () => {
    it('builds id without extra', () => {
      expect(buildRoundtableAnchorId('verdict', 'room1')).toBe('roundtable:verdict:room1');
    });
    it('builds id with extra', () => {
      expect(buildRoundtableAnchorId('phase', 'room1', 2)).toBe('roundtable:phase:room1:2');
    });
  });

  describe('trimQuoteSnippet', () => {
    it('returns short text unchanged', () => {
      expect(trimQuoteSnippet('Hello world')).toBe('Hello world');
    });
    it('truncates long text with ellipsis', () => {
      const long = 'A'.repeat(200);
      const trimmed = trimQuoteSnippet(long, 50);
      expect(trimmed.length).toBeLessThanOrEqual(52); // 50 + ellipsis char
      expect(trimmed).toContain('…');
    });
    it('normalizes whitespace', () => {
      expect(trimQuoteSnippet('  hello   world  ')).toBe('hello world');
    });
  });

  describe('buildRoundtableQuotePrompt', () => {
    it('includes speaker and snippet', () => {
      const prompt = buildRoundtableQuotePrompt('Alice', 'This is a test', false);
      expect(prompt).toContain('Alice');
      expect(prompt).toContain('This is a test');
    });
  });

  describe('branchListChanged', () => {
    it('returns false for identical arrays', () => {
      expect(branchListChanged(['a', 'b'], ['a', 'b'])).toBe(false);
    });
    it('returns true for different lengths', () => {
      expect(branchListChanged(['a'], ['a', 'b'])).toBe(true);
    });
    it('returns true for different content', () => {
      expect(branchListChanged(['a', 'b'], ['a', 'c'])).toBe(true);
    });
  });

  describe('sameWitnessSelection', () => {
    it('returns true for identical selections', () => {
      const sel = { branchId: 'b1', agentId: 'a1' };
      expect(sameWitnessSelection(sel, sel)).toBe(true);
    });
    it('returns true for equal values', () => {
      expect(sameWitnessSelection(
        { branchId: 'b1', agentId: 'a1' },
        { branchId: 'b1', agentId: 'a1' },
      )).toBe(true);
    });
    it('returns false for different values', () => {
      expect(sameWitnessSelection(
        { branchId: 'b1', agentId: 'a1' },
        { branchId: 'b2', agentId: 'a1' },
      )).toBe(false);
    });
    it('returns false when one is null', () => {
      expect(sameWitnessSelection(null, { branchId: 'b1', agentId: 'a1' })).toBe(false);
    });
    it('returns true when both are null', () => {
      expect(sameWitnessSelection(null, null)).toBe(true);
    });
  });

  describe('normalizeManualShortlist', () => {
    it('filters and preserves order', () => {
      expect(normalizeManualShortlist(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
    });
    it('drops ids not in branchOrder', () => {
      expect(normalizeManualShortlist(['a', 'b'], ['a', 'x'])).toEqual(['a']);
    });
  });

  describe('buildDefaultManualShortlist', () => {
    it('takes first 2 branches', () => {
      expect(buildDefaultManualShortlist(['a', 'b', 'c'])).toEqual(['a', 'b']);
    });
    it('handles fewer than 2 branches', () => {
      expect(buildDefaultManualShortlist(['a'])).toEqual(['a']);
    });
  });

  describe('chooseWitnessAugmentedSelection', () => {
    it('picks highest impact from a different branch', () => {
      const result = chooseWitnessAugmentedSelection([
        { branchId: 'b1', agentId: 'a1', branchTitle: '', name: 'A', role: '', impactScore: 0.9 },
        { branchId: 'b2', agentId: 'a2', branchTitle: '', name: 'B', role: '', impactScore: 0.8 },
        { branchId: 'b1', agentId: 'a3', branchTitle: '', name: 'C', role: '', impactScore: 0.7 },
      ]);
      expect(result).toEqual({ branchId: 'b2', agentId: 'a2' });
    });
    it('returns null for empty list', () => {
      expect(chooseWitnessAugmentedSelection([])).toBeNull();
    });
  });

  describe('describeRoundtableAnchor', () => {
    const t = (key: string) => key;
    it('returns null for empty anchorIds', () => {
      expect(describeRoundtableAnchor([], false, [], [], t)).toBeNull();
    });
    it('returns null for null anchorIds', () => {
      expect(describeRoundtableAnchor(null, false, [], [], t)).toBeNull();
    });
    it('parses verdict anchor', () => {
      const result = describeRoundtableAnchor(['roundtable:verdict:room1'], false, [], [], t);
      expect(result?.kind).toBe('verdict');
      expect(result?.kindLabel).toBe('Archive verdict');
    });
    it('parses phase anchor with insight', () => {
      const result = describeRoundtableAnchor(
        ['roundtable:phase:room1:opening-0'],
        false,
        [{ phase: 'opening', stakes: 'Resource fight' }],
        [],
        t,
      );
      expect(result?.kind).toBe('phase');
      expect(result?.label).toContain('Resource fight');
    });
    it('handles non-roundtable domain', () => {
      const result = describeRoundtableAnchor(['other:verdict:x'], false, [], [], t);
      expect(result?.kind).toBe('unknown');
    });
  });
});
