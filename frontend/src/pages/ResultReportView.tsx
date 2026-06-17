import { useEffect, useState, useCallback } from 'react';
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
    <div className="my-8">
      <div className="report-panel-container flat-card">
        <div className="flex flex-col items-center text-center">
          {title && (
            <h1 className="text-xl font-semibold text-[color:var(--text-primary)] mb-2">
              {title}
            </h1>
          )}
          <p className="text-sm text-[color:var(--text-secondary)] mb-5 max-w-md">
            {desc}
          </p>
          {actionLabel && onAction && (
            <div>
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

  // Re-fetchable so the report panel's retry can refresh the persisted /story.full_report.
  const refetch = useCallback(() => {
    if (!id || !isReportEnabled) return;
    Promise.resolve()
      .then(() => {
        setLoading(true);
        setLoadError(false);
        return Promise.all([getScenario(id), getStory(id)]);
      })
      .then(([scen, story]) => {
        setScenario(scen);
        setStoryData(story);
      })
      .catch((err) => {
        console.error(err);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [id, isReportEnabled]);

  useEffect(() => {
    if (isReportEnabled) {
      refetch();
    }
  }, [isReportEnabled, refetch]);

  if (capLoading) {
    return (
      <div className="result-report-view">
        <ProgressIndicator currentStep={4} />
        <div className="mt-8 animate-pulse motion-reduce:animate-none space-y-4">
          <div className="h-8 bg-[color:var(--bg-hover)] rounded w-1/3" />
          <div className="h-4 bg-[color:var(--bg-hover)] rounded w-1/2" />
          <div className="h-64 bg-[color:var(--bg-hover)] rounded w-full" />
        </div>
      </div>
    );
  }

  if (capError) {
    return (
      <div className="result-report-view">
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
      <div className="result-report-view">
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
      <div className="result-report-view">
        <ProgressIndicator currentStep={4} />
        <div className="mt-8 animate-pulse motion-reduce:animate-none space-y-4">
          <div className="h-8 bg-[color:var(--bg-hover)] rounded w-1/3" />
          <div className="h-4 bg-[color:var(--bg-hover)] rounded w-1/2" />
          <div className="h-64 bg-[color:var(--bg-hover)] rounded w-full" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="result-report-view">
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
      <div className="result-report-view">
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
            {t('result.report.fullReport')}
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
