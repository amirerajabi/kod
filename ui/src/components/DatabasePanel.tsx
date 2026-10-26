import { ChevronDown, ChevronRight, Columns3, Database, Eye, FileCode2, FileInput, KeyRound, LoaderCircle, Plus, RotateCw, Table2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { copyText } from '../app/actions';
import { DB_KINDS, deleteSource, importFromAppSettings, loadSchema, openConsole, saveSource, selectTop, testConnection, useDb, connectionOf, type DataSource, type DbKind } from '../store/database';
import { platform } from '../platform';
import { errorText } from '../api/client';
import { Dialog } from './common/Dialog';
import { showContextMenu } from './common/Menu';

/** Rider's Database window: data sources, their schemas, tables, views and columns; consoles open from here. */
export function DatabasePanel() {
  const sources = useDb((s) => s.sources);
  const schemas = useDb((s) => s.schemas);
  const editing = useDb((s) => s.editing);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string, load?: () => void) => {
    const now = !open[k];
    setOpen({ ...open, [k]: now });
    if (now) load?.();
  };

  const row = (key: string, depth: number, icon: ReactNode, label: ReactNode, hint: ReactNode, opts: { expandable?: boolean; onOpen?: () => void; onDouble?: () => void; menu?: Parameters<typeof showContextMenu>[1] } = {}) => (
    <div
      key={key}
      className="tree-row"
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={() => opts.expandable && toggle(key, opts.onOpen)}
      onDoubleClick={opts.onDouble}
      onContextMenu={(e) => opts.menu && showContextMenu(e, opts.menu)}
    >
      <span className="tree-chevron">{opts.expandable ? open[key] ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</span>
      {icon}
      <span className="tree-label">{label}</span>
      {hint && <span className="tree-hint">{hint}</span>}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-header">
        <span className="panel-title">Database</span>
        <button className="icon-btn sm" title="New data source" onClick={() => useDb.setState({ editing: { id: `ds${Date.now()}`, name: '', kind: 'sqlserver' } })}>
          <Plus size={14} />
        </button>
        <button className="icon-btn sm" title="Import from appsettings.json" onClick={() => void importFromAppSettings()}>
          <FileInput size={14} />
        </button>
        <button className="icon-btn sm" title="Refresh" onClick={() => sources.forEach((s) => open[s.id] && void loadSchema(s.id))}>
          <RotateCw size={14} />
        </button>
      </div>
      <div className="panel-body tree">
        {sources.length === 0 && (
          <div className="panel-empty">
            <Database size={18} />
            <div style={{ margin: '6px 0 10px' }}>No data sources yet.</div>
            <button className="btn btn-xs btn-primary" onClick={() => useDb.setState({ editing: { id: `ds${Date.now()}`, name: '', kind: 'sqlserver' } })}>
              New Data Source…
            </button>
            <button className="btn btn-xs" style={{ marginTop: 6 }} onClick={() => void importFromAppSettings()}>
              Import from appsettings.json
            </button>
          </div>
        )}
        {sources.map((s) => {
          const sc = schemas[s.id];
          const menu = [
            { label: 'New Query Console', icon: <FileCode2 size={14} />, run: () => openConsole(s.id) },
            { label: 'Refresh', run: () => void loadSchema(s.id) },
            { label: 'Use for SQL in C# Code', checked: !!s.forCode, run: () => useDb.getState().sources.forEach((x) => void saveSource({ ...x, forCode: x.id === s.id }, undefined)) },
            'separator' as const,
            { label: 'Properties…', run: () => useDb.setState({ editing: s }) },
            { label: 'Remove', danger: true, run: () => void deleteSource(s) },
          ];
          return (
            <div key={s.id}>
              {row(s.id, 0, <Database size={14} className="db-kind" />, s.name, `${DB_KINDS.find((k) => k.id === s.kind)?.label}${s.forCode ? ' · code' : ''}`, {
                expandable: true,
                onOpen: () => sc === undefined && void loadSchema(s.id),
                onDouble: () => openConsole(s.id),
                menu,
              })}
              {open[s.id] && sc === 'loading' && row(`${s.id}/l`, 1, <LoaderCircle size={14} className="spin" />, 'Loading…', null)}
              {open[s.id] && sc && typeof sc === 'object' && 'error' in sc && (
                <div className="tree-row sev-error" style={{ paddingLeft: 34, whiteSpace: 'normal', height: 'auto' }} title={sc.error}>
                  {sc.error}
                </div>
              )}
              {open[s.id] &&
                Array.isArray(sc) &&
                sc.map((schema) => {
                  const sk = `${s.id}/${schema.name}`;
                  return (
                    <div key={sk}>
                      {row(sk, 1, <Columns3 size={14} className="muted" />, schema.name, `${schema.tables.length}`, { expandable: true })}
                      {open[sk] &&
                        schema.tables.map((t) => {
                          const tk = `${sk}/${t.name}`;
                          return (
                            <div key={tk}>
                              {row(tk, 2, t.kind === 'view' ? <Eye size={14} style={{ color: 'var(--syn-interface)' }} /> : <Table2 size={14} style={{ color: 'var(--syn-class)' }} />, t.name, t.kind === 'view' ? 'view' : null, {
                                expandable: true,
                                onDouble: () => openConsole(s.id, selectTop(s, schema.name, t.name), true),
                                menu: [
                                  { label: 'Select Top 100 Rows', run: () => openConsole(s.id, selectTop(s, schema.name, t.name), true) },
                                  { label: 'New Query Console', run: () => openConsole(s.id, `SELECT *\nFROM ${t.name}\n`) },
                                  { label: 'Copy Name', run: () => void copyText(t.name, 'Name') },
                                ],
                              })}
                              {open[tk] &&
                                t.columns.map((c) =>
                                  row(`${tk}/${c.name}`, 3, c.primaryKey ? <KeyRound size={13} style={{ color: 'var(--warning)' }} /> : <span className="db-col-dot" />, c.name, `${c.type}${c.nullable ? '' : ' not null'}`),
                                )}
                            </div>
                          );
                        })}
                      {open[sk] && schema.routines.length > 0 && row(`${sk}/routines`, 2, <FileCode2 size={14} className="muted" />, `${schema.routines.length} routines`, schema.routines.slice(0, 3).join(', '))}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      {editing && <DataSourceDialog source={editing} />}
    </div>
  );
}

/** New / edit data source: driver, host / port / database / user / password, a connection string, or a SQLite file. */
function DataSourceDialog({ source }: { source: DataSource }) {
  const isNew = !useDb.getState().sources.some((s) => s.id === source.id);
  const [s, setS] = useState<DataSource>(source);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useDb.setState({ editing: null });
  const up = (p: Partial<DataSource>) => setS({ ...s, ...p });
  const kind = DB_KINDS.find((k) => k.id === s.kind)!;
  const valid = s.name.trim() && (s.useConnectionString ? isNew ? !!secret : true : s.kind === 'sqlite' ? !!s.file : true);

  const test = async () => {
    setBusy(true);
    setStatus(null);
    try {
      // a typed password wins; otherwise the stored one
      const conn = (await connectionOf(s)) as Record<string, unknown>;
      if (secret !== undefined) {
        if (s.useConnectionString) conn.connectionString = secret;
        else conn.password = secret;
      }
      setStatus({ ok: true, text: await testConnection(conn) });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={isNew ? 'New data source' : `Data source: ${source.name}`}
      onClose={close}
      width={520}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} disabled={busy} onClick={() => void test()}>
            {busy ? <LoaderCircle size={14} className="spin" /> : null} Test Connection
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => {
              void saveSource({ ...s, name: s.name.trim() }, secret);
              close();
            }}
          >
            {isNew ? 'Add' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="ds-name">Name</label>
        <input id="ds-name" className="input" value={s.name} onChange={(e) => up({ name: e.target.value })} placeholder="My database" autoFocus />
        <label htmlFor="ds-kind">Driver</label>
        <select id="ds-kind" className="input" value={s.kind} onChange={(e) => up({ kind: e.target.value as DbKind, port: undefined })}>
          {DB_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <span />
        <label className="check">
          <input type="checkbox" checked={!!s.useConnectionString} onChange={(e) => up({ useConnectionString: e.target.checked })} /> Use a connection string
        </label>
        {s.useConnectionString ? (
          <>
            <label htmlFor="ds-cs">Connection string</label>
            <textarea id="ds-cs" className="input" rows={3} value={secret ?? ''} placeholder={isNew ? 'Server=…;Database=…;' : 'Stored securely: type to replace it'} onChange={(e) => setSecret(e.target.value)} spellCheck={false} />
          </>
        ) : s.kind === 'sqlite' ? (
          <>
            <label htmlFor="ds-file">File</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input id="ds-file" className="input" value={s.file ?? ''} onChange={(e) => up({ file: e.target.value })} placeholder="C:\data\app.db" spellCheck={false} />
              <button
                className="btn"
                onClick={async () => {
                  const f = await platform.pickFile('SQLite database', [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }]);
                  if (f) up({ file: f, name: s.name || f.split(/[\\/]/).pop()! });
                }}
              >
                …
              </button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="ds-host">Host</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input id="ds-host" className="input" value={s.host ?? ''} onChange={(e) => up({ host: e.target.value })} placeholder="localhost" spellCheck={false} />
              <input className="input" style={{ width: 90 }} value={s.port ?? ''} onChange={(e) => up({ port: Number(e.target.value) || undefined })} placeholder={String(kind.port ?? '')} aria-label="Port" />
            </div>
            <label htmlFor="ds-db">Database</label>
            <input id="ds-db" className="input" value={s.database ?? ''} onChange={(e) => up({ database: e.target.value })} spellCheck={false} />
            <label htmlFor="ds-user">User</label>
            <input id="ds-user" className="input" value={s.user ?? ''} onChange={(e) => up({ user: e.target.value })} placeholder={s.kind === 'sqlserver' ? 'empty = Windows authentication' : ''} spellCheck={false} autoComplete="off" />
            <label htmlFor="ds-pw">Password</label>
            <input id="ds-pw" className="input" type="password" value={secret ?? ''} placeholder={isNew ? '' : 'Stored securely: type to replace it'} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
            <label htmlFor="ds-opt">Options</label>
            <input id="ds-opt" className="input" value={s.options ?? ''} onChange={(e) => up({ options: e.target.value })} placeholder="Encrypt=false;Command Timeout=60" spellCheck={false} />
          </>
        )}
      </div>
      {status && <div className={status.ok ? 'form-ok' : 'form-error'}>{status.text}</div>}
      <div className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>
        Passwords and connection strings are kept by your operating system's keychain, not in Kod's settings.
      </div>
    </Dialog>
  );
}

/** The bar above a SQL console: its data source, Run (Ctrl+Enter: the selection or the statement at the caret), Run All. */
export function SqlConsoleBar({ path, run }: { path: string; run: (all: boolean) => void }) {
  const source = useDb((s) => s.sources.find((x) => x.id === path.split(':')[1]));
  const running = useDb((s) => s.runs[path]?.running);
  return (
    <div className="breadcrumbs sql-bar">
      <Database size={13} />
      <span>{source?.name ?? 'Unknown data source'}</span>
      <span className="muted">{DB_KINDS.find((k) => k.id === source?.kind)?.label}</span>
      <div className="flex-1" />
      <button className="btn btn-xs btn-primary" disabled={running} onClick={() => run(false)} title="Run the selection, or the statement at the caret (Ctrl+Enter)">
        ▶ Run
      </button>
      <button className="btn btn-xs" disabled={running} onClick={() => run(true)} title="Run the whole console (Ctrl+Shift+Enter)">
        Run All
      </button>
    </div>
  );
}
