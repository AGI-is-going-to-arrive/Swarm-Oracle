const STORAGE_KEY = 'swarmoracle:director-identity:v1';

export interface DirectorIdentity {
  userId: string;
  userName: string;
}

const DEFAULT_NAME = 'Local Director';

function readStoredIdentity(): DirectorIdentity | null {
  try {
    if (typeof window.localStorage?.getItem !== 'function') return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DirectorIdentity>;
    if (!parsed.userId) return null;
    return {
      userId: parsed.userId,
      userName: parsed.userName?.trim() || DEFAULT_NAME,
    };
  } catch {
    return null;
  }
}

function writeStoredIdentity(identity: DirectorIdentity) {
  if (typeof window.localStorage?.setItem !== 'function') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch (error) {
    console.warn('[directorIdentity] Failed to persist identity', error);
  }
}

export function getDirectorIdentity(): DirectorIdentity {
  const existing = readStoredIdentity();
  if (existing) return existing;

  const identity = {
    userId: `director-${crypto.randomUUID()}`,
    userName: DEFAULT_NAME,
  };
  writeStoredIdentity(identity);
  return identity;
}

export function updateDirectorName(userName: string) {
  const identity = getDirectorIdentity();
  const next = {
    ...identity,
    userName: userName.trim() || identity.userName,
  };
  writeStoredIdentity(next);
  return next;
}
