import { create } from 'zustand';
import { load, loadRaw, save } from '../lib/storage';

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
  /** 'rider': saved when Kod loses focus, on a tab switch or close, before build / run / commit, and after a quiet moment. */
  autoSave: 'rider' | 'off' | 'afterDelay' | 'onFocusChange';
  /** Rider mode: save after this many seconds without typing or clicking. */
  autoSaveIdleSeconds: number;
  /** Bumped when a default changes for everyone (2: Auto Save on). */
  settingsVersion: number;
  saveBeforeBuild: boolean;
  previewTabs: boolean;
  showIgnored: boolean;
  /** Inferred types and parameter names drawn in the code. */
  inlayHints: boolean;
  /** Usages / implementations above types and members (Rider's Code Vision). */
  codeVision: boolean;
  /** Roslyn IDE analyzers and the projects' analyzers while typing (suggestions, unused code), not only compiler errors. */
  inspections: boolean;
  /** Rider's Power Save Mode: no inlay hints, Code Vision, inspections, inline blame, minimap or automatic completion popup. */
  powerSave: boolean;
  /** Kod's memory use in the status bar. */
  memoryIndicator: boolean;
  /** Above this (MB) the engine drops its caches and compilations, then warns; 0 = a quarter of the RAM (1–4 GB). */
  engineMemoryLimitMb: number;
  /** Give memory back to the system when Kod has been idle for a while. */
  idleTrim: boolean;
  /** Warn when the engine stays above its memory limit. */
  memoryWarnings: boolean;
  /** Finished build / run outputs kept per tool window (older ones are closed). */
  keepFinishedProcesses: number;
  /** AI ghost-text suggestions while typing. */
  aiInline: boolean;
  /** The model for inline completions ('' = a fast default of the provider). */
  aiInlineModel: string;
  /** How long typing must pause before a suggestion is requested (ms). */
  aiInlineDelay: number;
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
  autoSave: 'rider',
  autoSaveIdleSeconds: 15,
  settingsVersion: 2,
  saveBeforeBuild: true,
  previewTabs: true,
  showIgnored: false,
  inlayHints: true,
  codeVision: true,
  inspections: true,
  powerSave: false,
  memoryIndicator: true,
  engineMemoryLimitMb: 0,
  idleTrim: true,
  memoryWarnings: true,
  keepFinishedProcesses: 8,
  aiInline: false,
  aiInlineModel: '',
  aiInlineDelay: 400,
};

/** What Power Save Mode turns off on top of the user's own choices. */
function effective(p: Settings): Settings {
  return p.powerSave ? { ...p, inlayHints: false, codeVision: false, inspections: false, inlineBlame: false, minimap: false, aiInline: false } : p;
}

interface SettingsState {
  /** What the editor runs with: the user's choices, less what Power Save Mode turns off. */
  settings: Settings;
  /** The user's own choices (the Settings dialog shows and edits these). */
  prefs: Settings;
  update(p: Partial<Settings>): void;
}

const initial = migrate(load('settings', DEFAULT_SETTINGS));

/** Settings saved by an older Kod: Auto Save was off by default, now it is on (Rider's behaviour). */
function migrate(s: Settings): Settings {
  const stored = loadRaw<Partial<Settings>>('settings', {});
  if ((stored.settingsVersion ?? 1) >= 2) return s;
  const next = { ...s, settingsVersion: 2, autoSave: stored.autoSave && stored.autoSave !== 'off' ? stored.autoSave : ('rider' as const) };
  save('settings', next);
  return next;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: effective(initial),
  prefs: initial,
  update: (p) => {
    const prefs = { ...get().prefs, ...p };
    set({ prefs, settings: effective(prefs) });
    save('settings', prefs);
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
