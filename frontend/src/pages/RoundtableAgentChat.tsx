import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AgentConversationWSEvent, EndingRoomParticipant } from '../types';
import { buildSessionHeaders } from '../api/client';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import { parseSseFrame } from '../lib/parseSseFrame';

function participantInitial(name: string): string {
  return Array.from(name)[0]?.toUpperCase() ?? '?';
}

interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
}

interface ActiveStreamState {
  controller: AbortController;
  participantId: string;
  threadId: string | null;
}

function parseConversationSseFrame(frame: string): AgentConversationWSEvent | null {
  return parseSseFrame<AgentConversationWSEvent>(frame);
}

async function readConversationError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as {
      detail?: string | { code?: string; message?: string };
      message?: string;
    };
    if (typeof payload.detail === 'object' && payload.detail !== null) {
      return typeof payload.detail.message === 'string'
        ? payload.detail.message
        : (payload.detail.code ?? `HTTP ${response.status}`);
    }
    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      return payload.detail.trim();
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // Fall through to generic HTTP fallback.
  }
  return `HTTP ${response.status}`;
}

export interface RoundtableAgentChatProps {
  scenarioId: string;
  participants: EndingRoomParticipant[];
  isZh: boolean;
}

export default function RoundtableAgentChat({
  scenarioId,
  participants,
}: RoundtableAgentChatProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [threadIds, setThreadIds] = useState<Map<string, string>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const inputRef = useRef('');
  const activeStreamRef = useRef<ActiveStreamState | null>(null);
  const [, forceRender] = useState(0);

  const selectedParticipant = useMemo(
    () => participants.find((p) => p.id === selectedId) ?? null,
    [participants, selectedId],
  );

  const currentMessages = selectedId ? (messages.get(selectedId) ?? []) : [];

  const handleSelect = useCallback((id: string) => {
    if (streaming) return;
    setSelectedId(id);
  }, [streaming]);

  const appendAgentMessage = useCallback((pid: string, content: string) => {
    setMessages((prev) => {
      const next = new Map(prev);
      const list = [...(next.get(pid) ?? [])];
      list.push({ role: 'agent', content });
      next.set(pid, list);
      return next;
    });
  }, []);

  useEffect(() => () => {
    activeStreamRef.current?.controller.abort();
  }, []);

  const handleSend = useCallback(async () => {
    const question = inputRef.current.trim();
    if (!question || !selectedId || !selectedParticipant || streaming) return;
    const participantId = selectedId;
    const originExcerpt = selectedParticipant.persona_snapshot_json
      ? JSON.stringify(selectedParticipant.persona_snapshot_json).slice(0, 200)
      : '';
    const originBranchId = selectedParticipant.source_branch_id?.trim() || null;
    const policy = loadLlmProviderPolicy();
    const controller = new AbortController();
    let nextThreadId = threadIds.get(participantId) ?? null;
    activeStreamRef.current = { controller, participantId, threadId: nextThreadId };

    setMessages((prev) => {
      const next = new Map(prev);
      const list = [...(next.get(participantId) ?? [])];
      list.push({ role: 'user', content: question });
      next.set(participantId, list);
      return next;
    });
    setStreaming(true);
    setStreamingText('');
    inputRef.current = '';
    forceRender((n) => n + 1);

    try {
      if (!nextThreadId) {
        const startResponse = await fetch('/api/conversation/start', {
          method: 'POST',
          headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            scenario_id: scenarioId,
            agent_identity_id: null,
            origin_branch_id: originBranchId,
            origin_node_id: participantId,
            origin_node_type: 'roundtable_participant',
            ...(originExcerpt ? { origin_excerpt: originExcerpt } : {}),
            first_user_content: question,
            ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
            ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
            ...(policy.model ? { llm_model: policy.model } : {}),
            ...(policy.disableUserQuota ? { disable_user_quota: true } : {}),
          }),
          signal: controller.signal,
        });
        if (!startResponse.ok) {
          appendAgentMessage(
            participantId,
            t('roundtable.chat_error_generic', {
              detail: await readConversationError(startResponse),
            }),
          );
          return;
        }
        const startPayload = await startResponse.json() as { thread_id?: string | null };
        nextThreadId = typeof startPayload.thread_id === 'string' && startPayload.thread_id.trim()
          ? startPayload.thread_id
          : null;
        if (!nextThreadId) {
          appendAgentMessage(participantId, t('roundtable.chat_error_no_body'));
          return;
        }
        setThreadIds((prev) => {
          const next = new Map(prev);
          next.set(participantId, nextThreadId as string);
          return next;
        });
        if (activeStreamRef.current?.controller === controller) {
          activeStreamRef.current = { controller, participantId, threadId: nextThreadId };
        }
      }

      const response = await fetch(`/api/conversation/${encodeURIComponent(nextThreadId)}/turn`, {
        method: 'POST',
        headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          user_content: question,
          ...(originExcerpt ? { origin_excerpt: originExcerpt } : {}),
          ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
          ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
          ...(policy.model ? { llm_model: policy.model } : {}),
          ...(policy.disableUserQuota ? { disable_user_quota: true } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        appendAgentMessage(
          participantId,
          t('roundtable.chat_error_generic', {
            detail: await readConversationError(response),
          }),
        );
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        appendAgentMessage(participantId, t('roundtable.chat_error_no_body'));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let streamError: string | null = null;
      const applyStreamFrame = (frame: string) => {
        const event = parseConversationSseFrame(frame);
        if (!event) return;
        if (event.type === 'turn_token_delta') {
          fullText += event.delta;
          setStreamingText(fullText);
          return;
        }
        if (event.type === 'turn_error') {
          streamError = event.message ?? event.code;
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          applyStreamFrame(frame);
        }
      }
      const trailingFrame = (buffer + decoder.decode()).trim();
      if (trailingFrame) applyStreamFrame(trailingFrame);

      appendAgentMessage(
        participantId,
        streamError
          ? t('roundtable.chat_error_generic', { detail: streamError })
          : (fullText || t('roundtable.chat_no_response')),
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        appendAgentMessage(
          participantId,
          t('roundtable.chat_error_generic', { detail: (err as Error).message }),
        );
      }
    } finally {
      setStreaming(false);
      setStreamingText('');
      if (activeStreamRef.current?.controller === controller) {
        activeStreamRef.current = null;
      }
    }
  }, [appendAgentMessage, scenarioId, selectedId, selectedParticipant, streaming, t, threadIds]);

  const handleAbort = useCallback(() => {
    const active = activeStreamRef.current;
    active?.controller.abort();
    if (active?.threadId) {
      void fetch(`/api/conversation/${encodeURIComponent(active.threadId)}/active`, {
        method: 'DELETE',
        headers: buildSessionHeaders(),
      }).catch(() => {
        // Best-effort network cleanup.
      });
    }
  }, []);

  return (
    <div data-testid="roundtable-agent-chat" className="roundtable-agent-chat">
      <div
        className="roundtable-agent-chat__picker"
        role="listbox"
        aria-label={t('roundtable.chat_select_agent')}
      >
        {participants.map((p) => (
          <button
            key={p.id}
            type="button"
            role="option"
            aria-selected={selectedId === p.id}
            className={`roundtable-agent-chat__avatar${selectedId === p.id ? ' is-selected' : ''}${streaming ? ' is-locked' : ''}`}
            disabled={streaming}
            onClick={() => handleSelect(p.id)}
          >
            <span className="roundtable-agent-chat__initial" aria-hidden="true">
              {participantInitial(p.display_name)}
            </span>
            <span className="roundtable-agent-chat__avatar-name">
              {p.display_name}
            </span>
          </button>
        ))}
      </div>

      {selectedParticipant ? (
        <>
          <div className="roundtable-agent-chat__target">
            <strong>{t('roundtable.chat_speaking_with')} {selectedParticipant.display_name}</strong>
            <span>{t('roundtable.chat_role_label')}: {selectedParticipant.role_slot}</span>
          </div>

          {(currentMessages.length > 0 || streaming) && (
            <div
              className="roundtable-agent-chat__messages"
              role="log"
              aria-live="polite"
            >
              {currentMessages.map((msg, i) => (
                <div key={i} className={`roundtable-agent-chat__msg roundtable-agent-chat__msg--${msg.role}`}>
                  {msg.role === 'agent' && (
                    <span className="roundtable-agent-chat__msg-name">{selectedParticipant.display_name}</span>
                  )}
                  <p>{msg.content}</p>
                </div>
              ))}
              {streaming && streamingText && (
                <div className="roundtable-agent-chat__msg roundtable-agent-chat__msg--agent">
                  <span className="roundtable-agent-chat__msg-name">{selectedParticipant.display_name}</span>
                  <p>{streamingText}<span className="editorial-streaming-cursor" /></p>
                </div>
              )}
              {streaming && !streamingText && (
                <div className="roundtable-agent-chat__msg roundtable-agent-chat__msg--agent">
                  <span className="editorial-streaming-cursor">{t('roundtable.stream_loading')}</span>
                </div>
              )}
            </div>
          )}

          <div className="roundtable-agent-chat__input">
            <textarea
              className="roundtable-agent-chat__textarea"
              placeholder={t('roundtable.chat_input_placeholder')}
              onChange={(e) => { inputRef.current = e.target.value; forceRender((n) => n + 1); }}
              disabled={streaming}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button
              type="button"
              className="roundtable-agent-chat__send btn btn--sm"
              onClick={streaming ? handleAbort : () => void handleSend()}
              disabled={!streaming && !inputRef.current.trim()}
            >
              {streaming ? t('roundtable.chat_stop') : t('roundtable.chat_send')}
            </button>
          </div>
        </>
      ) : (
        <p className="roundtable-agent-chat__hint">
          {t('roundtable.chat_select_agent')}
        </p>
      )}
    </div>
  );
}
