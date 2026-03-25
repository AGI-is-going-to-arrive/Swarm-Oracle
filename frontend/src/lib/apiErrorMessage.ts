type Translator = (key: string, options?: Record<string, unknown>) => string;
type ErrorKeyOverrides = Partial<Record<string, string>>;

type ApiErrorLike = {
  status?: unknown;
  code?: unknown;
};

function getApiErrorLike(error: unknown): ApiErrorLike | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  return error as ApiErrorLike;
}

export function getApiErrorStatus(error: unknown): number | null {
  const candidate = getApiErrorLike(error)?.status;
  return typeof candidate === 'number' ? candidate : null;
}

export function getApiErrorCode(error: unknown): string | null {
  const candidate = getApiErrorLike(error)?.code;
  return typeof candidate === 'string' ? candidate : null;
}

export type AutomationErrorState = {
  code: string | null;
  label: string;
};

export function buildAutomationErrorState(
  code: string | null | undefined,
  label: string | null | undefined,
): AutomationErrorState | null {
  if (!label) return null;
  return {
    code: typeof code === 'string' && code.length > 0 ? code : null,
    label,
  };
}

export function getLocalizedApiErrorMessage(
  error: unknown,
  t: Translator,
  fallback: string,
  overrides: ErrorKeyOverrides = {},
): string {
  const code = getApiErrorCode(error);
  if (!code) {
    return fallback;
  }

  const overrideKey = overrides[code];
  if (overrideKey) {
    return t(overrideKey);
  }

  switch (code) {
    case 'SCENARIO_NOT_FOUND':
      return t('common.api_errors.scenario_not_found');
    case 'DEBATE_NOT_FOUND':
      return t('common.api_errors.debate_not_found');
    case 'DEBATE_RESULT_NOT_READY':
      return t('debate.result_pending');
    case 'DEBATE_PREDICTIONS_CLOSED':
    case 'DEBATE_PREDICTIONS_LOCKED':
      return t('debate.bet_error_locked');
    case 'PREDICTIONS_CLOSED':
      return t('prediction.error_closed');
    case 'PREDICTION_ALREADY_SUBMITTED':
      return t('prediction.error_duplicate');
    case 'INTERVENTION_SCENARIO_STATUS_INVALID':
    case 'INTERVENTION_BRANCH_STATUS_INVALID':
    case 'BATCH_INTERVENTION_BRANCH_STATUS_INVALID':
      return t('intervention.error_unavailable');
    case 'INTERVENTION_BRANCH_NOT_FOUND':
    case 'BATCH_INTERVENTION_BRANCH_NOT_FOUND':
      return t('intervention.error_branch_missing');
    case 'LLM_TEMPORARILY_UNAVAILABLE':
      return t('common.api_errors.llm_unavailable');
    case 'LLM_GENERATION_FAILED':
      return t('common.api_errors.llm_generation_failed');
    case 'SIMULATION_TIMEOUT':
    case 'SIMULATION_RUNTIME_FAILED':
    case 'SCENARIO_PARSE_FAILED':
      return t('common.api_errors.simulation_start_failed');
    case 'DEBATE_RUNTIME_FAILED':
      return t('common.api_errors.debate_load_failed');
    case 'DIRECTOR_STATE_REVISION_MISMATCH':
    case 'GAMEPLAY_STATE_REVISION_MISMATCH':
      return t('common.api_errors.sync_conflict');
    default:
      return fallback;
  }
}
