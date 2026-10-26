// Rider's bookmarks: F11 toggles one on the caret line, Ctrl+Shift+digit a numbered one, Ctrl+digit jumps to it.
// They live per workspace, show in the gutter and move with the code while the file is edited.
import { create } from 'zustand';
import { norm, samePath } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { useEditors } from '../store/editors';
import { askText, toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { getEntry, pathOfModel } from './models';
import { monaco } from './monaco';

export interface Bookmark {
  path: string;
  line: number;
  /** A digit or letter (Ctrl+digit jumps to it). */
  mnemonic?: string;
  description?: string;
  /** The line's text when it was set, for files that are not open. */
  text?: string;
}

export const useBookmarks = create<{ list: Bookmark[] }>(() => ({ list: [] }));

const KEY = 'bookmarks';
let root: string | undefined;

function persist(): void {
  if (!root) return;
  const all = loadRaw<Record<string, Bookmark[]>>(KEY, {});
  all[norm(root)] = useBookmarks.getState().list;
  save(KEY, all);
}

useWorkspace.subscribe((s) => {
  if (s.ws.root === root) return;
  root = s.ws.root;
  useBookmarks.setState({ list: root ? (loadRaw<Record<string, Bookmark[]>>(KEY, {})[norm(root)] ?? []) : [] });
});

function lineText(path: string, line: number): string | undefined {
  const m = getEntry(path)?.model;
  return m && line <= m.getLineCount() ? m.getLineContent(line).trim().slice(0, 160) : undefined;
}

function set(list: Bookmark[]): void {
  useBookmarks.setState({ list });
  persist();
}

/** Toggles a bookmark on a line; with a mnemonic, moves that mnemonic here (or removes it when it is already here). */
export function toggleBookmark(path: string, line: number, mnemonic?: string): void {
  const list = useBookmarks.getState().list;
  const here = list.find((b) => samePath(b.path, path) && b.line === line);
  if (here && (!mnemonic || here.mnemonic === mnemonic)) {
    set(list.filter((b) => b !== here));
    return;
  }
  const others = list.filter((b) => b !== here).map((b) => (mnemonic && b.mnemonic === mnemonic ? { ...b, mnemonic: undefined } : b));
  set([...others, { ...here, path, line, mnemonic, text: lineText(path, line) }]);
}

export function toggleAtCaret(ed: monaco.editor.ICodeEditor | null, mnemonic?: string): void {
  const path = pathOfModel(ed?.getModel());
  const pos = ed?.getPosition();
  if (!path || !pos) return;
  toggleBookmark(path, pos.lineNumber, mnemonic);
}

/** Ctrl+F11: a bookmark with a mnemonic of your choice. */
export async function toggleWithMnemonic(ed: monaco.editor.ICodeEditor | null): Promise<void> {
  const m = await askText({ title: 'Bookmark with mnemonic', label: 'A digit or a letter', placeholder: '1', okLabel: 'Set', validate: (v) => (/^[0-9A-Za-z]$/.test(v) ? null : 'One digit or letter') });
  if (m) toggleAtCaret(ed, m.toUpperCase());
}

export function gotoBookmark(b: Bookmark): void {
  void useEditors.getState().open(b.path, { line: b.line, column: 1 });
}

export function gotoMnemonic(m: string): void {
  const b = useBookmarks.getState().list.find((x) => x.mnemonic === m);
  if (b) gotoBookmark(b);
  else toast('info', `No bookmark ${m}`, `Set one with ${m.match(/\d/) ? `Ctrl+Shift+${m}` : 'Ctrl+F11'}.`, 2500);
}

export async function describeBookmark(b: Bookmark): Promise<void> {
  const description = await askText({ title: 'Bookmark description', value: b.description ?? '', okLabel: 'Save' });
  if (description === null) return;
  set(useBookmarks.getState().list.map((x) => (x === b ? { ...x, description } : x)));
}

export function removeBookmark(b: Bookmark): void {
  set(useBookmarks.getState().list.filter((x) => x !== b));
}

// ---------------------------------------------------------------- gutter

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const marks = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `.bm-line.bm-${c}::after{content:'${c}'}`).join('');
  const el = document.createElement('style');
  el.textContent = marks;
  document.head.appendChild(el);
}

/** Draws the active file's bookmarks and keeps their lines in step with edits. */
export function attachBookmarks(ed: monaco.editor.IStandaloneCodeEditor): () => void {
  injectStyles();
  let ids: string[] = [];
  let shown: Bookmark[] = [];
  const render = () => {
    const path = pathOfModel(ed.getModel());
    shown = path ? useBookmarks.getState().list.filter((b) => samePath(b.path, path)) : [];
    ids = ed.deltaDecorations(
      ids,
      shown.map((b) => ({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: {
          linesDecorationsClassName: `bm-line${b.mnemonic ? ` bm-${b.mnemonic}` : ' bm-anon'}`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          overviewRuler: { color: '#4a90d9', position: monaco.editor.OverviewRulerLane.Left },
          hoverMessage: { value: `Bookmark${b.mnemonic ? ` ${b.mnemonic}` : ''}${b.description ? `: ${b.description}` : ''}` },
        },
      })),
    );
  };
  const unsub = useBookmarks.subscribe(render);
  const subs = [
    ed.onDidChangeModel(render),
    ed.onDidChangeModelContent(() => {
      const model = ed.getModel();
      if (!model || shown.length === 0) return;
      // decorations moved with the edit: carry the new lines back to the bookmarks
      let changed = false;
      const moved = new Map<Bookmark, number>();
      ids.forEach((id, i) => {
        const r = model.getDecorationRange(id);
        if (r && r.startLineNumber !== shown[i]?.line) {
          moved.set(shown[i], r.startLineNumber);
          changed = true;
        }
      });
      if (!changed) return;
      useBookmarks.setState({ list: useBookmarks.getState().list.map((b) => (moved.has(b) ? { ...b, line: moved.get(b)! } : b)) });
      persist();
    }),
  ];
  render();
  return () => {
    unsub();
    subs.forEach((s) => s.dispose());
  };
}
