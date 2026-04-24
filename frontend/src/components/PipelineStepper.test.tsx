import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { PipelineStepper } from './PipelineStepper';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

// ── Mock simulationStore ──
let mockStatus = 'idle';

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: mockStatus }),
}));

function renderStepper(route: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[route]}>
        <PipelineStepper />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('PipelineStepper', () => {
  beforeEach(() => {
    mockStatus = 'idle';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Route gating ──

  it('renders on /sim/:id route when status is active', () => {
    mockStatus = 'parsing';
    renderStepper('/sim/test-id');
    expect(screen.getByTestId('pipeline-stepper')).toBeInTheDocument();
  });

  it('renders on /result/:id route when status is active', () => {
    mockStatus = 'simulating';
    renderStepper('/result/test-id');
    expect(screen.getByTestId('pipeline-stepper')).toBeInTheDocument();
  });

  it('does NOT render on root route', () => {
    mockStatus = 'parsing';
    renderStepper('/');
    expect(screen.queryByTestId('pipeline-stepper')).not.toBeInTheDocument();
  });

  it('does NOT render on /debate route', () => {
    mockStatus = 'simulating';
    renderStepper('/debate/some-id');
    expect(screen.queryByTestId('pipeline-stepper')).not.toBeInTheDocument();
  });

  it('does NOT render on /history route', () => {
    mockStatus = 'narrating';
    renderStepper('/history');
    expect(screen.queryByTestId('pipeline-stepper')).not.toBeInTheDocument();
  });

  it('does NOT render on /sim/replay route', () => {
    mockStatus = 'parsing';
    renderStepper('/sim/replay');
    expect(screen.queryByTestId('pipeline-stepper')).not.toBeInTheDocument();
  });

  // ── Status display ──

  it('shows correct stage for parsing status', () => {
    mockStatus = 'parsing';
    renderStepper('/sim/test-id');

    const parsingStep = screen.getByTestId('pipeline-step-parsing');
    expect(parsingStep.className).toContain('pipeline-stepper__step--active');
  });

  it('shows correct stage for simulating status', () => {
    mockStatus = 'simulating';
    renderStepper('/sim/test-id');

    const simulatingStep = screen.getByTestId('pipeline-step-simulating');
    expect(simulatingStep.className).toContain('pipeline-stepper__step--active');

    // parsing should be completed
    const parsingStep = screen.getByTestId('pipeline-step-parsing');
    expect(parsingStep.className).toContain('pipeline-stepper__step--completed');
  });

  it('shows correct stage for narrating status', () => {
    mockStatus = 'narrating';
    renderStepper('/sim/test-id');

    const narratingStep = screen.getByTestId('pipeline-step-narrating');
    expect(narratingStep.className).toContain('pipeline-stepper__step--active');

    // previous stages should be completed
    const parsingStep = screen.getByTestId('pipeline-step-parsing');
    expect(parsingStep.className).toContain('pipeline-stepper__step--completed');
    const simulatingStep = screen.getByTestId('pipeline-step-simulating');
    expect(simulatingStep.className).toContain('pipeline-stepper__step--completed');
  });

  it('shows correct stage for done status', () => {
    mockStatus = 'done';
    renderStepper('/sim/test-id');

    const doneStep = screen.getByTestId('pipeline-step-done');
    expect(doneStep.className).toContain('pipeline-stepper__step--active');

    // all previous stages should be completed
    const parsingStep = screen.getByTestId('pipeline-step-parsing');
    expect(parsingStep.className).toContain('pipeline-stepper__step--completed');
  });

  it('is hidden when status is idle', () => {
    mockStatus = 'idle';
    renderStepper('/sim/test-id');

    const stepper = screen.getByTestId('pipeline-stepper');
    expect(stepper.className).toContain('pipeline-stepper--hidden');
  });

  // ── Aria attributes ──

  it('has correct aria attributes for progressbar', () => {
    mockStatus = 'simulating';
    renderStepper('/sim/test-id');

    const stepper = screen.getByTestId('pipeline-stepper');
    expect(stepper.getAttribute('role')).toBe('progressbar');
    expect(stepper.getAttribute('aria-valuenow')).toBe('1');
    expect(stepper.getAttribute('aria-valuemax')).toBe('3');
    expect(stepper.getAttribute('aria-label')).toBeTruthy();
  });

  it('has aria-valuemin of 0', () => {
    mockStatus = 'parsing';
    renderStepper('/sim/test-id');

    const stepper = screen.getByTestId('pipeline-stepper');
    expect(stepper.getAttribute('aria-valuemin')).toBe('0');
  });

  // ── Auto-fade on result route ──

  it('auto-fades on result route after done', () => {
    mockStatus = 'done';
    renderStepper('/result/test-id');

    const stepper = screen.getByTestId('pipeline-stepper');
    // Initially visible
    expect(stepper.className).not.toContain('pipeline-stepper--hidden');

    // After 2000ms, should fade out
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(stepper.className).toContain('pipeline-stepper--hidden');
  });

  it('does NOT auto-fade on sim route after done', () => {
    mockStatus = 'done';
    renderStepper('/sim/test-id');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    const stepper = screen.getByTestId('pipeline-stepper');
    expect(stepper.className).not.toContain('pipeline-stepper--hidden');
  });

  // ── Error state ──

  it('renders error indicator for error status', () => {
    mockStatus = 'error';
    renderStepper('/sim/test-id');

    const stepper = screen.getByTestId('pipeline-stepper');
    expect(stepper.className).toContain('pipeline-stepper--error');
  });

  it('keeps progressbar value in range on error', () => {
    mockStatus = 'error';
    renderStepper('/sim/test-id');

    const stepper = screen.getByTestId('pipeline-stepper');
    expect(stepper).toHaveAttribute('aria-valuemin', '0');
    expect(stepper).toHaveAttribute('aria-valuenow', '0');
  });

  it('does not mark any step as active or completed on error', () => {
    mockStatus = 'error';
    renderStepper('/sim/test-id');

    const parsingStep = screen.getByTestId('pipeline-step-parsing');
    expect(parsingStep.className).not.toContain('pipeline-stepper__step--active');
    expect(parsingStep.className).not.toContain('pipeline-stepper__step--completed');
  });

  // ── All 4 steps rendered ──

  it('renders all 4 pipeline stages', () => {
    mockStatus = 'parsing';
    renderStepper('/sim/test-id');

    expect(screen.getByTestId('pipeline-step-parsing')).toBeInTheDocument();
    expect(screen.getByTestId('pipeline-step-simulating')).toBeInTheDocument();
    expect(screen.getByTestId('pipeline-step-narrating')).toBeInTheDocument();
    expect(screen.getByTestId('pipeline-step-done')).toBeInTheDocument();
  });
});
