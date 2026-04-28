import { useCallback, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { AnalystSSEEvent } from '../types';
import { useRoundtableSseStream } from '../hooks/useRoundtableSseStream';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';

interface AnalystIteration {
  iteration: number;
  action: string;
  params?: Record<string, unknown>;
  summary?: string;
  elapsed_ms?: number;
}

type AnalystStoppedReason = 'final_response' | 'llm_error' | 'unexpected_action' | 'max_iterations' | 'stream_failure';

export interface AnalystCacheState {
  iterations: AnalystIteration[];
  finalAnswer: string | null;
  stoppedReason: AnalystStoppedReason | null;
  streaming: boolean;
  error: string | null;
}

export const INITIAL_ANALYST_CACHE: AnalystCacheState = {
  iterations: [],
  finalAnswer: null,
  stoppedReason: null,
  streaming: false,
  error: null,
};

interface AnalystStreamViewProps {
  scenarioId: string;
  cacheRef: React.RefObject<AnalystCacheState>;
  version: number;
  bumpVersion: () => void;
}

export default function AnalystStreamView({
  scenarioId,
  cacheRef,
  bumpVersion,
}: AnalystStreamViewProps) {
  const { t } = useTranslation();
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const questionRef = useRef('');

  const cache = cacheRef.current;

  const onEvent = useCallback((event: AnalystSSEEvent) => {
    const c = cacheRef.current;
    if (event.type === 'analyst_thinking') {
      const existing = c.iterations.find((it) => it.iteration === event.iteration);
      if (existing) {
        existing.action = event.action;
        existing.params = event.params;
      } else {
        c.iterations.push({ iteration: event.iteration, action: event.action, params: event.params });
      }
    } else if (event.type === 'analyst_tool_result') {
      const existing = c.iterations.find((it) => it.iteration === event.iteration);
      if (existing) {
        existing.summary = event.summary;
        existing.elapsed_ms = event.elapsed_ms;
      }
    } else if (event.type === 'analyst_response') {
      c.finalAnswer = event.answer;
      c.stoppedReason = (event.stopped_reason as AnalystStoppedReason) ?? 'final_response';
      c.streaming = false;
      if (event.error) c.error = event.error;
    }
    bumpVersion();
  }, [cacheRef, bumpVersion]);

  const onError = useCallback((code: string, message: string) => {
    cacheRef.current.error = `${code}: ${message}`;
    cacheRef.current.streaming = false;
    bumpVersion();
  }, [cacheRef, bumpVersion]);

  const onComplete = useCallback(() => {
    cacheRef.current.streaming = false;
    bumpVersion();
  }, [cacheRef, bumpVersion]);

  const { start, abort } = useRoundtableSseStream<AnalystSSEEvent>({
    scenarioId,
    endpoint: 'analyst',
    onEvent,
    onError,
    onComplete,
  });

  const handleSubmit = useCallback(() => {
    const question = questionRef.current.trim();
    if (!question) return;
    const c = cacheRef.current;
    c.iterations = [];
    c.finalAnswer = null;
    c.stoppedReason = null;
    c.error = null;
    c.streaming = true;
    bumpVersion();

    const policy = loadLlmProviderPolicy();
    void start({
      question,
      ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
      ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
      ...(policy.model ? { llm_model: policy.model } : {}),
    });
  }, [cacheRef, bumpVersion, start]);

  const handleRetry = useCallback(() => {
    handleSubmit();
  }, [handleSubmit]);

  const stoppedReasonLabel = (reason: AnalystStoppedReason | null): string => {
    switch (reason) {
      case 'final_response': return '';
      case 'llm_error': return t('roundtable.analyst_error_llm');
      case 'unexpected_action': return t('roundtable.analyst_error_action');
      case 'max_iterations': return t('roundtable.analyst_max_iterations');
      case 'stream_failure': return t('roundtable.analyst_error_stream');
      default: return '';
    }
  };

  const toolLabel = (action: string): string => {
    switch (action) {
      case 'query_causal_graph': return t('roundtable.analyst_tool_causal');
      case 'search_identity_memories': return t('roundtable.analyst_tool_memory');
      case 'search_web_context': return t('roundtable.analyst_tool_web');
      default: return action;
    }
  };

  return (
    <div className="analyst-stream" data-testid="analyst-stream-view">
      <div className="analyst-stream__input">
        <textarea
          className="analyst-stream__textarea"
          placeholder={t('roundtable.analyst_placeholder')}
          onChange={(e) => { questionRef.current = e.target.value; forceRender(); }}
          disabled={cache.streaming}
          rows={2}
        />
        <button
          type="button"
          className={`analyst-stream__submit btn btn--sm${cache.streaming ? ' is-streaming' : ''}`}
          onClick={cache.streaming ? abort : handleSubmit}
          disabled={!cache.streaming && !questionRef.current.trim()}
        >
          {cache.streaming ? t('roundtable.analyst_stop') : t('roundtable.analyst_ask')}
        </button>
      </div>

      {!cache.streaming && cache.iterations.length === 0 && !cache.finalAnswer && !cache.error && (
        <p className="analyst-stream__empty-hint">{t('roundtable.explore_analyst_desc')}</p>
      )}

      {cache.iterations.length > 0 && (
        <div className="analyst-stream__iterations">
          {cache.iterations.map((it) => (
            <div key={it.iteration} className="analyst-stream__iteration">
              <span className="analyst-stream__iteration-badge">{it.iteration}</span>
              <div className="analyst-stream__iteration-body">
                <span className="analyst-stream__tool-name">{toolLabel(it.action)}</span>
                {it.summary && (
                  <p className="analyst-stream__tool-summary">{it.summary}</p>
                )}
                {it.elapsed_ms != null && (
                  <span className="analyst-stream__elapsed">{(it.elapsed_ms / 1000).toFixed(1)}s</span>
                )}
              </div>
            </div>
          ))}
          {cache.streaming && (
            <div className="analyst-stream__thinking">
              <span className="editorial-streaming-cursor">{t('roundtable.analyst_thinking')}</span>
            </div>
          )}
        </div>
      )}

      {cache.finalAnswer && (
        <div className="analyst-stream__answer">
          <p className="analyst-stream__answer-text">{cache.finalAnswer}</p>
        </div>
      )}

      {cache.stoppedReason && cache.stoppedReason !== 'final_response' && (
        <div className="analyst-stream__stopped">
          <span>{stoppedReasonLabel(cache.stoppedReason)}</span>
          {(cache.stoppedReason === 'llm_error' || cache.stoppedReason === 'stream_failure') && (
            <button type="button" className="btn btn--sm" onClick={handleRetry}>
              {t('roundtable.analyst_retry')}
            </button>
          )}
        </div>
      )}

      {cache.error && !cache.stoppedReason && (
        <div className="analyst-stream__error">
          <span>{cache.error}</span>
          <button type="button" className="btn btn--sm" onClick={handleRetry}>
            {t('roundtable.analyst_retry')}
          </button>
        </div>
      )}
    </div>
  );
}
