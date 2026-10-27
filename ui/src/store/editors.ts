import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { FileEditsDto, MetadataViewDto, RangeDto, TextEditDto } from '../api/types';
import { disposeModel, ensureModel, ensureVirtualModel, getEntry, isDirty, markSaved, onDirtyChange, renameEntry, type ModelEntry } from '../editor/models';
import { monaco } from '../editor/monaco';
import { basename, norm, samePath } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { useSettings } from './settings';
import { askConfirm, toast } from './ui';
import { useWorkspace } from './workspace';

export interface Tab {
  path: string;
  title: string;
  kind: 'file' | 'metadata' | 'diff' | 'history' | 'merge' | 'sql';
  preview: boolean;
  dirty: boolean;
  readOnly: boolean;
  /** Diff tabs: the file and the two sides (HEAD, ':' for the index, a commit hash, or 'working'). */
  diff?: DiffSpec;
}

export interface DiffSpec {
  path: string;
  left: string;
  right: string;
  title?: string;
}

export interface Reveal {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  seq: number;
}

interface EditorsState {
  tabs: Tab[];
  active: string | null;
  reveal: Reveal | null;
  open(path: string, opts?: { line?: number; column?: number; range?: RangeDto; preview?: boolean; focus?: boolean }): Promise<void>;
  openMetadata(view: MetadataViewDto): void;
  openDiff(spec: DiffSpec): void;
  /** Local History of a file: its revisions, each diffed against the current text. */
  /** Local History of a file, of a folder (`folder`: its changes across files), or of the selected lines of a file. */
  openHistory(path: string, opts?: { folder?: boolean; selection?: { start: number; end: number } }): void;
  /** The three-way merge tool for a conflicted file. */
  openMerge(path: string): void;
  activate(path: string): void;
  pin(path: string): void;
  close(path: string): Promise<boolean>;
  closeMany(paths: string[]): Promise<void>;
  move(from: number, to: number): void;
  /** `auto`: an Auto Save (no format on save, which would move the code under the caret). */
  save(path?: string, opts?: { auto?: boolean }): Promise<boolean>;
  saveAll(opts?: { auto?: boolean }): Promise<boolean>;
  renamed(from: string, to: string): void;
  deleted(path: string): void;
}

let seq = 0;
/** Formatting before save goes through the editor (the language providers live there). */
export const saveHooks: { formatBeforeSave?: (path: string) => Promise<void> } = {};

export const useEditors = create<EditorsState>((set, get) => ({
  tabs: [],
  active: null,
  reveal: null,

  open: async (path, opts = {}) => {
    const existing = get().tabs.find((t) => samePath(t.path, path));
    const range = opts.range;
    const reveal = range
      ? { path, line: range.startLine, column: range.startColumn, endLine: range.endLine, endColumn: range.endColumn, seq: ++seq }
      : opts.line
        ? { path, line: opts.line, column: opts.column ?? 1, seq: ++seq }
        : null;
    if (existing) {
      set({ active: existing.path, reveal: reveal ? { ...reveal, path: existing.path } : get().reveal });
      if (opts.preview === false && existing.preview) get().pin(existing.path);
      return;
    }
    let entry: ModelEntry;
    try {
      entry = await ensureModel(path);
    } catch (e) {
      toast('error', `Cannot open ${basename(path)}`, errorText(e));
      return;
    }
    const usePreview = (opts.preview ?? false) && useSettings.getState().settings.previewTabs;
    // a second open() of the same file (double-click) may have finished while this one was loading
    const raced = get().tabs.find((t) => samePath(t.path, entry.path));
    if (raced) {
      set({ active: raced.path, reveal: reveal ? { ...reveal, path: raced.path } : get().reveal });
      if (!usePreview && raced.preview) get().pin(raced.path);
      return;
    }
    set((s) => {
      let tabs = s.tabs;
      // a new preview replaces the previous preview tab (Rider / VS Code behaviour)
      const prevPreview = usePreview ? tabs.find((t) => t.preview && !t.dirty && !samePath(t.path, entry.path)) : undefined;
      const tab: Tab = { path: entry.path, title: basename(entry.path), kind: 'file', preview: usePreview, dirty: false, readOnly: entry.readOnly };
      const at = s.active ? tabs.findIndex((t) => samePath(t.path, s.active)) + 1 : tabs.length;
      if (prevPreview) {
        tabs = tabs.map((t) => (t === prevPreview ? tab : t));
        queueMicrotask(() => releaseModel(prevPreview.path));
      } else {
        tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
      }
      return { tabs, active: entry.path, reveal };
    });
    persistTabs();
  },

  openMetadata: (view) => {
    const path = view.uri;
    ensureVirtualModel(view.uri, path, view.text);
    const reveal = { path, line: view.range.startLine, column: view.range.startColumn, endLine: view.range.endLine, endColumn: view.range.endColumn, seq: ++seq };
    if (!get().tabs.some((t) => t.path === path))
      set((s) => ({ tabs: [...s.tabs, { path, title: view.title, kind: 'metadata', preview: false, dirty: false, readOnly: true }] }));
    set({ active: path, reveal });
  },

  openDiff: (spec) => {
    const path = `kod-diff:${spec.left}:${spec.right}:${spec.path}`;
    const side = (r: string) => (r === 'working' ? 'Working' : r === ':' ? 'Staged' : r === 'HEAD' ? 'HEAD' : r.slice(0, 7));
    const title = spec.title ?? `${basename(spec.path)} (${side(spec.left)} ↔ ${side(spec.right)})`;
    if (!get().tabs.some((t) => t.path === path)) set((s) => ({ tabs: [...s.tabs, { path, title, kind: 'diff', preview: false, dirty: false, readOnly: true, diff: spec }] }));
    set({ active: path });
  },

  openHistory: (file, opts = {}) => {
    const sel = opts.selection;
    const mode = opts.folder ? 'folder' : sel ? `selection:${sel.start}-${sel.end}` : '';
    const path = `kod-history:${mode ? `${mode}:` : ''}${file}`;
    const title = sel ? `${basename(file)} lines ${sel.start}–${sel.end} (History)` : `${basename(file) || file} (Local History)`;
    if (!get().tabs.some((t) => t.path === path)) set((s) => ({ tabs: [...s.tabs, { path, title, kind: 'history', preview: false, dirty: false, readOnly: true, diff: { path: file, left: mode, right: 'working' } }] }));
    set({ active: path });
  },

  openMerge: (file) => {
    const path = `kod-merge:${file}`;
    if (!get().tabs.some((t) => t.path === path))
      set((s) => ({ tabs: [...s.tabs, { path, title: `${basename(file)} (Merge)`, kind: 'merge', preview: false, dirty: false, readOnly: false, diff: { path: file, left: ':2', right: ':3' } }] }));
    set({ active: path });
  },

  activate: (path) => set({ active: path }),

  pin: (path) => set((s) => ({ tabs: s.tabs.map((t) => (samePath(t.path, path) ? { ...t, preview: false } : t)) })),

  close: async (path) => {
    const tab = get().tabs.find((t) => samePath(t.path, path));
    if (!tab) return true;
    const entry = getEntry(path);
    // Auto Save (Rider's): closing saves, no question
    if (entry && isDirty(entry) && tab.kind === 'file' && useSettings.getState().settings.autoSave === 'rider' && !entry.readOnly) {
      if (!(await get().save(path, { auto: true }))) return false;
    } else if (entry && isDirty(entry) && tab.kind === 'file') {
      set({ active: tab.path });
      const answer = await askConfirm({ title: 'Save changes?', message: `${tab.title} has unsaved changes.`, okLabel: 'Save', altLabel: "Don't save" });
      if (answer === 'cancel') return false;
      if (answer === 'ok' && !(await get().save(path))) return false;
    }
    set((s) => {
      const i = s.tabs.findIndex((t) => samePath(t.path, path));
      const tabs = s.tabs.filter((_, k) => k !== i);
      const active = samePath(s.active, path) ? (tabs[Math.min(i, tabs.length - 1)]?.path ?? null) : s.active;
      return { tabs, active };
    });
    releaseModel(tab.path);
    persistTabs();
    return true;
  },

  closeMany: async (paths) => {
    for (const p of paths) if (!(await get().close(p))) return;
  },

  move: (from, to) =>
    set((s) => {
      const tabs = [...s.tabs];
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t);
      return { tabs };
    }),

  save: async (path, opts) => {
    const p = path ?? get().active;
    if (!p) return false;
    const entry = getEntry(p);
    const tab = get().tabs.find((t) => samePath(t.path, p));
    if (!entry || !tab || tab.kind !== 'file' || entry.readOnly) return true;
    try {
      if (!opts?.auto && useSettings.getState().settings.formatOnSave && entry.model.getLanguageId() === 'csharp') await saveHooks.formatBeforeSave?.(entry.path);
      await api.post('/fs/write', { path: entry.path, text: entry.model.getValue() });
      markSaved(entry);
      return true;
    } catch (e) {
      toast('error', `Could not save ${tab.title}`, errorText(e));
      return false;
    }
  },

  saveAll: async (opts) => {
    let ok = true;
    for (const t of get().tabs) {
      const e = getEntry(t.path);
      if (e && isDirty(e)) ok = (await get().save(t.path, opts)) && ok;
    }
    return ok;
  },

  renamed: (from, to) => {
    const affected = get().tabs.filter((t) => samePath(t.path, from) || norm(t.path).startsWith(norm(from) + (from.includes('\\') ? '\\' : '/')));
    if (affected.length === 0) return;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (!affected.includes(t)) return t;
        const np = to + t.path.slice(from.length);
        renameEntry(t.path, np);
        return { ...t, path: np, title: basename(np) };
      }),
      active: s.active && affected.some((t) => samePath(t.path, s.active)) ? to + s.active.slice(from.length) : s.active,
    }));
    persistTabs();
  },

  deleted: (path) => {
    const gone = get().tabs.filter((t) => samePath(t.path, path) || norm(t.path).startsWith(norm(path) + (path.includes('\\') ? '\\' : '/')));
    for (const t of gone) {
      const e = getEntry(t.path);
      if (e && !isDirty(e)) void get().close(t.path);
    }
  },
}));

function releaseModel(path: string): void {
  if (path.startsWith('kod-diff:') || path.startsWith('kod-history:') || path.startsWith('kod-merge:')) return;
  if (path.startsWith('kod-metadata:') || path.startsWith('kod-sql:')) {
    disposeModel(path);
    return;
  }
  disposeModel(path);
  void api.post('/workspace/documentClosed', { path }).catch(() => undefined);
}

onDirtyChange((e) => {
  const dirty = isDirty(e);
  useEditors.setState((s) => ({
    tabs: s.tabs.map((t) => (samePath(t.path, e.path) ? { ...t, dirty, preview: dirty ? false : t.preview } : t)),
  }));
});

// ---------------------------------------------------------------- session restore (per workspace root)

function persistTabs(): void {
  const root = useWorkspace.getState().ws.root;
  if (!root) return;
  const { tabs, active } = useEditors.getState();
  const all = loadRaw<Record<string, { tabs: string[]; active: string | null }>>('sessions', {});
  all[norm(root)] = { tabs: tabs.filter((t) => t.kind === 'file').map((t) => t.path), active };
  save('sessions', all);
}

export async function restoreTabs(root: string): Promise<void> {
  const s = loadRaw<Record<string, { tabs: string[]; active: string | null }>>('sessions', {})[norm(root)];
  if (!s) return;
  for (const p of s.tabs) await useEditors.getState().open(p).catch(() => undefined);
  if (s.active && useEditors.getState().tabs.some((t) => samePath(t.path, s.active))) useEditors.getState().activate(s.active);
}

export async function closeAllTabs(): Promise<boolean> {
  const { tabs } = useEditors.getState();
  for (const t of [...tabs]) if (!(await useEditors.getState().close(t.path))) return false;
  return true;
}

// ---------------------------------------------------------------- applying multi-file edits (rename, code actions)

function toMonacoRange(r: RangeDto): monaco.IRange {
  return { startLineNumber: r.startLine, startColumn: r.startColumn, endLineNumber: r.endLine, endColumn: r.endColumn };
}

/** Applies offsets-free edits to a plain string (for files that are not open). */
function applyToText(text: string, edits: TextEditDto[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const off = (line: number, col: number) => Math.min(text.length, (lineStarts[line - 1] ?? text.length) + col - 1);
  const sorted = [...edits].sort((a, b) => off(b.range.startLine, b.range.startColumn) - off(a.range.startLine, a.range.startColumn));
  let out = text;
  for (const e of sorted) {
    const s = off(e.range.startLine, e.range.startColumn);
    const en = off(e.range.endLine, e.range.endColumn);
    out = out.slice(0, s) + e.newText + out.slice(en);
  }
  return out;
}

/** Open files get undoable editor edits (left unsaved, like Rider); closed files are rewritten on disk. */
export async function applyFileEdits(files: FileEditsDto[]): Promise<number> {
  let n = 0;
  for (const f of files) {
    if (f.deleted) {
      try {
        await api.post('/fs/delete', { path: f.path });
        const e = getEntry(f.path);
        if (e) markSaved(e);
        useEditors.getState().deleted(f.path);
        n++;
      } catch (e) {
        toast('error', `Could not delete ${basename(f.path)}`, errorText(e));
      }
      continue;
    }
    if (f.created) {
      try {
        await api.post('/fs/create', { path: f.path, isDir: false, text: f.newText ?? '' });
        await useEditors.getState().open(f.path);
        n++;
      } catch (e) {
        toast('error', `Could not create ${basename(f.path)}`, errorText(e));
      }
      continue;
    }
    const entry = getEntry(f.path);
    if (entry && !entry.ephemeral) {
      entry.model.pushEditOperations([], f.edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })), () => null);
      n++;
      continue;
    }
    try {
      const file = await api.get<{ text: string }>('/fs/read', { path: f.path });
      const next = applyToText(file.text, f.edits);
      await api.post('/fs/write', { path: f.path, text: next, label: 'Refactoring' });
      if (entry) {
        entry.model.setValue(next);
        markSaved(entry);
      }
      n++;
    } catch (e) {
      toast('error', `Could not update ${basename(f.path)}`, errorText(e));
    }
  }
  return n;
}
