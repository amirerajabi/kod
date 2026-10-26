// Git (the engine runs the git CLI): working tree status, branches, history, and the actions of Rider's Commit and
// Git windows. Network operations (fetch, pull, push) run as processes so their output shows in the Build window.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { norm } from '../lib/paths';
import { runAndWait } from './procs';
import { askConfirm, askText, toast, useUi } from './ui';
import { useEditors } from './editors';
import { useWorkspace } from './workspace';

export interface GitFile {
  path: string;
  rel: string;
  index: string;
  workTree: string;
  origPath?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitFile[];
  /** The merge, rebase, cherry-pick or revert that stopped (conflicts, an edit). */
  operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
}

export interface GitBranch {
  name: string;
  hash: string;
  upstream?: string;
  current: boolean;
  remote: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  refs: string[];
  subject: string;
}

interface GitState {
  status: GitStatus | null;
  /** Bumped on every refresh: views that cache HEAD content (the gutter) reload. */
  rev: number;
  busy: string | null;
  set(p: Partial<GitState>): void;
}

export const useGit = create<GitState>((set) => ({ status: null, rev: 0, busy: null, set: (p) => set(p) }));

/** The change kind of a file for colours and badges. */
export function changeKind(f: GitFile): 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict' {
  if (f.conflicted) return 'conflict';
  if (f.untracked) return 'untracked';
  const x = f.index !== '.' ? f.index : f.workTree;
  return x === 'A' ? 'added' : x === 'D' ? 'deleted' : x === 'R' || x === 'C' ? 'renamed' : 'modified';
}

export function statusOf(path: string): GitFile | undefined {
  const n = norm(path);
  return useGit.getState().status?.files.find((f) => norm(f.path) === n);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;

export function refreshGit(delay = 300): void {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (inflight || !useWorkspace.getState().ws.root) return;
    inflight = true;
    try {
      const status = await api.get<GitStatus>('/git/status');
      useGit.setState((s) => ({ status, rev: s.rev + 1 }));
    } catch {
      useGit.setState({ status: null });
    } finally {
      inflight = false;
    }
  }, delay);
}

async function op(label: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  useGit.setState({ busy: label });
  try {
    await fn();
    if (ok) toast('success', ok, undefined, 2500);
    return true;
  } catch (e) {
    toast('error', `${label} failed`, errorText(e), 8000);
    return false;
  } finally {
    useGit.setState({ busy: null });
    refreshGit(0);
  }
}

export const stage = (paths: string[]) => op('Stage', () => api.post('/git/stage', { paths }));
export const unstage = (paths: string[]) => op('Unstage', () => api.post('/git/unstage', { paths }));

export async function rollback(paths: string[]): Promise<void> {
  const n = paths.length;
  const answer = await askConfirm({
    title: 'Rollback changes',
    message: `Discard the changes in ${n === 1 ? paths[0].split(/[\\/]/).pop() : `${n} files`}?\n\nModified files go back to the last commit; new (unversioned) files are deleted. This cannot be undone.`,
    okLabel: 'Rollback',
    danger: true,
  });
  if (answer !== 'ok') return;
  await op('Rollback', () => api.post('/git/discard', { paths }), `Rolled back ${n} file${n === 1 ? '' : 's'}`);
}

/** A file committed in part: the chosen hunks and, per hunk, the chosen changed lines (null = the whole hunk). */
export interface PartialFile {
  path: string;
  hunks: { index: number; lines: number[] | null }[];
}

export async function commit(message: string, paths: string[] | null, amend: boolean, push: boolean, partial?: PartialFile[]): Promise<boolean> {
  await useEditors.getState().saveAll();
  const ok = await op(amend ? 'Amend commit' : 'Commit', async () => {
    const r = await api.post<{ hash: string }>('/git/commit', { message, paths, amend, partial: partial?.length ? partial : undefined });
    toast('success', `Committed ${r.hash}`, message.split('\n')[0], 3000);
  });
  if (ok && push) await gitPush();
  return ok;
}

async function gitProc(title: string, args: string[]): Promise<boolean> {
  const root = useGit.getState().status?.root ?? useWorkspace.getState().ws.root;
  if (!root) return false;
  useGit.setState({ busy: title });
  const r = await runAndWait({ kind: 'git', title, file: 'git', args, cwd: root, env: { GIT_TERMINAL_PROMPT: '0' } });
  useGit.setState({ busy: null });
  refreshGit(0);
  if (r?.exitCode === 0) {
    toast('success', `${title} done`, undefined, 2500);
    return true;
  }
  useUi.getState().toast({ kind: 'error', text: `${title} failed`, detail: 'See the Build window for git’s output.', action: { label: 'Show output', run: () => useUi.getState().showBottom('build') } }, 8000);
  return false;
}

export const gitFetch = () => gitProc('Fetch', ['fetch', '--all', '--prune']);
export const gitPull = () => gitProc('Update project', ['pull', '--ff-only']);

export async function gitPush(): Promise<boolean> {
  const s = useGit.getState().status;
  // nowhere to push yet: Rider asks for a remote first
  if (!s?.upstream) {
    const remotes = await api.get<{ name: string }[]>('/git/remotes').catch(() => []);
    if (remotes.length === 0) {
      toast('info', 'Add a remote to push to', 'This repository has no remote yet.');
      useUi.getState().set({ remotesOpen: true });
      return false;
    }
  }
  return gitProc('Push', s?.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
}

export async function checkout(name: string): Promise<void> {
  await op('Checkout', () => api.post('/git/checkout', { name, create: false }), `Checked out ${name}`);
}

export async function newBranch(): Promise<void> {
  const name = await askText({
    title: 'New branch',
    label: `From ${useGit.getState().status?.branch ?? 'HEAD'}`,
    placeholder: 'feature/my-change',
    okLabel: 'Create',
    validate: (v) => (/^[^\s~^:?*[\\]+$/.test(v) && !v.startsWith('-') && !v.endsWith('.') && !v.includes('..') ? null : 'Not a valid branch name'),
  });
  if (name) await op('New branch', () => api.post('/git/checkout', { name, create: true }), `Switched to new branch ${name}`);
}

export async function deleteBranch(name: string): Promise<void> {
  if ((await askConfirm({ title: 'Delete branch', message: `Delete the local branch ${name}?`, okLabel: 'Delete', danger: true })) !== 'ok') return;
  const ok = await op('Delete branch', () => api.post('/git/deleteBranch', { name, create: false }), `Deleted ${name}`);
  if (!ok && (await askConfirm({ title: 'Branch not merged', message: `${name} has commits that are not merged. Delete it anyway?`, okLabel: 'Force delete', danger: true })) === 'ok')
    await op('Delete branch', () => api.post('/git/deleteBranch', { name, create: true }), `Deleted ${name}`);
}

export const initRepository = () => op('Init repository', () => api.post('/git/init'), 'Created a Git repository');

/** Opens a diff tab: the file at `left` (HEAD, ':' index, or a commit) against the working copy or another revision. */
export function openDiff(path: string, left = 'HEAD', right = 'working', title?: string): void {
  useEditors.getState().openDiff({ path, left, right, title });
}

// ---------------------------------------------------------------- merge / rebase / cherry-pick in progress

const OP_LABEL: Record<string, string> = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };
export const operationLabel = (op: string) => OP_LABEL[op] ?? op;

/** Continue, abort or skip the stopped merge / rebase / cherry-pick / revert. */
export async function operationAction(action: 'continue' | 'abort' | 'skip'): Promise<void> {
  const st = useGit.getState().status;
  const opName = st?.operation ? operationLabel(st.operation) : 'Operation';
  if (action === 'continue' && st?.files.some((f) => f.conflicted)) {
    toast('warning', 'Resolve the conflicts first', `${st.files.filter((f) => f.conflicted).length} files still have conflicts.`);
    return;
  }
  if (action === 'abort' && (await askConfirm({ title: `Abort ${opName.toLowerCase()}`, message: `Abort the ${opName.toLowerCase()} and go back to where it started?`, okLabel: 'Abort', danger: true })) !== 'ok') return;
  await useEditors.getState().saveAll();
  await op(`${opName} ${action}`, async () => {
    const r = await api.post<{ message: string }>('/git/operation', { action });
    toast('info', r.message, undefined, 4000);
  });
}

export const acceptSide = (paths: string[], side: 'ours' | 'theirs') => op(side === 'ours' ? 'Accept yours' : 'Accept theirs', () => api.post('/git/acceptSide', { paths, side }));

/** Opens the three-way merge tool for a conflicted file. */
export function openMerge(path: string): void {
  useEditors.getState().openMerge(path);
}

// ---------------------------------------------------------------- commits from the log

const afterOp = (label: string) => {
  const opName = useGit.getState().status?.operation;
  if (opName) toast('warning', `${label} stopped`, 'There are conflicts: resolve them, then continue (Commit window).', 8000);
};

export async function cherryPick(hash: string, subject: string): Promise<void> {
  await op('Cherry-pick', () => api.post('/git/cherryPick', { hash }), `Cherry-picked "${subject}"`);
  afterOp('Cherry-pick');
}

export async function revertCommit(hash: string, subject: string): Promise<void> {
  if ((await askConfirm({ title: 'Revert commit', message: `Create a new commit that undoes "${subject}"?`, okLabel: 'Revert' })) !== 'ok') return;
  await op('Revert', () => api.post('/git/revertCommit', { hash }), `Reverted "${subject}"`);
  afterOp('Revert');
}

export async function resetTo(hash: string, mode: 'soft' | 'mixed' | 'hard' | 'keep'): Promise<void> {
  const what: Record<string, string> = {
    soft: 'Soft: the changes of the later commits stay staged.',
    mixed: 'Mixed: the changes of the later commits stay in the working tree, unstaged.',
    hard: 'Hard: the later commits AND all uncommitted changes are thrown away.',
    keep: 'Keep: the later commits are thrown away, uncommitted changes are kept.',
  };
  if ((await askConfirm({ title: `Reset ${useGit.getState().status?.branch ?? 'HEAD'} to ${hash.slice(0, 8)}`, message: what[mode], okLabel: 'Reset', danger: mode === 'hard' || mode === 'keep' })) !== 'ok') return;
  await op('Reset', () => api.post('/git/reset', { hash, mode }), `Reset to ${hash.slice(0, 8)}`);
}

export const checkoutRevision = (hash: string) => op('Checkout', () => api.post('/git/checkoutRevision', { hash }), `Checked out ${hash.slice(0, 8)} (detached HEAD)`);

export async function branchAt(hash: string): Promise<void> {
  const name = await askText({ title: 'New branch', label: `At ${hash.slice(0, 8)}`, placeholder: 'feature/my-change', okLabel: 'Create and checkout', validate: (v) => (/^[^\s~^:?*[\\]+$/.test(v) && !v.startsWith('-') ? null : 'Not a valid branch name') });
  if (name) await op('New branch', () => api.post('/git/branchAt', { hash, name, checkout: true }), `Switched to new branch ${name}`);
}

// ---------------------------------------------------------------- stash and shelf

export async function stashChanges(paths?: string[]): Promise<void> {
  const message = await askText({ title: 'Stash changes', label: paths?.length ? `${paths.length} selected file(s); untracked ones included` : 'All changes, untracked files included', placeholder: 'Message (optional)', okLabel: 'Stash' });
  if (message === null) return;
  await useEditors.getState().saveAll();
  await op('Stash', () => api.post('/git/stash', { message, includeUntracked: true, paths }), 'Changes stashed');
}

export async function stashAction(ref: string, action: 'apply' | 'pop' | 'drop'): Promise<void> {
  if (action === 'drop' && (await askConfirm({ title: 'Drop stash', message: `Delete ${ref}? This cannot be undone.`, okLabel: 'Drop', danger: true })) !== 'ok') return;
  await op(`Stash ${action}`, () => api.post('/git/stash/action', { ref, action }), action === 'drop' ? `Dropped ${ref}` : `Applied ${ref}`);
}

export async function shelveChanges(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    toast('info', 'Check the files to shelve');
    return;
  }
  const name = await askText({ title: 'Shelve changes', label: `${paths.length} file(s); the changes are saved aside and rolled back`, value: '', placeholder: 'Shelf name', okLabel: 'Shelve' });
  if (name === null) return;
  await useEditors.getState().saveAll();
  await op('Shelve', () => api.post('/git/shelve', { name, paths, keep: false }), 'Changes shelved');
}

export const unshelve = (id: string, remove = true) => op('Unshelve', () => api.post('/git/unshelve', { id, remove }), 'Changes unshelved');

export async function deleteShelf(id: string, name: string): Promise<void> {
  if ((await askConfirm({ title: 'Delete shelf', message: `Delete "${name}"? Its changes are lost.`, okLabel: 'Delete', danger: true })) !== 'ok') return;
  await op('Delete shelf', () => api.post('/git/shelf/delete', { id }));
}
