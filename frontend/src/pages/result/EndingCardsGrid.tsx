/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Ending cards grid (per-branch summary cards)
   ═══════════════════════════════════════════════════════════ */

import { useResultContext } from './ResultContext';

function plainNarrativeNotice(value: string): string {
  return value
    .replace(/^\*\*Evidence-limited hypothesis:\*\*\s*/, 'Evidence-limited narrative hypothesis: ')
    .replace(/^\*\*Unverified attribution:\*\*\s*/, 'Evidence-limited narrative hypothesis (unverified attribution): ')
    .replace(/^\*\*证据有限的假设：\*\*\s*/, '证据有限的叙事假设：')
    .replace(/^\*\*归因未经验证：\*\*\s*/, '证据有限的叙事假设（归因未经验证）：');
}

function focusEndingTitle(branchId: string) {
  if (typeof window === 'undefined') return;
  const schedule = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
  schedule(() => {
    const title = window.document.getElementById(`ending-title-${branchId}`);
    if (!(title instanceof HTMLElement)) return;
    const behavior: ScrollBehavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';
    title.scrollIntoView?.({ behavior, block: 'center' });
    title.focus({ preventScroll: true });
  });
}

export default function EndingCardsGrid() {
  const {
    t,
    branches,
    expandedBranch,
    setExpandedBranch,
    handleOpenEndingRoom,
    isReplayMode,
    scenario,
    comparisonBranchA,
    comparisonBranchB,
    setComparisonBranch,
    comparisonHref,
    handleOpenComparison,
    capabilities,
    capLoading,
    capError,
  } = useResultContext();

  if (branches.length === 0) {
    return (
      <div className="result-empty">
        <p>{t('result.no_stories')}</p>
      </div>
    );
  }

  return (
    <section id="result-endings" className="result-endings" aria-labelledby="result-endings-heading">
      <header className="result-endings__header">
        <h2 id="result-endings-heading">{t('result.saved_endings_heading')}</h2>
        <p className="probability-resume-hint" role="note">{t('result.simulation_weight_hint')}</p>
        {branches.length > 1 && (
          <fieldset className="result-compare-picker" id="result-compare-picker">
            <legend>{t('result.compare_choose_two')}</legend>
            {(['a', 'b'] as const).map((side) => (
              <label key={side}>
                <span>{t(side === 'a' ? 'result.compare_first' : 'result.compare_second')}</span>
                <select
                  value={(side === 'a' ? comparisonBranchA : comparisonBranchB) ?? ''}
                  onChange={(event) => setComparisonBranch(side, event.target.value)}
                >
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id} disabled={branch.id === (side === 'a' ? comparisonBranchB : comparisonBranchA)}>
                      {branch.title}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <button type="button" className="btn" disabled={!comparisonHref} onClick={handleOpenComparison}>
              {t('result.compare_selected')}
            </button>
            {!comparisonHref && (
              <p className="result-compare-picker__note" role="status">
                {t(capLoading ? 'common.loading' : capError ? 'common.capability_error' : isReplayMode
                  ? 'result.bridge_replay_unavailable' : !capabilities?.counterfactual_replay?.enabled
                    ? 'result.bridge_not_enabled' : 'result.compare_choose_two')}
              </p>
            )}
          </fieldset>
        )}
      </header>
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

        const branchAnswerRaw = branch.question_answer;
        const branchAnswerText = typeof branchAnswerRaw === 'string' ? plainNarrativeNotice(branchAnswerRaw).trim() : '';
        const hasBranchAnswer = branchAnswerText.length > 0;

        return (
          <article
            key={branch.id}
            className={`ending-card ${isExpanded ? 'expanded' : ''} ${index === 0 ? 'ending-card--primary' : ''} ${hasBranchAnswer ? 'ending-card--has-answer' : ''}`}
            ref={(el) => { if (el) el.style.setProperty('--card-delay', `${index * 0.1}s`); }}
          >
            {/* Summary-First: always visible */}
            <div className="ending-header">
              <span className="ending-index">
                {t('result.ending_card')} {index + 1}
              </span>
              {branch.replay_kind === 'resume' && (
                <span className="ending-resume-badge">
                  {t('result.resume_branch_badge', 'Resumed')}
                </span>
              )}
              {branch.replay_kind === 'resume' && branch.replay_source_branch_id && (() => {
                const sourceBranch = branches.find((b) => b.id === branch.replay_source_branch_id);
                return sourceBranch ? (
                  <button
                    type="button"
                    className="btn btn-ghost ending-source-link"
                    aria-controls={`ending-detail-${sourceBranch.id}`}
                    aria-label={t('result.view_source_branch_aria', {
                      title: sourceBranch.title,
                      defaultValue: 'Open source branch: {{title}}',
                    })}
                    onClick={() => {
                      setExpandedBranch(sourceBranch.id);
                      focusEndingTitle(sourceBranch.id);
                    }}
                  >
                    {t('result.view_source_branch', { title: sourceBranch.title, defaultValue: 'Source: {{title}}' })}
                  </button>
                ) : null;
              })()}
              <h2 id={titleId} className="ending-title" tabIndex={-1}>{branch.title}</h2>
            </div>

            {/* Branch-specific answer to the user's question, rendered as the
                focal point of the card when present — placed BEFORE the
                probability bar so the answer leads the reading order. */}
            {hasBranchAnswer && (
              <p
                className="ending-card__answer ending-card__answer--focal"
                data-testid={`ending-card-answer-${branch.id}`}
              >
                <span className="ending-card__answer-label">
                  {t('result.branch_answer_label', { defaultValue: 'Answer to Your Question' })}
                </span>
                <span className="ending-card__answer-text">{branchAnswerText}</span>
              </p>
            )}

            <div className="probability-section">
              <div className="probability-label">
                <span>{t('result.simulation_weight')}</span>
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
              {branch.replay_kind === 'resume' && (
                <p className="probability-resume-hint">
                  {t('result.resume_probability_hint', 'This is a standalone resumed branch — probability reflects its independent simulation.')}
                </p>
              )}
            </div>

            {/* Insight visible as a secondary takeaway when the focal
                question_answer is present, otherwise as the primary takeaway. */}
            {branch.insight && (
              <blockquote
                className={`insight-quote ${hasBranchAnswer ? 'insight-quote--secondary' : ''}`}
              >
                {plainNarrativeNotice(branch.insight)}
              </blockquote>
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
                      {branch.story ? plainNarrativeNotice(branch.story) : '—'}
                    </p>
                  </div>

                  {branch.key_moments && branch.key_moments.length > 0 && (
                    <div className="moments-section">
                      <h3 className="section-label">{t('result.key_moments')}</h3>
                      <ol className="moments-timeline">
                        {branch.key_moments.map((moment, mi) => (
                          <li key={mi}>{plainNarrativeNotice(moment)}</li>
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
    </section>
  );
}
