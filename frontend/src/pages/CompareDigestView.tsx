import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildSessionHeaders, getScenario } from '../api/client';
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

function formatRoundLabel(round: number, isZh: boolean) {
  return isZh ? `第 ${round} 轮` : `Round ${round}`;
}

export function CompareDigestView() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const { loading: capLoading, enabled } = useCapabilityCheck('counterfactual_replay');
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const branchA = searchParams.get('branch_a') ?? '';
  const branchB = searchParams.get('branch_b') ?? '';
  const missingParamsLabel = isZh ? '缺少分支参数' : 'Missing branch parameters';

  const setScenario = useSimulationStore((state) => state.setScenario);
  const resetSimulation = useSimulationStore((state) => state.reset);
  const storeScenario = useSimulationStore((state) => state.scenario);
  const branches = useSimulationStore((state) => state.branches);
  const messages = useSimulationStore((state) => state.messages);
  const agents = useSimulationStore((state) => state.agents);

  const [data, setData] = useState<CompareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const availableRounds = useMemo(
    () => data?.rounds.map((entry) => entry.round) ?? [],
    [data],
  );
  const scenarioQuestion = storeScenario?.question ?? null;
  const hasScenario = Boolean(storeScenario);

  useEffect(() => {
    if (!enabled) return;
    if (!id || !branchA || !branchB) {
      setLoading(false);
      setError(missingParamsLabel);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [scenarioPayload, comparePayload] = await Promise.all([
          getScenario(id),
          fetch(`/api/scenario/${id}/compare?branch_a=${branchA}&branch_b=${branchB}`, {
            headers: buildSessionHeaders(),
          }).then(async (response) => {
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            return response.json() as Promise<CompareData>;
          }),
        ]);

        if (cancelled) return;
        setScenario(scenarioPayload);
        setData(comparePayload);
        setSelectedRound(comparePayload.rounds[0]?.round ?? 1);
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      resetSimulation();
    };
  }, [branchA, branchB, enabled, id, missingParamsLabel, resetSimulation, setScenario]);

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
        totalRounds: availableRounds.at(-1) ?? null,
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
        error: buildAutomationErrorState(null, error),
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
  }, [activeBranchId, activeDiff?.divergence_score, activePane, agents.length, availableRounds, branchA, branchB, data, error, hasScenario, loading, messages.length, playbackMode, replaySpeed, scenarioQuestion, selectedRound, snapshots.a, snapshots.b]);

  if (capLoading) {
    return <div className="compare-digest-view compare-digest-view--empty">{t('common.loading', 'Loading...')}</div>;
  }

  if (!enabled) {
    return (
      <div className="compare-digest-view compare-digest-view--empty">
        <p>{t('compare.feature_disabled', 'Counterfactual replay feature is not enabled.')}</p>
        <Link to={id ? `/result/${id}` : '/'}>{t('common.back_to_result', 'Back to Result')}</Link>
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
        <p role="alert" className="compare-digest-view__error">{error}</p>
        <Link to={`/result/${id}`}>{t('common.back_to_result', 'Back to Result')}</Link>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="compare-digest-view">
      <header className="compare-digest-view__header">
        <div>
          <Link to={`/result/${id}`} className="compare-digest-view__back">
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

      <section className="compare-theater">
        {(['a', 'b'] as const).map((pane) => {
          const panel = branchPanels[pane];
          const isActive = activePane === pane;
          const divergencePct = Math.round((activeDiff?.divergence_score ?? 0) * 100);
          return (
            <article
              key={pane}
              className={`compare-theater-pane ${isActive ? 'is-active' : 'is-inactive'}`}
              data-testid={`compare-pane-${pane}`}
            >
              <header className="compare-theater-pane__header">
                <div>
                  <strong>{panel.title}</strong>
                  {panel.probability != null && (
                    <span>{Math.round(panel.probability * 100)}%</span>
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
                    alt={panel.title}
                  />
                ) : (
                  <div className="compare-theater-pane__placeholder">
                    <strong>{isZh ? '等待快照' : 'Snapshot pending'}</strong>
                    <span>{isZh ? '切换过去后会记录当前舞台。' : 'Switch here once to capture this pane.'}</span>
                  </div>
                )}
                {!isActive && (
                  <div className="compare-theater-pane__veil">
                    <span>{isZh ? '静态镜像' : 'Static mirror'}</span>
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
