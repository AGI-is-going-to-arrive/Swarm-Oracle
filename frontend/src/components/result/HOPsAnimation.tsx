import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './HOPsAnimation.css';

export interface HOPsBranchInput {
  id: string;
  title?: string;
  probability?: number;
  status?: string;
}

export interface HOPsAnimationProps {
  branches: HOPsBranchInput[];
  isPlaying?: boolean;
}

interface NormalizedBranch {
  id: string;
  title: string;
  probability: number;
  cumulative: number;
}

const SAMPLE_INTERVAL_MS = 800;
const TITLE_MAX_CHARS = 20;
const MIN_BRANCH_COUNT = 2;

function clampProbability(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value > 1) return 1;
  return value;
}

function truncateTitle(raw: string | undefined, fallback: string): string {
  const text = (raw ?? '').trim() || fallback;
  const chars = Array.from(text);
  if (chars.length <= TITLE_MAX_CHARS) return text;
  return `${chars.slice(0, TITLE_MAX_CHARS).join('')}…`;
}

function normalizeBranches(input: HOPsBranchInput[], fallbackLabel: string): NormalizedBranch[] {
  const cleaned = input
    .filter((branch) => branch && typeof branch.id === 'string' && branch.id.length > 0)
    .map((branch, index) => ({
      id: branch.id,
      title: truncateTitle(branch.title, `${fallbackLabel} ${index + 1}`),
      probability: clampProbability(branch.probability),
    }));

  const total = cleaned.reduce((sum, branch) => sum + branch.probability, 0);
  if (total <= 0) {
    const equal = 1 / Math.max(cleaned.length, 1);
    let cumulative = 0;
    return cleaned.map((branch) => {
      cumulative += equal;
      return { ...branch, probability: equal, cumulative };
    });
  }

  let cumulative = 0;
  return cleaned.map((branch) => {
    const normalized = branch.probability / total;
    cumulative += normalized;
    return { ...branch, probability: normalized, cumulative };
  });
}

function pickSampleIndex(branches: NormalizedBranch[], rand: number): number {
  for (let i = 0; i < branches.length; i += 1) {
    if (rand <= branches[i].cumulative) return i;
  }
  return branches.length - 1;
}

export default function HOPsAnimation({ branches, isPlaying = true }: HOPsAnimationProps) {
  const { t } = useTranslation();
  const fallbackLabel = t('hops.branch_fallback', { defaultValue: 'Branch' });
  const normalized = useMemo(() => normalizeBranches(branches, fallbackLabel), [branches, fallbackLabel]);

  const [internalPlaying, setInternalPlaying] = useState<boolean>(isPlaying);
  const [sampleIndex, setSampleIndex] = useState<number>(-1);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const lastSampleAtRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setInternalPlaying(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setPrefersReducedMotion(mq.matches);
      if (mq.matches) {
        setSampleIndex(-1);
      }
    };
    update();
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  useEffect(() => {
    if (normalized.length < MIN_BRANCH_COUNT) return;
    if (!internalPlaying) return;
    if (prefersReducedMotion) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;

    const tick = (timestamp: number) => {
      if (lastSampleAtRef.current === 0) {
        lastSampleAtRef.current = timestamp;
      }
      if (timestamp - lastSampleAtRef.current >= SAMPLE_INTERVAL_MS) {
        const rand = Math.random();
        const next = pickSampleIndex(normalized, rand);
        setSampleIndex(next);
        lastSampleAtRef.current = timestamp;
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastSampleAtRef.current = 0;
    };
  }, [normalized, internalPlaying, prefersReducedMotion]);

  const togglePlay = useCallback(() => {
    setInternalPlaying((prev) => !prev);
  }, []);

  if (normalized.length < MIN_BRANCH_COUNT) {
    return null;
  }

  const playLabel = internalPlaying
    ? t('hops.pause', { defaultValue: 'Pause' })
    : t('hops.play', { defaultValue: 'Play' });
  const titleLabel = t('hops.title', { defaultValue: 'Probability sampling' });
  const subtitleLabel = t('hops.subtitle', {
    defaultValue: 'Each frame samples one branch based on its probability.',
  });
  const ariaLabel = t('hops.aria_label', {
    defaultValue: 'Hypothetical outcome plot animation',
  });
  const sampledLabel = t('hops.sampled_label', { defaultValue: 'sampled' });

  return (
    <section
      className="hops"
      role="figure"
      aria-label={ariaLabel}
      data-playing={internalPlaying ? 'true' : 'false'}
    >
      <header className="hops__header">
        <div className="hops__heading">
          <h3 className="hops__title">{titleLabel}</h3>
          <p className="hops__subtitle">{subtitleLabel}</p>
        </div>
        <button
          type="button"
          className="hops__control"
          onClick={togglePlay}
          aria-pressed={internalPlaying}
        >
          <span aria-hidden="true" className="hops__control-icon">
            {internalPlaying ? '❚❚' : '▶'}
          </span>
          <span className="hops__control-label">{playLabel}</span>
        </button>
      </header>
      <ul className="hops__list" aria-live="off">
        {normalized.map((branch, index) => {
          const isHighlighted = index === sampleIndex;
          const widthPct = Math.max(branch.probability * 100, 2);
          const probPct = Math.round(branch.probability * 100);
          return (
            <li
              key={branch.id}
              className="hops__row"
              data-highlighted={isHighlighted ? 'true' : 'false'}
            >
              <span className="hops__row-title" title={branch.title}>
                {branch.title}
              </span>
              <span className="hops__bar-track" aria-hidden="true">
                <span className="hops__bar" style={{ width: `${widthPct}%` }} />
              </span>
              <span className="hops__prob">
                <span className="hops__prob-value">{probPct}%</span>
                {isHighlighted && <span className="hops__prob-flag">{sampledLabel}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
