import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../api/client';
import type { ExtractInterfaceInfoDto, FileEditsDto, SafeDeleteCheckDto, SignatureInfoDto, SignatureParameterEditDto } from '../api/types';
import { applyRefactoring, useRefactor, type At } from '../editor/refactor';
import { basename, relative } from '../lib/paths';
import { useEditors } from '../store/editors';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';

/** The dialog of the refactoring in progress (Change Signature, Safe Delete, Extract Interface). */
export function RefactorDialogs() {
  const dialog = useRefactor((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.kind === 'signature') return <ChangeSignatureDialog at={dialog.at} info={dialog.info} />;
  if (dialog.kind === 'safeDelete') return <SafeDeleteDialog at={dialog.at} check={dialog.check} />;
  return <ExtractInterfaceDialog at={dialog.at} info={dialog.info} />;
}

/** Runs a refactoring request, keeping the dialog open with the engine's message when it is refused. */
function useRun(title: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const files = await api.post<FileEditsDto[]>(path, body);
      useRefactor.getState().close();
      await applyRefactoring(files, done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, title };
}

// ---------------------------------------------------------------- Change Signature

interface Row {
  key: number;
  originalIndex: number;
  name: string;
  type: string;
  defaultValue: string;
  originalDefault: string;
  callSiteValue: string;
  modifier?: string;
  isParams: boolean;
}

let rowKey = 0;

function ChangeSignatureDialog({ at, info }: { at: At; info: SignatureInfoDto }) {
  const [rows, setRows] = useState<Row[]>(() =>
    info.parameters.map((p, i) => ({ key: ++rowKey, originalIndex: i, name: p.name, type: p.type, defaultValue: p.defaultValue ?? '', originalDefault: p.defaultValue ?? '', callSiteValue: '', modifier: p.modifier, isParams: p.isParams })),
  );
  const [sel, setSel] = useState(rows.length ? 0 : -1);
  const { busy, error, run } = useRun('Change Signature');
  const close = () => useRefactor.getState().close();
  const fixedFirst = info.isExtension; // the "this" parameter stays first

  const update = (i: number, p: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const move = (d: -1 | 1) => {
    const j = sel + d;
    if (sel < 0 || j < 0 || j >= rows.length || (fixedFirst && (sel === 0 || j === 0))) return;
    const next = [...rows];
    [next[sel], next[j]] = [next[j], next[sel]];
    setRows(next);
    setSel(j);
  };
  const add = () => {
    const at = sel >= 0 ? sel + 1 : rows.length;
    const paramsLast = rows.length > 0 && rows[rows.length - 1].isParams;
    const i = Math.min(at, paramsLast ? rows.length - 1 : rows.length);
    const next = [...rows];
    next.splice(i, 0, { key: ++rowKey, originalIndex: -1, name: `param${rows.length + 1}`, type: 'int', defaultValue: '', originalDefault: '', callSiteValue: '0', isParams: false });
    setRows(next);
    setSel(i);
  };
  const remove = () => {
    if (sel < 0 || (fixedFirst && sel === 0)) return;
    setRows(rows.filter((_, k) => k !== sel));
    setSel(Math.min(sel, rows.length - 2));
  };

  const preview = useMemo(
    () =>
      `${info.returnType ? `${info.returnType} ` : ''}${info.name}(${rows
        .map((r) => `${r.isParams ? 'params ' : r.modifier ? `${r.modifier} ` : ''}${r.type} ${r.name}${r.defaultValue.trim() ? ` = ${r.defaultValue.trim()}` : ''}`)
        .join(', ')})`,
    [rows, info],
  );

  const submit = () => {
    const parameters: SignatureParameterEditDto[] = rows.map((r) => ({
      originalIndex: r.originalIndex,
      name: r.name.trim(),
      type: r.type.trim(),
      // existing parameters: null keeps the default as it is, '' removes it
      defaultValue: r.originalIndex >= 0 ? (r.defaultValue.trim() === r.originalDefault ? null : r.defaultValue.trim()) : r.defaultValue.trim() || null,
      callSiteValue: r.originalIndex < 0 ? r.callSiteValue.trim() || null : null,
    }));
    void run('/intel/refactor/changeSignature', { ...at, parameters }, `Changed the signature of ${info.name}`);
  };

  return (
    <Dialog
      title={`Change Signature: ${info.name}`}
      onClose={close}
      width={760}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            Refactor
          </button>
        </>
      }
    >
      <div className="muted" style={{ marginBottom: 8 }}>
        Calls, overrides and implementations are updated. A new parameter gets its call-site value at every existing call (or its default value, if it has one).
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <button className="btn btn-xs" onClick={add} title="Add a parameter">
          <Plus size={12} /> Add
        </button>
        <button className="btn btn-xs" onClick={remove} disabled={sel < 0 || (fixedFirst && sel === 0)} title="Remove the parameter">
          <Trash2 size={12} /> Remove
        </button>
        <button className="btn btn-xs" onClick={() => move(-1)} disabled={sel <= 0} title="Move up">
          <ArrowUp size={12} />
        </button>
        <button className="btn btn-xs" onClick={() => move(1)} disabled={sel < 0 || sel >= rows.length - 1} title="Move down">
          <ArrowDown size={12} />
        </button>
      </div>
      <table className="sig-table">
        <thead>
          <tr>
            <th style={{ width: 70 }}>Modifier</th>
            <th>Type</th>
            <th>Name</th>
            <th>Default value</th>
            <th>Value at existing calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={i === sel ? 'selected' : undefined} onClick={() => setSel(i)}>
              <td className="muted">{r.isParams ? 'params' : (r.modifier ?? '')}</td>
              <td>
                <input className="input sm" value={r.type} disabled={r.originalIndex >= 0} onChange={(e) => update(i, { type: e.target.value })} spellCheck={false} />
              </td>
              <td>
                <input className="input sm" value={r.name} onChange={(e) => update(i, { name: e.target.value })} onFocus={() => setSel(i)} spellCheck={false} />
              </td>
              <td>
                <input className="input sm" value={r.defaultValue} disabled={r.isParams} placeholder="none" onChange={(e) => update(i, { defaultValue: e.target.value })} onFocus={() => setSel(i)} spellCheck={false} />
              </td>
              <td>
                {r.originalIndex < 0 ? (
                  <input className="input sm" value={r.callSiteValue} placeholder={r.defaultValue ? 'use the default' : 'required'} onChange={(e) => update(i, { callSiteValue: e.target.value })} onFocus={() => setSel(i)} spellCheck={false} />
                ) : (
                  <span className="muted">unchanged</span>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No parameters
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="section-label" style={{ padding: '10px 0 4px' }}>
        Signature
      </div>
      <pre className="sig-preview">{preview}</pre>
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Safe Delete

function SafeDeleteDialog({ at, check }: { at: At; check: SafeDeleteCheckDto }) {
  const root = useWorkspace((s) => s.ws.root);
  const { busy, error, run } = useRun('Safe Delete');
  const close = () => useRefactor.getState().close();
  const used = check.usages.length > 0;
  return (
    <Dialog
      title={`Safe Delete ${check.kind} '${check.name}'`}
      onClose={close}
      width={used ? 680 : 440}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className={`btn ${used ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={() => void run('/intel/refactor/safeDelete', { ...at, force: used }, `Deleted ${check.name}`)}>
            {used ? 'Delete anyway' : 'Delete'}
          </button>
        </>
      }
    >
      {!used ? (
        <div>
          '{check.name}' is not used anywhere{check.kind === 'parameter' ? '; it is removed from every call too' : ''}. Delete it?
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            '{check.name}' is still used in {check.usages.length} {check.usages.length === 1 ? 'place' : 'places'}. Deleting it breaks them.
          </div>
          <div className="result-list" style={{ maxHeight: 280, border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
            {check.usages.map((u, i) => (
              <div key={i} className="result-item" onClick={() => void useEditors.getState().open(u.path, { range: u.range, preview: true })} title={u.path}>
                <span className="loc">
                  {basename(u.path)}:{u.range.startLine}
                </span>
                <span className="text">{u.preview}</span>
                <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {relative(root, u.path)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Extract Interface

function ExtractInterfaceDialog({ at, info }: { at: At; info: ExtractInterfaceInfoDto }) {
  const root = useWorkspace((s) => s.ws.root);
  const [name, setName] = useState(info.suggestedName);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(info.members.map((m) => m.id)));
  const { busy, error, run } = useRun('Extract Interface');
  const close = () => useRefactor.getState().close();
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  useEffect(() => setName(info.suggestedName), [info.suggestedName]);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  return (
    <Dialog
      title={`Extract Interface from ${info.typeName}`}
      onClose={close}
      width={600}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !valid} onClick={() => void run('/intel/refactor/extractInterface', { ...at, name, memberIds: [...chosen] }, `Extracted ${name}`)}>
            Extract
          </button>
        </>
      }
    >
      <label className="muted" htmlFor="xi-name">
        Interface name
      </label>
      <input id="xi-name" className="input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoFocus />
      <div className="muted" style={{ margin: '4px 0 10px', fontSize: 'var(--text-xs)' }}>
        New file: {relative(root, info.folder) || '.'}/{name || '…'}.cs
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <span className="section-label" style={{ padding: 0 }}>
          Members ({chosen.size} of {info.members.length})
        </span>
        <span className="flex-1" />
        <button className="btn btn-xs btn-ghost" onClick={() => setChosen(new Set(info.members.map((m) => m.id)))}>
          All
        </button>
        <button className="btn btn-xs btn-ghost" onClick={() => setChosen(new Set())}>
          None
        </button>
      </div>
      <div className="result-list" style={{ maxHeight: 300, border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
        {info.members.length === 0 && <div className="panel-empty">The type has no public instance members.</div>}
        {info.members.map((m) => (
          <label key={m.id} className="result-item" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={chosen.has(m.id)} onChange={() => toggle(m.id)} />
            <span className="text" style={{ fontFamily: 'var(--font-mono)' }}>
              {m.display}
            </span>
          </label>
        ))}
      </div>
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}
