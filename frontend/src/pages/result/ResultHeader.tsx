/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Result header (back / title / mode toggle / actions)
   ═══════════════════════════════════════════════════════════ */

import { QuotaBadge } from '../../components/shared/QuotaBadge';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import type { ResultViewMode } from '../../stores/uiPreferencesStore';
import { useResultContext } from './ResultContext';

interface ResultHeaderProps {
  section?: 'heading' | 'tools';
}

export default function ResultHeader({ section = 'heading' }: ResultHeaderProps) {
  const {
    t,
    id,
    isReplayMode,
    branches,
    scenario,
    storyData,
    activeScenarioId,
    activeRuntimePresetLabel,
    resultViewMode,
    setResultViewMode,
    isWorkbenchMode,
    capabilities,
    analysisBranch,
    cfBranchId,
    handleOpenRoundtable,
    showResultReplayImportAction,
    importingReplay,
    handleImportReplay,
    handleExport,
    exporting,
    setShowShare,
    replayUrl,
    handleCopyPermalink,
    permalinkCopied,
    handleShareChallenge,
    challengeLinkCopied,
    setShowSnapshotExport,
    navigate,
    exportError,
    importError,
  } = useResultContext();
  const hasResultVerdict = Boolean(
    capabilities?.result_verdict?.enabled
      && typeof storyData?.verdict === 'string'
      && storyData.verdict.trim(),
  );
  const subtitleKey = hasResultVerdict ? 'result.subtitle_prediction' : 'result.subtitle';
  const causalEnabled = capabilities?.causal_graph?.enabled ?? false;
  const kgEnabled = capabilities?.kg_explorer?.enabled ?? false;
  const hasCausalGraph = Boolean(scenario?.causal_graph_id);
  const encodedScenarioId = activeScenarioId ? encodeURIComponent(activeScenarioId) : null;
  const causalGraphHref = encodedScenarioId && causalEnabled && hasCausalGraph && !isReplayMode
    ? `/sim/${encodedScenarioId}/causal-map`
    : null;
  const workbenchView = !causalEnabled && kgEnabled ? 'kg' : 'graph';
  const workbenchBranchQuery = analysisBranch
    ? `&branch=${encodeURIComponent(analysisBranch.id)}`
    : '';
  const graphWorkbenchHref = encodedScenarioId
    && !isReplayMode
    && hasCausalGraph
    && (causalEnabled || kgEnabled)
    ? `/workbench/${encodedScenarioId}?view=${workbenchView}${workbenchBranchQuery}`
    : null;

  const handleModeChange = (val: string) => {
    if (val !== 'reader' && val !== 'workbench') return;
    setResultViewMode(val as ResultViewMode);
    if (val !== 'workbench') return;
    window.requestAnimationFrame(() => {
      const bridge = document.getElementById('result-bridge');
      if (!bridge || typeof bridge.scrollIntoView !== 'function') return;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      bridge.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
    });
  };

  return (
    <header className={section === 'heading' ? 'result-header' : 'result-header-tools'}>
      {section === 'heading' && <>
      <button
        className="btn btn-ghost result-back"
        onClick={() => (
          !isReplayMode && id
            ? navigate(`/sim/${id}`, { state: { forceClassicForDone: true } })
            : navigate('/')
        )}
      >
        {t('result.back')}
      </button>
      <h1 className="result-title">{t('result.title')}</h1>
      {storyData?.question && (
        <p className="result-question">{storyData.question}</p>
      )}
      <p className="result-subtitle">
        {t(subtitleKey)} — {t('result.ending_count', { count: branches.length })}
      </p>
      <div className="result-mode-toggle">
        <ToggleGroup
          type="single"
          value={resultViewMode}
          onValueChange={handleModeChange}
          variant="outline"
          size="sm"
          aria-label={t('result.mode_toggle_label')}
          className="result-mode-toggle__group"
        >
          <ToggleGroupItem value="reader" aria-label={t('result.mode_reader')}>
            {t('result.mode_reader')}
          </ToggleGroupItem>
          <ToggleGroupItem value="workbench" aria-label={t('result.mode_workbench')}>
            {t('result.mode_workbench')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      </>}
      {section === 'tools' && <>
      <div className="result-archive__chips">
        <span className="archive-chip archive-chip--primary">
          {t('common.runtime_preset_label')} · {activeRuntimePresetLabel}
        </span>
        {activeScenarioId && !isReplayMode && (
          <>
            <QuotaBadge scenarioId={activeScenarioId} type="conversation" />
            <QuotaBadge scenarioId={activeScenarioId} type="replay" />
          </>
        )}
      </div>
      <div className="result-actions">
        <div className="result-actions__primary">
          {branches.length > 1 && (
            <button
              className="btn"
              onClick={handleOpenRoundtable}
              disabled={isReplayMode || scenario?.status !== 'done'}
            >
              {t('roundtable.entry_cta')}
            </button>
          )}
          {showResultReplayImportAction && (
            <button
              className="btn btn-primary"
              onClick={() => void handleImportReplay()}
              disabled={importingReplay}
            >
              {importingReplay
                ? t('sim.replay.importing')
                : t('sim.replay.import_local')}
            </button>
          )}
        </div>
        <div className="result-actions__secondary">
          <button
            className="btn"
            onClick={handleExport}
            disabled={exporting || isReplayMode}
          >
            {exporting ? t('result.exporting') : t('result.export')}
          </button>
          <button
            className="btn"
            onClick={() => setShowShare(true)}
            disabled={isReplayMode || !replayUrl}
          >
            {t('result.share_btn')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void handleCopyPermalink()}
            disabled={!replayUrl}
          >
            {permalinkCopied ? t('result.permalink_copied') : t('result.copy_permalink_btn')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void handleShareChallenge()}
            disabled={!scenario}
          >
            {challengeLinkCopied ? t('result.challenge_link_copied') : t('result.share_challenge_btn')}
          </button>
          {capabilities?.snapshot_export?.enabled && id && !isReplayMode && (
            <button
              className="btn btn-ghost"
              onClick={() => setShowSnapshotExport(true)}
              data-testid="result-snapshot-export-btn"
            >
              {t('snapshot.export_btn', 'Export snapshot')}
            </button>
          )}
        </div>
        <div className="result-actions__overflow">
          {capabilities?.you_vs_oracle?.enabled && (
            <button
              className="btn btn-ghost"
              onClick={() => navigate('/leaderboard')}
            >
              {t('result.leaderboard_link')}
            </button>
          )}
          {capabilities?.prediction_journal?.enabled && (
            <button
              className="btn btn-ghost"
              onClick={() => navigate('/me/journal')}
            >
              {t('result.journal_link')}
            </button>
          )}
          {causalGraphHref && (
            <a
              className="btn btn-ghost result-actions__graph-link"
              href={causalGraphHref}
            >
              {t('result.causal_graph_link', 'View Causal Graph')}
            </a>
          )}
          {graphWorkbenchHref && (
            <a
              className="btn btn-ghost result-actions__graph-link"
              href={graphWorkbenchHref}
            >
              {t('result.open_workbench_link', 'Graph Workbench')}
            </a>
          )}
          {isWorkbenchMode && activeScenarioId && analysisBranch && !isReplayMode && cfBranchId && (
            <a
              className="btn btn-ghost"
              href={`/result/${encodeURIComponent(activeScenarioId)}/compare?branch_a=${encodeURIComponent(analysisBranch.id)}&branch_b=${encodeURIComponent(cfBranchId)}`}
            >
              {t('result.compare_link', 'Compare branches')}
            </a>
          )}
        </div>
      </div>
      {exportError && <p className="result-error result-error--spaced">{exportError}</p>}
      {importError && <p className="result-error result-error--spaced">{importError}</p>}
      </>}
    </header>
  );
}
