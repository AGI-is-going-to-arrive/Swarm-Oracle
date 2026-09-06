type Translator = (key: string, options?: Record<string, unknown>) => string;
type ErrorKeyOverrides = Partial<Record<string, string>>;

type ApiErrorLike = {
  status?: unknown;
  code?: unknown;
};

export interface ApiErrorState {
  status: number | null;
  code: string | null;
}

export function captureApiError(error: unknown): ApiErrorState {
  return { status: getApiErrorStatus(error), code: getApiErrorCode(error) };
}

/** Only expose bounded public status/code fields, never provider text or credentials. */
export function getApiErrorDiagnostic(error: unknown): string | null {
  const { status, code } = captureApiError(error);
  const parts: string[] = [];
  if (status !== null && Number.isInteger(status) && status >= 100 && status <= 599) parts.push(`HTTP ${status}`);
  if (code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) parts.push(code);
  return parts.length > 0 ? parts.join(' · ') : null;
}

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
    case 'SCENARIO_LOAD_FAILED':
      return t('common.api_errors.scenario_load_failed');
    case 'DEBATE_NOT_FOUND':
      return t('common.api_errors.debate_not_found');
    case 'DEBATE_CANCELLED':
      return t('debate.cancelled_notice');
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
    case 'QUOTA_EXCEEDED':
    case 'DAILY_QUOTA_EXCEEDED':
    case 'ORG_DAILY_QUOTA_EXCEEDED':
      return t('conversation.error.quota_exceeded');
    case 'LLM_TEMPORARILY_UNAVAILABLE':
    case 'SOCIAL_LLM_TEMPORARILY_UNAVAILABLE':
      return t('common.api_errors.llm_unavailable');
    case 'BYOK_INVALID':
      return t('conversation.error.byok_invalid');
    case 'MODEL_PROFILE_CHANGED':
      return t('common.api_errors.model_profile_changed');
    case 'ENDING_ROOM_MODEL_PROFILE_CONFLICT':
      return t('common.api_errors.ending_room_model_profile_conflict');
    case 'DEBATE_RESTART_PROVIDER_CHANGED':
      return t('debate.restart_provider_changed');
    case 'LLM_GENERATION_FAILED':
      return t('common.api_errors.llm_generation_failed');
    case 'WEB_SEARCH_BASE_URL_NOT_ALLOWED':
      return t('common.api_errors.web_search_base_url_not_allowed');
    case 'LLM_BASE_URL_NOT_ALLOWED':
      return t('common.api_errors.llm_base_url_not_allowed');
    case 'SIMULATION_TIMEOUT':
    case 'SIMULATION_RUNTIME_FAILED':
    case 'SCENARIO_PARSE_FAILED':
      return t('common.api_errors.simulation_start_failed');
    case 'RUNTIME_ERROR':
      return t('simulation.runtime_failed');
    case 'DEBATE_RUNTIME_FAILED':
      return t('common.api_errors.debate_load_failed');
    case 'DIRECTOR_STATE_REVISION_MISMATCH':
    case 'GAMEPLAY_STATE_REVISION_MISMATCH':
      return t('common.api_errors.sync_conflict');
    case 'FEATURE_DISABLED':
      return t('common.api_errors.feature_disabled');
    default:
      return fallback;
  }
}
