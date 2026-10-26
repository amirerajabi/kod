// Fonts (Settings › Appearance): the UI font and size go to CSS variables on <html>; the editor and terminal read the
// editor font from the settings. Installed font families come from the Local Font Access API where the shell allows
// it, else from a list of common ones.
import { useSettings } from '../store/settings';

const BASE_UI_SIZE = 13;
const TEXT_SIZES: [string, number][] = [
  ['--text-xs', 11],
  ['--text-sm', 12],
  ['--text-md', 13],
  ['--text-lg', 15],
];

export function applyFonts(): void {
  const s = useSettings.getState().settings;
  const root = document.documentElement.style;
  if (s.uiFontFamily.trim()) root.setProperty('--font-ui', `${quoteFamily(s.uiFontFamily)}, system-ui, sans-serif`);
  else root.removeProperty('--font-ui');
  const scale = s.uiFontSize / BASE_UI_SIZE;
  for (const [name, px] of TEXT_SIZES) {
    if (s.uiFontSize === BASE_UI_SIZE) root.removeProperty(name);
    else root.setProperty(name, `${Math.round(px * scale * 2) / 2}px`);
  }
}

/** A single family name gets quotes; a CSS font list is used as written. */
export function quoteFamily(family: string): string {
  const f = family.trim();
  return f.includes(',') || /^['"]/.test(f) ? f : `'${f}'`;
}

/** The first family of a CSS font list, unquoted. */
export function firstFamily(list: string): string {
  return (list.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '');
}

const COMMON_MONO = ['JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Consolas', 'Source Code Pro', 'Hack', 'Iosevka', 'SF Mono', 'Menlo', 'Monaco', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Courier New'];
const COMMON_UI = ['Segoe UI', 'Segoe UI Variable Text', 'Inter', 'Roboto', 'Open Sans', 'Noto Sans', 'Ubuntu', 'SF Pro Text', 'Helvetica Neue', 'Arial', 'Tahoma', 'Vazirmatn'];

let installed: Promise<string[]> | null = null;

interface LocalFont {
  family: string;
}

/** Installed font families (sorted), or the common ones when the browser cannot list them. */
export function installedFonts(kind: 'mono' | 'ui'): Promise<string[]> {
  installed ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
    if (!query) return [];
    try {
      const fonts = await query();
      return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  })();
  return installed.then((list) => {
    const common = kind === 'mono' ? COMMON_MONO : COMMON_UI;
    if (list.length === 0) return common;
    // monospaced families first for the code font (by name: the API does not say which are fixed-width)
    if (kind === 'mono') {
      const mono = list.filter((f) => /mono|code|consol|courier|hack|iosevka|menlo|monaco|fixed|terminal/i.test(f));
      return [...mono, ...list.filter((f) => !mono.includes(f))];
    }
    return list;
  });
}
