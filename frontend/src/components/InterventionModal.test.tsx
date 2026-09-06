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
    i18n: { language: 'en' },
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
      status: 'queued',
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
      status: 'queued',
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

  it('has correct a11y attributes for mode group and inputs', async () => {
    render(<InterventionModal {...baseProps} />);

    const modeGroup = screen.getByRole('group', { name: 'intervention.mode_label' });
    expect(modeGroup).toBeInTheDocument();

    const standardButton = screen.getByText('intervention.mode_standard').closest('button');
    const retrospectiveButton = screen.getByText('intervention.mode_retrospective').closest('button');
    const batchButton = screen.getByText('intervention.mode_batch').closest('button');
    expect(standardButton).toHaveAttribute('aria-pressed', 'true');
    expect(retrospectiveButton).toHaveAttribute('aria-pressed', 'false');
    expect(batchButton).toHaveAttribute('aria-pressed', 'false');

    const textarea = screen.getByRole('textbox', { name: 'intervention.input_label' });
    expect(textarea).toBeInTheDocument();
  });

  it('exposes a named modal dialog, traps focus, closes on Escape, and restores focus', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const onClose = vi.fn();
    const { unmount } = render(<InterventionModal {...baseProps} onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'intervention.title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('intervention.subtitle');
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'intervention.input_label' }),
    ));

    screen.getByRole('button', { name: 'intervention.submit' }).focus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('shows submitting state with aria-busy and correct text', async () => {
    const user = userEvent.setup();
    let resolveIntervene: (val: unknown) => void = () => {};
    interveneMock.mockReturnValue(new Promise(resolve => {
       resolveIntervene = resolve;
    }));

    render(<InterventionModal {...baseProps} />);
    const textarea = screen.getByRole('textbox', { name: 'intervention.input_label' });
    await user.type(textarea, 'Test');
    const submitBtn = screen.getByRole('button', { name: 'intervention.submit' });
    await user.click(submitBtn);

    expect(submitBtn).toHaveAttribute('aria-busy', 'true');
    expect(submitBtn).toHaveTextContent('intervention.submitting');

    resolveIntervene({ status: 'applied', intervention_id: 'int-1', branch_id: 'branch-1', round: 3 });

    await waitFor(() => {
       expect(screen.getByText('intervention.success_standard')).toBeInTheDocument();
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

  it('renders template variables and composes text', async () => {
    const user = userEvent.setup();
    getInterventionTemplatesMock.mockResolvedValue([
      {
        id: 'template-var',
        name: 'Target Variable Template',
        name_en: 'Target Variable Template',
        template: 'Target: {target}. Action: {action}.',
        variables: [
          { key: 'target', label_en: 'Target Name', label_zh: '目标名称', examples: ['John'] },
          { key: 'action', label_en: 'Action Type', label_zh: '操作类型', examples: ['Eliminate'] }
        ],
      }
    ]);

    render(<InterventionModal {...baseProps} />);

    await waitFor(() => expect(getInterventionTemplatesMock).toHaveBeenCalled());

    const templateButton = await screen.findByRole('button', { name: 'Target Variable Template' });
    await user.click(templateButton);

    const targetInput = screen.getByRole('textbox', { name: 'Target Name' });
    const actionInput = screen.getByRole('textbox', { name: 'Action Type' });
    expect(targetInput).toBeInTheDocument();
    expect(targetInput).toHaveAttribute('placeholder', 'John');

    const textarea = screen.getByRole('textbox', { name: 'intervention.input_label' });
    expect(textarea).toHaveValue('Target: {target}. Action: {action}.');

    await user.type(targetInput, 'Alpha');
    await user.type(actionInput, 'Negotiate');

    expect(textarea).toHaveValue('Target: Alpha. Action: Negotiate.');

    await user.click(screen.getByRole('button', { name: 'intervention.submit' }));

    await waitFor(() => {
      expect(interveneMock).toHaveBeenCalledWith('scenario-1', {
        branch_id: 'branch-1',
        text: 'Target: Alpha. Action: Negotiate.',
      });
    });
  });
});
