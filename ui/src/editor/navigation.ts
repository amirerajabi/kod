// Structural navigation (Rider's Navigate menu): Back / Forward across files, Recent Files and Recent Locations,
// Go to Base Symbols, Related Files, next / previous member and the Navigate To popup.
import { api, errorText } from '../api/client';
import type { DefinitionDto, HierarchyItemDto, RelatedFileDto, SymbolDto } from '../api/types';
import { useMenu, type MenuItem } from '../components/common/Menu';
import { basename } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { useEditors } from '../store/editors';
import { toast } from '../store/ui';
import { entryOfModel, getEntry, pathOfModel } from './models';
import { monaco } from './monaco';

type Editor = monaco.editor.ICodeEditor;

export interface Place {
  path: string;
  line: number;
  column: number;
  /** The line's text when it was recorded (Recent Locations shows it). */
  text?: string;
  at?: number;
}

// ---------------------------------------------------------------- popups at the caret

/** Shows a menu under the caret (Refactor This, Navigate To, Surround With…). */
export function showAtCaret(ed: Editor, items: MenuItem[]): void {
  const pos = ed.getPosition();
  const at = pos ? ed.getScrolledVisiblePosition(pos) : null;
  const box = ed.getDomNode()?.getBoundingClientRect();
  const x = (box?.left ?? 100) + (at?.left ?? 40);
  const y = (box?.top ?? 100) + (at?.top ?? 40) + (at?.height ?? 18);
  useMenu.getState().show(x, y, items);
}

// ---------------------------------------------------------------- back / forward

const back: Place[] = [];
const forward: Place[] = [];
let navigating = false;

const same = (a: Place, b: Place, lines = 3) => a.path.toLowerCase() === b.path.toLowerCase() && Math.abs(a.line - b.line) <= lines;

function pushBack(p: Place): void {
  if (navigating) return;
  if (back.length && same(back[back.length - 1], p)) back[back.length - 1] = p;
  else back.push(p);
  if (back.length > 100) back.shift();
  forward.length = 0;
}

function go(p: Place): void {
  navigating = true;
  void useEditors
    .getState()
    .open(p.path, { line: p.line, column: p.column })
    .finally(() => setTimeout(() => (navigating = false), 50));
}

function current(ed: Editor | null): Place | null {
  const path = pathOfModel(ed?.getModel());
  const pos = ed?.getPosition();
  return path && pos ? { path, line: pos.lineNumber, column: pos.column } : null;
}

export function navigateBack(ed: Editor | null): void {
  const here = current(ed);
  let p = back.pop();
  while (p && here && same(p, here, 0)) p = back.pop();
  if (!p) return;
  if (here) forward.push(here);
  go(p);
}

export function navigateForward(ed: Editor | null): void {
  const p = forward.pop();
  if (!p) return;
  const here = current(ed);
  if (here) back.push(here);
  go(p);
}

// ---------------------------------------------------------------- recent files and locations

const recentFiles: string[] = loadRaw<string[]>('recentFiles', []);
const recentPlaces: Place[] = loadRaw<Place[]>('recentPlaces', []);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save('recentFiles', recentFiles.slice(0, 50));
    save('recentPlaces', recentPlaces.slice(0, 50));
  }, 500);
};

export const getRecentFiles = () => recentFiles;
export const getRecentPlaces = () => recentPlaces;

function touchFile(path: string): void {
  const i = recentFiles.findIndex((p) => p.toLowerCase() === path.toLowerCase());
  if (i >= 0) recentFiles.splice(i, 1);
  recentFiles.unshift(path);
  if (recentFiles.length > 50) recentFiles.length = 50;
  persist();
}

function touchPlace(p: Place): void {
  const i = recentPlaces.findIndex((x) => same(x, p, 5));
  if (i >= 0) recentPlaces.splice(i, 1);
  recentPlaces.unshift({ ...p, at: Date.now() });
  if (recentPlaces.length > 50) recentPlaces.length = 50;
  persist();
}

/** Records jumps (go to, search results, far clicks, tab switches) and edits for Back / Recent Locations. */
export function attachNavigation(ed: monaco.editor.IStandaloneCodeEditor): () => void {
  let last: Place | null = null;
  const subs = [
    ed.onDidChangeCursorPosition((e) => {
      const path = pathOfModel(ed.getModel());
      if (!path) return;
      const now: Place = { path, line: e.position.lineNumber, column: e.position.column };
      if (last && last.path === path && ((e.source === 'api' && Math.abs(last.line - now.line) > 2) || (e.source === 'mouse' && Math.abs(last.line - now.line) > 10)))
        pushBack({ ...last, text: lineText(last) });
      last = now;
    }),
    ed.onDidChangeModel((e) => {
      if (last && e.oldModelUrl) pushBack({ ...last, text: lineText(last) });
      last = null;
      const path = pathOfModel(ed.getModel());
      if (path && entryOfModel(ed.getModel())?.model.uri.scheme === 'file') touchFile(path);
    }),
    ed.onDidChangeModelContent(() => {
      const p = current(ed);
      if (p) touchPlace({ ...p, text: lineText(p) });
    }),
  ];
  return () => subs.forEach((s) => s.dispose());
}

function lineText(p: Place): string | undefined {
  const m = getEntry(p.path)?.model;
  return m && p.line <= m.getLineCount() ? m.getLineContent(p.line).trim().slice(0, 160) : p.text;
}

// ---------------------------------------------------------------- next / previous member

let symbolCache: { uri: string; version: number; members: SymbolDto[] } | null = null;

async function members(model: monaco.editor.ITextModel): Promise<SymbolDto[]> {
  if (symbolCache?.uri === model.uri.toString() && symbolCache.version === model.getVersionId()) return symbolCache.members;
  const res = await api.post<SymbolDto[]>('/intel/symbols', { path: pathOfModel(model), text: model.getValue() });
  const flat: SymbolDto[] = [];
  const walk = (list: SymbolDto[]) => {
    for (const s of list) {
      if (s.kind !== 'namespace') flat.push(s);
      walk(s.children);
    }
  };
  walk(res);
  flat.sort((a, b) => a.selectionRange.startLine - b.selectionRange.startLine);
  symbolCache = { uri: model.uri.toString(), version: model.getVersionId(), members: flat };
  return flat;
}

/** Alt+Down / Alt+Up: the next / previous type or member declaration. */
export async function gotoMember(ed: Editor, dir: 1 | -1): Promise<void> {
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!model || !pos || model.getLanguageId() !== 'csharp' || !pathOfModel(model)) return;
  let list: SymbolDto[];
  try {
    list = await members(model);
  } catch {
    return;
  }
  const target = dir > 0 ? list.find((s) => s.selectionRange.startLine > pos.lineNumber) : [...list].reverse().find((s) => s.selectionRange.startLine < pos.lineNumber);
  if (!target) return;
  const p = { lineNumber: target.selectionRange.startLine, column: target.selectionRange.startColumn };
  ed.setPosition(p);
  ed.revealLineInCenterIfOutsideViewport(p.lineNumber, monaco.editor.ScrollType.Smooth);
}

// ---------------------------------------------------------------- symbols by id (hierarchies, base symbols)

/** Opens a hierarchy / navigation item: its file, or a metadata view for a framework type or member. */
export async function openSymbol(item: HierarchyItemDto, at?: { path: string; range: HierarchyItemDto['range'] }): Promise<void> {
  if (at?.range) {
    await useEditors.getState().open(at.path, { range: at.range });
    return;
  }
  if (item.path && item.range) {
    await useEditors.getState().open(item.path, { range: item.range });
    return;
  }
  try {
    const def = await api.post<DefinitionDto>('/intel/symbolDefinition', { id: item.id });
    if (def.locations[0]) await useEditors.getState().open(def.locations[0].path, { range: def.locations[0].range });
    else if (def.metadata) useEditors.getState().openMetadata(def.metadata);
    else toast('info', `${item.name} has no declaration to show`);
  } catch (e) {
    toast('error', `Cannot open ${item.name}`, errorText(e));
  }
}

const docReq = (ed: Editor) => {
  const model = ed.getModel()!;
  const pos = ed.getPosition()!;
  return { path: pathOfModel(model), text: model.getValue(), line: pos.lineNumber, column: pos.column };
};

/** Go to Base Symbols: the base type / interfaces, or the overridden / implemented member. */
export async function gotoBase(ed: Editor | null): Promise<void> {
  if (!ed?.getModel() || !pathOfModel(ed.getModel()) || ed.getModel()!.getLanguageId() !== 'csharp') return;
  let list: HierarchyItemDto[];
  try {
    list = await api.post<HierarchyItemDto[]>('/intel/baseSymbols', docReq(ed));
  } catch (e) {
    toast('error', 'Go to Base Symbols failed', errorText(e));
    return;
  }
  if (list.length === 0) {
    toast('info', 'No base symbols', undefined, 2000);
    return;
  }
  if (list.length === 1) {
    void openSymbol(list[0]);
    return;
  }
  showAtCaret(ed, [{ label: 'Base symbols', disabled: true }, 'separator', ...list.map((s): MenuItem => ({ label: s.detail ? `${s.name}  ·  ${s.detail}` : s.name, run: () => void openSymbol(s) }))]);
}

/** Go to Related Files: partial parts, base types, interfaces, inheritors, tests, code-behind. */
export async function gotoRelated(ed: Editor | null): Promise<void> {
  const model = ed?.getModel();
  const path = pathOfModel(model);
  if (!ed || !model || !path) return;
  let list: RelatedFileDto[];
  try {
    list = await api.post<RelatedFileDto[]>('/intel/relatedFiles', { path, text: model.getValue() });
  } catch (e) {
    toast('error', 'Related files failed', errorText(e));
    return;
  }
  if (list.length === 0) {
    toast('info', 'No related files', undefined, 2000);
    return;
  }
  showAtCaret(ed, [{ label: 'Related files', disabled: true }, 'separator', ...list.map((f): MenuItem => ({ label: `${basename(f.path)}  ·  ${f.reason}`, run: () => void useEditors.getState().open(f.path) }))]);
}
