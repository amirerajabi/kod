import { Bookmark as BookmarkIcon, ChevronDown, ChevronRight, ListTodo, LoaderCircle, Pencil, RotateCw, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { describeBookmark, gotoBookmark, removeBookmark, useBookmarks } from '../editor/bookmarks';
import { getEntry } from '../editor/models';
import { basename, dirname, norm, relative, samePath } from '../lib/paths';
import { useEditors } from '../store/editors';
import { toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { FileIcon } from './common/icons';
import { showContextMenu } from './common/Menu';

interface Todo {
  path: string;
  line: number;
  column: number;
  kind: string;
  text: string;
}

const useTodos = create<{ items: Todo[] | null; loading: boolean }>(() => ({ items: null, loading: false }));

export async function refreshTodos(): Promise<void> {
  if (!useWorkspace.getState().ws.root || useTodos.getState().loading) return;
  useTodos.setState({ loading: true });
  try {
    useTodos.setState({ items: await api.get<Todo[]>('/fs/todos'), loading: false });
  } catch (e) {
    useTodos.setState({ loading: false });
    toast('error', 'Could not scan for TODOs', errorText(e));
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Files changed: rescan a little later, if the window has been opened. */
export function todosMaybeChanged(): void {
  if (!useTodos.getState().items) return;
  clearTimeout(timer);
  timer = setTimeout(() => void refreshTodos(), 2000);
}

const KINDS = ['TODO', 'FIXME', 'HACK', 'BUG', 'NOTE', 'XXX'];

/** Rider's TODO window: TODO / FIXME / HACK / BUG / NOTE comments of the whole project or the current file. */
export function TodoPanel() {
  const { items, loading } = useTodos();
  const root = useWorkspace((s) => s.ws.root);
  const active = useEditors((s) => s.active);
  const [scope, setScope] = useState<'project' | 'file'>('project');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!items) void refreshTodos();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const by = new Map<string, Todo[]>();
    for (const t of items ?? []) {
      if (hidden.has(t.kind) || (scope === 'file' && !samePath(t.path, active))) continue;
      const k = norm(t.path);
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(t);
    }
    return [...by.values()].sort((a, b) => a[0].path.localeCompare(b[0].path));
  }, [items, hidden, scope, active]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of items ?? []) c[t.kind] = (c[t.kind] ?? 0) + 1;
    return c;
  }, [items]);
  const total = groups.reduce((n, g) => n + g.length, 0);

  return (
    <>
      <div className="console-toolbar">
        <button className={`proc-chip${scope === 'project' ? ' active' : ''}`} onClick={() => setScope('project')}>
          Project
        </button>
        <button className={`proc-chip${scope === 'file' ? ' active' : ''}`} onClick={() => setScope('file')}>
          Current file
        </button>
        <div className="topbar-sep" />
        {KINDS.filter((k) => counts[k]).map((k) => (
          <button
            key={k}
            className={`proc-chip${hidden.has(k) ? '' : ' active'}`}
            onClick={() => {
              const n = new Set(hidden);
              if (n.has(k)) n.delete(k);
              else n.add(k);
              setHidden(n);
            }}
          >
            <span className={`todo-kind todo-${k.toLowerCase()}`}>{k}</span> {counts[k]}
          </button>
        ))}
        <div className="flex-1" />
        <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          {total} item{total === 1 ? '' : 's'}
        </span>
        <button className="icon-btn sm" title="Rescan" onClick={() => void refreshTodos()}>
          {loading ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}
        </button>
      </div>
      <div className="result-list">
        {!items && loading && (
          <div className="panel-empty">
            <LoaderCircle size={16} className="spin" /> Looking for TODO comments…
          </div>
        )}
        {items && groups.length === 0 && (
          <div className="panel-empty">
            <ListTodo size={18} />
            <div>No TODO, FIXME or HACK comments{scope === 'file' ? ' in this file' : ''}.</div>
          </div>
        )}
        {groups.map((list) => {
          const k = norm(list[0].path);
          return (
            <Fragment key={k}>
              <div className="result-file" onClick={() => setClosed({ ...closed, [k]: !closed[k] })} title={list[0].path}>
                {closed[k] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <FileIcon path={list[0].path} size={14} />
                {basename(list[0].path)}
                <span className="muted">{relative(root, dirname(list[0].path))}</span>
                <span className="badge" style={{ marginLeft: 'auto' }}>
                  {list.length}
                </span>
              </div>
              {!closed[k] &&
                list.map((t, i) => (
                  <div key={i} className="result-item" style={{ paddingLeft: 30 }} onClick={() => void useEditors.getState().open(t.path, { line: t.line, column: t.column, preview: true })}>
                    <span className="loc">{t.line}</span>
                    <span className={`todo-kind todo-${t.kind.toLowerCase()}`}>{t.kind}</span>
                    <span className="text">{t.text.replace(/^\w+[:\s]*/, '')}</span>
                  </div>
                ))}
            </Fragment>
          );
        })}
      </div>
    </>
  );
}

/** Rider's Bookmarks window: every bookmark of the workspace, numbered ones first. */
export function BookmarksPanel() {
  const list = useBookmarks((s) => s.list);
  const root = useWorkspace((s) => s.ws.root);
  const sorted = [...list].sort((a, b) => (a.mnemonic ?? '~').localeCompare(b.mnemonic ?? '~') || a.path.localeCompare(b.path) || a.line - b.line);
  if (list.length === 0)
    return (
      <div className="panel-empty">
        <BookmarkIcon size={18} />
        <div>
          No bookmarks. <kbd>F11</kbd> toggles one on the caret line, <kbd>Ctrl+Shift+1</kbd>…<kbd>9</kbd> a numbered one; <kbd>Ctrl+1</kbd>…<kbd>9</kbd> jumps back.
        </div>
      </div>
    );
  return (
    <div className="result-list">
      {sorted.map((b, i) => {
        const text = getEntry(b.path)?.model.getLineContent(Math.min(b.line, getEntry(b.path)!.model.getLineCount())).trim() ?? b.text;
        return (
          <div
            key={`${b.path}:${b.line}:${i}`}
            className="result-item"
            onClick={() => gotoBookmark(b)}
            onContextMenu={(e) =>
              showContextMenu(e, [
                { label: 'Edit Description…', icon: <Pencil size={14} />, run: () => void describeBookmark(b) },
                { label: 'Remove Bookmark', icon: <Trash2 size={14} />, danger: true, run: () => removeBookmark(b) },
              ])
            }
            title={b.path}
          >
            <span className={`bm-badge${b.mnemonic ? '' : ' anon'}`}>{b.mnemonic ?? '✓'}</span>
            <FileIcon path={b.path} size={14} />
            <span className="loc">
              {basename(b.path)}:{b.line}
            </span>
            <span className="text">{b.description ? <b>{b.description}</b> : text}</span>
            <span className="muted insp-dir">{relative(root, dirname(b.path))}</span>
            <button
              className="icon-btn sm hier-go"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                removeBookmark(b);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
