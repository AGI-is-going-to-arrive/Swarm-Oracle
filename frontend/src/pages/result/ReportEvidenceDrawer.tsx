import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { ReportEvidence } from '../../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scenarioId: string;
  evidence: ReportEvidence[];
}

// Localized labels for the EvidenceKind enum — never show the raw enum value to users.
const EVIDENCE_KIND_LABELS: Record<string, { zh: string; en: string }> = {
  utterance: { zh: '发言', en: 'Utterance' },
  causal_fact: { zh: '因果事实', en: 'Causal fact' },
  faction_event: { zh: '阵营事件', en: 'Faction event' },
  interview: { zh: '访谈', en: 'Interview' },
};

function kindLabel(kind: string, isZh: boolean): string {
  const entry = EVIDENCE_KIND_LABELS[kind];
  if (!entry) return isZh ? '证据' : 'Evidence';
  return isZh ? entry.zh : entry.en;
}

export function ReportEvidenceDrawer({ isOpen, onClose, scenarioId, evidence }: Props) {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // useFocusTrap traps Tab/Shift+Tab inside the dialog and restores focus to the
  // previously-focused trigger on close.
  useFocusTrap(drawerRef, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';
    // Move initial focus into the dialog (the trap restores it to the trigger on close).
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isZh = i18n.language.startsWith('zh');

  const handleDeepLink = (ev: ReportEvidence) => {
    // Message-level deep link (H12). `round` is the simulation round; ReplayView maps it
    // to its current frame index because frame numbers can differ from round numbers.
    const params = new URLSearchParams({
      branch: ev.branch_id,
      message: ev.message_id,
      round: String(ev.round_number),
    });
    navigate(`/replay/${encodeURIComponent(scenarioId)}?${params.toString()}`);
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-40 transition-opacity motion-reduce:transition-none"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={isZh ? '证据抽屉' : 'Evidence Drawer'}
        className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[color:var(--bg-elevated)] shadow-2xl z-50 flex flex-col transform transition-transform duration-300 motion-reduce:transition-none forced-colors:border"
      >
        <div className="flex items-center justify-between p-4 border-b border-[color:var(--border-subtle)]">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            {isZh ? '引用证据' : 'Cited Evidence'}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="p-2 rounded hover:bg-[color:var(--bg-hover)] text-[color:var(--text-secondary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)]"
            aria-label={isZh ? '关闭抽屉' : 'Close drawer'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {evidence.length === 0 ? (
            <p className="text-[color:var(--text-secondary)]">
              {isZh ? '此报告暂无详细证据引用。' : 'No detailed evidence cited in this report.'}
            </p>
          ) : (
            evidence.map((ev) => (
              <div
                key={ev.id}
                className="p-4 rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] flex flex-col space-y-2"
              >
                <div className="flex justify-between items-start">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-[color:var(--text-primary)]">
                      {ev.agent_name}
                    </span>
                    <span className="text-xs text-[color:var(--text-muted)]">
                      {isZh ? `第 ${ev.round_number} 轮` : `Round ${ev.round_number}`} ({kindLabel(ev.kind, isZh)})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeepLink(ev)}
                    className="text-xs px-2 py-1 bg-[color:var(--color-primary)] text-white rounded hover:bg-[color:var(--color-primary-dim)] focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-[color:var(--color-ring)]"
                    aria-label={`${isZh ? '在回放中查看' : 'View in replay for'} ${ev.agent_name}`}
                  >
                    {isZh ? '查看上下文' : 'View Context'}
                  </button>
                </div>
                <blockquote className="text-sm text-[color:var(--text-secondary)] italic border-l-2 border-[color:var(--color-primary)] pl-3 my-2">
                  &ldquo;{ev.quote}&rdquo;
                </blockquote>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
