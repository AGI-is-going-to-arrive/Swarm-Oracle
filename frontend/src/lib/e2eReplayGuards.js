export function assertReplayCoverage(report, { label, requiredFields = [] } = {}) {
  const issues = [];

  if (!report || typeof report !== 'object') {
    throw new Error(`${label ?? 'replay coverage'}: missing report payload`);
  }

  if (report.replayCoverageError) {
    issues.push(`replayCoverageError=${report.replayCoverageError}`);
  }

  for (const field of requiredFields) {
    if (report[field] == null) {
      issues.push(`missing ${field}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`${label ?? 'replay coverage'} failed: ${issues.join(', ')}`);
  }
}
