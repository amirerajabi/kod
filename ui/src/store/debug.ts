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
  /** "N" (the Nth hit), ">= N", "> N", "% N" (every Nth). */
  hitCondition?: string;
  /** Printed on a hit, {expressions} evaluated in the frame. */
  logMessage?: string;
  /** Unset: pauses. False: only logs (a logpoint). */
  suspend?: boolean;
  /** Unset: enabled. Disabled ones stay in the gutter but are not sent to the debugger. */
  enabled?: boolean;
  /** Removed after the first hit. */
  temporary?: boolean;
  verified?: boolean;
}

/** What the debugger is told about a breakpoint (verified is the debugger's answer, not ours). */
const wire = (b: Breakpoint) => ({ line: b.line, condition: b.condition, hitCondition: b.hitCondition, logMessage: b.logMessage, suspend: b.suspend !== false });
const saved = ({ verified: _v, ...b }: Breakpoint) => b;
const sent = (bps: Breakpoint[]) => bps.filter((b) => b.enabled !== false);

/** netcoredbg's exception filters: 'all' thrown exceptions, 'user-unhandled' ones user code does not catch. */
export type ExceptionFilter = 'all' | 'user-unhandled';

export interface StoppedException {
  type?: string;
  message?: string;
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

/** The value popup over a hovered expression while paused (Rider's debugger tooltip); x / y: screen point under the word. */
export interface ValueTip {
  x: number;
  y: number;
  /** Line height at the word, so the popup can go above it. */
  height: number;
  expression: string;
  result: string;
  type?: string;
  variablesReference: number;
}

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
  /** The exception the program stopped on. */
  exception: StoppedException | null;
  exceptionFilters: ExceptionFilter[];
  /** The breakpoint being edited (its properties dialog). */
  editing: { path: string; line: number } | null;
  attachOpen: boolean;
  tip: ValueTip | null;
  set(p: Partial<DebugState>): void;
  toggle(path: string, line: number): void;
  setLines(path: string, bps: Breakpoint[]): void;
  /** Changes one breakpoint's properties (adds it when missing). */
  update(path: string, line: number, p: Partial<Breakpoint>): void;
  setExceptionFilters(f: ExceptionFilter[]): void;
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
  all[key] = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { path: v.path, bps: v.bps.map(saved) }]));
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
  exception: null,
  exceptionFilters: loadRaw<ExceptionFilter[]>('exceptionFilters', ['user-unhandled']),
  editing: null,
  attachOpen: false,
  tip: null,
  set: (p) => set(p),
  update: (path, line, p) => {
    const cur = get().breakpoints[norm(path)]?.bps ?? [];
    const bps = cur.some((b) => b.line === line) ? cur.map((b) => (b.line === line ? { ...b, ...p } : b)) : [...cur, { line, ...p }].sort((a, b) => a.line - b.line);
    get().setLines(path, bps);
  },
  setExceptionFilters: (f) => {
    set({ exceptionFilters: f });
    save('exceptionFilters', f);
    if (get().status !== 'idle') void api.post('/debug/exceptions', { filters: f }).catch(() => undefined);
  },
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
    const on = sent(bps);
    const verified = await api.post<{ line: number; verified: boolean }[]>('/debug/breakpoints', { path, breakpoints: on.map(wire) });
    const cur = useDebug.getState().breakpoints[norm(path)];
    if (!cur) return;
    const byLine = new Map(on.map((b, i) => [b.line, verified[i]?.verified]));
    useDebug.setState((s) => ({
      breakpoints: { ...s.breakpoints, [norm(path)]: { ...cur, bps: cur.bps.map((b) => ({ ...b, verified: byLine.get(b.line) ?? b.verified })) } },
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

/** How a run configuration launches its project. */
export interface LaunchOptions {
  /** A launchSettings.json profile; undefined: the one `dotnet run` picks; null: none. */
  profile?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

let lastStart: { projectPath?: string; opts: { docker?: boolean; launch?: LaunchOptions } } = { opts: {} };

const breakpointsForStart = () => Object.fromEntries(Object.values(useDebug.getState().breakpoints).map((v) => [v.path, sent(v.bps).map(wire)]));

export async function startDebugging(projectPath?: string, opts: { docker?: boolean; launch?: LaunchOptions } = {}): Promise<void> {
  const d = useDebug.getState();
  if (d.status === 'stopped') return step('continue');
  if (d.status !== 'idle') return;
  const project = projectPath ? useWorkspace.getState().ws.projects.find((p) => samePath(p.path, projectPath)) : startupProject();
  if (!project?.runnable) {
    toast('warning', 'Nothing to debug', 'Choose a console, web or worker project as the run configuration.');
    return;
  }
  if (!opts.docker && !(await ensureAdapter())) return;
  lastStart = { projectPath: project.path, opts };
  if (useSettings.getState().settings.saveBeforeBuild) await useEditors.getState().saveAll();
  useDebug.setState({ status: 'building', output: '', frames: [], frameId: null, reason: null, exception: null, program: project.name });
  const built = await dotnetBuild('build', project.path);
  if (!built || built.exitCode !== 0) {
    useDebug.setState({ status: 'idle' });
    if (built) toast('error', 'Build failed — not starting the debugger');
    return;
  }
  useDebug.setState({ status: 'starting' });
  useUi.getState().showBottom('debug');
  const l = opts.launch ?? {};
  try {
    await api.post('/debug/start', {
      projectPath: project.path,
      breakpoints: breakpointsForStart(),
      docker: !!opts.docker,
      profile: l.profile ?? undefined,
      noProfile: l.profile === null,
      args: l.args,
      env: l.env,
      cwd: l.cwd || undefined,
      exceptionFilters: useDebug.getState().exceptionFilters,
    });
  } catch (e) {
    useDebug.setState({ status: 'idle' });
    toast('error', 'Could not start debugging', errorText(e));
  }
}

/** Debug again what was debugged last (the Debug window's Restart). */
export async function restartDebugging(): Promise<void> {
  await stopDebugging();
  await startDebugging(lastStart.projectPath, lastStart.opts);
}

/** Attaches the debugger to a running .NET process. */
export async function attachTo(pid: number, name: string): Promise<void> {
  if (useDebug.getState().status !== 'idle') await stopDebugging();
  if (!(await ensureAdapter())) return;
  useDebug.setState({ status: 'starting', output: '', frames: [], frameId: null, reason: null, exception: null, program: name });
  useUi.getState().showBottom('debug');
  try {
    await api.post('/debug/attach', { processId: pid, breakpoints: breakpointsForStart(), exceptionFilters: useDebug.getState().exceptionFilters });
  } catch (e) {
    useDebug.setState({ status: 'idle' });
    toast('error', `Could not attach to ${name}`, errorText(e));
  }
}

/** Resumes until the caret's line (Rider's Run to Cursor). */
export async function runToCursor(path: string, line: number): Promise<void> {
  if (useDebug.getState().status !== 'stopped') {
    toast('info', 'Run to Cursor works while paused');
    return;
  }
  try {
    await api.post('/debug/runTo', { path, line });
  } catch (e) {
    toast('warning', 'Run to Cursor', errorText(e));
  }
}

/** Gives a variable a new value (an expression the debugger evaluates); null when it refused. */
export async function setVariable(reference: number, name: string, value: string): Promise<string | null> {
  try {
    const r = await api.post<{ result: string }>('/debug/setVariable', { reference, name, value });
    return r.result;
  } catch (e) {
    toast('warning', `Could not set ${name}`, errorText(e));
    return null;
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
  useDebug.setState({ status: 'idle', frames: [], frameId: null, tip: null });
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

type HoverValue = { result: string; type?: string; variablesReference: number };
const hoverCache = new Map<string, Promise<HoverValue | null>>();

/** The value of a hovered expression in the current frame, asked once per stop (the editor's value popup and the
 *  quick info hover share it: a variable's value replaces its quick info while paused, as in Rider). */
export function hoverValue(expression: string): Promise<HoverValue | null> {
  const { stopSeq, frameId } = useDebug.getState();
  const key = `${stopSeq}:${frameId}:${expression}`;
  let p = hoverCache.get(key);
  if (!p) {
    if (hoverCache.size > 200) hoverCache.clear();
    // "error CS0103: The name ... does not exist" is not a value
    p = evaluate(expression, 'hover').then((r) => (r && !/^error\b/i.test(r.result) ? r : null));
    hoverCache.set(key, p);
  }
  return p;
}

let tipTimer: ReturnType<typeof setTimeout> | undefined;
/** The mouse is in the popup: the editor's (sometimes late) mouse leave does not close it. */
let overTip = false;
/** Hides the value popup after a moment, unless the mouse is in it by then. */
export function hideValueTip(delay = 300): void {
  clearTimeout(tipTimer);
  if (!useDebug.getState().tip) return;
  tipTimer = setTimeout(() => !overTip && useDebug.setState({ tip: null }), delay);
}
export function enterValueTip(): void {
  overTip = true;
  clearTimeout(tipTimer);
}
export function leaveValueTip(): void {
  overTip = false;
  hideValueTip();
}
export function showValueTip(tip: ValueTip): void {
  clearTimeout(tipTimer);
  overTip = false;
  useDebug.setState({ tip });
}

/** Engine events. */
export function onDebugEvent(e: { type: string; [k: string]: unknown }): void {
  switch (e.type) {
    case 'debug.state': {
      const state = e.state as string;
      const program = typeof e.program === 'string' ? basename(e.program).replace(/\.dll$/i, '') : useDebug.getState().program;
      useDebug.setState({ status: state === 'stopped' ? 'stopped' : state === 'starting' ? 'starting' : 'running', program, ...(state === 'running' ? { frames: [], frameId: null, exception: null, tip: null } : {}) });
      break;
    }
    case 'debug.stopped': {
      const frames = (e.frames as Frame[]) ?? [];
      const top = frames.find((f) => f.path) ?? frames[0];
      const raw = (e.exception as StoppedException | null) ?? null;
      const exception = raw && { ...raw, type: raw.type?.replace(/^CLR\//, '') };
      useDebug.setState((s) => ({ status: 'stopped', reason: (e.reason as string) ?? null, frames, frameId: top?.id ?? null, stopSeq: s.stopSeq + 1, exception }));
      if (exception) useDebug.setState((s) => ({ output: `${s.output}\n⚠ ${exception.type ?? 'Exception'}: ${exception.message ?? ''}\n` }));
      // a temporary breakpoint goes once it is hit
      const hit = e.breakpoint as { path: string; line: number } | null;
      if (hit) {
        const bp = useDebug.getState().breakpoints[norm(hit.path)];
        if (bp?.bps.some((b) => b.line === hit.line && b.temporary)) useDebug.getState().setLines(bp.path, bp.bps.filter((b) => b.line !== hit.line));
      }
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
      useDebug.setState({ status: 'idle', frames: [], frameId: null, exception: null, tip: null });
      break;
  }
}
