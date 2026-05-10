import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  getCounterfactualCompare,
  getScenario,
  isApiError,
} from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useSimulationStore } from '../stores/simulationStore';
import { PhaserGameLoader } from '../game';
import { TimelineBar } from '../components/TimelineBar';
import { buildAutomationErrorState } from '../lib/apiErrorMessage';
import { captureCompositeElementDataUrl, captureElementDataUrl } from '../hooks/useScreenCapture';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import './CompareDigestView.css';

interface RoundDiff {
  round: number;
  branch_a_summary: string;
  branch_b_summary: string;
  divergence_score: number;
}

interface CompareData {
  scenario_id: string;
  branch_a: string;
  branch_b: string;
  rounds: RoundDiff[];
}

type ComparePane = 'a' | 'b';

type CompareErrorState =
  | { kind: 'missing_params' }
  | { kind: 'no_data'; status: number | null }
  | { kind: 'load_failed'; source: 'compare' | 'scenario' | 'capability'; status: number | null };

function formatRoundLabel(round: number, isZh: boolean) {
  return isZh ? `第 ${round} 轮` : `Round ${round}`;
}

export function CompareDigestView() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const {
    loading: capLoading,
    enabled,
    error: capabilityError,
    reload: reloadCapability,
  } = useCapabilityCheck('counterfactual_replay');
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const branchA = searchParams.get('branch_a') ?? '';
  const branchB = searchParams.get('branch_b') ?? '';
  const missingParamsLabel = t('compare.missing_params', 'Missing branch parameters');
  const encodedScenarioId = id ? encodeURIComponent(id) : '';
  const resultHref = encodedScenarioId ? `/result/${encodedScenarioId}` : '/';

  const setScenario = useSimulationStore((state) => state.setScenario);
  const resetSimulation = useSimulationStore((state) => state.reset);
  const storeScenario = useSimulationStore((state) => state.scenario);
  const branches = useSimulationStore((state) => state.branches);
  const messages = useSimulationStore((state) => state.messages);
  const agents = useSimulationStore((state) => state.agents);

  const [data, setData] = useState<CompareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CompareErrorState | null>(null);
  const [activePane, setActivePane] = useState<ComparePane>('a');
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [playbackMode, setPlaybackMode] = useState<'replay' | 'skip'>('skip');
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(1);
  const [theaterMountKey, setTheaterMountKey] = useState(0);
  const [snapshots, setSnapshots] = useState<Record<ComparePane, string | null>>({
    a: null,
    b: null,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRequestIdRef = useRef(0);

  const availableRounds = useMemo(
    () => data?.rounds.map((entry) => entry.round) ?? [],
    [data],
  );
  const scenarioQuestion = storeScenario?.question ?? null;
  const hasScenario = Boolean(storeScenario);
  const errorLabel = useMemo(() => {
    if (!error) return null;
    if (error.kind === 'missing_params') {
      return missingParamsLabel;
    }
    if (error.kind === 'no_data') {
      return t('compare.no_data', 'No comparison data available.');
    }
    return t('compare.error_fetch', 'Unable to load comparison data right now. Please retry.');
  }, [error, missingParamsLabel, t]);

  const loadCompare = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    if (!id || !branchA || !branchB) {
      setLoading(false);
      setData(null);
      setError({ kind: 'missing_params' });
      return;
    }

    setLoading(true);
    setError(null);
    setData(null);
    try {
      let comparePayload: CompareData;
      try {
        comparePayload = await getCounterfactualCompare<CompareData>(id, branchA, branchB);
      } catch (compareErr) {
        if (requestId !== loadRequestIdRef.current) return;
        if (compareErr instanceof ApiError) {
          setError(
            compareErr.status === 404
              ? { kind: 'no_data', status: compareErr.status }
              : { kind: 'load_failed', source: 'compare', status: compareErr.status },
          );
        } else {
          setError({ kind: 'load_failed', source: 'compare', status: null });
        }
        return;
      }

      const scenarioPayload = await getScenario(id);
      if (requestId !== loadRequestIdRef.current) return;
      setScenario(scenarioPayload);
      setData(comparePayload);
      setSelectedRound(comparePayload.rounds[0]?.round ?? 1);
    } catch (nextError) {
      if (requestId !== loadRequestIdRef.current) return;
      setError({
        kind: 'load_failed',
        source: 'scenario',
        status: isApiError(nextError) ? nextError.status : null,
      });
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [branchA, branchB, id, setScenario]);

  useEffect(() => {
    if (!enabled || capabilityError) return;
    void loadCompare();
    return () => {
      loadRequestIdRef.current += 1;
      resetSimulation();
    };
  }, [capabilityError, enabled, loadCompare, resetSimulation]);

  useEffect(() => {
    if (availableRounds.length === 0) return;
    if (selectedRound == null || !availableRounds.includes(selectedRound)) {
      setSelectedRound(availableRounds[0]);
    }
  }, [availableRounds, selectedRound]);

  const branchById = useMemo(
    () => new Map(branches.map((branch) => [branch.id, branch])),
    [branches],
  );

  const activeBranchId = activePane === 'a' ? branchA : branchB;
  const activeDiff = useMemo(
    () => data?.rounds.find((entry) => entry.round === selectedRound) ?? null,
    [data?.rounds, selectedRound],
  );
  const selectedRoundLabel = selectedRound != null
    ? formatRoundLabel(selectedRound, isZh)
    : (isZh ? '最新回合' : 'Latest round');
  const activeDivergencePct = activeDiff
    ? Math.round(activeDiff.divergence_score * 100)
    : null;

  const branchPanels = useMemo(() => ({
    a: {
      id: branchA,
      title: branchById.get(branchA)?.title ?? t('compare.branch_a_label', 'Branch A (Original)'),
      summary: activeDiff?.branch_a_summary ?? '',
      probability: branchById.get(branchA)?.probability ?? null,
    },
    b: {
      id: branchB,
      title: branchById.get(branchB)?.title ?? t('compare.branch_b_label', 'Branch B (Counterfactual)'),
      summary: activeDiff?.branch_b_summary ?? '',
      probability: branchById.get(branchB)?.probability ?? null,
    },
  }), [activeDiff?.branch_a_summary, activeDiff?.branch_b_summary, branchA, branchB, branchById, t]);

  const roundMarkers = useMemo(
    () => availableRounds.map((round) => ({
      round,
      isAvailable: true,
      isSelected: selectedRound === round,
      forkCount: 0,
      cardCount: 0,
      betCount: 0,
      resultCount: 0,
      resultSummaries: [],
      cardSummaries: [],
      betSummaries: [],
      forkTitles: [],
    })),
    [availableRounds, selectedRound],
  );

  const captureActivePaneSnapshot = useCallback(async (pane: ComparePane) => {
    const root = rootRef.current;
    if (!root) return;
    const selector = pane === 'a'
      ? '[data-testid="compare-pane-a"] .phaser-game-container canvas'
      : '[data-testid="compare-pane-b"] .phaser-game-container canvas';
    const canvas = root.querySelector(selector) as HTMLCanvasElement | null;
    if (!canvas) return;
    try {
      const snapshot = canvas.toDataURL('image/png');
      setSnapshots((current) => ({ ...current, [pane]: snapshot }));
    } catch (nextError) {
      console.warn('[CompareDigestView] Failed to capture pane snapshot', nextError);
    }
  }, []);

  const activatePane = useCallback(async (pane: ComparePane) => {
    if (pane === activePane) return;
    await captureActivePaneSnapshot(activePane);
    setActivePane(pane);
    setPlaybackMode('skip');
    setTheaterMountKey((value) => value + 1);
  }, [activePane, captureActivePaneSnapshot]);

  const handleRoundSelect = useCallback((round: number) => {
    setSelectedRound(round);
    setPlaybackMode('skip');
    setTheaterMountKey((value) => value + 1);
  }, []);

  const handleReplay = useCallback(() => {
    setPlaybackMode('replay');
    setTheaterMountKey((value) => value + 1);
  }, []);

  const handleSkip = useCallback(() => {
    setPlaybackMode('skip');
    setTheaterMountKey((value) => value + 1);
  }, []);

  const cycleReplaySpeed = useCallback(() => {
    setReplaySpeed((current) => {
      if (current === 1) return 2;
      if (current === 2) return 4;
      return 1;
    });
  }, []);

  useEffect(() => {
    const win = window as AutomationWindow;
    const capture = async (mode: 'canvas' | 'panel' | 'modal' = 'panel') => {
      const activeCanvasSelector = '.compare-theater-pane.is-active .phaser-game-container';
      if (mode === 'canvas') {
        return captureElementDataUrl(activeCanvasSelector, 'canvas');
      }
      const compositePanelShot = await captureCompositeElementDataUrl(
        '.compare-digest-view',
        activeCanvasSelector,
      );
      if (compositePanelShot) {
        return compositePanelShot;
      }
      const activeCanvasShot = await captureElementDataUrl(
        activeCanvasSelector,
        'canvas',
      );
      if (activeCanvasShot) {
        return activeCanvasShot;
      }
      return captureElementDataUrl('.compare-digest-view', 'element');
    };

    win.capture_game_screenshot = capture;
    win.render_game_to_text = () => stringifyAutomationPayload(
      {
        question: scenarioQuestion,
        status: loading ? 'loading' : error ? 'error' : 'done',
        currentRound: selectedRound ?? 0,
        totalRounds: availableRounds[availableRounds.length - 1] ?? null,
        viewMode: 'theater',
        visualizationEnabled: true,
        isSimulationComplete: Boolean(data && hasScenario),
        messageCount: messages.length,
        agentCount: agents.length,
        branchCount: [branchA, branchB].filter(Boolean).length,
      },
      win.__swarmGetSceneAutomation?.() ?? null,
      {
        route: window.location.pathname,
        kind: 'compare',
        loading,
        error: buildAutomationErrorState(null, errorLabel),
        controls: {
          compare_mode: true,
          active_compare_pane: activePane,
          can_activate_pane_a: activePane !== 'a',
          can_activate_pane_b: activePane !== 'b',
          can_replay: Boolean(data),
          can_skip: Boolean(data),
          replay_speed: replaySpeed,
          playback_mode: playbackMode,
        },
        compare: {
          branch_a: branchA,
          branch_b: branchB,
          active_branch_id: activeBranchId,
          active_compare_pane: activePane,
          selected_round: selectedRound,
          available_rounds: availableRounds,
          snapshot_ready: {
            a: Boolean(snapshots.a),
            b: Boolean(snapshots.b),
          },
          divergence_score: activeDiff?.divergence_score ?? null,
        },
      },
    );

    return () => {
      if (win.render_game_to_text) delete win.render_game_to_text;
      if (win.capture_game_screenshot === capture) delete win.capture_game_screenshot;
    };
  }, [activeBranchId, activeDiff?.divergence_score, activePane, agents.length, availableRounds, branchA, branchB, data, error, errorLabel, hasScenario, loading, messages.length, playbackMode, replaySpeed, scenarioQuestion, selectedRound, snapshots.a, snapshots.b]);

  if (capLoading) {
    return <div className="compare-digest-view compare-digest-view--empty">{t('common.loading', 'Loading...')}</div>;
  }

  if (capabilityError) {
    return (
      <div className="compare-digest-view compare-digest-view--empty">
        <h1>{t('compare.title', 'Counterfactual Compare')}</h1>
        <p role="alert">{t('compare.error_fetch', 'Unable to load comparison data right now. Please retry.')}</p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
          <button type="button" className="btn btn-ghost" onClick={() => void reloadCapability?.()}>
            {t('common.retry', 'Retry')}
          </button>
          <Link to={resultHref}>{t('common.back_to_result', 'Back to Result')}</Link>
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="compare-digest-view compare-digest-view--empty">
        <p>{t('compare.feature_disabled', 'Counterfactual replay feature is not enabled.')}</p>
        <Link to={resultHref}>{t('common.back_to_result', 'Back to Result')}</Link>
      </div>
    );
  }

  if (loading) {
    return <div className="compare-digest-view compare-digest-view--empty">{t('common.loading', 'Loading...')}</div>;
  }

  if (error) {
    return (
      <div className="compare-digest-view compare-digest-view--empty">
        <h1>{t('compare.title', 'Counterfactual Compare')}</h1>
        <p role="alert" className="compare-digest-view__error">{errorLabel}</p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
          {error.kind === 'load_failed' ? (
            <button type="button" className="btn btn-ghost" onClick={() => void loadCompare()}>
              {t('common.retry', 'Retry')}
            </button>
          ) : null}
          <Link to={resultHref}>{t('common.back_to_result', 'Back to Result')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="compare-digest-view">
      <header className="compare-digest-view__header">
        <div>
          <Link to={resultHref} className="compare-digest-view__back">
            ← {t('common.back_to_result', 'Back to Result')}
          </Link>
          <h1>{t('compare.title', 'Counterfactual Compare')}</h1>
          <p>{scenarioQuestion}</p>
        </div>
        <div className="compare-digest-view__controls">
          <button type="button" className="btn btn-ghost" onClick={handleReplay}>
            {t('game.replay_btn', 'Replay')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleSkip}>
            {t('game.skip_btn', 'Skip')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={cycleReplaySpeed}>
            {replaySpeed}x
          </button>
        </div>
      </header>

      <div className="compare-digest-view__branch-switch" role="tablist" aria-label={t('compare.title', 'Counterfactual Compare')}>
        <button
          type="button"
          className={`compare-digest-view__branch-tab ${activePane === 'a' ? 'is-active' : ''}`}
          onClick={() => void activatePane('a')}
        >
          {branchPanels.a.title}
        </button>
        <button
          type="button"
          className={`compare-digest-view__branch-tab ${activePane === 'b' ? 'is-active' : ''}`}
          onClick={() => void activatePane('b')}
        >
          {branchPanels.b.title}
        </button>
      </div>

      <section
        className="compare-digest-view__stage-note"
        aria-label={isZh ? '对照上下文' : 'Comparison context'}
      >
        <div className="compare-digest-view__stage-pills">
          <span className="compare-digest-view__stage-pill">{selectedRoundLabel}</span>
          {activeDivergencePct != null && (
            <span className="compare-digest-view__stage-pill">
              {t('compare.divergence_label', 'Divergence')}: {activeDivergencePct}%
            </span>
          )}
          <span className="compare-digest-view__stage-pill">
            {isZh ? '双舞台对照' : 'Dual-stage compare'}
          </span>
        </div>
        <p>
          {isZh
            ? '当前舞台继续播放实况，另一侧保留同回合镜像线索，方便横向比对。'
            : 'The active stage keeps playing live while the other pane holds same-round context for side-by-side reading.'}
        </p>
      </section>

      <section className="compare-theater">
        {(['a', 'b'] as const).map((pane) => {
          const panel = branchPanels[pane];
          const isActive = activePane === pane;
          const divergencePct = Math.round((activeDiff?.divergence_score ?? 0) * 100);
          const mirrorStateLabel = snapshots[pane]
            ? (isZh ? '已捕获镜像' : 'Captured mirror')
            : (isZh ? '待机镜像' : 'Standby mirror');
          const probabilityLabel = panel.probability != null
            ? `${Math.round(panel.probability * 100)}% ${isZh ? '路径权重' : 'path weight'}`
            : (isZh ? '分支概览' : 'Branch overview');
          return (
            <article
              key={pane}
              className={`compare-theater-pane ${isActive ? 'is-active' : 'is-inactive'}`}
              data-testid={`compare-pane-${pane}`}
            >
              <header className="compare-theater-pane__header">
                <div>
                  <div className="compare-theater-pane__eyebrow">
                    <span className={`compare-theater-pane__status ${isActive ? 'is-live' : 'is-passive'}`}>
                      {isActive ? (isZh ? '实况舞台' : 'Live stage') : mirrorStateLabel}
                    </span>
                    <span>{selectedRoundLabel}</span>
                  </div>
                  <strong>{panel.title}</strong>
                  {panel.probability != null && (
                    <span>{probabilityLabel}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="compare-theater-pane__focus"
                  onClick={() => void activatePane(pane)}
                  disabled={isActive}
                >
                  {isActive
                    ? (isZh ? '当前舞台' : 'Live stage')
                    : (isZh ? '切到此线' : 'Activate')}
                </button>
              </header>

              <div className="compare-theater-pane__surface">
                {isActive ? (
                  <div className="compare-theater-pane__live">
                    <PhaserGameLoader
                      key={`${activeBranchId}-${selectedRound ?? 'latest'}-${theaterMountKey}-${playbackMode}`}
                      replaySpeed={replaySpeed}
                      playbackMode={playbackMode}
                      playbackBranchId={activeBranchId}
                      playbackRound={selectedRound}
                    />
                  </div>
                ) : snapshots[pane] ? (
                  <img
                    className="compare-theater-pane__snapshot"
                    src={snapshots[pane] ?? undefined}
                    alt={`${panel.title} ${mirrorStateLabel}`}
                  />
                ) : (
                  <div
                    className="compare-theater-pane__placeholder"
                    data-testid={`compare-pane-${pane}-standby`}
                  >
                    <div className="compare-theater-pane__placeholder-copy">
                      <span className="compare-theater-pane__placeholder-kicker">
                        {mirrorStateLabel}
                      </span>
                      <strong>
                        {isZh
                          ? '先保留这条分支的上下文，切换后再抓取实况画面。'
                          : 'Keep this branch readable first, then capture a live frame after activation.'}
                      </strong>
                      <span>
                        {isZh
                          ? '首屏先展示回合、分歧和分支权重，让双舞台对照保持完整。'
                          : 'Round, divergence, and branch weight stay visible so the two-stage compare feels complete from the first frame.'}
                      </span>
                    </div>
                    <div className="compare-theater-pane__placeholder-grid" aria-hidden="true">
                      <div className="compare-theater-pane__placeholder-card is-primary">
                        <span>{selectedRoundLabel}</span>
                        <strong>
                          {activeDiff
                            ? `${t('compare.divergence_label', 'Divergence')}: ${divergencePct}%`
                            : mirrorStateLabel}
                        </strong>
                      </div>
                      <div className="compare-theater-pane__placeholder-card">
                        <span>{panel.title}</span>
                        <strong>{probabilityLabel}</strong>
                      </div>
                      <div className="compare-theater-pane__placeholder-card is-wide">
                        <span>{isZh ? '切换后可用' : 'Available after activation'}</span>
                        <strong>
                          {isZh
                            ? '激活一次后，这里会保留该分支的舞台镜像。'
                            : 'After one activation, this pane keeps a mirrored stage snapshot for the branch.'}
                        </strong>
                      </div>
                    </div>
                  </div>
                )}
                {!isActive && (
                  <div className="compare-theater-pane__veil">
                    <span>{mirrorStateLabel}</span>
                    <strong>{selectedRoundLabel}</strong>
                  </div>
                )}
              </div>

              <div className="compare-theater-pane__summary">
                <p>{panel.summary || t('compare.no_data', 'No comparison data available.')}</p>
                {activeDiff && (
                  <span className="compare-theater-pane__divergence">
                    {t('compare.divergence_label', 'Divergence')}: {divergencePct}%
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </section>

      <section className="compare-digest-view__timeline">
        <TimelineBar
          interactive
          compact
          selectedRound={selectedRound}
          roundMarkers={roundMarkers}
          onRoundSelect={handleRoundSelect}
        />
      </section>

      <section className="compare-digest-view__rounds">
        {data?.rounds.length ? data.rounds.map((round) => {
          const divergencePct = Math.round(round.divergence_score * 100);
          return (
            <article key={round.round} className={`compare-round-card ${selectedRound === round.round ? 'is-selected' : ''}`}>
              <div className="compare-round-card__header">
                <div>
                  <strong>{formatRoundLabel(round.round, isZh)}</strong>
                  <span>{t('compare.divergence_label', 'Divergence')}: {divergencePct}%</span>
                </div>
                <button type="button" className="btn btn-ghost" onClick={() => handleRoundSelect(round.round)}>
                  {isZh ? '播放这一轮' : 'Play this round'}
                </button>
              </div>
              <div className="compare-round-card__grid">
                <section>
                  <span>{t('compare.branch_a_label', 'Branch A (Original)')}</span>
                  <p>{round.branch_a_summary || '—'}</p>
                </section>
                <section>
                  <span>{t('compare.branch_b_label', 'Branch B (Counterfactual)')}</span>
                  <p>{round.branch_b_summary || '—'}</p>
                </section>
              </div>
            </article>
          );
        }) : (
          <p className="compare-digest-view__empty-copy">{t('compare.no_data', 'No comparison data available.')}</p>
        )}
      </section>
    </div>
  );
}

export default CompareDigestView;
