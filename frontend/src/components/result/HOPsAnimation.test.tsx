import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HOPsAnimation from './HOPsAnimation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('HOPsAnimation reduced-motion behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancels the active animation frame when reduced motion is enabled at runtime', () => {
    let reducedMotion = false;
    let changeHandler: (() => void) | null = null;
    const mediaQuery = {
      get matches() {
        return reducedMotion;
      },
      addEventListener: vi.fn((_event: string, handler: () => void) => {
        changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
    const cancelAnimationFrameMock = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 42));
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);

    render(
      <HOPsAnimation
        branches={[
          { id: 'a', title: 'A', probability: 0.7 },
          { id: 'b', title: 'B', probability: 0.3 },
        ]}
      />,
    );

    expect(window.requestAnimationFrame).toHaveBeenCalled();

    act(() => {
      reducedMotion = true;
      changeHandler?.();
    });

    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(42);
  });
});
