import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ResultVerdictPanel from './ResultVerdictPanel';
import type { FullReport } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; strong?: number; moderate?: number; unsupported?: number }) => key === 'result.report.claimSupportCounts'
      ? `${options?.strong} exact · ${options?.moderate} paraphrases · ${options?.unsupported} unsupported`
      : options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

describe('ResultVerdictPanel', () => {
  it('renders an accessible verdict region with confidence and question text', () => {
    render(
      <ResultVerdictPanel
        verdict="AI changes the job more than it removes it."
        confidence="medium"
        confidenceKind="model_self_rating"
        question="Will AI replace programmers?"
      />,
    );

    const region = screen.getByRole('region', { name: 'Prediction Verdict' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    const confidenceBadge = screen.getByTestId('result-verdict-confidence-badge');
    expect(confidenceBadge).toHaveTextContent(
      'Model self-rating: Medium Confidence',
    );
    expect(confidenceBadge).toHaveAttribute('data-confidence-kind', 'model_self_rating');
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

  it.each([undefined, null] as const)(
    'does not infer model self-rating when confidence kind is %s',
    (confidenceKind) => {
      render(
        <ResultVerdictPanel
          verdict="The model selects the audited branch."
          confidence="high"
          confidenceKind={confidenceKind}
          question="Which branch holds?"
        />,
      );

      const confidenceBadge = screen.getByTestId('result-verdict-confidence-badge');
      expect(confidenceBadge).toHaveTextContent('High Confidence');
      expect(confidenceBadge).not.toHaveTextContent('Model self-rating');
      expect(confidenceBadge).not.toHaveAttribute('data-confidence-kind');
    },
  );

  it('does not render a confidence badge for the explicit null backend contract', () => {
    render(
      <ResultVerdictPanel
        verdict="The simulation completed without a valid confidence rating."
        confidence={null}
        confidenceKind={null}
        question="Which branch holds?"
      />,
    );

    expect(screen.getByTestId('result-verdict-text')).toBeInTheDocument();
    expect(screen.queryByTestId('result-verdict-confidence-badge')).not.toBeInTheDocument();
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

function evidenceReport(): FullReport {
  return {
    version: '1', generated_at: '2026-09-05T00:00:00Z', generation_mode: 'static', detail_level: 'brief',
    target_branch_id: 'b1', target_branch_sort: ['probability_desc', 'fork_round_asc', 'id_asc'],
    language: 'zh', available_languages: ['zh', 'en'], language_status: { zh: 'available', en: 'available' }, title: '报告', title_i18n: { zh: '报告', en: 'Report' },
    summary: '摘要', summary_i18n: { zh: '摘要', en: 'Summary' }, status: 'complete', tier: 'static',
    verdict: { headline_answer: '存在风险。', likelihood: { probability: 0.5, interval: [0.5, 0.5], wep: 'missing' }, analytic_confidence: { level: 'low', basis: 'Saved checks', basis_i18n: { en: 'Coverage remains limited.', zh: '证据覆盖有限。' } }, disclaimer: null },
    claims: [{
      claim_id: 'c1', claim_text: '存在风险。', claim_type: 'assertion', speaker: '原始角色', agent_id: 'a1',
      message_ids: ['m1'], action_ids: [], branch_id: 'b1', round_numbers: [1], exact_quote: null,
      evidence_strength: 'moderate', temporal_coverage: ['early'], role_coverage: ['Analyst'], confidence: 'medium', downgrade_reason: null,
    }],
    sections: [], evidence: [{ id: 'ev1', branch_id: 'b1', round_id: 'r1', round_number: 1, agent_id: 'a1', agent_name: '原始角色', message_id: 'm1', quote: '存在一项风险。', kind: 'utterance' }],
    indicators_to_watch: [], dissenting: null, key_participants: [], follow_ups: [], limitations: '模型存在局限。', interview_evidence: [], premortem: [],
    authored_content_i18n: { en: { title: 'Report', summary: 'Summary', section_texts: {}, headline_answer: 'The translated report identifies a risk.', limitations: 'The model has limitations.', follow_ups: [], indicators_to_watch: [], dissenting: null, interview_evidence: [] } },
  };
}

it('shows the translated current report conclusion with an original-verdict disclosure', async () => {
  const user = userEvent.setup();
  render(<ResultVerdictPanel verdict="原始总体结论。" confidence="high" confidenceKind="model_self_rating" question="What happens?" report={evidenceReport()} />);
  expect(screen.getByTestId('result-verdict-text')).toHaveTextContent('The translated report identifies a risk.');
  expect(screen.getByText('result.report.translatedConclusion')).toBeInTheDocument();
  expect(screen.queryByTestId('result-verdict-confidence-badge')).toBeNull();
  await user.click(screen.getByText('result.report.originalVerdict'));
  expect(screen.getByText('原始总体结论。')).toBeVisible();
});

it('opens real evidence from a saved supported paraphrase and keeps original claim wording', async () => {
  const user = userEvent.setup();
  const onOpenEvidence = vi.fn();
  render(<ResultVerdictPanel verdict="Original verdict" confidence={null} question="Question" report={evidenceReport()} onOpenEvidence={onOpenEvidence} />);
  expect(screen.getByText('0 exact · 1 paraphrases · 0 unsupported')).toBeInTheDocument();
  await user.click(screen.getAllByRole('button', { name: 'result.report.viewCitedEvidence' })[0]);
  expect(onOpenEvidence).toHaveBeenCalledWith(['ev1']);
  await user.click(screen.getByText('result.report.inspectClaims'));
  const claim = screen.getByText('存在风险。').closest('li');
  expect(claim).not.toBeNull();
  expect(within(claim as HTMLElement).getByText('result.report.claimModerate')).toBeInTheDocument();
  await user.click(within(claim as HTMLElement).getByRole('button', { name: 'result.report.viewCitedEvidence' }));
  expect(onOpenEvidence).toHaveBeenLastCalledWith(['ev1']);
});

it('never substitutes a historical report translation for the current verdict', () => {
  render(<ResultVerdictPanel verdict="Current verdict" confidence={null} question="Question" report={evidenceReport()} reportStale />);
  expect(screen.getByTestId('result-verdict-text')).toHaveTextContent('Current verdict');
  expect(screen.getByText('result.report.historicalEvidence')).toBeInTheDocument();
  expect(screen.queryByText('The translated report identifies a risk.')).toBeNull();
});
