import { describe, it, expect } from 'vitest';
import {
  buildEndingAnchorId,
  buildEndingInsightPrompt,
  buildEndingQuotePrompt,
  buildEndingVerdictPrompt,
  describeEndingAnchor,
  getAllPresentModeLabel,
  getArchivistModeLabel,
  getHotseatModeLabel,
  getInteractionModeNote,
  roleLabel,
  scopeText,
  threadLabel,
  trimQuoteSnippet,
} from './endingChatHelpers';

describe('endingChatHelpers', () => {
  describe('roleLabel', () => {
    it('returns archivist label', () => {
      expect(roleLabel({ role_slot: 'archivist' } as never, true)).toBe('档案官');
      expect(roleLabel({ role_slot: 'archivist' } as never, false)).toBe('Archivist');
    });
    it('returns user label', () => {
      expect(roleLabel({ role_slot: 'user' } as never, false)).toBe('You');
    });
    it('returns default for unknown slot', () => {
      expect(roleLabel({ role_slot: 'unknown' } as never, false)).toBe('Current worldline');
    });
  });

  describe('threadLabel', () => {
    it('appends main chamber for room mode', () => {
      const label = threadLabel({ mode: 'room', title: 'Chamber' } as never, true);
      expect(label).toBe('Chamber · 主厅');
    });
    it('returns title for followup mode', () => {
      expect(threadLabel({ mode: 'followup', title: 'Thread' } as never, false)).toBe('Thread');
    });
  });

  describe('scopeText', () => {
    it('returns scope notice text when matching', () => {
      const thread = { id: 't1', mode: 'followup' } as never;
      const notice = { threadId: 't1', memoryPartitionId: 'p1' };
      expect(scopeText(thread, notice, false)).toContain('follow-up thread');
    });
    it('returns default scope text', () => {
      expect(scopeText(undefined, null, false)).toContain('worldline');
    });
  });

  describe('mode labels', () => {
    it('returns correct zh labels', () => {
      expect(getArchivistModeLabel(true)).toBe('档案官主持');
      expect(getHotseatModeLabel(true)).toBe('点名角色');
      expect(getAllPresentModeLabel(true)).toBe('当前阵容回应');
    });
  });

  describe('getInteractionModeNote', () => {
    it('handles all modes', () => {
      expect(getInteractionModeNote('hotseat', false, 'Bob')).toContain('Bob');
      expect(getInteractionModeNote('all_present', false)).toContain('lineup');
      expect(getInteractionModeNote('thread_followup', false)).toContain('thread');
      expect(getInteractionModeNote('epilogue', false)).toContain('3 turns');
      expect(getInteractionModeNote('evidence_card', false)).toContain('evidence');
      expect(getInteractionModeNote('archivist_route', false)).toContain('Archivist');
    });
    it('handles hotseat without name', () => {
      expect(getInteractionModeNote('hotseat', false)).toContain('one role');
    });
  });

  describe('buildEndingVerdictPrompt', () => {
    it('includes summary when present', () => {
      expect(buildEndingVerdictPrompt('War ended', false)).toContain('War ended');
    });
    it('uses fallback for empty', () => {
      expect(buildEndingVerdictPrompt('', true)).toContain('结论');
    });
  });

  describe('buildEndingInsightPrompt', () => {
    it('includes insight text', () => {
      expect(buildEndingInsightPrompt('Key turning point', false)).toContain('Key turning point');
    });
    it('uses fallback for empty', () => {
      expect(buildEndingInsightPrompt('', false)).toContain('hinge');
    });
  });

  describe('buildEndingAnchorId', () => {
    it('builds without extra', () => {
      expect(buildEndingAnchorId('verdict', 'room1')).toBe('ending:verdict:room1');
    });
    it('builds with extra', () => {
      expect(buildEndingAnchorId('key_moment', 'room1', 3)).toBe('ending:key_moment:room1:3');
    });
  });

  describe('trimQuoteSnippet', () => {
    it('passes through short text', () => {
      expect(trimQuoteSnippet('short')).toBe('short');
    });
    it('truncates long text', () => {
      const result = trimQuoteSnippet('A'.repeat(200), 50);
      expect(result.length).toBeLessThanOrEqual(52);
    });
  });

  describe('buildEndingQuotePrompt', () => {
    it('includes speaker and content', () => {
      const prompt = buildEndingQuotePrompt('Alice', 'Something important', false);
      expect(prompt).toContain('Alice');
      expect(prompt).toContain('Something important');
    });
  });

  describe('describeEndingAnchor', () => {
    it('returns null for empty/null', () => {
      expect(describeEndingAnchor([], false, [], [])).toBeNull();
      expect(describeEndingAnchor(null, false, [], [])).toBeNull();
    });
    it('parses verdict anchor', () => {
      const result = describeEndingAnchor(['ending:verdict:room1'], false, [], []);
      expect(result?.kind).toBe('verdict');
    });
    it('parses key_moment anchor with moment text', () => {
      const result = describeEndingAnchor(['ending:key_moment:room1:0'], false, ['Alliance formed'], []);
      expect(result?.label).toContain('Alliance formed');
    });
    it('parses quote anchor with turn content', () => {
      const result = describeEndingAnchor(
        ['ending:quote:room1:turn-5'],
        false,
        [],
        [{ key: 'turn-5', content: 'This was the key decision' }],
      );
      expect(result?.label).toContain('This was the key decision');
    });
    it('handles non-ending domain', () => {
      const result = describeEndingAnchor(['other:x:y'], false, [], []);
      expect(result?.kind).toBe('unknown');
    });
  });
});
