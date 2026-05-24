import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { PhaseInsightTimeline } from './PhaseInsightTimeline';
import type { EndingRoomPhaseInsight } from '../../types';

const messages = {
  roundtable: {
    phase_insights_label: 'Key takeaways',
    insight_focus_label: 'Moderator focus',
    phase_unknown: 'Phase',
    phase_opening: 'Opening',
    phase_crossfire: 'Crossfire',
    phase_rebuttal: 'Rebuttal',
    phase_closing: 'Closing',
    phase_verdict: 'Verdict',
  },
};

beforeEach(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      resources: {
        en: {
          translation: messages,
        },
      },
      interpolation: { escapeValue: false },
      returnEmptyString: false,
    });
  } else {
    // Refresh resource bundle so each test has a clean copy
    i18n.removeResourceBundle('en', 'translation');
    i18n.addResourceBundle('en', 'translation', messages, true, true);
    await i18n.changeLanguage('en');
  }
});

function buildPhases(): EndingRoomPhaseInsight[] {
  return [
    {
      phase: 'opening',
      stakes: 'Opening stakes',
      moderator_focus: 'Open the topic',
      commentary: 'Opening commentary text in full.',
    },
    {
      phase: 'crossfire',
      stakes: 'Crossfire stakes',
      moderator_focus: 'Pressure the seam',
      commentary: 'Crossfire commentary text in full.',
    },
    {
      phase: 'verdict',
      stakes: 'Verdict stakes',
      moderator_focus: 'Pronounce the verdict',
      commentary: 'Verdict commentary text in full.',
    },
  ];
}

function renderTimeline(props: Partial<React.ComponentProps<typeof PhaseInsightTimeline>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <PhaseInsightTimeline phases={buildPhases()} {...props} />
    </I18nextProvider>,
  );
}

describe('PhaseInsightTimeline', () => {
  it('renders a phase chip and short title for each phase', () => {
    renderTimeline();
    expect(screen.getByText('Opening')).toBeInTheDocument();
    expect(screen.getByText('Crossfire')).toBeInTheDocument();
    expect(screen.getByText('Verdict')).toBeInTheDocument();
    expect(screen.getByText('Opening commentary text in full.')).toBeInTheDocument();
  });

  it('collapses every item by default and exposes them as buttons', () => {
    renderTimeline();
    const triggers = screen.getAllByRole('button');
    expect(triggers.length).toBeGreaterThanOrEqual(3);
    for (const trigger of triggers) {
      expect(trigger.getAttribute('data-state')).toBe('closed');
    }
    // No expanded body should be visible
    expect(
      screen.queryByText('Opening', { selector: '.phase-insight-expanded__focus' }),
    ).toBeNull();
  });

  it('expands the clicked phase on activation', async () => {
    const user = userEvent.setup();
    renderTimeline();
    const openingTrigger = screen
      .getByText('Opening')
      .closest('button') as HTMLButtonElement;
    await user.click(openingTrigger);
    expect(openingTrigger.getAttribute('data-state')).toBe('open');
    // Moderator focus label is rendered inside the expanded body
    expect(screen.getByText(/Moderator focus: Open the topic/)).toBeInTheDocument();
  });

  it('invokes onPhaseClick with the phase id and index', async () => {
    const user = userEvent.setup();
    const onPhaseClick = vi.fn();
    renderTimeline({ onPhaseClick });
    const crossfireTrigger = screen
      .getByText('Crossfire')
      .closest('button') as HTMLButtonElement;
    await user.click(crossfireTrigger);
    expect(onPhaseClick).toHaveBeenCalledWith('crossfire', 1);
  });

  it('returns null when no phases provided', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <PhaseInsightTimeline phases={[]} />
      </I18nextProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders provided action buttons inside the expanded body', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderTimeline({
      renderActions: (_insight, index) => (
        <button type="button" onClick={() => onAction(index)}>
          Action {index}
        </button>
      ),
    });
    const verdictTrigger = screen
      .getByText('Verdict')
      .closest('button') as HTMLButtonElement;
    await user.click(verdictTrigger);
    const actionBtn = await screen.findByRole('button', { name: 'Action 2' });
    await user.click(actionBtn);
    expect(onAction).toHaveBeenCalledWith(2);
  });

  it('uses heading button semantics via the accordion primitive', () => {
    renderTimeline();
    // Each trigger sits inside a heading role provided by Radix accordion header
    const headings = screen.getAllByRole('heading');
    expect(headings.length).toBeGreaterThanOrEqual(3);
    // The first heading should contain the Opening chip text
    expect(within(headings[0]).getByText('Opening')).toBeInTheDocument();
  });

  it('exposes the timeline with an accessible aria-label', () => {
    const { container } = renderTimeline();
    const timeline = container.querySelector('.roundtable-phase-timeline');
    expect(timeline?.getAttribute('aria-label')).toBe('Key takeaways');
  });
});
