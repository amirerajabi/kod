import { FolderOpen, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { openWorkspace } from '../app/actions';
import { dirname, join } from '../lib/paths';
import { platform } from '../platform';
import { runAndWait } from '../store/procs';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';

const TEMPLATES = [
  { id: 'console', name: 'Console App', desc: 'A command-line application' },
  { id: 'classlib', name: 'Class Library', desc: 'A reusable .dll' },
  { id: 'webapi', name: 'ASP.NET Core Web API', desc: 'REST API with OpenAPI' },
  { id: 'web', name: 'ASP.NET Core Empty', desc: 'Minimal web app' },
  { id: 'mvc', name: 'ASP.NET Core MVC', desc: 'Model-View-Controller web app' },
  { id: 'blazor', name: 'Blazor Web App', desc: 'Interactive web UI in C#' },
  { id: 'worker', name: 'Worker Service', desc: 'Long-running background service' },
  { id: 'grpc', name: 'gRPC Service', desc: 'ASP.NET Core gRPC server' },
  { id: 'xunit', name: 'xUnit Tests', desc: 'Unit tests with xUnit' },
  { id: 'nunit', name: 'NUnit Tests', desc: 'Unit tests with NUnit' },
  { id: 'mstest', name: 'MSTest Tests', desc: 'Unit tests with MSTest' },
  ...(platform.os === 'win32'
    ? [
        { id: 'wpf', name: 'WPF App', desc: 'Windows desktop (XAML)' },
        { id: 'winforms', name: 'Windows Forms App', desc: 'Windows desktop (forms)' },
      ]
    : []),
];

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function NewProjectDialog() {
  const open = useUi((s) => s.newProjectOpen);
  const ws = useWorkspace((s) => s.ws);
  const meta = useWorkspace((s) => s.meta);
  const recents = useWorkspace((s) => s.recents);
  const hasSolution = !!ws.target && /\.slnx?$/i.test(ws.target);
  const [template, setTemplate] = useState('console');
  const [name, setName] = useState('MyApp');
  const [location, setLocation] = useState('');
  const [framework, setFramework] = useState('net10.0');
  const [withSolution, setWithSolution] = useState(true);
  const [addToCurrent, setAddToCurrent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(null);
    setAddToCurrent(hasSolution);
    if (!location) setLocation(recents[0] ? dirname(recents[0].path) : meta?.home ? join(meta.home, 'source', 'repos') : '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const close = () => !busy && useUi.getState().set({ newProjectOpen: false });
  const valid = NAME_RE.test(name) && (addToCurrent || location.trim().length > 0);

  const step = async (title: string, args: string[], cwd: string): Promise<boolean> => {
    setBusy(title);
    const r = await runAndWait({ kind: 'new', title, file: 'dotnet', args, cwd });
    if (!r || r.exitCode !== 0) {
      setError(`${title} failed. See the Build window for the output.`);
      useUi.getState().showBottom('build');
      setBusy(null);
      return false;
    }
    return true;
  };

  const create = async () => {
    setError(null);
    const fw = ['-f', framework];
    if (addToCurrent && ws.target && ws.root) {
      const dir = join(ws.root, name);
      if (!(await step(`Create ${name}`, ['new', template, '-n', name, '-o', dir, ...fw], ws.root))) return;
      if (!(await step(`Add ${name} to the solution`, ['sln', ws.target, 'add', join(dir, `${name}.csproj`)], ws.root))) return;
      setBusy(null);
      useUi.getState().set({ newProjectOpen: false });
      return;
    }
    const base = join(location.trim(), name);
    if (withSolution) {
      if (!(await step('Create solution', ['new', 'sln', '-n', name, '-o', base], location.trim()))) return;
      if (!(await step(`Create ${name}`, ['new', template, '-n', name, '-o', join(base, name), ...fw], base))) return;
      if (!(await step('Add project to the solution', ['sln', 'add', join(name, `${name}.csproj`)], base))) return;
    } else if (!(await step(`Create ${name}`, ['new', template, '-n', name, '-o', base, ...fw], location.trim()))) return;
    setBusy(null);
    useUi.getState().set({ newProjectOpen: false });
    await openWorkspace(base);
  };

  return (
    <Dialog
      title="New project"
      onClose={close}
      width={720}
      footer={
        <>
          {busy && (
            <span className="muted" style={{ marginRight: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <LoaderCircle size={14} className="spin" /> {busy}…
            </span>
          )}
          <button className="btn" onClick={close} disabled={!!busy}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || !!busy} onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <button key={t.id} className={`template-card${template === t.id ? ' selected' : ''}`} onClick={() => setTemplate(t.id)}>
            <span className="t-name">{t.name}</span>
            <span className="t-desc">{t.desc}</span>
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label className="form-label" htmlFor="np-name">Name</label>
        <div>
          <input id="np-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {!NAME_RE.test(name) && <div className="form-error">Use letters, digits, dots and underscores; start with a letter.</div>}
        </div>
        {hasSolution && (
          <>
            <span />
            <label className="check">
              <input type="checkbox" checked={addToCurrent} onChange={(e) => setAddToCurrent(e.target.checked)} /> Add to the open solution
            </label>
          </>
        )}
        {!addToCurrent && (
          <>
            <label className="form-label" htmlFor="np-loc">Location</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="np-loc" className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
              <button
                className="btn"
                onClick={async () => {
                  const p = await platform.pickFolder('Location');
                  if (p) setLocation(p);
                }}
              >
                <FolderOpen size={14} />
              </button>
            </div>
            <span />
            <label className="check">
              <input type="checkbox" checked={withSolution} onChange={(e) => setWithSolution(e.target.checked)} /> Create a solution
            </label>
          </>
        )}
        <label className="form-label" htmlFor="np-fw">Framework</label>
        <select id="np-fw" className="input" value={framework} onChange={(e) => setFramework(e.target.value)}>
          <option value="net10.0">.NET 10</option>
          <option value="net9.0">.NET 9</option>
          <option value="net8.0">.NET 8 (LTS)</option>
        </select>
        <span />
        <div className="form-help">{addToCurrent ? `Created in ${ws.root ? join(ws.root, name) : ''}` : location ? `Created in ${join(location, name)}` : ''}</div>
      </div>
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}
