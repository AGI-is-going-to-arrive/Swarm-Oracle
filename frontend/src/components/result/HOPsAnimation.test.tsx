import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HOPsAnimation, { type HOPsBranchInput } from './HOPsAnimation';

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

describe('HOPsAnimation rendering behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const mediaQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the section and one row per branch when given 2+ branches', () => {
    const branches: HOPsBranchInput[] = [
      { id: 'a', title: 'Alpha', probability: 0.5 },
      { id: 'b', title: 'Beta', probability: 0.3 },
      { id: 'c', title: 'Gamma', probability: 0.2 },
    ];
    const { container } = render(<HOPsAnimation branches={branches} />);

    const section = container.querySelector('.hops');
    expect(section).not.toBeNull();
    const rows = container.querySelectorAll('.hops__row');
    expect(rows).toHaveLength(3);
  });

  it('renders nothing when given a single branch', () => {
    const { container } = render(
      <HOPsAnimation branches={[{ id: 'only', title: 'Solo', probability: 1 }]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(container.querySelector('.hops')).toBeNull();
  });

  it('renders nothing when given an empty branch array', () => {
    const { container } = render(<HOPsAnimation branches={[]} />);
    expect(container.firstChild).toBeNull();
    expect(container.querySelector('.hops')).toBeNull();
  });

  it('displays correct probability percentages after normalization', () => {
    // Probabilities sum to 1.0, so they pass through unchanged after normalization.
    const branches: HOPsBranchInput[] = [
      { id: 'a', title: 'Alpha', probability: 0.6 },
      { id: 'b', title: 'Beta', probability: 0.4 },
    ];
    const { container } = render(<HOPsAnimation branches={branches} />);
    const probValues = Array.from(container.querySelectorAll('.hops__prob-value')).map(
      (el) => el.textContent,
    );
    expect(probValues).toEqual(['60%', '40%']);
  });

  it('toggles data-playing attribute when the control button is clicked', () => {
    const { container } = render(
      <HOPsAnimation
        isPlaying
        branches={[
          { id: 'a', title: 'Alpha', probability: 0.5 },
          { id: 'b', title: 'Beta', probability: 0.5 },
        ]}
      />,
    );
    const section = container.querySelector('.hops') as HTMLElement | null;
    const button = container.querySelector('.hops__control') as HTMLButtonElement | null;
    expect(section).not.toBeNull();
    expect(button).not.toBeNull();
    expect(section!.getAttribute('data-playing')).toBe('true');

    act(() => {
      fireEvent.click(button!);
    });
    expect(section!.getAttribute('data-playing')).toBe('false');

    act(() => {
      fireEvent.click(button!);
    });
    expect(section!.getAttribute('data-playing')).toBe('true');
  });

  it('renders i18n title and subtitle from default values', () => {
    const { container } = render(
      <HOPsAnimation
        branches={[
          { id: 'a', title: 'Alpha', probability: 0.5 },
          { id: 'b', title: 'Beta', probability: 0.5 },
        ]}
      />,
    );
    const title = container.querySelector('.hops__title');
    const subtitle = container.querySelector('.hops__subtitle');
    expect(title?.textContent).toBe('Probability sampling');
    expect(subtitle?.textContent).toBe(
      'Each frame samples one branch based on its probability.',
    );
  });

  it('does not produce horizontal overflow at mobile width (375px)', () => {
    const containerEl = document.createElement('div');
    containerEl.style.width = '375px';
    document.body.appendChild(containerEl);

    try {
      const { container } = render(
        <HOPsAnimation
          branches={[
            { id: 'a', title: 'Alpha', probability: 0.5 },
            { id: 'b', title: 'Beta', probability: 0.5 },
            { id: 'c', title: 'Gamma', probability: 0 },
          ]}
        />,
        { container: containerEl },
      );

      const section = container.querySelector('.hops');
      expect(section).not.toBeNull();

      // Inline width styles must not exceed 100% (the only inline width in HOPs is the bar fill).
      const allEls = container.querySelectorAll<HTMLElement>('[style*="width"]');
      allEls.forEach((el) => {
        const inline = el.style.width;
        if (!inline) return;
        if (inline.endsWith('%')) {
          const pct = parseFloat(inline);
          expect(pct).toBeLessThanOrEqual(100);
        } else if (inline.endsWith('px')) {
          const px = parseFloat(inline);
          expect(px).toBeLessThanOrEqual(375);
        }
      });
    } finally {
      document.body.removeChild(containerEl);
    }
  });
});
