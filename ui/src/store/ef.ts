// EF Core tool window: the projects that use EF Core, their DbContexts and migrations (applied or not), and the
// dotnet ef commands (add / remove migration, update or drop the database, SQL script, scaffold from a database).
// Every command runs as a process, its output in the Build window.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { stripAnsi } from '../lib/ansi';
import { basename, dirname, isUnder, join } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { connectionOf, type DataSource } from './database';
import { useEditors } from './editors';
import { runAndWait, useProcs } from './procs';
import { useSettings } from './settings';
import { askConfirm, askText, toast, useUi } from './ui';
import { startupProject, useWorkspace } from './workspace';

export interface EfProject {
  name: string;
  path: string;
  hasDesign: boolean;
  provider?: string;
  runnable: boolean;
  version?: string;
}

export interface EfMigration {
  id: string;
  name: string;
  /** null: the database could not be reached, so whether it is applied is unknown. */
  applied: boolean | null;
}

interface EfState {
  projects: EfProject[];
  project: string | null;
  startup: string | null;
  contexts: string[];
  context: string | null;
  migrations: EfMigration[];
  loading: boolean;
  busy: string | null;
  /** dotnet-ef is not installed. */
  toolMissing: boolean;
  /** The startup project lacks Microsoft.EntityFrameworkCore.Design. */
  designMissing: boolean;
  error: string | null;
  /** The database was not reachable when listing. */
  offline: boolean;
}

const saved = loadRaw<Record<string, { project?: string; startup?: string; context?: string }>>('ef', {});

export const useEf = create<EfState>(() => ({
  projects: [],
  project: null,
  startup: null,
  contexts: [],
  context: null,
  migrations: [],
  loading: false,
  busy: null,
  toolMissing: false,
  designMissing: false,
  error: null,
  offline: false,
}));

function remember(): void {
  const root = useWorkspace.getState().ws.root;
  if (!root) return;
  const { project, startup, context } = useEf.getState();
  saved[root] = { project: project ?? undefined, startup: startup ?? undefined, context: context ?? undefined };
  save('ef', saved);
}

export function selectEf(p: Partial<Pick<EfState, 'project' | 'startup' | 'context'>>): void {
  useEf.setState({ ...p, ...(p.project !== undefined || p.startup !== undefined ? { contexts: [], context: null } : {}) });
  remember();
  void refreshEf(p.context === undefined);
}

interface EfResult {
  ok: boolean;
  text: string;
}

/** Runs dotnet ef with the selected project, startup project and context. */
async function ef(title: string, args: string[], withContext = true): Promise<EfResult> {
  const { project, startup, context } = useEf.getState();
  if (!project) return { ok: false, text: '' };
  const full = ['ef', ...args, '--project', project, '--startup-project', startup ?? project];
  if (withContext && context) full.push('--context', context);
  if (useSettings.getState().settings.saveBeforeBuild) await useEditors.getState().saveAll();
  const info = await runAndWait({ kind: 'ef', title, file: 'dotnet', args: full, cwd: dirname(project) });
  const text = stripAnsi(info ? (useProcs.getState().procs[info.id]?.text ?? '') : '');
  const ok = info?.exitCode === 0;
  if (!ok) {
    const toolMissing = /could not execute because the specified command or file was not found|dotnet-ef does not exist|No executable found matching command "dotnet-ef"/i.test(text);
    const designMissing = /doesn't reference Microsoft\.EntityFrameworkCore\.Design/i.test(text);
    useEf.setState({ toolMissing, designMissing });
  }
  return { ok, text };
}

/** The JSON that dotnet ef --json --prefix-output prints on its "data:" lines. */
function data<T>(text: string): T | null {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ {0,4}/, ''));
  if (!lines.length) return null;
  try {
    return JSON.parse(lines.join('\n')) as T;
  } catch {
    return null;
  }
}

/** The error dotnet ef reported (its "error:" lines), else the last lines. */
function errorOf(text: string): string {
  const errs = text.split(/\r?\n/).filter((l) => l.startsWith('error:')).map((l) => l.slice(6).trim());
  return (errs.length ? errs : text.trim().split(/\r?\n/).slice(-4)).join('\n').slice(0, 600);
}

export async function loadEfProjects(): Promise<void> {
  try {
    const projects = await api.get<EfProject[]>('/ef/projects');
    const root = useWorkspace.getState().ws.root;
    const mem = root ? saved[root] : undefined;
    const st = useEf.getState();
    const has = (p?: string | null) => !!p && projects.some((x) => x.path === p);
    const project = has(st.project) ? st.project : has(mem?.project) ? mem!.project! : (projects[0]?.path ?? null);
    const runnable = useWorkspace.getState().ws.projects.filter((p) => p.runnable && !p.unloaded);
    const startup =
      st.startup && runnable.some((p) => p.path === st.startup) ? st.startup
      : mem?.startup && runnable.some((p) => p.path === mem.startup) ? mem.startup
      : projects.find((p) => p.path === project)?.runnable ? project : (startupProject()?.path ?? project);
    useEf.setState({ projects, project, startup, context: st.context ?? mem?.context ?? null });
  } catch (e) {
    useEf.setState({ error: errorText(e) });
  }
}

/** Lists the contexts (once per project) and the migrations, with what the database has applied. */
export async function refreshEf(withContexts = true): Promise<void> {
  if (useEf.getState().loading) return;
  if (!useEf.getState().projects.length) await loadEfProjects();
  if (!useEf.getState().project) return;
  useEf.setState({ loading: true, error: null, toolMissing: false, designMissing: false });
  try {
    const listContexts = withContexts || !useEf.getState().contexts.length;
    if (listContexts) {
      const r = await ef('EF: list DbContexts', ['dbcontext', 'list', '--json', '--prefix-output'], false);
      if (!r.ok) {
        useEf.setState({ error: errorOf(r.text), migrations: [] });
        return;
      }
      const list = (data<{ fullName: string; safeName: string; name: string }[]>(r.text) ?? []).map((c) => c.fullName);
      const current = useEf.getState().context;
      useEf.setState({ contexts: list, context: current && list.includes(current) ? current : (list[0] ?? null) });
      remember();
    }
    // right after listing the contexts the build is fresh; otherwise (a migration was just added) build again
    const r = await ef('EF: list migrations', ['migrations', 'list', '--json', '--prefix-output', ...(listContexts ? ['--no-build'] : [])]);
    if (!r.ok) {
      useEf.setState({ error: errorOf(r.text), migrations: [] });
      return;
    }
    const migrations = (data<{ id: string; name: string; applied?: boolean | null }[]>(r.text) ?? []).map((m) => ({ id: m.id, name: m.name, applied: m.applied ?? null }));
    useEf.setState({ migrations, offline: migrations.some((m) => m.applied === null) || /error occurred while accessing the database|unable to connect|could not connect|network-related/i.test(r.text) });
  } finally {
    useEf.setState({ loading: false });
  }
}

async function command(label: string, args: string[], done: string): Promise<boolean> {
  useEf.setState({ busy: label });
  try {
    const r = await ef(`EF: ${label}`, args);
    if (r.ok) toast('success', done, undefined, 4000);
    else toast('error', `${label} failed`, errorOf(r.text), 10000);
    return r.ok;
  } finally {
    useEf.setState({ busy: null });
  }
}

/** Opens a migration's file (Migrations/20240101120000_Name.cs). */
export async function openMigration(m: EfMigration): Promise<void> {
  const project = useEf.getState().project;
  if (!project) return;
  const files = await useWorkspace.getState().loadFiles();
  const file = files.find((f) => isUnder(f, dirname(project)) && basename(f) === `${m.id}.cs`);
  if (file) await useEditors.getState().open(file);
  else toast('info', `${m.id}.cs is not in the project folder`);
}

export async function addMigration(): Promise<void> {
  const name = await askText({
    title: 'Add Migration',
    label: 'Name',
    placeholder: 'AddCustomerEmail',
    okLabel: 'Add',
    validate: (v) => (/^[A-Za-z_]\w*$/.test(v.trim()) ? null : 'A C# identifier: letters, digits and _'),
  });
  if (!name) return;
  if (await command(`Add migration ${name.trim()}`, ['migrations', 'add', name.trim()], `Migration ${name.trim()} added`)) {
    await refreshEf(false);
    const m = useEf.getState().migrations.find((x) => x.name === name.trim());
    if (m) await openMigration(m);
  }
}

export async function removeLastMigration(): Promise<void> {
  const last = useEf.getState().migrations.at(-1);
  if (!last) return;
  const applied = last.applied === true;
  const a = await askConfirm({
    title: 'Remove Last Migration',
    message: applied ? `${last.name} is applied to the database. Remove it anyway (the database keeps its changes; update the database to the previous migration first to undo them)?` : `Remove ${last.name} and its files?`,
    okLabel: 'Remove',
    danger: true,
  });
  if (a !== 'ok') return;
  if (await command('Remove last migration', ['migrations', 'remove', ...(applied ? ['--force'] : [])], `${last.name} removed`)) await refreshEf(false);
}

/** dotnet ef database update [to] ('0' undoes every migration). */
export async function updateDatabase(target?: string): Promise<void> {
  const label = target === '0' ? 'Revert all migrations' : target ? `Update database to ${target}` : 'Update database';
  if (target) {
    const a = await askConfirm({ title: label, message: target === '0' ? 'Undo every migration in the database?' : `Apply or revert migrations so the database is at ${target}?`, okLabel: 'Update', danger: true });
    if (a !== 'ok') return;
  }
  if (await command(label, ['database', 'update', ...(target ? [target] : [])], 'The database is up to date')) await refreshEf(false);
}

export async function dropDatabase(): Promise<void> {
  const a = await askConfirm({ title: 'Drop Database', message: 'Delete the database of this DbContext, with all its data? This cannot be undone.', okLabel: 'Drop', danger: true });
  if (a !== 'ok') return;
  if (await command('Drop database', ['database', 'drop', '--force'], 'Database dropped')) await refreshEf(false);
}

/** The SQL of the migrations (from → to), opened in an editor tab. */
export async function scriptMigrations(from?: string, to?: string): Promise<void> {
  const project = useEf.getState().project;
  if (!project) return;
  const out = join(dirname(project), 'obj', 'Kod', `${from ?? 'start'}-${to ?? 'latest'}.sql`);
  // idempotent (safe to run on any database) where the provider can: SQLite cannot
  const idempotent = useEf.getState().projects.find((p) => p.path === project)?.provider !== 'SQLite';
  const args = ['migrations', 'script', ...(from ? [from] : to ? ['0'] : []), ...(to ? [to] : []), ...(idempotent ? ['--idempotent'] : []), '--output', out];
  if (await command('Generate SQL script', args, 'SQL script generated')) await useEditors.getState().open(out);
}

export async function installEfTool(): Promise<void> {
  const r = await runAndWait({ kind: 'ef', title: 'Install dotnet-ef', file: 'dotnet', args: ['tool', 'install', '--global', 'dotnet-ef'], cwd: useWorkspace.getState().ws.root ?? undefined });
  if (r?.exitCode === 0) {
    toast('success', 'dotnet-ef installed');
    useEf.setState({ toolMissing: false });
    await refreshEf();
  } else toast('error', 'Could not install dotnet-ef', 'See the Build window. If it is already installed, update it: dotnet tool update --global dotnet-ef');
}

/** Adds Microsoft.EntityFrameworkCore.Design (the EF Core version of the project) to the startup project. */
export async function addDesignPackage(): Promise<void> {
  const { startup, project, projects } = useEf.getState();
  const target = startup ?? project;
  if (!target) return;
  const version = projects.find((p) => p.path === project)?.version;
  const r = await runAndWait({ kind: 'nuget', title: 'Add Microsoft.EntityFrameworkCore.Design', file: 'dotnet', args: ['add', target, 'package', 'Microsoft.EntityFrameworkCore.Design', ...(version ? ['--version', version] : [])], cwd: dirname(target) });
  if (r?.exitCode === 0) {
    useEf.setState({ designMissing: false });
    await refreshEf();
  }
}

export interface ScaffoldOptions {
  source: DataSource;
  context: string;
  outputDir: string;
  contextDir: string;
  dataAnnotations: boolean;
  tables: string[];
  force: boolean;
}

/** dotnet ef dbcontext scaffold from a data source of the Database panel (its connection string stays hidden). */
export async function scaffold(o: ScaffoldOptions): Promise<void> {
  const { project, startup } = useEf.getState();
  if (!project) return;
  useEf.setState({ busy: 'Scaffold' });
  try {
    const info = await api.post<{ id: string }>('/ef/scaffold', {
      connection: await connectionOf(o.source),
      project,
      startup: startup ?? project,
      context: o.context,
      outputDir: o.outputDir,
      contextDir: o.contextDir,
      dataAnnotations: o.dataAnnotations,
      tables: o.tables.length ? o.tables : null,
      force: o.force,
    });
    useUi.getState().showBottom('build');
    const code = await new Promise<number | null>((resolve) => {
      const check = () => {
        const p = useProcs.getState().procs[info.id]?.info;
        if (p && p.exitCode != null) {
          off();
          resolve(p.exitCode);
        }
      };
      const off = useProcs.subscribe(check);
      check();
    });
    if (code === 0) {
      toast('success', `${o.context} scaffolded`, `Entities in ${o.outputDir}, the context in ${o.contextDir}.`);
      await refreshEf();
    } else toast('error', 'Scaffolding failed', 'See the Build window.');
  } catch (e) {
    toast('error', 'Scaffolding failed', errorText(e));
  } finally {
    useEf.setState({ busy: null });
  }
}
