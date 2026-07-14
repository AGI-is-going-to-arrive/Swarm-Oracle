import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  getCounterfactualCompare,
  getScenario,
  isApiError,
  resimulateCounterfactual,
} from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useSimulationStore } from '../stores/simulationStore';
import { PhaserGameLoader } from '../game';
import { TimelineBar } from '../components/TimelineBar';
import { buildAutomationErrorState } from '../lib/apiErrorMessage';
import { captureCompositeElementDataUrl, captureElementDataUrl } from '../hooks/useScreenCapture';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import { diffChars } from '../lib/textDiff';
import './CompareDigestView.css';

interface MessageEntry {
  agent_id: string;
  agent_name: string;
  content: string;
  emotion: string;
}

interface RoundDiff {
  round: number;
  branch_a_summary: string;
  branch_b_summary: string;
  branch_a_messages: MessageEntry[];
  branch_b_messages: MessageEntry[];
  divergence_score: number;
  is_identical: boolean;
}

function DiffHighlight({ oldText, newText, side }: { oldText: string; newText: string; side: 'a' | 'b' }) {
  const segments = useMemo(() => diffChars(oldText, newText), [oldText, newText]);
  return (
    <span>
      {segments.map((seg, i) => {
        if (seg.type === 'equal') return <span key={i}>{seg.text}</span>;
        if (seg.type === 'delete' && side === 'a') return <del key={i} className="compare-diff-del">{seg.text}</del>;
        if (seg.type === 'insert' && side === 'b') return <ins key={i} className="compare-diff-ins">{seg.text}</ins>;
        return null;
      })}
    </span>
  );
}

interface CounterfactualInterventionInfo {
  replay_kind?: 'counterfactual';
  round: number;
  agent_id: string;
  agent_name: string;
  original_content: string | null;
  replacement_content: string | null;
}

interface RetrospectiveInterventionInfo {
  replay_kind: 'retrospective';
  source_branch_id: string;
  source_round: number;
  intervention_text: string | null;
}

type InterventionInfo = CounterfactualInterventionInfo | RetrospectiveInterventionInfo;

function isRetrospectiveIntervention(
  intervention: InterventionInfo | null,
): intervention is RetrospectiveInterventionInfo {
  return intervention?.replay_kind === 'retrospective';
}

function getInterventionRound(intervention: InterventionInfo | null): number | null {
  if (!intervention) return null;
  return isRetrospectiveIntervention(intervention)
    ? intervention.source_round
    : intervention.round;
}

interface CompareData {
  scenario_id: string;
  branch_a: string;
  branch_b: string;
  common_rounds: number;
  intervention: InterventionInfo | null;
  rounds: RoundDiff[];
}

type ComparePane = 'a' | 'b';

type CompareErrorState =
  | { kind: 'missing_params' }
  | { kind: 'no_data'; status: number | null }
  | { kind: 'load_failed'; source: 'compare' | 'scenario' | 'capability'; status: number | null };

export function CompareDigestView() {
  const { t } = useTranslation();
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
  const [resimulating, setResimulating] = useState(false);
  const [resimulateError, setResimulateError] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRequestIdRef = useRef(0);
  const resimulateRefreshTimerRef = useRef<number | null>(null);
  const resimulateEpochRef = useRef(0);
  const tabARef = useRef<HTMLButtonElement>(null);
  const tabBRef = useRef<HTMLButtonElement>(null);

  const toggleMessage = useCallback((key: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const divergentRounds = useMemo(
    () => data?.rounds.filter((entry) => !entry.is_identical) ?? [],
    [data],
  );
  const availableRounds = useMemo(
    () => divergentRounds.map((entry) => entry.round),
    [divergentRounds],
  );
  const hasDivergentRounds = availableRounds.length > 0;
  const scenarioQuestion = storeScenario?.question ?? null;
  const hasScenario = Boolean(storeScenario);
  const intervention = data?.intervention ?? null;
  const interventionRound = getInterventionRound(intervention);
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
      setSelectedRound(
        getInterventionRound(comparePayload.intervention)
        ?? comparePayload.rounds.find((r) => !r.is_identical)?.round
        ?? comparePayload.rounds[0]?.round
        ?? 1,
      );
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

  const isStale = useMemo(() => {
    if (!data || !branches.length) return false;
    const cfBranch = branches.find((b) => b.id === branchB && b.replay_kind === 'counterfactual');
    return Boolean(cfBranch && (!cfBranch.story || cfBranch.story.length === 0) && data.rounds.length <= 1);
  }, [data, branches, branchB]);

  const handleResimulate = useCallback(async () => {
    if (!id || !branchB || resimulating) return;
    const resimulateEpoch = resimulateEpochRef.current + 1;
    resimulateEpochRef.current = resimulateEpoch;
    if (resimulateRefreshTimerRef.current !== null) {
      window.clearTimeout(resimulateRefreshTimerRef.current);
      resimulateRefreshTimerRef.current = null;
    }
    setResimulating(true);
    setResimulateError(false);
    try {
      await resimulateCounterfactual(id, branchB);
      if (resimulateEpoch !== resimulateEpochRef.current) return;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise<void>((resolve) => {
          resimulateRefreshTimerRef.current = window.setTimeout(() => {
            resimulateRefreshTimerRef.current = null;
            resolve();
          }, 2000);
        });
        if (resimulateEpoch !== resimulateEpochRef.current) return;
        try {
          const scenarioPayload = await getScenario(id);
          if (resimulateEpoch !== resimulateEpochRef.current) return;
          setScenario(scenarioPayload);
          if (scenarioPayload.status === 'done') {
            await loadCompare();
            return;
          }
          if (scenarioPayload.status === 'error' || scenarioPayload.status === 'cancelled') {
            setResimulateError(true);
            return;
          }
        } catch {
          // A transient read failure should not permit a duplicate resimulation.
        }
      }
      if (resimulateEpoch === resimulateEpochRef.current) setResimulateError(true);
    } catch {
      if (resimulateEpoch !== resimulateEpochRef.current) return;
      setResimulateError(true);
    } finally {
      if (resimulateEpoch === resimulateEpochRef.current) {
        setResimulating(false);
      }
    }
  }, [id, branchB, resimulating, loadCompare, setScenario]);

  useEffect(() => () => {
    resimulateEpochRef.current += 1;
    if (resimulateRefreshTimerRef.current !== null) {
      window.clearTimeout(resimulateRefreshTimerRef.current);
      resimulateRefreshTimerRef.current = null;
    }
  }, [id, branchB]);

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
    ? t('compare.round', { round: selectedRound })
    : t('compare.latest_round');
  const activeDivergencePct = activeDiff
    ? Math.round(activeDiff.divergence_score * 100)
    : null;

  const branchPanels = useMemo(() => ({
    a: {
      id: branchA,
      title: branchById.get(branchA)?.title ?? t('compare.branch_a_label', 'Branch A (Original)'),
      probability: branchById.get(branchA)?.probability ?? null,
    },
    b: {
      id: branchB,
      title: branchById.get(branchB)?.title ?? t('compare.branch_b_label', 'Branch B (Counterfactual)'),
      probability: branchById.get(branchB)?.probability ?? null,
    },
  }), [branchA, branchB, branchById, t]);

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

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, targetPane: 'a' | 'b') => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const nextPane = targetPane === 'a' ? 'b' : 'a';
      void activatePane(nextPane);
      setTimeout(() => {
        if (nextPane === 'a') {
          tabARef.current?.focus();
        } else {
          tabBRef.current?.focus();
        }
      }, 0);
    }
  };

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
          intervention: data?.intervention ?? null,
          common_rounds: data?.common_rounds ?? 0,
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
        <h1>{t('compare.title', 'Compare branches')}</h1>
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
        <h1>{t('compare.title', 'Compare branches')}</h1>
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
          <h1>{t('compare.title', 'Compare branches')}</h1>
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

      {isStale && (
        <div className="compare-digest-view__stale-banner" role="alert">
          <p>{t('compare.stale_notice', 'This counterfactual branch has not been simulated yet. Results only show the intervention round.')}</p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleResimulate}
            disabled={resimulating}
          >
            {resimulating
              ? t('compare.resimulating', 'Simulating...')
              : t('compare.resimulate', 'Simulate Remaining Rounds')}
          </button>
          {resimulateError && (
            <p>{t('compare.error_fetch', 'Unable to load comparison data right now. Please retry.')}</p>
          )}
        </div>
      )}

      <div className="compare-digest-view__branch-switch" role="tablist" aria-label={t('compare.title', 'Compare branches')}>
        <button
          ref={tabARef}
          type="button"
          id="tab-branch-a"
          role="tab"
          aria-selected={activePane === 'a'}
          aria-controls="panel-branch-a"
          tabIndex={activePane === 'a' ? 0 : -1}
          className={`compare-digest-view__branch-tab ${activePane === 'a' ? 'is-active' : ''}`}
          onClick={() => void activatePane('a')}
          onKeyDown={(e) => handleTabKeyDown(e, 'a')}
        >
          {branchPanels.a.title}
        </button>
        <button
          ref={tabBRef}
          type="button"
          id="tab-branch-b"
          role="tab"
          aria-selected={activePane === 'b'}
          aria-controls="panel-branch-b"
          tabIndex={activePane === 'b' ? 0 : -1}
          className={`compare-digest-view__branch-tab ${activePane === 'b' ? 'is-active' : ''}`}
          onClick={() => void activatePane('b')}
          onKeyDown={(e) => handleTabKeyDown(e, 'b')}
        >
          {branchPanels.b.title}
        </button>
      </div>

      <section
        className="compare-digest-view__stage-note"
        aria-label={t('compare.context_aria')}
      >
        <div className="compare-digest-view__stage-pills">
          <span className="compare-digest-view__stage-pill">{selectedRoundLabel}</span>
          {activeDivergencePct != null && (
            <span className="compare-digest-view__stage-pill">
              {t('compare.divergence_label', 'Divergence')}: {activeDivergencePct}%
            </span>
          )}
          <span className="compare-digest-view__stage-pill">
            {t('compare.dual_stage_pill')}
          </span>
        </div>
        <p>
          {t('compare.stage_intro')}
        </p>
      </section>

      {intervention && (
        <section
          className="compare-digest-view__intervention"
          role="note"
          aria-labelledby="compare-intervention-title"
        >
          <div className="compare-digest-view__intervention-header">
            <strong id="compare-intervention-title">
              {isRetrospectiveIntervention(intervention)
                ? t('compare.intervention_retrospective_title', 'Retrospective Intervention')
                : t('compare.intervention_title', 'What Changed')}
            </strong>
            <span className="compare-digest-view__intervention-round">
              {t('compare.round', { round: interventionRound ?? 0 })}
            </span>
          </div>
          <div className="compare-digest-view__intervention-body">
            {isRetrospectiveIntervention(intervention) ? (
              <>
                <div className="compare-digest-view__intervention-agent">
                  <span>
                    {t('compare.intervention_retrospective_source', {
                      branch: branchById.get(intervention.source_branch_id)?.title ?? intervention.source_branch_id,
                      defaultValue: 'Source branch: {{branch}}',
                    })}
                  </span>
                </div>
                <div className="compare-digest-view__intervention-diff">
                  <div className="compare-digest-view__intervention-original">
                    <span>{t('compare.intervention_retrospective_boundary', 'Replay boundary')}</span>
                    <p>{t('compare.round', { round: intervention.source_round })}</p>
                  </div>
                  <div className="compare-digest-view__intervention-replacement">
                    <span>{t('compare.intervention_retrospective_prompt', 'Injected prompt')}</span>
                    <p>{intervention.intervention_text || '—'}</p>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="compare-digest-view__intervention-agent">
                  <span>
                    {t('compare.intervention_agent_label', {
                      agent: intervention.agent_name,
                      defaultValue: 'Agent: {{agent}}',
                    })}
                  </span>
                </div>
                <div className="compare-digest-view__intervention-diff">
                  <div className="compare-digest-view__intervention-original">
                    <span>{t('compare.intervention_original', 'Original')}</span>
                    <p>{intervention.original_content || '—'}</p>
                  </div>
                  <div className="compare-digest-view__intervention-replacement">
                    <span>{t('compare.intervention_replacement', 'Replacement')}</span>
                    <p>{intervention.replacement_content || '—'}</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <section className="compare-theater">
        {(['a', 'b'] as const).map((pane) => {
          const panel = branchPanels[pane];
          const isActive = activePane === pane;
          const divergencePct = Math.round((activeDiff?.divergence_score ?? 0) * 100);
          const mirrorStateLabel = snapshots[pane]
            ? t('compare.captured_mirror')
            : t('compare.standby_mirror');
          const probabilityLabel = panel.probability != null
            ? `${Math.round(panel.probability * 100)}% ${t('compare.path_weight_suffix')}`
            : t('compare.branch_overview');
          return (
            <article
              key={pane}
              id={`panel-branch-${pane}`}
              role="tabpanel"
              aria-labelledby={`tab-branch-${pane}`}
              className={`compare-theater-pane ${isActive ? 'is-active' : 'is-inactive'}`}
              data-testid={`compare-pane-${pane}`}
            >
              <header className="compare-theater-pane__header">
                <div>
                  <div className="compare-theater-pane__eyebrow">
                    <span className={`compare-theater-pane__status ${isActive ? 'is-live' : 'is-passive'}`}>
                      {isActive ? t('compare.live_stage') : mirrorStateLabel}
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
                    ? t('compare.current_stage')
                    : t('compare.activate_pane')}
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
                        {t('compare.placeholder_primary')}
                      </strong>
                      <span>
                        {t('compare.placeholder_detail')}
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
                        <span>{t('compare.after_activation_label')}</span>
                        <strong>
                          {t('compare.after_activation_detail')}
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
        {hasDivergentRounds ? (
          <TimelineBar
            interactive
            compact
            selectedRound={selectedRound}
            roundMarkers={roundMarkers}
            onRoundSelect={handleRoundSelect}
          />
        ) : (
          <p className="compare-digest-view__timeline-empty">
            {t('compare.no_different_rounds', 'No divergent rounds to replay.')}
          </p>
        )}
      </section>

      <section className="compare-digest-view__rounds">
        {data?.rounds.length ? (
          <>
            {data.common_rounds > 0 && (
              <div className="compare-round-card compare-round-card--collapsed">
                <div className="compare-round-card__header">
                  <div>
                    <strong>
                      {t('compare.identical_rounds', {
                        count: data.common_rounds,
                        defaultValue: '{{count}} identical rounds before divergence',
                      })}
                    </strong>
                    <span>{t('compare.divergence_label', 'Divergence')}: 0%</span>
                  </div>
                </div>
              </div>
            )}
            {divergentRounds.length ? (
              divergentRounds.map((round) => {
                const divergencePct = Math.round(round.divergence_score * 100);
                const isIntervention = interventionRound === round.round;
                const aHasData = (round.branch_a_messages?.length ?? 0) > 0;
                const bHasData = (round.branch_b_messages?.length ?? 0) > 0;
                const oneSideEmpty = (aHasData && !bHasData) || (!aHasData && bHasData);
                const activeSide: 'a' | 'b' = aHasData ? 'a' : 'b';
                const activeSideLabel = aHasData
                  ? branchPanels.a.title
                  : branchPanels.b.title;
                const soloMessages = activeSide === 'a' ? round.branch_a_messages : round.branch_b_messages;
                const soloRoundKey = `solo-${round.round}`;
                const allSoloExpanded = oneSideEmpty && expandedMessages.has(soloRoundKey);
                return (
                  <article
                    key={round.round}
                    className={`compare-round-card ${selectedRound === round.round ? 'is-selected' : ''} ${isIntervention ? 'is-intervention' : ''}`}
                  >
                    <div className="compare-round-card__header">
                      <div>
                        <strong>{t('compare.round', { round: round.round })}</strong>
                        <span>{t('compare.divergence_label', 'Divergence')}: {divergencePct}%</span>
                        {isIntervention && (
                          <span className="compare-round-card__intervention-badge">
                            {t('compare.intervention_badge', 'Intervention Point')}
                          </span>
                        )}
                      </div>
                      <button type="button" className="btn btn-ghost" onClick={() => handleRoundSelect(round.round)}>
                        {t('compare.play_round')}
                      </button>
                    </div>
                    {oneSideEmpty ? (
                      <div className="compare-round-card__solo">
                        <div className="compare-round-card__solo-banner">
                          <span>{t('compare.solo_branch_notice', {
                            branch: activeSideLabel,
                            defaultValue: 'Only {{branch}} has data for this round. The other branch ended before this point.',
                          })}</span>
                        </div>
                        <div className="compare-round-card__solo-messages">
                          {soloMessages?.map((msg, idx) => {
                            const msgKey = `${round.round}-${activeSide}-${idx}`;
                            const isExpanded = allSoloExpanded || expandedMessages.has(msgKey);
                            const needsCollapse = msg.content.length > 120;
                            return (
                              <div key={idx} className="compare-message">
                                <div
                                  className="compare-message__header"
                                  onClick={() => needsCollapse && toggleMessage(msgKey)}
                                  style={needsCollapse ? { cursor: 'pointer' } : undefined}
                                >
                                  <strong className="compare-message__agent">{msg.agent_name}</strong>
                                  <span className="compare-message__emotion">{msg.emotion}</span>
                                  {needsCollapse && (
                                    <span className="compare-message__toggle">{isExpanded ? '▾' : '▸'}</span>
                                  )}
                                </div>
                                <div className={`compare-message__content ${!isExpanded && needsCollapse ? 'compare-message__content--collapsed' : ''}`}>
                                  {isExpanded || !needsCollapse ? (
                                    <p>{msg.content}</p>
                                  ) : (
                                    <p>{Array.from(msg.content).slice(0, 120).join('') + '…'}</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {(soloMessages?.length ?? 0) > 1 && (
                          <button
                            type="button"
                            className="btn btn-ghost compare-round-card__expand-all"
                            onClick={() => toggleMessage(soloRoundKey)}
                          >
                            {allSoloExpanded
                              ? t('compare.collapse_all', 'Collapse All')
                              : t('compare.expand_all', 'Expand All')}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="compare-round-card__grid">
                        <section>
                          <span>{t('compare.branch_a_label', 'Branch A (Original)')}</span>
                          <div className="compare-round-card__messages">
                            {round.branch_a_messages?.map((msg, idx) => {
                              const matchingMsg = round.branch_b_messages?.[idx];
                              const hasChange = Boolean(matchingMsg && msg.content !== matchingMsg.content);
                              const msgKey = `${round.round}-a-${idx}`;
                              const isExpanded = expandedMessages.has(msgKey);
                              const needsCollapse = !hasChange && msg.content.length > 80;
                              return (
                                <div key={idx} className={`compare-message ${hasChange ? 'compare-message--changed' : ''}`}>
                                  <div
                                    className="compare-message__header"
                                    onClick={() => needsCollapse && toggleMessage(msgKey)}
                                    style={needsCollapse ? { cursor: 'pointer' } : undefined}
                                  >
                                    <strong className="compare-message__agent">{msg.agent_name}</strong>
                                    <span className="compare-message__emotion">{msg.emotion}</span>
                                    {needsCollapse && (
                                      <span className="compare-message__toggle">{isExpanded ? '▾' : '▸'}</span>
                                    )}
                                  </div>
                                  <div className={`compare-message__content ${!isExpanded && needsCollapse ? 'compare-message__content--collapsed' : ''}`}>
                                    {hasChange && matchingMsg ? (
                                      <DiffHighlight oldText={msg.content} newText={matchingMsg.content} side="a" />
                                    ) : isExpanded || !needsCollapse ? (
                                      <p>{msg.content}</p>
                                    ) : (
                                      <p>{Array.from(msg.content).slice(0, 80).join('') + '…'}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </section>
                        <section>
                          <span>{t('compare.branch_b_label', 'Branch B (Counterfactual)')}</span>
                          <div className="compare-round-card__messages">
                            {round.branch_b_messages?.map((msg, idx) => {
                              const matchingMsg = round.branch_a_messages?.[idx];
                              const hasChange = Boolean(matchingMsg && msg.content !== matchingMsg.content);
                              const msgKey = `${round.round}-b-${idx}`;
                              const isExpanded = expandedMessages.has(msgKey);
                              const needsCollapse = !hasChange && msg.content.length > 80;
                              return (
                                <div key={idx} className={`compare-message ${hasChange ? 'compare-message--changed' : ''}`}>
                                  <div
                                    className="compare-message__header"
                                    onClick={() => needsCollapse && toggleMessage(msgKey)}
                                    style={needsCollapse ? { cursor: 'pointer' } : undefined}
                                  >
                                    <strong className="compare-message__agent">{msg.agent_name}</strong>
                                    <span className="compare-message__emotion">{msg.emotion}</span>
                                    {needsCollapse && (
                                      <span className="compare-message__toggle">{isExpanded ? '▾' : '▸'}</span>
                                    )}
                                  </div>
                                  <div className={`compare-message__content ${!isExpanded && needsCollapse ? 'compare-message__content--collapsed' : ''}`}>
                                    {hasChange && matchingMsg ? (
                                      <DiffHighlight oldText={matchingMsg.content} newText={msg.content} side="b" />
                                    ) : isExpanded || !needsCollapse ? (
                                      <p>{msg.content}</p>
                                    ) : (
                                      <p>{Array.from(msg.content).slice(0, 80).join('') + '…'}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </section>
                      </div>
                    )}
                  </article>
                );
              })
            ) : (
              <p className="compare-digest-view__empty-copy">
                {t('compare.no_different_rounds', 'No divergent rounds to replay.')}
              </p>
            )}
          </>
        ) : (
          <p className="compare-digest-view__empty-copy">{t('compare.no_data', 'No comparison data available.')}</p>
        )}
      </section>
    </div>
  );
}

export default CompareDigestView;
