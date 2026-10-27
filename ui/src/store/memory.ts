// Kod's memory, like Rider's memory indicator and low-memory warning: what the engine (Roslyn) and the window's
// processes use, freeing it on request, while the window is hidden or the user is away, and the engine's warning
// when it stays above its limit.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { disposeUnusedModels } from '../editor/models';
import { platform } from '../platform';
import { useProcs } from './procs';
import { useSettings } from './settings';
import { toast, useUi } from './ui';

export interface EngineMemory {
  workingSetMb: number;
  /** Memory only the engine uses (what the OS charges it): the number that matters. */
  privateMb: number;
  managedHeapMb: number;
  heapSizeMb: number;
  fragmentedMb: number;
  committedMb: number;
  machineMb: number;
  gen0: number;
  gen1: number;
  gen2: number;
  pauseMs: number;
  pausePercent: number;
  projects: number;
  unloadedProjects: number;
  documents: number;
  openDocuments: number;
  caches: { name: string; count: number }[];
  settings: { softLimitMb: number; idleTrim: boolean; warnings: boolean };
  lastTrim?: string;
  lastFreedMb?: number;
  lastTrimReason?: string;
}

/** One Electron process (the window's renderer, GPU, the main process, utilities). */
export interface ProcessMemory {
  pid: number;
  type: string;
  name: string;
  workingSetKb: number;
  privateKb: number;
  cpu: number;
}

interface TrimResult {
  beforeMb: number;
  afterMb: number;
  freedMb: number;
  ms: number;
}

interface MemoryState {
  engine: EngineMemory | null;
  processes: ProcessMemory[];
  /** The window's JavaScript heap (browser mode, where the processes are not visible). */
  jsHeapMb: number | null;
  /** Total MB, one sample per poll (the sparkline). */
  history: number[];
  freeing: boolean;
  dialogOpen: boolean;
}

export const useMemory = create<MemoryState>(() => ({ engine: null, processes: [], jsHeapMb: null, history: [], freeing: false, dialogOpen: false }));

/** The window's processes in MB (private memory where the OS reports it). */
export function windowMb(s: MemoryState = useMemory.getState()): number {
  if (s.processes.length) return Math.round(s.processes.reduce((n, p) => n + (p.privateKb || p.workingSetKb), 0) / 1024);
  return s.jsHeapMb ?? 0;
}

/** Everything Kod uses: the engine plus the window. */
export function totalMb(s: MemoryState = useMemory.getState()): number {
  return (s.engine?.privateMb ?? 0) + windowMb(s);
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${Math.round(mb)} MB`;
}

export async function refreshMemory(): Promise<void> {
  const [engine, processes] = await Promise.all([
    api.get<EngineMemory>('/memory').catch(() => null),
    platform.getProcessMemory?.().catch(() => []) ?? Promise.resolve([]),
  ]);
  const perf = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const next = { engine, processes, jsHeapMb: perf ? Math.round(perf.usedJSHeapSize / 1048576) : null };
  const total = totalMb({ ...useMemory.getState(), ...next });
  useMemory.setState((s) => ({ ...next, history: [...s.history, total].slice(-90) }));
}

/** Drops what the window can rebuild: peeked files nobody looks at, old build / run output. */
export function trimWindow(aggressive: boolean): void {
  disposeUnusedModels();
  useProcs.getState().prune(useSettings.getState().settings.keepFinishedProcesses, aggressive);
  if (aggressive) platform.freeRendererMemory?.();
}

/**
 * Free Memory: the window's caches, then the engine's (and when deep, Roslyn's compilations, rebuilt when next
 * needed), the heap compacted and given back to the OS.
 */
export async function freeMemory(deep: boolean): Promise<void> {
  if (useMemory.getState().freeing) return;
  useMemory.setState({ freeing: true });
  const before = totalMb();
  try {
    trimWindow(true);
    await api.post<TrimResult>('/memory/trim', { deep });
    await refreshMemory();
    const freed = before - totalMb();
    toast('success', freed > 0 ? `Freed ${formatMb(freed)}` : 'Memory is already lean', `Kod now uses ${formatMb(totalMb())}.`, 4000);
  } catch (e) {
    toast('error', 'Could not free memory', errorText(e));
  } finally {
    useMemory.setState({ freeing: false });
  }
}

/** The engine's limit and idle trimming follow the settings (sent again whenever the engine (re)connects). */
export function syncMemorySettings(): void {
  const s = useSettings.getState().settings;
  void api.post('/memory/settings', { softLimitMb: s.engineMemoryLimitMb, idleTrim: s.idleTrim, warnings: s.memoryWarnings }).catch(() => undefined);
}

/** The engine stayed above its limit after dropping its caches. */
export function onMemoryPressure(e: { usedMb: number; limitMb: number }): void {
  useUi.getState().toast(
    {
      kind: 'warning',
      text: `Kod is low on memory (${formatMb(e.usedMb)} of ${formatMb(e.limitMb)})`,
      detail: 'Unload projects you are not working on, turn on Power Save Mode, or raise the limit in Settings › Memory.',
      action: { label: 'Manage memory', run: () => useMemory.setState({ dialogOpen: true }) },
    },
    15000,
  );
}

let started = false;

/**
 * Polls while someone looks (the indicator or the dialog), trims the window every few minutes, and gives memory back
 * when the window has been hidden for a minute.
 */
export function startMemoryMonitor(): void {
  if (started) return;
  started = true;
  const tick = () => {
    const visible = document.visibilityState === 'visible';
    const watched = useSettings.getState().settings.memoryIndicator || useMemory.getState().dialogOpen;
    if (visible && watched) void refreshMemory();
    setTimeout(tick, useMemory.getState().dialogOpen ? 2000 : 5000);
  };
  tick();
  setInterval(() => trimWindow(false), 3 * 60_000);

  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (document.visibilityState !== 'hidden' || !useSettings.getState().settings.idleTrim) return;
    hiddenTimer = setTimeout(() => {
      trimWindow(true);
      void api.post('/memory/trim', { deep: false }).catch(() => undefined);
    }, 60_000);
  });

  syncMemorySettings();
  useSettings.subscribe((s, p) => {
    const a = s.settings, b = p.settings;
    if (a.engineMemoryLimitMb !== b.engineMemoryLimitMb || a.idleTrim !== b.idleTrim || a.memoryWarnings !== b.memoryWarnings) syncMemorySettings();
  });
}
