// Edit › Copy/Paste Special (Rider's): Copy Path/Reference (absolute, file name, from the solution or repository root,
// Namespace.Type.Member, file:line, a link to the lines on GitHub/GitLab), Copy as Plain / Rich Text, Paste from History
// and Paste as Plain Text. Copies and cuts anywhere in Kod feed the history.
import { api } from '../api/client';
import { copyText } from '../app/actions';
import type { MenuItem } from '../components/common/Menu';
import { useMenu } from '../components/common/Menu';
import { basename, relative } from '../lib/paths';
import { useClipboard } from '../store/clipboard';
import { useEditors } from '../store/editors';
import { toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { getEditor } from './CodeEditor';
import { pathOfModel } from './models';
import { monaco } from './monaco';
import { showAtCaret } from './navigation';

type Editor = monaco.editor.IStandaloneCodeEditor;

/** The active file: the editor's when it shows one, else the active tab's. */
function activeFile(): string | null {
  const fromEditor = pathOfModel(getEditor()?.getModel());
  if (fromEditor) return fromEditor;
  const { active, tabs } = useEditors.getState();
  return tabs.find((t) => t.path === active && t.kind === 'file')?.path ?? null;
}

/** The selected lines (or the caret's) of the editor when it shows this file. */
function linesOf(path: string): { line: number; end?: number } | null {
  const ed = getEditor();
  if (!ed || pathOfModel(ed.getModel()) !== path) return null;
  const sel = ed.getSelection();
  if (!sel) return null;
  // a selection ending at a line's start does not take that line
  const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
  return { line: sel.startLineNumber, end: end > sel.startLineNumber ? end : undefined };
}

/** Namespace.Type.Member of the C# symbol at the caret, or null. */
async function referenceAtCaret(path: string): Promise<string | null> {
  const ed = getEditor();
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  if (!ed || !model || !pos || pathOfModel(model) !== path || model.getLanguageId() !== 'csharp') return null;
  try {
    const r = await api.post<{ reference: string | null }>('/intel/reference', { path, text: model.getValue(), line: pos.lineNumber, column: pos.column });
    return r.reference;
  } catch {
    return null;
  }
}

/** Every way to copy where a file (and the caret's symbol and lines) is: each entry shows what it copies. */
export async function pathReferenceItems(path: string): Promise<MenuItem[]> {
  const root = useWorkspace.getState().ws.root;
  const lines = linesOf(path);
  const [reference, link] = await Promise.all([
    referenceAtCaret(path),
    api.get<{ repoPath?: string; url?: string }>(`/git/link?path=${encodeURIComponent(path)}${lines ? `&line=${lines.line}${lines.end ? `&endLine=${lines.end}` : ''}` : ''}`).catch(() => ({}) as { repoPath?: string; url?: string }),
  ]);
  const fromRoot = root ? relative(root, path).replace(/\\/g, '/') : null;
  const fileLine = lines ? `${fromRoot ?? basename(path)}:${lines.line}` : null;
  const entry = (label: string, value: string | null | undefined, what: string): MenuItem[] =>
    // the value previews short enough for the labels to stay readable
    value ? [{ label, shortcut: value.length > 44 ? `…${value.slice(-42)}` : value, run: () => void copyText(value, what) }] : [];
  return [
    ...entry('Absolute Path', path, 'Path'),
    ...entry('File Name', basename(path), 'File name'),
    ...entry('Path From Solution Root', fromRoot && fromRoot !== path ? fromRoot : null, 'Path'),
    ...entry('Path From Repository Root', link.repoPath, 'Path'),
    ...(reference || fileLine ? (['separator'] as MenuItem[]) : []),
    ...entry('Reference', reference, 'Reference'),
    ...entry('File and Line', fileLine, 'Location'),
    ...(link.url ? (['separator', ...entry(link.url.includes('gitlab') ? 'GitLab Link' : 'GitHub Link', link.url, 'Link')] as MenuItem[]) : []),
  ];
}

/** Copy Path/Reference… (Ctrl+Alt+Shift+C): the choices at the caret, or at the middle of the window without an editor. */
export async function copyPathReference(): Promise<void> {
  const path = activeFile();
  if (!path) {
    toast('info', 'Open a file first');
    return;
  }
  const items: MenuItem[] = [{ label: 'Copy', disabled: true }, 'separator', ...(await pathReferenceItems(path))];
  const ed = getEditor();
  if (ed && pathOfModel(ed.getModel()) === path) showAtCaret(ed, items);
  else useMenu.getState().show(window.innerWidth / 2 - 150, window.innerHeight / 3, items);
}

/** Copy Paths (Ctrl+Shift+C): the active file's absolute path. */
export function copyPaths(): void {
  const path = activeFile();
  if (path) void copyText(path);
  else toast('info', 'Open a file first');
}

/** Copy Reference: Namespace.Type.Member at the caret, else file:line. */
export async function copyReference(): Promise<void> {
  const path = activeFile();
  if (!path) return;
  const ref = await referenceAtCaret(path);
  const lines = linesOf(path);
  const root = useWorkspace.getState().ws.root;
  const value = ref ?? (lines ? `${root ? relative(root, path).replace(/\\/g, '/') : basename(path)}:${lines.line}` : null);
  if (value) await copyText(value, ref ? 'Reference' : 'Location');
}

/** The editor's selections as Monaco copies them (an empty selection takes its whole line). */
function selectedText(ed: Editor): string {
  const model = ed.getModel();
  const sels = ed.getSelections() ?? [];
  if (!model || sels.length === 0) return '';
  if (sels.every((s) => s.isEmpty())) return sels.map((s) => model.getLineContent(s.startLineNumber) + model.getEOL()).join('');
  return sels.map((s) => model.getValueInRange(s)).join(model.getEOL());
}

/** Copy as Plain Text: the selection without the colours an ordinary copy carries. */
export async function copyPlain(): Promise<void> {
  const ed = getEditor();
  if (!ed?.getModel()) return;
  const text = selectedText(ed);
  try {
    await navigator.clipboard.writeText(text);
    useClipboard.getState().add(text);
    toast('info', 'Copied as plain text', undefined, 1500);
  } catch {
    toast('warning', 'Clipboard is not available');
  }
}

/** Copy as Rich Text: the selection with the editor's syntax colours and font, for documents and mail. */
export function copyRich(): void {
  const ed = getEditor();
  if (!ed?.getModel()) return;
  const was = ed.getOption(monaco.editor.EditorOption.copyWithSyntaxHighlighting);
  ed.updateOptions({ copyWithSyntaxHighlighting: true });
  ed.focus();
  ed.trigger('kod', 'editor.action.clipboardCopyAction', null);
  ed.updateOptions({ copyWithSyntaxHighlighting: !!was });
  toast('info', 'Copied with syntax colours', undefined, 1500);
}

/** Inserts text at every caret of the editor as it is: no re-indenting, no formatting. */
export function insertAsIs(text: string, ed = getEditor()): void {
  const model = ed?.getModel();
  if (!ed || !model) {
    toast('info', 'Open a file to paste into');
    return;
  }
  if (ed.getOption(monaco.editor.EditorOption.readOnly)) return;
  const sels = ed.getSelections() ?? [];
  // one line per caret when the text has as many lines, as Rider pastes into multiple carets
  const parts = text.split(/\r?\n/);
  const spread = sels.length > 1 && parts.length === sels.length;
  ed.pushUndoStop();
  ed.executeEdits(
    'kod.pasteAsIs',
    sels.map((s, i) => ({ range: s, text: spread ? parts[i] : text, forceMoveMarkers: true })),
  );
  ed.pushUndoStop();
  ed.focus();
}

/** Paste as Plain Text (Ctrl+Alt+Shift+V): the clipboard's text without formatting or re-indenting. */
export async function pastePlain(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) insertAsIs(text);
  } catch {
    toast('warning', 'Clipboard is not available', 'Use Paste from History (Ctrl+Shift+V) instead.');
  }
}

/** Paste from History (Ctrl+Shift+V): the dialog, with what is on the clipboard now on top. */
export async function pasteFromHistory(): Promise<void> {
  try {
    const now = await navigator.clipboard.readText();
    if (now) useClipboard.getState().add(now);
  } catch {
    /* the system clipboard is not readable: the history alone */
  }
  useClipboard.setState({ open: true });
}

// copies and cuts anywhere in Kod: the editor's selections, a field's selection, any selected text
function onCopy(): void {
  const active = document.activeElement as HTMLElement | null;
  const ed = getEditor();
  let text = '';
  if (active?.closest('.monaco-editor') && ed?.hasTextFocus()) text = selectedText(ed);
  else if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) text = active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0);
  else text = window.getSelection()?.toString() ?? '';
  if (text) useClipboard.getState().add(text);
}
window.addEventListener('copy', onCopy, true);
window.addEventListener('cut', onCopy, true);
