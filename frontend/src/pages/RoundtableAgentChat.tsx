import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EndingRoomParticipant } from '../types';
import { buildSessionHeaders } from '../api/client';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';

function participantInitial(name: string): string {
  return Array.from(name)[0]?.toUpperCase() ?? '?';
}

interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
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
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const inputRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const [, forceRender] = useState(0);

  const selectedParticipant = useMemo(
    () => participants.find((p) => p.id === selectedId) ?? null,
    [participants, selectedId],
  );

  const currentMessages = selectedId ? (messages.get(selectedId) ?? []) : [];

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const appendAgentMessage = useCallback((pid: string, content: string) => {
    setMessages((prev) => {
      const next = new Map(prev);
      const list = [...(next.get(pid) ?? [])];
      list.push({ role: 'agent', content });
      next.set(pid, list);
      return next;
    });
  }, []);

  const handleSend = useCallback(async () => {
    const question = inputRef.current.trim();
    if (!question || !selectedId || !selectedParticipant || streaming) return;

    setMessages((prev) => {
      const next = new Map(prev);
      const list = [...(next.get(selectedId) ?? [])];
      list.push({ role: 'user', content: question });
      next.set(selectedId, list);
      return next;
    });
    setStreaming(true);
    setStreamingText('');
    inputRef.current = '';
    forceRender((n) => n + 1);

    const controller = new AbortController();
    abortRef.current = controller;
    const policy = loadLlmProviderPolicy();
    const persona = selectedParticipant.persona_snapshot_json
      ? JSON.stringify(selectedParticipant.persona_snapshot_json).slice(0, 200)
      : '';

    try {
      const response = await fetch(`/api/scenario/${encodeURIComponent(scenarioId)}/conversation`, {
        method: 'POST',
        headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          question,
          origin_node_id: selectedId,
          origin_node_type: 'roundtable_participant',
          origin_excerpt: persona || undefined,
          ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
          ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
          ...(policy.model ? { llm_model: policy.model } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({})) as Record<string, unknown>;
        const detail = typeof err.detail === 'object' && err.detail !== null
          ? err.detail as Record<string, unknown>
          : null;
        const msg = detail?.message ?? err.message ?? `HTTP ${response.status}`;
        appendAgentMessage(selectedId, `Error: ${String(msg)}`);
        setStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        appendAgentMessage(selectedId, 'Error: No response body');
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(line.indexOf(':') + 1).trimStart();
            try {
              const data = JSON.parse(payload) as Record<string, unknown>;
              if (typeof data.delta === 'string') {
                fullText += data.delta;
                setStreamingText(fullText);
              } else if (typeof data.content === 'string' && data.content) {
                fullText += data.content;
                setStreamingText(fullText);
              }
            } catch { /* skip malformed SSE data */ }
          }
        }
      }
      appendAgentMessage(selectedId, fullText || t('roundtable.chat_no_response'));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        appendAgentMessage(selectedId, `Error: ${(err as Error).message}`);
      }
    } finally {
      setStreaming(false);
      setStreamingText('');
      abortRef.current = null;
    }
  }, [selectedId, selectedParticipant, scenarioId, streaming, appendAgentMessage, t]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
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
            className={`roundtable-agent-chat__avatar${selectedId === p.id ? ' is-selected' : ''}`}
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
            <div className="roundtable-agent-chat__messages">
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
