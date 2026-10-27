// GitHub pull requests of the open repository (Rider's Pull Requests window): the list, a PR's details, its file
// diffs, and Checkout / Create / Comment / Review / Merge. The engine talks to GitHub with the gh CLI's token,
// GH_TOKEN / GITHUB_TOKEN, or a token kept with the other secrets.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { join } from '../lib/paths';
import { platform } from '../platform';
import { useEditors } from './editors';
import { gitPush, refreshGit, useGit } from './git';
import { askConfirm, askText, toast, useUi } from './ui';

export interface GhRepo {
  host: string;
  owner: string;
  name: string;
  webUrl: string;
  remote: string;
}

export interface PullContext {
  repo?: GhRepo;
  signedIn: boolean;
  /** gh, settings, or the environment variable the token came from. */
  authSource?: string;
  user?: string;
  defaultBranch?: string;
  error?: string;
}

export type PullState = 'open' | 'closed' | 'merged';

export interface PullSummary {
  number: number;
  title: string;
  url: string;
  state: PullState;
  draft: boolean;
  author: string;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  /** The head commit's combined checks: success, failure, error, pending, expected. */
  checks?: string;
  /** approved, changes_requested, review_required. */
  review?: string;
  comments: number;
  additions: number;
  deletions: number;
}

export interface PullCheck {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
}

export interface PullReview {
  id: number;
  author: string;
  state: string;
  body: string;
  submittedAt?: string;
}

export interface PullComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface PullReviewComment {
  id: number;
  replyTo?: number;
  author: string;
  body: string;
  path: string;
  /** Null when the line is gone from the latest diff (outdated); then originalLine is where it was. */
  line?: number;
  originalLine?: number;
  side: 'LEFT' | 'RIGHT';
  createdAt: string;
  diffHunk: string;
  url: string;
}

export interface PullFile {
  path: string;
  prevPath?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
}

export interface PullDetail {
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullState;
  draft: boolean;
  merged: boolean;
  mergeable?: boolean;
  mergeableState?: string;
  author: string;
  headRef: string;
  headSha: string;
  headRepo?: string;
  sameRepo: boolean;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
  createdAt: string;
  updatedAt: string;
  commits: number;
  additions: number;
  deletions: number;
  checks: PullCheck[];
  reviews: PullReview[];
  comments: PullComment[];
  reviewComments: PullReviewComment[];
  files: PullFile[];
}

export type PullFilter = 'open' | 'closed' | 'all';

interface PullsState {
  context: PullContext | null;
  list: PullSummary[];
  loading: boolean;
  error: string | null;
  filter: PullFilter;
  mine: boolean;
  selected: number | null;
  detail: PullDetail | null;
  detailLoading: boolean;
  busy: string | null;
  /** The Create Pull Request dialog is open. */
  creating: boolean;
  set(p: Partial<PullsState>): void;
}

export const usePulls = create<PullsState>((set) => ({
  context: null,
  list: [],
  loading: false,
  error: null,
  filter: 'open',
  mine: false,
  selected: null,
  detail: null,
  detailLoading: false,
  busy: null,
  creating: false,
  set: (p) => set(p),
}));

const TOKEN_SECRET = 'github.token';
let tokenSent = false;

/** Hands the token saved in Settings (if any) to the engine, once per session. */
async function sendSavedToken(): Promise<void> {
  if (tokenSent) return;
  tokenSent = true;
  const token = await platform.getSecret(TOKEN_SECRET).catch(() => null);
  if (token) await api.post('/git/pulls/token', { token }).catch(() => undefined);
}

export async function loadContext(): Promise<PullContext | null> {
  usePulls.setState({ loading: true, error: null });
  try {
    await sendSavedToken();
    const context = await api.get<PullContext>('/git/pulls/context');
    usePulls.setState({ context });
    if (context.signedIn) await loadPulls();
    return context;
  } catch (e) {
    usePulls.setState({ error: errorText(e) });
    return null;
  } finally {
    usePulls.setState({ loading: false });
  }
}

export async function loadPulls(): Promise<void> {
  const { filter, mine } = usePulls.getState();
  usePulls.setState({ loading: true, error: null });
  try {
    const list = await api.get<PullSummary[]>('/git/pulls/list', { state: filter, mine });
    usePulls.setState({ list });
  } catch (e) {
    usePulls.setState({ list: [], error: errorText(e) });
  } finally {
    usePulls.setState({ loading: false });
  }
}

export function setFilter(p: { filter?: PullFilter; mine?: boolean }): void {
  usePulls.setState(p);
  void loadPulls();
}

let detailSeq = 0;

export async function selectPull(number: number | null): Promise<void> {
  const seq = ++detailSeq;
  usePulls.setState({ selected: number, detail: number === usePulls.getState().detail?.number ? usePulls.getState().detail : null, detailLoading: number !== null });
  if (number === null) return;
  try {
    const detail = await api.get<PullDetail>(`/git/pulls/${number}`);
    if (seq === detailSeq) usePulls.setState({ detail });
  } catch (e) {
    if (seq === detailSeq) toast('error', `Could not load #${number}`, errorText(e), 6000);
  } finally {
    if (seq === detailSeq) usePulls.setState({ detailLoading: false });
  }
}

/** Saves a token for GitHub with the other secrets (OS keychain); empty removes it. */
export async function setGithubToken(): Promise<void> {
  const token = await askText({
    title: 'GitHub token',
    label: 'A personal access token with the repo scope (empty to remove the saved one). Kept in the OS keychain.',
    placeholder: 'ghp_… or github_pat_…',
    okLabel: 'Save',
  });
  if (token === null) return;
  await platform.setSecret(TOKEN_SECRET, token.trim() || null);
  await api.post('/git/pulls/token', { token: token.trim() || null }).catch(() => undefined);
  tokenSent = true;
  await loadContext();
}

async function prOp(label: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  usePulls.setState({ busy: label });
  try {
    await fn();
    if (ok) toast('success', ok, undefined, 3000);
    return true;
  } catch (e) {
    toast('error', `${label} failed`, errorText(e), 8000);
    return false;
  } finally {
    usePulls.setState({ busy: null });
  }
}

/** Reloads the list and the selected PR after an action. */
async function reload(number: number): Promise<void> {
  await Promise.all([loadPulls(), usePulls.getState().selected === number ? selectPull(number) : Promise.resolve()]);
}

export async function checkoutPull(pr: { number: number; headRef: string }): Promise<void> {
  await useEditors.getState().saveAll();
  await prOp('Checkout', async () => {
    const r = await api.post<{ branch: string }>(`/git/pulls/${pr.number}/checkout`);
    toast('success', `Checked out #${pr.number}`, `On branch ${r.branch}`, 3000);
  });
  refreshGit(0);
}

export async function addComment(number: number, body: string): Promise<boolean> {
  const ok = await prOp('Comment', () => api.post(`/git/pulls/${number}/comment`, { body }), 'Comment added');
  if (ok) await reload(number);
  return ok;
}

export type ReviewEvent = 'approve' | 'request_changes' | 'comment';

export async function submitReview(number: number, event: ReviewEvent, body: string): Promise<boolean> {
  const label = event === 'approve' ? 'Approved' : event === 'request_changes' ? 'Requested changes' : 'Review submitted';
  const ok = await prOp('Review', () => api.post(`/git/pulls/${number}/review`, { event, body }), label);
  if (ok) await reload(number);
  return ok;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

const METHOD: Record<MergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };
export const mergeMethodLabel = (m: MergeMethod) => METHOD[m];

export async function mergePull(pr: { number: number; title: string; headRef: string; baseRef: string }, method: MergeMethod): Promise<void> {
  const answer = await askConfirm({
    title: `Merge #${pr.number}`,
    message: `${METHOD[method]}: ${pr.headRef} into ${pr.baseRef}?\n\n${pr.title}`,
    okLabel: method === 'merge' ? 'Merge' : method === 'squash' ? 'Squash and merge' : 'Rebase and merge',
  });
  if (answer !== 'ok') return;
  const ok = await prOp('Merge', async () => {
    const r = await api.post<{ message: string }>(`/git/pulls/${pr.number}/merge`, { method, title: method === 'squash' ? `${pr.title} (#${pr.number})` : undefined });
    toast('success', r.message, `#${pr.number} into ${pr.baseRef}`, 4000);
  });
  if (ok) await reload(pr.number);
}

export const openOnGitHub = (url: string) => platform.openExternal(url);

/** A changed file of a PR in a diff tab: the merge base on the left, the PR's head on the right. */
export function openPullFile(pr: PullDetail, f: PullFile): void {
  const root = useGit.getState().status?.root;
  if (!root) return;
  const left = f.status === 'added' ? 'empty' : `gh:${pr.mergeBaseSha}:${f.prevPath ?? f.path}`;
  const right = f.status === 'removed' ? 'empty' : `gh:${pr.headSha}:${f.path}`;
  useEditors.getState().openDiff({ path: join(root, f.path), left, right, title: `${f.path.split('/').pop()} (#${pr.number})` });
}

export function showCreatePullRequest(): void {
  useUi.getState().showBottom('pulls');
  usePulls.setState({ creating: true });
}

/** Creates a PR from the current branch, pushing it first when it has no upstream or unpushed commits. */
export async function createPullRequest(p: { title: string; body: string; base: string; draft: boolean }): Promise<boolean> {
  const status = useGit.getState().status;
  if (!status?.branch) {
    toast('warning', 'Check out a branch first', 'A pull request is made from a branch (HEAD is detached).');
    return false;
  }
  if (!status.upstream || status.ahead > 0) {
    if (!(await gitPush())) return false;
  }
  const upstream = useGit.getState().status?.upstream;
  const head = upstream ? upstream.slice(upstream.indexOf('/') + 1) : status.branch;
  const out: { pr?: PullSummary } = {};
  const ok = await prOp('Create pull request', async () => {
    out.pr = await api.post<PullSummary>('/git/pulls/create', { ...p, head });
  });
  const pr = out.pr;
  if (!ok || !pr) return false;
  useUi.getState().toast({ kind: 'success', text: `Created pull request #${pr.number}`, detail: pr.title, action: { label: 'Open on GitHub', run: () => openOnGitHub(pr.url) } }, 6000);
  usePulls.setState({ filter: 'open', mine: false });
  await loadPulls();
  void selectPull(pr.number);
  return true;
}
