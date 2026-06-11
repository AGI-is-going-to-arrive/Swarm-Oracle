const REPORT_DISCLAIMER_KEY = 'result.report.disclaimer';

const DEFAULT_REPORT_DISCLAIMER_EN =
  'This probability is a narrative simulation result, not a real-world prediction.';
const DEFAULT_REPORT_DISCLAIMER_ZH = '本概率为叙事推演产物，非真实世界预测。';

const LOCALIZED_BOILERPLATE_DISCLAIMERS = new Set([
  DEFAULT_REPORT_DISCLAIMER_EN,
  DEFAULT_REPORT_DISCLAIMER_ZH,
]);

type Translate = (key: string, defaultValue: string) => string;

export function getReportDisclaimerText(disclaimer: string | null | undefined, t: Translate): string {
  const trimmed = disclaimer?.trim() ?? '';
  if (!trimmed || LOCALIZED_BOILERPLATE_DISCLAIMERS.has(trimmed)) {
    return t(REPORT_DISCLAIMER_KEY, DEFAULT_REPORT_DISCLAIMER_EN);
  }
  return disclaimer ?? trimmed;
}
