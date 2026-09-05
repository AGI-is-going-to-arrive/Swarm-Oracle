import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en.json';
import zh from '../i18n/locales/zh.json';

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

    expect(
      getLocalizedApiErrorMessage(
        { status: 429, code: 'DAILY_QUOTA_EXCEEDED' },
        t,
        'fallback',
      ),
    ).toBe('conversation.error.quota_exceeded');

    expect(
      getLocalizedApiErrorMessage(
        { status: 429, code: 'ORG_DAILY_QUOTA_EXCEEDED' },
        t,
        'fallback',
      ),
    ).toBe('conversation.error.quota_exceeded');

    expect(
      getLocalizedApiErrorMessage(
        { status: 503, code: 'SOCIAL_LLM_TEMPORARILY_UNAVAILABLE' },
        t,
        'fallback',
      ),
    ).toBe('common.api_errors.llm_unavailable');
  });

  it('falls back for unknown errors', () => {
    expect(getLocalizedApiErrorMessage(new Error('boom'), t, 'fallback')).toBe('fallback');
  });

  it.each([en, zh])('explains a rejected search URL in each supported language', (locale) => {
    const translate = (key: string): string => {
      if (key === 'common.api_errors.web_search_base_url_not_allowed') {
        return locale.translation.common.api_errors.web_search_base_url_not_allowed;
      }
      return key;
    };
    const message = getLocalizedApiErrorMessage(
      { status: 400, code: 'WEB_SEARCH_BASE_URL_NOT_ALLOWED' },
      translate,
      'fallback',
    );

    expect(message).toBe(locale.translation.common.api_errors.web_search_base_url_not_allowed);
    expect(message).not.toBe('fallback');
    expect(message).not.toContain('common.api_errors.');
  });
});
