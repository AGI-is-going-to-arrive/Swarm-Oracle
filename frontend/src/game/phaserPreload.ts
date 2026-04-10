interface NavigatorConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

interface NavigatorLike {
  userAgent?: string;
  connection?: NavigatorConnectionLike;
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

interface PhaserPreloadEnvironmentLike {
  visibilityState?: DocumentVisibilityState | 'hidden' | 'visible' | 'prerender';
  prefersReducedData?: boolean;
}

function loadPhaserGameModule() {
  return import('./PhaserGame').then((mod) => ({ default: mod.PhaserGame }));
}

export function shouldPreloadPhaserGame(
  targetNavigator: NavigatorLike | undefined,
  environment: PhaserPreloadEnvironmentLike = {},
): boolean {
  if (!targetNavigator) return false;
  if (/\bjsdom\b/i.test(targetNavigator.userAgent ?? '')) {
    return false;
  }
  if (environment.visibilityState && environment.visibilityState !== 'visible') {
    return false;
  }
  if (environment.prefersReducedData) {
    return false;
  }

  const connection = targetNavigator.connection;
  if (connection?.saveData) {
    return false;
  }

  const effectiveType = connection?.effectiveType?.toLowerCase();
  if (effectiveType === 'slow-2g' || effectiveType === '2g') {
    return false;
  }

  if (
    typeof targetNavigator.deviceMemory === 'number'
    && targetNavigator.deviceMemory > 0
    && targetNavigator.deviceMemory <= 2
  ) {
    return false;
  }

  if (
    typeof targetNavigator.hardwareConcurrency === 'number'
    && targetNavigator.hardwareConcurrency > 0
    && targetNavigator.hardwareConcurrency <= 2
  ) {
    return false;
  }

  return true;
}

export function preloadPhaserGame() {
  const prefersReducedData = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-data: reduce)').matches;
  const visibilityState = typeof document !== 'undefined'
    ? document.visibilityState
    : undefined;

  if (!shouldPreloadPhaserGame(
    typeof navigator === 'undefined' ? undefined : navigator,
    { visibilityState, prefersReducedData },
  )) {
    return;
  }

  void loadPhaserGameModule();
}

export { loadPhaserGameModule };
