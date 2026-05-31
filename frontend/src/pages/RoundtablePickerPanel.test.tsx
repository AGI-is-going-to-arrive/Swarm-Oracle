import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RoundtablePickerPanel from './RoundtablePickerPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (typeof values?.name === 'string') return values.name;
      if (typeof values?.title === 'string') return values.title;
      return key;
    },
  }),
}));

describe('RoundtablePickerPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to mouse-up seat hit testing when desktop drag sensors miss', () => {
    const onSelectRepresentative = vi.fn();
    render(
      <RoundtablePickerPanel
        selectionMode="representative"
        onSelectionModeChange={vi.fn()}
        effectiveSnapshot={null}
        branches={[
          {
            id: 'branch-a',
            title: 'Archive A',
            probability: 1,
            status: 'COMPLETED',
            story: 'A',
            insight: 'A',
            key_moments: [],
            parent_branch_id: null,
            fork_reason: '',
          },
        ]}
        branchOrder={['branch-a']}
        branchCandidates={{
          'branch-a': [
            {
              id: 'agent-a',
              name: 'Rep A',
              role: 'Marshal',
              persona: 'Keeps the first seat.',
              impactScore: 0.5,
              contributionCount: 1,
              keyMomentHits: 0,
              lastRound: 1,
              fallbackCast: false,
            },
            {
              id: 'agent-b',
              name: 'Rep B',
              role: 'Steward',
              persona: 'Can be dragged into the seat.',
              impactScore: 0.7,
              contributionCount: 2,
              keyMomentHits: 1,
              lastRound: 2,
              fallbackCast: false,
            },
          ],
        }}
        selectedRepresentatives={{ 'branch-a': 'agent-a' }}
        onSelectRepresentative={onSelectRepresentative}
        selectedBranchIdsForLaunch={['branch-a']}
        selectionUsesShortlist={false}
        manualShortlistMin={2}
        manualShortlistMax={3}
        onToggleManualShortlistBranch={vi.fn()}
        witnessCandidates={[]}
        selectedWitness={null}
        onSelectWitness={vi.fn()}
        launchingRoom={false}
        onLaunchRoundtable={vi.fn()}
        onCancelEditing={vi.fn()}
      />,
    );

    const source = screen.getByRole('button', { name: /Rep B/ });
    const targetSeat = screen.getByTestId('roundtable-seat-slot-branch-a');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => targetSeat),
    });

    fireEvent.mouseDown(source, { button: 0, clientX: 120, clientY: 520 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 130, clientY: 460 });
    fireEvent.mouseUp(window, { button: 0, clientX: 160, clientY: 160 });

    expect(onSelectRepresentative).toHaveBeenCalledWith('branch-a', 'agent-b');
  });
});
