import { Archive, GitCommitHorizontal, PackageOpen, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { copyText } from '../app/actions';
import { basename, dirname, relative } from '../lib/paths';
import { branchAt, checkoutRevision, cherryPick, deleteShelf, openDiff, resetTo, revertCommit, stashAction, stashChanges, unshelve, useGit, type GitCommit } from '../store/git';
import { showRebase } from './GitDialogs';
import type { MenuItem } from './common/Menu';
import { FileIcon } from './common/icons';
import { showContextMenu } from './common/Menu';

interface CommitDetail {
  hash: string;
  message: string;
  files: { status: string; path: string; origPath?: string }[];
}

const STATUS: Record<string, string> = { A: 'git-added', M: 'git-modified', D: 'git-deleted', R: 'git-renamed', C: 'git-added' };

/** Rider's Git window (Log tab): history of all branches, a filter, and the selected commit's message and files. */
/** Rider's Git window: the Log, the stashes and the shelf. */
export function GitLogPanel() {
  const [tab, setTab] = useState<'log' | 'stash' | 'shelf'>('log');
  const isRepo = useGit((s) => s.status?.isRepo);
  if (!isRepo) return <div className="panel-empty">This folder is not under Git.</div>;
  return (
    <>
      <div className="subtabs">
        {(['log', 'stash', 'shelf'] as const).map((t) => (
          <button key={t} className={`subtab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t === 'log' ? 'Log' : t === 'stash' ? 'Stashes' : 'Shelf'}
          </button>
        ))}
      </div>
      {tab === 'log' && <LogTab />}
      {tab === 'stash' && <StashTab />}
      {tab === 'shelf' && <ShelfTab />}
    </>
  );
}

function LogTab() {
  const rev = useGit((s) => s.rev);
  const root = useGit((s) => s.status?.root);
  const isRepo = useGit((s) => s.status?.isRepo);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.get<GitCommit[]>('/git/log', { all: true, max: '500' }).then(setCommits, () => setCommits([])).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (isRepo) load();
  }, [rev, isRepo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected) return setDetail(null);
    let cancelled = false;
    api.get<CommitDetail>('/git/commit', { hash: selected }).then((d) => !cancelled && setDetail(d), () => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? commits.filter((c) => `${c.subject} ${c.author} ${c.hash} ${c.refs.join(' ')}`.toLowerCase().includes(q)) : commits;
  }, [commits, filter]);

  if (!isRepo) return <div className="panel-empty">This folder is not under Git.</div>;

  const commit = commits.find((c) => c.hash === selected);

  return (
    <>
      <div className="console-toolbar">
        <input className="input sm" style={{ width: 260 }} placeholder="Filter by message, author, hash or branch" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon-btn sm" title="Refresh" onClick={load}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
        </button>
        <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          {shown.length} commit{shown.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="split-pane">
        <div className="pane-left" style={{ width: '58%' }}>
          <div className="result-list">
            {shown.map((c) => (
              <div
                key={c.hash}
                className={`result-item${c.hash === selected ? ' selected' : ''}`}
                style={{ paddingLeft: 10 }}
                onClick={() => setSelected(c.hash)}
                onContextMenu={(e) =>
                  showContextMenu(e, [
                    { label: 'Copy Revision Number', run: () => void copyText(c.hash, 'Hash') },
                    { label: 'Copy Message', run: () => void copyText(c.subject, 'Message') },
                    'separator',
                    { label: 'Checkout Revision', run: () => void checkoutRevision(c.hash) },
                    { label: 'New Branch…', run: () => void branchAt(c.hash) },
                    'separator',
                    { label: 'Cherry-Pick', run: () => void cherryPick(c.hash, c.subject) },
                    { label: 'Revert Commit', run: () => void revertCommit(c.hash, c.subject) },
                    {
                      label: 'Reset Current Branch to Here',
                      submenu: [
                        { label: 'Soft (keep changes staged)', run: () => void resetTo(c.hash, 'soft') },
                        { label: 'Mixed (keep changes unstaged)', run: () => void resetTo(c.hash, 'mixed') },
                        { label: 'Keep (drop commits, keep local changes)', run: () => void resetTo(c.hash, 'keep') },
                        { label: 'Hard (drop commits and changes)', danger: true, run: () => void resetTo(c.hash, 'hard') },
                      ] as MenuItem[],
                    },
                    { label: 'Interactively Rebase from Here…', run: () => showRebase(c.hash, c.subject) },
                  ])
                }
                title={`${c.hash}\n${c.author} <${c.email}>\n${new Date(c.date).toLocaleString()}`}
              >
                <GitCommitHorizontal size={13} className="muted" />
                {c.refs.map((r) => (
                  <span key={r} className={`ref-badge${r.startsWith('tag: ') ? ' tag' : r.includes('/') ? ' remote' : ''}`}>
                    {r.replace(/^tag: /, '')}
                  </span>
                ))}
                <span className="msg">{c.subject}</span>
                <span className="loc" style={{ marginLeft: 'auto' }}>
                  {c.author} · {new Date(c.date).toLocaleDateString()}
                </span>
              </div>
            ))}
            {!loading && shown.length === 0 && <div className="panel-empty">No commits{filter ? ' match the filter' : ' yet'}.</div>}
          </div>
        </div>
        <div className="pane-right">
          {!detail || !commit ? (
            <div className="panel-empty">Select a commit to see its changes.</div>
          ) : (
            <>
              <div className="details">
                <div style={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>{detail.message}</div>
                <div className="muted" style={{ marginTop: 6 }}>
                  {commit.short} · {commit.author} &lt;{commit.email}&gt; · {new Date(commit.date).toLocaleString()}
                </div>
              </div>
              <div className="section-label">{detail.files.length} changed file{detail.files.length === 1 ? '' : 's'}</div>
              <div className="result-list">
                {detail.files.map((f) => (
                  <div
                    key={f.path}
                    className="result-item"
                    style={{ paddingLeft: 10 }}
                    title={relative(root, f.path)}
                    onClick={() => openDiff(f.path, commit.parents[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904', commit.hash, `${basename(f.path)} (${commit.short})`)}
                  >
                    <FileIcon path={f.path} size={14} />
                    <span className={`msg ${STATUS[f.status] ?? ''}`}>{basename(f.path)}</span>
                    <span className="loc">{relative(root, dirname(f.path))}</span>
                    <span className="loc" style={{ marginLeft: 'auto' }}>{f.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

interface Stash {
  ref: string;
  hash: string;
  time: number;
  message: string;
}

interface Shelf {
  id: string;
  name: string;
  time: number;
  files: string[];
}

/** git stash: apply, pop, drop and the stashed files. */
function StashTab() {
  const rev = useGit((s) => s.rev);
  const root = useGit((s) => s.status?.root);
  const [list, setList] = useState<Stash[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<CommitDetail['files']>([]);

  useEffect(() => {
    api.get<Stash[]>('/git/stashes').then(setList, () => setList([]));
  }, [rev]);
  useEffect(() => {
    if (!selected) return setFiles([]);
    api.get<CommitDetail['files']>('/git/stash/files', { ref: selected }).then(setFiles, () => setFiles([]));
  }, [selected, rev]);
  const cur = list.find((s) => s.ref === selected);

  return (
    <>
      <div className="console-toolbar">
        <button className="btn btn-xs" onClick={() => void stashChanges()} title="Stash all uncommitted changes, untracked files included">
          <Archive size={12} /> Stash Changes…
        </button>
        {cur && (
          <>
            <div className="topbar-sep" />
            <button className="btn btn-xs" onClick={() => void stashAction(cur.ref, 'apply')}>
              Apply
            </button>
            <button className="btn btn-xs" onClick={() => void stashAction(cur.ref, 'pop')} title="Apply and drop">
              Pop
            </button>
            <button className="btn btn-xs btn-ghost" onClick={() => void stashAction(cur.ref, 'drop')}>
              <Trash2 size={12} /> Drop
            </button>
          </>
        )}
      </div>
      <div className="split-pane">
        <div className="pane-left" style={{ width: '50%' }}>
          <div className="result-list">
            {list.length === 0 && <div className="panel-empty">No stashes.</div>}
            {list.map((s) => (
              <div key={s.ref} className={`result-item${s.ref === selected ? ' selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setSelected(s.ref)} onDoubleClick={() => void stashAction(s.ref, 'apply')}>
                <Archive size={13} className="muted" />
                <span className="msg">{s.message}</span>
                <span className="loc" style={{ marginLeft: 'auto' }}>
                  {s.ref} · {new Date(s.time).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="pane-right">
          <div className="result-list">
            {!cur && <div className="panel-empty">Select a stash to see its files.</div>}
            {cur &&
              files.map((f) => (
                <div
                  key={f.path + f.status}
                  className="result-item"
                  style={{ paddingLeft: 10 }}
                  title={relative(root, f.path)}
                  onClick={() => (f.status === 'U' ? openDiff(f.path, 'empty', `${cur.ref}^3`, `${basename(f.path)} (${cur.ref})`) : openDiff(f.path, `${cur.ref}^1`, cur.ref, `${basename(f.path)} (${cur.ref})`))}
                >
                  <FileIcon path={f.path} size={14} />
                  <span className={`msg ${STATUS[f.status] ?? (f.status === 'U' ? 'git-untracked' : '')}`}>{basename(f.path)}</span>
                  <span className="loc">{relative(root, dirname(f.path))}</span>
                  <span className="loc" style={{ marginLeft: 'auto' }}>
                    {f.status}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** Rider's shelf: changes set aside as patches (outside the stash), unshelved when needed. */
function ShelfTab() {
  const rev = useGit((s) => s.rev);
  const [list, setList] = useState<Shelf[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState('');

  useEffect(() => {
    api.get<Shelf[]>('/git/shelves').then(setList, () => setList([]));
  }, [rev]);
  useEffect(() => {
    if (!selected) return setPatch('');
    api.get<{ text: string }>('/git/shelf/patch', { id: selected }).then((r) => setPatch(r.text), () => setPatch(''));
  }, [selected]);
  const cur = list.find((s) => s.id === selected);

  return (
    <>
      <div className="console-toolbar">
        <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
          Shelve checked files from the Commit window (Shelve Changes…).
        </span>
        {cur && (
          <>
            <div className="flex-1" />
            <button className="btn btn-xs" onClick={() => void unshelve(cur.id, true)}>
              <PackageOpen size={12} /> Unshelve
            </button>
            <button className="btn btn-xs" onClick={() => void unshelve(cur.id, false)} title="Apply the changes and keep the shelf">
              Unshelve (keep shelf)
            </button>
            <button className="btn btn-xs btn-ghost" onClick={() => void deleteShelf(cur.id, cur.name)}>
              <Trash2 size={12} /> Delete
            </button>
          </>
        )}
      </div>
      <div className="split-pane">
        <div className="pane-left" style={{ width: '40%' }}>
          <div className="result-list">
            {list.length === 0 && <div className="panel-empty">The shelf is empty.</div>}
            {list.map((s) => (
              <div key={s.id} className={`result-item${s.id === selected ? ' selected' : ''}`} style={{ paddingLeft: 10 }} onClick={() => setSelected(s.id)} title={s.files.join('\n')}>
                <PackageOpen size={13} className="muted" />
                <span className="msg">{s.name}</span>
                <span className="loc" style={{ marginLeft: 'auto' }}>
                  {s.files.length} file{s.files.length === 1 ? '' : 's'} · {new Date(s.time).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="pane-right">
          {!cur ? (
            <div className="panel-empty">Select a shelf to see its changes.</div>
          ) : (
            <pre className="patch-view">
              {patch.split('\n').map((l, i) => (
                <div key={i} className={l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') ? 'patch-file' : l.startsWith('+') ? 'patch-add' : l.startsWith('-') ? 'patch-del' : l.startsWith('@@') ? 'patch-hunk' : undefined}>
                  {l || ' '}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </>
  );
}
