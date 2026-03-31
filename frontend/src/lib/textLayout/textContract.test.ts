/**
 * Text Contract Tests — P5 QA/CI
 *
 * Ensures critical UI labels, card titles, transcript bubbles, and share copy
 * never overflow their design-time containers in both zh and en locales.
 */
import { describe, expect, it } from 'vitest';

import { measureParagraph } from './pretext';
import { ORACLE_TEXT_LAYOUT_CONTRACTS, predictTextOverflow } from './textOverflowPredictor';

/* ── Font stacks (must mirror index.css) ─────────────────── */
const HEADING_FONT = '"Cormorant Garamond", "Noto Serif SC", serif';
const BODY_FONT = '"Instrument Sans", "Noto Sans SC", sans-serif';

function headingFont(sizePx: number, weight = 400) {
  return `normal ${weight} ${sizePx}px ${HEADING_FONT}`;
}
function bodyFont(sizePx: number, weight = 400) {
  return `normal ${weight} ${sizePx}px ${BODY_FONT}`;
}

/* ── Critical button labels (zh + en) ────────────────────── */
const BUTTON_LABELS_ZH = [
  '⚡ 开始推演',
  '🎯 预测',
  '施加干预',
  '取消',
  '📱 生成文案',
  '🔗 复制固定链接',
  '🔗 分享挑战',
  '📋 复制文案',
  '提交预测',
  '提交中…',
  '🃏 玩法卡',
  '注入玩法卡',
  '注入中…',
];

const BUTTON_LABELS_EN = [
  'Start Simulation',
  '🎯 Predict',
  'Apply Intervention',
  'Cancel',
  '📱 Generate Copy',
  '🔗 Copy Permalink',
  '🔗 Share Challenge',
  '📋 Copy',
  'Submit Prediction',
  'Submitting…',
  '🃏 Gameplay Cards',
  'Inject Card',
  'Injecting…',
];

/* ── Card titles ─────────────────────────────────────────── */
const CARD_TITLES_ZH = [
  '推演结果',
  '结局',
  '发起预测',
  '玩法卡',
  '繁荣黄金时代',
  '和平与统一',
  '永恒之战',
  '文明崩塌',
  '黑暗暴政',
  '革命之曙光',
];

const CARD_TITLES_EN = [
  'Simulation Results',
  'Ending',
  'Make a Prediction',
  'Gameplay Cards',
  'Golden Age of Prosperity',
  'Peace and Unity',
  'Eternal War',
  'Civilization Collapse',
  'Dark Tyranny',
  'Dawn of Revolution',
];

/* ── Longer descriptive text ─────────────────────────────── */
const DESCRIPTIVE_ZH = [
  '选择导演卡或反制卡，把结构化事件注入当前世界线',
  '先选卡，再补充一句导演指令。提交后会走现有 intervention API，把结构化事件直接送进推演引擎。',
  '可先预览玩法卡，待角色就位后再注入',
  '导演工具已解锁，可以开始下注或出牌',
  '已有更新先一步写入，已回拉最新玩法状态。',
  '当前还没有可下注的活跃世界线，请稍候再试。',
];

const DESCRIPTIVE_EN = [
  'Pick a director card or counter card and inject a structured event into the current worldline',
  'Pick the card first, then add one clear director instruction. Submission still goes through the intervention API.',
  'You can preview cards now and inject once agents finish syncing',
  'Director tools are ready for bets and cards',
  'Another update landed first. Reloaded the latest gameplay state.',
  'No active worldline is ready for branch betting yet. Try again in a moment.',
];

/* ── Contract: buttons fit in 1 line at 320px (mobile minimum) ── */
describe('Text Contract: Button labels', () => {
  const MOBILE_BTN_WIDTH = 280; // mobile button min-width minus padding
  const BTN_FONT = bodyFont(14, 500);
  const BTN_LINE_HEIGHT = 20;

  it.each(BUTTON_LABELS_ZH)('zh button "%s" fits in 1 line at 280px', (label) => {
    const { lineCount } = measureParagraph({
      text: label,
      font: BTN_FONT,
      maxWidthPx: MOBILE_BTN_WIDTH,
      lineHeightPx: BTN_LINE_HEIGHT,
      locale: 'zh',
    });
    expect(lineCount).toBeLessThanOrEqual(1);
  });

  it.each(BUTTON_LABELS_EN)('en button "%s" fits in 1 line at 280px', (label) => {
    const { lineCount } = measureParagraph({
      text: label,
      font: BTN_FONT,
      maxWidthPx: MOBILE_BTN_WIDTH,
      lineHeightPx: BTN_LINE_HEIGHT,
      locale: 'en',
    });
    expect(lineCount).toBeLessThanOrEqual(1);
  });
});

/* ── Contract: card/modal titles fit in 2 lines at 300px ── */
describe('Text Contract: Card/Modal titles', () => {
  const TITLE_WIDTH = 300; // card title container
  const TITLE_FONT = headingFont(22, 500);
  const TITLE_LINE_HEIGHT = 30;

  it.each(CARD_TITLES_ZH)('zh title "%s" fits in 2 lines at 300px', (title) => {
    const { lineCount } = measureParagraph({
      text: title,
      font: TITLE_FONT,
      maxWidthPx: TITLE_WIDTH,
      lineHeightPx: TITLE_LINE_HEIGHT,
      locale: 'zh',
    });
    expect(lineCount).toBeLessThanOrEqual(2);
  });

  it.each(CARD_TITLES_EN)('en title "%s" fits in 2 lines at 300px', (title) => {
    const { lineCount } = measureParagraph({
      text: title,
      font: TITLE_FONT,
      maxWidthPx: TITLE_WIDTH,
      lineHeightPx: TITLE_LINE_HEIGHT,
      locale: 'en',
    });
    expect(lineCount).toBeLessThanOrEqual(2);
  });
});

/* ── Contract: descriptive text stays within 5 lines at 320px ── */
describe('Text Contract: Descriptive text', () => {
  const DESC_WIDTH = 320;
  const DESC_FONT = bodyFont(14, 400);
  const DESC_LINE_HEIGHT = 22;

  it.each(DESCRIPTIVE_ZH)('zh description stays within 5 lines at 320px: "%s"', (text) => {
    const { lineCount } = measureParagraph({
      text,
      font: DESC_FONT,
      maxWidthPx: DESC_WIDTH,
      lineHeightPx: DESC_LINE_HEIGHT,
      locale: 'zh',
    });
    expect(lineCount).toBeLessThanOrEqual(5);
  });

  it.each(DESCRIPTIVE_EN)('en description stays within 5 lines at 320px: "%s"', (text) => {
    const { lineCount } = measureParagraph({
      text,
      font: DESC_FONT,
      maxWidthPx: DESC_WIDTH,
      lineHeightPx: DESC_LINE_HEIGHT,
      locale: 'en',
    });
    expect(lineCount).toBeLessThanOrEqual(5);
  });
});

/* ── Contract: Oracle layout contracts (existing textOverflowPredictor) ── */
describe('Text Contract: Oracle layout contracts', () => {
  const ENDING_TITLES_ZH = [
    '繁荣黄金时代',
    '革命之曙光',
    '文明崩塌：一个关于人类社会如何走向终结的深度反思与推演',
  ];
  const ENDING_TITLES_EN = [
    'Golden Age of Prosperity',
    'Dawn of Revolution',
    'Civilization Collapse',
  ];

  it.each(ENDING_TITLES_ZH)('zh ending title "%s" does not overflow', (title) => {
    const prediction = predictTextOverflow(title, ORACLE_TEXT_LAYOUT_CONTRACTS.resultEndingTitle);
    expect(prediction.overflow).toBe(false);
  });

  it.each(ENDING_TITLES_EN)('en ending title "%s" does not overflow', (title) => {
    const prediction = predictTextOverflow(title, ORACLE_TEXT_LAYOUT_CONTRACTS.resultEndingTitle);
    expect(prediction.overflow).toBe(false);
  });

  it('detects overflow for excessively long ending title', () => {
    const longTitle = 'Dawn of Revolution: A Deep Reflection on How Human Civilization Reaches Its Conclusion';
    const prediction = predictTextOverflow(longTitle, ORACLE_TEXT_LAYOUT_CONTRACTS.resultEndingTitle);
    expect(prediction.overflow).toBe(true);
  });

  it('roundtable bubble stays within contract for typical zh transcript', () => {
    const text = '这是一段典型的圆桌讨论记录，包含了多个角色的发言内容。在这个世界线中，我们需要考虑各种可能的发展方向。';
    const prediction = predictTextOverflow(text, ORACLE_TEXT_LAYOUT_CONTRACTS.roundtableTranscriptBubble);
    expect(prediction.overflow).toBe(false);
  });

  it('roundtable bubble stays within contract for typical en transcript', () => {
    const text = 'This is a typical roundtable discussion transcript containing multiple agents speaking. In this worldline, we need to consider various possible outcomes.';
    const prediction = predictTextOverflow(text, ORACLE_TEXT_LAYOUT_CONTRACTS.roundtableTranscriptBubble);
    expect(prediction.overflow).toBe(false);
  });

  it('endingRoom bubble stays within contract for zh message', () => {
    const text = '这个世界线最终走向了和平与繁荣。各个派系在长期的博弈之后，终于达成了一个微妙的平衡。';
    const prediction = predictTextOverflow(text, ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomBubble);
    expect(prediction.overflow).toBe(false);
  });

  it('endingRoom draft bubble accommodates reasonable zh draft', () => {
    const text = '我想追问一下关于这个世界线最终走向的具体细节。为什么在第三轮的时候出现了关键的转折点？';
    const prediction = predictTextOverflow(text, ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomDraftBubble);
    expect(prediction.overflow).toBe(false);
  });
});

/* ── Contract: share copy stays bounded ────────────────────── */
describe('Text Contract: Share copy', () => {
  it('zh share copy within 8 lines at 520px', () => {
    const text = '我在 SwarmOracle 中推演了一个关于"如果诸葛亮多活10年"的场景。\n经过5轮推演，5个AI Agent各抒己见，最终走向了"革命之曙光"的结局。\n最精彩的转折发生在第3轮，当时一位谋士提出了颠覆性的策略。';
    const prediction = predictTextOverflow(text, ORACLE_TEXT_LAYOUT_CONTRACTS.resultShareCopy);
    expect(prediction.overflow).toBe(false);
  });

  it('en share copy within 8 lines at 520px', () => {
    const text = 'I simulated "What if Zhuge Liang lived 10 more years?" on SwarmOracle.\nAfter 5 rounds with 5 AI agents, the worldline reached "Dawn of Revolution".\nThe most dramatic twist came in round 3 when one strategist proposed a game-changing move.';
    const prediction = predictTextOverflow(text, ORACLE_TEXT_LAYOUT_CONTRACTS.resultShareCopy);
    expect(prediction.overflow).toBe(false);
  });
});
