import { useCallback, useEffect, useRef } from 'react';

import { buildSessionHeaders, getSessionToken } from '../api/client';
import { parseSseFrame } from '../lib/parseSseFrame';
import { loadLlmProviderPolicy, validateByok } from '../lib/llmProviderPolicy';
import type { AgentConversationWSEvent } from '../types';

function parseConversationSseFrame(frame: string): AgentConversationWSEvent | null {
  return parseSseFrame<AgentConversationWSEvent>(frame);
}

interface UseNodeConversationTransportOptions {
  sessionToken?: string;
  scenarioId: string;
  identityId?: string | null;
  originNodeId?: string | null;
  originNodeType?: string | null;
  originBranchId?: string | null;
  originRoundNumber?: number | null;
  originExcerpt?: string | null;
  setThreadId: (threadId: string | null) => void;
  onTransportError: (code: string, message?: string) => void;
  onWsEvent: (event: AgentConversationWSEvent) => void;
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
  sessionToken = getSessionToken(),
  scenarioId,
  identityId,
  originNodeId,
  originNodeType,
  originBranchId,
  originRoundNumber,
  originExcerpt,
  setThreadId,
  onTransportError,
  onWsEvent,
}: UseNodeConversationTransportOptions) {
  const activeRequestControllerRef = useRef<AbortController | null>(null);
  const bootstrapEpochRef = useRef(0);
  const setThreadIdRef = useRef(setThreadId);
  const onTransportErrorRef = useRef(onTransportError);
  const onWsEventRef = useRef(onWsEvent);

  setThreadIdRef.current = setThreadId;
  onTransportErrorRef.current = onTransportError;
  onWsEventRef.current = onWsEvent;

  const abortActiveRequest = useCallback(() => {
    bootstrapEpochRef.current += 1;
    activeRequestControllerRef.current?.abort();
    activeRequestControllerRef.current = null;
  }, []);

  useEffect(() => () => {
    abortActiveRequest();
  }, [abortActiveRequest, sessionToken]);

  const streamTurn = useCallback(async (nextThreadId: string, text: string): Promise<boolean> => {
    if (getSessionToken() !== sessionToken) return false;
    abortActiveRequest();
    const controller = new AbortController();
    activeRequestControllerRef.current = controller;
    let accepted = false;
    let terminalReceived = false;
    let activeTurnId: string | null = null;
    const isCurrent = () => getSessionToken() === sessionToken
      && !controller.signal.aborted && activeRequestControllerRef.current === controller;
    const dispatchFrame = (frame: string) => {
      if (!isCurrent() || terminalReceived) return;
      const parsed = parseConversationSseFrame(frame);
      if (!parsed) return;
      if ('thread_id' in parsed && parsed.thread_id && parsed.thread_id !== nextThreadId) return;
      if (parsed.type === 'turn_started') activeTurnId = parsed.turn_id;
      if ('turn_id' in parsed && activeTurnId && parsed.turn_id !== activeTurnId) return;
      if (parsed.type === 'turn_completed' || parsed.type === 'turn_aborted' || parsed.type === 'turn_error') {
        // Server validation can terminate a reserved assistant before its first token/start frame.
        if (!activeTurnId && typeof parsed.sequence === 'number') {
          onWsEventRef.current({ type: 'turn_started', thread_id: nextThreadId, turn_id: parsed.turn_id, sequence: parsed.sequence });
        } else if (!activeTurnId && parsed.type === 'turn_error') {
          onTransportErrorRef.current(parsed.code, parsed.message);
          terminalReceived = true;
          return;
        }
        terminalReceived = true;
      }
      onWsEventRef.current(parsed);
    };
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
          ...(originExcerpt ? { origin_excerpt: Array.from(originExcerpt).slice(0, 1000).join('') } : {}),
          ...(providerPolicy.apiKey ? { llm_api_key: providerPolicy.apiKey } : {}),
          ...(providerPolicy.baseUrl ? { llm_base_url: providerPolicy.baseUrl } : {}),
          ...(providerPolicy.model ? { llm_model: providerPolicy.model } : {}),
          ...(providerPolicy.disableUserQuota ? { disable_user_quota: true } : {}),
        }),
        signal: controller.signal,
      });
      if (!isCurrent()) return false;
      if (!response.ok) {
        const error = await readConversationError(response);
        if (isCurrent()) onTransportErrorRef.current(error.code, error.message);
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
        if (!isCurrent()) return accepted;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          dispatchFrame(frame);
        }
      }
      dispatchFrame((buffer + decoder.decode()).trim());
      if (isCurrent() && !terminalReceived) onTransportErrorRef.current('SERVER_ERROR');
    } catch (error) {
      if (!isCurrent()) return accepted;
      const message = error instanceof Error ? error.message : 'Stream failed';
      onTransportErrorRef.current('SERVER_ERROR', message);
      return accepted;
    } finally {
      if (getSessionToken() !== sessionToken) controller.abort();
      if (activeRequestControllerRef.current === controller) {
        activeRequestControllerRef.current = null;
      }
    }
    return accepted;
  }, [abortActiveRequest, originExcerpt, sessionToken]);

  const startConversation = useCallback(async (text: string): Promise<boolean> => {
    if (getSessionToken() !== sessionToken) return false;
    abortActiveRequest();
    const epoch = ++bootstrapEpochRef.current;
    const controller = new AbortController();
    activeRequestControllerRef.current = controller;
    const isCurrent = () => getSessionToken() === sessionToken
      && !controller.signal.aborted && bootstrapEpochRef.current === epoch;
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
          origin_branch_id: originBranchId ?? null,
          origin_round_number: originRoundNumber ?? null,
          origin_node_id: originNodeId ?? null,
          origin_node_type: originNodeType ?? null,
          ...(originExcerpt ? { origin_excerpt: Array.from(originExcerpt).slice(0, 1000).join('') } : {}),
          first_user_content: text,
          ...(providerPolicy.apiKey ? { llm_api_key: providerPolicy.apiKey } : {}),
          ...(providerPolicy.baseUrl ? { llm_base_url: providerPolicy.baseUrl } : {}),
          ...(providerPolicy.model ? { llm_model: providerPolicy.model } : {}),
          ...(providerPolicy.disableUserQuota ? { disable_user_quota: true } : {}),
        }),
        signal: controller.signal,
      });
      if (!isCurrent()) return false;
      if (!response.ok) {
        const error = await readConversationError(response);
        if (isCurrent()) onTransportErrorRef.current(error.code, error.message);
        return false;
      }
      const payload = await response.json() as { thread_id?: string | null };
      if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;
      const message = error instanceof Error ? error.message : 'Start conversation failed';
      onTransportErrorRef.current('SERVER_ERROR', message);
      return false;
    } finally {
      if (getSessionToken() !== sessionToken) controller.abort();
      if (activeRequestControllerRef.current === controller) {
        activeRequestControllerRef.current = null;
      }
    }
  }, [abortActiveRequest, identityId, originBranchId, originExcerpt, originNodeId, originNodeType, originRoundNumber, scenarioId, streamTurn, sessionToken]);

  return {
    abortActiveRequest,
    startConversation,
    streamTurn,
    hasActiveRequest: () => activeRequestControllerRef.current !== null,
  };
}
