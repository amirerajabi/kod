import { AlertTriangle, ArrowDown, ArrowUp, GitMerge, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { basename, dirname } from '../lib/paths';
import { acceptSide, openMerge, operationAction, operationLabel, refreshGit, useGit } from '../store/git';
import { useEditors } from '../store/editors';
import { toast } from '../store/ui';
import { FileIcon } from './common/icons';
import { Dialog } from './common/Dialog';

const useGitDialogs = create<{ conflicts: boolean; rebase: { hash: string; subject: string } | null }>(() => ({ conflicts: false, rebase: null }));

export const showConflicts = () => useGitDialogs.setState({ conflicts: true });
export const showRebase = (hash: string, subject: string) => useGitDialogs.setState({ rebase: { hash, subject } });

/** The stopped merge / rebase / cherry-pick with its conflicts: Resolve, Continue, Skip, Abort (Commit window and status bar). */
export function GitOperationBar() {
  const status = useGit((s) => s.status);
  const busy = useGit((s) => s.busy);
  const conflicts = status?.files.filter((f) => f.conflicted) ?? [];
  if (!status?.operation && conflicts.length === 0) return null;
  const op = status?.operation;
  return (
    <div className="git-op-bar">
      <AlertTriangle size={14} className="sev-warning" />
      <span className="flex-1">
        <b>{op ? `${operationLabel(op)} in progress` : 'Unresolved conflicts'}</b>
        {conflicts.length > 0 && <span className="muted"> · {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}</span>}
      </span>
      {conflicts.length > 0 && (
        <button className="btn btn-xs btn-primary" onClick={showConflicts}>
          Resolve…
        </button>
      )}
      {op && (
        <>
          <button className="btn btn-xs" disabled={!!busy || conflicts.length > 0} title={conflicts.length ? 'Resolve the conflicts first' : undefined} onClick={() => void operationAction('continue')}>
            Continue
          </button>
          {op !== 'merge' && (
            <button className="btn btn-xs" disabled={!!busy} onClick={() => void operationAction('skip')}>
              Skip
            </button>
          )}
          <button className="btn btn-xs btn-ghost" disabled={!!busy} onClick={() => void operationAction('abort')}>
            Abort
          </button>
        </>
      )}
    </div>
  );
}

export function GitDialogs() {
  const { conflicts, rebase } = useGitDialogs();
  return (
    <>
      {conflicts && <ConflictsDialog />}
      {rebase && <RebaseDialog hash={rebase.hash} subject={rebase.subject} />}
    </>
  );
}

// ---------------------------------------------------------------- conflicts

/** Rider's Conflicts dialog: every conflicted file, Accept Yours / Accept Theirs / Merge…. */
function ConflictsDialog() {
  const status = useGit((s) => s.status);
  const files = status?.files.filter((f) => f.conflicted) ?? [];
  const [sel, setSel] = useState<Set<string>>(new Set());
  const close = () => useGitDialogs.setState({ conflicts: false });
  const rebase = status?.operation === 'rebase';
  useEffect(() => {
    if (status && files.length === 0) close();
  }, [files.length, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = files.filter((f) => sel.has(f.path)).map((f) => f.path);
  const targets = chosen.length ? chosen : files.map((f) => f.path);
  return (
    <Dialog
      title="Conflicts"
      onClose={close}
      width={640}
      footer={
        <>
          <button className="btn" onClick={() => void acceptSide(targets, 'ours')}>
            Accept {rebase ? 'Upstream' : 'Yours'}
            {chosen.length ? ` (${chosen.length})` : ' (all)'}
          </button>
          <button className="btn" onClick={() => void acceptSide(targets, 'theirs')}>
            Accept {rebase ? 'From Commit' : 'Theirs'}
            {chosen.length ? ` (${chosen.length})` : ' (all)'}
          </button>
          <div className="flex-1" />
          <button className="btn" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className="muted" style={{ marginBottom: 8 }}>
        {rebase ? 'During a rebase, "upstream" is the branch being rebased onto and "from commit" is your commit being replayed.' : 'Yours is the current branch; theirs is the branch being merged in.'} Merge… opens the three-way merge tool.
      </div>
      <div className="result-list" style={{ maxHeight: 340, border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
        {files.map((f) => (
          <div key={f.path} className="result-item">
            <input
              type="checkbox"
              checked={sel.has(f.path)}
              onChange={() => {
                const n = new Set(sel);
                if (n.has(f.path)) n.delete(f.path);
                else n.add(f.path);
                setSel(n);
              }}
            />
            <FileIcon path={f.path} size={14} />
            <span className="msg git-conflict">{basename(f.path)}</span>
            <span className="loc">{dirname(f.rel) === f.rel ? '' : dirname(f.rel)}</span>
            <button
              className="btn btn-xs btn-primary"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                close();
                openMerge(f.path);
              }}
            >
              <GitMerge size={12} /> Merge…
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- interactive rebase

interface PlanCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
}

type Action = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
const ACTIONS: [Action, string][] = [
  ['pick', 'Pick'],
  ['reword', 'Reword'],
  ['edit', 'Edit (stop)'],
  ['squash', 'Squash'],
  ['fixup', 'Fixup'],
  ['drop', 'Drop'],
];

/** Rider's Interactively Rebase from Here: reorder, reword, squash, fixup, edit or drop the commits. */
function RebaseDialog({ hash, subject }: { hash: string; subject: string }) {
  const [rows, setRows] = useState<(PlanCommit & { action: Action; message: string })[] | null>(null);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => useGitDialogs.setState({ rebase: null });

  useEffect(() => {
    api.get<PlanCommit[]>('/git/rebase/plan', { hash }).then(
      (list) => setRows(list.map((c) => ({ ...c, action: 'pick', message: c.subject }))),
      (e) => setError(errorText(e)),
    );
  }, [hash]);

  const update = (i: number, p: Partial<NonNullable<typeof rows>[number]>) => setRows(rows!.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const move = (d: -1 | 1) => {
    if (!rows) return;
    const j = sel + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[sel], next[j]] = [next[j], next[sel]];
    setRows(next);
    setSel(j);
  };
  const firstKept = rows?.find((r) => r.action !== 'drop');
  const invalid = !rows ? 'Loading' : firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup') ? 'The first commit cannot be squashed into a previous one' : rows.every((r) => r.action === 'drop') ? 'Every commit would be dropped' : null;

  const start = async () => {
    if (!rows || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await useEditors.getState().saveAll();
      const r = await api.post<{ message: string }>('/git/rebase', { hash, steps: rows.map((x) => ({ hash: x.hash, action: x.action, message: x.action === 'reword' ? x.message : null })) });
      close();
      toast(r.message === 'Rebase done' ? 'success' : 'warning', r.message, undefined, 6000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      refreshGit(0);
    }
  };

  return (
    <Dialog
      title={`Rebase from "${subject}"`}
      onClose={close}
      width={760}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto', fontSize: 'var(--text-xs)' }}>
            Oldest commit first. Uncommitted changes are stashed and restored.
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !!invalid} onClick={() => void start()}>
            {busy ? <LoaderCircle size={14} className="spin" /> : null} Start Rebasing
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <button className="btn btn-xs" onClick={() => move(-1)} disabled={!rows || sel <= 0} title="Move up (earlier)">
          <ArrowUp size={12} />
        </button>
        <button className="btn btn-xs" onClick={() => move(1)} disabled={!rows || sel >= rows.length - 1} title="Move down (later)">
          <ArrowDown size={12} />
        </button>
      </div>
      {!rows && !error && (
        <div className="panel-empty">
          <LoaderCircle size={16} className="spin" />
        </div>
      )}
      {rows && (
        <table className="sig-table">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Action</th>
              <th style={{ width: 80 }}>Commit</th>
              <th>Message</th>
              <th style={{ width: 120 }}>Author</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.hash} className={`${i === sel ? 'selected' : ''}${r.action === 'drop' ? ' dropped' : ''}`} onClick={() => setSel(i)}>
                <td>
                  <select className="input sm" value={r.action} onChange={(e) => update(i, { action: e.target.value as Action })}>
                    {ACTIONS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="muted" style={{ fontFamily: 'var(--font-mono)' }}>
                  {r.short}
                </td>
                <td>{r.action === 'reword' ? <input className="input sm" value={r.message} onChange={(e) => update(i, { message: e.target.value })} autoFocus /> : <span style={{ textDecoration: r.action === 'drop' ? 'line-through' : undefined }}>{r.subject}</span>}</td>
                <td className="muted">{r.author}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(error || (invalid && invalid !== 'Loading')) && <div className="form-error">{error ?? invalid}</div>}
    </Dialog>
  );
}
