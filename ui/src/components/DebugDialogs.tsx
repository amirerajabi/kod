import { RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../api/client';
import { basename, norm } from '../lib/paths';
import { attachTo, useDebug, type Breakpoint } from '../store/debug';
import { Dialog } from './common/Dialog';
import './run.css';

/** A breakpoint's properties: enabled, condition, hit count, log message, suspend, remove once hit. */
export function BreakpointDialog() {
  const editing = useDebug((s) => s.editing);
  if (!editing) return null;
  return <BreakpointForm key={`${editing.path}:${editing.line}`} path={editing.path} line={editing.line} />;
}

function BreakpointForm({ path, line }: { path: string; line: number }) {
  const existing = useDebug.getState().breakpoints[norm(path)]?.bps.find((b) => b.line === line);
  const [b, setB] = useState<Breakpoint>(existing ?? { line });
  const up = (p: Partial<Breakpoint>) => setB((x) => ({ ...x, ...p }));
  const close = () => useDebug.setState({ editing: null });
  const hitOk = !b.hitCondition?.trim() || /^(>=|>|==|=|%)?\s*\d+$/.test(b.hitCondition.trim());

  return (
    <Dialog
      title={`Breakpoint at ${basename(path)}:${line}`}
      onClose={close}
      width={520}
      footer={
        <>
          {existing && (
            <button
              className="btn"
              style={{ marginRight: 'auto' }}
              onClick={() => {
                useDebug.getState().toggle(path, line);
                close();
              }}
            >
              Remove
            </button>
          )}
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!hitOk}
            onClick={() => {
              const clean = (s?: string) => (s?.trim() ? s.trim() : undefined);
              useDebug.getState().update(path, line, {
                enabled: b.enabled === false ? false : undefined,
                condition: clean(b.condition),
                hitCondition: clean(b.hitCondition),
                logMessage: clean(b.logMessage),
                suspend: b.suspend === false ? false : undefined,
                temporary: b.temporary || undefined,
              });
              close();
            }}
          >
            {existing ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <span />
        <label className="check">
          <input type="checkbox" checked={b.enabled !== false} onChange={(e) => up({ enabled: e.target.checked })} /> Enabled
        </label>
        <label htmlFor="bp-cond">Condition</label>
        <input id="bp-cond" className="input mono" value={b.condition ?? ''} onChange={(e) => up({ condition: e.target.value })} placeholder="i > 10 && name == &quot;Ann&quot;" spellCheck={false} autoFocus />
        <label htmlFor="bp-hit">Hit count</label>
        <div>
          <input id="bp-hit" className="input mono" value={b.hitCondition ?? ''} onChange={(e) => up({ hitCondition: e.target.value })} placeholder="5,  >= 5  or  % 5" spellCheck={false} />
          <div className={hitOk ? 'form-help' : 'form-error'}>5 = only the 5th hit, &gt;= 5 = from the 5th on, % 5 = every 5th. Empty: every hit.</div>
        </div>
        <label htmlFor="bp-log">Log message</label>
        <div>
          <input id="bp-log" className="input mono" value={b.logMessage ?? ''} onChange={(e) => up({ logMessage: e.target.value })} placeholder="order {order.Id} has {order.Lines.Count} lines" spellCheck={false} />
          <div className="form-help">Printed to the Debug console on a hit; {'{expressions}'} are evaluated in the frame.</div>
        </div>
        <span />
        <label className="check">
          <input type="checkbox" checked={b.suspend !== false} onChange={(e) => up({ suspend: e.target.checked })} /> Suspend (pause the program)
        </label>
        <span />
        <label className="check">
          <input type="checkbox" checked={!!b.temporary} onChange={(e) => up({ temporary: e.target.checked })} /> Remove once hit
        </label>
      </div>
    </Dialog>
  );
}

interface DotnetProcess {
  id: number;
  name: string;
  path?: string;
  startedAt?: number;
  title?: string;
}

/** Attach to Process: the running .NET programs, filterable. */
export function AttachDialog() {
  const open = useDebug((s) => s.attachOpen);
  return open ? <AttachForm /> : null;
}

function AttachForm() {
  const [list, setList] = useState<DotnetProcess[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const close = () => useDebug.setState({ attachOpen: false });
  const load = () => {
    setError(null);
    api.get<DotnetProcess[]>('/debug/processes').then(setList, (e) => setError(errorText(e)));
  };
  useEffect(load, []);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list ?? []).filter((p) => !f || `${p.id} ${p.name} ${p.path ?? ''} ${p.title ?? ''}`.toLowerCase().includes(f));
  }, [list, filter]);
  const chosen = shown.find((p) => p.id === sel) ?? (shown.length === 1 ? shown[0] : undefined);
  const attach = (p: DotnetProcess | undefined) => {
    if (!p) return;
    close();
    void attachTo(p.id, p.name);
  };

  return (
    <Dialog
      title="Attach to Process"
      onClose={close}
      width={640}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} onClick={load} title="Refresh">
            <RotateCw size={14} /> Refresh
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!chosen} onClick={() => attach(chosen)}>
            Attach
          </button>
        </>
      }
    >
      <input
        className="input"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && attach(chosen)}
        placeholder="Filter by name, id or path"
        autoFocus
        style={{ width: '100%' }}
      />
      <div className="result-list attach-list">
        {error && <div className="form-error" style={{ padding: 12 }}>{error}</div>}
        {!list && !error && <div className="panel-empty" style={{ padding: 12 }}>Looking for .NET processes…</div>}
        {list && shown.length === 0 && <div className="panel-empty" style={{ padding: 12 }}>{list.length ? 'No process matches' : 'No .NET processes are running'}</div>}
        {shown.map((p) => (
          <div key={p.id} className={`result-item${p.id === chosen?.id ? ' selected' : ''}`} onClick={() => setSel(p.id)} onDoubleClick={() => attach(p)} title={p.path ?? p.name}>
            <span className="msg">{p.name}</span>
            <span className="muted">{p.id}</span>
            {(p.title || p.path) && <span className="loc">{p.title ?? p.path}</span>}
          </div>
        ))}
      </div>
      <div className="form-help" style={{ marginTop: 6 }}>Stopping the session detaches; the program keeps running.</div>
    </Dialog>
  );
}
