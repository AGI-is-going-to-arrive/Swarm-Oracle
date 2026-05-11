import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  type LeaderboardResponse,
  type LeaderboardSegmentFilters,
} from '../api/client';
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function leaderboardResponse(userName: string): LeaderboardResponse {
  return {
    entries: [
      {
        user_id: userName.toLowerCase().replace(/\s+/g, '-'),
        user_name: userName,
        avg_score: 7.5,
        best_score: 9,
        total_predictions: 3,
        win_streak: 1,
      },
    ],
    segment_metadata: {
      active_filters: {},
      total_count: 2,
      filtered_count: 1,
    },
  };
}

beforeEach(() => {
  getLeaderboardMock.mockReset();
  setLanguage('en');
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

  it('ignores stale leaderboard responses after filters change quickly', async () => {
    const staleAll = createDeferred<LeaderboardResponse>();
    const freshDebate = createDeferred<LeaderboardResponse>();
    getLeaderboardMock
      .mockImplementationOnce(
        (_limit: number, _filters?: LeaderboardSegmentFilters) => staleAll.promise,
      )
      .mockImplementationOnce(
        (_limit: number, _filters?: LeaderboardSegmentFilters) => freshDebate.promise,
      );

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LeaderboardView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getLeaderboardMock).toHaveBeenCalledWith(
        50,
        expect.objectContaining({ scenarioType: null }),
      );
    });

    await user.click(screen.getByRole('button', { name: 'en:leaderboard.filter_type_debate' }));

    await waitFor(() => {
      expect(getLeaderboardMock).toHaveBeenCalledWith(
        50,
        expect.objectContaining({ scenarioType: 'debate' }),
      );
    });

    await act(async () => {
      freshDebate.resolve(leaderboardResponse('Fresh Debate'));
      await freshDebate.promise;
    });

    expect(await screen.findByText('Fresh Debate')).toBeInTheDocument();

    await act(async () => {
      staleAll.resolve(leaderboardResponse('Stale All'));
      await staleAll.promise;
    });

    await waitFor(() => {
      expect(screen.getByText('Fresh Debate')).toBeInTheDocument();
      expect(screen.queryByText('Stale All')).not.toBeInTheDocument();
    });
  });
});
