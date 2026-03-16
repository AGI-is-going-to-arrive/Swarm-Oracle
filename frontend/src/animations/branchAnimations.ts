/* ═══════════════════════════════════════════════════════════
   SwarmOracle — GSAP Branch Animations
   ═══════════════════════════════════════════════════════════ */

import gsap from 'gsap';

/**
 * Animate an SVG edge "growing" from source to target.
 * Uses strokeDashoffset reveal.
 */
export function animateEdgeGrowth(pathEl: SVGPathElement, duration = 1.5) {
  const length = pathEl.getTotalLength();
  // Guard: for very short or zero-length paths (e.g. straight vertical lines),
  // skip the dasharray animation — the path is already visible via opacity:1.
  if (length < 1) return;

  // Kill any stale GSAP animations on this element (prevents race conditions
  // when React Flow rapidly re-renders edges during layout changes).
  gsap.killTweensOf(pathEl);

  gsap.set(pathEl, {
    strokeDasharray: length,
    strokeDashoffset: length,
    opacity: 1,
  });
  gsap.to(pathEl, {
    strokeDashoffset: 0,
    duration,
    ease: 'power2.out',
    onComplete: () => {
      // Clear dasharray after animation so path stays visible
      // even if React Flow changes the `d` attribute later.
      gsap.set(pathEl, { strokeDasharray: 'none', strokeDashoffset: 0 });
    },
  });
}

/**
 * Animate a glow particle flowing along a path.
 * Requires gsap MotionPathPlugin (self-contained fallback).
 */
export function animateGlowParticle(
  circleEl: SVGCircleElement,
  pathEl: SVGPathElement,
  duration = 3,
) {
  const length = pathEl.getTotalLength();

  // Manual motion path using getTotalLength
  gsap.to({ progress: 0 }, {
    progress: 1,
    duration,
    repeat: -1,
    ease: 'none',
    onUpdate: function () {
      const progress = this.targets()[0].progress;
      const point = pathEl.getPointAtLength(progress * length);
      gsap.set(circleEl, { attr: { cx: point.x, cy: point.y } });
    },
  });
}

/**
 * Animate a React Flow node appearing (scale + fade in).
 */
export function animateNodeAppear(nodeEl: HTMLElement, delay = 0) {
  gsap.fromTo(
    nodeEl,
    { scale: 0.3, opacity: 0, transformOrigin: 'center center' },
    {
      scale: 1,
      opacity: 1,
      duration: 0.6,
      delay,
      ease: 'back.out(1.5)',
    },
  );
}

/**
 * Fork burst — create expanding rings at a point.
 * Returns cleanup function.
 */
export function animateForkBurst(container: SVGSVGElement, cx: number, cy: number) {
  const rings = 3;
  const elements: SVGCircleElement[] = [];

  for (let i = 0; i < rings; i++) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '4');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', '#888');
    circle.setAttribute('stroke-width', '2');
    circle.setAttribute('opacity', '0.8');
    container.appendChild(circle);
    elements.push(circle);

    gsap.to(circle, {
      attr: { r: 40 + i * 20 },
      opacity: 0,
      duration: 0.8 + i * 0.15,
      delay: i * 0.1,
      ease: 'power2.out',
      onComplete: () => circle.remove(),
    });
  }

  // Particle dots
  for (let i = 0; i < 8; i++) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const angle = (i / 8) * Math.PI * 2;
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '2');
    dot.setAttribute('fill', '#666');
    container.appendChild(dot);
    elements.push(dot);

    gsap.to(dot, {
      attr: {
        cx: cx + Math.cos(angle) * 60,
        cy: cy + Math.sin(angle) * 60,
      },
      opacity: 0,
      duration: 0.7,
      ease: 'power2.out',
      onComplete: () => dot.remove(),
    });
  }
}

/**
 * Animate pruning — gray out + shrink + fade.
 */
export function animatePrune(nodeEl: HTMLElement) {
  gsap.to(nodeEl, {
    scale: 0.8,
    opacity: 0.3,
    filter: 'grayscale(1)',
    duration: 0.8,
    ease: 'power2.inOut',
  });
}
