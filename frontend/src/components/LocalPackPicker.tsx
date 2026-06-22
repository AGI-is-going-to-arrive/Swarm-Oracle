import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import {
  listLocalPacks,
  getLocalPack,
  refreshLocalPacks,
  getLocalPackDiagnostics,
} from '../api/client';
import type {
  LocalPackSummary,
  LocalPack,
  PackDiagnostic,
  LocalizedText,
  SuggestedSettings,
} from '../types';
import { copyText } from '../lib/copyText';
import './LocalPackPicker.css';

interface GenreMeta {
  key: string;
  raw: string;
  color: string;
}

// 统一 5 类 genre 暖色色点（paper/ink 调性，禁紫/禁霓虹）；按 pack.genre 原始串匹配（注意 'historical what-if' 含空格）
const GENRE_META: GenreMeta[] = [
  { key: 'society', raw: 'society', color: '#b5703f' },
  { key: 'business', raw: 'business', color: '#b8863a' },
  { key: 'culture', raw: 'culture', color: '#a8625e' },
  { key: 'technology', raw: 'technology', color: '#5f7a63' },
  { key: 'historical_whatif', raw: 'historical what-if', color: '#8a5a3c' },
];
const GENRE_FALLBACK_COLOR = '#8a7e74';
// 未知/扩展 genre 的合并 sentinel，确保筛选区最多只出现一个「其他」分段（不暴露内部枚举）
const OTHER_GENRE = '__other__';

const normalizeGenre = (genre: string | undefined | null): string =>
  (genre || '').toLowerCase().trim();

const genreMetaOf = (genre: string | undefined | null): GenreMeta | undefined => {
  const raw = normalizeGenre(genre);
  return GENRE_META.find((g) => g.raw === raw);
};

const genreColorOf = (genre: string | undefined | null): string =>
  genreMetaOf(genre)?.color ?? GENRE_FALLBACK_COLOR;

export interface LocalPackPickerProps {
  onImport: (payload: {
    question: string;
    suggested_settings: SuggestedSettings;
  }) => void;
}

export function LocalPackPicker({ onImport }: LocalPackPickerProps) {
  const { t, i18n } = useTranslation();
  const { enabled, loading, error: capabilityError, reload: reloadCapabilities } = useCapabilityCheck('local_packs');

  const [packs, setPacks] = useState<LocalPackSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<PackDiagnostic[]>([]);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [selectedPackDetail, setSelectedPackDetail] = useState<LocalPack | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);

  const [, setIsLoadingPacks] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState<{
    type: 'prompt' | 'json';
    templateId?: string;
    active: boolean;
  } | null>(null);

  const getLocalized = useCallback((text: LocalizedText | undefined | null, currentLang: string): string => {
    if (!text) return '';
    const zh = typeof text.zh === 'string' ? text.zh : '';
    const en = typeof text.en === 'string' ? text.en : '';
    const isZh = currentLang.startsWith('zh');
    if (isZh) {
      return zh || en || '';
    }
    return en || zh || '';
  }, []);

  const genreLabel = useCallback((genre: string | undefined | null): string => {
    const raw = normalizeGenre(genre);
    const meta = genreMetaOf(raw);
    if (meta) return t(`local_packs.genre.${meta.key}`, raw);
    // 未知/空 genre 一律归并为「其他」，不把内部英文枚举泄漏给用户（原始串经 title 暴露）
    return t('local_packs.genre_other', 'Other');
  }, [t]);

  const fetchPacksData = useCallback(async () => {
    setIsLoadingPacks(true);
    setApiError(null);
    try {
      const [packsRes, diagRes] = await Promise.all([
        listLocalPacks(),
        getLocalPackDiagnostics(),
      ]);
      setPacks(packsRes.packs || []);
      setDiagnostics(diagRes.diagnostics || []);
    } catch {
      setApiError(t('local_packs.error_load_failed', 'Failed to load local packs.'));
    } finally {
      setIsLoadingPacks(false);
    }
  }, [t]);

  useEffect(() => {
    if (enabled) {
      void fetchPacksData();
    }
  }, [enabled, fetchPacksData]);

  useEffect(() => {
    if (!selectedPackId || !enabled) {
      setSelectedPackDetail(null);
      setSelectedTemplateId(null);
      return undefined;
    }

    let isMounted = true;
    const fetchDetail = async () => {
      setIsLoadingDetail(true);
      try {
        const detail = await getLocalPack(selectedPackId);
        if (isMounted) {
          setSelectedPackDetail(detail);
          const templates = detail.scenario_templates || [];
          if (templates.length > 0) {
            setSelectedTemplateId(templates[0].id);
          } else {
            setSelectedTemplateId(null);
          }
        }
      } catch {
        if (isMounted) {
          setApiError(t('local_packs.error_detail_failed', 'Failed to load pack details.'));
        }
      } finally {
        if (isMounted) {
          setIsLoadingDetail(false);
        }
      }
    };

    void fetchDetail();
    return () => {
      isMounted = false;
    };
  }, [selectedPackId, enabled, getLocalized, t]);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setApiError(null);
    try {
      const res = await refreshLocalPacks();
      setPacks(res.packs || []);
      setDiagnostics(res.diagnostics || []);
    } catch {
      setApiError(t('local_packs.error_refresh_failed', 'Failed to refresh packs from disk.'));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCopyText = (text: string, type: 'prompt' | 'json', templateId?: string) => {
    copyText(text)
      .then(() => {
        setCopySuccess({ type, templateId, active: true });
        setTimeout(() => setCopySuccess(null), 2000);
      })
      .catch(() => {});
  };

  const genreCounts = useMemo(() => {
    const counts = new Map<string, number>();
    packs.forEach((pack) => {
      const raw = normalizeGenre(pack.genre);
      // 空/未知 genre 全部并入单一 OTHER_GENRE 桶，避免显示为「其他」却无法按「其他」筛选
      const key = genreMetaOf(raw) ? raw : OTHER_GENRE;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  }, [packs]);

  const orderedGenres = useMemo(() => {
    const known = GENRE_META.map((g) => g.raw).filter((raw) => genreCounts.has(raw));
    return genreCounts.has(OTHER_GENRE) ? [...known, OTHER_GENRE] : known;
  }, [genreCounts]);

  // 防止 refresh 后 packs 变化导致 selectedGenre 指向已不存在的类型，使筛选卡在空态且分段隐藏无法复位
  useEffect(() => {
    if (!selectedGenre) return;
    const stillPresent =
      selectedGenre === OTHER_GENRE
        ? packs.some((pack) => {
            const raw = normalizeGenre(pack.genre);
            return !genreMetaOf(raw);
          })
        : packs.some((pack) => normalizeGenre(pack.genre) === selectedGenre);
    if (!stillPresent) setSelectedGenre(null);
  }, [packs, selectedGenre]);

  const filteredPacks = useMemo(() => {
    return packs.filter((pack) => {
      if (selectedGenre) {
        const packGenre = normalizeGenre(pack.genre);
        const excluded =
          selectedGenre === OTHER_GENRE
            ? Boolean(genreMetaOf(packGenre)) // 空/未知 genre 都属于「其他」
            : packGenre !== selectedGenre;
        if (excluded) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const title = getLocalized(pack.title, i18n.language).toLowerCase();
        const desc = getLocalized(pack.description, i18n.language).toLowerCase();
        const genre = normalizeGenre(pack.genre);
        const genreLabelText = genreLabel(pack.genre).toLowerCase();
        // 标签退化为搜索单通道（27 个 tag 零重叠，独立 chip 墙已删，tag 文本并入搜索）
        const tagText = (pack.tags || [])
          .map((tag) => getLocalized(tag, i18n.language).toLowerCase())
          .join(' ');
        if (
          !title.includes(q) &&
          !desc.includes(q) &&
          !genre.includes(q) &&
          !genreLabelText.includes(q) &&
          !tagText.includes(q)
        ) {
          return false;
        }
      }

      return true;
    });
  }, [packs, searchQuery, selectedGenre, getLocalized, genreLabel, i18n.language]);

  // P0-3：master-detail 软选中——当前选中失效（初始 null 或被筛选移除）时回落到首个结果，消除「左实右空」
  useEffect(() => {
    if (!enabled) return;
    if (selectedPackId && filteredPacks.some((pack) => pack.id === selectedPackId)) return;
    setSelectedPackId(filteredPacks[0]?.id ?? null);
  }, [enabled, filteredPacks, selectedPackId]);

  // 活动筛选数（类型 + 搜索），驱动「清除筛选 (N)」与结果计数状态条
  const activeFilterCount = (selectedGenre ? 1 : 0) + (searchQuery.trim() ? 1 : 0);
  const clearAllFilters = useCallback(() => {
    setSelectedGenre(null);
    setSearchQuery('');
  }, []);

  const getDiagnosticExplanation = (diag: PackDiagnostic) => {
    const translationKey = `local_packs.diagnostics_code.${diag.code}`;
    const localizedMessage = t(translationKey, '');
    if (localizedMessage) {
      return localizedMessage;
    }
    return diag.message || t('local_packs.unknown_diagnostic_code', 'Unknown diagnostic code');
  };

  if (loading) {
    return (
      <div className="local-pack-picker local-pack-picker--loading" role="status" aria-busy="true">
        <div className="local-pack-picker__spinner" />
        <p>{t('local_packs.loading', 'Loading local packs...')}</p>
      </div>
    );
  }

  if (capabilityError) {
    return (
      <div className="local-pack-picker local-pack-picker--error" role="alert">
        <p>{capabilityError.message || t('local_packs.error_load_failed', 'Failed to load local packs.')}</p>
        {reloadCapabilities && (
          <button type="button" onClick={() => void reloadCapabilities()} className="local-pack-picker__retry-btn">
            {t('local_packs.retry', 'Retry')}
          </button>
        )}
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="local-pack-picker local-pack-picker--disabled" role="alert">
        <p className="local-pack-picker__disabled-message">
          {t('local_packs.capability_disabled', 'Local packs feature is disabled. Check capability settings.')}
        </p>
      </div>
    );
  }

  return (
    <div
      className="local-pack-picker"
      data-testid="local-pack-picker"
      lang={i18n.language.startsWith('zh') ? 'zh' : 'en'}
    >
      <div className="local-pack-picker__header">
        <h3 className="local-pack-picker__title">{t('local_packs.panel_title', 'Local Packs')}</h3>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="local-pack-picker__refresh-btn"
          aria-live="polite"
        >
          {isRefreshing ? (
            <>
              <span className="local-pack-picker__spinner local-pack-picker__spinner--small" />
              {t('local_packs.loading', 'Loading local packs...')}
            </>
          ) : (
            t('local_packs.refresh_action', 'Refresh Packs')
          )}
        </button>
      </div>

      {(apiError || diagnostics.length > 0) && (
        <div className="local-pack-picker__diagnostics-container">
          {apiError && (
            <div className="local-pack-picker__api-error" role="alert">
              {apiError}
            </div>
          )}
          {diagnostics.length > 0 && (
            <details className="local-pack-picker__diagnostics-details">
              <summary className="local-pack-picker__diagnostics-summary">
                {t('local_packs.diagnostics_title', 'Pack Diagnostics')} ({diagnostics.length})
              </summary>
              <ul className="local-pack-picker__diagnostics-list">
                {diagnostics.map((diag, idx) => (
                  <li key={`${diag.id_or_filename}-${idx}`} className="local-pack-picker__diagnostic-item">
                    <strong className="local-pack-picker__diagnostic-file">{diag.id_or_filename}</strong>:{' '}
                    <span className="local-pack-picker__diagnostic-code">{diag.code}</span> -{' '}
                    <span className="local-pack-picker__diagnostic-msg">{getDiagnosticExplanation(diag)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="local-pack-picker__filters">
        {orderedGenres.length > 1 && (
          <div
            className="local-pack-picker__genre-filter"
            role="group"
            aria-label={t('local_packs.genres_label', 'Genre')}
          >
            <button
              type="button"
              onClick={() => setSelectedGenre(null)}
              aria-pressed={selectedGenre === null}
              className={`local-pack-picker__genre-chip ${
                selectedGenre === null ? 'local-pack-picker__genre-chip--active' : ''
              }`}
            >
              <span className="local-pack-picker__genre-label">{t('local_packs.genre_all', 'All')}</span>
              {packs.length > 12 && (
                <span className="local-pack-picker__genre-count">{packs.length}</span>
              )}
            </button>
            {orderedGenres.map((raw) => {
              const isActive = selectedGenre === raw;
              return (
                <button
                  key={raw}
                  type="button"
                  onClick={() => setSelectedGenre(isActive ? null : raw)}
                  aria-pressed={isActive}
                  title={raw === OTHER_GENRE ? undefined : raw}
                  className={`local-pack-picker__genre-chip ${
                    isActive ? 'local-pack-picker__genre-chip--active' : ''
                  }`}
                >
                  <span
                    className="local-pack-picker__genre-dot"
                    style={{ backgroundColor: genreColorOf(raw) }}
                    aria-hidden="true"
                  />
                  <span className="local-pack-picker__genre-label">{genreLabel(raw)}</span>
                  {packs.length > 12 && (
                    <span className="local-pack-picker__genre-count">{genreCounts.get(raw) ?? 0}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div
          className={`local-pack-picker__search-wrap${
            searchQuery ? ' local-pack-picker__search-wrap--has-clear' : ''
          }`}
        >
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('local_packs.search_placeholder', 'Search title, description, or genre...')}
            className="local-pack-picker__search-input"
            aria-label={t('local_packs.search_placeholder', 'Search title, description, or genre...')}
          />
          {searchQuery && (
            <button
              type="button"
              className="local-pack-picker__search-clear"
              aria-label={t('local_packs.clear_search', 'Clear search')}
              onClick={() => setSearchQuery('')}
            >
              ✕
            </button>
          )}
        </div>

        {activeFilterCount > 0 && (
          <div className="local-pack-picker__filter-status">
            <span className="local-pack-picker__result-count" aria-live="polite">
              {t('local_packs.result_count', 'Showing {{count}} of {{total}}', {
                count: filteredPacks.length,
                total: packs.length,
              })}
            </span>
            <button
              type="button"
              className="local-pack-picker__clear-filters"
              onClick={clearAllFilters}
            >
              {t('local_packs.clear_filters', 'Clear filters')} ({activeFilterCount})
            </button>
          </div>
        )}
      </div>

      <div className="local-pack-picker__content">
        <div className="local-pack-picker__list-column">
          {filteredPacks.length === 0 ? (
            <p className="local-pack-picker__empty" role="status">
              {t('local_packs.no_results', 'No matching packs found.')}
            </p>
          ) : (
            <ul className="local-pack-picker__pack-list" aria-label={t('local_packs.panel_title', 'Local Packs')}>
              {filteredPacks.map((pack) => {
                const isSelected = selectedPackId === pack.id;
                const title = getLocalized(pack.title, i18n.language);
                const genreColor = genreColorOf(pack.genre);
                // 瓷砖副标题用 description 首句（LocalPackSummary 无 per-template question），比孤立 tag 信息量更高
                const teaser =
                  getLocalized(pack.description, i18n.language).split(/[。.!?！？\n]/)[0]?.trim() ?? '';

                return (
                  <li key={pack.id} className="local-pack-picker__pack-item">
                    <button
                      type="button"
                      onClick={() => setSelectedPackId(pack.id)}
                      aria-pressed={isSelected}
                      style={{ '--pack-genre-color': genreColor } as CSSProperties}
                      className={`local-pack-picker__pack-card ${
                        isSelected ? 'local-pack-picker__pack-card--active' : ''
                      }`}
                    >
                      <span className="local-pack-picker__pack-genre">
                        <span
                          className="local-pack-picker__genre-dot"
                          style={{ backgroundColor: genreColor }}
                          aria-hidden="true"
                        />
                        {genreLabel(pack.genre)}
                      </span>
                      <h4 className="local-pack-picker__pack-title" title={title}>{title}</h4>
                      {teaser && (
                        <p className="local-pack-picker__pack-teaser" title={teaser}>{teaser}</p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="local-pack-picker__preview-column">
          {selectedPackId ? (
            <div className="local-pack-picker__preview-card">
              {isLoadingDetail ? (
                <div className="local-pack-picker__preview-loading">
                  <div className="local-pack-picker__spinner" />
                  <p>{t('local_packs.loading', 'Loading local packs...')}</p>
                </div>
              ) : selectedPackDetail ? (
                <div className="local-pack-picker__preview-details">
                  <div className="local-pack-picker__preview-header">
                    <span className="local-pack-picker__preview-genre">{genreLabel(selectedPackDetail.genre)}</span>
                    <h4 className="local-pack-picker__preview-title">
                      {getLocalized(selectedPackDetail.title, i18n.language)}
                    </h4>
                    <p className="local-pack-picker__preview-desc">
                      {getLocalized(selectedPackDetail.description, i18n.language)}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleCopyText(JSON.stringify(selectedPackDetail, null, 2), 'json')}
                      className="local-pack-picker__copy-json-btn"
                    >
                      {copySuccess?.type === 'json' ? t('local_packs.copysuccess_generic', 'Copied!') : t('local_packs.copy_json_action', 'Copy JSON')}
                    </button>
                  </div>

                  <div className="local-pack-picker__settings-section">
                    <h5>{t('local_packs.suggested_settings_label', 'Suggested Settings')}</h5>
                    <div className="local-pack-picker__settings-grid">
                      <div>
                        <strong>{t('home.agents_label', 'Agent Count')}:</strong>{' '}
                        {selectedPackDetail.suggested_settings.num_agents}
                      </div>
                      <div>
                        <strong>{t('home.rounds_label', 'Simulation Rounds')}:</strong>{' '}
                        {selectedPackDetail.suggested_settings.rounds}
                      </div>
                      <div>
                        <strong>{t('home.mode_label', 'Simulation Mode')}:</strong>{' '}
                        {selectedPackDetail.suggested_settings.simulation_mode}
                      </div>
                      <div>
                        <strong>{t('common.language', 'Language')}:</strong>{' '}
                        {selectedPackDetail.suggested_settings.language}
                      </div>
                    </div>
                  </div>

                  {selectedPackDetail.scenario_templates && selectedPackDetail.scenario_templates.length > 0 && (
                    <div className="local-pack-picker__templates-section">
                      <h5>{t('local_packs.scenarios_label', 'Scenario Templates')}</h5>
                      <div className="local-pack-picker__template-tabs">
                        {selectedPackDetail.scenario_templates.map((temp) => (
                          <button
                            key={temp.id}
                            type="button"
                            onClick={() => setSelectedTemplateId(temp.id)}
                            className={`local-pack-picker__template-tab ${
                              selectedTemplateId === temp.id ? 'local-pack-picker__template-tab--active' : ''
                            }`}
                          >
                            {getLocalized(temp.question, i18n.language)}
                          </button>
                        ))}
                      </div>

                      {selectedPackDetail.scenario_templates
                        .filter((temp) => temp.id === selectedTemplateId)
                        .map((temp) => (
                          <div key={temp.id} className="local-pack-picker__template-body">
                            <div className="local-pack-picker__field">
                              <h6>{t('home.question_input_label', 'Simulation question')}</h6>
                              <p>{getLocalized(temp.question, i18n.language)}</p>
                            </div>
                            <div className="local-pack-picker__field">
                              <h6>{t('document_seed.summary', 'Summary')} / {t('common.context', 'Context')}</h6>
                              <p>{getLocalized(temp.context, i18n.language)}</p>
                            </div>
                            <div className="local-pack-picker__field">
                              <h6>{t('local_packs.field_prompt')}</h6>
                              <p className="local-pack-picker__prompt-text">
                                {getLocalized(temp.prompt, i18n.language)}
                              </p>
                            </div>
                            {(temp.stakes || []).length > 0 && (
                              <div className="local-pack-picker__field">
                                <h6>{t('local_packs.field_stakes')}</h6>
                                <ul className="local-pack-picker__stakes-list">
                                  {temp.stakes?.map((stake, sIdx) => (
                                    <li key={sIdx}>{getLocalized(stake, i18n.language)}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            <div className="local-pack-picker__template-actions">
                              <button
                                type="button"
                                onClick={() =>
                                  onImport({
                                    question: getLocalized(temp.question, i18n.language),
                                    suggested_settings: selectedPackDetail.suggested_settings,
                                  })
                                }
                                className="local-pack-picker__import-btn"
                              >
                                {t('local_packs.import_action', 'Use This Template')}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopyText(getLocalized(temp.prompt, i18n.language), 'prompt', temp.id)
                                }
                                className="local-pack-picker__copy-prompt-btn"
                              >
                                {copySuccess?.type === 'prompt' && copySuccess?.templateId === temp.id
                                  ? t('local_packs.copysuccess_generic', 'Copied!')
                                  : t('local_packs.copy_prompt_action', 'Copy Prompt')}
                              </button>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}

                  {selectedPackDetail.agent_casts && selectedPackDetail.agent_casts.length > 0 && (
                    <div className="local-pack-picker__casts-section">
                      <h5>{t('local_packs.agent_casts_label', 'Agent Casts')}</h5>
                      <ul className="local-pack-picker__casts-list">
                        {selectedPackDetail.agent_casts.map((cast) => (
                          <li key={cast.id} className="local-pack-picker__cast-item">
                            <strong>{getLocalized(cast.name, i18n.language)}</strong> ({getLocalized(cast.role, i18n.language)}) - {getLocalized(cast.perspective, i18n.language)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selectedPackDetail.demo_snapshots && selectedPackDetail.demo_snapshots.length > 0 && (
                    <div className="local-pack-picker__snapshots-section">
                      <h5>{t('local_packs.demo_snapshots_label', 'Demo Snapshots')}</h5>
                      <ul className="local-pack-picker__snapshots-list">
                        {selectedPackDetail.demo_snapshots.map((snap) => (
                          <li key={snap.id} className="local-pack-picker__snapshot-item">
                            {getLocalized(snap.label, i18n.language)} (<code>{snap.filename}</code>)
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="local-pack-picker__source-section">
                    <h5>{t('local_packs.source_metadata_label', 'Source Metadata')}</h5>
                    <div className="local-pack-picker__source-grid">
                      <div>
                        <strong>{t('local_packs.meta_curator')}:</strong> {selectedPackDetail.source_metadata.curator}
                      </div>
                      <div>
                        <strong>{t('local_packs.meta_created')}:</strong> {selectedPackDetail.source_metadata.created_at}
                      </div>
                      <div>
                        <strong>{t('local_packs.meta_license')}:</strong> {selectedPackDetail.source_metadata.license}
                      </div>
                      <div>
                        <strong>{t('local_packs.meta_notes')}:</strong> {getLocalized(selectedPackDetail.source_metadata.notes, i18n.language)}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="local-pack-picker__preview-placeholder">
              <svg
                className="local-pack-picker__preview-placeholder-icon"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <p>{t('local_packs.select_pack_hint', 'Select a pack from the list to view scenario templates and preview details.')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
