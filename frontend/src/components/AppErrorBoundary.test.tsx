import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../i18n/config', () => ({
  default: {
    language: 'en',
  },
}));

import { AppErrorBoundary } from './AppErrorBoundary';

function ThrowOnRender(): never {
  throw new Error('boom');
}

describe('AppErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
