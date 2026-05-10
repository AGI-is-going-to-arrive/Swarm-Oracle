import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConversationDetail,
  ConversationListItem,
  ConversationListResponse,
} from '../api/client';
import { ConversationHistoryPicker } from './ConversationHistoryPicker';

const apiMocks = vi.hoisted(() => ({
  getConversation: vi.fn(),
  getScenarioConversations: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: Record<string, string | number | undefined>,
    ) => key.replace(/\{\{(\w+)\}\}/g, (_match: string, token: string) => String(options?.[token] ?? '')),
  }),
}));

vi.mock('../api/client', () => ({
  getConversation: apiMocks.getConversation,
  getScenarioConversations: apiMocks.getScenarioConversations,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeItem(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    thread_id: overrides.thread_id ?? 'thread-1',
    scenario_id: overrides.scenario_id ?? 'scenario-1',
    agent_identity_id: null,
    owner_user_id: 'user-1',
    origin_branch_id: null,
    origin_round_number: null,
    origin_node_id: overrides.origin_node_id ?? 'node-1',
    origin_node_type: overrides.origin_node_type ?? 'event',
    last_turn_sequence: overrides.last_turn_sequence ?? 2,
    latest_status: 'committed',
    active_turn_id: null,
    created_at: '2026-05-10T00:00:00Z',
    updated_at: '2026-05-10T00:00:00Z',
    ...overrides,
  };
}

function makeDetail(item: ConversationListItem): ConversationDetail {
  return {
    ...item,
    user_turn_id: 'turn-user',
    assistant_turn_id: 'turn-assistant',
    sequence_range: [1, 2],
    turns: [
      {
        id: 'turn-user',
        thread_id: item.thread_id,
        role: 'user',
        sequence: 1,
        status: 'committed',
        content: 'Question',
        created_at: item.created_at,
        updated_at: item.updated_at,
      },
      {
        id: 'turn-assistant',
        thread_id: item.thread_id,
        role: 'assistant',
        sequence: 2,
        status: 'committed',
        content: 'Answer',
        created_at: item.created_at,
        updated_at: item.updated_at,
      },
    ],
  };
}

describe('ConversationHistoryPicker', () => {
  beforeEach(() => {
    apiMocks.getConversation.mockReset();
    apiMocks.getScenarioConversations.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows Load More when the filtered current page is empty but more pages exist', async () => {
    apiMocks.getScenarioConversations
      .mockResolvedValueOnce({
        items: [makeItem({ thread_id: 'event-thread', origin_node_type: 'event' })],
        cursor: 20,
        has_more: true,
      } satisfies ConversationListResponse)
      .mockResolvedValueOnce({
        items: [
          makeItem({
            thread_id: 'participant-thread',
            origin_node_id: 'rep-a',
            origin_node_type: 'roundtable_participant',
          }),
        ],
        cursor: 40,
        has_more: false,
      } satisfies ConversationListResponse);

    render(
      <ConversationHistoryPicker
        alwaysOpen
        scenarioId="scenario-1"
        filterNodeTypes={['roundtable_participant']}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('conversation.history.no_history')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.load_more' }));

    await waitFor(() => {
      expect(apiMocks.getScenarioConversations).toHaveBeenCalledWith('scenario-1', 20, 20);
    });
    expect(await screen.findByText('roundtable_participant · rep-a')).toBeInTheDocument();
  });

  it('ignores a stale list response after the scenario changes', async () => {
    const stalePage = deferred<ConversationListResponse>();
    const freshPage = deferred<ConversationListResponse>();
    apiMocks.getScenarioConversations
      .mockReturnValueOnce(stalePage.promise)
      .mockReturnValueOnce(freshPage.promise);

    const { rerender } = render(
      <ConversationHistoryPicker
        alwaysOpen
        scenarioId="scenario-old"
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(apiMocks.getScenarioConversations).toHaveBeenCalledWith('scenario-old', 0, 20);
    });

    rerender(
      <ConversationHistoryPicker
        alwaysOpen
        scenarioId="scenario-new"
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(apiMocks.getScenarioConversations).toHaveBeenCalledWith('scenario-new', 0, 20);
    });

    await act(async () => {
      freshPage.resolve({
        items: [makeItem({ thread_id: 'fresh-thread', origin_node_id: 'fresh-node' })],
        cursor: 0,
        has_more: false,
      });
      await freshPage.promise;
    });
    expect(await screen.findByText('event · fresh-node')).toBeInTheDocument();

    await act(async () => {
      stalePage.resolve({
        items: [makeItem({ thread_id: 'stale-thread', origin_node_id: 'stale-node' })],
        cursor: 0,
        has_more: false,
      });
      await stalePage.promise;
    });

    await waitFor(() => {
      expect(screen.queryByText('event · stale-node')).not.toBeInTheDocument();
    });
    expect(screen.getByText('event · fresh-node')).toBeInTheDocument();
  });

  it('ignores a stale detail response after the filter changes', async () => {
    const item = makeItem({
      thread_id: 'event-thread',
      origin_node_id: 'event-node',
      origin_node_type: 'event',
    });
    const staleDetail = deferred<ConversationDetail>();
    const onSelect = vi.fn();
    apiMocks.getScenarioConversations
      .mockResolvedValueOnce({
        items: [item],
        cursor: 0,
        has_more: false,
      } satisfies ConversationListResponse)
      .mockResolvedValueOnce({
        items: [item],
        cursor: 0,
        has_more: false,
      } satisfies ConversationListResponse);
    apiMocks.getConversation.mockReturnValueOnce(staleDetail.promise);

    const { rerender } = render(
      <ConversationHistoryPicker
        alwaysOpen
        scenarioId="scenario-1"
        filterNodeTypes={['event']}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(await screen.findByTestId('conversation-history-picker-row-event-thread'));

    rerender(
      <ConversationHistoryPicker
        alwaysOpen
        scenarioId="scenario-1"
        filterNodeTypes={['roundtable_participant']}
        onSelect={onSelect}
      />,
    );

    await act(async () => {
      staleDetail.resolve(makeDetail(item));
      await staleDetail.promise;
    });

    await waitFor(() => {
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
