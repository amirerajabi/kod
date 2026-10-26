import { useUi } from '../store/ui';
import { engineInfo } from './client';
import type { EngineEvent } from './types';

type Handler = (e: EngineEvent) => void;

const handlers = new Set<Handler>();
let socket: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function onEngineEvent(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

/** Connects (and keeps reconnecting with backoff) to the engine's event stream. */
export async function connectEvents(): Promise<void> {
  clearTimeout(timer);
  socket?.close();
  const info = await engineInfo();
  const url = `${info.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(info.token)}`;
  useUi.getState().set({ wsStatus: 'connecting' });
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    useUi.getState().set({ wsStatus: 'open', engineError: null });
  };
  ws.onmessage = (m) => {
    let e: EngineEvent;
    try {
      e = JSON.parse(m.data as string) as EngineEvent;
    } catch {
      return;
    }
    for (const h of handlers) {
      try {
        h(e);
      } catch (err) {
        console.error('event handler failed', err);
      }
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    useUi.getState().set({ wsStatus: 'closed' });
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    timer = setTimeout(() => void connectEvents().catch(() => undefined), delay);
  };
}
