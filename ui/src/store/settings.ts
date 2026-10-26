import { create } from 'zustand';
import { load, save } from '../lib/storage';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  /** The app theme used in light mode / dark mode (theme/themes.ts APP_THEMES). */
  appThemeLight: string;
  appThemeDark: string;
  /** The code theme ('match' = derived from the app theme). */
  codeTheme: string;
  autoCheckUpdates: boolean;
  reopenLastWorkspace: boolean;
  /** GitToolBox: author, date and summary of the caret line's last change at the end of the line. */
  inlineBlame: boolean;
  fontSize: number;
  fontFamily: string;
  ligatures: boolean;
  /** The window's font ('' = the system UI font) and its base size in px. */
  uiFontFamily: string;
  uiFontSize: number;
  /** The terminal font ('' = the editor font) and size (0 = editor size - 1). */
  terminalFontFamily: string;
  terminalFontSize: number;
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
  /** Inferred types and parameter names drawn in the code. */
  inlayHints: boolean;
  /** Usages / implementations above types and members (Rider's Code Vision). */
  codeVision: boolean;
  /** Roslyn IDE analyzers and the projects' analyzers while typing (suggestions, unused code), not only compiler errors. */
  inspections: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  appThemeLight: 'light',
  appThemeDark: 'dark',
  codeTheme: 'match',
  autoCheckUpdates: true,
  reopenLastWorkspace: true,
  inlineBlame: true,
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  ligatures: true,
  uiFontFamily: '',
  uiFontSize: 13,
  terminalFontFamily: '',
  terminalFontSize: 0,
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
  inlayHints: true,
  codeVision: true,
  inspections: true,
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
