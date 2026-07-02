import { describe, expect, it } from 'vitest';

import { getReportDisclaimerText } from './reportDisclaimer';

const englishBoilerplate = 'This probability is a narrative simulation result, not a real-world prediction.';
const chineseBoilerplate = '本概率为叙事推演产物，非真实世界预测。';

describe('getReportDisclaimerText', () => {
  const tZh = () => chineseBoilerplate;
  const tEn = () => englishBoilerplate;

  it('localizes missing, empty, and whitespace-only disclaimers', () => {
    expect(getReportDisclaimerText(null, tZh)).toBe(chineseBoilerplate);
    expect(getReportDisclaimerText('', tZh)).toBe(chineseBoilerplate);
    expect(getReportDisclaimerText('   ', tZh)).toBe(chineseBoilerplate);
  });

  it('localizes legacy persisted boilerplate in the active language', () => {
    expect(getReportDisclaimerText(englishBoilerplate, tZh)).toBe(chineseBoilerplate);
    expect(getReportDisclaimerText(chineseBoilerplate, tEn)).toBe(englishBoilerplate);
  });

  it('preserves scenario-specific backend disclaimers', () => {
    expect(getReportDisclaimerText('Scenario-specific caveat.', tZh)).toBe('Scenario-specific caveat.');
  });

  it('maps the suppressed-likelihood boilerplate (both languages) to its own key', () => {
    const suppressedEn =
      'The report suppresses the statistical band because the only resolved ' +
      'anchor is a root or fork-parent fallback rather than an answer-bearing branch.';
    const suppressedZh =
      '报告已隐藏统计区间，因为唯一可解析锚点是根分支或分叉父分支，而不是直接回答问题的分支。';
    const tKeyed = (key: string, defaultValue: string) =>
      key === 'result.report.disclaimer_suppressed' ? '[[suppressed-l10n]]' : defaultValue;
    expect(getReportDisclaimerText(suppressedEn, tKeyed)).toBe('[[suppressed-l10n]]');
    expect(getReportDisclaimerText(suppressedZh, tKeyed)).toBe('[[suppressed-l10n]]');
  });
});
