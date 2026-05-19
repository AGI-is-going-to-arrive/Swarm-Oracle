import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import type { ComponentProps } from 'react';

import { ScenarioAgentPicker } from './ScenarioAgentPicker';
import type { AgentInfo } from '../../types';

const i18n = i18next.createInstance();

void i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        result: {
          agent_picker_title: 'Pick an Agent to Ask',
          agent_picker_select: 'Start conversation',
          agent_picker_tier_core: 'Core',
          agent_picker_tier_important: 'Important',
          agent_picker_tier_crowd: 'Crowd',
          agent_picker_view_profile: 'View profile',
        },
        common: {
          close: 'Close',
        },
      },
    },
  },
});

const agents: AgentInfo[] = [
  {
    id: 'agent-1',
    name: 'Ada',
    role: 'Systems analyst',
    persona: 'Reads the room before speaking.',
    tier: 'IMPORTANT',
    emotion: 'calm',
    agent_identity_id: 'identity-1',
  },
  {
    id: 'agent-2',
    name: 'Bo',
    role: 'Field observer',
    tier: 'CROWD',
    emotion: 'curious',
  },
];

function renderPicker(overrides?: Partial<ComponentProps<typeof ScenarioAgentPicker>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ScenarioAgentPicker
        open
        agents={agents}
        onSelect={() => {}}
        onClose={() => {}}
        {...overrides}
      />
    </I18nextProvider>,
  );
}

describe('ScenarioAgentPicker', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('renders agents as list items with button cards and profile links', () => {
    renderPicker();

    expect(screen.getByRole('dialog', { name: 'Pick an Agent to Ask' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Ada/ })).toHaveAttribute('data-agent-id', 'agent-1');
    expect(screen.getByText('A')).toHaveClass('scenario-agent-picker__avatar');
    expect(screen.getByText('Reads the room before speaking.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View profile: Ada' })).toHaveAttribute(
      'href',
      '/agents#agent_profile=identity-1&tab=memory',
    );
  });

  it('selects an agent from the card without treating profile link clicks as selection', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    const profileLink = screen.getByRole('link', { name: 'View profile: Ada' });
    profileLink.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(profileLink);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Ada/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-1' }));
  });
});
