// EF Core tool window (Rider's Entity Framework Core UI): choose the migrations project, the startup project and the
// DbContext; the migrations with whether the database has them; add / remove migrations, update or drop the
// database, generate the SQL script, and scaffold a DbContext from a Database panel data source.
import { ArrowUpToLine, CircleCheck, CircleDashed, CircleHelp, Database, Download, FileCode, LoaderCircle, Minus, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDb } from '../store/database';
import {
  addDesignPackage,
  addMigration,
  dropDatabase,
  installEfTool,
  loadEfProjects,
  openMigration,
  refreshEf,
  removeLastMigration,
  scaffold,
  scriptMigrations,
  selectEf,
  updateDatabase,
  useEf,
  type EfMigration,
} from '../store/ef';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';
import { showContextMenu, type MenuItem } from './common/Menu';
import './ef.css';

function ScaffoldDialog({ onClose }: { onClose: () => void }) {
  const sources = useDb((s) => s.sources);
  const [sourceId, setSourceId] = useState(sources.find((s) => s.forCode)?.id ?? sources[0]?.id ?? '');
  const [context, setContext] = useState('AppDbContext');
  const [outputDir, setOutputDir] = useState('Entities');
  const [contextDir, setContextDir] = useState('Data');
  const [tables, setTables] = useState('');
  const [annotations, setAnnotations] = useState(false);
  const [force, setForce] = useState(false);
  const source = sources.find((s) => s.id === sourceId);
  const valid = !!source && /^[A-Za-z_]\w*$/.test(context.trim()) && outputDir.trim() !== '';
  return (
    <Dialog
      title="Scaffold DbContext from a database"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => {
              onClose();
              void scaffold({ source: source!, context: context.trim(), outputDir: outputDir.trim(), contextDir: contextDir.trim() || outputDir.trim(), dataAnnotations: annotations, tables: tables.split(/[\s,;]+/).filter(Boolean), force });
            }}
          >
            Scaffold
          </button>
        </>
      }
    >
      {sources.length === 0 ? (
        <div className="muted">Add a data source in the Database panel (Alt+Shift+D) first; Kod scaffolds from its connection.</div>
      ) : (
        <div className="form-grid">
          <label htmlFor="sc-src">Database</label>
          <select id="sc-src" className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.kind})
              </option>
            ))}
          </select>
          <label htmlFor="sc-ctx">DbContext name</label>
          <input id="sc-ctx" className="input" value={context} onChange={(e) => setContext(e.target.value)} spellCheck={false} />
          <label htmlFor="sc-out">Entities folder</label>
          <input id="sc-out" className="input" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} spellCheck={false} />
          <label htmlFor="sc-cdir">DbContext folder</label>
          <input id="sc-cdir" className="input" value={contextDir} onChange={(e) => setContextDir(e.target.value)} spellCheck={false} />
          <label htmlFor="sc-tables">Tables</label>
          <input id="sc-tables" className="input" value={tables} onChange={(e) => setTables(e.target.value)} placeholder="All tables (or: dbo.Orders, Customers)" spellCheck={false} />
          <span />
          <label className="check">
            <input type="checkbox" checked={annotations} onChange={(e) => setAnnotations(e.target.checked)} /> Data annotations instead of the fluent API
          </label>
          <span />
          <label className="check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Overwrite existing files
          </label>
        </div>
      )}
      <div className="muted ef-note">The provider package for this database must be referenced by the project. The connection string is not written into the generated code.</div>
    </Dialog>
  );
}

function Status({ m }: { m: EfMigration }) {
  if (m.applied === true) return <CircleCheck size={14} className="ef-applied" aria-label="Applied" />;
  if (m.applied === false) return <CircleDashed size={14} className="muted" aria-label="Pending" />;
  return <CircleHelp size={14} className="muted" aria-label="Unknown (database not reachable)" />;
}

export function EfPanel() {
  const st = useEf();
  const wsProjects = useWorkspace((s) => s.ws.projects);
  const root = useWorkspace((s) => s.ws.root);
  const ready = useWorkspace((s) => s.ws.state === 'ready');
  const [scaffolding, setScaffolding] = useState(false);

  useEffect(() => {
    if (ready) void loadEfProjects();
  }, [ready, root]);

  if (!root) return <div className="panel-empty">Open a solution that uses Entity Framework Core.</div>;
  if (ready && st.projects.length === 0)
    return (
      <div className="panel-empty">
        No project references Entity Framework Core. Add <code>Microsoft.EntityFrameworkCore</code> and a provider (NuGet window) to a project.
      </div>
    );

  const busy = st.loading || !!st.busy;
  const applied = st.migrations.filter((m) => m.applied).length;
  const menu = (m: EfMigration, i: number): MenuItem[] => [
    { label: 'Open', icon: <FileCode size={14} />, run: () => void openMigration(m) },
    'separator',
    { label: 'Update Database to Here', icon: <ArrowUpToLine size={14} />, run: () => void updateDatabase(m.name) },
    { label: 'Generate SQL Script up to Here', run: () => void scriptMigrations(undefined, m.name) },
    ...(i > 0 ? [{ label: 'Generate SQL Script of This Migration', run: () => void scriptMigrations(st.migrations[i - 1].name, m.name) } as MenuItem] : []),
    ...(i === st.migrations.length - 1 ? ['separator' as const, { label: 'Remove This Migration', icon: <Minus size={14} />, danger: true, run: () => void removeLastMigration() } as MenuItem] : []),
  ];

  return (
    <div className="ef-panel">
      <div className="ef-toolbar">
        <label className="ef-field" title="The project that holds the DbContext and the migrations">
          <span className="muted">Migrations</span>
          <select className="input sm" value={st.project ?? ''} onChange={(e) => selectEf({ project: e.target.value })}>
            {st.projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
                {p.provider ? ` (${p.provider})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="ef-field" title="The project that is run to create the DbContext (its configuration and connection string)">
          <span className="muted">Startup</span>
          <select className="input sm" value={st.startup ?? ''} onChange={(e) => selectEf({ startup: e.target.value })}>
            {wsProjects
              .filter((p) => !p.unloaded && (p.runnable || p.path === st.project))
              .map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        {st.contexts.length > 1 && (
          <label className="ef-field">
            <span className="muted">DbContext</span>
            <select className="input sm" value={st.context ?? ''} onChange={(e) => selectEf({ context: e.target.value })}>
              {st.contexts.map((c) => (
                <option key={c} value={c}>
                  {c.split('.').pop()}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex-1" />
        <button className="icon-btn sm" title="Refresh (builds the project)" disabled={busy} onClick={() => void refreshEf()}>
          {st.loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
        <button className="icon-btn sm" title="Add Migration…" disabled={busy || !st.contexts.length} onClick={() => void addMigration()}>
          <Plus size={15} />
        </button>
        <button className="icon-btn sm" title="Update Database (apply every migration)" disabled={busy || !st.contexts.length} onClick={() => void updateDatabase()}>
          <ArrowUpToLine size={15} />
        </button>
        <button className="icon-btn sm" title="Remove Last Migration" disabled={busy || !st.migrations.length} onClick={() => void removeLastMigration()}>
          <Minus size={15} />
        </button>
        <button className="icon-btn sm" title="Generate SQL Script (every migration; idempotent where the provider supports it)" disabled={busy || !st.migrations.length} onClick={() => void scriptMigrations()}>
          <FileCode size={15} />
        </button>
        <button className="icon-btn sm" title="Scaffold DbContext from a Database…" disabled={busy} onClick={() => setScaffolding(true)}>
          <Wand2 size={15} />
        </button>
        <button className="icon-btn sm" title="Drop Database…" disabled={busy || !st.contexts.length} onClick={() => void dropDatabase()}>
          <Trash2 size={15} />
        </button>
      </div>

      {st.toolMissing && (
        <div className="ef-banner">
          <span>The EF Core command-line tool (dotnet-ef) is not installed.</span>
          <button className="btn btn-xs btn-primary" onClick={() => void installEfTool()}>
            <Download size={13} /> Install dotnet-ef
          </button>
        </div>
      )}
      {st.designMissing && (
        <div className="ef-banner">
          <span>The startup project needs the Microsoft.EntityFrameworkCore.Design package.</span>
          <button className="btn btn-xs btn-primary" onClick={() => void addDesignPackage()}>
            <Plus size={13} /> Add it
          </button>
        </div>
      )}
      {st.error && !st.toolMissing && !st.designMissing && <div className="ef-banner error">{st.error}</div>}
      {st.offline && !st.error && <div className="ef-banner">The database could not be reached: which migrations are applied is unknown.</div>}

      <div className="ef-list">
        {st.loading && !st.migrations.length ? (
          <div className="panel-empty">
            <LoaderCircle size={16} className="spin" /> Building and reading the migrations…
          </div>
        ) : st.migrations.length === 0 && st.contexts.length ? (
          <div className="panel-empty">No migrations yet. Click + to add the first one.</div>
        ) : st.migrations.length === 0 && !st.error && !st.toolMissing ? (
          <div className="panel-empty">
            <button className="btn" onClick={() => void refreshEf()}>
              <Database size={14} /> Load DbContexts and migrations
            </button>
          </div>
        ) : (
          st.migrations.map((m, i) => (
            <div
              key={m.id}
              className="ef-row"
              role="button"
              tabIndex={0}
              onDoubleClick={() => void openMigration(m)}
              onKeyDown={(e) => e.key === 'Enter' && void openMigration(m)}
              onContextMenu={(e) => showContextMenu(e, menu(m, i))}
              title={m.applied === true ? 'Applied to the database' : m.applied === false ? 'Not applied yet' : 'The database could not be reached'}
            >
              <Status m={m} />
              <span className="ef-name">{m.name}</span>
              <span className="muted ef-id">{m.id.slice(0, 14).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3 $4:$5')}</span>
            </div>
          ))
        )}
      </div>
      {st.migrations.length > 0 && (
        <div className="ef-footer muted">
          {st.busy ? (
            <>
              <LoaderCircle size={12} className="spin" /> {st.busy}…
            </>
          ) : (
            `${st.migrations.length} migration${st.migrations.length === 1 ? '' : 's'}${st.offline ? '' : `, ${applied} applied`} · right-click a migration to update the database to it or script it`
          )}
        </div>
      )}
      {scaffolding && <ScaffoldDialog onClose={() => setScaffolding(false)} />}
    </div>
  );
}
