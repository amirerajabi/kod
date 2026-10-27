// Find Usages, Rider's way: Show Usages (Ctrl+Alt+F7) lists them in a popup at the caret, Find Usages (Alt+F7) in the
// Find tool window. Both share the last search, so the popup's "Open in Find window" just shows it there.
import { create } from 'zustand';
import { api } from '../api/client';
import type { UsageDto, UsagesDto } from '../api/types';

export type UsageKind = UsageDto['kind'];

/** Rider's usage type names, in its order. */
export const KIND_LABEL: Record<UsageKind, string> = {
  declaration: 'Declaration',
  invocation: 'Invocation',
  creation: 'New instance creation',
  read: 'Read access',
  write: 'Write access',
  readwrite: 'Read/write access',
  reference: 'Reference',
  type: 'Type usage',
  typeof: 'Usage in typeof',
  base: 'Base type',
  attribute: 'Attribute usage',
  nameof: 'Usage in nameof',
  import: 'Usage in import',
};
export const KIND_ORDER = Object.keys(KIND_LABEL) as UsageKind[];

export interface UsageRequest {
  path: string;
  /** The editor's text when searched; a rerun leaves it out and searches the files as they are now. */
  text?: string;
  line: number;
  column: number;
  word: string;
}

/** A search kept in its own tab of the Find window (Rider's Pin Tab). */
export interface UsageSearch {
  request: UsageRequest;
  symbol: string;
  symbolKind: string;
  items: UsageDto[];
}

interface UsagesState {
  request: UsageRequest | null;
  /** Symbol display ("Order.Total") and kind ("property"); empty until the engine answers. */
  symbol: string;
  symbolKind: string;
  items: UsageDto[];
  loading: boolean;
  error: string | null;
  /** The Show Usages popup's anchor (screen pixels under the caret), when it is open. */
  popup: { x: number; y: number } | null;
  /** Pinned searches; a new search replaces the unpinned one, like Rider's tabs. */
  pinned: UsageSearch[];
  /** The pinned tab on show, or null for the latest search. */
  tab: number | null;
  set(p: Partial<Omit<UsagesState, 'set'>>): void;
}

export const useUsages = create<UsagesState>((set) => ({
  request: null,
  symbol: '',
  symbolKind: '',
  items: [],
  loading: false,
  error: null,
  popup: null,
  pinned: [],
  tab: null,
  set: (p) => set(p),
}));

let seq = 0;

/** Runs the search (again, when no request is given) and fills the store. */
export async function searchUsages(req?: UsageRequest): Promise<UsageDto[] | null> {
  const r = req ?? useUsages.getState().request;
  if (!r) return null;
  const id = ++seq;
  useUsages.getState().set({ tab: null, request: r, loading: true, error: null, items: [], symbol: r.word, symbolKind: '' });
  try {
    const res = await api.post<UsagesDto | undefined>('/intel/usages', { path: r.path, text: r.text, line: r.line, column: r.column });
    if (id !== seq) return null;
    if (!res) {
      useUsages.getState().set({ loading: false, error: 'Cannot find a symbol to search for at the caret' });
      return [];
    }
    useUsages.getState().set({ loading: false, items: res.usages, symbol: res.symbol, symbolKind: res.symbolKind });
    return res.usages;
  } catch (e) {
    if (id === seq) useUsages.getState().set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export const isWrite = (k: UsageKind) => k === 'write' || k === 'readwrite';
export const isRead = (k: UsageKind) => k === 'read' || k === 'readwrite';

/** Pins the latest search: it gets its own tab and the next search opens next to it. */
export function pinSearch(): void {
  const s = useUsages.getState();
  if (!s.request || s.loading) return;
  const pinned = [...s.pinned, { request: s.request, symbol: s.symbol, symbolKind: s.symbolKind, items: s.items }];
  // the search now lives in its pinned tab; the latest-search tab comes back with the next search
  s.set({ pinned, tab: pinned.length - 1, request: null, items: [], symbol: '', symbolKind: '' });
}

/** Rerun of a pinned tab: searches again in place. */
export async function rerunPinned(i: number): Promise<void> {
  const t = useUsages.getState().pinned[i];
  if (!t) return;
  const res = await api.post<UsagesDto | undefined>('/intel/usages', { path: t.request.path, line: t.request.line, column: t.request.column });
  const pinned = useUsages.getState().pinned.map((p) => (p === t ? { ...p, items: res?.usages ?? [] } : p));
  useUsages.getState().set({ pinned });
}

export function closeTab(i: number): void {
  const s = useUsages.getState();
  const pinned = s.pinned.filter((_, j) => j !== i);
  s.set({ pinned, tab: s.tab === null || s.tab < i ? s.tab : s.tab === i ? null : s.tab - 1 });
}
