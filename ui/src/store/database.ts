// Database tools (Rider's Database window / DataGrip): data sources, their schema, SQL consoles and query results.
// Data sources are kept per workspace; passwords and full connection strings go to the OS keychain (secrets).
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { ensureConsoleModel } from '../editor/models';
import { norm } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { platform } from '../platform';
import { useEditors } from './editors';
import { askConfirm, toast, useUi } from './ui';
import { useWorkspace } from './workspace';

export type DbKind = 'sqlserver' | 'postgres' | 'mysql' | 'sqlite';

export const DB_KINDS: { id: DbKind; label: string; port?: number }[] = [
  { id: 'sqlserver', label: 'SQL Server', port: 1433 },
  { id: 'postgres', label: 'PostgreSQL', port: 5432 },
  { id: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { id: 'sqlite', label: 'SQLite' },
];

export interface DataSource {
  id: string;
  name: string;
  kind: DbKind;
  /** Fields mode; a connection string (kept as a secret) replaces them when useConnectionString is set. */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  file?: string;
  options?: string;
  useConnectionString?: boolean;
  /** The data source SQL in C# strings completes against. */
  forCode?: boolean;
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface DbTable {
  name: string;
  kind: 'table' | 'view';
  columns: DbColumn[];
}

export interface DbSchema {
  name: string;
  tables: DbTable[];
  routines: string[];
}

export interface DbResult {
  columns: string[];
  types: string[];
  rows: (string | null)[][];
  truncated: boolean;
}

export interface QueryRun {
  console: string;
  sql: string;
  running: boolean;
  results: DbResult[];
  elapsedMs?: number;
  messages: string[];
  error?: string;
  errorLine?: number;
  at: number;
}

interface DbState {
  sources: DataSource[];
  schemas: Record<string, DbSchema[] | 'loading' | { error: string }>;
  /** The last run of each console. */
  runs: Record<string, QueryRun>;
  /** The console whose results the Database tool window shows. */
  shownRun: string | null;
  editing: DataSource | null;
}

export const useDb = create<DbState>(() => ({ sources: [], schemas: {}, runs: {}, shownRun: null, editing: null }));

const KEY = 'dataSources';
let root: string | undefined;
useWorkspace.subscribe((s) => {
  if (s.ws.root === root) return;
  root = s.ws.root;
  useDb.setState({ sources: root ? (loadRaw<Record<string, DataSource[]>>(KEY, {})[norm(root)] ?? []) : [], schemas: {} });
});

function persist(): void {
  if (!root) return;
  const all = loadRaw<Record<string, DataSource[]>>(KEY, {});
  all[norm(root)] = useDb.getState().sources;
  save(KEY, all);
}

const secretName = (id: string) => `db.${id}`;

/** What the engine needs to connect: the stored fields plus the secret (password, or the whole connection string). */
export async function connectionOf(s: DataSource): Promise<object> {
  const secret = (await platform.getSecret(secretName(s.id)).catch(() => null)) ?? undefined;
  return s.useConnectionString
    ? { kind: s.kind, connectionString: secret }
    : { kind: s.kind, host: s.host, port: s.port, database: s.database, user: s.user, password: secret, file: s.file, options: s.options };
}

export async function saveSource(s: DataSource, secret: string | null | undefined): Promise<void> {
  const list = useDb.getState().sources;
  useDb.setState({ sources: list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s] });
  persist();
  if (secret !== undefined) await platform.setSecret(secretName(s.id), secret || null);
  void loadSchema(s.id);
}

export async function deleteSource(s: DataSource): Promise<void> {
  if ((await askConfirm({ title: 'Remove data source', message: `Remove "${s.name}" from Kod? The database itself is not touched.`, okLabel: 'Remove', danger: true })) !== 'ok') return;
  useDb.setState({ sources: useDb.getState().sources.filter((x) => x.id !== s.id) });
  persist();
  await platform.setSecret(secretName(s.id), null).catch(() => undefined);
}

export const sourceById = (id: string) => useDb.getState().sources.find((s) => s.id === id);

export async function loadSchema(id: string): Promise<void> {
  const s = sourceById(id);
  if (!s) return;
  useDb.setState((st) => ({ schemas: { ...st.schemas, [id]: 'loading' } }));
  try {
    const schema = await api.post<DbSchema[]>('/db/schema', await connectionOf(s));
    useDb.setState((st) => ({ schemas: { ...st.schemas, [id]: schema } }));
  } catch (e) {
    useDb.setState((st) => ({ schemas: { ...st.schemas, [id]: { error: errorText(e) } } }));
  }
}

export async function testConnection(conn: object): Promise<string> {
  const r = await api.post<{ serverVersion: string; database: string; elapsedMs: number }>('/db/test', conn);
  return `Connected: ${r.serverVersion}${r.database ? ` · ${r.database}` : ''} (${r.elapsedMs} ms)`;
}

/** Data sources from the workspace's appsettings*.json ConnectionStrings. */
export async function importFromAppSettings(): Promise<void> {
  try {
    const found = await api.get<{ name: string; kind: DbKind; connectionString: string; file: string }[]>('/db/discover');
    const existing = new Set(useDb.getState().sources.map((s) => s.name));
    const fresh = found.filter((f) => !existing.has(f.name));
    if (fresh.length === 0) {
      toast('info', found.length ? 'Those data sources are already here' : 'No connection strings found', found.length ? undefined : 'Kod looks for a ConnectionStrings section in appsettings*.json.');
      return;
    }
    for (const f of fresh) await saveSource({ id: `ds${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: f.name, kind: f.kind, useConnectionString: true }, f.connectionString);
    toast('success', `Imported ${fresh.length} data source${fresh.length === 1 ? '' : 's'}`, fresh.map((f) => f.name).join(', '));
  } catch (e) {
    toast('error', 'Import failed', errorText(e));
  }
}

// ---------------------------------------------------------------- consoles

let consoleSeq = 0;

/** Opens a SQL console for a data source (a tab with its own editor), optionally with a query to run. */
export function openConsole(sourceId: string, sql = '', run = false): string {
  const s = sourceById(sourceId);
  if (!s) return '';
  const path = `kod-sql:${sourceId}:${++consoleSeq}`;
  ensureConsoleModel(path, sql);
  useEditors.setState((st) => ({ tabs: [...st.tabs, { path, title: `${s.name} (console${consoleSeq > 1 ? ` ${consoleSeq}` : ''})`, kind: 'sql', preview: false, dirty: false, readOnly: false }], active: path }));
  if (run) void runQuery(path, sql);
  return path;
}

export const consoleSource = (consolePath: string) => sourceById(consolePath.split(':')[1] ?? '');

let runSeq = 0;

export async function runQuery(consolePath: string, sql: string): Promise<void> {
  const s = consoleSource(consolePath);
  if (!s || !sql.trim()) return;
  const queryId = `q${++runSeq}`;
  const run: QueryRun = { console: consolePath, sql, running: true, results: [], messages: [], at: Date.now() };
  useDb.setState((st) => ({ runs: { ...st.runs, [consolePath]: run }, shownRun: consolePath }));
  current.set(consolePath, queryId);
  useUi.getState().showBottom('database');
  try {
    const r = await api.post<{ results: DbResult[]; elapsedMs: number; messages: string[]; error?: string; errorLine?: number }>('/db/query', { connection: await connectionOf(s), sql, queryId, maxRows: 1000 });
    useDb.setState((st) => ({ runs: { ...st.runs, [consolePath]: { ...run, running: false, ...r } } }));
  } catch (e) {
    useDb.setState((st) => ({ runs: { ...st.runs, [consolePath]: { ...run, running: false, error: errorText(e) } } }));
  } finally {
    current.delete(consolePath);
  }
}

const current = new Map<string, string>();

export function cancelQuery(consolePath: string): void {
  const id = current.get(consolePath);
  if (id) void api.post('/db/cancel', { id }).catch(() => undefined);
}

/** SELECT the first rows of a table, quoted for the database. */
export function selectTop(s: DataSource, schema: string, table: string, n = 100): string {
  const q = (x: string) => (s.kind === 'sqlserver' ? `[${x}]` : s.kind === 'mysql' ? `\`${x}\`` : `"${x}"`);
  const name = s.kind === 'sqlite' ? q(table) : `${q(schema)}.${q(table)}`;
  return s.kind === 'sqlserver' ? `SELECT TOP ${n} * FROM ${name};` : `SELECT * FROM ${name} LIMIT ${n};`;
}
