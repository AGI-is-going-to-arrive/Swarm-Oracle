import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import RoundtableAgentChat from './RoundtableAgentChat';
import type { EndingRoomParticipant } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: Record<string, string | number | undefined>,
    ) => {
      const translations: Record<string, string> = {
        'roundtable.agent_chat_origin_role': 'Role',
        'roundtable.agent_chat_origin_worldline': 'Worldline',
        'roundtable.agent_chat_origin_stance': 'Stance',
        'roundtable.agent_chat_origin_quote': 'Recent quote',
        'roundtable.agent_chat_origin_bio': 'Persona',
      };
      return (translations[key] ?? key).replace(
        /\{\{(\w+)\}\}/g,
        (_match: string, token: string) => String(options?.[token] ?? ''),
      );
    },
  }),
}));

const participants: EndingRoomParticipant[] = [
  {
    id: 'rep-a',
    room_id: 'room-1',
    role_slot: 'representative',
    display_name: 'Representative A',
    source_branch_id: 'branch-a',
    source_agent_id: 'agent-a',
    persona_snapshot_json: {
      agent_role: 'Marshal',
      bio_short: 'Holds the hinge with discipline.',
      branch_title: 'Northern Supply Line',
      agent_stance: 'The line only holds if Han River supply stays intact.',
      latest_quote: 'No northern push survives a broken granary road.',
    },
  },
  {
    id: 'rep-b',
    room_id: 'room-1',
    role_slot: 'representative',
    display_name: 'Representative B',
    source_branch_id: 'branch-b',
    source_agent_id: 'agent-b',
    persona_snapshot_json: {
      agent_role: 'Auditor',
      bio_short: 'Wants evidence before commitment.',
      branch_title: 'Treasury Line',
    },
  },
];

function makeSseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(frame));
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        }),
      }),
    },
  } as unknown as Response;
}

function renderChat() {
  return render(
    <RoundtableAgentChat
      scenarioId="scenario-1"
      participants={participants}
    />,
  );
}

async function sendQuestion(text: string) {
  const textarea = screen.getByPlaceholderText('roundtable.chat_input_placeholder');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'roundtable.chat_send' }));
}

describe('RoundtableAgentChat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it('uses conversation start + participant-scoped turn threads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ thread_id: 'thread-a' }),
      })
      .mockResolvedValueOnce(
        makeSseResponse([
          'event: turn_started\ndata: {"thread_id":"thread-a","turn_id":"turn-a1","sequence":2}\n\n',
          'event: turn_token_delta\ndata: {"turn_id":"turn-a1","delta":"Answer A1"}\n\n',
          'event: turn_completed\ndata: {"thread_id":"thread-a","turn_id":"turn-a1","sequence":2,"status":"committed"}\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          'event: turn_started\ndata: {"thread_id":"thread-a","turn_id":"turn-a2","sequence":4}\n\n',
          'event: turn_token_delta\ndata: {"turn_id":"turn-a2","delta":"Answer A2"}\n\n',
          'event: turn_completed\ndata: {"thread_id":"thread-a","turn_id":"turn-a2","sequence":4,"status":"committed"}\n\n',
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ thread_id: 'thread-b' }),
      })
      .mockResolvedValueOnce(
        makeSseResponse([
          'event: turn_started\ndata: {"thread_id":"thread-b","turn_id":"turn-b1","sequence":2}\n\n',
          'event: turn_token_delta\ndata: {"turn_id":"turn-b1","delta":"Answer B1"}\n\n',
          'event: turn_completed\ndata: {"thread_id":"thread-b","turn_id":"turn-b1","sequence":2,"status":"committed"}\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderChat();

    fireEvent.click(screen.getByRole('option', { name: /Representative A/i }));
    await sendQuestion('First question');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/start',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-a/turn',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByText('Answer A1')).toBeInTheDocument();
    });

    await sendQuestion('Second question');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-a/turn',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByText('Answer A2')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('option', { name: /Representative B/i }));
    await sendQuestion('Question for B');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-b/turn',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByText('Answer B1')).toBeInTheDocument();
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/conversation/start',
      '/api/conversation/thread-a/turn',
      '/api/conversation/thread-a/turn',
      '/api/conversation/start',
      '/api/conversation/thread-b/turn',
    ]);

    const [firstStartUrl, firstStartOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstStartUrl).toBe('/api/conversation/start');
    const firstStartBody = JSON.parse(String(firstStartOptions.body));
    expect(firstStartBody).toMatchObject({
      scenario_id: 'scenario-1',
      agent_identity_id: null,
      origin_branch_id: 'branch-a',
      origin_node_id: 'rep-a',
      origin_node_type: 'roundtable_participant',
      first_user_content: 'First question',
    });
    expect(firstStartBody.origin_excerpt).toContain('Role: Marshal');
    expect(firstStartBody.origin_excerpt).toContain('Worldline: Northern Supply Line');

    const [, firstTurnOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(firstTurnOptions.body))).toMatchObject({
      user_content: 'First question',
    });

    const [secondStartUrl, secondStartOptions] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(secondStartUrl).toBe('/api/conversation/start');
    expect(JSON.parse(String(secondStartOptions.body))).toMatchObject({
      scenario_id: 'scenario-1',
      agent_identity_id: null,
      origin_branch_id: 'branch-b',
      origin_node_id: 'rep-b',
      origin_node_type: 'roundtable_participant',
      first_user_content: 'Question for B',
    });
  });

  it('shows participant context before starting the interview', () => {
    renderChat();

    fireEvent.click(screen.getByRole('option', { name: /Representative A/i }));

    expect(screen.getByText(/Marshal/)).toBeInTheDocument();
    expect(screen.getByText(/Northern Supply Line/)).toBeInTheDocument();
    expect(screen.getByText(/Han River supply stays intact/)).toBeInTheDocument();
    expect(screen.getByText(/broken granary road/)).toBeInTheDocument();
  });

  it('does not render network failures as participant speech', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({ detail: { message: 'provider unavailable' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderChat();

    fireEvent.click(screen.getByRole('option', { name: /Representative A/i }));
    await sendQuestion('Can you answer this?');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('roundtable.chat_error_generic');
    });
    const agentMessages = Array.from(container.querySelectorAll('.roundtable-agent-chat__msg--agent'));
    expect(agentMessages.some((node) => node.textContent?.includes('roundtable.chat_error_generic'))).toBe(false);
  });

  it('locks participant switching while a turn is streaming', async () => {
    let turnSignal: RequestInit['signal'];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/conversation/start') {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({ thread_id: 'thread-a' }),
        } as unknown as Response;
      }
      if (url === '/api/conversation/thread-a/turn') {
        turnSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      if (url === '/api/conversation/thread-a/active') {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({}),
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderChat();

    fireEvent.click(screen.getByRole('option', { name: /Representative A/i }));
    await sendQuestion('Hold this open');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-a/turn',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByRole('button', { name: 'roundtable.chat_stop' })).toBeInTheDocument();
    });

    const otherParticipant = screen.getByRole('option', { name: /Representative B/i });
    expect(otherParticipant).toBeDisabled();
    expect(turnSignal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'roundtable.chat_stop' }));

    await waitFor(() => {
      expect(turnSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/thread-a/active',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(screen.getByRole('option', { name: /Representative B/i })).not.toBeDisabled();
    });
  });
});
