import { ChevronDown, ChevronRight, Download, GitBranch, GitCommitHorizontal, LoaderCircle, Minus, Plus, RefreshCw, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { keyLabel } from '../app/commands';
import { basename, dirname } from '../lib/paths';
import { useEditors } from '../store/editors';
import { changeKind, commit, gitFetch, gitPull, gitPush, initRepository, openDiff, refreshGit, rollback, stage, unstage, useGit, type GitFile } from '../store/git';
import { FileIcon } from './common/icons';
import { showContextMenu, type MenuItem } from './common/Menu';
import { showBranchMenu } from './GitBranchMenu';

const LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' };

/** Rider's Commit window: changed files with check boxes, the message, Amend, Commit and Commit and Push. */
export function CommitPanel() {
  const status = useGit((s) => s.status);
  const busy = useGit((s) => s.busy);
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Record<string, boolean>>({ unversioned: true });

  useEffect(() => refreshGit(0), []);
  useEffect(() => {
    if (!amend || message) return;
    void api.get<{ message: string }>('/git/lastMessage').then((r) => setMessage(r.message), () => undefined);
  }, [amend]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = status?.files ?? [];
  const tracked = useMemo(() => files.filter((f) => !f.untracked), [files]);
  const unversioned = useMemo(() => files.filter((f) => f.untracked), [files]);
  // Rider: changed files are checked, unversioned ones are not until you tick them
  const checked = (f: GitFile) => (f.untracked ? excluded.has(`+${f.path}`) : !excluded.has(f.path));
  const toggle = (f: GitFile) =>
    setExcluded((s) => {
      const n = new Set(s);
      const key = f.untracked ? `+${f.path}` : f.path;
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const selected = files.filter(checked);

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
    if (await commit(message, selected.map((f) => f.path), amend, push)) {
      setMessage('');
      setAmend(false);
      setExcluded(new Set());
    }
  };

  const menuFor = (f: GitFile): MenuItem[] => [
    { label: 'Show Diff', shortcut: keyLabel('Ctrl+D'), run: () => openDiff(f.path, f.untracked ? 'HEAD' : 'HEAD', 'working') },
    { label: 'Open File', run: () => void useEditors.getState().open(f.path) },
    'separator',
    f.staged ? { label: 'Unstage', icon: <Minus size={14} />, run: () => void unstage([f.path]) } : { label: 'Stage', icon: <Plus size={14} />, run: () => void stage([f.path]) },
    { label: 'Rollback…', icon: <RotateCcw size={14} />, danger: true, run: () => void rollback([f.path]) },
  ];

  const group = (id: string, title: string, list: GitFile[]) =>
    list.length > 0 && (
      <div key={id}>
        <div className="result-file" onClick={() => setClosed({ ...closed, [id]: !closed[id] })}>
          {closed[id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <input
            type="checkbox"
            checked={list.every(checked)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const on = e.target.checked;
              setExcluded((s) => {
                const n = new Set(s);
                for (const f of list) {
                  const key = f.untracked ? `+${f.path}` : f.path;
                  if (f.untracked === on) n.add(key);
                  else n.delete(key);
                }
                return n;
              });
            }}
          />
          {title}
          <span className="muted">{list.length} file{list.length === 1 ? '' : 's'}</span>
        </div>
        {!closed[id] &&
          list.map((f) => {
            const kind = changeKind(f);
            return (
              <div
                key={f.path}
                className="result-item"
                style={{ paddingLeft: 22 }}
                title={`${f.rel}${f.staged ? ' (staged)' : ''}`}
                onDoubleClick={() => openDiff(f.path)}
                onContextMenu={(e) => showContextMenu(e, menuFor(f))}
              >
                <input type="checkbox" checked={checked(f)} onChange={() => toggle(f)} />
                <FileIcon path={f.path} size={14} />
                <span className={`msg git-${kind}`}>{basename(f.path)}</span>
                <span className="loc" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{dirname(f.rel) === f.rel ? '' : dirname(f.rel)}</span>
                <span className="loc" style={{ marginLeft: 'auto' }} title={f.staged ? 'Staged' : undefined}>
                  {LETTER[kind]}
                  {f.staged ? '•' : ''}
                </span>
              </div>
            );
          })}
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-header">
        <span className="panel-title">Commit</span>
        <button className="icon-btn sm" title="Refresh" onClick={() => refreshGit(0)}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" title="Rollback the checked files" disabled={selected.length === 0} onClick={() => void rollback(selected.map((f) => f.path))}>
          <RotateCcw size={14} />
        </button>
        <button className="icon-btn sm" title="Update project (pull)" onClick={() => void gitPull()}>
          <Download size={14} />
        </button>
        <button className="icon-btn sm" title="Push" onClick={() => void gitPush()}>
          <Upload size={14} />
        </button>
      </div>
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
        {group('changes', 'Changes', tracked)}
        {group('unversioned', 'Unversioned Files', unversioned)}
      </div>
      <div style={{ padding: 8, borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          className="commit-box"
          placeholder="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (message.trim() || amend) && selected.length) {
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
          <button className="btn btn-primary btn-xs" disabled={!!busy || (!message.trim() && !amend) || (selected.length === 0 && !amend)} onClick={() => void doCommit(false)} title={`Commit (${keyLabel('Ctrl+Enter')})`}>
            <GitCommitHorizontal size={14} /> Commit
          </button>
          <button className="btn btn-xs" disabled={!!busy || (!message.trim() && !amend) || (selected.length === 0 && !amend)} onClick={() => void doCommit(true)}>
            Commit and Push…
          </button>
        </div>
        <div className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          {selected.length} of {files.length} file{files.length === 1 ? '' : 's'} selected · <a className="link-btn" style={{ padding: 0 }} onClick={() => void gitFetch()}>Fetch</a>
        </div>
      </div>
    </div>
  );
}
