import { create } from 'zustand';
import { load, save } from '../lib/storage';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  fontFamily: string;
  ligatures: boolean;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  renderWhitespace: 'none' | 'selection' | 'all';
  formatOnSave: boolean;
  autoSave: 'off' | 'afterDelay' | 'onFocusChange';
  saveBeforeBuild: boolean;
  previewTabs: boolean;
  showIgnored: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  ligatures: true,
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  minimap: true,
  stickyScroll: true,
  renderWhitespace: 'selection',
  formatOnSave: false,
  autoSave: 'off',
  saveBeforeBuild: true,
  previewTabs: true,
  showIgnored: false,
};

interface SettingsState {
  settings: Settings;
  update(p: Partial<Settings>): void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: load('settings', DEFAULT_SETTINGS),
  update: (p) => {
    const settings = { ...get().settings, ...p };
    set({ settings });
    save('settings', settings);
  },
}));

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function effectiveTheme(s: Settings = useSettings.getState().settings): 'dark' | 'light' {
  return s.theme === 'system' ? (media.matches ? 'dark' : 'light') : s.theme;
}

export function onSystemThemeChange(cb: () => void): () => void {
  media.addEventListener('change', cb);
  return () => media.removeEventListener('change', cb);
}
