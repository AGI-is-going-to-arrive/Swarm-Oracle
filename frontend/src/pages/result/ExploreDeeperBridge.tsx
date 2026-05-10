/* ═══════════════════════════════════════════════════════════
   SwarmOracle — "Explore Deeper" bridge cards (workbench mode)
   ═══════════════════════════════════════════════════════════ */

import { useResultContext } from './ResultContext';

export default function ExploreDeeperBridge() {
  const {
    t,
    isWorkbenchMode,
    branches,
    capLoading,
    activeScenarioId,
    capabilities,
    analysisBranch,
    isReplayMode,
    replayUrl,
    setShowShare,
  } = useResultContext();

  // Visibility guard: workbench mode + branches present + scenario id ready
  if (!isWorkbenchMode || branches.length === 0 || capLoading || !activeScenarioId) {
    return null;
  }

  const causalEnabled = capabilities?.causal_graph?.enabled ?? false;
  const kgEnabled = capabilities?.kg_explorer?.enabled ?? false;
  const replayEnabled = capabilities?.replay_trace?.enabled ?? false;
  const compareEnabled = (capabilities?.counterfactual_replay?.enabled ?? false) && branches.length > 1;
  const agentEnabled = !!(capabilities?.custom_agents?.enabled);
  const scenarioId = encodeURIComponent(activeScenarioId);
  const workbenchView = !causalEnabled && kgEnabled ? 'kg' : 'graph';
  const workbenchBranchQuery = analysisBranch
    ? `&branch=${encodeURIComponent(analysisBranch.id)}`
    : '';

  const entries: Array<{
    key: string;
    icon: string;
    titleKey: string;
    titleDefault: string;
    descKey: string;
    descDefault: string;
    enabled: boolean;
    href: string;
    disabledKey: string;
    disabledDefault: string;
  }> = [
    {
      key: 'causal',
      icon: '\u{1F578}️',
      titleKey: 'result.next_understand_why',
      titleDefault: 'Causal Graph',
      descKey: 'result.next_understand_why_desc',
      descDefault: 'Trace how events led to each ending.',
      enabled: causalEnabled,
      href: `/sim/${scenarioId}/causal-map${analysisBranch ? `?branch_id=${encodeURIComponent(analysisBranch.id)}` : ''}`,
      disabledKey: 'result.bridge_not_enabled',
      disabledDefault: 'Not enabled on this server.',


    },
    {
      key: 'replay',
      icon: '\u{1F3AC}',
      titleKey: 'result.next_replay_trace',
      titleDefault: 'Replay Trace',
      descKey: 'result.next_replay_trace_desc',
      descDefault: 'Step through the simulation round by round.',
      enabled: replayEnabled && !isReplayMode,
      href: `/replay/${scenarioId}`,
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : 'Not enabled on this server.',


    },
    {
      key: 'compare',
      icon: '\u{1F500}',
      titleKey: 'result.next_replay_different',
      titleDefault: 'Compare Branches',
      descKey: 'result.next_replay_different_desc',
      descDefault: 'See how different branches diverged.',
      enabled: compareEnabled && !isReplayMode,
      href: analysisBranch && branches.length > 1
        ? `/result/${scenarioId}/compare?branch_a=${encodeURIComponent(analysisBranch.id)}&branch_b=${encodeURIComponent((branches.find(b => b.id !== analysisBranch.id) ?? branches[0]).id)}`
        : '#',
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : (branches.length <= 1 ? 'result.bridge_single_branch' : 'result.bridge_not_enabled'),
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : (branches.length <= 1 ? 'Only one branch — nothing to compare.' : 'Not enabled on this server.'),


    },
    {
      key: 'workbench',
      icon: '\u{1F6E0}️',
      titleKey: 'result.bridge_workbench_title',
      titleDefault: 'Open Graph Workbench',
      descKey: 'result.bridge_workbench_desc',
      descDefault: 'Compare causal and knowledge graphs side by side',
      enabled: (causalEnabled || kgEnabled) && !isReplayMode,
      href: `/workbench/${scenarioId}?view=${workbenchView}${workbenchBranchQuery}`,
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : 'Not enabled on this server.',
    },
    {
      key: 'agents',
      icon: '\u{1F9EC}',
      titleKey: 'result.next_ask_agent',
      titleDefault: 'Agent Library',
      descKey: 'result.next_ask_agent_desc',
      descDefault: 'Browse agent identities and cross-scenario memory.',
      enabled: agentEnabled && !isReplayMode,
      href: '/agents',
      disabledKey: 'result.bridge_agents_disabled',
      disabledDefault: 'Agent identity is not enabled.',
    },
  ];

  const shareDisabled = isReplayMode || !replayUrl;
  const shareStatusId = 'result-bridge-share-status';
  const shareReason = isReplayMode
    ? t('result.bridge_disabled_replay')
    : !replayUrl
      ? t('result.bridge_disabled_loading')
      : undefined;

  return (
    <section id="result-bridge" className="result-bridge">
      <h2 className="result-bridge__heading">{t('result.next_steps_heading')}</h2>
      <div className="result-bridge__grid">
        {entries.map((entry) => {
          const isDisabled = !entry.enabled;
          const statusId = `result-bridge-${entry.key}-status`;
          return isDisabled ? (
            <div
              key={entry.key}
              className="result-bridge__card result-bridge__card--disabled"
              aria-disabled="true"
              tabIndex={-1}
              role="link"
              aria-describedby={statusId}
            >
              <span className="result-bridge__card-icon" aria-hidden="true">{entry.icon}</span>
              <span className="result-bridge__card-name">{t(entry.titleKey, entry.titleDefault)}</span>
              <span className="result-bridge__card-desc">{t(entry.descKey, entry.descDefault)}</span>
              <span id={statusId} className="result-bridge__card-status">{t(entry.disabledKey, entry.disabledDefault)}</span>
            </div>
          ) : (
            <a
              key={entry.key}
              className="result-bridge__card"
              href={entry.href}
            >
              <span className="result-bridge__card-icon" aria-hidden="true">{entry.icon}</span>
              <span className="result-bridge__card-name">{t(entry.titleKey, entry.titleDefault)}</span>
              <span className="result-bridge__card-desc">{t(entry.descKey, entry.descDefault)}</span>
            </a>
          );
        })}
        <button
          className={`result-bridge__card${shareDisabled ? ' result-bridge__card--disabled' : ''}`}
          onClick={() => { if (!shareDisabled) setShowShare(true); }}
          disabled={shareDisabled}
          title={shareReason}
          aria-describedby={shareDisabled ? shareStatusId : undefined}
        >
          <span className="result-bridge__card-icon" aria-hidden="true">📋</span>
          <span className="result-bridge__card-name">{t('result.next_share')}</span>
          <span className="result-bridge__card-desc">{t('result.next_share_desc')}</span>
          {shareDisabled && shareReason && (
            <span id={shareStatusId} className="result-bridge__card-status">{shareReason}</span>
          )}
        </button>
      </div>
    </section>
  );
}
