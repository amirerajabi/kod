// Rider's Pull Requests tool window for GitHub: the repository's PRs (open / closed / all, mine), and the selected
// one's description, checks, changed files (each opening a diff), reviews, comments and inline review comments, with
// Checkout, Review, Merge and Open on GitHub; plus the Create Pull Request dialog for the current branch.
import {
  ChevronDown,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestCreate,
  GitPullRequestDraft,
  KeyRound,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { copyText } from '../app/actions';
import { basename, dirname } from '../lib/paths';
import { useGit, type GitBranch as Branch } from '../store/git';
import {
  addComment,
  checkoutPull,
  createPullRequest,
  loadContext,
  loadPulls,
  mergeMethodLabel,
  mergePull,
  openOnGitHub,
  openPullFile,
  selectPull,
  setFilter,
  setGithubToken,
  submitReview,
  usePulls,
  type MergeMethod,
  type PullDetail,
  type PullFilter,
  type PullReviewComment,
  type PullSummary,
  type ReviewEvent,
} from '../store/pulls';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';
import { FileIcon } from './common/icons';
import { showContextMenu, showMenuBelow } from './common/Menu';
import './pulls.css';

/** "5 min ago", "3 days ago", then the date. */
function ago(iso: string | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function StateIcon({ state, draft, size = 14 }: { state: string; draft: boolean; size?: number }) {
  if (state === 'merged') return <GitMerge size={size} className="pr-merged" />;
  if (state === 'closed') return <GitPullRequestClosed size={size} className="pr-closed" />;
  if (draft) return <GitPullRequestDraft size={size} className="muted" />;
  return <GitPullRequest size={size} className="pr-open" />;
}

/** The combined state of the checks: success, failure / error, or pending. */
function ChecksIcon({ state }: { state?: string }) {
  if (!state) return null;
  if (state === 'success') return <CircleCheck size={13} className="pr-ok" aria-label="Checks passed" />;
  if (state === 'failure' || state === 'error') return <CircleX size={13} className="pr-fail" aria-label="Checks failed" />;
  return <Clock size={13} className="pr-pending" aria-label="Checks running" />;
}

const REVIEW: Record<string, [string, string]> = {
  approved: ['Approved', 'pr-review-ok'],
  changes_requested: ['Changes requested', 'pr-review-changes'],
  review_required: ['Review required', ''],
};

export function PullRequestsPanel() {
  const root = useWorkspace((s) => s.ws.root);
  const isRepo = useGit((s) => s.status?.isRepo);
  const context = usePulls((s) => s.context);
  const loading = usePulls((s) => s.loading);
  const error = usePulls((s) => s.error);
  const creating = usePulls((s) => s.creating);

  useEffect(() => {
    if (root) void loadContext();
  }, [root]);

  let body;
  if (!root) body = <div className="panel-empty">Open a folder to see its pull requests.</div>;
  else if (isRepo === false) body = <div className="panel-empty">This folder is not under Git.</div>;
  else if (!context) body = <div className="panel-empty">{loading ? 'Connecting to GitHub…' : error ?? ''}</div>;
  else if (!context.repo) body = <div className="panel-empty">{context.error ?? 'The repository has no GitHub remote.'} Pull requests need a remote on GitHub (Git ▸ Manage Remotes…).</div>;
  else if (!context.signedIn) body = <SignIn />;
  else body = <PullsView />;

  return (
    <div className="pr-panel">
      {body}
      {creating && context?.signedIn && <CreatePullRequestDialog />}
    </div>
  );
}

function SignIn() {
  const context = usePulls((s) => s.context);
  const loading = usePulls((s) => s.loading);
  const host = context?.repo?.host ?? 'github.com';
  return (
    <div className="panel-empty pr-signin">
      <div style={{ fontWeight: 600, color: 'var(--fg)' }}>Sign in to GitHub to see the pull requests of {context?.repo ? `${context.repo.owner}/${context.repo.name}` : 'this repository'}</div>
      {context?.error && <div className="sev-error">{context.error}</div>}
      <div>
        Run <code>gh auth login{host !== 'github.com' ? ` --hostname ${host}` : ''}</code> in a terminal (GitHub CLI), or set the <code>GITHUB_TOKEN</code> environment variable, or use a personal access token.
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <button className="btn btn-xs" onClick={() => void setGithubToken()}>
          <KeyRound size={12} /> Use a Token…
        </button>
        <button className="btn btn-xs" onClick={() => void loadContext()} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'spin' : undefined} /> Retry
        </button>
      </div>
    </div>
  );
}

function PullsView() {
  const { context, list, loading, error, filter, mine, selected } = usePulls();
  const branch = useGit((s) => s.status?.branch);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? list.filter((p) => `#${p.number} ${p.title} ${p.author} ${p.headRef} ${p.baseRef}`.toLowerCase().includes(q)) : list;
  }, [list, query]);
  const current = branch ? list.find((p) => p.headRef === branch && p.state === 'open') : undefined;

  return (
    <>
      <div className="console-toolbar">
        <div className="pr-seg" role="group" aria-label="State">
          {(['open', 'closed', 'all'] as PullFilter[]).map((f) => (
            <button key={f} className={`subtab${filter === f ? ' active' : ''}`} onClick={() => setFilter({ filter: f })}>
              {f === 'open' ? 'Open' : f === 'closed' ? 'Closed' : 'All'}
            </button>
          ))}
        </div>
        <label className="check" style={{ fontSize: 'var(--text-sm)' }} title="Authored by me or waiting for my review">
          <input type="checkbox" checked={mine} onChange={(e) => setFilter({ mine: e.target.checked })} /> Mine
        </label>
        <input className="input sm" style={{ width: 220 }} placeholder="Filter by title, author, branch or #" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon-btn sm" title="Refresh" onClick={() => void loadPulls()}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
        </button>
        <button className="btn btn-xs" onClick={() => usePulls.setState({ creating: true })} title={branch ? `From ${branch}` : 'Check out a branch first'} disabled={!branch}>
          <GitPullRequestCreate size={12} /> Create Pull Request…
        </button>
        {current && (
          <button className="btn btn-xs btn-ghost" onClick={() => void selectPull(current.number)} title="The pull request of the current branch">
            <GitBranch size={12} /> #{current.number}
          </button>
        )}
        <div className="flex-1" />
        <span className="muted" style={{ fontSize: 'var(--text-xs)' }} title={`Signed in through ${context?.authSource}`}>
          {context?.repo?.owner}/{context?.repo?.name} · {context?.user}
        </span>
        <button className="icon-btn sm" title="GitHub token…" onClick={() => void setGithubToken()}>
          <KeyRound size={14} />
        </button>
      </div>
      <div className="split-pane">
        <div className="pane-left" style={{ width: '46%' }}>
          <div className="result-list">
            {error && <div className="panel-empty sev-error">{error}</div>}
            {!error && !loading && shown.length === 0 && <div className="panel-empty">No {filter === 'all' ? '' : `${filter} `}pull requests{mine ? ' of yours' : ''}{query ? ' match the filter' : ''}.</div>}
            {shown.map((p) => (
              <PullRow key={p.number} pr={p} selected={p.number === selected} />
            ))}
          </div>
        </div>
        <div className="pane-right">
          <PullDetailView />
        </div>
      </div>
    </>
  );
}

function PullRow({ pr, selected }: { pr: PullSummary; selected: boolean }) {
  const review = pr.review ? REVIEW[pr.review] : undefined;
  return (
    <div
      className={`result-item pr-row${selected ? ' selected' : ''}`}
      onClick={() => void selectPull(pr.number)}
      onDoubleClick={() => openOnGitHub(pr.url)}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: 'Open on GitHub', run: () => openOnGitHub(pr.url) },
          { label: 'Copy URL', run: () => void copyText(pr.url, 'URL') },
          'separator',
          { label: 'Checkout', disabled: pr.state === 'merged', run: () => void checkoutPull(pr) },
        ])
      }
      title={`#${pr.number} ${pr.title}\n${pr.author}: ${pr.headRef} → ${pr.baseRef}\nUpdated ${new Date(pr.updatedAt).toLocaleString()}`}
    >
      <StateIcon state={pr.state} draft={pr.draft} />
      <div className="pr-row-body">
        <div className="pr-row-title">
          <span className="msg">{pr.title}</span>
          {pr.draft && <span className="ref-badge remote">Draft</span>}
          {review?.[0] && <span className={`ref-badge ${review[1]}`}>{review[0]}</span>}
          <ChecksIcon state={pr.checks} />
        </div>
        <div className="loc">
          #{pr.number} · {pr.author} · {pr.headRef} → {pr.baseRef} · {ago(pr.updatedAt)}
          {pr.comments > 0 && (
            <>
              {' · '}
              <MessageSquare size={11} style={{ verticalAlign: -1 }} /> {pr.comments}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const CHECK_LABEL: Record<string, string> = { success: 'Passed', failure: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', neutral: 'Neutral', timed_out: 'Timed out', action_required: 'Action required', error: 'Error', stale: 'Stale' };

const FILE_STATUS: Record<string, [string, string]> = {
  added: ['A', 'git-added'],
  removed: ['D', 'git-deleted'],
  renamed: ['R', 'git-renamed'],
  copied: ['C', 'git-added'],
};

const REVIEW_STATE: Record<string, string> = { approved: 'approved', changes_requested: 'requested changes', commented: 'reviewed', dismissed: 'review dismissed' };

function PullDetailView() {
  const detail = usePulls((s) => s.detail);
  const selected = usePulls((s) => s.selected);
  const loadingDetail = usePulls((s) => s.detailLoading);
  const busy = usePulls((s) => s.busy);
  const [comment, setComment] = useState('');
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => setComment(''), [selected]);

  if (!selected) return <div className="panel-empty">Select a pull request to see its details.</div>;
  if (!detail) return <div className="panel-empty">{loadingDetail ? 'Loading…' : 'Could not load the pull request.'}</div>;
  const pr = detail;

  const byFile = new Map<string, PullReviewComment[]>();
  for (const c of pr.reviewComments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const timeline = [
    ...pr.comments.map((c) => ({ key: `c${c.id}`, at: c.createdAt, author: c.author, what: 'commented', body: c.body })),
    ...pr.reviews.filter((r) => r.body || r.state !== 'commented').map((r) => ({ key: `r${r.id}`, at: r.submittedAt ?? '', author: r.author, what: REVIEW_STATE[r.state] ?? r.state, body: r.body, state: r.state })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const failing = pr.checks.filter((c) => c.conclusion && ['failure', 'timed_out', 'cancelled', 'action_required', 'error'].includes(c.conclusion)).length;
  const pending = pr.checks.filter((c) => c.status !== 'completed').length;
  const open = pr.state === 'open';

  const send = async () => {
    if (await addComment(pr.number, comment)) setComment('');
  };

  return (
    <>
      <div className="details pr-head">
        <div className="pr-title">
          <StateIcon state={pr.state} draft={pr.draft} size={16} />
          <span>{pr.title}</span>
          <span className="muted">#{pr.number}</span>
          {loadingDetail && <RefreshCw size={12} className="spin muted" />}
        </div>
        <div className="muted pr-meta">
          <span className={`ref-badge pr-state-${pr.state}`}>{pr.draft && open ? 'Draft' : pr.state[0].toUpperCase() + pr.state.slice(1)}</span>
          {pr.author} wants to merge {pr.commits} commit{pr.commits === 1 ? '' : 's'} into <span className="ref-badge">{pr.baseRef}</span> from <span className="ref-badge remote">{pr.sameRepo ? pr.headRef : `${pr.headRepo ?? '?'}:${pr.headRef}`}</span>
          <span>
            · <span className="git-added">+{pr.additions}</span> <span className="pr-fail">−{pr.deletions}</span> · updated {ago(pr.updatedAt)}
          </span>
        </div>
        <div className="pr-actions">
          <button className="btn btn-xs" disabled={!!busy || pr.state === 'merged'} onClick={() => void checkoutPull(pr)} title={`Fetch the pull request and switch to ${pr.sameRepo ? pr.headRef : `pr/${pr.number}`}`}>
            <GitBranch size={12} /> Checkout
          </button>
          <button className="btn btn-xs" disabled={!!busy || !open} onClick={() => setReviewing(true)}>
            <MessageSquare size={12} /> Review…
          </button>
          <button
            className="btn btn-xs"
            disabled={!!busy || !open || pr.draft}
            title={pr.draft ? 'A draft cannot be merged' : pr.mergeable === false ? 'There are merge conflicts' : undefined}
            onClick={(e) => showMenuBelow(e.currentTarget, (['merge', 'squash', 'rebase'] as MergeMethod[]).map((m) => ({ label: mergeMethodLabel(m), run: () => void mergePull(pr, m) })))}
          >
            <GitMerge size={12} /> Merge <ChevronDown size={12} />
          </button>
          <button className="btn btn-xs btn-ghost" onClick={() => openOnGitHub(pr.url)}>
            <ExternalLink size={12} /> Open on GitHub
          </button>
          {busy && <span className="muted">{busy}…</span>}
          {open && pr.mergeable === false && <span className="pr-fail">Conflicts with {pr.baseRef}</span>}
          {open && pr.mergeable && pr.mergeableState === 'blocked' && <span className="pr-pending">Merging is blocked (required reviews or checks)</span>}
        </div>
        {pr.body.trim() ? <pre className="pr-body">{pr.body}</pre> : <div className="muted" style={{ marginTop: 8, fontStyle: 'italic' }}>No description.</div>}
      </div>

      {pr.checks.length > 0 && (
        <>
          <div className="section-label">
            Checks · {failing ? `${failing} failing` : pending ? `${pending} running` : 'all passed'}
          </div>
          <div className="result-list pr-section">
            {pr.checks.map((c, i) => (
              <div key={`${c.name}${i}`} className="result-item" onClick={() => c.url && openOnGitHub(c.url)} title={c.url}>
                {c.status !== 'completed' ? <Clock size={13} className="pr-pending" /> : c.conclusion === 'success' ? <CircleCheck size={13} className="pr-ok" /> : c.conclusion === 'skipped' || c.conclusion === 'neutral' ? <CircleMinus size={13} className="muted" /> : <CircleX size={13} className="pr-fail" />}
                <span className="msg">{c.name}</span>
                <span className="loc" style={{ marginLeft: 'auto' }}>
                  {c.status !== 'completed' ? (c.status === 'queued' ? 'Queued' : 'Running') : (CHECK_LABEL[c.conclusion ?? ''] ?? c.conclusion)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-label">
        {pr.files.length} changed file{pr.files.length === 1 ? '' : 's'}
      </div>
      <div className="result-list pr-section">
        {pr.files.map((f) => {
          const [letter, cls] = FILE_STATUS[f.status] ?? ['M', 'git-modified'];
          const notes = byFile.get(f.path)?.length ?? 0;
          return (
            <div key={f.path} className="result-item" onClick={() => openPullFile(pr, f)} title={f.prevPath ? `${f.prevPath} → ${f.path}` : f.path}>
              <FileIcon path={f.path} size={14} />
              <span className={`msg ${cls}`}>{basename(f.path)}</span>
              <span className="loc">{dirname(f.path) === f.path ? '' : dirname(f.path)}</span>
              {notes > 0 && (
                <span className="loc" title={`${notes} review comment${notes === 1 ? '' : 's'}`}>
                  <MessageSquare size={11} style={{ verticalAlign: -1 }} /> {notes}
                </span>
              )}
              <span className="loc pr-counts" style={{ marginLeft: 'auto' }}>
                <span className="git-added">+{f.additions}</span> <span className="pr-fail">−{f.deletions}</span> {letter}
              </span>
            </div>
          );
        })}
      </div>

      {byFile.size > 0 && (
        <>
          <div className="section-label">Review comments</div>
          <div className="pr-section">
            {[...byFile].map(([path, comments]) => {
              const file = pr.files.find((f) => f.path === path);
              return (
                <div key={path} className="pr-thread">
                  <div className="pr-thread-file" onClick={() => file && openPullFile(pr, file)} title={file ? 'Show the diff' : 'The file is no longer in the pull request'}>
                    <FileIcon path={path} size={13} /> {path}
                  </div>
                  {comments.map((c) => (
                    <div key={c.id} className={`pr-comment${c.replyTo ? ' reply' : ''}`}>
                      <div className="pr-comment-head">
                        <b>{c.author}</b>
                        <span className="muted">
                          {c.line ? `line ${c.line}` : `line ${c.originalLine ?? '?'} (outdated)`}
                          {c.side === 'LEFT' ? ', old side' : ''} · {ago(c.createdAt)}
                        </span>
                      </div>
                      <pre className="pr-comment-body">{c.body}</pre>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="section-label">Conversation</div>
      <div className="pr-section">
        {timeline.length === 0 && <div className="muted" style={{ padding: '4px 14px' }}>No comments yet.</div>}
        {timeline.map((t) => (
          <div key={t.key} className="pr-comment">
            <div className="pr-comment-head">
              <b>{t.author}</b>
              <span className={'state' in t ? (t.state === 'approved' ? 'pr-ok' : t.state === 'changes_requested' ? 'pr-fail' : 'muted') : 'muted'}>{t.what}</span>
              <span className="muted">· {ago(t.at)}</span>
            </div>
            {t.body && <pre className="pr-comment-body">{t.body}</pre>}
          </div>
        ))}
        <div className="pr-reply">
          <textarea
            className="commit-box"
            placeholder="Leave a comment (Ctrl+Enter)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment.trim()) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div>
            <button className="btn btn-xs btn-primary" disabled={!comment.trim() || !!busy} onClick={() => void send()}>
              Comment
            </button>
          </div>
        </div>
      </div>
      {reviewing && <ReviewDialog pr={pr} onClose={() => setReviewing(false)} />}
    </>
  );
}

function ReviewDialog({ pr, onClose }: { pr: PullDetail; onClose: () => void }) {
  const [event, setEvent] = useState<ReviewEvent>('comment');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const user = usePulls((s) => s.context?.user);
  const own = user === pr.author;
  const submit = async () => {
    setBusy(true);
    if (await submitReview(pr.number, event, body)) onClose();
    setBusy(false);
  };
  return (
    <Dialog
      title={`Review #${pr.number}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || (event !== 'approve' && !body.trim())} onClick={() => void submit()}>
            Submit Review
          </button>
        </>
      }
    >
      <textarea className="commit-box" style={{ minHeight: 110 }} placeholder="Leave a review comment" value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      <div className="pr-review-choice">
        {(
          [
            ['comment', 'Comment', 'General feedback without approving.'],
            ['approve', 'Approve', 'Approve merging these changes.'],
            ['request_changes', 'Request changes', 'Feedback that must be addressed before merging.'],
          ] as [ReviewEvent, string, string][]
        ).map(([v, label, help]) => (
          <label key={v} className="check" title={own && v !== 'comment' ? 'You cannot approve or request changes on your own pull request' : undefined}>
            <input type="radio" name="pr-review" checked={event === v} disabled={own && v !== 'comment'} onChange={() => setEvent(v)} />
            <span>
              {label} <span className="muted">— {help}</span>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

/** Create Pull Request from the current branch: title, description, base branch, draft. */
function CreatePullRequestDialog() {
  const context = usePulls((s) => s.context);
  const status = useGit((s) => s.status);
  const [branches, setBranches] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(context?.defaultBranch ?? 'main');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => usePulls.setState({ creating: false });
  const branch = status?.branch;
  const remote = context?.repo?.remote ?? 'origin';

  useEffect(() => {
    api.get<Branch[]>('/git/branches').then(
      (list) => setBranches(list.filter((b) => b.remote && b.name.startsWith(`${remote}/`)).map((b) => b.name.slice(remote.length + 1)).filter((b) => b !== branch)),
      () => setBranches([]),
    );
    api.get<{ message: string }>('/git/lastMessage').then(
      (r) => {
        const [subject, ...rest] = r.message.split('\n');
        setTitle((t) => t || subject || branch || '');
        setBody((b) => b || rest.join('\n').trim());
      },
      () => setTitle((t) => t || branch || ''),
    );
  }, [remote, branch]);

  const bases = [...new Set([context?.defaultBranch ?? 'main', ...branches])];
  const needsPush = !status?.upstream || (status?.ahead ?? 0) > 0;
  const create = async () => {
    setBusy(true);
    if (await createPullRequest({ title, body, base, draft })) close();
    setBusy(false);
  };

  return (
    <Dialog
      title="Create Pull Request"
      onClose={close}
      width={620}
      footer={
        <>
          <span className="muted" style={{ flex: 1, fontSize: 'var(--text-xs)' }}>
            {needsPush ? `${branch} is pushed to ${remote} first.` : ''}
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !branch || !title.trim() || base === branch} onClick={() => void create()}>
            {draft ? 'Create Draft' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form-grid" style={{ gridTemplateColumns: '90px 1fr' }}>
        <span className="form-label">Into</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="input" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch">
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <span className="muted">←</span>
          <span className="ref-badge remote">{branch ?? 'no branch'}</span>
        </div>
        <label className="form-label" htmlFor="pr-title">
          Title
        </label>
        <input id="pr-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <label className="form-label" htmlFor="pr-body" style={{ alignSelf: 'start', marginTop: 4 }}>
          Description
        </label>
        <textarea id="pr-body" className="commit-box" style={{ minHeight: 140 }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Markdown" />
        <span />
        <label className="check">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Create as draft
        </label>
      </div>
      {base === branch && <div className="form-error">Choose a base branch other than {branch}.</div>}
    </Dialog>
  );
}
