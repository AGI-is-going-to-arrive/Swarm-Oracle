import { useCallback, useEffect, useRef } from 'react';

import { buildSessionHeaders } from '../api/client';
import { loadLlmProviderPolicy, validateByok } from '../lib/llmProviderPolicy';
import type { AgentConversationWSEvent } from '../types';

interface UseNodeConversationTransportOptions {
  scenarioId: string;
  identityId?: string | null;
  originNodeId?: string | null;
  originNodeType?: string | null;
  setThreadId: (threadId: string | null) => void;
  onTransportError: (code: string, message?: string) => void;
  onWsEvent: (event: AgentConversationWSEvent) => void;
}

function parseConversationSseFrame(frame: string): AgentConversationWSEvent | null {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    let value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value.trim();
    if (field === 'data') dataLines.push(value);
  }
  const dataText = dataLines.join('\n');
  if (!eventName || !dataText) return null;
  try {
    return {
      type: eventName as AgentConversationWSEvent['type'],
      ...(JSON.parse(dataText) as Record<string, unknown>),
    } as AgentConversationWSEvent;
  } catch {
    return null;
  }
}

async function readConversationError(
  response: Response,
): Promise<{ code: string; message?: string }> {
  try {
    const payload = await response.json() as {
      detail?: string | { code?: string; message?: string };
    };
    if (typeof payload.detail === 'object' && payload.detail !== null) {
      return {
        code: typeof payload.detail.code === 'string' ? payload.detail.code : 'SERVER_ERROR',
        message: typeof payload.detail.message === 'string' ? payload.detail.message : undefined,
      };
    }
    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      return { code: 'SERVER_ERROR', message: payload.detail.trim() };
    }
  } catch {
    // Ignore and fall through to the generic fallback.
  }
  return { code: 'SERVER_ERROR', message: `HTTP ${response.status}` };
}

export function useNodeConversationTransport({
  scenarioId,
  identityId,
  originNodeId,
  originNodeType,
  setThreadId,
  onTransportError,
  onWsEvent,
}: UseNodeConversationTransportOptions) {
  const activeRequestControllerRef = useRef<AbortController | null>(null);
  const setThreadIdRef = useRef(setThreadId);
  const onTransportErrorRef = useRef(onTransportError);
  const onWsEventRef = useRef(onWsEvent);

  setThreadIdRef.current = setThreadId;
  onTransportErrorRef.current = onTransportError;
  onWsEventRef.current = onWsEvent;

  const abortActiveRequest = useCallback(() => {
    activeRequestControllerRef.current?.abort();
    activeRequestControllerRef.current = null;
  }, []);

  useEffect(() => () => {
    abortActiveRequest();
  }, [abortActiveRequest]);

  const streamTurn = useCallback(async (nextThreadId: string, text: string): Promise<boolean> => {
    abortActiveRequest();
    const controller = new AbortController();
    activeRequestControllerRef.current = controller;
    let accepted = false;
    try {
      const providerPolicy = loadLlmProviderPolicy();
      const validation = validateByok({
        apiKey: providerPolicy.apiKey,
        baseUrl: providerPolicy.baseUrl,
      });
      if (!validation.valid) {
        onTransportErrorRef.current(validation.errorCode);
        return false;
      }
      const response = await fetch(`/api/conversation/${encodeURIComponent(nextThreadId)}/turn`, {
        method: 'POST',
        headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          user_content: text,
          ...(providerPolicy.apiKey ? { llm_api_key: providerPolicy.apiKey } : {}),
          ...(providerPolicy.baseUrl ? { llm_base_url: providerPolicy.baseUrl } : {}),
          ...(providerPolicy.model ? { llm_model: providerPolicy.model } : {}),
          ...(providerPolicy.disableUserQuota ? { disable_user_quota: true } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await readConversationError(response);
        onTransportErrorRef.current(error.code, error.message);
        return false;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onTransportErrorRef.current('SERVER_ERROR', 'Missing stream body');
        return false;
      }
      accepted = true;

      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let frameBoundary = buffer.indexOf('\n\n');
        while (frameBoundary >= 0) {
          const frame = buffer.slice(0, frameBoundary);
          buffer = buffer.slice(frameBoundary + 2);
          const parsed = parseConversationSseFrame(frame);
          if (parsed) {
            onWsEventRef.current(parsed);
          }
          frameBoundary = buffer.indexOf('\n\n');
        }
      }
      const trailing = parseConversationSseFrame((buffer + decoder.decode()).trim());
      if (trailing) {
        onWsEventRef.current(trailing);
      }
    } catch (error) {
      if (controller.signal.aborted) return accepted;
      const message = error instanceof Error ? error.message : 'Stream failed';
      onTransportErrorRef.current('SERVER_ERROR', message);
      return accepted;
    } finally {
      if (activeRequestControllerRef.current === controller) {
        activeRequestControllerRef.current = null;
      }
    }
    return accepted;
  }, [abortActiveRequest, onTransportError, onWsEvent]);

  const startConversation = useCallback(async (text: string): Promise<boolean> => {
    try {
      const providerPolicy = loadLlmProviderPolicy();
      const validation = validateByok({
        apiKey: providerPolicy.apiKey,
        baseUrl: providerPolicy.baseUrl,
      });
      if (!validation.valid) {
        onTransportErrorRef.current(validation.errorCode);
        return false;
      }
      const response = await fetch('/api/conversation/start', {
        method: 'POST',
        headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          scenario_id: scenarioId,
          agent_identity_id: identityId ?? null,
          origin_node_id: originNodeId ?? null,
          origin_node_type: originNodeType ?? null,
          first_user_content: text,
          ...(providerPolicy.apiKey ? { llm_api_key: providerPolicy.apiKey } : {}),
          ...(providerPolicy.baseUrl ? { llm_base_url: providerPolicy.baseUrl } : {}),
          ...(providerPolicy.model ? { llm_model: providerPolicy.model } : {}),
          ...(providerPolicy.disableUserQuota ? { disable_user_quota: true } : {}),
        }),
      });
      if (!response.ok) {
        const error = await readConversationError(response);
        onTransportErrorRef.current(error.code, error.message);
        return false;
      }
      const payload = await response.json() as { thread_id?: string | null };
      const nextThreadId = typeof payload.thread_id === 'string' && payload.thread_id.trim()
        ? payload.thread_id
        : null;
      if (!nextThreadId) {
        onTransportErrorRef.current('SERVER_ERROR', 'Missing conversation thread id');
        return false;
      }
      setThreadIdRef.current(nextThreadId);
      return await streamTurn(nextThreadId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Start conversation failed';
      onTransportErrorRef.current('SERVER_ERROR', message);
      return false;
    }
  }, [identityId, originNodeId, originNodeType, scenarioId, streamTurn]);

  return {
    abortActiveRequest,
    startConversation,
    streamTurn,
    hasActiveRequest: () => activeRequestControllerRef.current !== null,
  };
}
