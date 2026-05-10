/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Ending cards grid (per-branch summary cards)
   ═══════════════════════════════════════════════════════════ */

import { useResultContext } from './ResultContext';

export default function EndingCardsGrid() {
  const {
    t,
    branches,
    expandedBranch,
    setExpandedBranch,
    handleOpenEndingRoom,
    isReplayMode,
    scenario,
  } = useResultContext();

  if (branches.length === 0) {
    return (
      <div className="result-empty">
        <p>{t('result.no_stories')}</p>
      </div>
    );
  }

  return (
    <div className="endings-grid">
      {branches.map((branch, index) => {
        const isExpanded = expandedBranch === branch.id;
        const hasDetailContent = Boolean(
          branch.story
          || branch.fork_reason
          || (branch.key_moments && branch.key_moments.length > 0),
        );
        const detailId = `ending-detail-${branch.id}`;
        const titleId = `ending-title-${branch.id}`;

        return (
          <article
            key={branch.id}
            className={`ending-card ${isExpanded ? 'expanded' : ''} ${index === 0 ? 'ending-card--primary' : ''}`}
            ref={(el) => { if (el) el.style.setProperty('--card-delay', `${index * 0.1}s`); }}
          >
            {/* Summary-First: always visible */}
            <div className="ending-header">
              <span className="ending-index">
                {t('result.ending_card')} {index + 1}
              </span>
              <h2 id={titleId} className="ending-title">{branch.title}</h2>
            </div>

            <div className="probability-section">
              <div className="probability-label">
                <span>{t('result.probability')}</span>
                <span className="probability-value">
                  {((branch.probability ?? 0) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="probability-bar">
                <div
                  className={`probability-fill ${(branch.probability ?? 0) > 0.6 ? 'probability-fill--high' : (branch.probability ?? 0) < 0.3 ? 'probability-fill--low' : 'probability-fill--mid'}`}
                  ref={(el) => { if (el) el.style.setProperty('--prob-fill', `${Math.max((branch.probability ?? 0) * 100, 2)}%`); }}
                />
              </div>
            </div>

            {/* Insight always visible as the card's key takeaway */}
            {branch.insight && (
              <blockquote className="insight-quote">{branch.insight}</blockquote>
            )}

            {/* Collapsible detail section */}
            {isExpanded && (
              <section
                id={detailId}
                className="ending-detail"
                aria-labelledby={titleId}
              >
                <div className="ending-detail__inner">
                  {branch.fork_reason && (
                    <div className="fork-reason">
                      <span className="fork-label">{t('result.fork_reason')}</span>
                      <p>{branch.fork_reason}</p>
                    </div>
                  )}

                  <div className="story-section">
                    <h3 className="section-label">{t('result.story')}</h3>
                    <p className="story-text full">
                      {branch.story || '—'}
                    </p>
                  </div>

                  {branch.key_moments && branch.key_moments.length > 0 && (
                    <div className="moments-section">
                      <h3 className="section-label">{t('result.key_moments')}</h3>
                      <ol className="moments-timeline">
                        {branch.key_moments.map((moment, mi) => (
                          <li key={mi}>{moment}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Expand/collapse toggle */}
            {hasDetailContent && (
              <button
                type="button"
                className="btn btn-ghost expand-btn"
                aria-expanded={isExpanded}
                aria-controls={isExpanded ? detailId : undefined}
                onClick={() =>
                  setExpandedBranch(
                    isExpanded ? null : branch.id,
                  )
                }
              >
                {isExpanded
                  ? t('result.collapse')
                  : t('result.read_full')}
              </button>
            )}

            <div className="ending-room-actions ending-action-band">
              <button
                type="button"
                className="btn"
                onClick={() => void handleOpenEndingRoom(branch.id, 'ending_chamber')}
                disabled={!isReplayMode && scenario?.status !== 'done'}
              >
                {t('ending_room.entry_cta')}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleOpenEndingRoom(branch.id, 'one_move_only')}
                disabled={!isReplayMode && scenario?.status !== 'done'}
              >
                {t('ending_room.one_move_cta')}
              </button>
              {branches.length > 1 && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void handleOpenEndingRoom(branch.id, 'crossline_gallery')}
                  disabled={!isReplayMode && scenario?.status !== 'done'}
                >
                  {t('roundtable.gallery_title')}
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
