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
});
