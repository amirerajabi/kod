import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { EngineEvent, ProcDto } from '../api/types';
import { parseBuildDiagnostics } from '../lib/buildOutput';
import { stripAnsi } from '../lib/ansi';
import { basename, dirname } from '../lib/paths';
import { platform } from '../platform';
import { useEditors } from './editors';
import { countProblems, useProblems } from './problems';
import { useSettings } from './settings';
import { toast, useUi } from './ui';
import { startupProject, useWorkspace } from './workspace';

export interface ProcView {
  info: ProcDto;
  text: string;
}

/** Which bottom tab shows a process. */
export type ProcGroup = 'run' | 'build' | 'terminal';

export const groupOf = (kind: string): ProcGroup => (kind === 'run' || kind === 'docker-run' ? 'run' : kind === 'terminal' ? 'terminal' : 'build');

export interface StartRequest {
  kind: string;
  title: string;
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface ProcsState {
  procs: Record<string, ProcView>;
  selected: Record<ProcGroup, string | null>;
  onEvent(e: EngineEvent): void;
  start(req: StartRequest): Promise<ProcDto | null>;
  select(group: ProcGroup, id: string): void;
  clear(id: string): void;
  remove(id: string): void;
  /** Closes the oldest finished outputs beyond `keep` per tool window; aggressive also cuts long finished outputs. */
  prune(keep: number, aggressive?: boolean): void;
  stop(id: string): Promise<void>;
  input(id: string, text: string): Promise<void>;
}

const MAX_TEXT = 2_000_000;
/** What a finished, unseen output keeps when memory is freed. */
const KEEP_TEXT = 200_000;
const waiters = new Map<string, (p: ProcDto) => void>();
const urlShown = new Set<string>();
/** Runs that open the browser once listening: the launch URL to open (relative to the listening address, or absolute). */
const browserFor = new Map<string, string>();

/** The first "Now listening on: http://…" address in ASP.NET Core's output. */
export function listeningUrl(text: string): string | null {
  return /Now listening on:\s*(https?:\/\/\S+)/.exec(stripAnsi(text))?.[1] ?? null;
}

/** What the browser opens: an absolute launch URL as it is, else the listening address (any-host bindings as localhost) plus the path. */
export function browserUrl(listening: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  const base = listening.replace(/\/\/(0\.0\.0\.0|\[::\]|\+|\*)(?=[:/]|$)/, '//localhost').replace(/\/+$/, '');
  return target ? `${base}/${target.replace(/^\/+/, '')}` : base;
}

export const useProcs = create<ProcsState>((set, get) => ({
  procs: {},
  selected: { run: null, build: null, terminal: null },

  onEvent: (e) => {
    if (e.type === 'proc.started') {
      const { type: _t, ...info } = e;
      if (!get().procs[info.id]) set((s) => ({ procs: { ...s.procs, [info.id]: { info, text: '' } } }));
    } else if (e.type === 'proc.output') {
      const p = get().procs[e.id];
      if (!p) return;
      let text = p.text + e.text;
      if (text.length > MAX_TEXT) text = text.slice(text.length - MAX_TEXT);
      set((s) => ({ procs: { ...s.procs, [e.id]: { ...p, text } } }));
      if (p.info.kind === 'run' && p.info.commandLine.startsWith('dotnet watch')) hotReloadNotice(stripAnsi(e.text));
      if (p.info.kind === 'run' && !urlShown.has(e.id)) {
        const listening = listeningUrl(text);
        if (listening) {
          urlShown.add(e.id);
          const target = browserFor.get(e.id);
          if (target !== undefined) {
            const url = browserUrl(listening, target);
            void platform.openExternal(url);
            toast('success', `${p.info.title} is listening: opened the browser`, url, 4000);
          } else useUi.getState().toast({ kind: 'success', text: `${p.info.title} is listening`, detail: listening, action: { label: 'Open in browser', run: () => platform.openExternal(browserUrl(listening, '')) } }, 10_000);
        }
      }
    } else if (e.type === 'proc.exit') {
      const { type: _t, ...info } = e;
      const p = get().procs[info.id];
      set((s) => ({ procs: { ...s.procs, [info.id]: { info, text: p?.text ?? '' } } }));
      waiters.get(info.id)?.(info);
      waiters.delete(info.id);
      if (p) afterExit(info, p.text);
      get().prune(useSettings.getState().settings.keepFinishedProcesses);
    }
  },

  start: async (req) => {
    try {
      const info = await api.post<ProcDto>('/proc/start', req);
      const group = groupOf(info.kind);
      set((s) => ({
        procs: { ...s.procs, [info.id]: s.procs[info.id] ?? { info, text: '' } },
        selected: { ...s.selected, [group]: info.id },
      }));
      return info;
    } catch (e) {
      toast('error', `Could not start ${req.title}`, errorText(e));
      return null;
    }
  },

  select: (group, id) => set((s) => ({ selected: { ...s.selected, [group]: id } })),
  clear: (id) => set((s) => (s.procs[id] ? { procs: { ...s.procs, [id]: { ...s.procs[id], text: '' } } } : s)),
  remove: (id) =>
    set((s) => {
      const procs = { ...s.procs };
      const group = procs[id] ? groupOf(procs[id].info.kind) : null;
      delete procs[id];
      const selected = { ...s.selected };
      if (group && selected[group] === id) selected[group] = Object.values(procs).filter((p) => groupOf(p.info.kind) === group).at(-1)?.info.id ?? null;
      return { procs, selected };
    }),
  prune: (keep, aggressive = false) =>
    set((s) => {
      const procs = { ...s.procs };
      let changed = false;
      const selected = new Set(Object.values(s.selected));
      const finished = Object.values(procs).filter((p) => p.info.exitCode != null && p.info.kind !== 'terminal');
      for (const group of new Set(finished.map((p) => groupOf(p.info.kind)))) {
        // the newest stay (and whichever one is on screen)
        const old = finished.filter((p) => groupOf(p.info.kind) === group).slice(0, -Math.max(1, keep));
        for (const p of old)
          if (!selected.has(p.info.id)) {
            delete procs[p.info.id];
            urlShown.delete(p.info.id);
            browserFor.delete(p.info.id);
            changed = true;
          }
      }
      if (aggressive)
        for (const p of finished)
          if (procs[p.info.id] && !selected.has(p.info.id) && p.text.length > KEEP_TEXT) {
            procs[p.info.id] = { ...p, text: '…(older output dropped to save memory)\n' + p.text.slice(-KEEP_TEXT) };
            changed = true;
          }
      return changed ? { procs } : s;
    }),
  stop: async (id) => {
    await api.post(`/proc/${id}/stop`).catch(() => undefined);
  },
  input: async (id, text) => {
    // the shell runs without echo: show what was typed
    const p = get().procs[id];
    if (p?.info.kind === 'terminal') set((s) => ({ procs: { ...s.procs, [id]: { ...p, text: p.text + `\u001b[1m${text}\u001b[0m` } } }));
    try {
      await api.post(`/proc/${id}/input`, { text });
    } catch (e) {
      toast('warning', 'Input not sent', errorText(e));
    }
  },
}));

/** Starts a process and resolves when it exits. */
export async function runAndWait(req: StartRequest): Promise<ProcDto | null> {
  const info = await useProcs.getState().start(req);
  if (!info) return null;
  const done = useProcs.getState().procs[info.id]?.info;
  if (done?.exitCode !== undefined && done.exitCode !== null) return done;
  return new Promise((resolve) => waiters.set(info.id, resolve));
}

function afterExit(info: ProcDto, text: string): void {
  if (!['build', 'test', 'rebuild'].includes(info.kind)) {
    if (info.kind === 'nuget' && info.exitCode === 0) toast('success', info.title);
    else if (info.kind === 'nuget') toast('error', `${info.title} failed`, undefined, 8000);
    return;
  }
  const diags = parseBuildDiagnostics(text);
  useProblems.getState().set({ build: diags });
  const { errors, warnings } = countProblems(diags);
  const ms = info.endedAt && info.startedAt ? ((info.endedAt - info.startedAt) / 1000).toFixed(1) : '?';
  if (info.exitCode === 0) {
    toast('success', `${info.title} succeeded in ${ms} s`, warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : undefined, 4000);
  } else {
    useUi.getState().toast(
      {
        kind: 'error',
        text: `${info.title} failed`,
        detail: errors ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : `exit code ${info.exitCode}`,
        action: errors ? { label: 'Show problems', run: () => useUi.getState().showBottom('problems') } : undefined,
      },
      10_000,
    );
  }
}

// ---------------------------------------------------------------- dotnet commands

function buildTarget(): { path: string; cwd: string } | null {
  const { ws } = useWorkspace.getState();
  if (!ws.root) return null;
  // a solution builds as a whole; without one, the run configuration's project (dotnet cannot build a bare folder)
  if (ws.target) return { path: ws.target, cwd: dirname(ws.target) };
  const project = startupProject() ?? ws.projects[0];
  return project ? { path: project.path, cwd: dirname(project.path) } : null;
}

async function beforeBuild(): Promise<void> {
  if (useSettings.getState().settings.saveBeforeBuild) await useEditors.getState().saveAll();
}

function busy(kinds: string[]): ProcView | undefined {
  return Object.values(useProcs.getState().procs).find((p) => kinds.includes(p.info.kind) && p.info.exitCode == null);
}

export async function dotnetBuild(kind: 'build' | 'rebuild' | 'clean' | 'restore' = 'build', projectPath?: string): Promise<ProcDto | null> {
  const t = projectPath ? { path: projectPath, cwd: dirname(projectPath) } : buildTarget();
  if (!t) return null;
  if (busy(['build', 'rebuild', 'clean', 'restore', 'test'])) {
    toast('info', 'A build is already running');
    return null;
  }
  await beforeBuild();
  useUi.getState().showBottom('build');
  const verb = kind === 'rebuild' ? 'build' : kind;
  const args = [verb, t.path, '-nologo', ...(kind === 'rebuild' ? ['--no-incremental'] : []), ...(kind === 'build' || kind === 'rebuild' ? ['-v:minimal'] : [])];
  const title = `${kind[0].toUpperCase()}${kind.slice(1)} ${basename(t.path)}`;
  return runAndWait({ kind: kind === 'rebuild' ? 'rebuild' : kind === 'build' ? 'build' : kind, title, file: 'dotnet', args, cwd: t.cwd });
}

export async function dotnetTest(projectPath?: string, filter?: string): Promise<ProcDto | null> {
  const t = projectPath ? { path: projectPath, cwd: dirname(projectPath) } : buildTarget();
  if (!t) return null;
  if (busy(['build', 'rebuild', 'test'])) {
    toast('info', 'A build is already running');
    return null;
  }
  await beforeBuild();
  useUi.getState().showBottom('build');
  const args = ['test', t.path, '-nologo', ...(filter ? ['--filter', filter] : []), '--logger', 'console;verbosity=normal'];
  return runAndWait({ kind: 'test', title: `Test ${basename(t.path)}`, file: 'dotnet', args, cwd: t.cwd });
}

/** A run configuration's launch: its name (the Run tab's title), launch profile, arguments, variables, folder, Hot Reload. */
export interface RunOptions {
  title?: string;
  /** A launchSettings.json profile; undefined: the one `dotnet run` picks; null: none. */
  profile?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** `dotnet watch`: saved edits are applied to the running app (a rude edit restarts it). */
  hotReload?: boolean;
  /** Open the browser once the app listens: the launch URL (a path, an absolute URL, or '' for the address itself). */
  browser?: string;
}

/** Run tab title → process, so a rerun stops the previous instance of the same configuration. */
const runByTitle = new Map<string, string>();

export async function dotnetRun(projectPath?: string, opts: RunOptions = {}): Promise<ProcDto | null> {
  const project = projectPath ? useWorkspace.getState().ws.projects.find((p) => p.path === projectPath) : startupProject();
  const path = project?.path ?? projectPath;
  if (!path) {
    toast('warning', 'Nothing to run', 'Open a project with an executable (console, web, worker) first.');
    return null;
  }
  const title = opts.title ?? project?.name ?? basename(path);
  // one instance per configuration, like Rider's "Stop and rerun"
  const prev = runByTitle.get(title);
  const running = prev ? useProcs.getState().procs[prev] : undefined;
  if (running && running.info.exitCode == null) {
    await useProcs.getState().stop(running.info.id);
    await new Promise((r) => setTimeout(r, 400));
  }
  await beforeBuild();
  useUi.getState().showBottom('run');
  const profile = opts.profile === null ? ['--no-launch-profile'] : opts.profile ? ['--launch-profile', opts.profile] : [];
  const program = opts.args?.length ? ['--', ...opts.args] : [];
  const args = opts.hotReload ? ['watch', '--non-interactive', 'run', '--project', path, ...profile, ...program] : ['run', '--project', path, ...profile, ...program];
  const env: Record<string, string> = { ASPNETCORE_ENVIRONMENT: 'Development', DOTNET_ENVIRONMENT: 'Development', ...opts.env };
  // Kod offers the URL itself; a rude edit restarts instead of asking on the console
  if (opts.hotReload) Object.assign(env, { DOTNET_WATCH_RESTART_ON_RUDE_EDIT: 'true', DOTNET_WATCH_SUPPRESS_LAUNCH_BROWSER: '1', DOTNET_WATCH_SUPPRESS_EMOJIS: '1' });
  const info = await useProcs.getState().start({ kind: 'run', title, file: 'dotnet', args, cwd: opts.cwd || dirname(path), env });
  if (info) {
    runByTitle.set(title, info.id);
    if (opts.browser !== undefined) browserFor.set(info.id, opts.browser);
  }
  return info;
}

/** dotnet watch's report on a save: applied, or restarting after an edit Hot Reload cannot apply. */
function hotReloadNotice(text: string): void {
  if (/Hot reload (of changes )?succeeded|changes applied in/i.test(text)) toast('success', 'Hot Reload: changes applied', undefined, 2500);
  else if (/compilation errors|build failed/i.test(text)) toast('warning', 'Hot Reload: the change does not build', 'Fix the errors and save again.', 4000);
  else if (/rude edit|restart is needed|restarting|unable to apply/i.test(text)) toast('info', 'Hot Reload: restarting the app', 'The change cannot be applied to the running app.', 4000);
}

export function stopAll(kind?: ProcGroup): void {
  for (const p of Object.values(useProcs.getState().procs))
    if (p.info.exitCode == null && (!kind || groupOf(p.info.kind) === kind) && p.info.kind !== 'terminal') void useProcs.getState().stop(p.info.id);
}

export function runningOf(group: ProcGroup): ProcView[] {
  return Object.values(useProcs.getState().procs).filter((p) => groupOf(p.info.kind) === group && p.info.exitCode == null);
}

/** Opens a new terminal (a real shell in the Terminal tool window). */
export async function startTerminal(cwd?: string): Promise<void> {
  const { newTerminal } = await import('./terminals');
  await newTerminal(cwd);
}
