import { describe, expect, it } from 'vitest';

import { EDGE_STYLES, TYPE_LABEL_I18N } from './graphTokens';
import en from '../i18n/locales/en.json';
import zh from '../i18n/locales/zh.json';

it('maps counterfactual to a string leaf in both supported locales', () => {
  expect(TYPE_LABEL_I18N.counterfactual).toEqual(['causal.type_counterfactual', 'Counterfactual']);
  for (const locale of [en, zh]) {
    const value = TYPE_LABEL_I18N.counterfactual[0].split('.').reduce<unknown>((current, key) => (
      current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
    ), locale.translation);
    expect(typeof value).toBe('string');
  }
});

describe('EDGE_STYLES inter-agent causal edges', () => {
  it('defines style tokens for new causal relation types', () => {
    expect(EDGE_STYLES.responds_to).toEqual({
      stroke: '#3498db',
      animated: false,
    });
    expect(EDGE_STYLES.supports_stance).toEqual({
      stroke: '#27ae60',
      animated: false,
    });
    expect(EDGE_STYLES.opposes_stance).toEqual({
      stroke: '#e74c3c',
      strokeDasharray: '6 3',
      animated: false,
    });
  });
});
