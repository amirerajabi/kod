// Terminals (pseudo consoles in the engine). Each terminal's xterm.js instance lives here, outside React, so it keeps
// its scrollback while the tool window is hidden or another terminal is shown.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { basename } from '../lib/paths';
import { quoteFamily } from '../theme/fonts';
import { useSettings } from './settings';
import { toast, useUi } from './ui';
import { useWorkspace } from './workspace';

export interface TermInfo {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  exited: boolean;
}

interface TerminalsState {
  terms: TermInfo[];
  active: string | null;
  set(p: Partial<TerminalsState>): void;
}

export const useTerminals = create<TerminalsState>((set) => ({ terms: [], active: null, set: (p) => set(p) }));

interface Live {
  xterm: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
}

const live = new Map<string, Live>();

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm colours from the app's tokens (re-applied on theme changes). */
export function terminalTheme() {
  return {
    background: cssVar('--ed-bg'),
    foreground: cssVar('--ed-fg'),
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--ed-bg'),
    selectionBackground: cssVar('--ed-selection'),
    black: cssVar('--ansi-black'),
    red: cssVar('--ansi-red'),
    green: cssVar('--ansi-green'),
    yellow: cssVar('--ansi-yellow'),
    blue: cssVar('--ansi-blue'),
    magenta: cssVar('--ansi-magenta'),
    cyan: cssVar('--ansi-cyan'),
    white: cssVar('--ansi-white'),
  };
}

export function liveTerminal(id: string): Live | undefined {
  return live.get(id);
}

export async function newTerminal(cwd?: string): Promise<void> {
  const dir = cwd ?? useWorkspace.getState().ws.root ?? useWorkspace.getState().meta?.home;
  const xterm = new Terminal({
    ...terminalFont(),
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10_000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  const host = document.createElement('div');
  host.className = 'xterm-host';
  useUi.getState().showBottom('terminal');
  try {
    const info = await api.post<{ id: string; title: string; cwd: string; shell: string }>('/term/start', { cwd: dir, cols: 120, rows: 30 });
    live.set(info.id, { xterm, fit, host });
    // Ctrl+C copies when text is selected (else it interrupts); Ctrl+V pastes through the browser's paste event
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && !e.shiftKey && xterm.hasSelection()) {
        void navigator.clipboard.writeText(xterm.getSelection());
        xterm.clearSelection();
        e.preventDefault();
        return false;
      }
      if (k === 'v' || (k === 'c' && e.shiftKey)) {
        if (k === 'c') void navigator.clipboard.writeText(xterm.getSelection());
        return false;
      }
      // xterm maps Ctrl+letter by keyCode; synthesized keys (IME, remote input, automation) can carry keyCode 0
      if (e.keyCode === 0 && !e.shiftKey && /^[a-z]$/.test(k)) {
        xterm.input(String.fromCharCode(k.charCodeAt(0) - 96));
        e.preventDefault();
        return false;
      }
      return true;
    });
    xterm.onData((data) => void api.post(`/term/${info.id}/input`, { data }).catch(() => undefined));
    xterm.onResize(({ cols, rows }) => void api.post(`/term/${info.id}/resize`, { cols, rows }).catch(() => undefined));
    useTerminals.setState((st) => ({ terms: [...st.terms, { ...info, title: basename(info.cwd) || info.title, exited: false }], active: info.id }));
  } catch (e) {
    xterm.dispose();
    toast('error', 'Could not start a terminal', errorText(e));
  }
}

export function closeTerminal(id: string): void {
  void api.post(`/term/${id}/kill`).catch(() => undefined);
  live.get(id)?.xterm.dispose();
  live.delete(id);
  useTerminals.setState((s) => {
    const terms = s.terms.filter((t) => t.id !== id);
    return { terms, active: s.active === id ? (terms[terms.length - 1]?.id ?? null) : s.active };
  });
}

/** Engine events. */
export function onTerminalEvent(e: { type: string; id?: unknown; data?: unknown; exitCode?: unknown }): void {
  const id = String(e.id ?? '');
  if (e.type === 'term.output') live.get(id)?.xterm.write(String(e.data ?? ''));
  else if (e.type === 'term.exit') {
    live.get(id)?.xterm.write(`\r\n\x1b[2m[process exited with code ${e.exitCode}]\x1b[0m\r\n`);
    useTerminals.setState((s) => ({ terms: s.terms.map((t) => (t.id === id ? { ...t, exited: true } : t)) }));
  }
}

export function retheme(): void {
  const theme = terminalTheme();
  for (const t of live.values()) t.xterm.options.theme = theme;
}

function terminalFont(): { fontFamily: string; fontSize: number } {
  const s = useSettings.getState().settings;
  return { fontFamily: s.terminalFontFamily.trim() ? quoteFamily(s.terminalFontFamily) : s.fontFamily, fontSize: s.terminalFontSize || Math.max(10, s.fontSize - 1) };
}

/** Settings › Appearance font changes, applied to open terminals. */
export function refont(): void {
  const font = terminalFont();
  for (const t of live.values()) {
    t.xterm.options.fontFamily = font.fontFamily;
    t.xterm.options.fontSize = font.fontSize;
    if (t.host.isConnected) t.fit.fit();
  }
}
