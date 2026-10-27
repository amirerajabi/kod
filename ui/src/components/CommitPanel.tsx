import { Archive, ChevronDown, ChevronRight, Download, GitBranch, GitCommitHorizontal, GitMerge, History, LoaderCircle, Minus, PackageOpen, Plus, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { keyLabel } from '../app/commands';
import { basename, dirname, norm } from '../lib/paths';
import { deleteChangelist, listOf, moveTo, newChangelist, renameChangelist, setActiveChangelist, useChangelists } from '../store/changelists';
import { useEditors } from '../store/editors';
import { acceptSide, changeKind, commit, gitFetch, gitPull, gitPush, initRepository, openDiff, openMerge, refreshGit, rollback, shelveChanges, stage, stashChanges, unstage, useGit, type GitFile, type PartialFile } from '../store/git';
import { FileIcon } from './common/icons';
import { showContextMenu, type MenuItem } from './common/Menu';
import { GitOperationBar } from './GitDialogs';
import { showBranchMenu } from './GitBranchMenu';

const LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' };

interface Hunk {
  header: string;
  lines: { kind: string; text: string }[];
}

/** Partial selection of one file: per hunk, the chosen changed lines (by index into the hunk's lines). */
type Selection = Record<number, Set<number>>;

const changedLines = (h: Hunk) => h.lines.map((l, i) => (l.kind === '+' || l.kind === '-' ? i : -1)).filter((i) => i >= 0);

/** Rider's Commit window: changelists of changed files with check boxes (down to hunks and lines), the message,
 *  Amend, Commit and Commit and Push, stash and shelve. */
export function CommitPanel() {
  const status = useGit((s) => s.status);
  const busy = useGit((s) => s.busy);
  const { lists, active, assign } = useChangelists();
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  /** Files whose check box differs from its default (the active changelist's files are checked by default). */
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Record<string, boolean>>({ unversioned: true });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [hunks, setHunks] = useState<Record<string, Hunk[] | 'loading'>>({});
  const [partial, setPartial] = useState<Record<string, Selection>>({});

  useEffect(() => refreshGit(0), []);
  useEffect(() => {
    if (!amend || message) return;
    void api.get<{ message: string }>('/git/lastMessage').then((r) => setMessage(r.message), () => undefined);
  }, [amend]); // eslint-disable-line react-hooks/exhaustive-deps
  // the hunks change with the files: reload the open ones, forget the selections of files that changed
  const rev = useGit((s) => s.rev);
  useEffect(() => {
    setHunks({});
    setPartial({});
  }, [rev]);

  const files = status?.files ?? [];
  const conflicts = useMemo(() => files.filter((f) => f.conflicted), [files]);
  const tracked = useMemo(() => files.filter((f) => !f.untracked && !f.conflicted), [files]);
  const unversioned = useMemo(() => files.filter((f) => f.untracked), [files]);
  void assign;
  const byList = useMemo(() => {
    const m = new Map<string, GitFile[]>(lists.map((l) => [l.id, []]));
    for (const f of tracked) m.get(listOf(f.path))?.push(f);
    return m;
  }, [tracked, lists, active, assign]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDefault = (f: GitFile) => !f.untracked && listOf(f.path) === active;
  const checked = (f: GitFile) => isDefault(f) !== toggled.has(norm(f.path));
  const setChecked = (list: GitFile[], on: boolean) =>
    setToggled((s) => {
      const n = new Set(s);
      for (const f of list) {
        const k = norm(f.path);
        if (isDefault(f) === on) n.delete(k);
        else n.add(k);
      }
      return n;
    });
  const selected = files.filter((f) => checked(f) && !f.conflicted);

  /** The partial selections that leave something out, as the engine wants them. */
  const partialFiles = (): PartialFile[] => {
    const out: PartialFile[] = [];
    for (const f of selected) {
      const sel = partial[norm(f.path)];
      const hs = hunks[norm(f.path)];
      if (!sel || !Array.isArray(hs)) continue;
      const chosen = hs.map((h, i) => ({ i, all: changedLines(h), on: sel[i] ?? new Set<number>() }));
      if (chosen.every((c) => c.on.size === c.all.length)) continue;
      out.push({ path: f.path, hunks: chosen.filter((c) => c.on.size > 0).map((c) => ({ index: c.i, lines: c.on.size === c.all.length ? null : [...c.on] })) });
    }
    return out;
  };

  if (!status) return <div className="panel-empty">Loading Git…</div>;
  if (!status.isRepo)
    return (
      <div className="panel-empty">
        <GitBranch size={20} />
        <div style={{ margin: '8px 0 12px' }}>This folder is not under Git.</div>
        <button className="btn btn-primary" onClick={() => void initRepository()}>
          Create Git repository
        </button>
      </div>
    );

  const doCommit = async (push: boolean) => {
    const parts = partialFiles();
    // a file whose partial selection is empty is left out
    const whole = selected.filter((f) => !parts.some((p) => p.path === f.path) || parts.find((p) => p.path === f.path)!.hunks.length > 0);
    if (await commit(message, whole.map((f) => f.path), amend, push, parts.filter((p) => p.hunks.length > 0))) {
      setMessage('');
      setAmend(false);
      setToggled(new Set());
      setPartial({});
    }
  };

  const expand = async (f: GitFile) => {
    const k = norm(f.path);
    const open = !expanded[k];
    setExpanded({ ...expanded, [k]: open });
    if (!open || hunks[k]) return;
    setHunks((h) => ({ ...h, [k]: 'loading' }));
    try {
      const r = await api.get<{ hunks: Hunk[]; binary: boolean }>('/git/hunks', { path: f.path });
      setHunks((h) => ({ ...h, [k]: r.binary ? [] : r.hunks }));
      setPartial((p) => ({ ...p, [k]: Object.fromEntries(r.hunks.map((h, i) => [i, new Set(changedLines(h))])) }));
    } catch {
      setHunks((h) => ({ ...h, [k]: [] }));
    }
  };

  const toggleLines = (path: string, hunk: number, lines: number[], on: boolean) =>
    setPartial((p) => {
      const k = norm(path);
      const cur = { ...(p[k] ?? {}) };
      const s = new Set(cur[hunk] ?? []);
      for (const l of lines) {
        if (on) s.add(l);
        else s.delete(l);
      }
      cur[hunk] = s;
      return { ...p, [k]: cur };
    });

  const partState = (f: GitFile): 'all' | 'some' | 'none' => {
    const k = norm(f.path);
    const hs = hunks[k];
    const sel = partial[k];
    if (!sel || !Array.isArray(hs)) return 'all';
    const total = hs.reduce((n, h) => n + changedLines(h).length, 0);
    const on = hs.reduce((n, _h, i) => n + (sel[i]?.size ?? 0), 0);
    return on === 0 ? 'none' : on === total ? 'all' : 'some';
  };

  const menuFor = (f: GitFile): MenuItem[] => {
    const targets = selected.some((s) => s.path === f.path) ? selected.map((s) => s.path) : [f.path];
    return [
      ...(f.conflicted
        ? ([
            { label: 'Merge…', icon: <GitMerge size={14} />, run: () => openMerge(f.path) },
            { label: 'Accept Yours', run: () => void acceptSide([f.path], 'ours') },
            { label: 'Accept Theirs', run: () => void acceptSide([f.path], 'theirs') },
            'separator',
          ] as MenuItem[])
        : []),
      { label: 'Show Diff', shortcut: keyLabel('Ctrl+D'), run: () => openDiff(f.path, 'HEAD', 'working') },
      { label: 'Open File', run: () => void useEditors.getState().open(f.path) },
      { label: 'Show Local History', icon: <History size={14} />, run: () => useEditors.getState().openHistory(f.path) },
      'separator',
      ...(!f.untracked && !f.conflicted
        ? ([
            {
              label: 'Move to Another Changelist',
              submenu: [
                ...lists.map((l) => ({ label: l.name, checked: listOf(f.path) === l.id, run: () => moveTo(targets, l.id) })),
                'separator',
                { label: 'New Changelist…', run: () => void newChangelist(targets) },
              ] as MenuItem[],
            },
          ] as MenuItem[])
        : []),
      { label: 'Shelve Changes…', icon: <PackageOpen size={14} />, run: () => void shelveChanges(targets) },
      { label: 'Stash Changes…', icon: <Archive size={14} />, run: () => void stashChanges(targets) },
      'separator',
      f.staged ? { label: 'Unstage', icon: <Minus size={14} />, run: () => void unstage([f.path]) } : { label: 'Stage', icon: <Plus size={14} />, run: () => void stage([f.path]) },
      { label: 'Rollback…', icon: <RotateCcw size={14} />, danger: true, run: () => void rollback(targets) },
    ];
  };

  const fileRow = (f: GitFile) => {
    const kind = changeKind(f);
    const k = norm(f.path);
    const canPart = !f.untracked && !f.conflicted && kind !== 'deleted';
    const part = partState(f);
    const hs = hunks[k];
    return (
      <div key={f.path}>
        <div
          className="result-item"
          style={{ paddingLeft: 8 }}
          title={`${f.rel}${f.staged ? ' (staged)' : ''}`}
          onDoubleClick={() => (f.conflicted ? openMerge(f.path) : openDiff(f.path))}
          onContextMenu={(e) => showContextMenu(e, menuFor(f))}
        >
          <span className="tree-chevron" onClick={() => canPart && void expand(f)} title={canPart ? 'Choose hunks and lines to commit' : undefined}>
            {canPart ? expanded[k] ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
          </span>
          {!f.conflicted && (
            <input
              type="checkbox"
              checked={checked(f) && part !== 'none'}
              ref={(el) => {
                if (el) el.indeterminate = checked(f) && part === 'some';
              }}
              onChange={(e) => setChecked([f], e.target.checked)}
            />
          )}
          <FileIcon path={f.path} size={14} />
          <span className={`msg git-${kind}`}>{basename(f.path)}</span>
          <span className="loc" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {dirname(f.rel) === f.rel ? '' : dirname(f.rel)}
          </span>
          {f.conflicted && (
            <button className="btn btn-xs btn-primary" style={{ marginLeft: 'auto' }} onClick={() => openMerge(f.path)}>
              Merge…
            </button>
          )}
          <span className="loc" style={{ marginLeft: f.conflicted ? 4 : 'auto' }} title={f.staged ? 'Staged' : undefined}>
            {LETTER[kind]}
            {f.staged ? '•' : ''}
          </span>
        </div>
        {expanded[k] && (
          <div className="hunk-list">
            {hs === 'loading' && (
              <div className="muted" style={{ padding: '2px 36px' }}>
                <LoaderCircle size={12} className="spin" />
              </div>
            )}
            {Array.isArray(hs) && hs.length === 0 && (
              <div className="muted" style={{ padding: '2px 36px', fontSize: 'var(--text-xs)' }}>
                No text changes to pick from (binary or new file): it is committed whole.
              </div>
            )}
            {Array.isArray(hs) &&
              hs.map((h, i) => {
                const all = changedLines(h);
                const on = partial[k]?.[i] ?? new Set<number>();
                return (
                  <div key={i} className="hunk">
                    <label className="hunk-head">
                      <input
                        type="checkbox"
                        checked={on.size === all.length}
                        ref={(el) => {
                          if (el) el.indeterminate = on.size > 0 && on.size < all.length;
                        }}
                        onChange={(e) => {
                          toggleLines(f.path, i, all, e.target.checked);
                          if (e.target.checked && !checked(f)) setChecked([f], true);
                        }}
                      />
                      <span>{h.header.replace(/^(@@[^@]*@@).*/, '$1')}</span>
                    </label>
                    {h.lines.map((l, li) =>
                      l.kind === '+' || l.kind === '-' ? (
                        <label key={li} className={`hunk-line ${l.kind === '+' ? 'add' : 'del'}`}>
                          <input type="checkbox" checked={on.has(li)} onChange={(e) => toggleLines(f.path, i, [li], e.target.checked)} />
                          <span>
                            {l.kind}
                            {l.text}
                          </span>
                        </label>
                      ) : l.kind === ' ' ? (
                        <div key={li} className="hunk-line ctx">
                          <span>&nbsp;{l.text}</span>
                        </div>
                      ) : null,
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    );
  };

  const group = (id: string, title: string, list: GitFile[], changelist?: string) => {
    if (list.length === 0 && (!changelist || changelist === 'default' && lists.length === 1)) return null;
    const isActive = changelist === active;
    return (
      <div key={id}>
        <div
          className="result-file"
          onClick={() => setClosed({ ...closed, [id]: !closed[id] })}
          onContextMenu={(e) =>
            id !== 'conflicts' &&
            showContextMenu(e, [
              { label: 'Rollback…', icon: <RotateCcw size={14} />, danger: true, disabled: list.length === 0, run: () => void rollback(list.map((f) => f.path)) },
              ...(changelist
                ? ([
                    'separator',
                    { label: 'Set Active Changelist', disabled: isActive, run: () => setActiveChangelist(changelist) },
                    { label: 'New Changelist…', run: () => void newChangelist() },
                    { label: 'Rename…', run: () => void renameChangelist(changelist) },
                    { label: 'Delete Changelist', disabled: changelist === 'default', danger: true, run: () => void deleteChangelist(changelist) },
                  ] as MenuItem[])
                : []),
            ])
          }
        >
          {closed[id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {id !== 'conflicts' && (
            <input
              type="checkbox"
              checked={list.length > 0 && list.every(checked)}
              disabled={list.length === 0}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setChecked(list, e.target.checked)}
            />
          )}
          {id === 'conflicts' && <GitMerge size={14} className="sev-warning" />}
          <span style={{ fontWeight: isActive ? 600 : undefined }}>{title}</span>
          {isActive && lists.length > 1 && <span className="badge">active</span>}
          <span className="muted">
            {list.length} file{list.length === 1 ? '' : 's'}
          </span>
        </div>
        {!closed[id] && list.map(fileRow)}
      </div>
    );
  };

  const count = selected.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-header">
        <span className="panel-title">Commit</span>
        <button className="icon-btn sm" title="Refresh" onClick={() => refreshGit(0)}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" title="Rollback the checked files" disabled={count === 0} onClick={() => void rollback(selected.map((f) => f.path))}>
          <RotateCcw size={14} />
        </button>
        <button className="icon-btn sm" title="Shelve the checked files" disabled={count === 0} onClick={() => void shelveChanges(selected.map((f) => f.path))}>
          <PackageOpen size={14} />
        </button>
        <button className="icon-btn sm" title="Stash changes" disabled={files.length === 0} onClick={() => void stashChanges(count && count < files.length ? selected.map((f) => f.path) : undefined)}>
          <Archive size={14} />
        </button>
        <button className="icon-btn sm" title="New changelist" onClick={() => void newChangelist()}>
          <Plus size={14} />
        </button>
        <button className="icon-btn sm" title="Update project (pull)" onClick={() => void gitPull()}>
          <Download size={14} />
        </button>
        <button className="icon-btn sm" title="Push" onClick={() => void gitPush()}>
          <Upload size={14} />
        </button>
      </div>
      <GitOperationBar />
      <div className="search-form" style={{ paddingBottom: 4 }}>
        <button className="proc-chip" style={{ alignSelf: 'flex-start' }} onClick={(e) => showBranchMenu(e.currentTarget)} title="Branches">
          <GitBranch size={12} />
          <span>{status.branch ?? (status.detached ? 'detached HEAD' : '—')}</span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="muted">
              {status.ahead ? `↑${status.ahead}` : ''}
              {status.behind ? ` ↓${status.behind}` : ''}
            </span>
          )}
        </button>
      </div>
      <div className="result-list">
        {files.length === 0 && <div className="panel-empty">No changes. The working tree is clean.</div>}
        {group('conflicts', 'Merge Conflicts', conflicts)}
        {lists.map((l) => group(l.id, l.name, byList.get(l.id) ?? [], l.id))}
        {group('unversioned', 'Unversioned Files', unversioned)}
      </div>
      <div style={{ padding: 8, borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          className="commit-box"
          placeholder="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (message.trim() || amend) && count) {
              e.preventDefault();
              void doCommit(false);
            }
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label className="check" style={{ fontSize: 'var(--text-sm)' }}>
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend
          </label>
          <div className="flex-1" />
          {busy && <LoaderCircle size={14} className="spin muted" />}
          <button className="btn btn-primary btn-xs" disabled={!!busy || (!message.trim() && !amend) || (count === 0 && !amend)} onClick={() => void doCommit(false)} title={`Commit (${keyLabel('Ctrl+Enter')})`}>
            <GitCommitHorizontal size={14} /> Commit
          </button>
          <button className="btn btn-xs" disabled={!!busy || (!message.trim() && !amend) || (count === 0 && !amend)} onClick={() => void doCommit(true)}>
            Commit and Push…
          </button>
        </div>
        <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          {count} of {files.length} file{files.length === 1 ? '' : 's'} selected
          {partialFiles().length > 0 ? ` (${partialFiles().length} in part)` : ''} ·{' '}
          <a className="link-btn" style={{ padding: 0 }} onClick={() => void gitFetch()}>
            Fetch
          </a>
        </div>
      </div>
    </div>
  );
}
