/* ═══════════════════════════════════════════════════════════
   SwarmOracle — "Explore Deeper" bridge cards (workbench mode)
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useState } from 'react';
import { ScenarioAgentPicker } from '../../components/result/ScenarioAgentPicker';
import type { AgentInfo } from '../../types';
import { useResultContext } from './ResultContext';

export default function ExploreDeeperBridge() {
  const {
    t,
    branches,
    capLoading,
    activeScenarioId,
    capabilities,
    analysisBranch,
    isReplayMode,
    replayUrl,
    setShowShare,
    agents,
    setAgentFollowupTarget,
    setProfileTarget,
  } = useResultContext();

  const [pickerOpen, setPickerOpen] = useState(false);

  const handleAgentSelect = useCallback(
    (agent: AgentInfo) => {
      setPickerOpen(false);
      setAgentFollowupTarget(agent);
    },
    [setAgentFollowupTarget],
  );

  const handleClosePicker = useCallback(() => {
    setPickerOpen(false);
  }, []);

  const handleViewProfile = useCallback(
    (agent: AgentInfo) => {
      setPickerOpen(false);
      setProfileTarget(agent);
    },
    [setProfileTarget],
  );

  // Result-level next steps should stay visible in Reader mode. The dedicated
  // Workbench mode only reveals heavier analysis panels below this bridge.
  if (branches.length === 0 || capLoading || !activeScenarioId) {
    return null;
  }

  const causalEnabled = capabilities?.causal_graph?.enabled ?? false;
  const kgEnabled = capabilities?.kg_explorer?.enabled ?? false;
  const replayEnabled = capabilities?.replay_trace?.enabled ?? false;
  const compareEnabled = (capabilities?.counterfactual_replay?.enabled ?? false) && branches.length > 1;
  const agentConvEnabled = !!capabilities?.agent_conversation?.enabled;
  const agentsAvailable = agents.length > 0;
  const agentEntryEnabled = agentConvEnabled && agentsAvailable && !isReplayMode;
  const agentDisabledKey = isReplayMode
    ? 'result.bridge_replay_unavailable'
    : !agentConvEnabled
      ? 'result.bridge_not_enabled'
      : 'result.agent_picker_empty';
  const agentDisabledDefault = isReplayMode
    ? 'Not available in replay mode.'
    : !agentConvEnabled
      ? 'Not enabled on this server.'
      : 'No agents available for follow-up';
  const scenarioId = encodeURIComponent(activeScenarioId);
  const workbenchView = !causalEnabled && kgEnabled ? 'kg' : 'graph';
  const workbenchBranchQuery = analysisBranch
    ? `&branch=${encodeURIComponent(analysisBranch.id)}`
    : '';

  type LinkEntry = {
    key: string;
    kind: 'link';
    icon: string;
    titleKey: string;
    titleDefault: string;
    descKey: string;
    descDefault: string;
    enabled: boolean;
    href: string;
    disabledKey: string;
    disabledDefault: string;
  };
  type ActionEntry = {
    key: string;
    kind: 'action';
    icon: string;
    titleKey: string;
    titleDefault: string;
    descKey: string;
    descDefault: string;
    enabled: boolean;
    onClick: () => void;
    disabledKey: string;
    disabledDefault: string;
  };
  type Entry = LinkEntry | ActionEntry;

  const entries: Entry[] = [
    {
      key: 'full-report',
      kind: 'link',
      icon: '\u{1F4D1}',
      titleKey: 'result.bridge_full_report_title',
      titleDefault: 'Full Report',
      descKey: 'result.bridge_full_report_desc',
      descDefault: 'Read the comprehensive scenario report',
      enabled: (capabilities?.result_report?.enabled ?? false) && !isReplayMode,
      href: `/result/${scenarioId}/report`,
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : 'Not enabled on this server.',
    },
    {
      key: 'causal',
      kind: 'link',
      icon: '\u{1F578}️',
      titleKey: 'result.next_understand_why',
      titleDefault: 'Causal Graph',
      descKey: 'result.next_understand_why_desc',
      descDefault: 'Trace how events led to each ending.',
      enabled: causalEnabled,
      href: `/sim/${scenarioId}/causal-map`,
      disabledKey: 'result.bridge_not_enabled',
      disabledDefault: 'Not enabled on this server.',
    },
    {
      key: 'replay',
      kind: 'link',
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
      kind: 'link',
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
      kind: 'link',
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
      key: 'kg-explorer',
      kind: 'link',
      icon: '\u{1F578}️',
      titleKey: 'result.bridge_kg_explorer_title',
      titleDefault: 'Knowledge Graph Explorer',
      descKey: 'result.bridge_kg_explorer_desc',
      descDefault: 'See how characters, events, and claims connect',
      enabled: kgEnabled && !isReplayMode,
      href: `/kg-explorer/${scenarioId}`,
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : 'Not enabled on this server.',
    },
    {
      key: 'timeline-galaxy',
      kind: 'link',
      icon: '\u{1F30C}',
      titleKey: 'result.bridge_timeline_galaxy_title',
      titleDefault: 'Timeline Galaxy',
      descKey: 'result.bridge_timeline_galaxy_desc',
      descDefault: 'All the worldlines laid out on one timeline',
      enabled: kgEnabled && !isReplayMode,
      href: `/timeline-galaxy/${scenarioId}`,
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : 'Not enabled on this server.',
    },
    {
      key: 'agents',
      kind: 'action',
      icon: '\u{1F9EC}',
      titleKey: 'result.next_ask_agent',
      titleDefault: 'Ask an Agent',
      descKey: 'result.next_ask_agent_desc',
      descDefault: 'Chat with scenario agents to dig deeper',
      enabled: agentEntryEnabled,
      onClick: () => setPickerOpen(true),
      disabledKey: agentDisabledKey,
      disabledDefault: agentDisabledDefault,
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
          if (isDisabled) {
            const disabledCardContent = (
              <>
                <span className="result-bridge__card-icon" aria-hidden="true">{entry.icon}</span>
                <span className="result-bridge__card-name">{t(entry.titleKey, entry.titleDefault)}</span>
                <span className="result-bridge__card-desc">{t(entry.descKey, entry.descDefault)}</span>
                <span id={statusId} className="result-bridge__card-status">{t(entry.disabledKey, entry.disabledDefault)}</span>
              </>
            );
            if (entry.kind === 'action') {
              return (
                <button
                  key={entry.key}
                  type="button"
                  className="result-bridge__card result-bridge__card--disabled"
                  disabled
                  aria-describedby={statusId}
                >
                  {disabledCardContent}
                </button>
              );
            }
            return (
              <div
                key={entry.key}
                className="result-bridge__card result-bridge__card--disabled"
                aria-disabled="true"
                tabIndex={-1}
                role="link"
                aria-describedby={statusId}
              >
                {disabledCardContent}
              </div>
            );
          }
          if (entry.kind === 'action') {
            return (
              <button
                key={entry.key}
                type="button"
                className="result-bridge__card"
                onClick={entry.onClick}
                data-testid={`result-bridge-${entry.key}`}
              >
                <span className="result-bridge__card-icon" aria-hidden="true">{entry.icon}</span>
                <span className="result-bridge__card-name">{t(entry.titleKey, entry.titleDefault)}</span>
                <span className="result-bridge__card-desc">{t(entry.descKey, entry.descDefault)}</span>
              </button>
            );
          }
          return (
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

      <ScenarioAgentPicker
        open={pickerOpen}
        agents={agents}
        onSelect={handleAgentSelect}
        onClose={handleClosePicker}
        onViewProfile={handleViewProfile}
      />
    </section>
  );
}
