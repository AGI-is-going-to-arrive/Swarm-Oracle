/* ═══════════════════════════════════════════════════════════
   Identity Memory Inspector
   Read-only timeline of an Agent identity's recorded memories.
   Capability gate: agent_identity
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  getIdentityMemories,
  getSessionBoundUserId,
  isApiError,
  listAgentIdentities,
  pinIdentityMemory,
  unpinIdentityMemory,
  type IdentityMemoryEntry,
} from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { AgentIdentityInfo } from '../types';
import './IdentityInspectorView.css';

const DOCUMENT_PREVIEW_CHARS = 200;
const SOURCE_ID_DISPLAY_LIMIT = 6;
const SOURCE_ID_PREVIEW_CHARS = 32;

type ConfidenceBucket = 'high' | 'medium' | 'low' | 'unknown';

function numericConfidence(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bucketConfidence(value: number | string | null | undefined): ConfidenceBucket {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  const numeric = numericConfidence(value);
  if (numeric === null) return 'unknown';
  if (numeric >= 0.7) return 'high';
  if (numeric >= 0.4) return 'medium';
  return 'low';
}

function parseRound(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function confidenceValueLabel(value: number | string | null | undefined): string | null {
  const numeric = numericConfidence(value);
  return numeric === null ? null : numeric.toFixed(2);
}

function truncatePreview(text: string, max: number): { preview: string; truncated: boolean } {
  // Use Array.from to avoid splitting surrogate pairs (CJK + emoji safety).
  const chars = Array.from(text);
  if (chars.length <= max) return { preview: text, truncated: false };
  return { preview: `${chars.slice(0, max).join('')}…`, truncated: true };
}

function nonBlankMetadataText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedSourceIds(value: unknown): string[] {
  let sourceIds: unknown = value;
  if (typeof value === 'string') {
    try {
      sourceIds = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(sourceIds)) return [];
  return sourceIds
    .filter((sourceId): sourceId is string => typeof sourceId === 'string' && !!sourceId.trim())
    .slice(0, SOURCE_ID_DISPLAY_LIMIT)
    .map((sourceId) => sourceId.trim());
}

function formatTimestamp(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(locale);
  } catch {
    return iso;
  }
}

function compareTimestampsDesc(a: IdentityMemoryEntry, b: IdentityMemoryEntry): number {
  const ta = a.timestamp ?? '';
  const tb = b.timestamp ?? '';
  // Newest first — empty timestamps sort last.
  if (!ta && !tb) return 0;
  if (!ta) return 1;
  if (!tb) return -1;
  return ta < tb ? 1 : ta > tb ? -1 : 0;
}

interface MemoryRowProps {
  entry: IdentityMemoryEntry;
  index: number;
  expanded: boolean;
  onToggle: (index: number) => void;
  onTogglePin: (memoryId: string, currentlyPinned: boolean) => void;
  pinCount: number;
  pinCap: number;
}

function MemoryRow({ entry, index, expanded, onToggle, onTogglePin, pinCount, pinCap }: MemoryRowProps) {
  const { t, i18n } = useTranslation();
  const document = typeof entry.document === 'string' ? entry.document : '';
  const { preview, truncated } = truncatePreview(document, DOCUMENT_PREVIEW_CHARS);
  const meta = entry.metadata ?? {};
  const scenarioId = typeof meta.scenario_id === 'string' ? meta.scenario_id : null;
  const branchId = nonBlankMetadataText(meta.branch_id);
  const round = parseRound(meta.round ?? meta.round_number);
  const memoryType = nonBlankMetadataText(meta.memory_kind) ?? nonBlankMetadataText(meta.type);
  const actionType = nonBlankMetadataText(meta.action_type);
  const observation = nonBlankMetadataText(meta.observation);
  const provenanceKind = nonBlankMetadataText(meta.provenance_kind);
  const outcome = nonBlankMetadataText(meta.outcome);
  const writeReason = nonBlankMetadataText(meta.write_reason);
  const confidence = nonBlankMetadataText(meta.confidence_tier) ?? entry.confidence;
  const bucket = bucketConfidence(confidence);
  const confidenceLabel = confidenceValueLabel(confidence);
  const sourceMessageIds = boundedSourceIds(meta.source_message_ids);
  const sourceEventIds = boundedSourceIds(meta.source_event_ids);
  const hasMemoryExplanation = Boolean(
    actionType || observation || provenanceKind || outcome || writeReason
      || branchId || sourceMessageIds.length || sourceEventIds.length,
  );
  const timestampLabel = formatTimestamp(entry.timestamp, i18n.language);
  const rowId = `identity-memory-row-${index}`;
  const bodyId = `identity-memory-row-${index}-body`;
  const interactive = truncated;
  const showFullDocument = expanded && truncated;
  const pinDisabled = !entry.pinned && pinCount >= pinCap;

  return (
    <li
      className={[
        'identity-inspector__entry',
        entry.is_compacted ? 'identity-inspector__entry--compacted' : '',
        entry.pinned ? 'identity-inspector__entry--pinned' : '',
      ].filter(Boolean).join(' ')}
      role="listitem"
    >
      <span className="identity-inspector__dot" aria-hidden="true" />
      <article
        className="identity-inspector__card"
        aria-labelledby={rowId}
      >
        <header className="identity-inspector__entry-header">
          <h2 id={rowId} className="identity-inspector__entry-title">
            {memoryType
              ? t(`identity_inspector.type_${memoryType}`, memoryType)
              : t('identity_inspector.entry_title', 'Memory entry')}
          </h2>
          <div className="identity-inspector__entry-header-right">
            {timestampLabel && (
              <time
                className="identity-inspector__timestamp"
                dateTime={entry.timestamp ?? undefined}
              >
                {timestampLabel}
              </time>
            )}
            <button
              type="button"
              className={`identity-inspector__pin-btn ${entry.pinned ? 'identity-inspector__pin-btn--pinned' : ''}`}
              onClick={() => onTogglePin(entry.memory_id || '', !!entry.pinned)}
              disabled={pinDisabled}
              title={pinDisabled ? t('identity_inspector.pin_cap_reached') : undefined}
              aria-label={entry.pinned ? t('identity_inspector.pin_btn_unpin_aria') : t('identity_inspector.pin_btn_pin_aria')}
            >
              {entry.pinned ? '📌' : '📍'}
              <span className="identity-inspector__pin-btn-text">
                {entry.pinned ? t('identity_inspector.pin_btn_unpin') : t('identity_inspector.pin_btn_pin')}
              </span>
            </button>
          </div>
        </header>

        <div className="identity-inspector__chips" role="group" aria-label={t('identity_inspector.metadata_label', 'Memory metadata')}>
          {entry.remembered && (
            <span
              className="identity-inspector__chip identity-inspector__chip--remembered"
              aria-label={t(
                'identity_inspector.query_match_aria',
                'Matched the current memory search query',
              )}
            >
              {t('identity_inspector.query_match_label', 'Query match')}
            </span>
          )}
          {scenarioId && (
            <span className="identity-inspector__chip" title={scenarioId}>
              <span className="identity-inspector__chip-key">
                {t('identity_inspector.chip_scenario', 'Scenario')}
              </span>
              <span className="identity-inspector__chip-value">
                {scenarioId.length > 12 ? `${scenarioId.slice(0, 8)}…` : scenarioId}
              </span>
            </span>
          )}
          {round !== null && (
            <span className="identity-inspector__chip">
              <span className="identity-inspector__chip-key">
                {t('identity_inspector.chip_round', 'Round')}
              </span>
              <span className="identity-inspector__chip-value">R{round}</span>
            </span>
          )}
          {memoryType && (
            <span className="identity-inspector__chip identity-inspector__chip--type">
              {t(`identity_inspector.type_${memoryType}`, memoryType)}
            </span>
          )}
          <span
            className={`identity-inspector__badge identity-inspector__badge--${bucket}`}
            aria-label={`${t('identity_inspector.confidence_label', 'Confidence')}: ${t(
              `identity_inspector.confidence_${bucket}`,
              bucket,
            )}`}
          >
            <span className="identity-inspector__badge-dot" aria-hidden="true" />
            {t(`identity_inspector.confidence_${bucket}`, bucket)}
            {confidenceLabel && (
              <span className="identity-inspector__badge-value">
                {confidenceLabel}
              </span>
            )}
          </span>
          {entry.is_compacted && (
            <span
              className="identity-inspector__pill identity-inspector__pill--compacted"
              aria-label={t('identity_inspector.compacted_aria', 'Compacted memory entry')}
            >
              {t('identity_inspector.compacted_label', 'compacted')}
            </span>
          )}
        </div>

        <p
          id={bodyId}
          className="identity-inspector__document"
        >
          {showFullDocument ? document : preview}
        </p>

        {interactive && (
          <button
            type="button"
            className="identity-inspector__expand-btn"
            onClick={() => onToggle(index)}
            aria-expanded={expanded}
            aria-controls={bodyId}
          >
            {expanded
              ? t('identity_inspector.collapse', 'Show less')
              : t('identity_inspector.expand', 'Show more')}
          </button>
        )}

        {hasMemoryExplanation && (
          <details className="identity-inspector__memory-explanation">
            <summary className="identity-inspector__expand-btn">
              {t('identity_inspector.why_remembered', 'Why this was remembered')}
            </summary>
            <dl className="identity-inspector__memory-explanation-list">
              {actionType && (
                <div>
                  <dt>{t('identity_inspector.action_type', 'Action')}</dt>
                  <dd>{actionType}</dd>
                </div>
              )}
              {observation && (
                <div>
                  <dt>{t('identity_inspector.observation', 'Observation')}</dt>
                  <dd>{observation}</dd>
                </div>
              )}
              {outcome && (
                <div>
                  <dt>{t('identity_inspector.outcome', 'Outcome')}</dt>
                  <dd>{outcome}</dd>
                </div>
              )}
              {writeReason && (
                <div>
                  <dt>{t('identity_inspector.write_reason', 'Write reason')}</dt>
                  <dd>{writeReason}</dd>
                </div>
              )}
              {provenanceKind && (
                <div>
                  <dt>{t('identity_inspector.provenance', 'Provenance')}</dt>
                  <dd>{provenanceKind}</dd>
                </div>
              )}
              {branchId && (
                <div>
                  <dt>{t('identity_inspector.branch', 'Branch')}</dt>
                  <dd title={branchId}>{truncatePreview(branchId, SOURCE_ID_PREVIEW_CHARS).preview}</dd>
                </div>
              )}
              {sourceMessageIds.length > 0 && (
                <div>
                  <dt>{t('identity_inspector.source_messages', 'Source messages')}</dt>
                  <dd>
                    {sourceMessageIds.map((sourceId, sourceIndex) => (
                      <code key={`${sourceId}-${sourceIndex}`} title={sourceId}>
                        {truncatePreview(sourceId, SOURCE_ID_PREVIEW_CHARS).preview}
                      </code>
                    ))}
                  </dd>
                </div>
              )}
              {sourceEventIds.length > 0 && (
                <div>
                  <dt>{t('identity_inspector.source_events', 'Source events')}</dt>
                  <dd>
                    {sourceEventIds.map((sourceId, sourceIndex) => (
                      <code key={`${sourceId}-${sourceIndex}`} title={sourceId}>
                        {truncatePreview(sourceId, SOURCE_ID_PREVIEW_CHARS).preview}
                      </code>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </details>
        )}
      </article>
    </li>
  );
}

function SkeletonRow() {
  return (
    <li className="identity-inspector__entry identity-inspector__entry--skeleton" aria-hidden="true">
      <span className="identity-inspector__dot identity-inspector__dot--skeleton" />
      <div className="identity-inspector__card identity-inspector__card--skeleton">
        <div className="identity-inspector__skeleton-line identity-inspector__skeleton-line--title" />
        <div className="identity-inspector__skeleton-line identity-inspector__skeleton-line--meta" />
        <div className="identity-inspector__skeleton-line identity-inspector__skeleton-line--body" />
        <div className="identity-inspector__skeleton-line identity-inspector__skeleton-line--body identity-inspector__skeleton-line--short" />
      </div>
    </li>
  );
}

export function IdentityInspectorView() {
  const { t } = useTranslation();
  const { id: identityId } = useParams<{ id: string }>();
  const {
    loading: capLoading,
    enabled,
    error: capabilityError,
    reload: reloadCapability,
  } = useCapabilityCheck('agent_identity');

  const [entries, setEntries] = useState<IdentityMemoryEntry[] | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(() => new Set());
  const [identityName, setIdentityName] = useState<string | null>(null);
  const memoryRequestSeqRef = useRef(0);
  const activeMemoryRequestRef = useRef<AbortController | null>(null);

  // F7 States
  const [searchVal, setSearchVal] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [pinCount, setPinCount] = useState<number>(0);
  const [pinCap, setPinCap] = useState<number>(20);
  const [pinError, setPinError] = useState<string | null>(null);

  // Debounce search query
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(searchVal);
    }, 300);
    return () => {
      clearTimeout(handler);
    };
  }, [searchVal]);

  const loadMemories = useCallback(async () => {
    if (!identityId) return;
    const requestSeq = memoryRequestSeqRef.current + 1;
    memoryRequestSeqRef.current = requestSeq;
    activeMemoryRequestRef.current?.abort();
    const controller = new AbortController();
    activeMemoryRequestRef.current = controller;

    const isStaleRequest = () =>
      requestSeq !== memoryRequestSeqRef.current || controller.signal.aborted;

    setLoading(true);
    setErrorMessage(null);
    setPinError(null);
    setExpandedIndices(new Set());
    try {
      const res = debouncedQuery
        ? await getIdentityMemories(identityId, debouncedQuery, { signal: controller.signal })
        : await getIdentityMemories(identityId, { signal: controller.signal });
      if (isStaleRequest()) return;
      const memories = Array.isArray(res?.memories) ? res.memories : [];
      setEntries(memories);
      setTotal(typeof res?.total === 'number' ? res.total : memories.length);
      const initialPinCount = memories.filter((m) => m.pinned).length;
      setPinCount(initialPinCount);

      if (res?.diagnostics?.message) {
        setErrorMessage(res.diagnostics.message);
      } else if (res?.error) {
        setErrorMessage(t(`identity_inspector.error_${res.error}`, res.error) as string);
      }
    } catch (err) {
      if (isStaleRequest()) return;
      const fallback = t('identity_inspector.error_load', 'Failed to load identity memories.') as string;
      let message = fallback;
      if (isApiError(err)) {
        message = err.status === 404
          ? t('identity_inspector.error_not_found', 'Identity not found.') as string
          : fallback;
        if (err.status !== 404) {
          console.debug('[IdentityInspectorView] Failed to load memories', err);
        }
      } else if (err instanceof Error) {
        console.debug('[IdentityInspectorView] Failed to load memories', err);
      }
      setEntries([]);
      setTotal(0);
      setErrorMessage(message);
    } finally {
      if (requestSeq === memoryRequestSeqRef.current) {
        activeMemoryRequestRef.current = null;
        setLoading(false);
      }
    }
  }, [identityId, debouncedQuery, t]);

  const handleTogglePin = useCallback(async (memoryId: string, currentlyPinned: boolean) => {
    if (!identityId) return;
    setPinError(null);
    try {
      if (currentlyPinned) {
        const res = await unpinIdentityMemory(identityId, memoryId);
        const pinRes = res as {
          pin_count: number;
          cap: number;
          diagnostics?: { message: string } | null;
          error?: string;
        };
        if (pinRes.diagnostics?.message) {
          setPinError(pinRes.diagnostics.message);
        } else if (pinRes.error) {
          setPinError(t(`identity_inspector.error_${pinRes.error}`, pinRes.error) as string);
        } else {
          setEntries((prev) =>
            prev
              ? prev.map((entry) =>
                  entry.memory_id === memoryId ? { ...entry, pinned: false } : entry
                )
              : null
          );
          setPinCount(pinRes.pin_count);
          setPinCap(pinRes.cap);
        }
      } else {
        const res = await pinIdentityMemory(identityId, memoryId);
        const pinRes = res as {
          pin_count: number;
          cap: number;
          diagnostics?: { message: string } | null;
          error?: string;
        };
        if (pinRes.diagnostics?.message) {
          setPinError(pinRes.diagnostics.message);
        } else if (pinRes.error) {
          setPinError(t(`identity_inspector.error_${pinRes.error}`, pinRes.error) as string);
        } else {
          setEntries((prev) =>
            prev
              ? prev.map((entry) =>
                  entry.memory_id === memoryId ? { ...entry, pinned: true } : entry
                )
              : null
          );
          setPinCount(pinRes.pin_count);
          setPinCap(pinRes.cap);
        }
      }
    } catch (err) {
      if (isApiError(err) && err.code === 'IDENTITY_MEMORY_PIN_LIMIT_REACHED') {
        setPinError(t('identity_inspector.pin_limit_error', 'At most 20 memories can be pinned per identity.') as string);
        setPinCount(pinCap);
      } else {
        setPinError(t('identity_inspector.pin_error', 'Failed to toggle pin state.') as string);
      }
    }
  }, [identityId, t, pinCap]);

  // Resolve identity display name (best-effort, non-blocking for the timeline).
  useEffect(() => {
    setIdentityName(null);
    if (!enabled || !identityId) return;
    let cancelled = false;
    const userId = getSessionBoundUserId();
    listAgentIdentities<AgentIdentityInfo[]>(userId)
      .then((list) => {
        if (cancelled) return;
        if (Array.isArray(list)) {
          const match = list.find((agent) => agent.id === identityId);
          setIdentityName(match?.display_name || null);
        }
      })
      .catch(() => {
        // Name lookup is best-effort; ignore failures and fall back to identity id.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, identityId]);

  useEffect(() => {
    if (!enabled || capabilityError) {
      memoryRequestSeqRef.current += 1;
      activeMemoryRequestRef.current?.abort();
      activeMemoryRequestRef.current = null;
      return;
    }
    void loadMemories();
    return () => {
      memoryRequestSeqRef.current += 1;
      activeMemoryRequestRef.current?.abort();
      activeMemoryRequestRef.current = null;
    };
  }, [enabled, capabilityError, loadMemories]);

  const sortedEntries = useMemo(() => {
    if (!entries) return [];
    return [...entries].sort(compareTimestampsDesc);
  }, [entries]);

  const handleToggleEntry = useCallback((index: number) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // ── Capability gate states ───────────────────────────
  if (capLoading) {
    return (
      <div className="identity-inspector identity-inspector--state">
        <p className="identity-inspector__state-text">{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  if (capabilityError) {
    return (
      <div className="identity-inspector identity-inspector--state">
        <h1 className="identity-inspector__title">
          {t('identity_inspector.title', 'Identity Memory Inspector')}
        </h1>
        <p className="identity-inspector__state-text">
          {t(
            'identity_inspector.capability_error',
            'Unable to confirm whether agent identity is available right now.',
          )}
        </p>
        <div className="identity-inspector__actions">
          <button
            type="button"
            className="identity-inspector__btn"
            onClick={() => void reloadCapability?.()}
          >
            {t('common.retry', 'Retry')}
          </button>
          <Link to="/agents" className="identity-inspector__link">
            {t('identity_inspector.back_to_library', 'Back to Agent Library')}
          </Link>
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="identity-inspector identity-inspector--state">
        <h1 className="identity-inspector__title">
          {t('identity_inspector.title', 'Identity Memory Inspector')}
        </h1>
        <p className="identity-inspector__state-text">
          {t(
            'identity_inspector.feature_disabled',
            'Agent identity memory is not enabled on this server.',
          )}
        </p>
        <Link to="/agents" className="identity-inspector__link">
          {t('identity_inspector.back_to_library', 'Back to Agent Library')}
        </Link>
      </div>
    );
  }

  if (!identityId) {
    return (
      <div className="identity-inspector identity-inspector--state">
        <p className="identity-inspector__state-text">
          {t('identity_inspector.missing_id', 'No identity selected.')}
        </p>
        <Link to="/agents" className="identity-inspector__link">
          {t('identity_inspector.back_to_library', 'Back to Agent Library')}
        </Link>
      </div>
    );
  }

  const hasEntries = sortedEntries.length > 0;

  return (
    <div className="identity-inspector">
      <header className="identity-inspector__header">
        <div className="identity-inspector__header-left">
          <Link
            to="/agents"
            className="identity-inspector__back"
            aria-label={t('identity_inspector.back_to_library', 'Back to Agent Library')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 12L6 8L10 4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <div className="identity-inspector__heading">
            <h1 className="identity-inspector__title">
              {identityName
                ? t(
                    'identity_inspector.title_with_name',
                    'Memory of {{name}}',
                    { name: identityName },
                  )
                : t('identity_inspector.title', 'Identity Memory Inspector')}
            </h1>
            <p className="identity-inspector__subtitle">
              {t(
                'identity_inspector.subtitle',
                'Read-only timeline of memories recorded across scenarios.',
              )}
            </p>
          </div>
        </div>
        <div className="identity-inspector__header-right">
          {!loading && !errorMessage && hasEntries && (
            <span className="identity-inspector__count" aria-live="polite">
              {t('identity_inspector.count', '{{count}} entries', { count: total })}
            </span>
          )}
          <button
            type="button"
            className="identity-inspector__btn identity-inspector__btn--ghost"
            onClick={() => void loadMemories()}
            disabled={loading}
          >
            {t('common.refresh', 'Refresh')}
          </button>
        </div>
      </header>

      <main className="identity-inspector__body">
        <div className="identity-inspector__toolbar">
          <div className="identity-inspector__search-wrapper">
            <input
              type="search"
              className="identity-inspector__search-input"
              placeholder={t('identity_inspector.search_placeholder', 'Search memories...')}
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value)}
              aria-label={t('identity_inspector.search_aria', 'Search memories')}
            />
          </div>
        </div>

        {pinError && (
          <div className="identity-inspector__pin-error" role="alert">
            {pinError}
          </div>
        )}

        {loading && (
          <ul
            className="identity-inspector__timeline"
            role="list"
            aria-label={t('identity_inspector.loading_aria', 'Loading memory timeline')}
            aria-busy="true"
          >
            <span className="identity-inspector__axis" aria-hidden="true" />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </ul>
        )}

        {!loading && errorMessage && (
          <div className="identity-inspector__error" role="alert">
            <p className="identity-inspector__error-text">{errorMessage}</p>
            <button
              type="button"
              className="identity-inspector__btn"
              onClick={() => void loadMemories()}
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        )}

        {!loading && !errorMessage && !hasEntries && (
          <div className="identity-inspector__empty">
            <div className="identity-inspector__empty-icon" aria-hidden="true">📭</div>
            <h2 className="identity-inspector__empty-title">
              {t('identity_inspector.empty_title', 'No memories recorded yet')}
            </h2>
            <p className="identity-inspector__empty-text">
              {t(
                'identity_inspector.empty_text',
                'This identity has not yet recorded any memory entries. Run a scenario with this agent to start populating the timeline.',
              )}
            </p>
          </div>
        )}

        {!loading && !errorMessage && hasEntries && (
          <ul
            className="identity-inspector__timeline"
            role="list"
            aria-label={t('identity_inspector.timeline_aria', 'Identity memory timeline')}
          >
            <span className="identity-inspector__axis" aria-hidden="true" />
            {sortedEntries.map((entry, index) => (
              <MemoryRow
                key={`${entry.timestamp ?? 'no-ts'}-${index}`}
                entry={entry}
                index={index}
                expanded={expandedIndices.has(index)}
                onToggle={handleToggleEntry}
                onTogglePin={handleTogglePin}
                pinCount={pinCount}
                pinCap={pinCap}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

export default IdentityInspectorView;
