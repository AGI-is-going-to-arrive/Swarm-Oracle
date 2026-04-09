/**
 * P1-8 — useFactionOverlay hook tests
 */
import { cleanup } from '@testing-library/react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EndingRoomParticipant } from '../types';
import { useFactionOverlay } from './useFactionOverlay';

vi.mock('../api/client', () => ({
  getFactionTimeline: vi.fn(),
}));

import { getFactionTimeline } from '../api/client';
const mockGetFactionTimeline = vi.mocked(getFactionTimeline);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function makeParticipant(
  id: string,
  sourceAgentId: string | undefined,
  sourceBranchId?: string,
): EndingRoomParticipant {
  return {
    id,
    room_id: 'room-1',
    source_branch_id: sourceBranchId ?? 'b1',
    source_agent_id: sourceAgentId,
    role_slot: 'panelist',
    display_name: `Agent ${id}`,
    persona_snapshot: 'test persona',
    worldline_echo_key: null,
  } as EndingRoomParticipant;
}

describe('useFactionOverlay', () => {
  it('returns empty map when no scenarioId', () => {
    const participants = new Map<string, EndingRoomParticipant>();
    const { result } = renderHook(() =>
      useFactionOverlay(undefined, 'b1', participants),
    );
    expect(result.current.size).toBe(0);
    expect(mockGetFactionTimeline).not.toHaveBeenCalled();
  });

  it('single-branch: fetches and maps participants correctly', async () => {
    const timelineData = [
      {
        round: 2,
        factions: [
          { key: 'hawks', label: 'War Hawks', members: ['agent-1', 'agent-2'] },
        ],
        events: [],
      },
    ];

    mockGetFactionTimeline.mockResolvedValueOnce(timelineData);

    const participants = new Map<string, EndingRoomParticipant>([
      ['p1', makeParticipant('p1', 'agent-1', 'b1')],
      ['p2', makeParticipant('p2', 'agent-2', 'b1')],
    ]);

    const { result } = renderHook(() =>
      useFactionOverlay('sc1', 'b1', participants),
    );

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    expect(result.current.get('p1')!.factionKey).toBe('hawks');
    expect(result.current.get('p1')!.color).toBe('#4a90d9');
    expect(mockGetFactionTimeline).toHaveBeenCalledWith('sc1', 'b1');
  });

  it('multi-branch: discovers branches from participants and maps each correctly', async () => {
    // Branch A: agent-1 is in faction "hawks"
    mockGetFactionTimeline.mockImplementation(async (_sid, bid) => {
      if (bid === 'branch-a') {
        return [{ round: 1, factions: [{ key: 'hawks', label: 'Hawks', members: ['agent-1'] }], events: [] }];
      }
      if (bid === 'branch-b') {
        return [{ round: 1, factions: [{ key: 'doves', label: 'Doves', members: ['agent-2'] }], events: [] }];
      }
      return [];
    });

    const participants = new Map<string, EndingRoomParticipant>([
      ['p1', makeParticipant('p1', 'agent-1', 'branch-a')],
      ['p2', makeParticipant('p2', 'agent-2', 'branch-b')],
    ]);

    // No branchId — hook discovers from participants
    const { result } = renderHook(() =>
      useFactionOverlay('sc1', undefined, participants),
    );

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    expect(result.current.get('p1')!.factionKey).toBe('hawks');
    expect(result.current.get('p2')!.factionKey).toBe('doves');
    // Each participant got their own branch's faction
    expect(result.current.get('p1')!.factionLabel).toBe('Hawks');
    expect(result.current.get('p2')!.factionLabel).toBe('Doves');
    expect(mockGetFactionTimeline).toHaveBeenCalledTimes(2);
  });

  it('returns empty map when fetch fails', async () => {
    mockGetFactionTimeline.mockRejectedValueOnce(new Error('Network error'));

    const participants = new Map<string, EndingRoomParticipant>([
      ['p1', makeParticipant('p1', 'agent-1')],
    ]);

    const { result } = renderHook(() =>
      useFactionOverlay('sc1', 'b1', participants),
    );

    await waitFor(() => {
      expect(mockGetFactionTimeline).toHaveBeenCalled();
    });
    expect(result.current.size).toBe(0);
  });

  it('returns empty map when timeline is empty', async () => {
    mockGetFactionTimeline.mockResolvedValueOnce([]);

    const participants = new Map<string, EndingRoomParticipant>([
      ['p1', makeParticipant('p1', 'agent-1')],
    ]);

    const { result } = renderHook(() =>
      useFactionOverlay('sc1', 'b1', participants),
    );

    await waitFor(() => {
      expect(mockGetFactionTimeline).toHaveBeenCalled();
    });
    expect(result.current.size).toBe(0);
  });

  it('skips participants without source_agent_id', async () => {
    mockGetFactionTimeline.mockResolvedValueOnce([
      { round: 1, factions: [{ key: 'f1', label: 'F1', members: ['agent-1'] }], events: [] },
    ]);

    const participants = new Map<string, EndingRoomParticipant>([
      ['p1', makeParticipant('p1', 'agent-1')],
      ['p2', makeParticipant('p2', undefined)],
    ]);

    const { result } = renderHook(() =>
      useFactionOverlay('sc1', 'b1', participants),
    );

    await waitFor(() => {
      expect(result.current.size).toBe(1);
    });
    expect(result.current.has('p1')).toBe(true);
    expect(result.current.has('p2')).toBe(false);
  });
});
