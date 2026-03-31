import { beforeEach, describe, expect, it } from 'vitest';

import { clearPretextCache } from './pretext';
import {
  buildOracleTranscriptLayoutMap,
  captureTranscriptScrollSnapshot,
  computeBottomAnchoredScrollTop,
  predictOracleTranscriptBubbleLayout,
  summarizeOracleTranscriptLayout,
} from './oracleTranscriptLayout';

describe('oracleTranscriptLayout', () => {
  beforeEach(() => {
    clearPretextCache();
  });

  it('predicts taller draft bubbles for longer Oracle follow-up text', () => {
    const shortLayout = predictOracleTranscriptBubbleLayout(
      'Pin the hinge.',
      'ending_draft',
      'en',
    );
    const longLayout = predictOracleTranscriptBubbleLayout(
      '请先钉住真正的转折点，再把代价拆开。第二段继续追问：是谁把这次误判扩散成了整条世界线的共识？',
      'ending_draft',
      'zh',
    );

    expect(longLayout.minHeightPx).toBeGreaterThan(shortLayout.minHeightPx);
    expect(longLayout.lineCount).toBeGreaterThan(shortLayout.lineCount);
  });

  it('builds a stable layout map for transcript items', () => {
    const layoutMap = buildOracleTranscriptLayoutMap([
      { key: 'turn-1', content: 'Archive the hinge before the market fractures.' },
      { key: 'turn-2', content: '第二条长句子要验证中文换行是否能被 transcript 布局内核稳定预测。' },
    ], 'roundtable_turn', 'zh');

    expect(Object.keys(layoutMap)).toEqual(['turn-1', 'turn-2']);
    expect(layoutMap['turn-2'].lineCount).toBeGreaterThanOrEqual(1);
  });

  it('preserves the previous bottom offset when transcript height grows', () => {
    const previous = captureTranscriptScrollSnapshot({
      scrollHeight: 800,
      clientHeight: 300,
      scrollTop: 460,
    });

    const nextScrollTop = computeBottomAnchoredScrollTop({
      scrollHeight: 880,
      clientHeight: 300,
    }, previous);

    expect(previous.bottomOffset).toBe(40);
    expect(nextScrollTop).toBe(540);
  });

  it('pins to the bottom when there is no previous scroll snapshot', () => {
    const nextScrollTop = computeBottomAnchoredScrollTop({
      scrollHeight: 640,
      clientHeight: 320,
    }, null);

    expect(nextScrollTop).toBe(320);
  });

  it('summarizes transcript layout and bottom anchoring telemetry', () => {
    const turnLayouts = buildOracleTranscriptLayoutMap([
      { key: 'turn-1', content: 'Archive the hinge before the market fractures.' },
      { key: 'turn-2', content: '这是一段更长的中文转录，用来触发更高的换行数和更大的最小高度。' },
    ], 'roundtable_turn', 'zh');
    const draftLayouts = buildOracleTranscriptLayoutMap([
      { key: 'draft-1', content: '请继续追问：谁真正承担了延迟决策的代价？' },
    ], 'roundtable_draft', 'zh');
    const telemetry = summarizeOracleTranscriptLayout(
      turnLayouts,
      draftLayouts,
      captureTranscriptScrollSnapshot({
        scrollHeight: 920,
        clientHeight: 340,
        scrollTop: 576,
      }),
      {
        collapseLineLimit: 0,
        collapsedTurnCount: 1,
      },
    );

    expect(telemetry.turn_count).toBe(2);
    expect(telemetry.draft_count).toBe(1);
    expect(telemetry.max_turn_lines).toBeGreaterThanOrEqual(1);
    expect(telemetry.max_draft_lines).toBeGreaterThanOrEqual(1);
    expect(telemetry.collapsible_turn_count).toBeGreaterThanOrEqual(1);
    expect(telemetry.collapsed_turn_count).toBe(1);
    expect(telemetry.scroll_bottom_offset_px).toBe(4);
    expect(telemetry.is_bottom_anchored).toBe(true);
  });
});
