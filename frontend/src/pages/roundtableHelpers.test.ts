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
      expect(getThreadLabel({ mode: 'room', title: 'Table 1' } as never, true)).toBe('主桌讨论');
    });
    it('uses translator for main table label', () => {
      expect(getThreadLabel(
        { mode: 'room', title: 'Table 1' } as never,
        false,
        ((key: string) => `t:${key}`) as never,
      )).toBe('t:roundtable.thread_main_table');
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
      expect(getSelectionReasonLabel('user_selected', true)).toBe('你选的');
      expect(getSelectionReasonLabel('user_selected', false)).toBe('Your pick');
    });
    it('returns localized label for top_impact', () => {
      expect(getSelectionReasonLabel('top_impact', false)).toBe('High impact');
    });
    it('uses translator for known selection reasons', () => {
      expect(getSelectionReasonLabel(
        'fallback',
        false,
        ((key: string) => `t:${key}`) as never,
      )).toBe('t:roundtable.selection_reason_fallback');
    });
    it('returns localized label for new fallback reasons', () => {
      const t = ((key: string) => `t:${key}`) as never;
      expect(getSelectionReasonLabel('witness_augmented', false, t)).toBe('t:roundtable.selection_reason_witness_augmented');
      expect(getSelectionReasonLabel('expert_witness', false, t)).toBe('t:roundtable.selection_reason_expert_witness');
      expect(getSelectionReasonLabel('trait_mix', false, t)).toBe('t:roundtable.selection_reason_trait_mix');
      expect(getSelectionReasonLabel('fault_line_first', false, t)).toBe('t:roundtable.selection_reason_fault_line_first');
    });
    it('returns empty string for empty reason', () => {
      expect(getSelectionReasonLabel('', true)).toBe('');
    });
    it('returns fallback for unknown reason replacing underscores', () => {
      expect(getSelectionReasonLabel('custom_reason', false)).toBe('custom reason');
    });
  });

  describe('getArchivistModeLabel / getRepresentativeHotseatLabel', () => {
    it('returns zh labels', () => {
      expect(getArchivistModeLabel(true)).toBe('主持人引导');
      expect(getRepresentativeHotseatLabel(true)).toBe('单独追问');
    });
    it('returns en labels', () => {
      expect(getArchivistModeLabel(false)).toBe('Host-guided');
      expect(getRepresentativeHotseatLabel(false)).toBe('Question one rep');
    });
    it('uses translator labels', () => {
      const t = ((key: string) => `t:${key}`) as never;
      expect(getArchivistModeLabel(false, t)).toBe('t:roundtable.host_guided_label');
      expect(getRepresentativeHotseatLabel(false, t)).toBe('t:roundtable.hotseat_question_one');
    });
  });

  describe('getRoundtableModeNote', () => {
    it('returns hotseat note with selected name', () => {
      const note = getRoundtableModeNote('hotseat', true, 'Alice');
      expect(note).toContain('Alice');
    });
    it('returns archivist_route default note', () => {
      const note = getRoundtableModeNote('archivist_route', false);
      expect(note).toContain('host');
    });
    it('returns thread_followup note', () => {
      const note = getRoundtableModeNote('thread_followup', false);
      expect(note).toContain('thread');
    });
    it('uses translator for mode notes', () => {
      const t = ((key: string, options?: { name?: string }) => `${key}:${options?.name ?? ''}`) as never;
      expect(getRoundtableModeNote('hotseat', false, 'Alice', t)).toBe(
        'roundtable.mode_note_hotseat_named:Alice',
      );
      expect(getRoundtableModeNote('thread_followup', false, null, t)).toBe(
        'roundtable.mode_note_thread_followup:',
      );
    });
  });

  describe('buildRoundtableVerdictPrompt', () => {
    it('builds prompt with summary in zh', () => {
      expect(buildRoundtableVerdictPrompt('和平收束', true)).toContain('和平收束');
      expect(buildRoundtableVerdictPrompt('和平收束', true)).not.toContain('最终结论');
    });
    it('builds fallback prompt for empty summary', () => {
      expect(buildRoundtableVerdictPrompt('', false)).toContain('roundtable reach');
    });
    it('uses translator for verdict prompt', () => {
      const t = ((key: string, options?: { summary?: string }) => `${key}:${options?.summary ?? ''}`) as never;
      expect(buildRoundtableVerdictPrompt('Final split', false, t)).toBe(
        'roundtable.verdict_prompt:Final split',
      );
    });
  });

  describe('buildRoundtablePhasePrompt', () => {
    it('includes phase label and stakes', () => {
      const prompt = buildRoundtablePhasePrompt('Opening', 'Resource allocation', false);
      expect(prompt).toContain('Opening');
      expect(prompt).toContain('Resource allocation');
      expect(buildRoundtablePhasePrompt('Opening', '', false)).not.toContain('disagreement');
    });
    it('compacts long phase context before using it as a prompt draft', () => {
      const prompt = buildRoundtablePhasePrompt(
        '开场',
        '真正的分歧是汉中粮道是否还能撑住。后面这整段如果原样进入输入框，就会像把 transcript 又复读一遍，显得非常机械。',
        true,
      );

      expect(prompt).toContain('开场');
      expect(prompt).toContain('汉中粮道');
      expect(prompt).not.toContain('transcript 又复读一遍');
      expect(prompt.length).toBeLessThan(90);
    });
    it('uses translator for phase prompt', () => {
      const t = ((key: string, options?: { label?: string; stakes?: string }) => (
        `${key}:${options?.label ?? ''}:${options?.stakes ?? ''}`
      )) as never;
      expect(buildRoundtablePhasePrompt('Opening', 'Resource allocation', false, t)).toBe(
        'roundtable.phase_prompt:Opening:Resource allocation',
      );
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
      expect(prompt).toContain('expand');
    });
    it('uses translator for quote prompt', () => {
      const t = ((key: string, options?: { speaker?: string; snippet?: string }) => (
        `${key}:${options?.speaker ?? ''}:${options?.snippet ?? ''}`
      )) as never;
      expect(buildRoundtableQuotePrompt('Alice', 'This is a test', false, t)).toBe(
        'roundtable.quote_prompt:Alice:This is a test',
      );
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
    const t = ((key: string) => {
      const dict: Record<string, string> = {
        'roundtable.anchor_kind_verdict': 'Verdict',
        'roundtable.anchor_kind_phase': 'Phase',
        'roundtable.anchor_kind_quote': 'Quote',
        'roundtable.anchor_kind_default': 'Anchor',
      };
      return dict[key] ?? key;
    }) as unknown as import('i18next').TFunction;
    it('returns null for empty anchorIds', () => {
      expect(describeRoundtableAnchor([], false, [], [], t)).toBeNull();
    });
    it('returns null for null anchorIds', () => {
      expect(describeRoundtableAnchor(null, false, [], [], t)).toBeNull();
    });
    it('parses verdict anchor', () => {
      const result = describeRoundtableAnchor(['roundtable:verdict:room1'], false, [], [], t);
      expect(result?.kind).toBe('verdict');
      expect(result?.kindLabel).toBe('Verdict');
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
    it('falls back to raw phase label for unknown phase anchors', () => {
      const calls: string[] = [];
      const trackingT = ((key: string) => {
        calls.push(key);
        return key === 'roundtable.anchor_kind_phase' ? 'Phase' : key;
      }) as unknown as import('i18next').TFunction;
      const result = describeRoundtableAnchor(
        ['roundtable:phase:room1:not-a-phase-0'],
        false,
        [],
        [],
        trackingT,
      );
      expect(result?.kind).toBe('phase');
      expect(result?.label).toBe('not-a-phase');
      expect(calls).toContain('roundtable.anchor_kind_phase');
      expect(calls).not.toContain('roundtable.phase_not-a-phase');
    });
    it('handles non-roundtable domain', () => {
      const result = describeRoundtableAnchor(['other:verdict:x'], false, [], [], t);
      expect(result?.kind).toBe('unknown');
    });
    it('falls back to raw phaseName when t is undefined', () => {
      const result = describeRoundtableAnchor(
        ['roundtable:phase:room1:opening-0'],
        false,
        [{ phase: 'opening', stakes: 'Resource fight' }],
        [],
        undefined,
      );
      expect(result?.kind).toBe('phase');
      expect(result?.kindLabel).toBe('Phase');
    });
  });
});
