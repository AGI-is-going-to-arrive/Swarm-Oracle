import { beforeEach, describe, expect, it } from 'vitest';

import { clearPretextCache } from './pretext';
import {
  ORACLE_TEXT_LAYOUT_CONTRACTS,
  estimateBubbleHeight,
  estimateLineCount,
  predictTextOverflow,
} from './textOverflowPredictor';

describe('textOverflowPredictor', () => {
  beforeEach(() => {
    clearPretextCache();
  });

  it('keeps short result titles under the overflow budget', () => {
    const prediction = predictTextOverflow(
      'Archive Verdict',
      ORACLE_TEXT_LAYOUT_CONTRACTS.resultEndingTitle,
    );

    expect(prediction.overflow).toBe(false);
    expect(prediction.lineCount).toBe(1);
  });

  it('flags long bilingual result titles as overflow risks', () => {
    const prediction = predictTextOverflow(
      '如果金融防线和边疆补给同时失守，这条世界线是否还会把体面误当成稳定的最后借口，同时继续要求档案官替所有成本兜底并把错误包装成必然结局',
      ORACLE_TEXT_LAYOUT_CONTRACTS.resultEndingTitle,
    );

    expect(prediction.overflow).toBe(true);
    expect(prediction.overflowLines).toBeGreaterThan(0);
  });

  it('estimates taller draft bubbles for pre-wrap follow-up text', () => {
    const shortHeight = estimateBubbleHeight(
      'Pin the hinge.',
      ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomDraftBubble,
    );
    const longHeight = estimateBubbleHeight(
      '请先钉住真正的转折点，再把代价拆开。\n第二行继续追问：是谁把这次误判扩散成了整条世界线的共识？',
      ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomDraftBubble,
    );

    expect(longHeight).toBeGreaterThan(shortHeight);
  });

  it('keeps track of picker hint line count for roundtable copy', () => {
    const lineCount = estimateLineCount(
      'Seat one representative for each ending. The table starts with high-impact picks while trying to avoid the same voice on every worldline.',
      ORACLE_TEXT_LAYOUT_CONTRACTS.roundtablePickerHint,
    );

    expect(lineCount).toBeGreaterThanOrEqual(2);
  });

  it('falls back to a cheap estimator when Intl.Segmenter is temporarily deleted', () => {
    type MutableIntl = { Segmenter?: unknown };
    const intlRef = globalThis.Intl as unknown as MutableIntl;
    const originalSegmenter = intlRef.Segmenter;
    // Set to undefined to simulate absence of Segmenter
    intlRef.Segmenter = undefined;
    try {
      const prediction = predictTextOverflow(
        '如果金融防线和边疆补给同时失守，这条世界线是否还会把体面误当成稳定的最后借口，同时继续要求档案官替所有成本兜底并把错误包装成必然结局',
        ORACLE_TEXT_LAYOUT_CONTRACTS.resultEndingTitle,
      );

      // Verify that the cheap estimator still predicts overflow for a long text, and does not crash!
      expect(prediction.overflow).toBe(true);
      expect(prediction.overflowLines).toBeGreaterThan(0);
      expect(prediction.lineCount).toBeGreaterThan(1);
    } finally {
      intlRef.Segmenter = originalSegmenter;
    }
  });
});
