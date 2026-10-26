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

export async function commit(message: string, paths: string[] | null, amend: boolean, push: boolean): Promise<boolean> {
  await useEditors.getState().saveAll();
  const ok = await op(amend ? 'Amend commit' : 'Commit', async () => {
    const r = await api.post<{ hash: string }>('/git/commit', { message, paths, amend });
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
