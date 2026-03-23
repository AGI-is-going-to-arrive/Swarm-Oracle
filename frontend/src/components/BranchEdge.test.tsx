import { render } from '@testing-library/react';
import { Position } from '@xyflow/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { BranchEdge } from './BranchEdge';

describe('BranchEdge', () => {
  beforeEach(() => {
    Object.defineProperty(window.SVGElement.prototype, 'getTotalLength', {
      configurable: true,
      value: () => 240,
    });
  });

  it('renders a stable base path underneath the animated overlay', () => {
    const { container } = render(
      <svg>
        <BranchEdge
          id="edge-1"
          source="root"
          target="child"
          sourceX={100}
          sourceY={50}
          targetX={100}
          targetY={180}
          sourcePosition={Position.Bottom}
          targetPosition={Position.Top}
          data={{ status: 'ACTIVE' }}
          selected={false}
        />
      </svg>,
    );

    expect(container.querySelector('path[data-edge-layer="base"]')).not.toBeNull();
    expect(container.querySelector('path[data-edge-layer="main"]')).not.toBeNull();
    expect(container.querySelector('circle[data-edge-layer="particle"]')).not.toBeNull();
  });
});
