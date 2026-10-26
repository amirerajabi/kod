// Applies the chosen app theme and code theme: data-theme on <html> selects the tokens.css base block, the theme's
// overrides go on <html> as inline custom properties, and the editor (Monaco) theme is rebuilt from the result.
import { applyMonacoTheme } from '../editor/monaco';
import { platform } from '../platform';
import { effectiveTheme, useSettings, type Settings } from '../store/settings';
import { appThemeById, codeThemeById, MATCH_APP, matchVars, type AppTheme, type CodeTheme } from './themes';

let applied: string[] = [];

/** #rgb / #rrggbbaa / rgb() → #rrggbb (the title bar and Monaco take nothing else). */
export function hex6(value: string): string {
  const raw = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(raw);
  if (m) return '#' + (m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1].slice(0, 6));
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(raw);
  if (m) return '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return '#808080';
}

export function activeThemes(s: Settings = useSettings.getState().settings): { base: 'light' | 'dark'; app: AppTheme; code: CodeTheme | null } {
  const base = effectiveTheme(s);
  const app = appThemeById(base === 'dark' ? s.appThemeDark : s.appThemeLight) ?? appThemeById(base)!;
  const code = s.codeTheme === MATCH_APP ? null : (codeThemeById(s.codeTheme) ?? null);
  return { base, app, code };
}

export function applyThemes(): void {
  const { base, app, code } = activeThemes();
  const root = document.documentElement;
  root.dataset.theme = base;
  for (const k of applied) root.style.removeProperty(k);
  // an app theme's --syn-* palette only feeds "Match app theme"; the editor tokens come from the code theme
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(app.vars)) if (!k.startsWith('--syn-')) vars[k] = v;
  Object.assign(vars, code ? code.vars : matchVars(app));
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  applied = Object.keys(vars);
  try {
    applyMonacoTheme((code?.base ?? base) === 'dark');
  } catch (e) {
    // a bad colour must never stop the app from starting
    console.error('Editor theme failed', e);
  }
  const s = getComputedStyle(root);
  platform.setTitleBarTheme({ color: hex6(s.getPropertyValue('--bg-app')), symbolColor: hex6(s.getPropertyValue('--fg')), dark: base === 'dark' });
}
