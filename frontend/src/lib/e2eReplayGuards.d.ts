export interface ReplayCoverageAssertionOptions {
  label?: string;
  requiredFields?: string[];
}

export function assertReplayCoverage(
  report: Record<string, unknown>,
  options?: ReplayCoverageAssertionOptions,
): void;
