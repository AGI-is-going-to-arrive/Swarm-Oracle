import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export default function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mq = window.matchMedia(QUERY);
    setReduced(mq.matches);

    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }

    // Legacy WebKit fallback
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  return reduced;
}
