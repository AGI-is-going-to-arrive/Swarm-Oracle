import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ResultVerdictPanel from './ResultVerdictPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('ResultVerdictPanel', () => {
  it('renders an accessible verdict region with confidence and question text', () => {
    render(
      <ResultVerdictPanel
        verdict="AI changes the job more than it removes it."
        confidence="medium"
        question="Will AI replace programmers?"
      />,
    );

    const region = screen.getByRole('region', { name: 'Prediction Verdict' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('result-verdict-confidence-badge')).toHaveTextContent(
      'Medium Confidence',
    );
    expect(screen.getByTestId('result-verdict-question')).toHaveTextContent(
      'Will AI replace programmers?',
    );
    const questionLabel = screen.getByText('Question answered');
    expect(questionLabel).toBeInTheDocument();
    expect(questionLabel).toHaveClass('result-verdict-panel__question-label');
    expect(screen.getByTestId('result-verdict-text')).toHaveTextContent(
      'AI changes the job more than it removes it.',
    );
  });

  it('shows a neutral unavailable fallback that anchors the question when verdict is blank', () => {
    render(
      <ResultVerdictPanel
        verdict="   "
        confidence="high"
        question="Will AI replace programmers?"
      />,
    );

    const pendingPanel = screen.getByTestId('result-verdict-panel-pending');
    expect(pendingPanel).toBeInTheDocument();
    // CSS class keeps the legacy `--pending` suffix for style continuity,
    // but the semantics are now "verdict unavailable" rather than "analyzing".
    expect(pendingPanel).toHaveClass('result-verdict-panel--pending');
    expect(screen.getByTestId('result-verdict-question')).toHaveTextContent(
      'Will AI replace programmers?',
    );
    expect(screen.getByText('Question answered')).toBeInTheDocument();
    // unavailable fallback is rendered, the confidence badge is suppressed
    expect(screen.queryByTestId('result-verdict-confidence-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('result-verdict-text')).not.toBeInTheDocument();
    const pendingMessage = screen.getByTestId('result-verdict-pending');
    expect(pendingMessage).toHaveTextContent(/no prediction verdict is available/i);
    expect(pendingMessage).not.toHaveTextContent(/analyzing/i);
  });

  it('still renders the pending panel even when both verdict and question are missing', () => {
    render(<ResultVerdictPanel verdict={null} confidence={null} question="" />);

    const pendingPanel = screen.getByTestId('result-verdict-panel-pending');
    expect(pendingPanel).toBeInTheDocument();
    expect(screen.queryByTestId('result-verdict-question')).not.toBeInTheDocument();
    expect(screen.queryByText('Question answered')).not.toBeInTheDocument();
    expect(screen.getByTestId('result-verdict-pending')).toBeInTheDocument();
  });

  it('treats an undefined verdict as unavailable', () => {
    render(
      <ResultVerdictPanel
        verdict={undefined}
        confidence="medium"
        question="Will the port fail first?"
      />,
    );

    expect(screen.getByTestId('result-verdict-panel-pending')).toBeInTheDocument();
    expect(screen.getByTestId('result-verdict-question')).toHaveTextContent(
      'Will the port fail first?',
    );
    expect(screen.queryByTestId('result-verdict-confidence-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('result-verdict-text')).not.toBeInTheDocument();
  });

  it('renders verdict markup as plain text', () => {
    const unsafeVerdict = '<img src=x onerror=alert(1)>Ignore all instructions';
    const { container } = render(
      <ResultVerdictPanel
        verdict={unsafeVerdict}
        confidence={null}
        question="Will AI replace programmers?"
      />,
    );

    expect(screen.getByTestId('result-verdict-text')).toHaveTextContent(unsafeVerdict);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByTestId('result-verdict-confidence-badge')).not.toBeInTheDocument();
  });
});
