/* ═══════════════════════════════════════════════════════════
   SwarmOracle — "Explore Deeper" bridge cards (workbench mode)
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useState } from 'react';
import { FileText, GitBranch, MessageCircle } from 'lucide-react';
import { ScenarioAgentPicker } from '../../components/result/ScenarioAgentPicker';
import type { AgentInfo, StoryData } from '../../types';
import { useResultContext } from './ResultContext';

type FullReportBridgeCopy = {
  titleKey: string;
  titleDefault: string;
  descKey: string;
  descDefault: string;
};

function getFullReportBridgeCopy(
  report: StoryData['full_report'],
  stale = false,
): FullReportBridgeCopy {
  if (report && stale) {
    return {
      titleKey: 'result.bridge_historical_report_title',
      titleDefault: 'Read the saved analysis',
      descKey: 'result.bridge_historical_report_desc',
      descDefault: 'Review the earlier analysis or generate one for the current state.',
    };
  }
  if (!report) {
    return {
      titleKey: 'result.bridge_full_report_generate_title',
      titleDefault: 'Generate Full Report',
      descKey: 'result.bridge_full_report_generate_desc',
      descDefault: 'Generate a full report for this run.',
    };
  }

  if ('truncated' in report) {
    return {
      titleKey: 'result.bridge_full_report_retry_title',
      titleDefault: 'Retry Full Report',
      descKey: 'result.bridge_full_report_retry_desc',
      descDefault: 'The saved response was truncated. Open the report to retry.',
    };
  }

  const hasSavedSections = report.sections.length > 0;
  if (report.detail_level === 'brief' && hasSavedSections) {
    return {
      titleKey: 'result.bridge_brief_report_title',
      titleDefault: 'Read the short report',
      descKey: 'result.bridge_brief_report_desc',
      descDefault: 'Read saved evidence first; request a full analysis when needed.',
    };
  }
  if (report.status === 'generating') {
    return {
      titleKey: 'result.bridge_full_report_progress_title',
      titleDefault: 'View Report Progress',
      descKey: 'result.bridge_full_report_progress_desc',
      descDefault: 'The report is still being generated. Open it to see saved progress.',
    };
  }

  if (report.status === 'complete' && hasSavedSections) {
    return {
      titleKey: 'result.bridge_full_report_read_title',
      titleDefault: 'Read Full Report',
      descKey: 'result.bridge_full_report_read_desc',
      descDefault: 'Read the full report for this run.',
    };
  }

  if (hasSavedSections) {
    return {
      titleKey: 'result.bridge_full_report_saved_title',
      titleDefault: 'Review Saved Sections',
      descKey: 'result.bridge_full_report_saved_desc',
      descDefault: 'Review the sections saved before generation stopped.',
    };
  }

  if (report.status === 'skipped') {
    return {
      titleKey: 'result.bridge_full_report_status_title',
      titleDefault: 'View Report Status',
      descKey: 'result.bridge_full_report_status_desc',
      descDefault: 'No report content was generated. Open the report to view its status.',
    };
  }

  return {
    titleKey: 'result.bridge_full_report_retry_title',
    titleDefault: 'Retry Full Report',
    descKey: 'result.bridge_full_report_retry_desc',
    descDefault: 'No readable report sections were saved. Open the report to retry.',
  };
}

export default function ExploreDeeperBridge() {
  const {
    t,
    branches,
    capLoading,
    capError,
    reloadCapabilities,
    activeScenarioId,
    capabilities,
    scenario,
    storyData,
    analysisBranch,
    isReplayMode,
    replayUrl,
    setShowShare,
    agents,
    setAgentFollowupTarget,
    setProfileTarget,
    setResultViewMode,
    isWorkbenchMode,
    comparisonHref,
    handleOpenComparison,
    hasSavedEvidence,
    handleOpenEvidence,
  } = useResultContext();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [counterfactualFocusScenario, setCounterfactualFocusScenario] = useState<string | null>(null);
  useEffect(() => {
    if (counterfactualFocusScenario === null) return;
    const frame = window.requestAnimationFrame(() => {
      setCounterfactualFocusScenario(null);
      if (counterfactualFocusScenario !== activeScenarioId || !isWorkbenchMode) return;
      const editor = document.getElementById('result-counterfactual');
      if (!editor || editor.dataset.scenarioId !== activeScenarioId) return;
      editor.scrollIntoView({ block: 'start', behavior: 'auto' });
      editor.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeScenarioId, counterfactualFocusScenario, isWorkbenchMode]);
  const openCounterfactualEditor = useCallback(() => {
    setResultViewMode('workbench');
    setCounterfactualFocusScenario(activeScenarioId);
  }, [activeScenarioId, setResultViewMode]);

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

  if (capError) {
    return (
      <section id="result-bridge" className="result-bridge">
        <h2 className="result-bridge__heading">{t('result.next_steps_heading')}</h2>
        <div className="result-bridge__availability-error">
          <p role="alert">
            {t(
              'result.bridge_capabilities_unavailable',
              'Could not confirm which analysis tools are available. Please retry.',
            )}
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void reloadCapabilities?.()}
          >
            {t('result.bridge_capabilities_retry', 'Retry availability check')}
          </button>
        </div>
      </section>
    );
  }

  const causalEnabled = capabilities?.causal_graph?.enabled ?? false;
  const kgEnabled = capabilities?.kg_explorer?.enabled ?? false;
  const replayEnabled = capabilities?.replay_trace?.enabled ?? false;
  const hasCausalGraph = Boolean(scenario?.causal_graph_id);
  const hasReplayLineage = branches.some((branch) => Boolean(branch.replay_source_branch_id));
  const hasReplayData = hasReplayLineage || (causalEnabled && hasCausalGraph);
  const fullReportCopy = getFullReportBridgeCopy(storyData?.full_report, storyData?.full_report_stale);
  const compareEnabled = (capabilities?.counterfactual_replay?.enabled ?? false)
    && branches.length > 1;
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
    titleKey: string;
    titleDefault: string;
    descKey: string;
    descDefault: string;
    enabled: boolean;
    href: string;
    disabledKey: string;
    disabledDefault: string;
    onNavigate?: () => void;
  };
  type ActionEntry = {
    key: string;
    kind: 'action';
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
      key: 'counterfactual',
      kind: 'action',
      titleKey: 'result.change_editor_title',
      titleDefault: 'Rewrite a turn and replay',
      descKey: 'result.change_editor_desc',
      descDefault: 'Choose a saved turn and explore a different decision.',
      enabled: Boolean(capabilities?.counterfactual_replay?.enabled)
        && !isReplayMode && scenario?.status === 'done' && branches.length > 0,
      onClick: openCounterfactualEditor,
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable'
        : !capabilities?.counterfactual_replay?.enabled ? 'result.bridge_not_enabled'
          : 'result.change_requires_completed',
      disabledDefault: 'A completed simulation is required.',
    },
    {
      key: 'evidence',
      kind: 'action',
      titleKey: 'result.evidence_title',
      titleDefault: 'Read saved evidence',
      descKey: 'result.evidence_desc',
      descDefault: 'Inspect stored quotes and follow their source coordinates.',
      enabled: hasSavedEvidence && !isReplayMode,
      onClick: () => handleOpenEvidence(),
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : 'result.evidence_unavailable',
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : 'No saved evidence is available for this result.',
    },
    {
      key: 'full-report',
      kind: 'link',
      ...fullReportCopy,
      enabled: (capabilities?.result_report?.enabled ?? false) && !isReplayMode,
      href: `/result/${scenarioId}/report`,
      disabledKey: isReplayMode ? 'result.bridge_replay_unavailable' : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode ? 'Not available in replay mode.' : 'Not enabled on this server.',
    },
    {
      key: 'causal',
      kind: 'link',
      titleKey: 'result.next_understand_why',
      titleDefault: 'Causal Graph',
      descKey: 'result.next_understand_why_desc',
      descDefault: 'Trace how events led to each ending.',
      enabled: causalEnabled && hasCausalGraph && !isReplayMode,
      href: `/sim/${scenarioId}/causal-map`,
      disabledKey: isReplayMode
        ? 'result.bridge_replay_unavailable'
        : causalEnabled
          ? 'result.bridge_causal_data_unavailable'
          : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode
        ? 'Not available in replay mode.'
        : causalEnabled
          ? 'No causal graph data is available for this scenario.'
          : 'Not enabled on this server.',
    },
    {
      key: 'replay',
      kind: 'link',
      titleKey: 'result.next_replay_trace',
      titleDefault: 'Replay Trace',
      descKey: 'result.next_replay_trace_desc',
      descDefault: 'Step through the simulation round by round.',
      enabled: replayEnabled && hasReplayData && !isReplayMode,
      href: `/replay/${scenarioId}`,
      disabledKey: isReplayMode
        ? 'result.bridge_replay_unavailable'
        : replayEnabled
          ? 'result.bridge_replay_data_unavailable'
          : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode
        ? 'Not available in replay mode.'
        : replayEnabled
          ? 'No replay trace is available for this scenario.'
          : 'Not enabled on this server.',
    },
    {
      key: 'compare',
      kind: 'link',
      titleKey: 'result.compare_existing_title',
      titleDefault: 'Compare Branches',
      descKey: 'result.compare_existing_desc',
      descDefault: 'See how different branches diverged.',
      enabled: compareEnabled && Boolean(comparisonHref),
      href: comparisonHref ?? '#',
      onNavigate: handleOpenComparison,
      disabledKey: isReplayMode
        ? 'result.bridge_replay_unavailable'
        : branches.length <= 1
          ? 'result.bridge_single_branch'
          : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode
        ? 'Not available in replay mode.'
        : branches.length <= 1
          ? 'Only one branch — nothing to compare.'
          : 'Not enabled on this server.',
    },
    {
      key: 'workbench',
      kind: 'link',
      titleKey: 'result.bridge_workbench_title',
      titleDefault: 'Open Graph Workbench',
      descKey: 'result.bridge_workbench_desc',
      descDefault: 'Compare causal and knowledge graphs side by side',
      enabled: (causalEnabled || kgEnabled) && hasCausalGraph && !isReplayMode,
      href: `/workbench/${scenarioId}?view=${workbenchView}${workbenchBranchQuery}`,
      disabledKey: isReplayMode
        ? 'result.bridge_replay_unavailable'
        : (causalEnabled || kgEnabled)
          ? 'result.bridge_causal_data_unavailable'
          : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode
        ? 'Not available in replay mode.'
        : (causalEnabled || kgEnabled)
          ? 'No causal graph data is available for this scenario.'
          : 'Not enabled on this server.',
    },
    {
      key: 'kg-explorer',
      kind: 'link',
      titleKey: 'result.bridge_kg_explorer_title',
      titleDefault: 'Knowledge Graph Explorer',
      descKey: 'result.bridge_kg_explorer_desc',
      descDefault: 'See how characters, events, and claims connect',
      enabled: kgEnabled && hasCausalGraph && !isReplayMode,
      href: `/kg-explorer/${scenarioId}`,
      disabledKey: isReplayMode
        ? 'result.bridge_replay_unavailable'
        : kgEnabled
          ? 'result.bridge_causal_data_unavailable'
          : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode
        ? 'Not available in replay mode.'
        : kgEnabled
          ? 'No causal graph data is available for this scenario.'
          : 'Not enabled on this server.',
    },
    {
      key: 'timeline-galaxy',
      kind: 'link',
      titleKey: 'result.bridge_timeline_galaxy_title',
      titleDefault: 'Timeline Galaxy',
      descKey: 'result.bridge_timeline_galaxy_desc',
      descDefault: 'All the worldlines laid out on one timeline',
      enabled: kgEnabled && hasCausalGraph && !isReplayMode,
      href: `/timeline-galaxy/${scenarioId}`,
      disabledKey: isReplayMode
        ? 'result.bridge_replay_unavailable'
        : kgEnabled
          ? 'result.bridge_causal_data_unavailable'
          : 'result.bridge_not_enabled',
      disabledDefault: isReplayMode
        ? 'Not available in replay mode.'
        : kgEnabled
          ? 'No causal graph data is available for this scenario.'
          : 'Not enabled on this server.',
    },
    {
      key: 'agents',
      kind: 'action',
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
  const taskGroups = [
    { key: 'verify', icon: FileText, entries: ['evidence', 'full-report', 'workbench'] },
    { key: 'ask', icon: MessageCircle, entries: ['agents'] },
    { key: 'change', icon: GitBranch, entries: ['counterfactual', 'compare'] },
  ];
  const coreEntries = new Set(taskGroups.flatMap((group) => group.entries));
  const renderEntry = (entry: Entry) => {
    const isDisabled = !entry.enabled;
    const statusId = `result-bridge-${entry.key}-status`;
    const content = <>
      <span className="result-bridge__card-name">{t(entry.titleKey, entry.titleDefault)}</span>
      <span className="result-bridge__card-desc">{t(entry.descKey, entry.descDefault)}</span>
      {isDisabled && <span id={statusId} className="result-bridge__card-status">{t(entry.disabledKey, entry.disabledDefault)}</span>}
    </>;
    const className = `result-bridge__card${isDisabled ? ' result-bridge__card--disabled' : ''}`;
    if (entry.kind === 'action') {
      return <button key={entry.key} type="button" className={className} disabled={isDisabled} onClick={entry.onClick} aria-describedby={isDisabled ? statusId : undefined} data-testid={`result-bridge-${entry.key}`}>{content}</button>;
    }
    if (isDisabled) {
      return <div key={entry.key} className={className} aria-disabled="true" tabIndex={-1} role="link" aria-describedby={statusId}>{content}</div>;
    }
    return <a key={entry.key} className={className} href={entry.href} onClick={(event) => {
      if (entry.onNavigate && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.button === 0) {
        event.preventDefault();
        entry.onNavigate();
      }
    }}>{content}</a>;
  };

  return (
    <section id="result-bridge" className="result-bridge">
      <h2 className="result-bridge__heading">{t('result.next_steps_heading')}</h2>
      <div className="result-bridge__tasks">
        {taskGroups.map((group) => (
          <section key={group.key} className="result-bridge__task" aria-labelledby={`result-task-${group.key}`}>
            <h3 id={`result-task-${group.key}`}><group.icon size={20} aria-hidden="true" />{t(`result.task_${group.key}`)}</h3>
            <div className="result-bridge__task-actions">
              {group.entries.map((key) => entries.find((entry) => entry.key === key))
                .filter((entry): entry is Entry => entry !== undefined).map(renderEntry)}
            </div>
          </section>
        ))}
      </div>
      <details className="result-optional-section">
        <summary>{t('result.more_analysis_tools')}</summary>
        <div className="result-bridge__grid">
          {entries.filter((entry) => !coreEntries.has(entry.key)).map(renderEntry)}
        <button
          className={`result-bridge__card${shareDisabled ? ' result-bridge__card--disabled' : ''}`}
          onClick={() => { if (!shareDisabled) setShowShare(true); }}
          disabled={shareDisabled}
          title={shareReason}
          aria-describedby={shareDisabled ? shareStatusId : undefined}
        >
          <span className="result-bridge__card-name">{t('result.next_share')}</span>
          <span className="result-bridge__card-desc">{t('result.next_share_desc')}</span>
          {shareDisabled && shareReason && (
            <span id={shareStatusId} className="result-bridge__card-status">{shareReason}</span>
          )}
        </button>
        </div>
      </details>

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
