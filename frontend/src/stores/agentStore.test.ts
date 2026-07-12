import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from './agentStore';
import type { AgentIdentityInfo } from '../types';

const apiMock = vi.hoisted(() => ({
  getSessionBoundUserId: vi.fn((fallback?: string | null) => fallback?.trim() || 'test_user'),
  listAgentIdentities: vi.fn(),
}));

vi.mock('../api/client', () => ({
  getSessionBoundUserId: apiMock.getSessionBoundUserId,
  listAgentIdentities: apiMock.listAgentIdentities,
}));

function makeAgent(id: string): AgentIdentityInfo {
  return {
    id,
    user_id: 'test_user',
    kind: 'custom',
    display_name: id,
    role: 'Analyst',
    persona: null,
    decision_bias: null,
    decision_bias_json: null,
    preferred_tier: null,
    continuity_key: id,
    created_at: '2026-07-12T00:00:00Z',
    updated_at: '2026-07-12T00:00:00Z',
  };
}

describe('agentStore', () => {
  beforeEach(() => {
    apiMock.getSessionBoundUserId.mockClear();
    apiMock.listAgentIdentities.mockReset();
    useAgentStore.setState({
      selectedIds: new Set(),
      identities: [],
      loading: false,
      error: null,
      loadedUserId: null,
      loadingUserId: null,
      requestSeq: 0,
    });
  });

  describe('authoritative identity replacement', () => {
    it('keeps a post-import replacement when an older fetch resolves later', async () => {
      let resolveOldFetch!: (value: AgentIdentityInfo[]) => void;
      apiMock.listAgentIdentities.mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldFetch = resolve;
      }));

      const oldFetch = useAgentStore.getState().fetchIdentities('test_user');
      expect(useAgentStore.getState().loading).toBe(true);
      expect(useAgentStore.getState().requestSeq).toBe(1);

      useAgentStore.getState().setIdentities([makeAgent('fresh-import')]);
      resolveOldFetch([makeAgent('stale-before-import')]);
      await oldFetch;

      const state = useAgentStore.getState();
      expect(state.identities.map((identity) => identity.id)).toEqual(['fresh-import']);
      expect(state.requestSeq).toBe(2);
      expect(state.loading).toBe(false);
      expect(state.loadingUserId).toBeNull();
      expect(state.loadedUserId).toBe('test_user');
      expect(state.error).toBeNull();
    });

    it('ignores an older fetch error after a post-import replacement', async () => {
      let rejectOldFetch!: (reason: Error) => void;
      apiMock.listAgentIdentities.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectOldFetch = reject;
      }));

      const oldFetch = useAgentStore.getState().fetchIdentities('test_user');
      useAgentStore.getState().setIdentities([makeAgent('fresh-import')]);
      rejectOldFetch(new Error('stale fetch failed'));
      await oldFetch;

      const state = useAgentStore.getState();
      expect(state.identities.map((identity) => identity.id)).toEqual(['fresh-import']);
      expect(state.error).toBeNull();
      expect(state.loading).toBe(false);
    });
  });

  describe('toggleSelection', () => {
    it('adds id when under default limit (no maxSelected provided)', () => {
      useAgentStore.getState().toggleSelection('a');
      useAgentStore.getState().toggleSelection('b');
      useAgentStore.getState().toggleSelection('c');
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b', 'c']);
    });

    it('respects custom maxSelected=3', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 3);
      toggleSelection('b', 3);
      toggleSelection('c', 3);
      toggleSelection('d', 3);
      const ids = Array.from(useAgentStore.getState().selectedIds);
      expect(ids.length).toBe(3);
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('removes id when already selected regardless of max', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 5);
      toggleSelection('b', 5);
      expect(useAgentStore.getState().selectedIds.has('a')).toBe(true);
      toggleSelection('a', 0);
      expect(useAgentStore.getState().selectedIds.has('a')).toBe(false);
      expect(useAgentStore.getState().selectedIds.has('b')).toBe(true);
    });

    it('does not add when at maxSelected cap', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 2);
      toggleSelection('b', 2);
      toggleSelection('c', 2);
      expect(useAgentStore.getState().selectedIds.size).toBe(2);
      expect(useAgentStore.getState().selectedIds.has('c')).toBe(false);
    });

    it('handles uncapped (no maxSelected) up to many items', () => {
      const { toggleSelection } = useAgentStore.getState();
      for (let i = 0; i < 12; i++) toggleSelection(`agent-${i}`);
      expect(useAgentStore.getState().selectedIds.size).toBe(12);
    });

    it('treats maxSelected=0 as a hard cap (no additions)', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 0);
      expect(useAgentStore.getState().selectedIds.size).toBe(0);
    });
  });

  describe('pruneSelectionToSize', () => {
    it('no-ops when size <= maxSize', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b']) });
      useAgentStore.getState().pruneSelectionToSize(5);
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b']);
    });

    it('truncates to maxSize keeping insertion order', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b', 'c', 'd', 'e']) });
      useAgentStore.getState().pruneSelectionToSize(3);
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b', 'c']);
    });

    it('clears all when maxSize is 0', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b', 'c']) });
      useAgentStore.getState().pruneSelectionToSize(0);
      expect(useAgentStore.getState().selectedIds.size).toBe(0);
    });

    it('coerces negative maxSize to 0', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b']) });
      useAgentStore.getState().pruneSelectionToSize(-3);
      expect(useAgentStore.getState().selectedIds.size).toBe(0);
    });

    it('truncates fractional maxSize via Math.trunc', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b', 'c', 'd']) });
      useAgentStore.getState().pruneSelectionToSize(2.9);
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b']);
    });
  });
});
