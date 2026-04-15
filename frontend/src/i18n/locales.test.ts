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
    expect(en.translation.roundtable.phase_insights_label).toBe('Phase insights');
    expect(zh.translation.roundtable.phase_insights_label).toBe('阶段洞察');
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
    expect(en.translation.compare.round).toBe('Round {{round}}');
    expect(zh.translation.compare.round).toBe('第 {{round}} 轮');
  });

  it('provides localized labels for ResultView Phase C action links', () => {
    expect(en.translation.result.causal_graph_link).toBeTruthy();
    expect(zh.translation.result.causal_graph_link).toBeTruthy();
    expect(en.translation.result.compare_link).toBeTruthy();
    expect(zh.translation.result.compare_link).toBeTruthy();
  });

  it('provides localized graph node detail labels and counterfactual labels', () => {
    expect(en.translation.node_detail.agent).toBe('Agent');
    expect(zh.translation.node_detail.agent).toBe('Agent');
    expect(en.translation.causal.search_agent).toBe('Search Agent...');
    expect(zh.translation.causal.search_agent).toBe('搜索 Agent...');
    expect(en.translation.node_detail.emotion).toBe('Emotion');
    expect(zh.translation.node_detail.emotion).toBe('情绪');
    expect(en.translation.node_detail.stance).toBe('Stance');
    expect(zh.translation.node_detail.stance).toBe('立场');
    expect(en.translation.node_detail.side).toBe('Side');
    expect(zh.translation.node_detail.side).toBe('立场方');
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

    expect(en.translation.counterfactual.title).toBe('What-If Replay');
    expect(zh.translation.counterfactual.title).toBe('假设重演');
    expect(en.translation.counterfactual.submit).toBe('Create What-If');
    expect(zh.translation.counterfactual.submit).toBe('创建假设分支');
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
