// localStorage that never throws (private windows, blocked storage).

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`kod.${key}`);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadRaw<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`kod.${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`kod.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
