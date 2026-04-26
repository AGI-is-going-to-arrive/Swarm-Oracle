/* ═══════════════════════════════════════════════════════════
   P6 Phase 2 — Animated Edge
   Custom React Flow edge with SVG animateMotion circle.
   Animation only plays when edge is selected (path-highlight)
   and prefers-reduced-motion is not active.
   ═══════════════════════════════════════════════════════════ */

import { memo } from 'react';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import useReducedMotion from '../hooks/useReducedMotion';
import EdgeLabelTooltip from './EdgeLabelTooltip';

function AnimatedEdgeComponent({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, style, selected, markerEnd, data,
}: EdgeProps) {
  const reducedMotion = useReducedMotion();
  const [edgePath] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  });

  const showAnimation = selected && !reducedMotion;
  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {showAnimation && (
        <circle r="3" fill="currentColor" opacity="0.7" aria-hidden="true" data-testid="animated-edge-circle">
          <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
      {data?.label && (
        <EdgeLabelTooltip
          labelX={labelX}
          labelY={labelY}
          label={String(data.label)}
          detail={data.detail ? String(data.detail) : undefined}
          edgeId={id}
          visible={true}
        />
      )}
    </>
  );
}

const AnimatedEdge = memo(AnimatedEdgeComponent);
export default AnimatedEdge;
