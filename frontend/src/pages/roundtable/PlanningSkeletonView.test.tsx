import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanningSkeletonView } from './PlanningSkeletonView';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'roundtable.planning_preparing') return 'Preparing roundtable...';
      if (key === 'roundtable.planning_turns') return `Planning ${opts?.count} discussion turns...`;
      return key;
    },
  }),
}));

describe('PlanningSkeletonView', () => {
  const basePlanningState = {
    room_id: 'room-1',
    discussion_format: 'deep_dive' as const,
    cast_mode: 'smart_pick' as const,
    planned_turn_count: 5,
    phase: 'opening',
  };

  it('renders preparing text', () => {
    render(<PlanningSkeletonView planningState={basePlanningState} />);
    expect(screen.getByText('Preparing roundtable...')).toBeTruthy();
  });

  it('renders turn count when > 0', () => {
    render(<PlanningSkeletonView planningState={basePlanningState} />);
    expect(screen.getByText('Planning 5 discussion turns...')).toBeTruthy();
  });

  it('hides turn count when 0', () => {
    render(<PlanningSkeletonView planningState={{ ...basePlanningState, planned_turn_count: 0 }} />);
    expect(screen.queryByText(/discussion turns/)).toBeNull();
  });

  it('has status role for a11y', () => {
    render(<PlanningSkeletonView planningState={basePlanningState} />);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
