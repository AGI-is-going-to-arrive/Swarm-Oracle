import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingGuide } from './OnboardingGuide';

const { useCapabilityCheckMock } = vi.hoisted(() => ({
  useCapabilityCheckMock: vi.fn(),
}));

vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'onboarding.step_indicator') {
        return `Step ${options?.current} of ${options?.total}`;
      }
      return key;
    },
  }),
}));

function setCapabilities(opts: {
  customAgents?: boolean;
  agentIdentity?: boolean;
  causalGraph?: boolean;
  loading?: boolean;
} = {}) {
  const { customAgents = true, agentIdentity = true, causalGraph = true, loading = false } = opts;
  useCapabilityCheckMock.mockImplementation((key: string) => {
    const enabled =
      key === 'custom_agents' ? customAgents :
      key === 'agent_identity' ? agentIdentity :
      key === 'causal_graph' ? causalGraph :
      false;
    return { loading, enabled, capabilities: null, error: null };
  });
}

describe('OnboardingGuide', () => {
  beforeEach(() => {
    useCapabilityCheckMock.mockReset();
    setCapabilities();
  });

  it('does not render when open=false', () => {
    const { container } = render(
      <OnboardingGuide open={false} onComplete={() => {}} />,
    );
    expect(container.querySelector('.onboarding-guide')).toBeNull();
  });

  it('renders the welcome step on first open', () => {
    render(<OnboardingGuide open onComplete={() => {}} />);
    expect(screen.getByText('onboarding.welcome_title')).toBeTruthy();
    expect(screen.getByText('onboarding.welcome_desc')).toBeTruthy();
  });

  it('shows 5 dots when all advanced capabilities are enabled', () => {
    setCapabilities({ customAgents: true, agentIdentity: true, causalGraph: true });
    render(<OnboardingGuide open onComplete={() => {}} />);
    const dots = document.querySelectorAll('.onboarding-guide__dot');
    expect(dots.length).toBe(5);
  });

  it('hides the advanced step when all advanced capabilities are disabled', () => {
    setCapabilities({ customAgents: false, agentIdentity: false, causalGraph: false });
    render(<OnboardingGuide open onComplete={() => {}} />);
    const dots = document.querySelectorAll('.onboarding-guide__dot');
    expect(dots.length).toBe(4);
    // Advanced step copy should not appear
    expect(screen.queryByText('onboarding.advanced_title')).toBeNull();
  });

  it('keeps the advanced step when at least one capability is enabled', () => {
    setCapabilities({ customAgents: false, agentIdentity: true, causalGraph: false });
    render(<OnboardingGuide open onComplete={() => {}} />);
    const dots = document.querySelectorAll('.onboarding-guide__dot');
    expect(dots.length).toBe(5);
  });

  it('Next advances through steps and Done calls onComplete on last step', () => {
    const onComplete = vi.fn();
    render(<OnboardingGuide open onComplete={onComplete} />);

    const nextBtn = screen.getByTestId('onboarding-next');
    // Default: 5 steps -> click Next 4 times to reach last, then Done.
    fireEvent.click(nextBtn);
    fireEvent.click(nextBtn);
    fireEvent.click(nextBtn);
    fireEvent.click(nextBtn);
    // Now on step 5; button label is now "onboarding.done"
    expect(nextBtn.textContent).toBe('onboarding.done');
    fireEvent.click(nextBtn);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('Back is disabled on the first step and enables after advancing', () => {
    render(<OnboardingGuide open onComplete={() => {}} />);
    const backBtn = screen.getByTestId('onboarding-back') as HTMLButtonElement;
    expect(backBtn.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('onboarding-next'));
    expect(backBtn.disabled).toBe(false);
    fireEvent.click(backBtn);
    expect(backBtn.disabled).toBe(true);
  });

  it('Skip calls onComplete immediately', () => {
    const onComplete = vi.fn();
    render(<OnboardingGuide open onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('clicking a dot jumps to that step', () => {
    render(<OnboardingGuide open onComplete={() => {}} />);
    const dots = document.querySelectorAll('.onboarding-guide__dot');
    expect(dots.length).toBe(5);
    fireEvent.click(dots[2]);
    // Step 3 is the chamber step
    expect(screen.getByText('onboarding.chamber_title')).toBeTruthy();
  });
});
