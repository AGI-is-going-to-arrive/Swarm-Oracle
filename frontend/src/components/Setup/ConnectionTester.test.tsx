import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionTester } from './ConnectionTester';
import { testLlmConnection } from '../../api/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../../api/client', () => ({
  testLlmConnection: vi.fn(),
  isApiError: vi.fn((error: unknown) => error instanceof Error && 'status' in error),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConnectionTester', () => {
  it('treats the backend nested llm ok response as success', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: {
        status: 'ok',
        model: 'gpt-test',
        response: 'model responded',
      },
    });

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'model responded',
    );
    await waitFor(() => {
      expect(container.querySelector('.status-dot--success')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'setup.test_failure',
    );
  });

  it('surfaces the backend nested llm error response as failure', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      server: 'ok',
      llm: {
        status: 'error',
        model: 'gpt-test',
        error: 'invalid api key',
      },
    });

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="bad-key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'invalid api key',
    );
    await waitFor(() => {
      expect(container.querySelector('.status-dot--error')).toBeInTheDocument();
    });
  });

  it('keeps the legacy top-level success response including latency', async () => {
    vi.mocked(testLlmConnection).mockResolvedValue({
      status: 'success',
      message: 'legacy ok',
      latency_ms: 42,
    } as unknown as Awaited<ReturnType<typeof testLlmConnection>>);

    const user = userEvent.setup();
    const { container } = render(
      <ConnectionTester baseUrl="https://api.example.com/v1" apiKey="key" />,
    );

    await user.click(screen.getByRole('button', { name: 'setup.test_button' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'legacy ok · 42 ms',
    );
    await waitFor(() => {
      expect(container.querySelector('.status-dot--success')).toBeInTheDocument();
    });
  });
});
