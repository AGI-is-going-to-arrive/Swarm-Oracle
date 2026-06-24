export const THEATER_SCENE_LABELS = {
  BootScene: 'sim.theater_scene.boot',
  TitleScene: 'sim.theater_scene.title',
  WorldScene: 'sim.theater_scene.world',
  EndingScene: 'sim.theater_scene.ending',
} as const;

export const THEATER_WEATHER_LABELS: Record<string, string> = {
  clear: 'sim.theater_weather.clear',
  rain: 'sim.theater_weather.rain',
  snow: 'sim.theater_weather.snow',
  storm: 'sim.theater_weather.storm',
  sandstorm: 'sim.theater_weather.sandstorm',
};

export const THEATER_TIME_LABELS: Record<string, string> = {
  dawn: 'sim.theater_time.dawn',
  noon: 'sim.theater_time.noon',
  dusk: 'sim.theater_time.dusk',
  night: 'sim.theater_time.night',
};

export const WARMUP_RECOVERY_INTERVAL_MS = 800;
export const WARMUP_RECOVERY_MAX_ATTEMPTS = 10;
export const TAIL_STATUS_SYNC_INTERVAL_MS = 600;

// ── Staleness watchdog ──
// A live run reports progress by advancing `currentRound`. When the round index
// stops advancing for a long time the backend task has likely died (orphaned by a
// process restart), leaving the scenario stuck in SIMULATING with no terminal event.
// A run that is merely slow but still advancing must NEVER trip this — the timer
// resets every time `currentRound` grows. (The gentle "running for a while" warmup
// hint is handled separately by the shared progress banner in TimelineBar.)
export const STUCK_HARD_CAP_MS = 300_000; // 5min: treat the run as interrupted
// While stuck, re-poll the scenario snapshot so a backend that has since marked the
// run as ERROR is reflected in the UI without requiring a manual refresh.
export const STUCK_STATUS_REPOLL_INTERVAL_MS = 5_000;

export function formatTheaterLabel(
  key: string | null | undefined,
  labels: Record<string, string>,
  t: (key: string) => string,
): string | null {
  if (!key) return null;
  const match = labels[key];
  if (match) {
    const translated = t(match);
    return translated === match ? key.replace(/_/g, ' ') : translated;
  }
  return key.replace(/_/g, ' ');
}

export function shouldWarmTheaterLoaderOnIntent() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    return false;
  }

  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-reduced-data: reduce)').matches) {
      return false;
    }

    if (!window.matchMedia('(pointer: fine)').matches) {
      return false;
    }
  }

  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  }).connection;

  if (connection?.saveData) {
    return false;
  }

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory === 'number' && deviceMemory > 0 && deviceMemory <= 2) {
    return false;
  }

  return true;
}
