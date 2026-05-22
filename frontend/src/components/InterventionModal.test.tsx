import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InterventionModal from './InterventionModal';

const {
  getInterventionTemplatesMock,
  interveneMock,
  interveneRetrospectiveMock,
  interveneBatchMock,
  capabilityState,
} = vi.hoisted(() => ({
  getInterventionTemplatesMock: vi.fn(),
  interveneMock: vi.fn(),
  interveneRetrospectiveMock: vi.fn(),
  interveneBatchMock: vi.fn(),
  capabilityState: {
    loading: false,
    enabled: true,
    error: null as Error | null,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('../api/client', () => ({
  getInterventionTemplates: getInterventionTemplatesMock,
  intervene: interveneMock,
  interveneRetrospective: interveneRetrospectiveMock,
  interveneBatch: interveneBatchMock,
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({
    loading: capabilityState.loading,
    enabled: capabilityState.enabled,
    capabilities: null,
    error: capabilityState.error,
  }),
}));

const baseProps = {
  scenarioId: 'scenario-1',
  branchId: 'branch-1',
  branchTitle: 'Alpha Branch',
  activeBranches: [
    { id: 'branch-1', title: 'Alpha Branch', status: 'ACTIVE' as const },
    { id: 'branch-2', title: 'Beta Branch', status: 'ACTIVE' as const },
  ],
  branchRoundLimits: {
    'branch-1': 3,
    'branch-2': 2,
  },
  currentRound: 3,
  onClose: vi.fn(),
};

async function clickMode(label: string) {
  const button = screen.getByText(label).closest('button');
  expect(button).toBeTruthy();
  await userEvent.click(button as HTMLButtonElement);
}

describe('InterventionModal advanced modes', () => {
  beforeEach(() => {
    getInterventionTemplatesMock.mockReset();
    getInterventionTemplatesMock.mockResolvedValue([]);
    interveneMock.mockReset();
    interveneMock.mockResolvedValue({
      status: 'applied',
      intervention_id: 'int-standard',
      branch_id: 'branch-1',
      round: 3,
    });
    interveneRetrospectiveMock.mockReset();
    interveneRetrospectiveMock.mockResolvedValue({
      status: 'created',
      intervention_id: 'int-retro',
      new_branch_id: 'branch-2',
      source_branch_id: 'branch-1',
      from_round: 2,
    });
    interveneBatchMock.mockReset();
    interveneBatchMock.mockResolvedValue({
      status: 'applied',
      count: 2,
      interventions: [],
    });
    capabilityState.loading = false;
    capabilityState.enabled = true;
    capabilityState.error = null;
  });

  it('submits a standard intervention through the existing client', async () => {
    const user = userEvent.setup();

    render(<InterventionModal {...baseProps} />);

    await waitFor(() => expect(getInterventionTemplatesMock).toHaveBeenCalled());
    await user.type(screen.getByPlaceholderText('intervention.placeholder'), 'Meteor impact');
    await user.click(screen.getByRole('button', { name: 'intervention.submit' }));

    await waitFor(() => {
      expect(interveneMock).toHaveBeenCalledWith('scenario-1', {
        branch_id: 'branch-1',
        text: 'Meteor impact',
      });
    });
  });

  it('submits a retrospective intervention to the dedicated endpoint', async () => {
    const user = userEvent.setup();

    render(<InterventionModal {...baseProps} />);

    await waitFor(() => expect(getInterventionTemplatesMock).toHaveBeenCalled());
    await clickMode('intervention.mode_retrospective');
    await user.selectOptions(screen.getByLabelText('intervention.retrospective_round_label'), '2');
    await user.type(screen.getByPlaceholderText('intervention.placeholder'), 'Delay the senate vote');
    await user.click(screen.getByRole('button', { name: 'intervention.submit' }));

    await waitFor(() => {
      expect(interveneRetrospectiveMock).toHaveBeenCalledWith('scenario-1', {
        branch_id: 'branch-1',
        round_number: 2,
        text: 'Delay the senate vote',
      });
    });
  });

  it('submits a batch intervention for all selected active branches', async () => {
    const user = userEvent.setup();

    render(<InterventionModal {...baseProps} />);

    await waitFor(() => expect(getInterventionTemplatesMock).toHaveBeenCalled());
    await clickMode('intervention.mode_batch');
    await user.click(screen.getByRole('checkbox', { name: /Beta Branch/ }));
    await user.type(screen.getByPlaceholderText('intervention.placeholder'), 'Seal all borders');
    await user.click(screen.getByRole('button', { name: 'intervention.submit' }));

    await waitFor(() => {
      expect(interveneBatchMock).toHaveBeenCalledWith('scenario-1', {
        interventions: [
          { branch_id: 'branch-1', text: 'Seal all borders' },
          { branch_id: 'branch-2', text: 'Seal all borders' },
        ],
      });
    });
  });

  it('disables retrospective mode when the branch has no completed rounds yet', async () => {
    render(
      <InterventionModal
        {...baseProps}
        activeBranches={[{ id: 'branch-1', title: 'Alpha Branch', status: 'ACTIVE' }]}
        branchRoundLimits={{}}
        currentRound={0}
      />,
    );

    await waitFor(() => expect(getInterventionTemplatesMock).toHaveBeenCalled());
    const retrospectiveButton = screen.getByText('intervention.mode_retrospective').closest('button');
    expect(retrospectiveButton).toBeDisabled();
    expect(screen.getByText('intervention.retrospective_disabled_hint')).toBeInTheDocument();
  });

  it('disables retrospective mode when counterfactual replay capability is off', async () => {
    capabilityState.enabled = false;

    render(<InterventionModal {...baseProps} />);

    await waitFor(() => expect(getInterventionTemplatesMock).toHaveBeenCalled());
    const retrospectiveButton = screen.getByText('intervention.mode_retrospective').closest('button');
    expect(retrospectiveButton).toBeDisabled();
    expect(screen.getByText('intervention.retrospective_feature_disabled')).toBeInTheDocument();
    expect(interveneRetrospectiveMock).not.toHaveBeenCalled();
  });

  it('disables retrospective mode when the capability probe fails', async () => {
    capabilityState.enabled = false;
    capabilityState.error = new Error('capabilities failed');

    render(<InterventionModal {...baseProps} />);

    await waitFor(() => expect(getInterventionTemplatesMock).toHaveBeenCalled());
    const retrospectiveButton = screen.getByText('intervention.mode_retrospective').closest('button');
    expect(retrospectiveButton).toBeDisabled();
    expect(screen.getByText('common.capability_error')).toBeInTheDocument();
    expect(interveneRetrospectiveMock).not.toHaveBeenCalled();
  });
});
