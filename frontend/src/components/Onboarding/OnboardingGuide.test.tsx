import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingGuide, SampleOnboardingGuide, type SampleCapabilityState } from './OnboardingGuide';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => key === 'onboarding.step_indicator'
      ? `Step ${options?.current} of ${options?.total}`
      : key,
  }),
}));

describe('OnboardingGuide saved sample entry', () => {
  it('does not render when closed', () => {
    render(<OnboardingGuide open={false} onComplete={vi.fn()} onOpenSample={vi.fn()} sampleCapabilityState="enabled" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a real sample action without marking the walkthrough complete', async () => {
    const user = userEvent.setup();
    const onOpenSample = vi.fn();
    const onComplete = vi.fn();
    render(<OnboardingGuide open onComplete={onComplete} onOpenSample={onOpenSample} sampleCapabilityState="enabled" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('onboarding.sample_no_llm')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-next')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('onboarding-open-sample'));
    expect(onOpenSample).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['loading', 'snapshot.capability_loading', false],
    ['disabled', 'snapshot.capability_disabled', false],
    ['error', 'snapshot.capability_error', true],
    ['unknown', 'snapshot.capability_error', true],
  ] as const)('keeps %s availability distinct and never imports', async (state, message, retryable) => {
    const user = userEvent.setup();
    const onOpenSample = vi.fn();
    const onRetryCapability = vi.fn();
    render(<OnboardingGuide open onComplete={vi.fn()} onOpenSample={onOpenSample} sampleCapabilityState={state as SampleCapabilityState} onRetryCapability={onRetryCapability} />);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-open-sample')).toBeDisabled();
    if (retryable) {
      await user.click(screen.getByRole('button', { name: 'snapshot.capability_retry' }));
      expect(onRetryCapability).toHaveBeenCalledTimes(1);
    } else {
      expect(screen.queryByRole('button', { name: 'snapshot.capability_retry' })).not.toBeInTheDocument();
    }
    expect(onOpenSample).not.toHaveBeenCalled();
  });

  it('keeps skip available while importing and exposes a retryable import error', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const onOpenSample = vi.fn();
    const { rerender } = render(<OnboardingGuide open onComplete={onComplete} onOpenSample={onOpenSample} sampleCapabilityState="enabled" importing />);
    expect(screen.getByTestId('onboarding-open-sample')).toBeDisabled();
    await user.click(screen.getByTestId('onboarding-skip'));
    expect(onComplete).toHaveBeenCalledTimes(1);
    rerender(<OnboardingGuide open onComplete={onComplete} onOpenSample={onOpenSample} sampleCapabilityState="enabled" importError="Saved sample unavailable" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Saved sample unavailable');
    await user.click(screen.getByTestId('onboarding-open-sample'));
    expect(onOpenSample).toHaveBeenCalledTimes(1);
  });

  it('can be opened, skipped with Escape and reopened using the keyboard', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Reopen walkthrough</button>
        <OnboardingGuide open={open} onComplete={() => setOpen(false)} onOpenSample={vi.fn()} sampleCapabilityState="enabled" />
      </>;
    }
    render(<Harness />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen walkthrough' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('onboarding-skip'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('SampleOnboardingGuide result actions', () => {
  it('delegates to real controls and only advances when the parent reports progress', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onSkip = vi.fn();
    const { rerender } = render(<SampleOnboardingGuide step="endings" onAction={onAction} onSkip={onSkip} />);
    await user.click(screen.getByRole('button', { name: 'onboarding.sample_endings_action' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading')).toHaveTextContent('onboarding.sample_endings_title');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<SampleOnboardingGuide step="divergence" onAction={onAction} onSkip={onSkip} />);
    expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'onboarding.skip' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('keeps unavailable evidence explicit and requires confirmed evidence access before completion', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onComplete = vi.fn();
    const { rerender } = render(<SampleOnboardingGuide step="evidence" onAction={onAction} onSkip={vi.fn()} unavailableReason="No saved evidence" />);
    expect(screen.getByRole('status')).toHaveTextContent('No saved evidence');
    expect(screen.getByRole('button', { name: 'onboarding.sample_evidence_action' })).toBeDisabled();
    rerender(<SampleOnboardingGuide step="evidence" onAction={onAction} onSkip={vi.fn()} onComplete={onComplete} />);
    expect(screen.getByText('onboarding.sample_run_later')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'onboarding.done' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });
});
