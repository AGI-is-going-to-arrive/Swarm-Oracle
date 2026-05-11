import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EducationTemplate } from '../../api/client';
import { EducationTemplatePicker } from '../EducationTemplatePicker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && typeof fallbackOrOpts === 'object') {
        const opts = fallbackOrOpts as Record<string, unknown>;
        if (key === 'education.suggested_config') {
          return `Suggested: ${opts.agents} agents, ${opts.rounds} rounds`;
        }
      }
      return key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

const apiMocks = vi.hoisted(() => ({
  listEducationTemplates: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  listEducationTemplates: apiMocks.listEducationTemplates,
}));

function makeTemplate(overrides: Partial<EducationTemplate> = {}): EducationTemplate {
  return {
    id: 'tpl-1',
    category: 'history',
    title_zh: '历史模板',
    title_en: 'History Template',
    description_zh: '历史描述',
    description_en: 'A history description',
    difficulty: 'beginner',
    suggested_agents: 5,
    suggested_rounds: 8,
    tags: ['classical', 'civics'],
    default_config: { mode: 'blackboard' },
    ...overrides,
  };
}

const sampleTemplates: EducationTemplate[] = [
  makeTemplate({
    id: 'tpl-history',
    category: 'history',
    title_en: 'History Lab',
    description_en: 'Explore counterfactual histories.',
    difficulty: 'beginner',
    suggested_agents: 4,
    suggested_rounds: 6,
    tags: ['empire'],
  }),
  makeTemplate({
    id: 'tpl-econ',
    category: 'economics',
    title_en: 'Macro Shocks',
    description_en: 'Analyze how shocks propagate.',
    difficulty: 'intermediate',
    suggested_agents: 6,
    suggested_rounds: 10,
    tags: ['markets', 'policy'],
  }),
  makeTemplate({
    id: 'tpl-ai',
    category: 'ai',
    title_en: 'AI Alignment Drill',
    description_en: 'Stress-test alignment proposals.',
    difficulty: 'advanced',
    suggested_agents: 8,
    suggested_rounds: 12,
    tags: ['safety'],
  }),
];

beforeEach(() => {
  apiMocks.listEducationTemplates.mockReset();
  apiMocks.listEducationTemplates.mockResolvedValue({ templates: sampleTemplates });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EducationTemplatePicker', () => {
  it('returns null when not open (no overlay rendered)', () => {
    render(
      <EducationTemplatePicker
        open={false}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    expect(screen.queryByTestId('edu-picker-overlay')).not.toBeInTheDocument();
  });

  it('renders cards from injected mock data', () => {
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    expect(screen.getByTestId('edu-picker-overlay')).toBeInTheDocument();
    expect(screen.getByText('History Lab')).toBeInTheDocument();
    expect(screen.getByText('Macro Shocks')).toBeInTheDocument();
    expect(screen.getByText('AI Alignment Drill')).toBeInTheDocument();
  });

  it('fetches templates from API when no templates prop is given', async () => {
    render(
      <EducationTemplatePicker open onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    await waitFor(() => {
      expect(apiMocks.listEducationTemplates).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('History Lab')).toBeInTheDocument();
  });

  it('shows loading while the initial API request is pending', () => {
    apiMocks.listEducationTemplates.mockReturnValueOnce(new Promise(() => {}));
    render(
      <EducationTemplatePicker open onClose={vi.fn()} onSelect={vi.fn()} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading templates…');
    expect(screen.queryByText('education.no_templates')).not.toBeInTheDocument();
  });

  it('filters by category via the dropdown', () => {
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    const select = screen.getByLabelText('education.filter_category') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'economics' } });
    expect(screen.queryByText('History Lab')).not.toBeInTheDocument();
    expect(screen.getByText('Macro Shocks')).toBeInTheDocument();
    expect(screen.queryByText('AI Alignment Drill')).not.toBeInTheDocument();
  });

  it('filters by difficulty via pills', () => {
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    const advancedPill = screen.getByRole('button', { name: 'education.difficulty_advanced' });
    fireEvent.click(advancedPill);
    expect(advancedPill).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('History Lab')).not.toBeInTheDocument();
    expect(screen.queryByText('Macro Shocks')).not.toBeInTheDocument();
    expect(screen.getByText('AI Alignment Drill')).toBeInTheDocument();
  });

  it('combines category and difficulty filters', () => {
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    const select = screen.getByLabelText('education.filter_category') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'history' } });
    fireEvent.click(screen.getByRole('button', { name: 'education.difficulty_intermediate' }));
    expect(screen.queryByText('History Lab')).not.toBeInTheDocument();
    expect(screen.queryByText('Macro Shocks')).not.toBeInTheDocument();
  });

  it('calls onSelect when a card CTA is clicked', () => {
    const onSelect = vi.fn();
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={onSelect}
        templates={sampleTemplates}
      />,
    );
    const ctas = screen.getAllByRole('button', { name: 'education.select_template' });
    fireEvent.click(ctas[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      id: 'tpl-history',
      suggested_agents: 4,
    });
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(
      <EducationTemplatePicker
        open
        onClose={onClose}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when overlay backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <EducationTemplatePicker
        open
        onClose={onClose}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    const overlay = screen.getByTestId('edu-picker-overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no templates match filters', () => {
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    const select = screen.getByLabelText('education.filter_category') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'history' } });
    fireEvent.click(screen.getByRole('button', { name: 'education.difficulty_advanced' }));
    expect(screen.getByText('education.no_templates')).toBeInTheDocument();
  });

  it('renders difficulty badges with the correct color variant class', () => {
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={sampleTemplates}
      />,
    );
    const beginnerCard = screen.getByTestId('edu-template-card-tpl-history');
    expect(beginnerCard.querySelector('.edu-difficulty-badge--beginner')).not.toBeNull();
    const advancedCard = screen.getByTestId('edu-template-card-tpl-ai');
    expect(advancedCard.querySelector('.edu-difficulty-badge--advanced')).not.toBeNull();
  });

  it('renders suggested config string with agents and rounds interpolated', () => {
    render(
      <EducationTemplatePicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        templates={[sampleTemplates[1]]}
      />,
    );
    expect(screen.getByText(/Suggested: 6 agents, 10 rounds/i)).toBeInTheDocument();
  });

  it('renders empty state when API returns empty list', async () => {
    apiMocks.listEducationTemplates.mockResolvedValueOnce({ templates: [] });
    render(
      <EducationTemplatePicker open onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByText('education.no_templates')).toBeInTheDocument();
    });
  });

  it('shows error state when API rejects', async () => {
    apiMocks.listEducationTemplates.mockRejectedValueOnce(new Error('boom'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(
      <EducationTemplatePicker open onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load templates. Please retry.');
    });
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('education.no_templates')).not.toBeInTheDocument();
    debugSpy.mockRestore();
  });

  it('retries after API errors', async () => {
    apiMocks.listEducationTemplates.mockRejectedValueOnce(new Error('boom'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(
      <EducationTemplatePicker open onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(apiMocks.listEducationTemplates).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('History Lab')).toBeInTheDocument();
    debugSpy.mockRestore();
  });
});
