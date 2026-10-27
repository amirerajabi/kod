// Generate (Alt+Insert) and the type / member refactorings of Refactor This: Move Type to Another File / Folder, Pull
// Members Up, Push Members Down, Inline and Extract Class. The dialogs live in components/GenerateDialogs.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { CodeActionDto, FileEditsDto } from '../api/types';
import type { MenuItem } from '../components/common/Menu';
import { toast } from '../store/ui';
import { applyCodeAction } from './csharp';
import { pathOfModel } from './models';
import { monaco } from './monaco';
import { showAtCaret } from './navigation';
import { applyRefactoring, type At } from './refactor';

// ---------------------------------------------------------------- engine types

export interface GenerateMemberDto {
  id: string;
  name: string;
  type: string;
  kind: 'field' | 'property';
  assignable: boolean;
  isReference: boolean;
  isDisposable: boolean;
}

export interface GenerateSignatureDto {
  id: string;
  display: string;
  kind: string;
  owner: string;
}

export interface GenerateInfoDto {
  typeName: string;
  typeKind: string;
  members: GenerateMemberDto[];
  fields: GenerateMemberDto[];
  overridable: GenerateSignatureDto[];
  missing: GenerateSignatureDto[];
  hasEquals: boolean;
  hasToString: boolean;
  isDisposable: boolean;
  isSealed: boolean;
}

export type GenerateKind = 'constructor' | 'properties' | 'readonlyProperties' | 'equality' | 'formatting' | 'overrides' | 'missing' | 'dispose';

export interface MoreRefactoringsDto {
  typeName?: string;
  canMoveType: boolean;
  canPullUp: boolean;
  canPushDown: boolean;
  canInline: boolean;
  canExtractClass: boolean;
}

export interface MoveTypeInfoDto {
  typeName: string;
  namespace: string;
  folder: string;
  projectFolder: string;
  rootNamespace?: string;
  folders: string[];
  onlyType: boolean;
}

export interface MovableMemberDto {
  id: string;
  display: string;
  kind: string;
  canBeAbstract: boolean;
  isPublic: boolean;
}

export interface MemberTargetDto {
  id: string;
  name: string;
  kind: string;
  path: string;
}

export interface MoveMembersInfoDto {
  typeName: string;
  targets: MemberTargetDto[];
  members: MovableMemberDto[];
}

export interface InlineInfoDto {
  name?: string;
  kind?: string;
  roslyn: CodeActionDto[];
  canInlineField: boolean;
  usages: number;
  canInlineAllCalls: boolean;
}

export interface ExtractClassInfoDto {
  typeName: string;
  suggestedName: string;
  folder: string;
  members: MovableMemberDto[];
}

// ---------------------------------------------------------------- dialogs in progress

type Dialog =
  | { kind: 'generate'; at: At; info: GenerateInfoDto; what: GenerateKind }
  | { kind: 'moveType'; at: At; info: MoveTypeInfoDto }
  | { kind: 'pullUp'; at: At; info: MoveMembersInfoDto }
  | { kind: 'pushDown'; at: At; info: MoveMembersInfoDto }
  | { kind: 'inlineMethod'; at: At; info: InlineInfoDto }
  | { kind: 'inlineField'; at: At; info: InlineInfoDto }
  | { kind: 'extractClass'; at: At; info: ExtractClassInfoDto };

export const useGenerate = create<{ dialog: Dialog | null; close(): void }>((set) => ({
  dialog: null,
  close: () => set({ dialog: null }),
}));

type Editor = monaco.editor.ICodeEditor;

function at(ed: Editor | null): At | null {
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  const path = pathOfModel(model);
  if (!model || !pos || !path || model.getLanguageId() !== 'csharp' || model.uri.scheme !== 'file') return null;
  return { path, text: model.getValue(), line: pos.lineNumber, column: pos.column };
}

// ---------------------------------------------------------------- Generate

const TITLES: Record<GenerateKind, string> = {
  constructor: 'Constructor',
  properties: 'Properties',
  readonlyProperties: 'Read-only Properties',
  equality: 'Equality Members',
  formatting: 'Formatting Members',
  overrides: 'Overriding Members',
  missing: 'Missing Members',
  dispose: 'Dispose Pattern',
};

export const generateTitle = (k: GenerateKind) => TITLES[k];

/** Alt+Insert in the editor: what can be generated for the type at the caret. */
export async function generateMenu(ed: Editor | null): Promise<void> {
  const a = at(ed);
  if (!ed || !a) {
    toast('info', 'Generate', 'Put the caret in a C# class or struct');
    return;
  }
  let info: GenerateInfoDto;
  try {
    info = await api.post<GenerateInfoDto>('/intel/generate/info', a);
  } catch (e) {
    toast('info', 'Generate', errorText(e));
    return;
  }
  const open = (what: GenerateKind) => useGenerate.setState({ dialog: { kind: 'generate', at: a, info, what } });
  const items: MenuItem[] = [
    { label: 'Constructor…', run: () => open('constructor') },
    { label: 'Properties…', disabled: info.fields.length === 0, run: () => open('properties') },
    { label: 'Read-only Properties…', disabled: info.fields.length === 0, run: () => open('readonlyProperties') },
    'separator',
    { label: info.hasEquals ? 'Equality Members (replace)…' : 'Equality Members…', run: () => open('equality') },
    { label: info.hasToString ? 'Formatting Members (replace ToString)…' : 'Formatting Members…', run: () => open('formatting') },
    'separator',
    { label: 'Overriding Members…', disabled: info.overridable.length === 0, run: () => open('overrides') },
    { label: info.missing.length ? `Missing Members (${info.missing.length})…` : 'Missing Members', disabled: info.missing.length === 0, run: () => open('missing') },
  ];
  if (!info.isDisposable) items.push({ label: 'Dispose Pattern…', run: () => open('dispose') });
  showAtCaret(ed, [{ label: `Generate for '${info.typeName}'`, disabled: true }, 'separator', ...items]);
}

// ---------------------------------------------------------------- refactorings

async function openDialog<T>(ed: Editor | null, title: string, path: string, make: (a: At, info: T) => Dialog): Promise<void> {
  const a = at(ed);
  if (!a) return;
  try {
    const info = await api.post<T>(path, a);
    useGenerate.setState({ dialog: make(a, info) });
  } catch (e) {
    toast('info', title, errorText(e));
  }
}

export const moveType = (ed: Editor | null) =>
  openDialog<MoveTypeInfoDto>(ed, 'Move Type', '/intel/refactor/moveType/info', (a, info) => ({ kind: 'moveType', at: a, info }));

export const pullMembersUp = (ed: Editor | null) =>
  openDialog<MoveMembersInfoDto>(ed, 'Pull Members Up', '/intel/refactor/pullUp/info', (a, info) => ({ kind: 'pullUp', at: a, info }));

export const pushMembersDown = (ed: Editor | null) =>
  openDialog<MoveMembersInfoDto>(ed, 'Push Members Down', '/intel/refactor/pushDown/info', (a, info) => ({ kind: 'pushDown', at: a, info }));

export const extractClass = (ed: Editor | null) =>
  openDialog<ExtractClassInfoDto>(ed, 'Extract Class', '/intel/refactor/extractClass/info', (a, info) => ({ kind: 'extractClass', at: a, info }));

/** Inline (Ctrl+Alt+N): a local through Roslyn right away, a method or a constant / field through its dialog. */
export async function inline(ed: Editor | null): Promise<void> {
  const a = at(ed);
  const sel = ed?.getSelection();
  if (!ed || !a || !sel) return;
  let info: InlineInfoDto;
  try {
    const range = { startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn };
    info = await api.post<InlineInfoDto>('/intel/refactor/inline/info', { path: a.path, text: a.text, range, invoked: true });
  } catch (e) {
    toast('error', 'Inline failed', errorText(e));
    return;
  }
  if (info.canInlineAllCalls) {
    useGenerate.setState({ dialog: { kind: 'inlineMethod', at: a, info } });
    return;
  }
  if (info.canInlineField) {
    useGenerate.setState({ dialog: { kind: 'inlineField', at: a, info } });
    return;
  }
  if (info.roslyn.length === 1) {
    void applyCodeAction(info.roslyn[0].id);
    return;
  }
  if (info.roslyn.length > 1) {
    showAtCaret(ed, [{ label: 'Inline', disabled: true }, 'separator', ...info.roslyn.map((r): MenuItem => ({ label: r.title, run: () => void applyCodeAction(r.id) }))]);
    return;
  }
  toast('info', 'Inline', 'Put the caret on a local variable, a method or a constant to inline it');
}

/** The Refactor This entries these refactorings add for the caret. */
export async function moreRefactorItems(ed: Editor): Promise<MenuItem[]> {
  const a = at(ed);
  if (!a) return [];
  let res: MoreRefactoringsDto;
  try {
    res = await api.post<MoreRefactoringsDto>('/intel/refactor/more', a);
  } catch {
    return [];
  }
  const { shortcutOf } = await import('../app/commands');
  const items: MenuItem[] = [];
  if (res.canInline) items.push({ label: 'Inline…', shortcut: shortcutOf('refactor.inline'), run: () => void inline(ed) });
  if (res.canMoveType) items.push({ label: `Move '${res.typeName}' to Another File / Folder…`, run: () => void moveType(ed) });
  if (res.canPullUp) items.push({ label: 'Pull Members Up…', run: () => void pullMembersUp(ed) });
  if (res.canPushDown) items.push({ label: 'Push Members Down…', run: () => void pushMembersDown(ed) });
  if (res.canExtractClass) items.push({ label: 'Extract Class…', run: () => void extractClass(ed) });
  return items;
}

/** Runs a refactoring request; the dialog stays open with the engine's message when it is refused. */
export async function runRefactoring(path: string, body: unknown, done: string): Promise<string | null> {
  try {
    const files = await api.post<FileEditsDto[]>(path, body);
    useGenerate.getState().close();
    await applyRefactoring(files, done);
    return null;
  } catch (e) {
    return errorText(e);
  }
}
