// Debugging (netcoredbg via the engine): session state, the call stack of the stopped thread, the debug console and
// the breakpoints (kept per workspace, sent to the engine when a session starts and whenever they change).
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { basename, norm, samePath } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { useEditors } from './editors';
import { dotnetBuild } from './procs';
import { useSettings } from './settings';
import { askConfirm, toast, useUi } from './ui';
import { startupProject, useWorkspace } from './workspace';

export interface Breakpoint {
  line: number;
  condition?: string;
  verified?: boolean;
}

export interface Frame {
  id: number;
  name: string;
  path?: string;
  line: number;
  column: number;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  /** The expression for this variable (the visualizers evaluate it). */
  evaluateName?: string;
}

export type DebugStatus = 'idle' | 'building' | 'starting' | 'running' | 'stopped';

interface DebugState {
  status: DebugStatus;
  program: string | null;
  reason: string | null;
  frames: Frame[];
  frameId: number | null;
  output: string;
  /** Breakpoints by normalized path. */
  breakpoints: Record<string, { path: string; bps: Breakpoint[] }>;
  /** Bumped on every stop, so variable views reload. */
  stopSeq: number;
  set(p: Partial<DebugState>): void;
  toggle(path: string, line: number): void;
  setLines(path: string, bps: Breakpoint[]): void;
  clearAll(): void;
}

const persistKey = () => {
  const root = useWorkspace.getState().ws.root;
  return root ? norm(root) : null;
};

function persist(b: DebugState['breakpoints']): void {
  const key = persistKey();
  if (!key) return;
  const all = loadRaw<Record<string, DebugState['breakpoints']>>('breakpoints', {});
  all[key] = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { path: v.path, bps: v.bps.map((x) => ({ line: x.line, condition: x.condition })) }]));
  save('breakpoints', all);
}

export const useDebug = create<DebugState>((set, get) => ({
  status: 'idle',
  program: null,
  reason: null,
  frames: [],
  frameId: null,
  output: '',
  breakpoints: {},
  stopSeq: 0,
  set: (p) => set(p),
  toggle: (path, line) => {
    const key = norm(path);
    const cur = get().breakpoints[key]?.bps ?? [];
    const bps = cur.some((b) => b.line === line) ? cur.filter((b) => b.line !== line) : [...cur, { line }].sort((a, b) => a.line - b.line);
    get().setLines(path, bps);
  },
  setLines: (path, bps) => {
    const key = norm(path);
    const breakpoints = { ...get().breakpoints };
    if (bps.length) breakpoints[key] = { path, bps };
    else delete breakpoints[key];
    set({ breakpoints });
    persist(breakpoints);
    if (get().status !== 'idle') void syncFile(path, bps);
  },
  clearAll: () => {
    const old = get().breakpoints;
    set({ breakpoints: {} });
    persist({});
    if (get().status !== 'idle') for (const v of Object.values(old)) void syncFile(v.path, []);
  },
}));

async function syncFile(path: string, bps: Breakpoint[]): Promise<void> {
  try {
    const verified = await api.post<{ line: number; verified: boolean }[]>('/debug/breakpoints', { path, breakpoints: bps.map((b) => ({ line: b.line, condition: b.condition })) });
    const cur = useDebug.getState().breakpoints[norm(path)];
    if (!cur) return;
    useDebug.setState((s) => ({
      breakpoints: { ...s.breakpoints, [norm(path)]: { ...cur, bps: cur.bps.map((b, i) => ({ ...b, verified: verified[i]?.verified ?? b.verified })) } },
    }));
  } catch {
    /* session ended */
  }
}

/** Loads the breakpoints of the workspace that just opened. */
export function loadBreakpoints(): void {
  const key = persistKey();
  const all = loadRaw<Record<string, DebugState['breakpoints']>>('breakpoints', {});
  useDebug.setState({ breakpoints: key ? (all[key] ?? {}) : {} });
}

// ---------------------------------------------------------------- session control

async function ensureAdapter(): Promise<boolean> {
  const a = await api.get<{ installed: boolean; downloadable: boolean }>('/debug/adapter');
  if (a.installed) return true;
  if (!a.downloadable) {
    toast('error', 'No debugger for this system', 'netcoredbg is not available for this operating system.');
    return false;
  }
  const ok = await askConfirm({
    title: 'Install the debugger?',
    message: 'Kod debugs .NET programs with netcoredbg, the open-source debugger from Samsung (MIT licence).\n\nDownload it now from github.com/Samsung/netcoredbg (about 5 MB)?',
    okLabel: 'Download',
  });
  if (ok !== 'ok') return false;
  try {
    useDebug.setState({ status: 'starting' });
    await api.post('/debug/adapter/install');
    toast('success', 'Debugger installed');
    return true;
  } catch (e) {
    toast('error', 'Could not install the debugger', errorText(e));
    return false;
  } finally {
    useDebug.setState({ status: 'idle' });
  }
}

export async function startDebugging(projectPath?: string, opts: { docker?: boolean } = {}): Promise<void> {
  const d = useDebug.getState();
  if (d.status === 'stopped') return step('continue');
  if (d.status !== 'idle') return;
  const project = projectPath ? useWorkspace.getState().ws.projects.find((p) => samePath(p.path, projectPath)) : startupProject();
  if (!project?.runnable) {
    toast('warning', 'Nothing to debug', 'Choose a console, web or worker project as the run configuration.');
    return;
  }
  if (!opts.docker && !(await ensureAdapter())) return;
  if (useSettings.getState().settings.saveBeforeBuild) await useEditors.getState().saveAll();
  useDebug.setState({ status: 'building', output: '', frames: [], frameId: null, reason: null, program: project.name });
  const built = await dotnetBuild('build', project.path);
  if (!built || built.exitCode !== 0) {
    useDebug.setState({ status: 'idle' });
    if (built) toast('error', 'Build failed — not starting the debugger');
    return;
  }
  useDebug.setState({ status: 'starting' });
  useUi.getState().showBottom('debug');
  const breakpoints = Object.fromEntries(Object.values(useDebug.getState().breakpoints).map((v) => [v.path, v.bps.map((b) => ({ line: b.line, condition: b.condition }))]));
  try {
    await api.post('/debug/start', { projectPath: project.path, breakpoints, docker: !!opts.docker });
  } catch (e) {
    useDebug.setState({ status: 'idle' });
    toast('error', 'Could not start debugging', errorText(e));
  }
}

export async function step(command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'): Promise<void> {
  try {
    await api.post('/debug/step', { command });
  } catch (e) {
    toast('warning', 'Debugger', errorText(e));
  }
}

export async function stopDebugging(): Promise<void> {
  await api.post('/debug/stop').catch(() => undefined);
  useDebug.setState({ status: 'idle', frames: [], frameId: null });
}

export const debugActive = () => useDebug.getState().status !== 'idle';

export async function evaluate(expression: string, context: 'hover' | 'watch' | 'repl' = 'repl'): Promise<{ result: string; type?: string; variablesReference: number } | null> {
  const { frameId, status } = useDebug.getState();
  if (status !== 'stopped') return null;
  try {
    return await api.post('/debug/evaluate', { expression, frameId, context });
  } catch (e) {
    if (context === 'repl') return { result: errorText(e), variablesReference: 0 };
    return null;
  }
}

/** Engine events. */
export function onDebugEvent(e: { type: string; [k: string]: unknown }): void {
  switch (e.type) {
    case 'debug.state': {
      const state = e.state as string;
      const program = typeof e.program === 'string' ? basename(e.program).replace(/\.dll$/i, '') : useDebug.getState().program;
      useDebug.setState({ status: state === 'stopped' ? 'stopped' : state === 'starting' ? 'starting' : 'running', program, ...(state === 'running' ? { frames: [], frameId: null } : {}) });
      break;
    }
    case 'debug.stopped': {
      const frames = (e.frames as Frame[]) ?? [];
      const top = frames.find((f) => f.path) ?? frames[0];
      useDebug.setState((s) => ({ status: 'stopped', reason: (e.reason as string) ?? null, frames, frameId: top?.id ?? null, stopSeq: s.stopSeq + 1 }));
      if (top?.path) void useEditors.getState().open(top.path, { line: top.line, column: top.column || 1 });
      useUi.getState().showBottom('debug');
      break;
    }
    case 'debug.output':
      useDebug.setState((s) => {
        let output = s.output + String(e.text ?? '');
        if (output.length > 1_000_000) output = output.slice(-1_000_000);
        return { output };
      });
      break;
    case 'debug.ended':
      useDebug.setState({ status: 'idle', frames: [], frameId: null });
      break;
  }
}
