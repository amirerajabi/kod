import { create } from 'zustand';
import { load, save } from '../lib/storage';

export type DockPanel = 'explorer' | 'commit' | 'search' | 'nuget' | 'structure';
export type BottomTab = 'run' | 'debug' | 'build' | 'tests' | 'git' | 'nuget' | 'problems' | 'usages' | 'terminal';
export type PaletteMode = 'files' | 'commands' | 'symbols' | 'line';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface PromptRequest {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  /** Select this part of the initial value (e.g. the name without its extension). */
  select?: [number, number];
  validate?: (v: string) => string | null;
  resolve: (v: string | null) => void;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
  /** A third choice, e.g. "Don't save". */
  altLabel?: string;
  resolve: (v: 'ok' | 'alt' | 'cancel') => void;
}

interface Layout {
  dockVisible: boolean;
  dockWidth: number;
  dock: DockPanel;
  bottomVisible: boolean;
  bottomHeight: number;
  bottom: BottomTab;
}

interface UiState extends Layout {
  wsStatus: 'connecting' | 'open' | 'closed';
  engineError: string | null;
  palette: PaletteMode | null;
  paletteSeed: string;
  settingsOpen: boolean;
  newProjectOpen: boolean;
  shortcutsOpen: boolean;
  prompt: PromptRequest | null;
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  cursor: { line: number; column: number; selected: number };
  set(p: Partial<UiState>): void;
  setLayout(p: Partial<Layout>): void;
  showDock(panel: DockPanel): void;
  toggleDock(): void;
  showBottom(tab: BottomTab): void;
  toggleBottom(): void;
  openPalette(mode: PaletteMode, seed?: string): void;
  toast(t: Omit<Toast, 'id'>, ms?: number): void;
  dismiss(id: number): void;
}

const LAYOUT_DEFAULT: Layout = { dockVisible: true, dockWidth: 300, dock: 'explorer', bottomVisible: false, bottomHeight: 260, bottom: 'run' };
let toastId = 0;

export const DOCK_MIN = 200;
export const DOCK_MAX = 640;

export const useUi = create<UiState>((set, get) => {
  const persist = () => {
    const s = get();
    save('layout', { dockVisible: s.dockVisible, dockWidth: s.dockWidth, dock: s.dock, bottomVisible: s.bottomVisible, bottomHeight: s.bottomHeight, bottom: s.bottom });
  };
  return {
    ...load<Layout>('layout', LAYOUT_DEFAULT),
    wsStatus: 'connecting',
    engineError: null,
    palette: null,
    paletteSeed: '',
    settingsOpen: false,
    newProjectOpen: false,
    shortcutsOpen: false,
    prompt: null,
    confirm: null,
    toasts: [],
    cursor: { line: 1, column: 1, selected: 0 },
    set: (p) => set(p),
    setLayout: (p) => {
      set(p);
      persist();
    },
    showDock: (panel) => {
      set({ dock: panel, dockVisible: true });
      persist();
    },
    toggleDock: () => {
      set({ dockVisible: !get().dockVisible });
      persist();
    },
    showBottom: (tab) => {
      set({ bottom: tab, bottomVisible: true });
      persist();
    },
    toggleBottom: () => {
      set({ bottomVisible: !get().bottomVisible });
      persist();
    },
    openPalette: (mode, seed = '') => set({ palette: mode, paletteSeed: seed }),
    toast: (t, ms = 5000) => {
      const id = ++toastId;
      set({ toasts: [...get().toasts.slice(-4), { ...t, id }] });
      if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    },
    dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  };
});

export const toast = (kind: Toast['kind'], text: string, detail?: string, ms?: number) => useUi.getState().toast({ kind, text, detail }, ms);

export function askText(r: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => useUi.getState().set({ prompt: { ...r, resolve } }));
}

export function askConfirm(r: Omit<ConfirmRequest, 'resolve'>): Promise<'ok' | 'alt' | 'cancel'> {
  return new Promise((resolve) => useUi.getState().set({ confirm: { ...r, resolve } }));
}
