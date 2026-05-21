import { beforeEach, describe, expect, it } from 'vitest';

import { useAgentStore } from './agentStore';

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.setState({
      selectedIds: new Set(),
      identities: [],
      loading: false,
      error: null,
      loadedUserId: null,
      requestSeq: 0,
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
