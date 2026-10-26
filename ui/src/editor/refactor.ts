// Refactor This (Ctrl+Shift+R): Rider's refactorings the engine implements (Change Signature, Safe Delete, Extract
// Interface) plus every Roslyn refactoring available at the caret. The dialogs live in components/RefactorDialogs.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { ExtractInterfaceInfoDto, FileEditsDto, RefactoringsDto, SafeDeleteCheckDto, SignatureInfoDto } from '../api/types';
import type { MenuItem } from '../components/common/Menu';
import { applyFileEdits } from '../store/editors';
import { toast } from '../store/ui';
import { applyCodeAction } from './csharp';
import { pathOfModel } from './models';
import { monaco } from './monaco';
import { showAtCaret } from './navigation';

/** Where the refactoring was asked for: the file, its current text and the caret. */
export interface At {
  path: string;
  text: string;
  line: number;
  column: number;
}

type Dialog =
  | { kind: 'signature'; at: At; info: SignatureInfoDto }
  | { kind: 'safeDelete'; at: At; check: SafeDeleteCheckDto }
  | { kind: 'extractInterface'; at: At; info: ExtractInterfaceInfoDto };

export const useRefactor = create<{ dialog: Dialog | null; close(): void }>((set) => ({
  dialog: null,
  close: () => set({ dialog: null }),
}));

function at(ed: monaco.editor.ICodeEditor | null): At | null {
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  const path = pathOfModel(model);
  if (!model || !pos || !path || model.getLanguageId() !== 'csharp' || model.uri.scheme !== 'file') return null;
  return { path, text: model.getValue(), line: pos.lineNumber, column: pos.column };
}

/** Applies the engine's edits; open files get undoable edits, like rename. */
export async function applyRefactoring(files: FileEditsDto[], done: string): Promise<void> {
  const n = await applyFileEdits(files);
  if (n > 0) toast('success', done, n > 1 ? `${n} files changed` : undefined, 3000);
}

export async function changeSignature(ed: monaco.editor.ICodeEditor | null): Promise<void> {
  const a = at(ed);
  if (!a) return;
  try {
    const info = await api.post<SignatureInfoDto>('/intel/refactor/signature', a);
    useRefactor.setState({ dialog: { kind: 'signature', at: a, info } });
  } catch (e) {
    toast('info', 'Change Signature', errorText(e));
  }
}

export async function safeDelete(ed: monaco.editor.ICodeEditor | null): Promise<void> {
  const a = at(ed);
  if (!a) return;
  try {
    const check = await api.post<SafeDeleteCheckDto>('/intel/refactor/safeDelete/check', a);
    useRefactor.setState({ dialog: { kind: 'safeDelete', at: a, check } });
  } catch (e) {
    toast('info', 'Safe Delete', errorText(e));
  }
}

export async function extractInterface(ed: monaco.editor.ICodeEditor | null): Promise<void> {
  const a = at(ed);
  if (!a) return;
  try {
    const info = await api.post<ExtractInterfaceInfoDto>('/intel/refactor/extractInterface/info', a);
    useRefactor.setState({ dialog: { kind: 'extractInterface', at: a, info } });
  } catch (e) {
    toast('info', 'Extract Interface', errorText(e));
  }
}

/** Ctrl+Shift+R: the refactorings that apply at the caret / selection. */
export async function refactorThis(ed: monaco.editor.ICodeEditor | null): Promise<void> {
  const a = at(ed);
  const sel = ed?.getSelection();
  if (!ed || !a || !sel) return;
  let res: RefactoringsDto;
  try {
    const range = { startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn };
    res = await api.post<RefactoringsDto>('/intel/refactor/available', { path: a.path, text: a.text, range, invoked: true });
  } catch (e) {
    toast('error', 'Refactor This failed', errorText(e));
    return;
  }
  const { keyLabel } = await import('../app/commands');
  const items: MenuItem[] = [];
  if (res.canRename) items.push({ label: 'Rename…', shortcut: keyLabel('F2'), run: () => ed.trigger('kod', 'editor.action.rename', {}) });
  if (res.canChangeSignature) items.push({ label: 'Change Signature…', shortcut: keyLabel('Ctrl+F6'), run: () => void changeSignature(ed) });
  if (res.canSafeDelete) items.push({ label: 'Safe Delete…', shortcut: keyLabel('Alt+Delete'), run: () => void safeDelete(ed) });
  if (res.canExtractInterface) items.push({ label: 'Extract Interface…', run: () => void extractInterface(ed) });
  if (res.roslyn.length) {
    if (items.length) items.push('separator');
    for (const r of res.roslyn) items.push({ label: r.title, run: () => void applyCodeAction(r.id) });
  }
  if (items.length === 0) items.push({ label: 'No refactorings available here', disabled: true });
  showAtCaret(ed, [{ label: res.symbolName ? `Refactor ${res.symbolKind ?? ''} '${res.symbolName}'` : 'Refactor This', disabled: true }, 'separator', ...items]);
}
