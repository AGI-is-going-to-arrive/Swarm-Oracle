/* ═══════════════════════════════════════════════════════════
   EducationTemplatePicker — modal grid of education templates.
   Filter by category + difficulty, locale-aware title/description.
   ═══════════════════════════════════════════════════════════ */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { listEducationTemplates, type EducationTemplate } from '../api/client';
import { useFocusTrap } from '../hooks/useFocusTrap';
import './EducationTemplatePicker.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (template: EducationTemplate) => void;
  /** Optional override for tests — when provided, network calls are skipped. */
  templates?: EducationTemplate[];
}

const DIFFICULTY_ORDER = ['beginner', 'intermediate', 'advanced'] as const;
type Difficulty = (typeof DIFFICULTY_ORDER)[number];

function isKnownDifficulty(value: string): value is Difficulty {
  return (DIFFICULTY_ORDER as readonly string[]).includes(value);
}

function getLocalizedTitle(tpl: EducationTemplate, language: string): string {
  if (language.startsWith('zh')) {
    return tpl.title_zh || tpl.title_en || tpl.id;
  }
  return tpl.title_en || tpl.title_zh || tpl.id;
}

function getLocalizedDescription(tpl: EducationTemplate, language: string): string {
  if (language.startsWith('zh')) {
    return tpl.description_zh || tpl.description_en || '';
  }
  return tpl.description_en || tpl.description_zh || '';
}

export function EducationTemplatePicker({
  open,
  onClose,
  onSelect,
  templates: templatesProp,
}: Props) {
  const { t, i18n } = useTranslation();

  const [templates, setTemplates] = useState<EducationTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [difficultyFilter, setDifficultyFilter] = useState<string>('');

  const requestIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, open);

  const resetFilters = useCallback(() => {
    setCategoryFilter('');
    setDifficultyFilter('');
  }, []);

  const closePicker = useCallback(() => {
    resetFilters();
    onClose();
  }, [onClose, resetFilters]);

  const fetchTemplates = useCallback(() => {
    if (templatesProp !== undefined) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setLoaded(false);
    setError(null);

    listEducationTemplates()
      .then((res) => {
        if (requestId !== requestIdRef.current) return;
        setError(null);
        setTemplates(Array.isArray(res?.templates) ? res.templates : []);
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        if (err instanceof Error) {
          console.debug('[EducationTemplatePicker] Failed to load templates', err);
        }
        setTemplates([]);
        setError('education.templates_error');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
        setLoaded(true);
      });
  }, [templatesProp]);

  // Fetch templates when opened (unless templates injected via prop for tests).
  useEffect(() => {
    if (!open) return;
    fetchTemplates();
  }, [fetchTemplates, open]);

  // Escape closes the picker.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePicker();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, closePicker]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    const source = templatesProp ?? templates;
    for (const tpl of source) {
      if (tpl.category) seen.add(tpl.category);
    }
    return Array.from(seen).sort();
  }, [templates, templatesProp]);

  const filtered = useMemo(() => {
    const source = templatesProp ?? templates;
    return source.filter((tpl) => {
      if (categoryFilter && tpl.category !== categoryFilter) return false;
      if (difficultyFilter && tpl.difficulty !== difficultyFilter) return false;
      return true;
    });
  }, [templates, templatesProp, categoryFilter, difficultyFilter]);

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) closePicker();
    },
    [closePicker],
  );

  const difficultyLabel = useCallback(
    (value: string): string => {
      if (isKnownDifficulty(value)) {
        return t(`education.difficulty_${value}`);
      }
      return value;
    },
    [t],
  );

  if (!open) return null;

  const hasLoadedTemplates = templatesProp !== undefined || loaded;
  const showLoading = templatesProp === undefined && (loading || (!loaded && !error));

  return (
    <div
      className="edu-picker-overlay"
      role="presentation"
      onClick={handleOverlayClick}
      data-testid="edu-picker-overlay"
    >
      <div
        ref={dialogRef}
        className="edu-picker-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('education.templates_title')}
        tabIndex={-1}
      >
        <header className="edu-picker-header">
          <h2 className="edu-picker-title">{t('education.templates_title')}</h2>
          <button
            type="button"
            className="edu-picker-close"
            onClick={closePicker}
            aria-label={t('education.close', 'Close')}
          >
            ×
          </button>
        </header>

        <div className="edu-picker-filters">
          <label className="edu-picker-filter">
            <span className="edu-picker-filter-label">
              {t('education.filter_category')}
            </span>
            <select
              className="edu-picker-select"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label={t('education.filter_category')}
            >
              <option value="">{t('education.filter_all', 'All')}</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </label>

          <div className="edu-picker-filter" role="group" aria-label={t('education.filter_difficulty')}>
            <span className="edu-picker-filter-label">
              {t('education.filter_difficulty')}
            </span>
            <div className="edu-picker-pills">
              <button
                type="button"
                className={`edu-picker-pill${difficultyFilter === '' ? ' edu-picker-pill--active' : ''}`}
                onClick={() => setDifficultyFilter('')}
                aria-pressed={difficultyFilter === ''}
              >
                {t('education.filter_all', 'All')}
              </button>
              {DIFFICULTY_ORDER.map((diff) => (
                <button
                  key={diff}
                  type="button"
                  className={`edu-picker-pill edu-picker-pill--${diff}${
                    difficultyFilter === diff ? ' edu-picker-pill--active' : ''
                  }`}
                  onClick={() => setDifficultyFilter(diff)}
                  aria-pressed={difficultyFilter === diff}
                >
                  {difficultyLabel(diff)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="edu-picker-body">
          {showLoading && (
            <p className="edu-picker-status" role="status">
              {t('education.templates_loading', 'Loading templates…')}
            </p>
          )}
          {!showLoading && error && (
            <div className="edu-picker-error" role="alert">
              <p>
                {error === 'education.templates_error'
                  ? t('education.templates_error', 'Could not load templates. Please retry.')
                  : error}
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={fetchTemplates}
              >
                {t('common.retry', 'Retry')}
              </button>
            </div>
          )}
          {!showLoading && !error && hasLoadedTemplates && filtered.length === 0 && (
            <p className="edu-picker-empty" role="status">
              {t('education.no_templates')}
            </p>
          )}
          {!showLoading && !error && filtered.length > 0 && (
            <div className="edu-picker-grid" data-testid="edu-picker-grid">
              {filtered.map((tpl) => {
                const title = getLocalizedTitle(tpl, i18n.language);
                const description = getLocalizedDescription(tpl, i18n.language);
                const difficultyClass = isKnownDifficulty(tpl.difficulty)
                  ? `edu-difficulty-badge--${tpl.difficulty}`
                  : 'edu-difficulty-badge--unknown';
                return (
                  <article
                    key={tpl.id}
                    className="edu-template-card"
                    data-testid={`edu-template-card-${tpl.id}`}
                  >
                    <div className="edu-template-card__head">
                      <h3 className="edu-template-card__title">{title}</h3>
                      <span
                        className={`edu-difficulty-badge ${difficultyClass}`}
                        aria-label={`${t('education.filter_difficulty')}: ${difficultyLabel(tpl.difficulty)}`}
                      >
                        {difficultyLabel(tpl.difficulty)}
                      </span>
                    </div>
                    {description && (
                      <p className="edu-template-card__desc">{description}</p>
                    )}
                    <p className="edu-template-card__meta">
                      {t('education.suggested_config', {
                        agents: tpl.suggested_agents,
                        rounds: tpl.suggested_rounds,
                      })}
                    </p>
                    {tpl.tags && tpl.tags.length > 0 && (
                      <div className="edu-template-card__tags" aria-label={t('education.tags', 'Tags')}>
                        {tpl.tags.map((tag) => (
                          <span key={tag} className="edu-template-card__tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn btn-primary edu-template-card__cta"
                      onClick={() => {
                        resetFilters();
                        onSelect(tpl);
                      }}
                    >
                      {t('education.select_template')}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default EducationTemplatePicker;
