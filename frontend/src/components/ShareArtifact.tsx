/* ═══════════════════════════════════════════════════════════
   P2-4 — ShareArtifact
   Offscreen 1200x630 OG-card image generator. Captures the rendered
   DOM with html2canvas and downloads as PNG. NEVER include sensitive
   config (api keys / base urls); only outcome + source family +
   first-3 agent display data.
   ═══════════════════════════════════════════════════════════ */

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { BranchInfo } from '../types';
import './ShareArtifact.css';

export interface ShareArtifactProps {
  question: string;
  branches: BranchInfo[];
  agentNames?: string[];
  sourceFamilies?: string[];
  /** Called after PNG download finishes (success OR failure). */
  onExport?: () => void;
}

export interface ShareArtifactHandle {
  /** Triggers PNG capture + download. Resolves to true on success. */
  exportPng: () => Promise<boolean>;
}

/** Source family keys we know how to colour. Anything else falls back to
    the neutral chip style — we still render the raw key so users can
    self-debug what was passed in. */
const KNOWN_SOURCE_FAMILIES = new Set(['polymarket', 'finance', 'academic', 'news_deep']);

function pickDominantBranch(branches: BranchInfo[]): BranchInfo | null {
  if (!branches || branches.length === 0) return null;
  // Prefer COMPLETED branches; among those, highest probability wins.
  // If none completed, use highest probability across all.
  const completed = branches.filter((b) => b.status === 'COMPLETED');
  const pool = completed.length > 0 ? completed : branches;
  return pool.reduce<BranchInfo | null>((best, current) => {
    if (!best) return current;
    const bp = typeof best.probability === 'number' ? best.probability : 0;
    const cp = typeof current.probability === 'number' ? current.probability : 0;
    return cp > bp ? current : best;
  }, null);
}

function formatProbability(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  // BranchInfo.probability is 0..1
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return `${pct.toFixed(0)}%`;
}

function formatTimestamp(date: Date): string {
  // YYYY-MM-DD HH:mm — locale-neutral, deterministic for regression tests.
  const pad = (n: number) => n.toString().padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

function downloadPngBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Defer revoke so the download has time to start in slow browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const ShareArtifact = forwardRef<ShareArtifactHandle, ShareArtifactProps>(
  function ShareArtifact(props, ref) {
    const { question, branches, agentNames, sourceFamilies, onExport } = props;
    const { t } = useTranslation();
    const cardRef = useRef<HTMLDivElement | null>(null);

    const dominant = useMemo(() => pickDominantBranch(branches ?? []), [branches]);
    const dominantTitle = dominant?.title?.trim() || t('share.artifact_no_outcome', 'Pending');
    const dominantInsight = dominant?.insight?.trim() || dominant?.summary?.trim() || '';
    const dominantProb = formatProbability(dominant?.probability);
    const visibleAgents = useMemo(
      () => (agentNames ?? []).filter((n) => typeof n === 'string' && n.trim().length > 0).slice(0, 3),
      [agentNames],
    );
    const visibleSources = useMemo(
      () => (sourceFamilies ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0),
      [sourceFamilies],
    );
    const timestamp = useMemo(() => formatTimestamp(new Date()), []);

    const exportPng = useCallback(async (): Promise<boolean> => {
      const node = cardRef.current;
      if (!node) {
        onExport?.();
        return false;
      }
      try {
        const { html2canvas } = await import('../hooks/screenCaptureHtmlVendor');
        const canvas = await html2canvas(node, {
          // The card already paints its own gradient. Use a solid dark
          // fallback in case the engine fills behind transparent regions.
          backgroundColor: '#0f172a',
          // 2x scale yields a crisp 2400x1260 export while keeping file size sane.
          scale: 2,
          logging: false,
          useCORS: true,
          // Card has fixed 1200x630 layout; pass it explicitly so the off-screen
          // (left:-99999px) parent doesn't confuse html2canvas viewport math.
          width: 1200,
          height: 630,
        });
        const blob: Blob | null = await new Promise((resolve) => {
          canvas.toBlob((b) => resolve(b), 'image/png', 0.95);
        });
        if (!blob) {
          onExport?.();
          return false;
        }
        const filename = `swarmoracle_${Date.now()}.png`;
        downloadPngBlob(blob, filename);
        onExport?.();
        return true;
      } catch (err) {
        // Surface to the caller so the modal can show its error state.
        // We swallow the throw to keep onExport's contract simple.
        console.error('[ShareArtifact] PNG export failed', err);
        onExport?.();
        return false;
      }
    }, [onExport]);

    useImperativeHandle(ref, () => ({ exportPng }), [exportPng]);

    return (
      <div className="share-artifact" aria-hidden="true" data-testid="share-artifact">
        <div className="share-artifact__card" ref={cardRef}>
          <div className="share-artifact__brand">
            <span className="share-artifact__brand-mark">S</span>
            <span>SwarmOracle</span>
          </div>

          <h2 className="share-artifact__question">{question}</h2>

          <div className="share-artifact__outcome">
            <span className="share-artifact__outcome-label">
              {t('share.artifact_outcome', 'Outcome')}
            </span>
            <div className="share-artifact__outcome-title">
              <span className="share-artifact__outcome-branch">{dominantTitle}</span>
              <span className="share-artifact__outcome-prob">{dominantProb}</span>
            </div>
            {dominantInsight && (
              <p className="share-artifact__outcome-insight">{dominantInsight}</p>
            )}
          </div>

          <div className="share-artifact__meta">
            {visibleSources.length > 0 && (
              <div className="share-artifact__sources">
                <span className="share-artifact__meta-label">
                  {t('share.artifact_sources', 'Sources')}
                </span>
                <div className="share-artifact__chips">
                  {visibleSources.map((family) => {
                    const known = KNOWN_SOURCE_FAMILIES.has(family);
                    const className = known
                      ? `share-artifact__chip share-artifact__chip--${family}`
                      : 'share-artifact__chip';
                    return (
                      <span key={family} className={className}>
                        {family}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {visibleAgents.length > 0 && (
              <div className="share-artifact__agents">
                <span className="share-artifact__meta-label">
                  {t('share.artifact_agents', 'Agents')}
                </span>
                <ul className="share-artifact__agent-list">
                  {visibleAgents.map((name) => (
                    <li key={name} className="share-artifact__agent-item">
                      <span className="share-artifact__agent-bullet" />
                      <span>{name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="share-artifact__footer">
            <span className="share-artifact__footer-brand">
              {t('share.artifact_footer', 'Generated by SwarmOracle')}
            </span>
            <span className="share-artifact__footer-timestamp">{timestamp}</span>
          </div>
        </div>
      </div>
    );
  },
);

export default ShareArtifact;
