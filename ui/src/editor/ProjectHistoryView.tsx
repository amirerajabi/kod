// Rider's Local History of a folder or the whole project: every change across files, newest first (files saved
// together form one change: a Save All, a rename, a refactoring, a revert), with project labels between them. Pick a
// change to see its files and what it did to each; revert a whole change or one file; put a label.
import { FileMinus, FilePlus, History, LoaderCircle, RotateCw, Tag, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../api/client';
import { FileIcon } from '../components/common/icons';
import { basename, relative } from '../lib/paths';
import { useEditors } from '../store/editors';
import { askConfirm, askText, toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { DiffView } from './DiffView';
import { getEntry, isDirty } from './models';

export interface HistoryChangeFile {
  path: string;
  id: string;
  prevId?: string;
  exists: boolean;
}

export interface HistoryChange {
  kind: 'change' | 'label';
  time: number;
  label: string;
  files: HistoryChangeFile[];
}

export function when(t: number): string {
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString();
  const yesterday = new Date(today.getTime() - 86_400_000);
  return d.toDateString() === yesterday.toDateString() ? `Yesterday ${d.toLocaleTimeString()}` : d.toLocaleString();
}

export const keyOf = (c: HistoryChange) => `${c.kind}:${c.time}:${c.files[0]?.id ?? c.label}`;

/** The change Recent Changes asked to show when the project history opens. */
let focus: string | null = null;

/** Opens the project history on one change (Recent Changes). */
export function showChange(root: string, c: HistoryChange): void {
  focus = keyOf(c);
  useEditors.getState().openHistory(root, { folder: true });
  window.dispatchEvent(new CustomEvent('kod:history-focus'));
}

/** Puts a project-wide label (Rider's Put Label on the project). */
export async function putProjectLabel(label?: string): Promise<boolean> {
  const text = label ?? (await askText({ title: 'Put Label', label: 'Label for the whole project', placeholder: 'Before the big refactoring', okLabel: 'Put Label' }));
  if (!text?.trim()) return false;
  try {
    await api.post('/history/projectLabel', { label: text.trim() });
    return true;
  } catch (e) {
    toast('error', 'Could not put the label', errorText(e));
    return false;
  }
}

/** Puts a file back to the text it had before a change (or deletes it, if the change created it). */
async function restore(f: HistoryChangeFile): Promise<void> {
  if (!f.prevId) {
    await api.post('/fs/delete', { path: f.path });
    return;
  }
  const { text } = await api.get<{ text: string }>('/history/text', { path: f.path, id: f.prevId });
  const entry = getEntry(f.path);
  if (entry && !entry.readOnly) {
    // the open editor gets an undoable edit, then the file is written
    entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text }], () => null);
    await useEditors.getState().save(f.path, { auto: true });
  } else {
    await api.post('/fs/write', { path: f.path, text, label: 'Reverted' });
  }
}

export function ProjectHistoryView({ path }: { path: string }) {
  const root = useWorkspace((s) => s.ws.root);
  const [changes, setChanges] = useState<HistoryChange[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = () =>
    api.get<HistoryChange[]>('/history/changes', { path }).then(
      (list) => {
        setChanges(list);
        const want = focus;
        focus = null;
        setSelected((s) => (want && list.some((c) => keyOf(c) === want) ? want : s && list.some((c) => keyOf(c) === s) ? s : (list.find((c) => c.kind === 'change') ? keyOf(list.find((c) => c.kind === 'change')!) : null)));
        setFile(null);
      },
      () => setChanges([]),
    );
  useEffect(() => void load(), [path]); // eslint-disable-line react-hooks/exhaustive-deps
  // Recent Changes picked a change while this view was already open
  useEffect(() => {
    const h = () => void load();
    window.addEventListener('kod:history-focus', h);
    return () => window.removeEventListener('kod:history-focus', h);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    if (!changes || !filter) return changes ?? [];
    const f = filter.toLowerCase();
    return changes.filter((c) => c.kind === 'label' || c.label.toLowerCase().includes(f) || c.files.some((x) => x.path.toLowerCase().includes(f)));
  }, [changes, filter]);
  const change = changes?.find((c) => keyOf(c) === selected);
  const current = change?.files.find((f) => f.path === file) ?? change?.files[0];

  const revertChange = async (c: HistoryChange) => {
    const created = c.files.filter((f) => !f.prevId);
    const msg = `Undo "${c.label}" from ${when(c.time)} in ${c.files.length} file${c.files.length === 1 ? '' : 's'}?${created.length ? `\n\n${created.length} file${created.length === 1 ? '' : 's'} it created will be deleted.` : ''}\n\nThe current texts stay in the history.`;
    if ((await askConfirm({ title: 'Revert change', message: msg, okLabel: 'Revert', danger: created.length > 0 })) !== 'ok') return;
    try {
      for (const f of c.files) await restore(f);
      await putProjectLabel(`Reverted: ${c.label}`);
      toast('success', 'Reverted', `${c.files.length} file${c.files.length === 1 ? '' : 's'} put back to before ${when(c.time)}`, 3000);
      void load();
    } catch (e) {
      toast('error', 'Revert failed', errorText(e));
    }
  };

  const revertFile = async (f: HistoryChangeFile) => {
    const entry = getEntry(f.path);
    const dirty = entry && isDirty(entry);
    if ((await askConfirm({ title: 'Revert file', message: `Put ${basename(f.path)} back to before this change?${dirty ? '\n\nIts unsaved edits are replaced too (undo brings them back).' : ''}`, okLabel: 'Revert' })) !== 'ok') return;
    try {
      await restore(f);
      void load();
    } catch (e) {
      toast('error', 'Revert failed', errorText(e));
    }
  };

  return (
    <div className="history-view">
      <div className="history-list project-history-list">
        <div className="console-toolbar">
          <History size={14} />
          <b title={path}>{path === root ? 'Project history' : basename(path)}</b>
          <div className="flex-1" />
          <button className="icon-btn sm" title="Put Label (on the whole project)" onClick={() => void putProjectLabel().then((ok) => { if (ok) void load(); })}>
            <Tag size={14} />
          </button>
          <button className="icon-btn sm" title="Refresh" onClick={() => void load()}>
            <RotateCw size={14} />
          </button>
        </div>
        <input className="input sm history-filter" placeholder="Filter by file or label" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="result-list">
          {!changes && (
            <div className="panel-empty">
              <LoaderCircle size={16} className="spin" />
            </div>
          )}
          {changes?.length === 0 && <div className="panel-empty">No history yet. Every save, refactoring and external change of a file is kept here for 30 days.</div>}
          {shown.map((c) =>
            c.kind === 'label' ? (
              <div key={keyOf(c)} className="history-project-label" title={when(c.time)}>
                <Tag size={12} /> {c.label}
                <span className="muted">{when(c.time)}</span>
              </div>
            ) : (
              <div key={keyOf(c)} className={`result-item history-change${keyOf(c) === selected ? ' selected' : ''}`} onClick={() => { setSelected(keyOf(c)); setFile(null); }}>
                <span className="history-change-main">
                  <span className="msg">{when(c.time)}</span>
                  <span className="muted history-change-files">{c.files.length === 1 ? relative(root ?? undefined, c.files[0].path) : `${c.files.length} files`}</span>
                </span>
                <span className={`history-label${c.label === 'Saved' ? ' muted' : ''}`}>{c.label}</span>
                <button className="icon-btn sm history-revert" title="Revert this change" onClick={(e) => { e.stopPropagation(); void revertChange(c); }}>
                  <Undo2 size={13} />
                </button>
              </div>
            ),
          )}
        </div>
      </div>
      {change && change.files.length > 1 && (
        <div className="history-files">
          <div className="section-label">{change.files.length} files</div>
          {change.files.map((f) => (
            <div key={f.path} className={`result-item${f.path === current?.path ? ' selected' : ''}`} onClick={() => setFile(f.path)} onDoubleClick={() => f.exists && void useEditors.getState().open(f.path)} title={f.path}>
              {f.prevId ? <FileIcon path={f.path} isDir={false} size={14} /> : <FilePlus size={14} className="history-created" />}
              <span className="msg">{basename(f.path)}</span>
              {!f.exists && <FileMinus size={13} className="muted" aria-label="Deleted since" />}
              <button className="icon-btn sm history-revert" title="Revert this file" onClick={(e) => { e.stopPropagation(); void revertFile(f); }}>
                <Undo2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="history-diff">
        {current ? (
          <>
            <div className="history-diff-head">
              <span title={current.path}>{relative(root ?? undefined, current.path)}</span>
              <span className="muted">{current.prevId ? 'before ↔ after this change' : 'created by this change'}</span>
            </div>
            <div className="history-diff-body">
              <DiffView key={`${current.path}:${current.id}`} spec={{ path: current.path, left: current.prevId ? `history:${current.prevId}` : 'empty', right: `history:${current.id}` }} />
            </div>
          </>
        ) : (
          <div className="panel-empty">Select a change to see what it did.</div>
        )}
      </div>
    </div>
  );
}
