import { describe, expect, it } from 'vitest';
import { getAgentEmotionLabel, getAgentStanceLabel } from './agentValueLabels';

describe('agent value labels', () => {
  it('translates saved canonical Chinese stances for an English interface', () => {
    expect(getAgentStanceLabel('支持', 'en-US')).toBe('Supportive');
    expect(getAgentStanceLabel('反对', 'en')).toBe('Opposed');
    expect(getAgentStanceLabel('中立', 'en')).toBe('Neutral');
  });

  it('recognizes known English labels without requiring exact casing', () => {
    expect(getAgentStanceLabel(' Supportive ', 'zh-CN')).toBe('支持');
    expect(getAgentStanceLabel('OPPOSED', 'zh')).toBe('反对');
    expect(getAgentEmotionLabel('NEUTRAL', 'zh-Hans')).toBe('中性');
    expect(getAgentEmotionLabel('calm', 'en')).toBe('Calm');
  });

  it.each(['支持先小范围试用', 'neutral about cost but worried about access', 'constructor', '  my own label  ', ''])(
    'preserves an authored or unknown value verbatim: %j', (value) => {
    for (const language of ['en', 'zh']) {
      expect(getAgentStanceLabel(value, language)).toBe(value);
      expect(getAgentEmotionLabel(value, language)).toBe(value);
    }
    },
  );
});
