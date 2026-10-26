// Rider's changelists: named groups of changed files in the Commit window, one of them active (new changes land
// there, and its files are the ones checked for the next commit). Kept per repository in local storage.
import { create } from 'zustand';
import { norm } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { useGit } from './git';
import { askConfirm, askText } from './ui';

export interface Changelist {
  id: string;
  name: string;
}

interface State {
  lists: Changelist[];
  /** Changelist id by normalized file path; files not listed belong to the active list. */
  assign: Record<string, string>;
  active: string;
}

const DEFAULT: State = { lists: [{ id: 'default', name: 'Changes' }], assign: {}, active: 'default' };
const KEY = 'changelists';

export const useChangelists = create<State>(() => DEFAULT);

let repo: string | undefined;
useGit.subscribe((s) => {
  const root = s.status?.root;
  if (root === repo) return;
  repo = root;
  useChangelists.setState(root ? (loadRaw<Record<string, State>>(KEY, {})[norm(root)] ?? DEFAULT) : DEFAULT);
});

function persist(): void {
  if (!repo) return;
  const all = loadRaw<Record<string, State>>(KEY, {});
  all[norm(repo)] = useChangelists.getState();
  save(KEY, all);
}

function update(p: Partial<State>): void {
  useChangelists.setState(p);
  persist();
}

export function listOf(path: string): string {
  const s = useChangelists.getState();
  const id = s.assign[norm(path)];
  return id && s.lists.some((l) => l.id === id) ? id : s.active;
}

export function moveTo(paths: string[], id: string): void {
  const assign = { ...useChangelists.getState().assign };
  for (const p of paths) assign[norm(p)] = id;
  update({ assign });
}

export async function newChangelist(paths: string[] = []): Promise<void> {
  const name = await askText({ title: 'New changelist', placeholder: 'Feature work', okLabel: 'Create', validate: (v) => (useChangelists.getState().lists.some((l) => l.name === v) ? 'A changelist with that name exists' : null) });
  if (!name) return;
  const id = `cl${Date.now()}`;
  update({ lists: [...useChangelists.getState().lists, { id, name }] });
  if (paths.length) moveTo(paths, id);
}

export async function renameChangelist(id: string): Promise<void> {
  const cur = useChangelists.getState().lists.find((l) => l.id === id);
  if (!cur) return;
  const name = await askText({ title: 'Rename changelist', value: cur.name, okLabel: 'Rename' });
  if (name) update({ lists: useChangelists.getState().lists.map((l) => (l.id === id ? { ...l, name } : l)) });
}

export async function deleteChangelist(id: string): Promise<void> {
  const s = useChangelists.getState();
  if (id === 'default') return;
  const cur = s.lists.find((l) => l.id === id);
  if ((await askConfirm({ title: 'Delete changelist', message: `Delete "${cur?.name}"? Its files move to the active changelist.`, okLabel: 'Delete' })) !== 'ok') return;
  const assign = Object.fromEntries(Object.entries(s.assign).filter(([, v]) => v !== id));
  update({ lists: s.lists.filter((l) => l.id !== id), assign, active: s.active === id ? 'default' : s.active });
}

export function setActiveChangelist(id: string): void {
  // files that followed the old active list stay where they are
  const s = useChangelists.getState();
  const files = useGit.getState().status?.files ?? [];
  const assign = { ...s.assign };
  for (const f of files) if (!f.untracked && !assign[norm(f.path)]) assign[norm(f.path)] = s.active;
  update({ active: id, assign });
}
