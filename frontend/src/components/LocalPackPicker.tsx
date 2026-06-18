import {
  useCallback,
  useEffect,
  useMemo,
  useState,
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
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

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

  const handleTagToggle = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const allTags = useMemo(() => {
    const tagsSet = new Set<string>();
    packs.forEach((pack) => {
      const tags = pack.tags || [];
      tags.forEach((tag) => {
        const localized = getLocalized(tag, i18n.language);
        if (localized) tagsSet.add(localized);
      });
    });
    return Array.from(tagsSet).sort();
  }, [packs, getLocalized, i18n.language]);

  const filteredPacks = useMemo(() => {
    return packs.filter((pack) => {
      if (selectedTags.length > 0) {
        const packTagStrings = (pack.tags || []).map((t) => getLocalized(t, i18n.language));
        const matchesAllSelectedTags = selectedTags.every((selectedTag) =>
          packTagStrings.includes(selectedTag),
        );
        if (!matchesAllSelectedTags) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const title = getLocalized(pack.title, i18n.language).toLowerCase();
        const desc = getLocalized(pack.description, i18n.language).toLowerCase();
        const genre = (pack.genre || '').toLowerCase();
        if (!title.includes(q) && !desc.includes(q) && !genre.includes(q)) {
          return false;
        }
      }

      return true;
    });
  }, [packs, searchQuery, selectedTags, getLocalized, i18n.language]);

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
    <div className="local-pack-picker" data-testid="local-pack-picker">
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
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('local_packs.search_placeholder', 'Search title, description, or genre...')}
          className="local-pack-picker__search-input"
          aria-label={t('local_packs.search_placeholder', 'Search title, description, or genre...')}
        />

        {allTags.length > 0 && (
          <div className="local-pack-picker__tags-filter" role="group" aria-label={t('local_packs.tags_label', 'Tags')}>
            {allTags.map((tag) => {
              const isSelected = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleTagToggle(tag)}
                  aria-pressed={isSelected}
                  className={`local-pack-picker__tag-chip ${
                    isSelected ? 'local-pack-picker__tag-chip--active' : ''
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="local-pack-picker__content">
        <div className="local-pack-picker__list-column">
          <ul className="local-pack-picker__pack-list" aria-label={t('local_packs.panel_title', 'Local Packs')}>
            {filteredPacks.map((pack) => {
              const isSelected = selectedPackId === pack.id;
              const title = getLocalized(pack.title, i18n.language);
              const desc = getLocalized(pack.description, i18n.language);
              const tags = pack.tags || [];

              return (
                <li key={pack.id} className="local-pack-picker__pack-item">
                  <button
                    type="button"
                    onClick={() => setSelectedPackId(isSelected ? null : pack.id)}
                    aria-pressed={isSelected}
                    className={`local-pack-picker__pack-card ${
                      isSelected ? 'local-pack-picker__pack-card--active' : ''
                    }`}
                  >
                    <div className="local-pack-picker__pack-card-header">
                      <span className="local-pack-picker__pack-genre">{pack.genre}</span>
                      <h4 className="local-pack-picker__pack-title">{title}</h4>
                    </div>
                    <p className="local-pack-picker__pack-desc">{desc}</p>
                    <div className="local-pack-picker__pack-tags">
                      {tags.map((tag, tIdx) => (
                        <span key={tIdx} className="local-pack-picker__pack-tag-badge">
                          {getLocalized(tag, i18n.language)}
                        </span>
                      ))}
                    </div>
                    <div className="local-pack-picker__pack-meta">
                      {t('local_packs.pack_info', '{{scenarios}} scenarios · {{casts}} casts · {{snapshots}} snapshots', {
                        scenarios: pack.scenario_count || 0,
                        casts: pack.agent_cast_count || 0,
                        snapshots: pack.demo_snapshot_count || 0,
                      })}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
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
                    <span className="local-pack-picker__preview-genre">{selectedPackDetail.genre}</span>
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
              <p>{t('local_packs.select_pack_hint', 'Select a pack from the list to view scenario templates and preview details.')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
