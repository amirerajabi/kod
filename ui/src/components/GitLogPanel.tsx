import { GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { copyText } from '../app/actions';
import { basename, dirname, relative } from '../lib/paths';
import { openDiff, useGit, type GitCommit } from '../store/git';
import { FileIcon } from './common/icons';
import { showContextMenu } from './common/Menu';

interface CommitDetail {
  hash: string;
  message: string;
  files: { status: string; path: string; origPath?: string }[];
}

const STATUS: Record<string, string> = { A: 'git-added', M: 'git-modified', D: 'git-deleted', R: 'git-renamed', C: 'git-added' };

/** Rider's Git window (Log tab): history of all branches, a filter, and the selected commit's message and files. */
export function GitLogPanel() {
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
