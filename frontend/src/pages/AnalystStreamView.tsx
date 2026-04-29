import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AnalystSSEEvent } from '../types';
import { useRoundtableSseStream } from '../hooks/useRoundtableSseStream';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import {
  createInitialAnalystCache,
  type AnalystCacheState,
  type AnalystStoppedReason,
} from './postVerdictCaches';

interface AnalystStreamViewProps {
  scenarioId: string;
  roomId?: string | null;
  cache: AnalystCacheState;
  setCache: Dispatch<SetStateAction<AnalystCacheState>>;
  contextVersion: number;
}

export default function AnalystStreamView({
  scenarioId,
  roomId,
  cache,
  setCache,
  contextVersion,
}: AnalystStreamViewProps) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');

  const onEvent = useCallback((event: AnalystSSEEvent) => {
    setCache((current) => {
      if (event.type === 'analyst_thinking') {
        const iterations = current.iterations.map((iteration) => ({ ...iteration }));
        const existing = iterations.find((iteration) => iteration.iteration === event.iteration);
        if (existing) {
          existing.action = event.action;
          existing.params = event.params;
        } else {
          iterations.push({
            iteration: event.iteration,
            action: event.action,
            params: event.params,
          });
        }
        return { ...current, iterations };
      }

      if (event.type === 'analyst_tool_result') {
        return {
          ...current,
          iterations: current.iterations.map((iteration) => (
            iteration.iteration === event.iteration
              ? {
                ...iteration,
                summary: event.summary,
                elapsed_ms: event.elapsed_ms,
              }
              : iteration
          )),
        };
      }

      if (event.type === 'analyst_response') {
        return {
          ...current,
          finalAnswer: event.answer,
          stoppedReason: (event.stopped_reason as AnalystStoppedReason) ?? 'final_response',
          streaming: false,
          error: event.error ?? current.error,
        };
      }

      return current;
    });
  }, [setCache]);

  const onError = useCallback((code: string, message: string) => {
    setCache((current) => ({
      ...current,
      error: `${code}: ${message}`,
      streaming: false,
    }));
  }, [setCache]);

  const onComplete = useCallback(() => {
    setCache((current) => ({ ...current, streaming: false }));
  }, [setCache]);

  const { start, abort } = useRoundtableSseStream<AnalystSSEEvent>({
    scenarioId,
    endpoint: 'analyst',
    onEvent,
    onError,
    onComplete,
  });

  useEffect(() => {
    abort();
  }, [abort, contextVersion]);

  const handleSubmit = useCallback(() => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return;
    setCache({
      ...createInitialAnalystCache(),
      streaming: true,
    });

    const policy = loadLlmProviderPolicy();
    void start({
      question: normalizedQuestion,
      ...(roomId ? { room_id: roomId } : {}),
      ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
      ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
      ...(policy.model ? { llm_model: policy.model } : {}),
    });
  }, [question, roomId, setCache, start]);

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
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={cache.streaming}
          rows={2}
        />
        <button
          type="button"
          className={`analyst-stream__submit btn btn--sm${cache.streaming ? ' is-streaming' : ''}`}
          onClick={cache.streaming ? abort : handleSubmit}
          disabled={!cache.streaming && !question.trim()}
        >
          {cache.streaming ? t('roundtable.analyst_stop') : t('roundtable.analyst_ask')}
        </button>
      </div>

      {!cache.streaming && cache.iterations.length === 0 && !cache.finalAnswer && !cache.error && (
        <p className="analyst-stream__empty-hint">{t('roundtable.explore_analyst_desc')}</p>
      )}

      {cache.iterations.length > 0 && (
        <div className="analyst-stream__iterations" aria-live="polite">
          {cache.iterations.map((iteration) => (
            <div key={iteration.iteration} className="analyst-stream__iteration">
              <span className="analyst-stream__iteration-badge">{iteration.iteration}</span>
              <div className="analyst-stream__iteration-body">
                <span className="analyst-stream__tool-name">{toolLabel(iteration.action)}</span>
                {iteration.summary && (
                  <p className="analyst-stream__tool-summary">{iteration.summary}</p>
                )}
                {iteration.elapsed_ms != null && (
                  <span className="analyst-stream__elapsed">
                    {(iteration.elapsed_ms / 1000).toFixed(1)}s
                  </span>
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
        <div className="analyst-stream__answer" aria-live="polite">
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
