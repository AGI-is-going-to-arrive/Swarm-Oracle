const REPORT_DISCLAIMER_KEY = 'result.report.disclaimer';
const SUPPRESSED_DISCLAIMER_KEY = 'result.report.disclaimer_suppressed';

const DEFAULT_REPORT_DISCLAIMER_EN =
  'This probability is a narrative simulation result, not a real-world prediction.';
const DEFAULT_REPORT_DISCLAIMER_ZH = '本概率为叙事推演产物，非真实世界预测。';

// Backend suppressed-likelihood boilerplate (reducer._root_likelihood_disclaimer).
// Persisted reports carry ONE of these verbatim; map both to the localized key so a
// zh user never sees the English sentence on a legacy report (and vice versa).
const SUPPRESSED_DISCLAIMER_EN =
  'The report suppresses the statistical band because the only resolved ' +
  'anchor is a root or fork-parent fallback rather than an answer-bearing branch.';
const SUPPRESSED_DISCLAIMER_ZH =
  '报告已隐藏统计区间，因为唯一可解析锚点是根分支或分叉父分支，而不是直接回答问题的分支。';

const LOCALIZED_BOILERPLATE_DISCLAIMERS = new Set([
  DEFAULT_REPORT_DISCLAIMER_EN,
  DEFAULT_REPORT_DISCLAIMER_ZH,
]);

const SUPPRESSED_BOILERPLATE_DISCLAIMERS = new Set([
  SUPPRESSED_DISCLAIMER_EN,
  SUPPRESSED_DISCLAIMER_ZH,
]);

type Translate = (key: string, defaultValue: string) => string;

export function getReportDisclaimerText(disclaimer: string | null | undefined, t: Translate): string {
  const trimmed = disclaimer?.trim() ?? '';
  if (SUPPRESSED_BOILERPLATE_DISCLAIMERS.has(trimmed)) {
    return t(SUPPRESSED_DISCLAIMER_KEY, SUPPRESSED_DISCLAIMER_EN);
  }
  if (!trimmed || LOCALIZED_BOILERPLATE_DISCLAIMERS.has(trimmed)) {
    return t(REPORT_DISCLAIMER_KEY, DEFAULT_REPORT_DISCLAIMER_EN);
  }
  return disclaimer ?? trimmed;
}
