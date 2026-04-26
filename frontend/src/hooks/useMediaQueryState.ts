import { useEffect, useState } from 'react';

export default function useMediaQueryState(query: string): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent | MediaQueryList) => {
      setMatches(event.matches);
    };

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler as EventListener);
      return () => mql.removeEventListener('change', handler as EventListener);
    }

    mql.addListener?.(handler as (event: MediaQueryListEvent) => void);
    return () => mql.removeListener?.(handler as (event: MediaQueryListEvent) => void);
  }, [query]);

  return matches;
}
