/**
 * P1-2 — MemoryTimeline tests
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

import type { AgentGrowthEvent, AgentMemoryEntry } from '../types';
import { MemoryTimeline } from './MemoryTimeline';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('MemoryTimeline', () => {
  it('renders empty state when no events and no memories', () => {
    render(<MemoryTimeline events={[]} memories={[]} />);
    expect(screen.getByText('No history yet.')).toBeInTheDocument();
  });

  it('renders growth events with correct icons and labels', () => {
    const events: AgentGrowthEvent[] = [
      {
        id: 'ev1',
        scenario_id: 'sc1',
        branch_id: 'b1',
        round_number: 2,
        event_type: 'stance_shift',
        summary: 'Agent shifted from hawk to dove',
        metrics_json: null,
        created_at: '2026-04-01T10:00:00Z',
      },
      {
        id: 'ev2',
        scenario_id: 'sc1',
        branch_id: 'b1',
        round_number: 3,
        event_type: 'betrayal',
        summary: 'Agent betrayed the alliance',
        metrics_json: null,
        created_at: '2026-04-01T11:00:00Z',
      },
    ];
    render(<MemoryTimeline events={events} memories={[]} />);

    // Check labels
    expect(screen.getByText('Stance Shift')).toBeInTheDocument();
    expect(screen.getByText('Betrayal')).toBeInTheDocument();

    // Check summaries
    expect(screen.getByText('Agent shifted from hawk to dove')).toBeInTheDocument();
    expect(screen.getByText('Agent betrayed the alliance')).toBeInTheDocument();

    // Check round numbers
    expect(screen.getByText('R2')).toBeInTheDocument();
    expect(screen.getByText('R3')).toBeInTheDocument();

    // Check list structure
    const list = screen.getByRole('list', { name: 'Agent growth timeline' });
    expect(list).toBeInTheDocument();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
  });

  it('renders memory entries', () => {
    const memories: AgentMemoryEntry[] = [
      {
        summary: 'Recalled the great debate outcome',
        scenario_id: 'sc2',
        created_at: '2026-04-02T08:00:00Z',
      },
    ];
    render(<MemoryTimeline events={[]} memories={memories} />);

    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('Recalled the great debate outcome')).toBeInTheDocument();
  });

  it('groups entries by scenario', () => {
    const events: AgentGrowthEvent[] = [
      {
        id: 'ev1', scenario_id: 'sc-aaa', branch_id: 'b1',
        round_number: 1, event_type: 'alliance_formed',
        summary: 'Formed alliance in first scenario',
        metrics_json: null, created_at: '2026-04-01T10:00:00Z',
      },
      {
        id: 'ev2', scenario_id: 'sc-bbb', branch_id: 'b2',
        round_number: 1, event_type: 'alliance_broken',
        summary: 'Alliance broken in second scenario',
        metrics_json: null, created_at: '2026-04-02T10:00:00Z',
      },
    ];
    render(<MemoryTimeline events={events} memories={[]} />);

    // Scenario headers show truncated IDs (first 8 chars)
    expect(screen.getByText(/sc-aaa/)).toBeInTheDocument();
    expect(screen.getByText(/sc-bbb/)).toBeInTheDocument();

    // Both event labels rendered
    expect(screen.getByText('Alliance Formed')).toBeInTheDocument();
    expect(screen.getByText('Alliance Broken')).toBeInTheDocument();
  });

  it('sorts entries by timestamp ascending', () => {
    const events: AgentGrowthEvent[] = [
      {
        id: 'ev-late', scenario_id: 'sc1', branch_id: 'b1',
        round_number: 5, event_type: 'betrayal',
        summary: 'Later event',
        metrics_json: null, created_at: '2026-04-02T10:00:00Z',
      },
    ];
    const memories: AgentMemoryEntry[] = [
      {
        summary: 'Earlier memory',
        scenario_id: 'sc1',
        created_at: '2026-04-01T10:00:00Z',
      },
    ];
    render(<MemoryTimeline events={events} memories={memories} />);

    const items = screen.getAllByRole('listitem');
    // Earlier memory first, later event second
    expect(items[0].textContent).toContain('Earlier memory');
    expect(items[1].textContent).toContain('Later event');
  });

  it('handles null scenario_id as "unknown" group', () => {
    const events: AgentGrowthEvent[] = [
      {
        id: 'ev1', scenario_id: null, branch_id: null,
        round_number: null, event_type: 'stance_shift',
        summary: 'Unknown origin event',
        metrics_json: null, created_at: null,
      },
    ];
    render(<MemoryTimeline events={events} memories={[]} />);
    // Unknown scenario shows dash
    expect(screen.getByText(/—/)).toBeInTheDocument();
    expect(screen.getByText('Unknown origin event')).toBeInTheDocument();
  });

  it('renders alliance event types with correct labels', () => {
    const events: AgentGrowthEvent[] = [
      {
        id: 'ev1', scenario_id: 'sc1', branch_id: 'b1',
        round_number: 1, event_type: 'alliance',
        summary: 'General alliance',
        metrics_json: null, created_at: '2026-04-01T10:00:00Z',
      },
    ];
    render(<MemoryTimeline events={events} memories={[]} />);
    expect(screen.getByText('Alliance')).toBeInTheDocument();
  });
});
