type TranslateFn = (key: string) => string;

const KNOWN_REASONS: Record<string, string> = {
  no_branches: 'result.report.chartEmptyReason.no_branches',
  feature_disabled: 'result.report.chartEmptyReason.feature_disabled',
  no_faction_snapshots: 'result.report.chartEmptyReason.no_faction_snapshots',
  empty_faction_membership: 'result.report.chartEmptyReason.empty_faction_membership',
  relation_edges_missing: 'result.report.chartEmptyReason.relation_edges_missing',
};

export function resolveChartEmptyReason(
  reason: string | null | undefined,
  t: TranslateFn
): string {
  if (!reason) {
    return t('result.report.chartEmpty');
  }
  const key = KNOWN_REASONS[reason];
  if (key) {
    return t(key);
  }
  return t('result.report.chartEmpty');
}
