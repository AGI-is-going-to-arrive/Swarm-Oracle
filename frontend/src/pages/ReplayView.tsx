import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { buildSessionHeaders, getReplayTrace, isApiError, getScenario } from '../api/client';
import type { ReplayTraceNode, ReplayTraceResponse, BranchInfo } from '../types';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import {
  useReplayTimeline,
  type PlaybackSpeed,
} from '../hooks/useReplayTimeline';
import { ReplayAgentQueue, type ReplayAgentInfo } from '../components/replay/ReplayAgentQueue';
import { ReplayEmptyState } from '../components/replay/ReplayEmptyState';
import { ReplayPlaybackControl } from '../components/replay/ReplayPlaybackControl';
import { ReplayTimelineScrubber } from '../components/replay/ReplayTimelineScrubber';

// ── Types ─────────────────────────────────────────────────────

interface CausalGraphNode {
  id: string;
  key: string;
  type: string;
  label: string;
  round: number | null;
  payload: unknown;
}

interface CausalGraphResponse {
  id: string;
  nodes: CausalGraphNode[];
  edges: unknown[];
}

// ── Helpers ───────────────────────────────────────────────────

function readPayload(node: CausalGraphNode): Record<string, unknown> {
  return (typeof node.payload === 'object' && node.payload !== null && !Array.isArray(node.payload))
    ? node.payload as Record<string, unknown>
    : {};
}

function extractAgentsFromGraph(graph: CausalGraphResponse | null): ReplayAgentInfo[] {
  if (!graph) return [];
  const agentMap = new Map<string, ReplayAgentInfo>();
  for (const node of graph.nodes ?? []) {
    const payload = readPayload(node);
    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : null;
    if (!agentId || agentMap.has(agentId)) continue;
    const agentName = typeof payload.agent_name === 'string' && payload.agent_name.trim()
      ? payload.agent_name.trim()
      : agentId;
    agentMap.set(agentId, { id: agentId, name: agentName });
  }
  return [...agentMap.values()];
}

function makeTraceFallbackNode(node: ReplayTraceNode): CausalGraphNode {
  return {
    id: `trace-${node.branch_id}-${node.origin_round}`,
    key: `trace-${node.branch_id}-${node.origin_round}`,
    type: node.replay_kind || 'trace',
    label: `Branch ${node.branch_id}`,
    round: node.origin_round,
    payload: {
      branch_id: node.branch_id,
      replay_kind: node.replay_kind,
      content: `Branch ${node.branch_id}`,
    },
  };
}

function buildFrames(
  trace: ReplayTraceResponse | null,
  graph: CausalGraphResponse | null,
): { count: number; nodeByFrame: Map<number, CausalGraphNode | null>; nodesByFrame: Map<number, CausalGraphNode[]>; turnIds: string[]; frameToRound: number[] } {
  const rounds = new Set<number>();
  if (trace?.nodes) {
    for (const n of trace.nodes) {
      if (typeof n.origin_round === 'number' && n.origin_round >= 0) rounds.add(n.origin_round);
    }
  }
  if (graph?.nodes) {
    for (const n of graph.nodes) {
      if (typeof n.round === 'number' && n.round >= 0) rounds.add(n.round);
    }
  }

  const nodesByRound = new Map<number, CausalGraphNode[]>();
  const nodeByRound = new Map<number, CausalGraphNode | null>();
  if (graph?.nodes) {
    for (const node of graph.nodes) {
      if (typeof node.round === 'number' && node.round >= 0) {
        if (!nodeByRound.has(node.round)) nodeByRound.set(node.round, node);
        const list = nodesByRound.get(node.round) ?? [];
        list.push(node);
        nodesByRound.set(node.round, list);
      }
    }
  }
  if (trace?.nodes) {
    for (const traceNode of trace.nodes) {
      if (typeof traceNode.origin_round !== 'number' || traceNode.origin_round < 0) continue;
      const list = nodesByRound.get(traceNode.origin_round) ?? [];
      const hasBranchNode = list.some((graphNode) => {
        const payload = readPayload(graphNode);
        return payload.branch_id === traceNode.branch_id;
      });
      if (hasBranchNode) continue;
      const fallbackNode = makeTraceFallbackNode(traceNode);
      list.push(fallbackNode);
      nodesByRound.set(traceNode.origin_round, list);
      if (!nodeByRound.has(traceNode.origin_round)) nodeByRound.set(traceNode.origin_round, fallbackNode);
    }
  }

  const sortedRounds = [...rounds].sort((a, b) => a - b);
  const populatedRounds = sortedRounds.filter(r => (nodesByRound.get(r)?.length ?? 0) > 0);
  const frameToRound = populatedRounds.length > 0 ? populatedRounds : sortedRounds;
  const count = frameToRound.length;

  const nodeByFrame = new Map<number, CausalGraphNode | null>();
  const nodesByFrame = new Map<number, CausalGraphNode[]>();
  for (let i = 0; i < count; i++) {
    const round = frameToRound[i];
    nodeByFrame.set(i, nodeByRound.get(round) ?? null);
    nodesByFrame.set(i, nodesByRound.get(round) ?? []);
  }

  const turnIds = frameToRound.map(r => `turn_${r}`);
  return { count, nodeByFrame, nodesByFrame, turnIds, frameToRound };
}

function pickActiveAgent(
  frame: number,
  nodeByFrame: Map<number, CausalGraphNode | null>,
): string | null {
  const node = nodeByFrame.get(frame);
  if (!node) return null;
  const payload = readPayload(node);
  return typeof payload.agent_id === 'string' ? payload.agent_id : null;
}

function hashToHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

const EMOTION_ICONS: Record<string, string> = {
  aggressive: '\u{1F525}', angry: '\u{1F4A2}', anxious: '\u{1F630}',
  fearful: '\u{1F628}', cautious: '\u{1F914}', calm: '\u{1F343}',
  hopeful: '\u{2728}', cooperative: '\u{1F91D}', confident: '\u{1F4AA}',
  neutral: '\u{2014}', focused: '\u{1F3AF}',
};

// ── Component ─────────────────────────────────────────────────

export function ReplayView() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const targetBranchId = searchParams.get('branch');
  const targetMessageId = searchParams.get('message');
  const targetRoundRaw = searchParams.get('round');
  const targetRoundNumber = targetRoundRaw != null && /^\d+$/.test(targetRoundRaw)
    ? Number.parseInt(targetRoundRaw, 10)
    : null;
  const {
    loading: capLoading,
    enabled,
    error: capabilityError,
    reload: reloadCapability,
  } = useCapabilityCheck('replay_trace');

  const [trace, setTrace] = useState<ReplayTraceResponse | null>(null);
  const [graph, setGraph] = useState<CausalGraphResponse | null>(null);
  const [branchesInfo, setBranchesInfo] = useState<BranchInfo[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState<string>(targetBranchId || '');
  // The specific replay node a `?message=Y` deep-link resolved to (used to highlight it).
  // Stays null when no frame/node carries that message_id — the graceful no-match fallback.
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fetchSeqRef = useRef(0);
  const loadMoreSeqRef = useRef(0);

  const encodedId = id ? encodeURIComponent(id) : '';

  const fetchAll = useCallback(async () => {
    if (!id || !encodedId) return;
    const requestId = fetchSeqRef.current + 1;
    fetchSeqRef.current = requestId;
    setLoadingData(true);
    setError(null);
    setTrace(null);
    setGraph(null);
    setBranchesInfo([]);
    // Preserve a `?branch=` deep-link filter across (re)fetches; only options-validation clears it.
    setBranchFilter(targetBranchId || '');
    setLoadMoreError(null);
    try {
      const [traceResult, graphRes, scenarioRes] = await Promise.allSettled([
        getReplayTrace(id),
        fetch(`/api/scenario/${encodedId}/causal-graph`, { headers: buildSessionHeaders() }),
        getScenario(id),
      ]);
      if (fetchSeqRef.current !== requestId) return;
      if (traceResult.status === 'fulfilled') {
        setTrace(traceResult.value);
      } else {
        const reason = traceResult.reason;
        if (isApiError(reason)) {
          setError(reason.status);
        } else {
          setError(-1);
        }
        setTrace(null);
      }
      if (graphRes.status === 'fulfilled' && graphRes.value.ok) {
        setGraph((await graphRes.value.json()) as CausalGraphResponse);
      } else {
        setGraph(null);
      }
      if (scenarioRes.status === 'fulfilled') {
        setBranchesInfo(scenarioRes.value.branches ?? []);
      } else {
        setBranchesInfo([]);
      }
    } catch {
      if (fetchSeqRef.current !== requestId) return;
      setError(-1);
      setTrace(null);
      setGraph(null);
      setBranchesInfo([]);
    } finally {
      if (fetchSeqRef.current === requestId) {
        setLoadingData(false);
      }
    }
  }, [encodedId, id, targetBranchId]);

  const loadMore = useCallback(async () => {
    if (!id || !trace?.next_cursor || loadingMore) return;
    const cursor = trace.next_cursor;
    const requestId = loadMoreSeqRef.current + 1;
    loadMoreSeqRef.current = requestId;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await getReplayTrace(id, { cursor });
      if (loadMoreSeqRef.current !== requestId) return;
      setTrace((prev) => {
        if (!prev) return next;
        if (prev.next_cursor !== cursor) return prev;
        const seen = new Set(prev.nodes.map((n) => n.branch_id));
        const newNodes = next.nodes.filter((n) => !seen.has(n.branch_id));
        const merged = [...prev.nodes, ...newNodes];
        const nextCursor = next.next_cursor === cursor && newNodes.length === 0
          ? null
          : next.next_cursor;
        return { nodes: merged, next_cursor: nextCursor };
      });
    } catch (err) {
      if (loadMoreSeqRef.current !== requestId) return;
      // Non-fatal: keep current trace; surface inline error so user may retry.
      const message = getLocalizedApiErrorMessage(err, t, t('replay.load_more_error'));
      setLoadMoreError(message);
    } finally {
      if (loadMoreSeqRef.current === requestId) {
        setLoadingMore(false);
      }
    }
  }, [id, trace, loadingMore, t]);

  useEffect(() => {
    if (!enabled || capabilityError) return;
    fetchAll();
  }, [capabilityError, enabled, fetchAll]);

  const { count: totalFrames, nodeByFrame, nodesByFrame, frameToRound } = useMemo(
    () => buildFrames(trace, graph),
    [trace, graph],
  );
  const agents = useMemo(() => extractAgentsFromGraph(graph), [graph]);

  const {
    frameIndex,
    playing,
    speed,
    setFrame,
    play,
    pause,
    step,
    skipToEnd,
    setSpeed,
  } = useReplayTimeline({ totalFrames });

  // Evidence deep-link: `/replay/{id}?branch=X&message=Y&round=N`.
  //  - branch X is already applied via `branchFilter` (seeded from `targetBranchId`);
  //  - round N is mapped to the current frame index because frames can differ from rounds;
  //  - here we refine to the exact message: if a frame/node carries `payload.message_id === Y`,
  //    jump to that frame and flag it for highlight; otherwise fall back gracefully to the
  //    branch+round view with no crash and no error surface.
  // Matching is restricted to `payload.message_id` ONLY — node id/key are graph-internal
  // identifiers and a `?message=Y` value could collide with one, falsely highlighting an
  // unrelated node. When the backend omits `payload.message_id`, nothing matches and the
  // deep-link degrades to the branch+turn view (still no crash).
  useEffect(() => {
    if (loadingData || totalFrames <= 0 || (!targetMessageId && targetRoundNumber == null)) return;

    let foundFrame = -1;
    let matchedKey: string | null = null;
    if (targetMessageId) {
      for (let i = 0; i < totalFrames; i++) {
        const nodes = nodesByFrame.get(i) ?? [];
        const matched = nodes.find((n) => readPayload(n).message_id === targetMessageId);
        if (matched) {
          foundFrame = i;
          matchedKey = matched.id;
          break;
        }
      }
    }
    if (foundFrame === -1 && targetRoundNumber != null) {
      foundFrame = frameToRound.findIndex((round) => round === targetRoundNumber);
    }

    if (foundFrame !== -1) {
      setFrame(foundFrame);
      setHighlightMessageId(matchedKey);
    } else {
      // No-match fallback: keep the hash-derived turn frame and branch filter as-is, and
      // surface nothing — the deep-link simply degrades to the branch+turn view.
      setHighlightMessageId(null);
    }

    // Either way, consume one-shot params so scrubbing/refetch doesn't snap back to them.
    // Preserve any existing hash for older links and the `branch` filter in the URL.
    searchParams.delete('message');
    searchParams.delete('round');
    const query = searchParams.toString();
    try {
      window.history.replaceState(null, '', `${query ? `?${query}` : ''}${window.location.hash}`);
    } catch {
      /* jsdom / sandboxes may reject replaceState — non-fatal. */
    }
  }, [frameToRound, loadingData, targetMessageId, targetRoundNumber, totalFrames, nodesByFrame, setFrame, searchParams]);

  useEffect(() => {
    if (rootRef.current && typeof rootRef.current.focus === 'function') {
      try {
        rootRef.current.focus({ preventScroll: true });
      } catch { /* jsdom */ }
    }
  }, []);

  const activeAgentId = useMemo(
    () => pickActiveAgent(frameIndex, nodeByFrame),
    [frameIndex, nodeByFrame],
  );

  const branchOptions = useMemo<string[]>(() => {
    const seen = new Set<string>();
    for (const node of trace?.nodes ?? []) {
      if (node.branch_id) seen.add(node.branch_id);
    }
    for (const node of graph?.nodes ?? []) {
      const payload = readPayload(node);
      const branchId = typeof payload.branch_id === 'string' ? payload.branch_id : null;
      if (branchId) seen.add(branchId);
    }
    return [...seen].sort();
  }, [graph, trace]);

  const branchOptionMap = useMemo(() => {
    return new Map(branchesInfo.map((b) => [b.id, b]));
  }, [branchesInfo]);

  const buildBranchOptionLabel = useCallback((branchId: string) => {
    const info = branchOptionMap.get(branchId);
    if (!info) return branchId;
    const title = info.title && info.title.trim().length > 0 ? info.title : branchId;
    if (info.probability == null) return title;
    return `${title} · ${(info.probability * 100).toFixed(1)}%`;
  }, [branchOptionMap]);

  // Reset filter when current selection becomes invalid (e.g., after refetch).
  useEffect(() => {
    if (branchFilter && !branchOptions.includes(branchFilter)) {
      setBranchFilter('');
    }
  }, [branchFilter, branchOptions]);

  const visibleFrameNodes = useMemo(() => {
    const nodes = nodesByFrame.get(frameIndex) ?? [];
    if (!branchFilter) return nodes;
    return nodes.filter((node) => {
      const payload = readPayload(node);
      const nodeBranchId = typeof payload.branch_id === 'string' ? payload.branch_id : null;
      return nodeBranchId === branchFilter;
    });
  }, [branchFilter, frameIndex, nodesByFrame]);

  // Loading state
  if (capLoading || (!capabilityError && enabled && loadingData)) {
    return (
      <div ref={rootRef} data-testid="replay-view-root" className="replay-view-root replay-shell" tabIndex={-1}>
        <div className="replay-loading">
          <div className="replay-loading__spinner" />
          <p className="replay-loading__text">{t('common.loading', 'Loading...')}</p>
        </div>
      </div>
    );
  }

  // Capability error / disabled
  if (capabilityError || !enabled) {
    return (
      <div ref={rootRef} data-testid="replay-view-root" className="replay-view-root replay-shell" tabIndex={-1}>
        <header className="replay-header">
          <h1 className="replay-header__title">{t('replay.title', 'Replay')}</h1>
        </header>
        <ReplayEmptyState
          title={capabilityError
            ? t('replay.feature_unavailable_title', 'Replay availability could not be checked')
            : t('replay.feature_disabled_title', 'Replay trace is unavailable')}
          message={capabilityError
            ? t('replay.feature_unavailable_description', 'Unable to confirm whether replay trace is available right now. Please retry.')
            : t('replay.feature_disabled_description', 'This server has replay trace disabled for this environment.')}
          onRetry={capabilityError ? () => void reloadCapability?.() : undefined}
          retryLabel={t('common.retry', 'Retry')}
        />
        <div className="replay-header__back-row">
          <Link to="/" className="replay-header__link">{t('common.back_home', 'Back to Home')}</Link>
        </div>
      </div>
    );
  }

  const hasTrace = (trace?.nodes?.length ?? 0) > 0;
  const hasGraph = (graph?.nodes?.length ?? 0) > 0;
  const hasFrames = totalFrames > 0;
  const hasPendingPage = Boolean(trace?.next_cursor);
  const showEmpty = !!error || (!hasTrace && !hasGraph) || !hasFrames;
  const currentRound = frameToRound[frameIndex];

  return (
    <div ref={rootRef} data-testid="replay-view-root" className="replay-view-root replay-shell" tabIndex={-1}>
      {/* ── Header ── */}
      <header className="replay-header">
        <div className="replay-header__left">
          <Link to="/" className="replay-header__back" aria-label={t('common.back_home', 'Back to Home')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1 className="replay-header__title">{t('replay.title', 'Replay')}</h1>
          {!showEmpty && currentRound != null && (
            <span className="replay-header__badge">
              R{currentRound}
            </span>
          )}
        </div>
        <div className="replay-header__right">
          {!showEmpty && id && (
            <Link to={`/sim/${encodeURIComponent(id)}`} className="replay-header__theater-btn">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6.5 6.5L10.5 8.5L6.5 10.5V6.5Z" fill="currentColor" />
              </svg>
              {t('replay.open_pixel_theater', 'Open Pixel Theater')}
            </Link>
          )}
        </div>
      </header>

      {showEmpty ? (
        <>
          <ReplayEmptyState
            message={error === -1
              ? t('replay.empty.offline', 'Network error loading replay trace.')
              : t('replay.empty.no_data', 'No replay lineage for this scenario yet.')}
            onRetry={fetchAll}
            retryLabel={t('replay.empty.retry', 'Retry')}
            title={t('replay.empty.title', 'No replay trace available')}
          />
          {!error && hasPendingPage && (
            <div className="replay-trace__load-more">
              <button
                type="button"
                data-testid="replay-load-more"
                className="replay-trace__load-more-btn"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? t('common.loading', 'Loading...')
                  : t('replay.load_more', 'Load more')}
              </button>
              {loadMoreError && (
                <p
                  className="replay-trace__load-more-error"
                  data-testid="replay-load-more-error"
                  role="alert"
                >
                  {loadMoreError}
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {/* ── Transport bar ── */}
          <div className="replay-transport">
            <ReplayPlaybackControl
              playing={playing}
              speed={speed}
              canStepBack={frameIndex > 0}
              canStepForward={frameIndex < totalFrames - 1}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onPlay={play}
              onPause={pause}
              onSkipToEnd={skipToEnd}
              onSpeedChange={(s: PlaybackSpeed) => setSpeed(s)}
            />
            <ReplayTimelineScrubber
              frameIndex={frameIndex}
              totalFrames={totalFrames}
              onFrameChange={setFrame}
              ariaLabel={t('replay.scrubber.aria_label', 'Replay timeline')}
            />
          </div>

          {/* ── Agents ── */}
          <section aria-label={t('replay.agent_queue.aria_label', 'Replay agent queue')} className="replay-agents-section">
            <ReplayAgentQueue agents={agents} activeAgentId={activeAgentId} />
          </section>

          {/* ── Frame metadata ── */}
          <div className="replay-meta">
            <span className="replay-meta__frame">
              {t('replay.trace.frame_count_label', 'Frame')} {frameIndex + 1} / {totalFrames}
            </span>
            {currentRound != null && (
              <span className="replay-meta__round">Round {currentRound}</span>
            )}
            <span className="replay-meta__branches">
              {t('replay.trace.branches_label', 'Branches')}: {branchOptions.length}
            </span>
          </div>

          {/* ── Branch filter ── */}
          {branchOptions.length > 0 && (
            <div className="replay-branch-filter">
              <label htmlFor="replay-branch-filter-select" className="replay-branch-filter__label">
                {t('replay.filter_branch', 'Filter by branch')}
              </label>
              <select
                id="replay-branch-filter-select"
                data-testid="replay-branch-filter-select"
                className="replay-branch-filter__select"
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
              >
                <option value="">{t('replay.all_branches', 'All branches')}</option>
                {branchOptions.map((branchId) => (
                  <option key={branchId} value={branchId}>{buildBranchOptionLabel(branchId)}</option>
                ))}
              </select>
            </div>
          )}

          {/* ── Trace cards ── */}
          <section aria-label={t('replay.trace.aria_label', 'Replay trace')} className="replay-trace">
            <div role="log" aria-live="polite" className="replay-trace__list">
              {visibleFrameNodes.map(node => {
                const p = readPayload(node);
                const agentId = typeof p.agent_id === 'string' ? p.agent_id : null;
                const agentName = typeof p.agent_name === 'string' && p.agent_name.trim()
                  ? p.agent_name.trim()
                  : (agentId ? agentId.slice(0, 8) : null);
                const content = typeof p.content === 'string' ? p.content : (node.label || '');
                const emotion = typeof p.emotion === 'string' ? p.emotion : null;
                const emotionMetadataUnavailable = p.emotion_metadata_status === 'unavailable';
                const isFork = node.type === 'fork';
                const hue = agentId ? hashToHue(agentId) : 260;
                const accentColor = `oklch(65% 0.18 ${hue})`;
                const isHighlighted = highlightMessageId != null && node.id === highlightMessageId;

                if (isFork && !agentName) {
                  return (
                    <div
                      key={node.id}
                      className={`replay-card replay-card--fork${isHighlighted ? ' replay-card--highlighted' : ''}`}
                      data-highlighted={isHighlighted ? 'true' : undefined}
                      data-testid={isHighlighted ? 'replay-card-highlighted' : undefined}
                    >
                      <div className="replay-card__fork-icon" aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <path d="M8 2V6M8 6L4 10M8 6L12 10M4 10V14M12 10V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="replay-card__fork-body">
                        <span className="replay-card__fork-label">
                          {t('replay.trace.branch_fork', 'Branch fork')}
                        </span>
                        <span className="replay-card__round">R{node.round ?? '?'}</span>
                      </div>
                      {content && <p className="replay-card__fork-detail">{content}</p>}
                    </div>
                  );
                }

                return (
                  <div
                    key={node.id}
                    className={`replay-card${isHighlighted ? ' replay-card--highlighted' : ''}`}
                    style={{ '--card-accent': accentColor } as React.CSSProperties}
                    data-highlighted={isHighlighted ? 'true' : undefined}
                    data-testid={isHighlighted ? 'replay-card-highlighted' : undefined}
                  >
                    <div className="replay-card__header">
                      <span className="replay-card__avatar" aria-hidden="true" style={{ background: accentColor }}>
                        {agentName ? agentName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() : '?'}
                      </span>
                      <div className="replay-card__meta">
                        <strong className="replay-card__name">{agentName ?? t('replay.trace.unknown_agent', 'System')}</strong>
                        {emotionMetadataUnavailable ? (
                          <span className="replay-card__emotion replay-card__emotion--unavailable">
                            {t(
                              'sim.panel.emotion_metadata_unavailable',
                              'Emotion metadata unavailable',
                            )}
                          </span>
                        ) : emotion && (
                          <span className="replay-card__emotion">
                            {EMOTION_ICONS[emotion] ?? ''} {emotion}
                          </span>
                        )}
                      </div>
                      <span className="replay-card__round">R{node.round ?? '?'}</span>
                    </div>
                    <p className="replay-card__content">{content}</p>
                  </div>
                );
              })}
              {visibleFrameNodes.length === 0 && (
                <p className="replay-trace__empty">
                  {t('replay.trace.no_events_frame', 'No events for this frame.')}
                </p>
              )}
            </div>
            {/* ── Load more (cursor pagination) ── */}
            {trace?.next_cursor ? (
              <div className="replay-trace__load-more">
                <button
                  type="button"
                  data-testid="replay-load-more"
                  className="replay-trace__load-more-btn"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore
                    ? t('common.loading', 'Loading...')
                    : t('replay.load_more', 'Load more')}
                </button>
                {loadMoreError && (
                  <p
                    className="replay-trace__load-more-error"
                    data-testid="replay-load-more-error"
                    role="alert"
                  >
                    {loadMoreError}
                  </p>
                )}
              </div>
            ) : (trace?.nodes.length ?? 0) > 0 ? (
              <p className="replay-trace__no-more" data-testid="replay-no-more">
                {t('replay.no_more', 'No more entries')}
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

export default ReplayView;
