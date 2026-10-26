import { platform, type EngineInfo } from '../platform';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let current: Promise<EngineInfo> | null = null;

export function engineInfo(): Promise<EngineInfo> {
  current ??= platform.getEngine();
  return current;
}

/** After the desktop shell restarted a crashed engine. */
export function setEngineInfo(info: EngineInfo): void {
  current = Promise.resolve(info);
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const info = await engineInfo();
  const res = await fetch(`${info.baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${info.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const q = (params: Record<string, string | boolean | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export const api = {
  get: <T>(path: string, params?: Record<string, string | boolean | undefined>, signal?: AbortSignal) =>
    request<T>('GET', params ? `${path}?${q(params)}` : path, undefined, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body ?? {}, signal),
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
