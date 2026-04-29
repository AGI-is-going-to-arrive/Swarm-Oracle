import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { EndingRoomParticipant, SurveySSEEvent } from '../types';
import { useRoundtableSseStream } from '../hooks/useRoundtableSseStream';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import {
  createInitialSurveyCache,
  type SurveyCacheState,
} from './postVerdictCaches';

interface SurveyStreamViewProps {
  scenarioId: string;
  roomId?: string | null;
  participants: EndingRoomParticipant[];
  cache: SurveyCacheState;
  setCache: Dispatch<SetStateAction<SurveyCacheState>>;
  contextVersion: number;
}

const MAX_SURVEY_PARTICIPANTS = 6;

export default function SurveyStreamView({
  scenarioId,
  roomId,
  participants,
  cache,
  setCache,
  contextVersion,
}: SurveyStreamViewProps) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(participants.slice(0, MAX_SURVEY_PARTICIPANTS).map((p) => p.id)),
  );

  const toggleParticipant = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_SURVEY_PARTICIPANTS) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const orderedParticipantIds = useMemo(
    () => participants.filter((participant) => selectedIds.has(participant.id)).map((participant) => participant.id),
    [participants, selectedIds],
  );

  const participantMap = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  );

  const onEvent = useCallback((event: SurveySSEEvent) => {
    if (event.type !== 'survey_response') {
      return;
    }

    setCache((current) => {
      if (!event.participant_id) {
        return {
          ...current,
          error: event.error || t('roundtable.survey_stream_failed'),
          streaming: false,
        };
      }
      const responses = new Map(current.responses);
      responses.set(event.participant_id, event);
      return { ...current, responses };
    });
  }, [setCache, t]);

  const onError = useCallback((code: string, message: string) => {
    setCache((current) => ({
      ...current,
      error: `${code}: ${message}`,
      streaming: false,
    }));
  }, [setCache]);

  const onComplete = useCallback(() => {
    setCache((current) => {
      const expectedCount = current.participantOrder.length;
      if (
        expectedCount > 0
        && current.responses.size < expectedCount
        && !current.error
      ) {
        return {
          ...current,
          error: t('roundtable.survey_stream_failed'),
          streaming: false,
        };
      }
      return { ...current, streaming: false };
    });
  }, [setCache, t]);

  const { start, abort } = useRoundtableSseStream<SurveySSEEvent>({
    scenarioId,
    endpoint: 'survey',
    onEvent,
    onError,
    onComplete,
  });

  useEffect(() => {
    abort();
  }, [abort, contextVersion]);

  const handleSubmit = useCallback(() => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || orderedParticipantIds.length === 0) return;
    setCache({
      ...createInitialSurveyCache(),
      streaming: true,
      participantOrder: orderedParticipantIds,
    });

    const policy = loadLlmProviderPolicy();
    void start({
      question: normalizedQuestion,
      participant_ids: orderedParticipantIds,
      ...(roomId ? { room_id: roomId } : {}),
      ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
      ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
      ...(policy.model ? { llm_model: policy.model } : {}),
    });
  }, [orderedParticipantIds, question, roomId, setCache, start]);

  const displayOrder = cache.participantOrder.length > 0 ? cache.participantOrder : orderedParticipantIds;

  return (
    <div className="survey-stream" data-testid="survey-stream-view">
      <div className="survey-stream__picker" role="group" aria-label={t('roundtable.survey_select_participants')}>
        {participants.map((participant) => (
          <label
            key={participant.id}
            className={`survey-stream__checkbox ${selectedIds.has(participant.id) ? 'is-selected' : ''}`}
          >
            <input
              type="checkbox"
              checked={selectedIds.has(participant.id)}
              onChange={() => toggleParticipant(participant.id)}
              disabled={
                cache.streaming
                || (!selectedIds.has(participant.id) && selectedIds.size >= MAX_SURVEY_PARTICIPANTS)
              }
            />
            <span>{participant.display_name}</span>
          </label>
        ))}
      </div>

      <div className="survey-stream__input">
        <textarea
          className="survey-stream__textarea"
          placeholder={t('roundtable.survey_placeholder')}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={cache.streaming}
          rows={2}
        />
        <button
          type="button"
          className="survey-stream__submit btn btn--sm"
          onClick={cache.streaming ? abort : handleSubmit}
          disabled={!cache.streaming && (!question.trim() || selectedIds.size === 0)}
        >
          {cache.streaming ? t('roundtable.survey_stop') : t('roundtable.survey_ask')}
        </button>
      </div>

      {(cache.streaming || cache.responses.size > 0) && (
        <div className="survey-stream__grid" aria-live="polite">
          {displayOrder.map((participantId) => {
            const response = cache.responses.get(participantId);
            const participant = participantMap.get(participantId);
            const hasError = response?.error;
            return (
              <div
                key={participantId}
                className={`survey-stream__card ${response ? 'is-filled' : ''} ${hasError ? 'is-error' : ''}`}
              >
                <div className="survey-stream__card-header">
                  <strong>{response?.display_name ?? participant?.display_name ?? participantId}</strong>
                  <span>{response?.role ?? participant?.role_slot ?? ''}</span>
                </div>
                {response ? (
                  hasError ? (
                    <p className="survey-stream__card-error">{response.error}</p>
                  ) : (
                    <p className="survey-stream__card-answer">{response.answer}</p>
                  )
                ) : (
                  <div className="survey-stream__card-skeleton">
                    {cache.streaming && <span className="editorial-streaming-cursor" />}
                  </div>
                )}
                {response?.elapsed_ms != null && (
                  <span className="survey-stream__card-elapsed">
                    {(response.elapsed_ms / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!cache.streaming && cache.responses.size === 0 && !cache.error && (
        <p className="survey-stream__empty-hint">{t('roundtable.survey_empty_hint')}</p>
      )}

      {cache.error && (
        <div className="survey-stream__error">
          <span>{cache.error}</span>
          <button type="button" className="btn btn--sm" onClick={handleSubmit}>
            {t('roundtable.survey_retry')}
          </button>
        </div>
      )}
    </div>
  );
}
