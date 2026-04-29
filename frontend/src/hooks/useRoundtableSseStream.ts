import { useCallback, useEffect, useRef } from 'react';

import { buildSessionHeaders } from '../api/client';
import { parseSseFrame } from '../lib/parseSseFrame';

const SSE_TIMEOUT_MS = 300_000;

interface UseRoundtableSseStreamOptions<T extends { type: string }> {
  scenarioId: string;
  endpoint: 'analyst' | 'survey';
  onEvent: (event: T) => void;
  onError: (code: string, message: string) => void;
  onComplete: () => void;
}

export function useRoundtableSseStream<T extends { type: string }>({
  scenarioId,
  endpoint,
  onEvent,
  onError,
  onComplete,
}: UseRoundtableSseStreamOptions<T>) {
  const controllerRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);
  const onCompleteRef = useRef(onComplete);
  onEventRef.current = onEvent;
  onErrorRef.current = onError;
  onCompleteRef.current = onComplete;

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const start = useCallback(async (body: Record<string, unknown>) => {
    abort();
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;

    let timedOut = false;
    const localTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SSE_TIMEOUT_MS);
    timeoutRef.current = localTimeout;

    try {
      const response = await fetch(`/api/scenario/${encodeURIComponent(scenarioId)}/${endpoint}`, {
        method: 'POST',
        headers: buildSessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (epochRef.current !== epoch) return;
        const errorBody = await response.json().catch(() => ({})) as Record<string, unknown>;
        const detail = (typeof errorBody.detail === 'object' && errorBody.detail !== null
          ? errorBody.detail : null) as Record<string, unknown> | null;
        const code = typeof detail?.code === 'string'
          ? detail.code
          : typeof errorBody.code === 'string' ? errorBody.code : 'HTTP_ERROR';
        const message = typeof detail?.message === 'string'
          ? detail.message
          : typeof errorBody.message === 'string'
            ? errorBody.message
            : `HTTP ${response.status}`;
        onErrorRef.current(code, message);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        if (epochRef.current !== epoch) return;
        onErrorRef.current('NO_BODY', 'Response has no body');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let receivedCompletion = false;
      const dispatchFrame = (frame: string) => {
        const event = parseSseFrame<T>(frame);
        if (!event) {
          return;
        }
        onEventRef.current(event);
        if (event.type === 'analyst_response' && 'stopped_reason' in event) {
          receivedCompletion = true;
        }
      };
      const flushBuffer = (allowTrailingFrame: boolean) => {
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          dispatchFrame(frame);
        }

        if (allowTrailingFrame && buffer.trim()) {
          dispatchFrame(buffer);
          buffer = '';
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (epochRef.current !== epoch) return;

        if (done) {
          buffer += decoder.decode();
          flushBuffer(true);
          if (endpoint === 'analyst' && !receivedCompletion) {
            onErrorRef.current('STREAM_INTERRUPTED', 'Analyst stream ended without response event');
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        flushBuffer(false);
      }
      onCompleteRef.current();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (epochRef.current === epoch) {
          if (timedOut) {
            onErrorRef.current('STREAM_TIMEOUT', 'Stream timed out');
          } else {
            onCompleteRef.current();
          }
        }
        return;
      }
      if (epochRef.current !== epoch) return;
      onErrorRef.current('NETWORK_ERROR', (err as Error).message);
    } finally {
      clearTimeout(localTimeout);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      if (timeoutRef.current === localTimeout) {
        timeoutRef.current = null;
      }
    }
  }, [scenarioId, endpoint, abort]);

  useEffect(() => () => { abort(); }, [abort]);

  return { start, abort, isStreaming: () => controllerRef.current !== null };
}
