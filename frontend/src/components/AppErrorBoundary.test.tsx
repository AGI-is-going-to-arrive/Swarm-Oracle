import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const i18nMock = vi.hoisted(() => ({
  language: 'en',
  resolvedLanguage: 'en',
  t: vi.fn((key: string, options?: { defaultValue?: string }) => {
    const map: Record<string, string> = {
      'error_boundary.title': 'Something went wrong',
      'error_boundary.body': 'Refresh the page and try again.',
      'error_boundary.action': 'Reload page',
    };
    return map[key] ?? options?.defaultValue ?? key;
  }),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('../i18n/config', () => ({
  default: i18nMock,
}));

import { AppErrorBoundary } from './AppErrorBoundary';

function ThrowOnRender(): never {
  throw new Error('boom');
}

describe('AppErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    i18nMock.language = 'en';
    i18nMock.resolvedLanguage = 'en';
    i18nMock.t.mockImplementation((key: string, options?: { defaultValue?: string }) => {
      const map: Record<string, string> = {
        'error_boundary.title': 'Something went wrong',
        'error_boundary.body': 'Refresh the page and try again.',
        'error_boundary.action': 'Reload page',
      };
      return map[key] ?? options?.defaultValue ?? key;
    });
    i18nMock.on.mockReset();
    i18nMock.off.mockReset();
  });

  it('renders a stable fallback when a child crashes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <ThrowOnRender />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/页面发生错误|Something went wrong/);
  });

  it('uses built-in localized fallback text when i18n is not ready', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    i18nMock.language = 'zh';
    i18nMock.resolvedLanguage = '';
    i18nMock.t.mockImplementation((key: string) => key);

    render(
      <AppErrorBoundary>
        <ThrowOnRender />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('页面发生错误');
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
  });

  it('refreshes fallback copy when the UI language changes after a crash', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <ThrowOnRender />
      </AppErrorBoundary>,
    );

    const languageHandler = i18nMock.on.mock.calls.find(([event]) => event === 'languageChanged')?.[1];
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');

    i18nMock.language = 'zh';
    i18nMock.resolvedLanguage = 'zh';
    i18nMock.t.mockImplementation((key: string, options?: { defaultValue?: string }) => {
      const map: Record<string, string> = {
        'error_boundary.title': '页面发生错误',
        'error_boundary.body': '请刷新页面后重试。',
        'error_boundary.action': '刷新页面',
      };
      return map[key] ?? options?.defaultValue ?? key;
    });

    act(() => {
      languageHandler?.('zh');
    });

    expect(screen.getByRole('alert')).toHaveTextContent('页面发生错误');
  });
});
