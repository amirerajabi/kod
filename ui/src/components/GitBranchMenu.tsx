import { Download, GitBranch, GitBranchPlus, GitCommitHorizontal, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api, errorText } from '../api/client';
import { checkout, deleteBranch, gitFetch, gitPull, gitPush, newBranch, useGit, type GitBranch as Branch } from '../store/git';
import { toast, useUi } from '../store/ui';
import { showMenuBelow, useMenu, type MenuItem } from './common/Menu';

/** Rider's Git branches popup: Update / Commit / Push, New Branch, then local and remote branches. */
export async function showBranchMenu(anchor: HTMLElement, above = false): Promise<void> {
  let branches: Branch[] = [];
  try {
    branches = await api.get<Branch[]>('/git/branches');
  } catch (e) {
    toast('warning', 'Git', errorText(e));
    return;
  }
  const local = branches.filter((b) => !b.remote);
  const remote = branches.filter((b) => b.remote);
  const status = useGit.getState().status;
  const branchItem = (b: Branch): MenuItem => ({
    label: b.name,
    icon: <GitBranch size={14} />,
    checked: b.current,
    shortcut: b.upstream && !b.remote ? `→ ${b.upstream}` : undefined,
    submenu: [
      { label: b.remote ? 'Checkout' : 'Checkout', disabled: b.current, run: () => void checkout(b.name) },
      ...(!b.remote ? ([{ label: 'Delete', icon: <Trash2 size={14} />, danger: true, disabled: b.current, run: () => void deleteBranch(b.name) }] as MenuItem[]) : []),
    ],
  });
  const items: MenuItem[] = [
    { label: 'Update Project…', icon: <Download size={14} />, run: () => void gitPull() },
    { label: 'Commit…', icon: <GitCommitHorizontal size={14} />, shortcut: 'Alt+0', run: () => useUi.getState().showDock('commit') },
    { label: status?.ahead ? `Push… (${status.ahead})` : 'Push…', icon: <Upload size={14} />, shortcut: 'Ctrl+Shift+K', run: () => void gitPush() },
    { label: 'Fetch', icon: <RefreshCw size={14} />, run: () => void gitFetch() },
    'separator',
    { label: 'New Branch…', icon: <GitBranchPlus size={14} />, run: () => void newBranch() },
    'separator',
    ...(local.length ? local.map(branchItem) : [{ label: 'No local branches', disabled: true } as MenuItem]),
    ...(remote.length ? (['separator', { label: 'Remote', disabled: true }, ...remote.map(branchItem)] as MenuItem[]) : []),
  ];
  if (above) {
    const r = anchor.getBoundingClientRect();
    useMenu.getState().show(r.left, Math.max(8, r.top - 8 - Math.min(items.length * 28 + 16, window.innerHeight * 0.7)), items);
  } else showMenuBelow(anchor, items);
}
