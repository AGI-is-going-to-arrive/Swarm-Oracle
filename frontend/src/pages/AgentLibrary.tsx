/* ═══════════════════════════════════════════════════════════
   Phase 3 F3 — Agent Library (Grid View) + Favorites Gallery
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  deleteAgent,
  getAgentFavorites,
  getSessionBoundUserId,
  markAgentFavorite,
  unmarkAgentFavorite,
} from '../api/client';
import { useAgentStore } from '../stores/agentStore';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { AgentProfileModal } from '../components/AgentProfileModal';
import { AgentCard } from '../components/AgentCard';
import { ExportButton, ImportDialog } from '../components/PersonaExportImport';
import type { AgentIdentityInfo } from '../types';

type LibraryTab = 'all' | 'favorites';

export function AgentLibrary() {
  const { t } = useTranslation();
  const {
    loading: capLoading,
    enabled,
    error: capError,
    reload: reloadCapability,
  } = useCapabilityCheck('custom_agents');
  const { enabled: exportEnabled } = useCapabilityCheck('persona_export');
  const { identities, loading, error, fetchIdentities } = useAgentStore();
  const [profileAgent, setProfileAgent] = useState<AgentIdentityInfo | null>(null);
  const [tab, setTab] = useState<LibraryTab>('all');
  const [search, setSearch] = useState('');
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoritesError, setFavoritesError] = useState<string | null>(null);
  const [pendingFavoriteId, setPendingFavoriteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const refreshFavorites = useCallback(async () => {
    setFavoritesLoading(true);
    setFavoritesError(null);
    try {
      const items = await getAgentFavorites<AgentIdentityInfo[]>();
      const ids = new Set<string>();
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item && typeof item.id === 'string') {
            ids.add(item.id);
          }
        }
      }
      setFavoriteIds(ids);
    } catch (err) {
      if (err instanceof Error) {
        console.debug('[AgentLibrary] Failed to load favorites', err);
      }
      setFavoritesError('agent_library.favorites_error_generic');
    } finally {
      setFavoritesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || capError) return;
    const userId = getSessionBoundUserId();
    fetchIdentities(userId);
    void refreshFavorites();
  }, [capError, fetchIdentities, enabled, refreshFavorites]);

  const handleToggleFavorite = useCallback(
    async (identity: AgentIdentityInfo) => {
      if (pendingFavoriteId === identity.id) return;
      const wasFavorite = favoriteIds.has(identity.id);
      // optimistic update
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (wasFavorite) {
          next.delete(identity.id);
        } else {
          next.add(identity.id);
        }
        return next;
      });
      setPendingFavoriteId(identity.id);
      try {
        if (wasFavorite) {
          await unmarkAgentFavorite(identity.id);
        } else {
          await markAgentFavorite<AgentIdentityInfo>(identity.id);
        }
      } catch (err) {
        // rollback on failure
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          if (wasFavorite) {
            next.add(identity.id);
          } else {
            next.delete(identity.id);
          }
          return next;
        });
        if (err instanceof Error) {
          console.debug('[AgentLibrary] Failed to update favorite', err);
        }
        setFavoritesError('agent_library.favorite_update_failed');
      } finally {
        setPendingFavoriteId(null);
      }
    },
    [favoriteIds, pendingFavoriteId],
  );

  const handleDelete = useCallback(
    async (identity: AgentIdentityInfo) => {
      if (identity.kind === 'generated') return;
      if (!confirm(t('agents.delete_confirm', 'Delete this agent?'))) return;
      await deleteAgent(identity.id);
      const userId = getSessionBoundUserId();
      fetchIdentities(userId);
      // also drop from favorites map if present
      setFavoriteIds((prev) => {
        if (!prev.has(identity.id)) return prev;
        const next = new Set(prev);
        next.delete(identity.id);
        return next;
      });
    },
    [fetchIdentities, t],
  );

  const handleImported = useCallback(
    () => {
      const userId = getSessionBoundUserId();
      fetchIdentities(userId);
    },
    [fetchIdentities],
  );

  const normalizedSearch = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const base = tab === 'favorites'
      ? identities.filter((a) => favoriteIds.has(a.id))
      : identities;
    if (!normalizedSearch) return base;
    return base.filter((a) => {
      const haystack = [
        a.display_name,
        a.role,
        a.persona ?? '',
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [identities, favoriteIds, tab, normalizedSearch]);

  const customAgents = filtered.filter((a) => a.kind === 'custom');
  const generatedAgents = filtered.filter((a) => a.kind === 'generated');

  if (capLoading) {
    return <div className="agent-page agent-page--centered">{t('common.loading', 'Loading...')}</div>;
  }
  if (capError) return (
    <div className="agent-page agent-page--centered agent-page--narrow">
      <p role="alert" className="agent-form__error">
        {t(
          'agents.capability_error',
          'Could not check custom agent availability. Please retry.',
        )}
      </p>
      <button
        type="button"
        className="agent-button agent-button--primary"
        onClick={() => void reloadCapability?.()}
      >
        {t('common.retry', 'Retry')}
      </button>
      <Link to="/" className="agent-link">{t('common.back_home', 'Back to Home')}</Link>
    </div>
  );
  if (!enabled) return (
    <div className="agent-page agent-page--centered">
      <p className="agent-page__muted">{t('agents.feature_disabled', 'Custom agents feature is not enabled.')}</p>
      <Link to="/" className="agent-link">{t('common.back_home', 'Back to Home')}</Link>
    </div>
  );

  const renderAgentCard = (agent: AgentIdentityInfo) => (
    <div key={agent.id} className="agent-library-card-wrap">
      <AgentCard
        identity={agent}
        isFavorite={favoriteIds.has(agent.id)}
        onToggleFavorite={() => void handleToggleFavorite(agent)}
        onSelect={() => setProfileAgent(agent)}
      />
      <div className="agent-library-card-wrap__row">
        {exportEnabled && (
          <ExportButton identityId={agent.id} name={agent.display_name} />
        )}
        {agent.kind !== 'generated' && (
          <button
            type="button"
            className="agent-card__action agent-card__action--danger"
            onClick={() => void handleDelete(agent)}
            aria-label={t('agents.delete_agent_aria', {
              name: agent.display_name,
              defaultValue: 'Delete {{name}}',
            })}
          >
            {t('common.delete', 'Delete')}
          </button>
        )}
      </div>
    </div>
  );

  const totalFavorites = favoriteIds.size;
  const showEmptyFavorites = tab === 'favorites'
    && !favoritesLoading
    && filtered.length === 0
    && !normalizedSearch
    && totalFavorites === 0;

  return (
    <div className="agent-page">
      <div className="agent-page__header">
        <h1>{t('agents.library_title', 'Agent Library')}</h1>
        <div className="agent-page__header-actions">
          {exportEnabled && (
            <button
              type="button"
              className="agent-button"
              onClick={() => setImportOpen(true)}
            >
              {t('persona_export.import', 'Import Persona')}
            </button>
          )}
          <Link
            to="/agents/new"
            className="agent-button agent-button--primary agent-button--link"
          >
            + {t('agents.create_btn', 'Create Agent')}
          </Link>
        </div>
      </div>

      <div
        className="agent-library-toolbar"
        role="group"
        aria-label={t('agent_library.filter_aria', 'Filter agents')}
      >
        <div className="agent-library-tabs">
          <button
            type="button"
            aria-pressed={tab === 'all'}
            className={`agent-library-tab${tab === 'all' ? ' agent-library-tab--active' : ''}`}
            onClick={() => setTab('all')}
          >
            {t('agent_library.all_tab', 'All')}
          </button>
          <button
            type="button"
            aria-pressed={tab === 'favorites'}
            className={`agent-library-tab${tab === 'favorites' ? ' agent-library-tab--active' : ''}`}
            onClick={() => setTab('favorites')}
          >
            {t('agent_library.favorites', 'Favorites')}
            {totalFavorites > 0 && (
              <span className="agent-library-tab__count" aria-hidden="true">
                {totalFavorites}
              </span>
            )}
          </button>
        </div>
        <input
          type="search"
          className="agent-library-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('agent_library.search_placeholder', 'Search agents...')}
          aria-label={t('agent_library.search_aria', 'Search agents')}
        />
      </div>

      {(loading || favoritesLoading) && <p>{t('common.loading', 'Loading...')}</p>}
      {error && <p role="alert" className="agent-form__error">{error}</p>}
      {favoritesError && (
        <p role="alert" className="agent-form__error">
          {favoritesError === 'agent_library.favorites_error_generic'
            ? t(favoritesError, 'Failed to load favorites. Please retry.')
            : favoritesError === 'agent_library.favorite_update_failed'
              ? t(favoritesError, 'Could not update favorite. Please retry.')
              : favoritesError}
        </p>
      )}

      {showEmptyFavorites && (
        <div className="agent-empty-state">
          <p className="agent-empty-state__title">
            {t('agent_library.no_favorites', 'No favorite agents yet')}
          </p>
          <p>
            {t('agent_library.no_favorites_hint', 'Tap the heart on any agent to save it here.')}
          </p>
        </div>
      )}

      {!loading && tab === 'all' && customAgents.length === 0 && generatedAgents.length === 0 && !normalizedSearch && (
        <div className="agent-empty-state">
          <p className="agent-empty-state__title">{t('agents.empty_state', 'No custom agents yet.')}</p>
          <p>{t('agents.empty_hint', 'Create your first agent to use in simulations.')}</p>
          <Link to="/agents/new" className="agent-button agent-button--primary agent-button--link">
            {t('agents.create_first', 'Create your first agent')}
          </Link>
        </div>
      )}

      {!loading && filtered.length === 0 && normalizedSearch && (
        <div className="agent-empty-state">
          <p className="agent-empty-state__title">
            {t('agent_library.no_results', 'No agents match your search.')}
          </p>
        </div>
      )}

      {tab === 'favorites' && filtered.length > 0 && (
        <section className="agent-library-section">
          <h2 className="agent-library-section__title">
            {t('agent_library.favorites_section', 'Your Favorites')}
          </h2>
          <div className="agent-library-grid agent-library-grid--gallery">
            {filtered.map(renderAgentCard)}
          </div>
        </section>
      )}

      {tab === 'all' && customAgents.length > 0 && (
        <section className="agent-library-section">
          <h2 className="agent-library-section__title">
            {t('agent_library.custom_group', 'My Agents')}
          </h2>
          <div className="agent-library-grid agent-library-grid--gallery">
            {customAgents.map(renderAgentCard)}
          </div>
        </section>
      )}

      {tab === 'all' && generatedAgents.length > 0 && (
        <section className="agent-library-section">
          <h2 className="agent-library-section__title">
            {t('agent_library.generated_group', 'System Generated')}
          </h2>
          <div className="agent-library-grid agent-library-grid--gallery">
            {generatedAgents.map(renderAgentCard)}
          </div>
        </section>
      )}

      <AgentProfileModal
        identity={profileAgent}
        open={profileAgent !== null}
        onClose={() => setProfileAgent(null)}
      />

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
      />
    </div>
  );
}

export default AgentLibrary;
