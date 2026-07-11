import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CounterfactualPanel } from './CounterfactualPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../api/client', () => ({
  ApiError: class MockApiError extends Error {
    status = 500;
  },
  submitCounterfactual: vi.fn(),
}));

describe('CounterfactualPanel responsive controls', () => {
  it('keeps a long Agent option inside a wrapping, shrinkable control row', () => {
    const longAgentName = 'A very long locally generated Agent name that must not widen the result page';

    render(
      <CounterfactualPanel
        scenarioId="scenario-1"
        branchId="branch-1"
        agents={[{
          id: 'agent-1',
          name: longAgentName,
          role: 'Strategic analyst with an equally descriptive role',
          tier: 'CORE',
          emotion: 'focused',
        }]}
        messages={[{
          agent: longAgentName,
          agent_id: 'agent-1',
          message: 'Hold the line.',
          emotion: 'focused',
          branch: 'branch-1',
          round: 1,
        }]}
        totalRounds={3}
      />,
    );

    const agentSelect = screen.getByRole('combobox', { name: 'counterfactual.agent' });
    const roundSelect = screen.getByRole('combobox', { name: 'counterfactual.round' });
    const agentField = agentSelect.parentElement;
    const roundField = roundSelect.parentElement;
    const controls = agentField?.parentElement;

    expect(screen.getByRole('option', { name: new RegExp(longAgentName) })).toBeInTheDocument();
    expect(controls).toHaveStyle({ flexWrap: 'wrap' });
    expect(agentField).toHaveStyle({
      flex: '1 1 14rem',
      minWidth: '0',
      maxWidth: '100%',
    });
    expect(roundField).toHaveStyle({
      flex: '0 1 8rem',
      minWidth: '0',
      maxWidth: '100%',
    });
    expect(agentSelect).toHaveStyle({
      boxSizing: 'border-box',
      width: '100%',
      minWidth: '0',
      maxWidth: '100%',
    });
  });
});
