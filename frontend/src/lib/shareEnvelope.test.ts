import { describe, expect, it } from 'vitest';

import { buildExportArchivePreface, buildShareCopyEnvelope } from './shareEnvelope';

describe('shareEnvelope helpers', () => {
  const context = {
    profileLabel: '贸易绞盘',
    profileHooks: ['关税杠杆', '港口封锁'],
    resonanceLabel: '命中题材核心',
    directorStyleLabel: '押注观察者',
    dominantBranchTitle: '海峡垄断',
    counterplaySummary: '2 张反制卡 · 最近一张 审计清算',
    commitmentSummary: '承诺命中 · 海峡垄断',
  };

  it('prepends share copy with theme context', () => {
    const result = buildShareCopyEnvelope('原始分享文案', context, true);
    expect(result).toContain('【贸易绞盘｜命中题材核心】');
    expect(result).toContain('题材钩子：关税杠杆 · 港口封锁');
    expect(result).toContain('反制轨迹：2 张反制卡 · 最近一张 审计清算');
    expect(result).toContain('世界线承诺：承诺命中 · 海峡垄断');
    expect(result).toContain('原始分享文案');
  });

  it('prepends markdown export with theme archive section', () => {
    const result = buildExportArchivePreface('# 原始导出', context, true);
    expect(result).toContain('## 题材档案');
    expect(result).toContain('- 【贸易绞盘｜命中题材核心】');
    expect(result).toContain('- 反制轨迹：2 张反制卡 · 最近一张 审计清算');
    expect(result).toContain('- 世界线承诺：承诺命中 · 海峡垄断');
    expect(result).toContain('# 原始导出');
  });
});
