import React, { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

export const ReportEvidenceDrawer = React.memo(function ReportEvidenceDrawer({
  isOpen,
  onClose,
  scenarioId,
  evidence,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const [shouldRender, setShouldRender] = useState(isOpen);
  const [active, setActive] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      Promise.resolve().then(() => {
        setShouldRender(true);
      });
      const timer = setTimeout(() => {
        setActive(true);
      }, 10);
      return () => clearTimeout(timer);
    } else {
      Promise.resolve().then(() => {
        setActive(false);
      });
      const timer = setTimeout(() => {
        setShouldRender(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // useFocusTrap traps Tab/Shift+Tab inside the dialog and restores focus to the
  // previously-focused trigger on close.
  useFocusTrap(drawerRef, active);

  useEffect(() => {
    if (!active) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';

    // Move initial focus into the dialog (the trap restores it to the trigger on close).
    closeButtonRef.current?.focus();

    // Lock background container (#root)
    const rootEl = document.getElementById('root');
    if (rootEl) {
      rootEl.setAttribute('aria-hidden', 'true');
      rootEl.setAttribute('inert', '');
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
      if (rootEl) {
        rootEl.removeAttribute('aria-hidden');
        rootEl.removeAttribute('inert');
      }
    };
  }, [active, onClose]);

  if (!shouldRender || typeof document === 'undefined') return null;

  const handleDeepLink = (ev: ReportEvidence) => {
    const params = new URLSearchParams({
      branch: ev.branch_id,
      message: ev.message_id,
      round: String(ev.round_number),
    });
    navigate(`/replay/${encodeURIComponent(scenarioId)}?${params.toString()}`);
  };

  return createPortal(
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 motion-reduce:transition-none ${
          active ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('result.report.evidenceDrawer')}
        aria-describedby="evidence-drawer-description"
        className={`fixed right-0 top-0 bottom-0 w-full max-w-md bg-[color:var(--bg-elevated)] shadow-2xl z-50 flex flex-col transform transition-transform duration-300 ease-in-out motion-reduce:transition-none forced-colors:border ${
          active ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-[color:var(--border-subtle)]">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            {t('result.report.citedEvidence')}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="p-2 rounded hover:bg-[color:var(--bg-hover)] text-[color:var(--text-secondary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)]"
            aria-label={t('result.report.closeDrawer')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div id="evidence-drawer-description" className="sr-only">
          {t('result.report.evidenceDrawerDescription', 'Detailed list of cited evidence')}
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {evidence.length === 0 ? (
            <p className="text-[color:var(--text-secondary)]">
              {t('result.report.noEvidence')}
            </p>
          ) : (
            evidence.map((ev) => (
              <div
                key={ev.id}
                className="p-4 rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] flex flex-col space-y-2"
              >
                <div className="flex justify-between items-start">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-[color:var(--text-primary)] break-words [overflow-wrap:anywhere]">
                      {ev.agent_name}
                    </span>
                    <span className="text-xs text-[color:var(--text-muted)] break-words [overflow-wrap:anywhere]">
                      {t('result.report.roundNum', { round: ev.round_number })} ({t(`result.report.evidenceKind.${ev.kind}`, { defaultValue: t('result.report.evidenceKind.default', 'Evidence') })})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeepLink(ev)}
                    className="text-xs px-2 py-1 bg-[color:var(--color-primary)] text-white rounded hover:bg-[color:var(--color-primary-dim)] focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-[color:var(--color-ring)]"
                    aria-label={t('result.report.viewInReplay', { name: ev.agent_name })}
                  >
                    {t('result.report.viewContext')}
                  </button>
                </div>
                <blockquote className="text-sm text-[color:var(--text-secondary)] italic border-l-2 border-[color:var(--color-primary)] pl-3 my-2 break-words [overflow-wrap:anywhere]">
                  &ldquo;{ev.quote}&rdquo;
                </blockquote>
              </div>
            ))
          )}
        </div>
      </div>
    </>,
    document.body
  );
});
