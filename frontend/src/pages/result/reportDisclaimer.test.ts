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
});
