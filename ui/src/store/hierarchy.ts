import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { HierarchyItemDto } from '../api/types';
import { toast, useUi } from './ui';

export type HierarchyKind = 'call' | 'type';
export type HierarchyDirection = 'callers' | 'callees' | 'supertypes' | 'subtypes';

interface HierarchyState {
  kind: HierarchyKind;
  direction: HierarchyDirection;
  root: HierarchyItemDto | null;
  loading: boolean;
  /** Children by node key (the ids from the root down, so a recursive call is its own node). */
  children: Record<string, HierarchyItemDto[] | 'loading'>;
  open: Record<string, boolean>;
  setDirection(d: HierarchyDirection): void;
  toggle(key: string, item: HierarchyItemDto): void;
}

export const nodeKey = (parent: string, item: HierarchyItemDto) => (parent ? `${parent}/${item.id}` : item.id);

async function load(key: string, item: HierarchyItemDto): Promise<void> {
  const { direction } = useHierarchy.getState();
  useHierarchy.setState((s) => ({ children: { ...s.children, [key]: 'loading' } }));
  try {
    const list = await api.post<HierarchyItemDto[]>('/intel/hierarchy/children', { id: item.id, direction });
    if (useHierarchy.getState().direction !== direction) return;
    useHierarchy.setState((s) => ({ children: { ...s.children, [key]: list } }));
  } catch (e) {
    useHierarchy.setState((s) => ({ children: { ...s.children, [key]: [] } }));
    toast('error', 'Hierarchy failed', errorText(e));
  }
}

export const useHierarchy = create<HierarchyState>((set, get) => ({
  kind: 'call',
  direction: 'callers',
  root: null,
  loading: false,
  children: {},
  open: {},
  setDirection: (direction) => {
    const root = get().root;
    set({ direction, children: {}, open: root ? { [root.id]: true } : {} });
    if (root) void load(root.id, root);
  },
  toggle: (key, item) => {
    const open = !get().open[key];
    set({ open: { ...get().open, [key]: open } });
    if (open && !get().children[key]) void load(key, item);
  },
}));

/** Ctrl+Alt+H / Ctrl+H: the call or type hierarchy of the symbol at the caret, in the Hierarchy tool window. */
export async function showHierarchy(kind: HierarchyKind, req: { path?: string; text: string; line: number; column: number }): Promise<void> {
  const direction: HierarchyDirection = kind === 'call' ? 'callers' : 'subtypes';
  useHierarchy.setState({ kind, direction, root: null, loading: true, children: {}, open: {} });
  useUi.getState().showBottom('hierarchy');
  try {
    const root = await api.post<HierarchyItemDto | undefined>(`/intel/hierarchy/root?kind=${kind}`, req);
    useHierarchy.setState({ root: root ?? null, loading: false, open: root ? { [root.id]: true } : {} });
    if (root) void load(root.id, root);
  } catch (e) {
    useHierarchy.setState({ loading: false });
    toast('error', 'Hierarchy failed', errorText(e));
  }
}
