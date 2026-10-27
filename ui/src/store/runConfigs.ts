// Run / debug configurations (Rider's Run › Edit Configurations): one generated per runnable project, plus the ones the
// user saves (a launch profile, program arguments, environment variables, working folder, Hot Reload) and compounds that
// start several at once. Kept per workspace; the selected one also sets the workspace's startup project.
import { create } from 'zustand';
import { api } from '../api/client';
import type { ProjectDto } from '../api/types';
import { samePath } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { startDebugging, type LaunchOptions } from './debug';
import { dotnetRun } from './procs';
import { toast } from './ui';
import { useWorkspace } from './workspace';

export interface RunConfig {
  id: string;
  name: string;
  type: 'project' | 'compound';
  project?: string;
  /** A launchSettings.json profile; undefined: the one `dotnet run` picks; null: none. */
  profile?: string | null;
  /** Program arguments as typed (a command line). */
  args?: string;
  env?: Record<string, string>;
  cwd?: string;
  hotReload?: boolean;
  /** After launch: open the browser once the app listens; undefined follows the launch profile's launchBrowser. */
  browser?: 'open' | 'off';
  /** The page to open: a path under the app's address or an absolute URL; empty uses the profile's launchUrl. */
  browserUrl?: string;
  /** Compound: the configurations it starts. */
  configs?: string[];
}

export interface LaunchProfile {
  name: string;
  commandName: string;
  applicationUrl?: string;
  env: Record<string, string>;
  commandLineArgs?: string;
  launchBrowser?: boolean;
  launchUrl?: string;
}

/** The id of a project's generated configuration (saving one with this id replaces it). */
export const autoId = (projectPath: string) => `auto:${projectPath.toLowerCase()}`;

const autoConfig = (p: ProjectDto): RunConfig => ({ id: autoId(p.path), name: p.name, type: 'project', project: p.path });

interface RunConfigsState {
  /** The user's configurations (edited generated ones included, under their auto: id). */
  saved: RunConfig[];
  /** Generated ones the user removed. */
  hidden: string[];
  activeId: string | null;
  editing: boolean;
  load(root: string | undefined): void;
  setActive(id: string): void;
  replaceAll(saved: RunConfig[], hidden: string[]): void;
}

const keyOf = () => useWorkspace.getState().ws.root?.replace(/[\\/]+$/, '').toLowerCase() ?? null;

function persist(s: Pick<RunConfigsState, 'saved' | 'hidden' | 'activeId'>): void {
  const key = keyOf();
  if (key) save('runConfigs', { ...loadRaw<Record<string, unknown>>('runConfigs', {}), [key]: s });
}

export const useRunConfigs = create<RunConfigsState>((set, get) => ({
  saved: [],
  hidden: [],
  activeId: null,
  editing: false,
  load: (root) => {
    const key = root?.replace(/[\\/]+$/, '').toLowerCase();
    const s = key ? loadRaw<Record<string, Partial<RunConfigsState>>>('runConfigs', {})[key] : undefined;
    set({ saved: s?.saved ?? [], hidden: s?.hidden ?? [], activeId: s?.activeId ?? null });
  },
  setActive: (id) => {
    set({ activeId: id });
    persist(get());
    const c = configById(id);
    const project = c?.type === 'compound' ? configById(c.configs?.[0] ?? '')?.project : c?.project;
    if (project && !samePath(project, useWorkspace.getState().startup)) useWorkspace.getState().setStartup(project);
  },
  replaceAll: (saved, hidden) => {
    const activeId = allConfigs(saved, hidden).some((c) => c.id === get().activeId) ? get().activeId : null;
    set({ saved, hidden, activeId });
    persist(get());
    if (activeId) get().setActive(activeId);
  },
}));

/** Every configuration: the saved ones, then a generated one for each runnable project not saved or removed. */
export function allConfigs(saved = useRunConfigs.getState().saved, hidden = useRunConfigs.getState().hidden): RunConfig[] {
  const ids = new Set(saved.map((c) => c.id));
  const generated = useWorkspace
    .getState()
    .ws.projects.filter((p) => p.runnable && !p.unloaded)
    .map(autoConfig)
    .filter((c) => !ids.has(c.id) && !hidden.includes(c.id));
  // generated configurations sit where their project is; the user's own after them
  const savedAuto = saved.filter((c) => c.id.startsWith('auto:'));
  return [...savedAuto, ...generated, ...saved.filter((c) => !c.id.startsWith('auto:'))];
}

export const configById = (id: string) => allConfigs().find((c) => c.id === id);

/** The selected configuration: the chosen one, else the one for the workspace's startup project, else the first. */
export function activeConfig(): RunConfig | undefined {
  const all = allConfigs();
  const { activeId } = useRunConfigs.getState();
  const startup = useWorkspace.getState().startup;
  const chosen = all.find((c) => c.id === activeId);
  // the Explorer's "Set as Run Configuration" changes the startup project: follow it
  if (chosen && (chosen.type === 'compound' || !startup || samePath(chosen.project, startup))) return chosen;
  return all.find((c) => c.type === 'project' && samePath(c.project, startup)) ?? chosen ?? all[0];
}

/** A command line split the way the shell would: spaces separate, double quotes group. */
export function splitArgs(line: string | undefined): string[] {
  const out: string[] = [];
  if (!line?.trim()) return out;
  let cur = '';
  let quoted = false;
  let any = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (any) out.push(cur);
      cur = '';
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/** The launch profile a configuration uses (the named one, else the first that runs the project), or none. */
async function profileOf(c: RunConfig): Promise<LaunchProfile | undefined> {
  if (!c.project || c.profile === null) return undefined;
  const all = await launchProfiles(c.project);
  return c.profile ? all.find((p) => p.name === c.profile) : all.find((p) => p.commandName === 'Project');
}

/** What the browser opens once the app listens (Rider's "After launch"), or undefined when it does not open. */
export async function browserOf(c: RunConfig): Promise<string | undefined> {
  if (c.browser === 'off') return undefined;
  const p = await profileOf(c);
  if (c.browser !== 'open' && !p?.launchBrowser) return undefined;
  return c.browserUrl?.trim() || p?.launchUrl || '';
}

const launchOf = async (c: RunConfig): Promise<LaunchOptions> => ({ profile: c.profile, args: splitArgs(c.args), env: c.env, cwd: c.cwd, browser: await browserOf(c) });

/** The project configurations a configuration starts (itself, or a compound's members). */
function members(c: RunConfig): RunConfig[] {
  if (c.type === 'project') return [c];
  return (c.configs ?? []).map(configById).filter((m): m is RunConfig => m?.type === 'project');
}

export async function runConfig(c = activeConfig()): Promise<void> {
  if (!c) {
    toast('warning', 'Nothing to run', 'Open a project with an executable (console, web, worker) first.');
    return;
  }
  const list = members(c);
  if (list.length === 0) toast('warning', `${c.name} has nothing to run`, 'Add configurations to the compound in Edit Configurations.');
  for (const m of list) await dotnetRun(m.project, { title: m.name, ...(await launchOf(m)), hotReload: m.hotReload });
}

/** Debugs the configuration; a compound debugs its first member and runs the others (one debug session at a time). */
export async function debugConfig(c = activeConfig()): Promise<void> {
  if (!c) return startDebugging();
  const [first, ...rest] = members(c);
  if (!first) {
    toast('warning', `${c.name} has nothing to debug`);
    return;
  }
  for (const m of rest) await dotnetRun(m.project, { title: m.name, ...(await launchOf(m)), hotReload: m.hotReload });
  await startDebugging(first.project, { launch: await launchOf(first) });
}

/** Reruns the configuration whose Run tab has this title (the Run window's Rerun button). */
export function rerunByTitle(title: string, cwd: string): Promise<unknown> {
  const c = allConfigs().find((x) => x.type === 'project' && x.name === title);
  if (c) return runConfig(c);
  return dotnetRun(useWorkspace.getState().ws.projects.find((p) => samePath(p.path.replace(/[\\/][^\\/]+$/, ''), cwd))?.path);
}

const profileCache = new Map<string, Promise<LaunchProfile[]>>();

/** The launch profiles of a project (cached; the dialog refreshes them when it opens). */
export function launchProfiles(project: string, refresh = false): Promise<LaunchProfile[]> {
  if (refresh || !profileCache.has(project)) profileCache.set(project, api.get<LaunchProfile[]>(`/run/profiles?project=${encodeURIComponent(project)}`).catch(() => []));
  return profileCache.get(project)!;
}

// a new workspace brings its own configurations (and the one already open, when this module loads late)
let lastRoot = useWorkspace.getState().ws.root;
useRunConfigs.getState().load(lastRoot);
useWorkspace.subscribe((s) => {
  if (s.ws.root === lastRoot) return;
  lastRoot = s.ws.root;
  useRunConfigs.getState().load(s.ws.root);
});
