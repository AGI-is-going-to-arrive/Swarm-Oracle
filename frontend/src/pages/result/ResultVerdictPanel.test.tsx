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
    expect(screen.getByTestId('result-verdict-text')).toHaveTextContent(
      'AI changes the job more than it removes it.',
    );
  });

  it('hides completely when verdict text is blank', () => {
    const { container } = render(
      <ResultVerdictPanel verdict="   " confidence="high" question="Will AI replace programmers?" />,
    );

    expect(container).toBeEmptyDOMElement();
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
