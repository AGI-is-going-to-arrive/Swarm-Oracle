import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { predictDebate } from '../api/client';
import { DebateBetModal } from '../components/DebateBetModal';
import { DebateMomentumBar } from '../components/DebateMomentumBar';
import { DebateScoreCard } from '../components/DebateScoreCard';
import { DebateStageRibbon } from '../components/DebateStageRibbon';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import {
  resolveDebateCounterplayRecord,
  loadDebateCounterplay,
  saveDebateCounterplay,
  type DebateCounterplayRecord,
} from '../lib/debateCounterplay';
import {
  DEBATE_PHASE_ORDER,
  getDebateDimensionLabel,
  getDebatePhaseLabel,
  getDebateSideLabel,
} from '../lib/debateLabels';
import {
  buildDebatePhaseSummaries,
  getDebateScoreLeader,
  type DebateLeader,
} from '../lib/debateInsights';
import { DEBATE_UI_ASSETS, getThemeAssetPath, getTheaterThemeLabel } from '../lib/themeRegistry';
import {
  captureElementDataUrl,
  useScreenCapture,
} from '../hooks/useScreenCapture';
import { useDebateWS } from '../hooks/useDebateWS';
import { useDebateStore } from '../stores/debateStore';
import { getDirectorIdentity } from '../lib/directorIdentity';
import type { DebatePhase } from '../types';
import './DebateArena.css';

const REVEAL_INTERVAL_MS = 1400;

interface DebateRoomInsight {
  side: 'proposition' | 'opposition' | 'judge';
  role: string;
  statusLabel: string;
  note: string;
  sourceLabel: string | null;
  active: boolean;
}

function getLeaderLabel(
  t: ReturnType<typeof useTranslation>['t'],
  leader: DebateLeader,
): string {
  if (leader === 'balanced') return t('debate.phase_balance');
  return getDebateSideLabel(t, leader);
}

export function DebateArenaView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();

  const debate = useDebateStore((state) => state.debate);
  const status = useDebateStore((state) => state.status);
  const error = useDebateStore((state) => state.error);
  const loadDebate = useDebateStore((state) => state.loadDebate);

  const [revealCount, setRevealCount] = useState(0);
  const [selectedPhase, setSelectedPhase] = useState<string>('opening');
  const [showBetModal, setShowBetModal] = useState(false);
  const [betSubmitting, setBetSubmitting] = useState(false);
  const [betModalState, setBetModalState] = useState<Record<string, unknown> | null>(null);
  const [betNotice, setBetNotice] = useState('');
  const [captureNotice, setCaptureNotice] = useState('');
  const [autoReveal, setAutoReveal] = useState(true);
  const [phaseLocked, setPhaseLocked] = useState(false);
  const [phaseCue, setPhaseCue] = useState<{
    phase: string;
    speakerName: string | null;
    speakerSide: 'proposition' | 'opposition' | 'judge' | null;
    token: number;
  } | null>(null);
  const [betPreset, setBetPreset] = useState<{
    kind: 'winner' | 'verdict_tone';
    targetValue: string;
    confidence: number;
    strategyHint: string;
    phase: DebatePhase;
    variant: 'balanced' | 'reversal';
  } | null>(null);
  const [counterplayRecord, setCounterplayRecord] = useState<DebateCounterplayRecord | null>(null);
  const revealRef = useRef(0);
  const previousPhaseRef = useRef<string | null>(null);

  const { status: captureStatus, captureScreenshot } = useScreenCapture({
    selector: '.debate-shell',
  });

  useEffect(() => {
    if (!id) return;
    void loadDebate(id);
    setCounterplayRecord(resolveDebateCounterplayRecord({
      resultCounterplay: debate?.counterplay ?? null,
      localRecord: loadDebateCounterplay(id),
    }));
  }, [id, loadDebate]);

  useEffect(() => {
    if (!id) return;
    setCounterplayRecord(resolveDebateCounterplayRecord({
      resultCounterplay: debate?.counterplay ?? null,
      localRecord: loadDebateCounterplay(id),
    }));
  }, [debate?.counterplay, id]);

  useEffect(() => {
    if (!debate?.language) return;
    const targetLanguage = debate.language === 'zh' ? 'zh' : 'en';
    if (!i18n.language.startsWith(targetLanguage)) {
      void i18n.changeLanguage(targetLanguage);
    }
  }, [debate?.language, i18n]);

  useDebateWS(id, Boolean(id));

  useEffect(() => {
    if (!debate?.turns.length) return;
    if (revealCount === 0) {
      setRevealCount(1);
    }
  }, [debate?.turns.length, revealCount]);

  useEffect(() => {
    revealRef.current = revealCount;
  }, [revealCount]);

  useEffect(() => {
    if (!debate?.turns.length || !autoReveal) return undefined;
    if (revealCount >= debate.turns.length) return undefined;
    const timer = window.setTimeout(() => {
      setRevealCount((current) => Math.min((debate?.turns.length ?? current), current + 1));
    }, REVEAL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [autoReveal, debate?.turns.length, revealCount]);

  const visibleTurns = useMemo(
    () => debate?.turns.slice(0, revealCount) ?? [],
    [debate?.turns, revealCount],
  );
  const activeSpeakerSide = visibleTurns.at(-1)?.speaker_side ?? null;

  const unlockedPhases = useMemo(
    () => Array.from(new Set(visibleTurns.map((turn) => turn.phase))),
    [visibleTurns],
  );

  const currentPhase = visibleTurns.at(-1)?.phase ?? debate?.current_phase ?? 'opening';
  const stageTurns = useMemo(
    () => visibleTurns.filter((turn) => turn.phase === selectedPhase),
    [selectedPhase, visibleTurns],
  );
  const latestVisibleTurn = visibleTurns.at(-1) ?? null;
  const latestStageTurn = stageTurns.at(-1) ?? null;
  const phaseUnlockCount = unlockedPhases.length;
  const phaseSummaries = useMemo(
    () => buildDebatePhaseSummaries(visibleTurns, unlockedPhases),
    [unlockedPhases, visibleTurns],
  );
  const serverPhaseInsights = debate?.phase_insights ?? [];
  const serverPhaseInsightMap = useMemo(
    () => new Map(serverPhaseInsights.map((insight) => [insight.phase, insight])),
    [serverPhaseInsights],
  );
  const selectedPhaseSummary = useMemo(
    () => phaseSummaries.find((summary) => summary.phase === selectedPhase) ?? null,
    [phaseSummaries, selectedPhase],
  );
  const selectedServerInsight = serverPhaseInsightMap.get(selectedPhase as DebatePhase) ?? null;

  useEffect(() => {
    if (!phaseLocked) {
      setSelectedPhase(currentPhase);
    }
  }, [currentPhase, phaseLocked]);

  useEffect(() => {
    if (!debate) return;
    if (previousPhaseRef.current === null) {
      previousPhaseRef.current = currentPhase;
      return;
    }
    if (previousPhaseRef.current === currentPhase) return;
    previousPhaseRef.current = currentPhase;
    setPhaseCue({
      phase: currentPhase,
      speakerName: latestVisibleTurn?.speaker_name ?? null,
      speakerSide: latestVisibleTurn?.speaker_side ?? null,
      token: Date.now(),
    });
    const timer = window.setTimeout(() => setPhaseCue(null), 2200);
    return () => window.clearTimeout(timer);
  }, [currentPhase, debate, latestVisibleTurn]);

  const currentPhaseIndex = useMemo(
    () => ['opening', 'crossfire', 'rebuttal', 'closing', 'verdict'].indexOf(currentPhase),
    [currentPhase],
  );
  const nextPhase = useMemo(() => {
    const next = DEBATE_PHASE_ORDER[currentPhaseIndex + 1];
    return next ?? null;
  }, [currentPhaseIndex]);
  const canBetNow = Boolean(debate && !debate.result_ready && currentPhaseIndex < 3);

  const phaseScoreDelta = useMemo(
    () => stageTurns.reduce(
      (acc, turn) => ({
        proposition: acc.proposition + (turn.score_delta?.proposition ?? 0),
        opposition: acc.opposition + (turn.score_delta?.opposition ?? 0),
      }),
      { proposition: 0, opposition: 0 },
    ),
    [stageTurns],
  );
  const overallPressure = useMemo(
    () => getDebateScoreLeader(debate?.score.proposition ?? 0, debate?.score.opposition ?? 0),
    [debate?.score.opposition, debate?.score.proposition],
  );

  const watchedDimension = useMemo(() => {
    switch (selectedPhase) {
      case 'opening':
        return 'coherence';
      case 'crossfire':
        return 'evidence';
      case 'rebuttal':
        return 'adaptability';
      case 'closing':
      case 'verdict':
        return 'impact';
      default:
        return 'coherence';
    }
  }, [selectedPhase]);

  const clashCopy = useMemo(() => t(`debate.clash_${selectedPhase}`), [selectedPhase, t]);
  const phaseLeaderLabel = useMemo(() => {
    if (phaseScoreDelta.proposition === phaseScoreDelta.opposition) {
      return t('debate.phase_balance');
    }
    return phaseScoreDelta.proposition > phaseScoreDelta.opposition
      ? getDebateSideLabel(t, 'proposition')
      : getDebateSideLabel(t, 'opposition');
  }, [phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const phasePressureCopy = useMemo(() => {
    const swing = Math.abs(phaseScoreDelta.proposition - phaseScoreDelta.opposition);
    if (swing === 0) {
      return t('debate.pressure_even');
    }
    return t('debate.pressure_edge', { side: phaseLeaderLabel, value: swing });
  }, [phaseLeaderLabel, phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const betWindowLabel = canBetNow ? t('debate.bet_window_open') : t('debate.bet_window_locked');
  const counterplayPlan = useMemo(() => {
    if (!debate || !canBetNow) return null;

    const phaseSwing = Math.abs(phaseScoreDelta.proposition - phaseScoreDelta.opposition);
    if (phaseSwing === 0) {
      return {
        kind: 'verdict_tone' as const,
        targetValue: 'balance',
        confidence: 0.5,
        label: t('debate.counterplay_balanced_label'),
        summary: t('debate.counterplay_balanced_summary'),
        strategyHint: t('debate.counterplay_balanced_hint'),
        variant: 'balanced' as const,
      };
    }

    const trailingSide = phaseScoreDelta.proposition > phaseScoreDelta.opposition
      ? 'opposition'
      : 'proposition';
    const confidence = phaseSwing >= 8 ? 0.7 : phaseSwing >= 4 ? 0.6 : 0.5;

    return {
      kind: 'winner' as const,
      targetValue: trailingSide,
      confidence,
      label: t('debate.counterplay_reversal_label'),
      summary: t('debate.counterplay_reversal_summary', {
        side: getDebateSideLabel(t, trailingSide),
        value: phaseSwing,
      }),
      strategyHint: t('debate.counterplay_reversal_hint', {
        side: getDebateSideLabel(t, trailingSide),
        value: phaseSwing,
        confidence: Math.round(confidence * 100),
      }),
      variant: 'reversal' as const,
    };
  }, [canBetNow, debate, phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const feedFocusLabel = useMemo(() => {
    if (!latestVisibleTurn) return null;
    const sideLabel = getDebateSideLabel(t, latestVisibleTurn.speaker_side);
    if (isZh) {
      return `${latestVisibleTurn.speaker_name} 正在把话题推向 ${sideLabel}`;
    }
    return `${latestVisibleTurn.speaker_name} currently has the floor for ${sideLabel}`;
  }, [isZh, latestVisibleTurn, t]);
  const phaseCueCopy = useMemo(() => {
    if (!phaseCue) return null;
    const phaseLabel = getDebatePhaseLabel(t, phaseCue.phase);
    if (isZh) {
      return phaseCue.speakerName
        ? `${phaseLabel}阶段已解锁，${phaseCue.speakerName} 刚把局势往前推了一步。`
        : `${phaseLabel}阶段已解锁。`;
    }
    return phaseCue.speakerName
      ? `${phaseLabel} just unlocked and ${phaseCue.speakerName} pushed the room into a new beat.`
      : `${phaseLabel} just unlocked.`;
  }, [isZh, phaseCue, t]);
  const unlockProgressLabel = useMemo(() => {
    if (isZh) return `已解锁 ${phaseUnlockCount}/${DEBATE_PHASE_ORDER.length}`;
    return `${phaseUnlockCount}/${DEBATE_PHASE_ORDER.length} unlocked`;
  }, [isZh, phaseUnlockCount]);
  const stageStateLabel = useMemo(() => {
    if (!phaseLocked) return isZh ? '直播跟进' : 'Live sync';
    return isZh ? '阶段锁定回看' : 'Phase locked';
  }, [isZh, phaseLocked]);
  const overallLeaderLabel = useMemo(
    () => getLeaderLabel(t, overallPressure.leader),
    [overallPressure.leader, t],
  );
  const overallPressureCopy = useMemo(() => {
    if (overallPressure.leader === 'balanced') {
      return t('debate.overview_judge_even');
    }
    return t('debate.overview_judge_edge', {
      side: overallLeaderLabel,
      value: overallPressure.margin,
    });
  }, [overallLeaderLabel, overallPressure.leader, overallPressure.margin, t]);
  const overviewCards = useMemo(
    () => [
      {
        title: t('debate.overview_room_title'),
        value: stageStateLabel,
        detail: t('debate.overview_room_detail', {
          phase: getDebatePhaseLabel(t, selectedPhase),
          unlocked: phaseUnlockCount,
          total: DEBATE_PHASE_ORDER.length,
          count: visibleTurns.length,
        }),
      },
      {
        title: t('debate.overview_judge_title'),
        value: overallLeaderLabel,
        detail: t('debate.overview_judge_detail', {
          watch: getDebateDimensionLabel(t, watchedDimension),
          pressure: selectedServerInsight?.judge_focus ?? overallPressureCopy,
        }),
      },
      {
        title: t('debate.overview_window_title'),
        value: betWindowLabel,
        detail: counterplayRecord
          ? t('debate.overview_window_used_detail')
          : canBetNow
            ? t('debate.overview_window_open_detail', {
              next: nextPhase ? getDebatePhaseLabel(t, nextPhase) : getDebatePhaseLabel(t, currentPhase),
            })
            : t('debate.overview_window_locked_detail', {
              phase: getDebatePhaseLabel(t, currentPhase),
            }),
      },
    ],
    [
      betWindowLabel,
      canBetNow,
      counterplayRecord,
      currentPhase,
      nextPhase,
      overallLeaderLabel,
      overallPressureCopy,
      phaseUnlockCount,
      selectedServerInsight,
      selectedPhase,
      stageStateLabel,
      t,
      visibleTurns.length,
      watchedDimension,
    ],
  );
  const roomInsights = useMemo<DebateRoomInsight[]>(() => {
    return (debate?.participants ?? []).map((participant) => {
      const latestPhaseTurn = [...stageTurns].reverse().find((turn) => turn.speaker_side === participant.side);
      const latestTurn = latestPhaseTurn
        ?? [...visibleTurns].reverse().find((turn) => turn.speaker_side === participant.side)
        ?? null;

      let statusLabel = t('debate.room_state_waiting');
      let note = participant.side === 'judge'
        ? t('debate.room_quote_judge')
        : t('debate.room_quote_waiting');

      if (participant.side === 'judge' && debate?.result_ready) {
        statusLabel = t('debate.room_state_verdict_ready');
      } else if (latestTurn) {
        statusLabel = latestTurn.id === latestVisibleTurn?.id
          ? t('debate.room_state_floor')
          : participant.side === 'judge'
            ? t('debate.room_state_listening')
            : t('debate.room_state_ready');
        note = latestTurn.content;
      }

      return {
        side: participant.side,
        role: participant.role,
        statusLabel,
        note,
        sourceLabel: latestTurn ? getDebatePhaseLabel(t, latestTurn.phase) : null,
        active: latestTurn?.id === latestVisibleTurn?.id,
      };
    });
  }, [debate?.participants, debate?.result_ready, latestVisibleTurn?.id, stageTurns, t, visibleTurns]);

  const themeLabel = getTheaterThemeLabel(debate?.scene_theme, isZh);
  const themeAsset = debate?.scene_theme ? getThemeAssetPath(debate.scene_theme as never) : null;

  useEffect(() => {
    if (!canBetNow && showBetModal) {
      setShowBetModal(false);
    }
    if (!canBetNow && betPreset) {
      setBetPreset(null);
    }
  }, [betPreset, canBetNow, showBetModal]);

  useEffect(() => {
    const win = window as AutomationWindow;
    const capture = async (mode: 'canvas' | 'panel' | 'modal' = 'panel') => {
      if (mode === 'modal') {
        if (!showBetModal) return null;
        return captureElementDataUrl('.debate-modal', 'element');
      }
      return captureElementDataUrl('.debate-shell', 'element');
    };
    win.advanceTime = async (ms: number) => {
      const steps = Math.max(1, Math.floor(ms / REVEAL_INTERVAL_MS));
      setAutoReveal(false);
      setRevealCount((current) => Math.min(debate?.turns.length ?? current, current + steps));
    };
    win.capture_game_screenshot = capture;
    win.render_game_to_text = () => stringifyAutomationPayload(
      {
        question: debate?.question ?? null,
        status: status === 'loading' ? 'loading' : error ? 'error' : debate?.status ?? 'idle',
        currentRound: revealCount,
        totalRounds: debate?.turns.length ?? null,
        viewMode: 'theater',
        visualizationEnabled: true,
        isSimulationComplete: debate?.result_ready ?? false,
        messageCount: visibleTurns.length,
        agentCount: debate?.participants.length ?? 0,
        branchCount: 1,
      },
      debate ? {
        scene: 'DebateArenaDOM',
        theme: debate.scene_theme,
        phase: currentPhase,
        visible_turn_count: visibleTurns.length,
      } : null,
      {
        route: window.location.pathname,
        kind: 'debate',
        phase: currentPhase,
        selected_phase: selectedPhase,
        is_phase_locked: phaseLocked,
        unlocked_phases: unlockedPhases,
        controls: {
          can_open_prediction: canBetNow,
          can_open_counterplay: Boolean(counterplayPlan),
          counterplay_used: Boolean(counterplayRecord),
          can_view_result: Boolean(debate?.result_ready),
          can_capture_screenshot: captureStatus === 'idle',
          capture_mode: 'panel',
          active_modal: showBetModal ? 'bet' : null,
          show_bet_modal: showBetModal,
          bet_submitting: betSubmitting,
          auto_reveal: autoReveal,
          cue_phase: phaseCue?.phase ?? null,
          cue_speaker: phaseCue?.speakerName ?? null,
          modal_state: betModalState,
        },
        debate: debate ? {
          motion: debate.motion,
          proposition: { score: debate.score.proposition },
          opposition: { score: debate.score.opposition },
          judge: { summary_ready: debate.result_ready },
          visible_quotes: visibleTurns.slice(-3).map((turn) => turn.content),
          bet_window_open: canBetNow,
          counterplay: counterplayPlan ? {
            kind: counterplayPlan.kind,
            target_value: counterplayPlan.targetValue,
            confidence: counterplayPlan.confidence,
            label: counterplayPlan.label,
          } : null,
          counterplay_used: Boolean(counterplayRecord),
          stage_turn_count: stageTurns.length,
          unlocked_phase_count: phaseUnlockCount,
          latest_turn_id: latestVisibleTurn?.id ?? null,
          feed_focus: feedFocusLabel,
          phase_delta: phaseScoreDelta,
          watched_dimension: watchedDimension,
          server_phase_insights: serverPhaseInsights,
          room_map: roomInsights,
          stage_summaries: phaseSummaries,
          selected_phase_summary: selectedPhaseSummary,
          overview_cards: overviewCards,
        } : null,
      },
    );

    return () => {
      if (win.render_game_to_text) delete win.render_game_to_text;
      if (win.advanceTime) delete win.advanceTime;
      if (win.capture_game_screenshot === capture) delete win.capture_game_screenshot;
    };
  }, [
    autoReveal,
    betSubmitting,
    betModalState,
    canBetNow,
    captureStatus,
    currentPhase,
    debate,
    error,
    phaseLocked,
    phaseScoreDelta,
    revealCount,
    selectedPhase,
    showBetModal,
    phaseCue,
    phaseUnlockCount,
    stageTurns.length,
    status,
    t,
    unlockedPhases,
    visibleTurns,
    watchedDimension,
    counterplayPlan,
    counterplayRecord,
    overviewCards,
    phaseSummaries,
    roomInsights,
    serverPhaseInsights,
    selectedPhaseSummary,
  ]);

  const persistCounterplay = (payload: {
    kind: 'winner' | 'verdict_tone';
    targetValue: string;
    confidence: number;
    phase: DebatePhase;
    variant: 'balanced' | 'reversal';
  }) => {
    if (!id) return null;
    const record = saveDebateCounterplay({
      debateId: id,
      kind: payload.kind,
      targetValue: payload.targetValue,
      confidence: payload.confidence,
      phase: payload.phase,
      variant: payload.variant,
      createdAt: new Date().toISOString(),
    });
    setCounterplayRecord(record);
    return record;
  };

  const handleBetSubmit = async (payload: {
    kind: 'winner' | 'verdict_tone';
    targetValue: string;
    confidence: number;
  }) => {
    if (!id || !canBetNow) return;
    setBetSubmitting(true);
    try {
      await predictDebate(id, {
        kind: payload.kind,
        targetValue: payload.targetValue,
        confidence: payload.confidence,
        userId: directorIdentity.userId,
        userName: directorIdentity.userName,
        ...(betPreset ? {
          isCounterplay: true,
          counterplayPhase: betPreset.phase,
          counterplayVariant: betPreset.variant,
        } : {}),
      });
      if (betPreset) {
        persistCounterplay({
          kind: payload.kind,
          targetValue: payload.targetValue,
          confidence: payload.confidence,
          phase: betPreset.phase,
          variant: betPreset.variant,
        });
      }
      setBetNotice(t('debate.bet_success'));
      setBetPreset(null);
      setShowBetModal(false);
    } finally {
      setBetSubmitting(false);
    }
  };

  const handleOpenBet = () => {
    setBetPreset(null);
    setShowBetModal(true);
  };

  const handleOpenCounterplay = () => {
    if (!counterplayPlan) return;
    setBetPreset({
      kind: counterplayPlan.kind,
      targetValue: counterplayPlan.targetValue,
      confidence: counterplayPlan.confidence,
      strategyHint: counterplayPlan.strategyHint,
      phase: currentPhase as DebatePhase,
      variant: counterplayPlan.variant,
    });
    setShowBetModal(true);
  };

  const handleQuickCounterplay = async () => {
    if (!id || !counterplayPlan || !canBetNow || betSubmitting) return;
    setBetSubmitting(true);
    try {
      await predictDebate(id, {
        kind: counterplayPlan.kind,
        targetValue: counterplayPlan.targetValue,
        confidence: counterplayPlan.confidence,
        userId: directorIdentity.userId,
        userName: directorIdentity.userName,
        isCounterplay: true,
        counterplayPhase: currentPhase,
        counterplayVariant: counterplayPlan.variant,
      });
      persistCounterplay({
        kind: counterplayPlan.kind,
        targetValue: counterplayPlan.targetValue,
        confidence: counterplayPlan.confidence,
        phase: currentPhase as DebatePhase,
        variant: counterplayPlan.variant,
      });
      setBetNotice(t('debate.counterplay_success'));
    } catch (nextError) {
      setBetNotice(nextError instanceof Error ? nextError.message : t('debate.bet_error'));
    } finally {
      setBetSubmitting(false);
    }
  };

  const handleCapture = async () => {
    await captureScreenshot({ selector: '.debate-shell', captureTarget: 'element' });
    setCaptureNotice(t('debate.capture_done'));
    window.setTimeout(() => setCaptureNotice(''), 1600);
  };

  const debateStatusLabel = debate?.status ? t(`debate.status_${debate.status}`) : t('common.loading');

  return (
    <div className="debate-shell">
      <div className="debate-shell__inner">
        <section
          className="debate-hero"
          style={themeAsset ? { backgroundImage: `url(${themeAsset})` } : undefined}
        >
          <div className="debate-hero__content">
            <div className="debate-hero__top">
              <span className="debate-hero__eyebrow">
                <img className="debate-hero__banner" src={DEBATE_UI_ASSETS.stageBanner} alt="" aria-hidden="true" />
                {t('debate.entry_title')}
                {themeLabel ? ` · ${themeLabel}` : ''}
              </span>
              <span className={`debate-hero__status ${debate?.result_ready ? 'debate-hero__status--done' : ''}`}>
                {debateStatusLabel}
              </span>
            </div>

            <div className="debate-hero__copy">
              <h1 className="debate-hero__title">{t('debate.live_title')}</h1>
              <p className="debate-hero__subtitle">{t('debate.live_subtitle')}</p>
              <p className="debate-hero__motion">
                <strong>{t('debate.motion_label')}:</strong> {debate?.motion ?? t('debate.loading')}
              </p>
            </div>

            <DebateStageRibbon
              activePhase={selectedPhase}
              unlockedPhases={unlockedPhases}
              onSelect={(phase) => {
                setSelectedPhase(phase);
                setPhaseLocked(phase !== currentPhase);
              }}
            />

            <div className="debate-hero__bottom">
              <DebateMomentumBar
                propositionScore={debate?.score.proposition ?? 0}
                oppositionScore={debate?.score.opposition ?? 0}
                audienceMeter={debate?.score.audience_meter ?? 0}
                frameSrc={DEBATE_UI_ASSETS.scoreMeter}
              />
              <div className="debate-controls">
                <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>
                  {t('debate.back_home')}
                </button>
                {!debate?.result_ready && (
                  <button
                    type="button"
                    className="btn btn-ghost debate-primary-cta debate-primary-cta--hero"
                    onClick={handleOpenBet}
                    disabled={!canBetNow}
                  >
                    {t('debate.open_bet')}
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={handleCapture}>
                  {t('debate.capture_panel')}
                </button>
                {debate?.result_ready && (
                  <button
                    type="button"
                    className="btn btn-primary debate-primary-cta debate-primary-cta--hero"
                    onClick={() => navigate(`/debate/${id}/result`)}
                  >
                    {t('debate.view_result')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {betNotice && <p className="debate-phase-chip">{betNotice}</p>}
        {captureNotice && <p className="debate-phase-chip">{captureNotice}</p>}
        {error && <p className="debate-modal__error">{error}</p>}
        <section className="debate-situation-grid" aria-label={t('debate.overview_room_title')}>
          {overviewCards.map((card) => (
            <article key={card.title} className="debate-situation-card">
              <span className="debate-situation-card__eyebrow">{card.title}</span>
              <strong className="debate-situation-card__value">{card.value}</strong>
              <p className="debate-situation-card__detail">{card.detail}</p>
            </article>
          ))}
        </section>
        {phaseCueCopy && !debate?.result_ready && (
          <section
            key={phaseCue?.token}
            className="debate-live-cue"
            data-testid="debate-live-cue"
            aria-live="polite"
          >
            <span className="debate-live-cue__eyebrow">{getDebatePhaseLabel(t, phaseCue?.phase ?? currentPhase)}</span>
            <strong className="debate-live-cue__title">{phaseCueCopy}</strong>
            <span className="debate-live-cue__meta">
              {phaseCue?.speakerSide ? getDebateSideLabel(t, phaseCue.speakerSide) : stageStateLabel}
            </span>
          </section>
        )}
        <div className="debate-mobile-rail" aria-label={t('debate.mobile_primary_actions')}>
          {!debate?.result_ready ? (
            <button
              type="button"
              className="btn btn-primary debate-primary-cta debate-primary-cta--rail"
              onClick={handleOpenBet}
              disabled={!canBetNow}
            >
              {t('debate.open_bet')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary debate-primary-cta debate-primary-cta--rail"
              onClick={() => navigate(`/debate/${id}/result`)}
            >
              {t('debate.view_result')}
            </button>
          )}
        </div>

        <div className="debate-layout">
          <div className="debate-main">
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.participants_title')}</h2>
                <span className="debate-phase-chip">
                  {t('debate.current_phase')}: {getDebatePhaseLabel(t, currentPhase)}
                </span>
              </div>
              <div className="debate-panel__body">
                <div className="debate-score-grid">
                  {debate?.participants.map((participant) => (
                    <DebateScoreCard
                      key={participant.side}
                      sideLabel={getDebateSideLabel(t, participant.side)}
                      role={participant.role}
                      badgeSrc={
                        participant.side === 'proposition'
                          ? DEBATE_UI_ASSETS.badgeProposition
                          : participant.side === 'opposition'
                            ? DEBATE_UI_ASSETS.badgeOpposition
                            : DEBATE_UI_ASSETS.badgeJudge
                      }
                      score={
                        participant.side === 'proposition'
                          ? debate.score.proposition
                          : participant.side === 'opposition'
                            ? debate.score.opposition
                            : debate.result_ready
                              ? 1
                              : 0
                      }
                      active={
                        participant.side === activeSpeakerSide
                        || (participant.side === 'judge' && currentPhase === 'verdict')
                      }
                    />
                  ))}
                </div>
                <div className="debate-room-grid">
                  {roomInsights.map((insight) => (
                    <article
                      key={insight.side}
                      className={`debate-room-card ${insight.active ? 'debate-room-card--active' : ''}`}
                    >
                      <div className="debate-room-card__meta">
                        <strong>{getDebateSideLabel(t, insight.side)}</strong>
                        <span className="debate-phase-chip">{insight.statusLabel}</span>
                      </div>
                      <p className="debate-room-card__role">{insight.role}</p>
                      <p className="debate-room-card__note">{insight.note}</p>
                      {insight.sourceLabel && (
                        <span className="debate-room-card__source">{insight.sourceLabel}</span>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.feed_title')}</h2>
                <div className="debate-feed-header-meta">
                  <span className="debate-phase-chip debate-phase-chip--accent">
                    {unlockProgressLabel}
                  </span>
                  <span className="debate-phase-chip">{stageStateLabel}</span>
                </div>
                <div className="debate-controls">
                  <button type="button" className="btn btn-ghost" onClick={() => setAutoReveal((current) => !current)}>
                    {t('debate.auto_reveal')}: {t(autoReveal ? 'debate.state_on' : 'debate.state_off')}
                  </button>
                  {phaseLocked && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setPhaseLocked(false);
                        setSelectedPhase(currentPhase);
                      }}
                    >
                      {t('debate.return_to_live')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setAutoReveal(false);
                      setPhaseLocked(false);
                      setRevealCount(debate?.turns.length ?? 0);
                      setSelectedPhase('verdict');
                    }}
                  >
                    {t('debate.skip_to_verdict')}
                  </button>
                </div>
              </div>
              <div className="debate-panel__body">
                {feedFocusLabel && (
                  <div className="debate-feed-focus" data-testid="debate-feed-focus">
                    <span className="debate-feed-focus__dot" aria-hidden="true" />
                    <div className="debate-feed-focus__copy">
                      <strong>{getDebatePhaseLabel(t, currentPhase)}</strong>
                      <p>{feedFocusLabel}</p>
                    </div>
                  </div>
                )}
                {stageTurns.length > 0 ? (
                  <div className="debate-turn-list">
                    {stageTurns.map((turn) => (
                      <article
                        key={turn.id}
                        className={`debate-turn-card ${turn.id === latestStageTurn?.id ? 'debate-turn-card--latest' : ''} ${turn.id === latestVisibleTurn?.id && selectedPhase === currentPhase ? 'debate-turn-card--hot' : ''}`}
                        data-testid={turn.id === latestVisibleTurn?.id && selectedPhase === currentPhase ? 'debate-live-turn' : undefined}
                      >
                        <div className="debate-turn-card__meta">
                          <strong>{turn.speaker_name}</strong>
                          <div className="debate-turn-card__tags">
                            <span>{getDebateSideLabel(t, turn.speaker_side)}</span>
                            {turn.score_delta && (
                              <span className="debate-phase-chip">
                                {(turn.score_delta.proposition ?? 0) === (turn.score_delta.opposition ?? 0)
                                  ? t('debate.turn_swing_even')
                                  : t('debate.turn_swing_edge', {
                                    side: getDebateSideLabel(
                                      t,
                                      (turn.score_delta.proposition ?? 0) > (turn.score_delta.opposition ?? 0)
                                        ? 'proposition'
                                        : 'opposition',
                                    ),
                                    value: Math.abs((turn.score_delta.proposition ?? 0) - (turn.score_delta.opposition ?? 0)),
                                  })}
                              </span>
                            )}
                          </div>
                        </div>
                        <p className="debate-turn-card__content">{turn.content}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="debate-empty-state">{t('debate.loading')}</p>
                )}
              </div>
            </section>
          </div>

          <aside className="debate-side">
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.strategy_title')}</h3>
                <span className="debate-phase-chip">{betWindowLabel}</span>
              </div>
              <div className="debate-panel__body">
                <div className="debate-turn-list">
                  <article className="debate-turn-card">
                    <div className="debate-turn-card__meta">
                      <strong>{t('debate.strategy_current_clash')}</strong>
                      <span>{getDebatePhaseLabel(t, selectedPhase)}</span>
                    </div>
                    <p className="debate-rule-copy">{clashCopy}</p>
                  </article>
                  <article className="debate-turn-card">
                    <div className="debate-turn-card__meta">
                      <strong>{t('debate.strategy_pressure')}</strong>
                      <span>{phaseLeaderLabel}</span>
                    </div>
                    <p className="debate-rule-copy">{phasePressureCopy}</p>
                  </article>
                  <article className="debate-turn-card">
                    <div className="debate-turn-card__meta">
                      <strong>{t('debate.strategy_watchlist')}</strong>
                      <span>{getDebateDimensionLabel(t, watchedDimension)}</span>
                    </div>
                    <p className="debate-rule-copy">
                      {canBetNow ? t('debate.watchlist_open') : t('debate.watchlist_locked')}
                    </p>
                  </article>
                  {counterplayPlan && (
                    <article className="debate-turn-card debate-turn-card--counterplay">
                      <div className="debate-turn-card__meta">
                        <strong>{t('debate.counterplay_title')}</strong>
                        <span>{counterplayPlan.label}</span>
                      </div>
                      <p className="debate-rule-copy">{counterplayPlan.summary}</p>
                      <div className="debate-counterplay-actions">
                        <button
                          type="button"
                          className="btn btn-primary debate-counterplay-btn"
                          onClick={handleQuickCounterplay}
                          disabled={!canBetNow || betSubmitting}
                        >
                          {betSubmitting ? t('debate.bet_submitting') : t('debate.counterplay_submit')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost debate-counterplay-btn"
                          onClick={handleOpenCounterplay}
                          disabled={!canBetNow || betSubmitting}
                        >
                          {t('debate.counterplay_apply')}
                        </button>
                      </div>
                      {counterplayRecord && (
                        <p className="debate-rule-copy">{t('debate.counterplay_used')}</p>
                      )}
                    </article>
                  )}
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.rules_title')}</h3>
              </div>
              <div className="debate-panel__body">
                <p className="debate-rule-copy">{t('debate.rules_body')}</p>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.stage_map_title')}</h3>
                <span className="debate-phase-chip">{getDebatePhaseLabel(t, selectedPhase)}</span>
              </div>
              <div className="debate-panel__body">
                <p className="debate-rule-copy debate-stage-map__intro">{t('debate.stage_map_subtitle')}</p>
                <div className="debate-stage-summary-list">
                  {phaseSummaries.map((summary) => {
                    const statusLabel = !summary.unlocked
                      ? t('debate.stage_status_waiting')
                      : summary.phase === currentPhase && !phaseLocked
                        ? t('debate.stage_status_live')
                        : summary.phase === selectedPhase && phaseLocked
                          ? t('debate.stage_status_locked')
                          : t('debate.stage_status_complete');

                    const swingLabel = summary.swing === 0
                      ? t('debate.stage_swing_even')
                      : t('debate.stage_swing_edge', {
                        side: getLeaderLabel(t, summary.leader),
                        value: summary.swing,
                      });
                    const serverInsight = serverPhaseInsightMap.get(summary.phase);

                    return (
                      <article
                        key={summary.phase}
                        className={`debate-stage-summary-card ${summary.phase === selectedPhase ? 'debate-stage-summary-card--active' : ''}`}
                      >
                        <div className="debate-stage-summary-card__meta">
                          <span className="debate-phase-chip">{getDebatePhaseLabel(t, summary.phase)}</span>
                          <span>{statusLabel}</span>
                        </div>
                        <strong className="debate-stage-summary-card__value">
                          {summary.turnCount > 0
                            ? t('debate.stage_turn_count', { count: summary.turnCount })
                            : t('debate.loading')}
                        </strong>
                        <p className="debate-stage-summary-card__detail">{swingLabel}</p>
                        {serverInsight?.commentary && (
                          <p className="debate-stage-summary-card__detail">{serverInsight.commentary}</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>

      {showBetModal && (
        <DebateBetModal
          loading={betSubmitting}
          initialSelection={betPreset}
          strategyHint={betPreset?.strategyHint ?? null}
          onClose={() => {
            setShowBetModal(false);
            setBetPreset(null);
          }}
          onSubmit={handleBetSubmit}
          onAutomationStateChange={setBetModalState}
        />
      )}
    </div>
  );
}
