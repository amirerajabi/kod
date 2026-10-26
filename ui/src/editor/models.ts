// Text models for open files: one Monaco model per path, its saved version (dirty tracking) and view state.
import { api } from '../api/client';
import type { FileText } from '../api/types';
import { norm } from '../lib/paths';
import { languageOf, monaco } from './monaco';

export interface ModelEntry {
  path: string;
  model: monaco.editor.ITextModel;
  savedVersion: number;
  viewState: monaco.editor.ICodeEditorViewState | null;
  readOnly: boolean;
  /** Created for a peek / reference preview, not shown as a tab yet. */
  ephemeral: boolean;
}

const entries = new Map<string, ModelEntry>();
const byUri = new Map<string, ModelEntry>();
const listeners = new Set<(e: ModelEntry) => void>();
const pending = new Map<string, Promise<ModelEntry>>();

export const getEntry = (path: string) => entries.get(norm(path));

export const entryOfModel = (m: monaco.editor.ITextModel | null | undefined) => (m ? byUri.get(m.uri.toString()) : undefined);

/** The file path of a model (as the engine knows it, not Monaco's lower-cased fsPath). */
export const pathOfModel = (m: monaco.editor.ITextModel | null | undefined) => entryOfModel(m)?.path;

export const allEntries = () => [...entries.values()];

export function onDirtyChange(cb: (e: ModelEntry) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const isDirty = (e: ModelEntry) => e.model.getAlternativeVersionId() !== e.savedVersion;

function register(path: string, model: monaco.editor.ITextModel, readOnly: boolean, ephemeral: boolean): ModelEntry {
  const e: ModelEntry = { path, model, savedVersion: model.getAlternativeVersionId(), viewState: null, readOnly, ephemeral };
  entries.set(norm(path), e);
  byUri.set(model.uri.toString(), e);
  let wasDirty = false;
  model.onDidChangeContent(() => {
    const d = isDirty(e);
    if (d !== wasDirty) {
      wasDirty = d;
      for (const l of listeners) l(e);
    }
  });
  return e;
}

/** Loads (once) the model for a file. */
export function ensureModel(path: string, opts: { ephemeral?: boolean } = {}): Promise<ModelEntry> {
  const key = norm(path);
  const existing = entries.get(key);
  if (existing) {
    if (!opts.ephemeral) existing.ephemeral = false;
    return Promise.resolve(existing);
  }
  let p = pending.get(key);
  if (!p) {
    p = api
      .get<FileText>('/fs/read', { path })
      .then((f) => {
        const already = entries.get(key);
        if (already) return already;
        const uri = monaco.Uri.file(path);
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(f.text, languageOf(path), uri);
        model.setEOL(f.eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        return register(path, model, f.readOnly, opts.ephemeral ?? false);
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p.then((e) => {
    if (!opts.ephemeral) e.ephemeral = false;
    return e;
  });
}

/** A read-only generated document (metadata view). */
export function ensureVirtualModel(uri: string, path: string, text: string): ModelEntry {
  const existing = entries.get(norm(path));
  if (existing) return existing;
  const u = monaco.Uri.parse(uri);
  const model = monaco.editor.getModel(u) ?? monaco.editor.createModel(text, 'csharp', u);
  return register(path, model, true, false);
}

/** An editable scratch document that is not a file (a SQL console). */
export function ensureConsoleModel(path: string, text: string, language = 'sql'): ModelEntry {
  const existing = entries.get(norm(path));
  if (existing) return existing;
  const u = monaco.Uri.parse(`kod-console:/${encodeURIComponent(path)}`);
  const model = monaco.editor.getModel(u) ?? monaco.editor.createModel(text, language, u);
  return register(path, model, false, false);
}

export function markSaved(e: ModelEntry): void {
  e.savedVersion = e.model.getAlternativeVersionId();
  for (const l of listeners) l(e);
}

export function disposeModel(path: string): void {
  const key = norm(path);
  const e = entries.get(key);
  if (!e) return;
  entries.delete(key);
  byUri.delete(e.model.uri.toString());
  e.model.dispose();
}

/** Replace the whole text keeping undo (external change on disk). */
export function replaceText(e: ModelEntry, text: string): void {
  if (e.model.getValue() === text) return;
  e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text }], () => null);
  markSaved(e);
}

export function renameEntry(from: string, to: string): void {
  const e = entries.get(norm(from));
  if (!e) return;
  // Monaco models cannot change URI: move the text into a new model
  const text = e.model.getValue();
  const dirty = isDirty(e);
  disposeModel(from);
  const model = monaco.editor.createModel(text, languageOf(to), monaco.Uri.file(to));
  const n = register(to, model, e.readOnly, false);
  if (dirty) n.savedVersion = -1;
}
