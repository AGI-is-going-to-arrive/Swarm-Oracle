import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mockEdgePath = 'M0,0 L100,100';
let mockLabelX = 50;
let mockLabelY = 50;
vi.mock('@xyflow/react', async () => {
  return {
    BaseEdge: ({ id, path, style, markerEnd }: { id: string; path: string; style?: React.CSSProperties; markerEnd?: string }) => (
      <path data-testid="base-edge" data-id={id} d={path} style={style} markerEnd={markerEnd} />
    ),
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <g data-testid="edge-label-renderer">{children}</g>,
    getSmoothStepPath: () => [mockEdgePath, mockLabelX, mockLabelY, 0, 0],
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  };
});

import AnimatedEdge from './AnimatedEdge';
import { Position } from '@xyflow/react';

afterEach(() => {
  cleanup();
  mockEdgePath = 'M0,0 L100,100';
  mockLabelX = 50;
  mockLabelY = 50;
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

  it('shows animateMotion circle when selected', () => {
    const { getByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} selected={true} />
      </svg>,
    );
    const circle = getByTestId('animated-edge-circle');
    expect(circle).toBeInTheDocument();
    // CSS class drives reduced-motion suppression (see index.css).
    expect(circle.getAttribute('class')).toBe('edge-flow-dot');
  });

  it('hides animateMotion when not selected', () => {
    const { queryByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} selected={false} />
      </svg>,
    );
    expect(queryByTestId('animated-edge-circle')).not.toBeInTheDocument();
  });

  it('keeps the edge-flow-dot class so CSS can suppress motion when reduced', () => {
    // Reduced-motion suppression is now centralized in CSS via
    // `@media (prefers-reduced-motion: reduce) { .edge-flow-dot { display: none; } }`.
    // The component itself no longer subscribes to the media query per edge;
    // we just assert the class hook is present so CSS can do its job.
    const { getByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} selected={true} />
      </svg>,
    );
    expect(getByTestId('animated-edge-circle').getAttribute('class')).toBe('edge-flow-dot');
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

  it('uses smooth-step label coordinates with parallel offset', () => {
    mockLabelX = 64;
    mockLabelY = 72;
    const { getByTestId } = render(
      <svg>
        <AnimatedEdge {...baseProps} data={{ label: 'supports', parallelOffset: 12, priority: 'high' }} />
      </svg>,
    );
    const anchor = getByTestId('edge-label-pill').parentElement!;
    expect(anchor.style.transform).toContain('translate(64px,84px)');
    expect(anchor).toHaveAttribute('data-priority', 'high');
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
