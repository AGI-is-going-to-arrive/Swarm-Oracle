import { describe, expect, it } from 'vitest';

import en from './locales/en.json';
import zh from './locales/zh.json';

describe('i18n locale resources', () => {
  it('provides shared common action labels used by live modals', () => {
    expect(en.translation.common.cancel).toBe('Cancel');
    expect(zh.translation.common.cancel).toBe('取消');
    expect(en.translation.common.close).toBe('Close');
    expect(zh.translation.common.close).toBe('关闭');
  });

  it('provides Phase D labels for shared debate and Oracle surfaces', () => {
    expect(en.translation.debate.strategy_accordion_label).toBe('Strategy panels');
    expect(zh.translation.debate.strategy_accordion_label).toBe('策略面板');
    expect(en.translation.ending_room.sidebar_mobile_label).toBe('Chamber sidebar');
    expect(zh.translation.ending_room.sidebar_mobile_label).toBe('密室侧栏');
    expect(en.translation.ending_room.sidebar_mobile_description).toBe('Quick actions and participant details for this chamber.');
    expect(zh.translation.ending_room.sidebar_mobile_description).toBe('查看此密室的快捷操作与参与者详情。');
    expect(en.translation.roundtable.phase_insights_label).toBe('Key takeaways');
    expect(zh.translation.roundtable.phase_insights_label).toBe('各阶段要点');
    expect(en.translation.common.more_count).toBe('+{{count}} more');
    expect(zh.translation.common.more_count).toBe('+{{count}} 更多');
  });

  it('provides localized theater labels and hints for simulation controls', () => {
    expect(en.translation.home.viz_theater).toBe('Pixel Theater');
    expect(zh.translation.home.viz_theater).toBe('像素剧场');
    expect(en.translation.home.viz_classic).toBe('Classic');
    expect(zh.translation.home.viz_classic).toBe('经典模式');
    expect(en.translation.home.reasoning_low).toBe('Light');
    expect(en.translation.home.reasoning_medium).toBe('Balanced');
    expect(en.translation.home.reasoning_high).toBe('Deep');
    expect(zh.translation.home.reasoning_low).toBe('轻量');
    expect(zh.translation.home.reasoning_medium).toBe('均衡');
    expect(zh.translation.home.reasoning_high).toBe('深入');
    expect(en.translation.sim.theater_unavailable_hint).toContain('Pixel Theater');
    expect(zh.translation.sim.theater_unavailable_hint).toContain('像素剧场');
    expect(zh.translation.game.capture_mode_panel).toBe('面板');
    expect(zh.translation.game.capture_mode_canvas).toBe('画布');
    expect(zh.translation.game.capture_mode_modal).toBe('弹窗');
  });

  it('provides localized runtime preset labels for the homepage and gameplay pages', () => {
    expect(en.translation.home.runtime_preset_label).toBe('Oracle Profile');
    expect(zh.translation.home.runtime_preset_label).toBe('神谕档位');
    expect(en.translation.home.runtime_preset_conservative).toBe('Watchful');
    expect(en.translation.home.runtime_preset_balanced).toBe('Calibrated');
    expect(en.translation.home.runtime_preset_aggressive).toBe('Riftbound');
    expect(zh.translation.home.runtime_preset_conservative).toBe('守望');
    expect(zh.translation.home.runtime_preset_balanced).toBe('校准');
    expect(zh.translation.home.runtime_preset_aggressive).toBe('裂界');
    expect(en.translation.sim.runtime_preset_title).toBe('Oracle Profile');
    expect(zh.translation.sim.runtime_preset_title).toBe('本局神谕档位');
    expect(en.translation.debate.runtime_preset_not_applicable).toContain('Debate Arena');
    expect(zh.translation.debate.runtime_preset_not_applicable).toContain('Debate Arena');
  });

  it('provides localized labels for Phase 3 agent, causal, and compare pages', () => {
    expect(en.translation.agents.library_title).toBe('Agent Library');
    expect(zh.translation.agents.library_title).toBe('Agent 库');
    expect(en.translation.agents.attach_title).toBe('Attach Custom Agents');
    expect(zh.translation.agents.attach_title).toBe('附加自定义 Agent');

    expect(en.translation.causal.title).toBe('Causal Graph');
    expect(zh.translation.causal.title).toBe('因果图谱');
    expect(en.translation.compare.title).toBe('Counterfactual Compare');
    expect(zh.translation.compare.title).toBe('反事实对比');
    expect(en.translation.compare.error_fetch).toBe('Unable to load comparison data right now. Please retry.');
    expect(zh.translation.compare.error_fetch).toBe('当前无法加载对比数据，请稍后重试。');
    expect(en.translation.compare.round).toBe('Round {{round}}');
    expect(zh.translation.compare.round).toBe('第 {{round}} 轮');
  });

  it('provides localized labels for ResultView Phase C action links', () => {
    expect(en.translation.result.causal_graph_link).toBeTruthy();
    expect(zh.translation.result.causal_graph_link).toBeTruthy();
    expect(en.translation.result.compare_link).toBeTruthy();
    expect(zh.translation.result.compare_link).toBeTruthy();
  });

  it('keeps the new bridge and graph-guide locale keys present in both English and Chinese resources', () => {
    const resultBridgeKeys = [
      'bridge_title',
      'bridge_causal_title',
      'bridge_causal_desc',
      'bridge_replay_title',
      'bridge_replay_desc',
      'bridge_compare_title',
      'bridge_compare_desc',
      'bridge_not_enabled',
      'bridge_replay_unavailable',
      'bridge_single_branch',
      'bridge_workbench_title',
      'bridge_workbench_desc',
    ] as const;
    const resultFollowupKeys = [
      'load_result_failed',
      'import_replay_failed',
      'import_chamber_replay_failed',
      'replay_copied',
      'copy_replay',
      'saved_local_readonly_copy',
      'save_local_readonly_copy',
      'importing_local_run',
      'import_local_run',
      'archive_commitment_hit',
      'archive_commitment_missed',
      'archive_commitment_pending',
      'archive_no_commitment',
      'archive_director_goals_label',
      'archive_worldline_commitment_label',
      'archive_signature_arc_label',
      'archive_system_tracks_label',
      'ending_room_picker_title',
      'ending_room_picker_limit',
      'ending_room_picker_empty',
      'ending_room_picker_impact',
      'ending_room_picker_fallback_roster',
      'ending_room_picker_fallback_lineup',
      'ending_room_picker_enter',
    ] as const;
    const causalGuideKeys = [
      'guide_title',
      'guide_close',
      'guide_story',
      'guide_story_no_outcomes',
      'guide_story_no_forks',
      'guide_stats_label',
      'guide_routes_title',
      'guide_route_connector',
      'guide_route_more',
      'guide_key_nodes',
      'guide_link_count',
      'guide_link_breakdown',
      'guide_key_node_reason_fork',
      'guide_key_node_reason_outcome',
      'guide_key_node_reason_intervention',
      'guide_key_node_reason_event',
      'guide_relation_explainer',
      'guide_hint',
      'guide_preview_action',
      'guide_preview_aria',
      'guide_expand_details',
      'guide_collapse_details',
      'guide_show',
      'guide_full_graph',
      'empty_guide',
      'evidence_high_context',
      'evidence_medium_context',
      'evidence_low_context',
      'edge_round_context',
      'edge_confidence_context',
      'edge_context_suffix',
    ] as const;
    const conversationQuickQuestionKeys = [
      'knowledge_q_1',
      'knowledge_q_2',
      'knowledge_q_3',
      'argument_verdict_q_1',
      'argument_verdict_q_2',
      'argument_verdict_q_3',
      'argument_evidence_q_1',
      'argument_evidence_q_2',
      'argument_evidence_q_3',
      'argument_rebuttal_q_1',
      'argument_rebuttal_q_2',
      'argument_rebuttal_q_3',
      'argument_claim_q_1',
      'argument_claim_q_2',
      'argument_claim_q_3',
      'causal_fork_q_1',
      'causal_fork_q_2_effect',
      'causal_fork_q_2',
      'causal_fork_q_3_cause',
      'causal_fork_q_3',
      'causal_outcome_q_1',
      'causal_outcome_q_2_cause',
      'causal_outcome_q_2',
      'causal_outcome_q_3',
      'causal_intervention_q_1',
      'causal_intervention_q_2_effect',
      'causal_intervention_q_2',
      'causal_intervention_q_3',
      'causal_event_q_1_agent',
      'causal_event_q_1',
      'causal_event_q_2_cause',
      'causal_event_q_2',
      'causal_event_q_3_effect',
      'causal_event_q_3_relation',
      'causal_event_q_3',
      'result_topic_fallback',
      'result_title_named',
      'result_subtitle_named',
      'result_context_q_1',
      'result_context_q_2_cause',
      'result_context_q_2',
      'result_context_q_3_compare',
      'result_context_q_3',
    ] as const;

    for (const key of resultBridgeKeys) {
      expect(en.translation.result[key]).toEqual(expect.any(String));
      expect(zh.translation.result[key]).toEqual(expect.any(String));
    }
    for (const key of resultFollowupKeys) {
      expect(en.translation.result[key]).toEqual(expect.any(String));
      expect(zh.translation.result[key]).toEqual(expect.any(String));
    }
    for (const key of causalGuideKeys) {
      expect(en.translation.causal[key]).toEqual(expect.any(String));
      expect(zh.translation.causal[key]).toEqual(expect.any(String));
    }
    for (const key of conversationQuickQuestionKeys) {
      expect(en.translation.conversation.empty_state[key]).toEqual(expect.any(String));
      expect(zh.translation.conversation.empty_state[key]).toEqual(expect.any(String));
    }
    expect(en.translation.node_context_banner.target_knowledge_analyst_label).toEqual(expect.any(String));
    expect(zh.translation.node_context_banner.target_knowledge_analyst_label).toEqual(expect.any(String));
    expect(en.translation.node_context_banner.target_argument_analyst_label).toEqual(expect.any(String));
    expect(zh.translation.node_context_banner.target_argument_analyst_label).toEqual(expect.any(String));
    expect(en.translation.kg_explorer.related_incoming).toEqual(expect.any(String));
    expect(zh.translation.kg_explorer.related_incoming).toEqual(expect.any(String));
    expect(en.translation.argument.related_context_line).toEqual(expect.any(String));
    expect(zh.translation.argument.related_context_line).toEqual(expect.any(String));
  });

  it('provides localized graph node detail labels and counterfactual labels', () => {
    expect(en.translation.node_detail.agent).toBe('Agent');
    expect(zh.translation.node_detail.agent).toBe('Agent');
    expect(en.translation.causal.search_agent).toBe('Search nodes or agents...');
    expect(zh.translation.causal.search_agent).toBe('搜索节点或 Agent...');
    expect(en.translation.causal.search_summary).toBe('{{matches}} direct matches · {{related}} related nodes kept for context');
    expect(zh.translation.causal.search_summary).toBe('{{matches}} 个直接命中 · 保留 {{related}} 个相关节点帮助理解上下文');
    expect(en.translation.node_detail.emotion).toBe('Emotion');
    expect(zh.translation.node_detail.emotion).toBe('情绪');
    expect(en.translation.node_detail.stance).toBe('Stance');
    expect(zh.translation.node_detail.stance).toBe('立场');
    expect(en.translation.node_detail.side).toBe('Side');
    expect(zh.translation.node_detail.side).toBe('立场方');
    expect(en.translation.node_detail.outcome_story).toBe('Outcome Story');
    expect(zh.translation.node_detail.outcome_story).toBe('结局详情');
    expect(en.translation.node_detail.fork_reason).toBe('Fork Reason');
    expect(zh.translation.node_detail.fork_reason).toBe('分支原因');
    expect(en.translation.node_detail.fork_impact).toBe('Impact');
    expect(zh.translation.node_detail.fork_impact).toBe('影响');
    expect(en.translation.node_context_banner.target_graph_analyst_label).toBe('Graph analyst');
    expect(zh.translation.node_context_banner.target_graph_analyst_label).toBe('图谱解读 Agent');
    expect(en.translation.node_context_banner.meaning_event_title).toBe('Event card');
    expect(zh.translation.node_context_banner.meaning_event_title).toBe('事件卡');
    expect(en.translation.node_context_banner.cause_title).toBe('Why this card appears');
    expect(zh.translation.node_context_banner.cause_title).toBe('为什么会出现');
    expect(en.translation.causal.node_card_summary_event).toBe('Causes {{causeCount}} · effects {{effectCount}}');
    expect(zh.translation.causal.node_card_summary_event).toBe('前因 {{causeCount}} · 后续 {{effectCount}}');
    expect(en.translation.node_detail.copy_ref).toBe('Copy Reference');
    expect(zh.translation.node_detail.copy_ref).toBe('复制引用');
    expect(en.translation.node_detail.copy_ref_failed).toBe('Failed to copy reference');
    expect(zh.translation.node_detail.copy_ref_failed).toBe('复制引用失败');
    expect(en.translation.export.exporting_png).toBe('Exporting PNG...');
    expect(zh.translation.export.exporting_png).toBe('PNG 导出中...');
    expect(en.translation.export.exporting_svg).toBe('Exporting SVG...');
    expect(zh.translation.export.exporting_svg).toBe('SVG 导出中...');
    expect(en.translation.export.png_failed).toBe('Failed to export PNG. Try again.');
    expect(zh.translation.export.png_failed).toBe('PNG 导出失败，请重试。');
    expect(en.translation.export.svg_failed).toBe('Failed to export SVG. Try again.');
    expect(zh.translation.export.svg_failed).toBe('SVG 导出失败，请重试。');
    expect(en.translation.common.graph_node_a11y).toBe('Graph node. Press Enter or Space to open details.');
    expect(zh.translation.common.graph_node_a11y).toBe('图谱节点。按回车或空格可打开详情。');
    expect(en.translation.common.graph_edge_a11y).toBe('Graph edge. Relation details are available in the text summary below.');
    expect(zh.translation.common.graph_edge_a11y).toBe('图谱连线。关系详情可在下方文本摘要中查看。');
    expect(en.translation.common.graph_handle).toBe('Graph handle');
    expect(zh.translation.common.graph_handle).toBe('图谱连接点');
    expect(en.translation.argument.filter_status_group).toBe('Filter argument units by status');
    expect(zh.translation.argument.filter_status_group).toBe('按状态筛选论证单元');

    expect(en.translation.counterfactual.title).toBe('What-If Replay');
    expect(zh.translation.counterfactual.title).toBe('假设重演');
    expect(en.translation.counterfactual.submit).toBe('Create What-If');
    expect(zh.translation.counterfactual.submit).toBe('创建假设分支');
  });

  it('provides localized faction timeline labels on the ResultView branch analysis section', () => {
    expect(en.translation.result.faction_timeline_branch_analysis_label).toBe('Branch analysis');
    expect(zh.translation.result.faction_timeline_branch_analysis_label).toBe('分支分析');
    expect(en.translation.result.faction_timeline_title).toBe('Faction timeline analysis');
    expect(zh.translation.result.faction_timeline_title).toBe('阵营轨迹时间线');
    expect(en.translation.result.faction_timeline_lead_expanded).toContain('{{title}}');
    expect(zh.translation.result.faction_timeline_lead_expanded).toContain('{{title}}');
    expect(en.translation.result.faction_timeline_lead_expanded).toContain('expanded ending branch');
    expect(zh.translation.result.faction_timeline_lead_expanded).toContain('当前跟随你展开查看的结局分支');
    expect(en.translation.result.faction_timeline_lead_dominant).toContain('highest-probability branch');
    expect(zh.translation.result.faction_timeline_lead_dominant).toContain('概率最高的分支');
    expect(en.translation.result.faction_timeline_lead_single).toContain('faction evolution for branch');
    expect(zh.translation.result.faction_timeline_lead_single).toContain('阵营演化');
    for (const key of [
      'faction_timeline_lead_expanded',
      'faction_timeline_lead_dominant',
      'faction_timeline_lead_single',
    ] as const) {
      expect(en.translation.result[key]).toContain('{{title}}');
      expect(zh.translation.result[key]).toContain('{{title}}');
    }
  });

  it('provides localized timeline and replay import labels used by result surfaces', () => {
    expect(en.translation.factions.current_branch).toBe('Current branch');
    expect(zh.translation.factions.current_branch).toBe('当前分支');
    expect(en.translation.factions.branch_scope).toBe('Branch scope');
    expect(zh.translation.factions.branch_scope).toBe('分支范围');
    expect(en.translation.factions.error_fetch).toBe('Unable to load the faction timeline right now. Please retry.');
    expect(zh.translation.factions.error_fetch).toBe('阵营时间线暂时无法加载，请稍后重试。');
    expect(en.translation.debate.import_local_run).toBe('Import as Local Run');
    expect(zh.translation.debate.import_local_run).toBe('导入为本地运行');
    expect(en.translation.debate.importing_local_run).toBe('Importing...');
    expect(zh.translation.debate.importing_local_run).toBe('导入中...');
  });

  it('provides localized replay, source tooltip, and knowledge-graph error labels', () => {
    expect(en.translation.input_source.disabled_tooltip).toBe('This data source is not enabled on the server.');
    expect(zh.translation.input_source.disabled_tooltip).toBe('此数据源未在服务器上启用。');
    expect(en.translation.replay.feature_disabled_title).toBe('Replay trace is unavailable');
    expect(zh.translation.replay.feature_disabled_title).toBe('回放轨迹不可用');
    expect(en.translation.replay.feature_unavailable_title).toBe('Replay availability could not be checked');
    expect(zh.translation.replay.feature_unavailable_title).toBe('暂时无法确认回放能力');
    expect(en.translation.replay.trace.frame_count_label).toBe('Frame');
    expect(zh.translation.replay.trace.frame_count_label).toBe('帧');
    expect(en.translation.replay.trace.branches_label).toBe('Branches');
    expect(zh.translation.replay.trace.branches_label).toBe('分支');
    expect(en.translation.replay.trace.frame_count_label).not.toContain('{{count}}');
    expect(en.translation.replay.trace.branches_label).not.toContain('{{count}}');
    expect(zh.translation.replay.trace.frame_count_label).not.toContain('{{count}}');
    expect(zh.translation.replay.trace.branches_label).not.toContain('{{count}}');
    expect(en.translation.kg_explorer.error_fetch).toBe('Unable to load the knowledge graph right now. Please retry.');
    expect(zh.translation.kg_explorer.error_fetch).toBe('当前无法加载知识图谱，请稍后重试。');
  });

  it('keeps en.json and zh.json key sets in perfect parity', () => {
    function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
      const keys: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v !== null) {
          keys.push(...flatKeys(v as Record<string, unknown>, path));
        } else {
          keys.push(path);
        }
      }
      return keys;
    }
    const enKeys = new Set(flatKeys(en));
    const zhKeys = new Set(flatKeys(zh));
    const onlyEn = [...enKeys].filter(k => !zhKeys.has(k));
    const onlyZh = [...zhKeys].filter(k => !enKeys.has(k));
    expect(onlyEn).toEqual([]);
    expect(onlyZh).toEqual([]);
  });

  it('provides KGGraphBoard locale keys for workbench knowledge-graph panel', () => {
    expect(en.translation.kg_graph_board.search_placeholder).toBe('Search by agent name or content...');
    expect(zh.translation.kg_graph_board.search_placeholder).toBe('搜索 Agent 名称或内容...');
    expect(en.translation.kg_graph_board.search_aria).toBe('Search knowledge graph nodes');
    expect(zh.translation.kg_graph_board.search_aria).toBe('搜索知识图谱节点');
    expect(en.translation.kg_graph_board.filter_aria).toBe('Show only selected types');
    expect(zh.translation.kg_graph_board.filter_aria).toBe('只显示选中的类型');
    expect(en.translation.kg_graph_board.zoom_in).toBe('Zoom in');
    expect(zh.translation.kg_graph_board.zoom_in).toBe('放大');
    expect(en.translation.kg_graph_board.zoom_out).toBe('Zoom out');
    expect(zh.translation.kg_graph_board.zoom_out).toBe('缩小');
    expect(en.translation.kg_graph_board.fit_view).toBe('Fit to view');
    expect(zh.translation.kg_graph_board.fit_view).toBe('适配视图');
    expect(en.translation.kg_graph_board.minimap_aria).toBe('Mini map');
    expect(zh.translation.kg_graph_board.minimap_aria).toBe('缩略图');
    expect(en.translation.kg_graph_board.sr_table_aria).toBe('Screen-reader fallback table of graph nodes');
    expect(zh.translation.kg_graph_board.sr_table_aria).toBe('图谱节点的无障碍表格');
    expect(en.translation.kg_graph_board.sr_caption).toBe('Graph nodes (screen-reader fallback)');
    expect(zh.translation.kg_graph_board.sr_caption).toBe('图谱节点（无障碍表格）');
  });

  it('provides NodeDetailPanel evidence locale keys for graph node detail panel', () => {
    expect(en.translation.node_detail.evidence).toBe('Evidence');
    expect(zh.translation.node_detail.evidence).toBe('证据');
    expect(en.translation.node_detail.evidence_confidence).toBe('Confidence');
    expect(zh.translation.node_detail.evidence_confidence).toBe('置信度');
    expect(en.translation.node_detail.evidence_detail).toBe('Detail');
    expect(zh.translation.node_detail.evidence_detail).toBe('详情');
    expect(en.translation.node_detail.evidence_source_ref).toBe('Source');
    expect(zh.translation.node_detail.evidence_source_ref).toBe('来源');
    expect(en.translation.node_detail.evidence_source_round).toBe('Round');
    expect(zh.translation.node_detail.evidence_source_round).toBe('回合');
  });

  it('provides shared retry, clear, submitting, and causal round labels used by graph views', () => {
    expect(en.translation.common.retry).toBe('Retry');
    expect(zh.translation.common.retry).toBe('重试');
    expect(en.translation.common.clear).toBe('Clear');
    expect(zh.translation.common.clear).toBe('清除');
    expect(en.translation.common.graph_controls).toBe('Graph controls');
    expect(zh.translation.common.graph_controls).toBe('图谱控件');
    expect(en.translation.common.graph_zoom_in).toBe('Zoom in');
    expect(zh.translation.common.graph_zoom_in).toBe('放大');
    expect(en.translation.common.graph_zoom_out).toBe('Zoom out');
    expect(zh.translation.common.graph_zoom_out).toBe('缩小');
    expect(en.translation.common.graph_fit_view).toBe('Fit view');
    expect(zh.translation.common.graph_fit_view).toBe('适配视图');
    expect(en.translation.common.graph_toggle_interactivity).toBe('Toggle interactivity');
    expect(zh.translation.common.graph_toggle_interactivity).toBe('切换交互状态');
    expect(en.translation.common.graph_minimap).toBe('Mini map');
    expect(zh.translation.common.graph_minimap).toBe('缩略图');
    expect(en.translation.common.submitting).toBe('Submitting...');
    expect(zh.translation.common.submitting).toBe('提交中...');
    expect(en.translation.causal.type_round).toBe('Round');
    expect(zh.translation.causal.type_round).toBe('回合');
    expect(en.translation.causal.type_outcome).toBe('Outcome');
    expect(zh.translation.causal.type_outcome).toBe('结局');
    expect(en.translation.causal.relationless_snapshot).toBe('No causal edges were generated for this scenario yet. Showing event snapshots instead.');
    expect(zh.translation.causal.relationless_snapshot).toBe('当前场景还没有生成因果连线，先显示事件快照。');
    expect(en.translation.causal.error.network).toBe('Unable to load the causal graph. Check your connection and try again.');
    expect(zh.translation.causal.error.network).toBe('因果图谱加载失败，请检查网络后重试。');
    expect(en.translation.causal.error.branch_not_found).toBe('The selected branch is no longer available for this scenario.');
    expect(zh.translation.causal.error.branch_not_found).toBe('所选分支已不在当前场景中。');
    expect(en.translation.causal.error.unauthorized).toBe('You do not have permission to view this causal graph.');
    expect(zh.translation.causal.error.unauthorized).toBe('你没有权限查看此因果图谱。');
    expect(en.translation.causal.error.server).toBe('The server could not load the causal graph right now.');
    expect(zh.translation.causal.error.server).toBe('服务器暂时无法加载因果图谱。');
    expect(en.translation.causal.error.load_failed).toBe('Unable to load the causal graph right now. Please retry.');
    expect(zh.translation.causal.error.load_failed).toBe('因果图谱暂时无法加载，请稍后重试。');
  });
});
