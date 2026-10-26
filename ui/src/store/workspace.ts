import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { MetaDto, ProjectDto, WorkspaceStateDto } from '../api/types';
import { basename, samePath } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { toast } from './ui';

export interface Recent {
  path: string;
  name: string;
  openedAt: number;
}

interface WorkspaceStore {
  ws: WorkspaceStateDto;
  meta: MetaDto | null;
  recents: Recent[];
  /** The run configuration: a project path. */
  startup: string | null;
  files: string[] | null;
  apply(ws: WorkspaceStateDto): void;
  open(path: string): Promise<void>;
  close(): Promise<void>;
  reload(): Promise<void>;
  setStartup(path: string | null): void;
  loadFiles(): Promise<string[]>;
  invalidateFiles(): void;
  removeRecent(path: string): void;
}

const EMPTY: WorkspaceStateDto = { state: 'none', projects: [], warnings: [] };

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  ws: EMPTY,
  meta: null,
  recents: loadRaw<Recent[]>('recents', []),
  startup: null,
  files: null,
  apply: (ws) => {
    const prev = get().ws;
    const rootChanged = !samePath(prev.root, ws.root);
    let startup = rootChanged ? (ws.root ? loadRaw<Record<string, string>>('startup', {})[ws.root] ?? null : null) : get().startup;
    if (ws.state === 'ready' && (!startup || !ws.projects.some((p) => samePath(p.path, startup)))) {
      startup = ws.projects.find((p) => p.runnable)?.path ?? ws.projects[0]?.path ?? null;
    }
    set({ ws, startup, ...(rootChanged ? { files: null } : {}) });
  },
  open: async (path) => {
    try {
      const ws = await api.post<WorkspaceStateDto>('/workspace/open', { path });
      get().apply(ws);
      const recents = [{ path, name: basename(path), openedAt: Date.now() }, ...get().recents.filter((r) => !samePath(r.path, path))].slice(0, 12);
      set({ recents });
      save('recents', recents);
    } catch (e) {
      toast('error', `Cannot open ${basename(path)}`, errorText(e));
    }
  },
  close: async () => {
    await api.post('/workspace/close');
    set({ ws: EMPTY, startup: null, files: null });
  },
  reload: async () => {
    await api.post('/workspace/reload');
  },
  setStartup: (path) => {
    set({ startup: path });
    const root = get().ws.root;
    if (root) save('startup', { ...loadRaw<Record<string, string>>('startup', {}), [root]: path });
  },
  loadFiles: async () => {
    const cached = get().files;
    if (cached) return cached;
    if (!get().ws.root) return [];
    const files = await api.get<string[]>('/fs/files');
    set({ files });
    return files;
  },
  invalidateFiles: () => set({ files: null }),
  removeRecent: (path) => {
    const recents = get().recents.filter((r) => !samePath(r.path, path));
    set({ recents });
    save('recents', recents);
  },
}));

export function startupProject(): ProjectDto | undefined {
  const { ws, startup } = useWorkspace.getState();
  return ws.projects.find((p) => samePath(p.path, startup));
}

/** The project that owns a file or folder (the deepest project directory containing it). */
export function projectOf(path: string): ProjectDto | undefined {
  const { ws } = useWorkspace.getState();
  let best: ProjectDto | undefined;
  let bestLen = -1;
  const n = path.toLowerCase();
  for (const p of ws.projects) {
    const dir = p.path.replace(/[\\/][^\\/]+$/, '').toLowerCase();
    if ((n === dir || n.startsWith(dir + '\\') || n.startsWith(dir + '/')) && dir.length > bestLen) {
      best = p;
      bestLen = dir.length;
    }
  }
  return best;
}
