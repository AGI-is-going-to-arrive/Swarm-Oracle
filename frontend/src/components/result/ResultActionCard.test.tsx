import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { ResultActionCard } from './ResultActionCard';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

type MqlListener = (evt: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean) {
  const listeners: MqlListener[] = [];
  const mql: MediaQueryList = {
    matches,
    media: '(max-width: 640px)',
    onchange: null,
    addEventListener: (_evt: string, cb: EventListener) =>
      listeners.push(cb as MqlListener),
    removeEventListener: (_evt: string, cb: EventListener) => {
      const idx = listeners.indexOf(cb as MqlListener);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    addListener: (cb: MqlListener) => listeners.push(cb),
    removeListener: (cb: MqlListener) => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    dispatchEvent: () => true,
  };
  const original = window.matchMedia;
  window.matchMedia = () => mql;
  return () => {
    window.matchMedia = original;
  };
}

describe('ResultActionCard', () => {
  let restoreMedia: () => void = () => {};

  afterEach(() => {
    restoreMedia();
    // reset hash
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', ' ');
    }
  });

  describe('desktop (matchMedia → false)', () => {
    beforeEach(() => {
      restoreMedia = installMatchMedia(false);
    });

    it('renders desktop sticky variant with cta', () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ResultActionCard agentIdentityId="id1" />
        </I18nextProvider>,
      );
      const btn = screen.getByTestId('result-action-conversation');
      expect(btn.getAttribute('data-variant')).toBe('desktop-sticky');
    });

    it('P4 deep-link hash on click', () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ResultActionCard agentIdentityId="abc" />
        </I18nextProvider>,
      );
      const btn = screen.getByTestId('result-action-conversation');
      act(() => {
        fireEvent.click(btn);
      });
      expect(window.location.hash).toMatch(/agent_profile=abc/);
      expect(window.location.hash).toMatch(/tab=memory/);
    });

    it('does not update hash when no agentIdentityId', () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ResultActionCard />
        </I18nextProvider>,
      );
      const btn = screen.getByTestId('result-action-conversation');
      act(() => {
        fireEvent.click(btn);
      });
      expect(window.location.hash).toBe('');
    });
  });

  describe('mobile (matchMedia → true)', () => {
    beforeEach(() => {
      restoreMedia = installMatchMedia(true);
    });

    it('renders mobile trigger variant and fires onMobileTriggerClick', () => {
      const handler = vi.fn();
      render(
        <I18nextProvider i18n={i18n}>
          <ResultActionCard agentIdentityId="id1" onMobileTriggerClick={handler} />
        </I18nextProvider>,
      );
      const btn = screen.getByTestId('result-action-conversation');
      expect(btn.getAttribute('data-variant')).toBe('mobile-trigger');
      act(() => {
        fireEvent.click(btn);
      });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('falls back to the hash deep-link when no mobile handler is provided', () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ResultActionCard agentIdentityId="mobile-id" />
        </I18nextProvider>,
      );
      const btn = screen.getByTestId('result-action-conversation');
      act(() => {
        fireEvent.click(btn);
      });
      expect(window.location.hash).toMatch(/agent_profile=mobile-id/);
      expect(window.location.hash).toMatch(/tab=memory/);
    });
  });
});
