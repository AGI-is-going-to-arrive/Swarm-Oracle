import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getScenario, getStory } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { Scenario, StoryData } from '../types';
import { ResultContextProvider } from './result/ResultContext';
import { ResultReportPanel } from './result/ResultReportPanel';
import { ProgressIndicator } from '../components/ProgressIndicator';
import './ResultView.css';
import './ResultReportView.css';

interface ReportStatePanelProps {
  title?: string;
  desc: string;
  actionLabel?: string;
  onAction?: () => void;
  isPrimary?: boolean;
}

function ReportStatePanel({ title, desc, actionLabel, onAction, isPrimary = false }: ReportStatePanelProps) {
  return (
    <div className="report-state-panel-shell">
      <div className="report-panel-container flat-card">
        <div className="report-state-panel">
          {title && (
            <h1 className="report-state-panel__title">
              {title}
            </h1>
          )}
          <p className="report-state-panel__desc">
            {desc}
          </p>
          {actionLabel && onAction && (
            <div className="report-state-panel__action">
              <button
                type="button"
                onClick={onAction}
                className={isPrimary ? 'btn btn-primary' : 'btn'}
              >
                {actionLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResultReportView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  // F4: Check result_report capability before executing getScenario / getStory.
  const {
    loading: capLoading,
    enabled: isReportEnabled,
    error: capError,
    reload: reloadCap,
  } = useCapabilityCheck('result_report');

  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [storyData, setStoryData] = useState<StoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestEpochRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);

  // Re-fetchable so the report panel's retry can refresh the persisted /story.full_report.
  const refetch = useCallback(() => {
    if (!id || !isReportEnabled) return;
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    Promise.resolve()
      .then(() => {
        setLoading(true);
        setLoadError(false);
        return Promise.all([
          getScenario(id, { signal: controller.signal }),
          getStory(id, { signal: controller.signal }),
        ]);
      })
      .then(([scen, story]) => {
        if (requestEpoch !== requestEpochRef.current) return;
        setScenario(scen);
        setStoryData(story);
      })
      .catch((err) => {
        if (requestEpoch !== requestEpochRef.current || controller.signal.aborted) return;
        console.error(err);
        setLoadError(true);
      })
      .finally(() => {
        if (requestEpoch === requestEpochRef.current) {
          setLoading(false);
          requestControllerRef.current = null;
        }
      });
  }, [id, isReportEnabled]);

  useEffect(() => {
    if (isReportEnabled) {
      refetch();
    }
  }, [isReportEnabled, refetch]);

  useEffect(() => () => {
    requestEpochRef.current += 1;
    requestControllerRef.current?.abort();
  }, []);

  if (capLoading) {
    return (
      <div className="result-report-view report-doc">
        <ProgressIndicator currentStep={4} />
        <div className="report-route-skeleton animate-pulse motion-reduce:animate-none">
          <div className="h-8 bg-[color:var(--bg-hover)] rounded w-1/3" />
          <div className="h-4 bg-[color:var(--bg-hover)] rounded w-1/2" />
          <div className="h-64 bg-[color:var(--bg-hover)] rounded w-full" />
        </div>
      </div>
    );
  }

  if (capError) {
    return (
      <div className="result-report-view report-doc">
        <button
          type="button"
          onClick={() => navigate(`/result/${id}`)}
          className="btn btn-ghost result-back"
        >
          <span aria-hidden="true">←</span>
          <span>{t('result.report.backToOverview')}</span>
        </button>
        <ReportStatePanel
          desc={t('result.report.couldNotConfirmAvailability')}
          actionLabel={t('result.report.retry')}
          onAction={() => void reloadCap?.()}
        />
      </div>
    );
  }

  // F4: Render friendly "Feature Not Enabled" panel with return button if disabled.
  if (!isReportEnabled) {
    return (
      <div className="result-report-view report-doc">
        <button
          type="button"
          onClick={() => navigate(`/result/${id}`)}
          className="btn btn-ghost result-back"
        >
          <span aria-hidden="true">←</span>
          <span>{t('result.report.backToOverview')}</span>
        </button>
        <ReportStatePanel
          title={t('result.report.featureNotEnabled')}
          desc={t('result.report.featureNotEnabledDesc')}
          actionLabel={t('result.report.backToOverview')}
          onAction={() => navigate(`/result/${id}`)}
          isPrimary={true}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="result-report-view report-doc">
        <ProgressIndicator currentStep={4} />
        <div className="report-route-skeleton animate-pulse motion-reduce:animate-none">
          <div className="h-8 bg-[color:var(--bg-hover)] rounded w-1/3" />
          <div className="h-4 bg-[color:var(--bg-hover)] rounded w-1/2" />
          <div className="h-64 bg-[color:var(--bg-hover)] rounded w-full" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="result-report-view report-doc">
        <button
          type="button"
          onClick={() => navigate(`/result/${id}`)}
          className="btn btn-ghost result-back"
        >
          <span aria-hidden="true">←</span>
          <span>{t('result.report.backToOverview')}</span>
        </button>
        <ReportStatePanel
          title={t('result.report.couldNotLoadReport')}
          desc={t('result.report.loadReportErrorDesc')}
          actionLabel={t('result.report.retry')}
          onAction={refetch}
        />
      </div>
    );
  }

  const isReplayMode = typeof window !== 'undefined' && (new URLSearchParams(window.location.search).has('replay') || new URLSearchParams(window.location.search).has('local'));
  const isBrief = storyData?.full_report && 'detail_level' in storyData.full_report
    && storyData.full_report.detail_level === 'brief';

  // Minimal context for ResultReportPanel (it only reads storyData/activeScenarioId/isZh/isReplayMode).
  const contextValue = {
    id,
    activeScenarioId: id,
    navigate,
    t,
    isZh,
    isReplayMode,
    scenario,
    storyData,
    branches: storyData?.branches || [],
  } as unknown as import('./result/ResultContext').ResultViewContextValue;

  return (
    <ResultContextProvider value={contextValue}>
      <div className="result-report-view report-doc">
        <button
          type="button"
          onClick={() => navigate(`/result/${id}`)}
          className="btn btn-ghost result-back"
        >
          <span aria-hidden="true">←</span>
          <span>{t('result.report.backToOverview')}</span>
        </button>

        <header className="result-header">
          <h1 className="result-title">
            {t(isBrief ? 'result.report.briefTitle' : 'result.report.fullReport')}
          </h1>
          {storyData?.question && (
            <div className="result-question">
              {storyData.question}
            </div>
          )}
        </header>

        <ResultReportPanel variant="standalone" onRefresh={refetch} />
      </div>
    </ResultContextProvider>
  );
}
