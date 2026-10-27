// Rider's Code Vision: "N usages" and "N implementations / inheritors / overrides" above types and members. The
// engine lists the declarations; each count is computed when its lens scrolls into view (and kept a few seconds,
// since Monaco asks again after every edit).
import { api, isAbort } from '../api/client';
import type { CodeVisionDto, CodeVisionEntryDto } from '../api/types';
import { useSettings } from '../store/settings';
import { getEditor, showUsages } from './CodeEditor';
import { pathOfModel } from './models';
import { monaco } from './monaco';

const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
const cache = new Map<string, { at: number; value: Promise<CodeVisionDto | null> }>();
const TTL = 5000;

type Lens = monaco.languages.CodeLens & { _at?: { path: string; line: number; column: number; key: string; part: 'usages' | 'impl' } };

function plural(n: number, one: string, many: string): string {
  return n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;
}

function counts(model: monaco.editor.ITextModel, at: NonNullable<Lens['_at']>): Promise<CodeVisionDto | null> {
  const hit = cache.get(at.key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = api
    .post<CodeVisionDto | undefined>('/intel/codeVision/resolve', { path: at.path, text: model.getValue(), line: at.line, column: at.column })
    .then((r) => r ?? null)
    .catch((e) => {
      if (!isAbort(e)) cache.delete(at.key);
      return null;
    });
  cache.set(at.key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return value;
}

export function registerCodeVision(): void {
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: changed.event,
    async provideCodeLenses(model) {
      const path = pathOfModel(model);
      if (!path || model.uri.scheme !== 'file' || !useSettings.getState().settings.codeVision) return { lenses: [], dispose() {} };
      let entries: CodeVisionEntryDto[];
      try {
        entries = await api.post<CodeVisionEntryDto[]>('/intel/codeVision', { path, text: model.getValue() });
      } catch {
        return { lenses: [], dispose() {} };
      }
      const lenses: Lens[] = [];
      for (const e of entries) {
        if (e.line > model.getLineCount()) continue;
        // the key follows the declaration's text, not its line number, so lenses above an edit stay cached
        const key = `${path}|${model.getLineContent(e.line).trim()}|${e.column}`;
        const range = new monaco.Range(e.line, 1, e.line, 1);
        lenses.push({ range, _at: { path, line: e.line, column: e.column, key, part: 'usages' } });
        if (e.implementable) lenses.push({ range, _at: { path, line: e.line, column: e.column, key, part: 'impl' } });
      }
      return { lenses, dispose() {} };
    },
    async resolveCodeLens(model, lens: Lens) {
      const at = lens._at;
      if (!at) return lens;
      const c = await counts(model, at);
      if (!c) {
        lens.command = { id: '', title: at.part === 'usages' ? '…' : '' };
        return lens;
      }
      if (at.part === 'usages') {
        lens.command = { id: 'kod.codeVision.usages', title: plural(c.usages, 'usage', 'usages'), arguments: [at.line, at.column] };
      } else {
        const label = c.implementationsLabel ?? 'implementations';
        const many = label.endsWith('s') ? label : `${label}s`;
        const one = label.endsWith('s') ? label.slice(0, -1) : label;
        lens.command = { id: c.implementations ? 'kod.codeVision.implementations' : '', title: plural(c.implementations, one, many), arguments: [at.line, at.column] };
      }
      return lens;
    },
  };
  monaco.languages.registerCodeLensProvider('csharp', provider);
  monaco.editor.registerCommand('kod.codeVision.usages', (_a, line: number, column: number) => {
    const ed = getEditor();
    if (!ed) return;
    ed.setPosition({ lineNumber: line, column });
    void showUsages();
  });
  monaco.editor.registerCommand('kod.codeVision.implementations', (_a, line: number, column: number) => {
    const ed = getEditor();
    if (!ed) return;
    ed.setPosition({ lineNumber: line, column });
    void ed.getAction('editor.action.goToImplementation')?.run();
  });
  useSettings.subscribe((s, p) => {
    if (s.settings.codeVision !== p.settings.codeVision) changed.fire(provider);
  });
}

/** After a save or an external change other files' counts may differ: recount. */
export function refreshCodeVision(): void {
  cache.clear();
}
