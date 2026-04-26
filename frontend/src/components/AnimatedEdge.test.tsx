import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mockReducedMotion = false;
vi.mock('../hooks/useReducedMotion', () => ({
  default: () => mockReducedMotion,
}));

let mockEdgePath = 'M0,0 L100,100';
vi.mock('@xyflow/react', async () => {
  return {
    BaseEdge: ({ id, path, style, markerEnd }: { id: string; path: string; style?: React.CSSProperties; markerEnd?: string }) => (
      <path data-testid="base-edge" data-id={id} d={path} style={style} markerEnd={markerEnd} />
    ),
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <g data-testid="edge-label-renderer">{children}</g>,
    getSmoothStepPath: () => [mockEdgePath],
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  };
});

import AnimatedEdge from './AnimatedEdge';
import { Position } from '@xyflow/react';

afterEach(() => {
  cleanup();
  mockReducedMotion = false;
  mockEdgePath = 'M0,0 L100,100';
});

const baseProps = {
  id: 'e1',
  source: 'n1',
  target: 'n2',
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 100,
  sourcePosition: Position.Bottom,
  targetPosition: Position.Top,
  style: { stroke: '#888' },
  selected: false,
  markerEnd: undefined,
  sourceHandleId: null,
  targetHandleId: null,
  data: {},
  interactionWidth: 20,
};

describe('AnimatedEdge', () => {
  it('renders BaseEdge with correct path', () => {
    const { getByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} />
      </svg>,
    );
    const edge = getByTestId('base-edge');
    expect(edge).toBeInTheDocument();
    expect(edge.getAttribute('d')).toBe('M0,0 L100,100');
  });

  it('shows animateMotion circle when selected and motion enabled', () => {
    mockReducedMotion = false;
    const { getByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} selected={true} />
      </svg>,
    );
    expect(getByTestId('animated-edge-circle')).toBeInTheDocument();
  });

  it('hides animateMotion when not selected', () => {
    mockReducedMotion = false;
    const { queryByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} selected={false} />
      </svg>,
    );
    expect(queryByTestId('animated-edge-circle')).not.toBeInTheDocument();
  });

  it('hides animateMotion when reduced motion is active', () => {
    mockReducedMotion = true;
    const { queryByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} selected={true} />
      </svg>,
    );
    expect(queryByTestId('animated-edge-circle')).not.toBeInTheDocument();
  });

  it('matches snapshot for default state', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...baseProps} />
      </svg>,
    );
    expect(container.querySelector('path[data-testid="base-edge"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="animated-edge-circle"]')).toBeNull();
  });

  it('renders EdgeLabelTooltip when data.label is provided', () => {
    const { getByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} data={{ label: 'supports', detail: 'some detail' }} />
      </svg>,
    );
    expect(getByTestId('edge-label-pill')).toBeInTheDocument();
    expect(getByTestId('edge-label-pill').textContent).toBe('supports');
  });

  it('does not render EdgeLabelTooltip when data.label is absent', () => {
    const { queryByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} data={{}} />
      </svg>,
    );
    expect(queryByTestId('edge-label-pill')).not.toBeInTheDocument();
  });
});
