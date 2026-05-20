/* ═══════════════════════════════════════════════════════════
   P6 Phase 2 — Animated Edge
   Custom React Flow edge with SVG animateMotion circle.
   Animation only plays when edge is selected (path-highlight).
   prefers-reduced-motion suppression is handled in CSS
   (`.edge-flow-dot` rule in index.css) so we don't subscribe
   to the media query per-edge.
   ═══════════════════════════════════════════════════════════ */

import { memo } from 'react';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import EdgeLabelTooltip from './EdgeLabelTooltip';

function AnimatedEdgeComponent({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, style, selected, markerEnd, data,
}: EdgeProps) {
  const [edgePath, pathLabelX, pathLabelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  });

  const parallelOffset = typeof data?.parallelOffset === 'number' ? data.parallelOffset : 0;
  const finalLabelX = pathLabelX;
  const finalLabelY = pathLabelY + parallelOffset;
  const priority = data?.priority === 'high' ? 'high' : undefined;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {selected && (
        <circle
          className="edge-flow-dot"
          r="3"
          fill="currentColor"
          opacity="0.7"
          aria-hidden="true"
          data-testid="animated-edge-circle"
        >
          <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelTooltip
          labelX={finalLabelX}
          labelY={finalLabelY}
          label={String(data.label)}
          detail={data.detail ? String(data.detail) : undefined}
          tierColor={data.tierColor ? String(data.tierColor) : undefined}
          priority={priority}
          edgeId={id}
          visible={true}
        />
      )}
    </>
  );
}

const AnimatedEdge = memo(AnimatedEdgeComponent);
export default AnimatedEdge;
