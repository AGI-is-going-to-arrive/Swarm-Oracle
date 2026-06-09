import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getScenario, getStory } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { Scenario, StoryData } from '../types';
import { ResultContextProvider } from './result/ResultContext';
import { ResultReportPanel } from './result/ResultReportPanel';
import { ProgressIndicator } from '../components/ProgressIndicator';

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
      <div className="p-8 max-w-4xl mx-auto">
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
      <div className="min-h-screen bg-[color:var(--bg-base)] py-8">
        <div className="max-w-4xl mx-auto px-4">
          <div className="mb-6 flex justify-between items-center">
            <button
              type="button"
              onClick={() => navigate(`/result/${id}`)}
              className="text-[color:var(--text-secondary)] hover:text-[color:var(--color-primary)] flex items-center space-x-2 rounded focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)]"
            >
              <span aria-hidden="true">←</span>
              <span>{t('result.report.backToOverview')}</span>
            </button>
          </div>
          <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center text-center forced-colors:border">
            <p className="text-sm text-[color:var(--text-secondary)] mb-4">
              {t('result.report.couldNotConfirmAvailability')}
            </p>
            <button
              type="button"
              onClick={() => void reloadCap?.()}
              className="px-5 py-2 rounded border border-[color:var(--border-default)] text-[color:var(--color-primary)] hover:bg-[color:var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)] forced-colors:border transition-colors motion-reduce:transition-none"
            >
              {t('result.report.retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // F4: Render friendly "Feature Not Enabled" panel with return button if disabled.
  if (!isReportEnabled) {
    return (
      <div className="min-h-screen bg-[color:var(--bg-base)] py-8">
        <div className="max-w-4xl mx-auto px-4">
          <div className="mb-6 flex justify-between items-center">
            <button
              type="button"
              onClick={() => navigate(`/result/${id}`)}
              className="text-[color:var(--text-secondary)] hover:text-[color:var(--color-primary)] flex items-center space-x-2 rounded focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)]"
            >
              <span aria-hidden="true">←</span>
              <span>{t('result.report.backToOverview')}</span>
            </button>
          </div>
          <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center text-center forced-colors:border">
            <h1 className="text-xl font-semibold text-[color:var(--text-primary)] mb-2">
              {t('result.report.featureNotEnabled')}
            </h1>
            <p className="text-sm text-[color:var(--text-secondary)] mb-5 max-w-md">
              {t('result.report.featureNotEnabledDesc')}
            </p>
            <button
              type="button"
              onClick={() => navigate(`/result/${id}`)}
              className="px-5 py-2 rounded border border-[color:var(--border-default)] bg-[color:var(--color-primary)] text-white hover:bg-[color:var(--color-primary-dim)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)] forced-colors:border transition-colors motion-reduce:transition-none"
            >
              {t('result.report.backToOverview')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
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
      <div className="min-h-screen bg-[color:var(--bg-base)] py-8">
        <div className="max-w-4xl mx-auto px-4">
          <div className="mb-6 flex justify-between items-center">
            <button
              type="button"
              onClick={() => navigate(`/result/${id}`)}
              className="text-[color:var(--text-secondary)] hover:text-[color:var(--color-primary)] flex items-center space-x-2 rounded focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)]"
            >
              <span aria-hidden="true">←</span>
              <span>{t('result.report.backToOverview')}</span>
            </button>
          </div>
          <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center text-center forced-colors:border">
            <h1 className="text-xl font-semibold text-[color:var(--text-primary)] mb-2">
              {t('result.report.couldNotLoadReport')}
            </h1>
            <p className="text-sm text-[color:var(--text-secondary)] mb-5 max-w-md">
              {t('result.report.loadReportErrorDesc')}
            </p>
            <button
              type="button"
              onClick={refetch}
              className="px-5 py-2 rounded border border-[color:var(--border-default)] text-[color:var(--color-primary)] hover:bg-[color:var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)] forced-colors:border transition-colors motion-reduce:transition-none"
            >
              {t('result.report.retry')}
            </button>
          </div>
        </div>
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
      <div className="min-h-screen bg-[color:var(--bg-base)] py-8">
        <div className="max-w-4xl mx-auto px-4">
          <div className="mb-6 flex justify-between items-center">
            <button
              type="button"
              onClick={() => navigate(`/result/${id}`)}
              className="text-[color:var(--text-secondary)] hover:text-[color:var(--color-primary)] flex items-center space-x-2 rounded focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)]"
            >
              <span aria-hidden="true">←</span>
              <span>{t('result.report.backToOverview')}</span>
            </button>
          </div>
          {/* Standalone page owns the <h1>; the panel renders its title as <h2>. */}
          <h1 className="text-3xl font-bold text-[color:var(--text-primary)] mb-4">
            {t('result.report.deepReadReport')}
          </h1>
          <ResultReportPanel variant="standalone" onRefresh={refetch} />
        </div>
      </div>
    </ResultContextProvider>
  );
}
