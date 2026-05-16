import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import gsap from 'gsap';
import useReducedMotion from '../../hooks/useReducedMotion';
import './CounterfactualBrand.css';

interface CounterfactualBranchLike {
  id: string;
  title: string;
  parent_branch_id: string | null;
  fork_reason?: string;
  fork_round?: number | null;
  insight?: string;
  probability?: number;
}

interface CounterfactualBrandProps {
  branches: CounterfactualBranchLike[];
  scenarioId: string;
  onExplore: (sourceBranchId: string, round: number) => void;
}

interface ForkPoint {
  branchId: string;
  sourceBranchId: string;
  round: number;
  title: string;
  reason: string;
  insight: string;
}

const MAX_FORK_HIGHLIGHT = 3;

function isUsableForkRound(value: number | null | undefined): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 1
  );
}

function pickForkPoints(branches: CounterfactualBranchLike[]): ForkPoint[] {
  const candidates = branches.filter((branch) => {
    if (!branch.parent_branch_id) return false;
    if (!isUsableForkRound(branch.fork_round)) return false;
    return Boolean(branch.fork_reason || branch.insight || branch.title);
  });
  candidates.sort((a, b) => {
    const probDelta = (b.probability ?? 0) - (a.probability ?? 0);
    if (probDelta !== 0) return probDelta;
    return (a.fork_round ?? 0) - (b.fork_round ?? 0);
  });
  return candidates.slice(0, MAX_FORK_HIGHLIGHT).map((branch) => ({
    branchId: branch.id,
    sourceBranchId: branch.parent_branch_id ?? branch.id,
    round: branch.fork_round ?? 1,
    title: branch.title,
    reason: branch.fork_reason ?? '',
    insight: branch.insight ?? '',
  }));
}

function ClockReverseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <circle cx="24" cy="24" r="14" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path
        d="M24 12 L24 24 L15 30"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 18 C 11 23, 11 30, 14 35"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M14 18 L 11 17.5 M14 18 L 13.5 14.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.7"
      />
      <circle cx="24" cy="24" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function CounterfactualBrand({ branches, scenarioId: _scenarioId, onExplore }: CounterfactualBrandProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLElement | null>(null);
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const eyebrowRef = useRef<HTMLSpanElement | null>(null);
  const forkListRef = useRef<HTMLOListElement | null>(null);
  const ctaRef = useRef<HTMLDivElement | null>(null);

  void _scenarioId;

  const forkPoints = useMemo(() => pickForkPoints(branches), [branches]);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const root = containerRef.current;
    if (!root) return;

    const targets: Element[] = [];
    if (eyebrowRef.current) targets.push(eyebrowRef.current);
    if (iconRef.current) targets.push(iconRef.current);
    if (titleRef.current) targets.push(titleRef.current);
    if (forkListRef.current) {
      Array.from(forkListRef.current.children).forEach((child) => targets.push(child));
    }
    if (ctaRef.current) targets.push(ctaRef.current);

    if (targets.length === 0) return;

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
      tl.fromTo(
        root,
        { filter: 'sepia(1) saturate(0.7) brightness(0.88)' },
        { filter: 'sepia(0) saturate(1) brightness(1)', duration: 1.2, ease: 'power2.inOut' },
        0,
      );
      tl.fromTo(
        targets,
        { autoAlpha: 0, y: 8 },
        { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.08 },
        0.15,
      );
    }, root);

    return () => ctx.revert();
  }, [prefersReducedMotion, forkPoints.length]);

  const handleExploreClick = useCallback(
    (branchId: string, round: number) => () => {
      onExplore(branchId, round);
    },
    [onExplore],
  );

  if (forkPoints.length === 0) {
    return null;
  }

  return (
    <aside
      ref={containerRef}
      className="cf-brand"
      aria-labelledby="cf-brand-title"
      data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
    >
      <div className="cf-brand__inner">
        <div className="cf-brand__header">
          <span ref={iconRef} className="cf-brand__icon" aria-hidden="true">
            <ClockReverseIcon className="cf-brand__icon-svg" />
          </span>
          <div className="cf-brand__heading">
            <span ref={eyebrowRef} className="cf-brand__eyebrow">
              {t('counterfactual_brand.eyebrow', '时钟倒拨')}
            </span>
            <h3 id="cf-brand-title" ref={titleRef} className="cf-brand__title">
              {t('counterfactual_brand.title', '探索另一种可能')}
            </h3>
            <p className="cf-brand__desc">
              {t(
                'counterfactual_brand.desc',
                '回到关键分叉点,改写一句话,看世界线如何重新缝合。',
              )}
            </p>
          </div>
        </div>

        <ol ref={forkListRef} className="cf-brand__forks" aria-label={t('counterfactual_brand.fork_list_label', '可回溯的分叉点')}>
          {forkPoints.map((fork) => {
            const description = fork.insight || fork.reason || fork.title;
            return (
              <li key={fork.branchId} className="cf-brand__fork">
                <div className="cf-brand__fork-meta">
                  <span className="cf-brand__fork-round">
                    {t('counterfactual_brand.round_label', '第 {{round}} 轮', { round: fork.round })}
                  </span>
                  <span className="cf-brand__fork-title">{fork.title}</span>
                </div>
                <p className="cf-brand__fork-desc">{description}</p>
                <button
                  type="button"
                  className="cf-brand__fork-cta"
                  onClick={handleExploreClick(fork.sourceBranchId, fork.round)}
                  aria-label={t('counterfactual_brand.explore_aria', '回到第 {{round}} 轮探索 {{title}}', {
                    round: fork.round,
                    title: fork.title,
                  })}
                >
                  <span>{t('counterfactual_brand.explore_cta', '回到第 {{round}} 轮', { round: fork.round })}</span>
                  <span className="cf-brand__fork-arrow" aria-hidden="true">↺</span>
                </button>
              </li>
            );
          })}
        </ol>

        <div ref={ctaRef} className="cf-brand__footer">
          <span className="cf-brand__hint">
            {t('counterfactual_brand.hint', '从下方编辑器中改写发言,即可生成新分支与原线对比。')}
          </span>
        </div>
      </div>
    </aside>
  );
}

export default CounterfactualBrand;
