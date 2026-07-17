import { useTranslation } from 'react-i18next';
import { type PublicArtifact } from '../types';
import { SafeMarkdown } from '../components/SafeMarkdown';

interface GalleryArtifactViewProps {
  artifact: PublicArtifact;
}

export function GalleryArtifactView({ artifact }: GalleryArtifactViewProps) {
  const { t } = useTranslation();

  const {
    question,
    display_agent_names,
    branch_verdicts,
    probability_bars,
    transcript_excerpts,
    source_summary,
  } = artifact;

  const sortedProbBars = [...probability_bars].sort((a, b) => a.branch_index - b.branch_index);

  return (
    <div className="artifact-card">
      <div className="artifact-question-section">
        <span className="artifact-label" id="question-label">
          {t('home.question_input_label', 'Simulation Question')}
        </span>
        <h2 className="artifact-question" aria-labelledby="question-label">
          <SafeMarkdown>{question}</SafeMarkdown>
        </h2>
      </div>

      <div className="section-grid">
        <div className="main-column">
          {/* Branches Section */}
          <section className="artifact-section" aria-label={t('gallery.branch_predictions_aria')}>
            <h3>{t('common.branches', 'Timelines')}</h3>
            {sortedProbBars.length === 0 ? (
              <p>{t('common.empty', 'No branches available')}</p>
            ) : (
              <div className="branches-list">
                {sortedProbBars.map((bar) => {
                  const verdict = branch_verdicts.find(
                    (v) => v.branch_index === bar.branch_index,
                  );
                  const confidence = verdict?.confidence ?? null;
                  const confidenceLabel = confidence
                    ? t(`gallery.confidence_${confidence}`, confidence)
                    : null;

                  const percentage = Math.round(bar.probability * 100);

                  return (
                    <article key={bar.branch_index} className="branch-item">
                      <div className="branch-header">
                        <h4 className="branch-title">{bar.label}</h4>
                        {confidence && confidenceLabel && (
                          <div className="branch-meta">
                            <span
                              className={`confidence-badge confidence-${confidence}`}
                              aria-label={`${t('result.confidence_label', 'Confidence')}: ${confidenceLabel}`}
                            >
                              {confidenceLabel}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Probability Bar */}
                      <div className="probability-bar-wrapper">
                        <div className="probability-bar-outer">
                          <div
                            className="probability-bar-inner"
                            role="progressbar"
                            aria-valuenow={percentage}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`${t('gallery.probability_label', 'Probability')} for ${bar.label}`}
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                        <div className="probability-text">
                          {percentage}% {t('gallery.probability_label', 'Probability')}
                        </div>
                      </div>

                      {/* Verdict Text */}
                      {verdict && (
                        <div className="branch-verdict-box">
                          <SafeMarkdown>{verdict.verdict}</SafeMarkdown>
                        </div>
                      )}

                      {/* Excerpts matching this branch */}
                      {transcript_excerpts.some((ex) => ex.branch_index === bar.branch_index) && (
                        <div style={{ marginTop: '16px', borderTop: '1px solid var(--color-border-subtle)', paddingTop: '12px' }}>
                          <h5 style={{ margin: '0 0 8px 0', fontSize: '0.85rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
                            {t('gallery.transcript_title', 'Excerpts')}
                          </h5>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {transcript_excerpts
                              .filter((ex) => ex.branch_index === bar.branch_index)
                              .map((ex, idx) => (
                                <div key={idx} style={{ fontSize: '0.9rem' }}>
                                  {ex.round !== undefined && (
                                    <span
                                      style={{
                                        marginRight: '6px',
                                        fontSize: '0.75rem',
                                        fontWeight: 'bold',
                                        backgroundColor: 'var(--color-border-subtle)',
                                        padding: '2px 6px',
                                        borderRadius: '4px',
                                        color: 'var(--color-text-secondary)',
                                      }}
                                      aria-label={t('gallery.round_aria', { round: ex.round })}
                                    >
                                      R{ex.round}
                                    </span>
                                  )}
                                  <strong style={{ color: 'var(--color-primary)' }}>{ex.agent_name}:</strong>{' '}
                                  <span style={{ fontStyle: 'italic', color: 'var(--color-text-secondary)' }}>{ex.excerpt}</span>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="side-column">
          {/* Participating Agents */}
          <section className="artifact-section" aria-label={t('gallery.agents_aria')}>
            <h3>{t('gallery.agents_title', 'Agent Swarm')}</h3>
            {display_agent_names.length === 0 ? (
              <p>{t('common.empty', 'None')}</p>
            ) : (
              <ul className="agents-list">
                {display_agent_names.map((name, idx) => (
                  <li key={idx} className="agent-chip">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Sources Section */}
          <section className="artifact-section" aria-label={t('gallery.sources_aria')} style={{ marginTop: '24px' }}>
            <h3>{t('gallery.sources_title', 'Verified Sources')}</h3>
            {(!source_summary.domains || source_summary.domains.length === 0) ? (
              <p>{t('common.empty', 'None')}</p>
            ) : (
              <div className="sources-list">
                {source_summary.domains.map((item, idx) => (
                  <div key={idx} className="source-chip">
                    <span className="source-domain">{item.domain}</span>
                    <span className="source-count">{item.source_count}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="disclaimer">
        <p>{t('gallery.disclaimer_public')}</p>
      </div>
    </div>
  );
}
