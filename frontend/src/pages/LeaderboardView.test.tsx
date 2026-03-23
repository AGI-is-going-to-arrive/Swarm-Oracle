import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import LeaderboardView from './LeaderboardView';

const { getLeaderboardMock, setLanguage, getLanguage, translate } = vi.hoisted(() => {
  const getLeaderboardMock = vi.fn();
  let language = 'en';
  return {
    getLeaderboardMock,
    setLanguage(next: string) {
      language = next;
    },
    getLanguage() {
      return language;
    },
    translate(key: string) {
      return `${language}:${key}`;
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: {
      get language() {
        return getLanguage();
      },
    },
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await import('../api/client');
  return {
    ...actual,
    getLeaderboard: getLeaderboardMock,
  };
});

describe('LeaderboardView', () => {
  it('reloads localized errors when the translation function changes', async () => {
    getLeaderboardMock.mockRejectedValue(new ApiError(503, 'LLM_TEMPORARILY_UNAVAILABLE', 'busy'));
    setLanguage('en');

    const view = render(
      <MemoryRouter>
        <LeaderboardView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('en:common.api_errors.llm_unavailable')).toBeInTheDocument();

    setLanguage('zh');
    view.rerender(
      <MemoryRouter>
        <LeaderboardView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('zh:common.api_errors.llm_unavailable')).toBeInTheDocument();
    });
  });
});
