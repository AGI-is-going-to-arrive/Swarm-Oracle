import { describe, expect, it } from 'vitest';

import { EDGE_STYLES } from './graphTokens';

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
