import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { QuotaBadge } from './QuotaBadge';
import type { QuotaSummaryResponse } from '../../api/client';

i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        quota: {
          remaining: '{{count}} remaining',
          exhausted: 'Quota exhausted',
          conversation_label: 'Conversations',
          replay_label: 'Replays',
          load_failed: 'Quota unavailable',
        },
      },
    },
  },
});

afterEach(() => {
  cleanup();
});

function makeSummary(overrides: Partial<QuotaSummaryResponse> = {}): QuotaSummaryResponse {
  return {
    conversation: { used: 0, limit: 500, remaining: 500 },
    replay: { used: 0, limit: 3, remaining: 3 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderBadge(props: Parameters<typeof QuotaBadge>[0]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <QuotaBadge {...props} />
    </I18nextProvider>,
  );
}

describe('QuotaBadge', () => {
  it('shows remaining count when quota available', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeSummary({ conversation: { used: 100, limit: 500, remaining: 400 } }),
    );
    renderBadge({ scenarioId: 's1', type: 'conversation', fetcher });
    await waitFor(() => {
      expect(screen.getByText(/400 remaining/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Conversations/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith('s1');
  });

  it('shows exhausted state when remaining is 0', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeSummary({ replay: { used: 3, limit: 3, remaining: 0 } }),
    );
    renderBadge({ scenarioId: 's1', type: 'replay', fetcher });
    await waitFor(() => {
      expect(screen.getByText(/Quota exhausted/)).toBeInTheDocument();
    });
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('aria-disabled', 'true');
    expect(badge.className).toContain('quota-badge--disabled');
  });

  it('shows error state when fetch fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    renderBadge({ scenarioId: 's1', type: 'conversation', fetcher });
    await waitFor(() => {
      expect(screen.getByText(/Quota unavailable/)).toBeInTheDocument();
    });
    expect(screen.getByRole('status').className).toContain('quota-badge--error');
  });

  it('renders replay label for replay type', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeSummary());
    renderBadge({ scenarioId: 's1', type: 'replay', fetcher });
    await waitFor(() => {
      expect(screen.getByText(/Replays/)).toBeInTheDocument();
    });
  });

  it('omits scenario_id when scenarioId is undefined', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeSummary());
    renderBadge({ type: 'conversation', fetcher });
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(undefined);
    });
  });

  it('ignores stale quota responses after scenario and type change', async () => {
    const firstRequest = deferred<QuotaSummaryResponse>();
    const secondRequest = deferred<QuotaSummaryResponse>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    const { rerender } = renderBadge({ scenarioId: 'old-scenario', type: 'conversation', fetcher });

    rerender(
      <I18nextProvider i18n={i18n}>
        <QuotaBadge scenarioId="new-scenario" type="replay" fetcher={fetcher} />
      </I18nextProvider>,
    );

    await act(async () => {
      secondRequest.resolve(
        makeSummary({
          replay: { used: 1, limit: 3, remaining: 2 },
        }),
      );
      await secondRequest.promise;
    });

    expect(screen.getByRole('status')).toHaveTextContent(/Replays.*2 remaining/);

    await act(async () => {
      firstRequest.resolve(
        makeSummary({
          conversation: { used: 1, limit: 500, remaining: 499 },
          replay: { used: 2, limit: 3, remaining: 1 },
        }),
      );
      await firstRequest.promise;
    });

    expect(screen.getByRole('status')).toHaveTextContent(/Replays.*2 remaining/);
    expect(screen.queryByText(/499 remaining/)).not.toBeInTheDocument();
  });
});
