import { describe, expect, it } from 'vitest';

import {
  getApiErrorCode,
  getApiErrorStatus,
  getLocalizedApiErrorMessage,
} from './apiErrorMessage';

const t = (key: string) => key;

describe('apiErrorMessage helpers', () => {
  it('extracts status and code from ApiError-like objects', () => {
    const error = { status: 409, code: 'GAMEPLAY_STATE_REVISION_MISMATCH' };

    expect(getApiErrorStatus(error)).toBe(409);
    expect(getApiErrorCode(error)).toBe('GAMEPLAY_STATE_REVISION_MISMATCH');
  });

  it('maps known codes to localized keys', () => {
    expect(
      getLocalizedApiErrorMessage(
        { status: 409, code: 'GAMEPLAY_STATE_REVISION_MISMATCH' },
        t,
        'fallback',
      ),
    ).toBe('common.api_errors.sync_conflict');

    expect(
      getLocalizedApiErrorMessage(
        { status: 400, code: 'DEBATE_PREDICTIONS_LOCKED' },
        t,
        'fallback',
      ),
    ).toBe('debate.bet_error_locked');
  });

  it('falls back for unknown errors', () => {
    expect(getLocalizedApiErrorMessage(new Error('boom'), t, 'fallback')).toBe('fallback');
  });
});
