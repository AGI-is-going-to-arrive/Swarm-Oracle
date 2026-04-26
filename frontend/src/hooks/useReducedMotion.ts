import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

export default function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(getSnapshot);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mq = window.matchMedia(QUERY);

    const handler = (event: MediaQueryListEvent | MediaQueryList) => {
      setReduced(event.matches);
    };

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }

    // Legacy WebKit fallback.
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  return reduced;
}
