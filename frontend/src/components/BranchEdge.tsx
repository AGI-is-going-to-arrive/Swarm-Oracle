/* ═══════════════════════════════════════════════════════════
   SwarmOracle — BranchEdge (Custom React Flow Edge with GSAP)
   ═══════════════════════════════════════════════════════════ */

import { memo, useEffect, useRef } from 'react';
import { getBezierPath, type EdgeProps } from '@xyflow/react';
import { animateEdgeGrowth, animateGlowParticle } from '../animations/branchAnimations';

function BranchEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const pathRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const animInitRef = useRef(false);

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const isPruned = data?.status === 'PRUNED';

  useEffect(() => {
    // Reset animation state when edge path changes (branch added/removed)
    animInitRef.current = false;
  }, [edgePath]);

  useEffect(() => {
    if (!pathRef.current || animInitRef.current) return;
    animInitRef.current = true;

    // Animate edge growth
    animateEdgeGrowth(pathRef.current, 1.5);

    // Animate glow particle
    if (glowRef.current && !isPruned) {
      setTimeout(() => {
        if (pathRef.current && glowRef.current) {
          animateGlowParticle(glowRef.current, pathRef.current, 3);
        }
      }, 1500); // Start after growth completes
    }
  }, [edgePath, isPruned]);

  return (
    <g className="branch-edge">
      {/* SVG Filters */}
      <defs>
        <filter id={`glow-${id}`}>
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id={`gradient-${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#888" stopOpacity="0.3" />
          <stop offset="50%" stopColor="#555" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#999" stopOpacity="0.6" />
        </linearGradient>
      </defs>

      {/* Background glow path */}
      <path
        d={edgePath}
        stroke={isPruned ? '#333' : `url(#gradient-${id})`}
        strokeWidth={isPruned ? 1 : 3}
        fill="none"
        filter={isPruned ? undefined : `url(#glow-${id})`}
        opacity={isPruned ? 0.3 : 0.4}
      />

      {/* Main animated path — starts visible as fallback */}
      <path
        ref={pathRef}
        d={edgePath}
        stroke={isPruned ? '#555' : '#666'}
        strokeWidth={isPruned ? 1 : 2}
        fill="none"
        opacity={1}
        filter={isPruned ? undefined : `url(#glow-${id})`}
      />

      {/* Flowing glow particle */}
      {!isPruned && (
        <circle
          ref={glowRef}
          r={4}
          fill="#888"
          filter={`url(#glow-${id})`}
          opacity={0.9}
          cx={sourceX}
          cy={sourceY}
        />
      )}
    </g>
  );
}

export const BranchEdge = memo(BranchEdgeComponent);
