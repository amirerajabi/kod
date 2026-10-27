import { ArrowDown, ArrowUp, Columns2, Rows2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api/client';
import type { DiffSpec } from '../store/editors';
import { useSettings } from '../store/settings';
import { getEntry } from './models';
import { languageOf, monaco } from './monaco';

async function sideText(path: string, rev: string): Promise<string> {
  if (rev.startsWith('history:')) return (await api.get<{ text: string }>('/history/text', { path, id: rev.slice(8) })).text;
  if (rev === 'empty') return '';
  // a pull request's side: gh:<commit>:<repository-relative path> (from GitHub when the commit is not fetched)
  const gh = /^gh:([0-9a-fA-F]+):(.+)$/.exec(rev);
  if (gh) return (await api.get<{ text: string }>('/git/pulls/content', { path: gh[2], sha: gh[1] })).text;
  if (rev === 'working') {
    const open = getEntry(path);
    if (open) return open.model.getValue();
    try {
      return (await api.get<{ text: string }>('/fs/read', { path })).text;
    } catch {
      return ''; // deleted
    }
  }
  const r = await api.get<{ exists: boolean; text: string }>('/git/show', { path, rev });
  return r.exists ? r.text : '';
}

/** A diff tab (Monaco's diff editor): HEAD / index / a commit on the left, the working copy or a commit on the right. */
export function DiffView({ spec }: { spec: DiffSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [inline, setInline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState(0);
  const settings = useSettings((s) => s.settings);

  useEffect(() => {
    const ed = monaco.editor.createDiffEditor(host.current!, {
      automaticLayout: true,
      readOnly: spec.right !== 'working',
      originalEditable: false,
      renderSideBySide: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      'semanticHighlighting.enabled': true,
    } as monaco.editor.IStandaloneDiffEditorConstructionOptions);
    editor.current = ed;
    let disposed = false;
    const models: monaco.editor.ITextModel[] = [];
    (async () => {
      try {
        const [left, right] = await Promise.all([sideText(spec.path, spec.left), sideText(spec.path, spec.right)]);
        if (disposed) return;
        const lang = languageOf(spec.path);
        const original = monaco.editor.createModel(left, lang);
        // the working side edits the real file model when it is open, so changes here are the file's changes
        const open = spec.right === 'working' ? getEntry(spec.path) : undefined;
        const modified = open?.model ?? monaco.editor.createModel(right, lang);
        models.push(original);
        if (!open) models.push(modified);
        ed.setModel({ original, modified });
        ed.onDidUpdateDiff(() => setCounts(ed.getLineChanges()?.length ?? 0));
      } catch (e) {
        setError(errorText(e));
      }
    })();
    return () => {
      disposed = true;
      ed.setModel(null);
      ed.dispose();
      for (const m of models) m.dispose();
    };
  }, [spec.path, spec.left, spec.right]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => editor.current?.updateOptions({ renderSideBySide: !inline }), [inline]);

  const go = (dir: 1 | -1) => {
    const ed = editor.current;
    if (!ed) return;
    const changes = ed.getLineChanges() ?? [];
    const cur = ed.getModifiedEditor().getPosition()?.lineNumber ?? 0;
    const target = dir > 0 ? changes.find((c) => c.modifiedStartLineNumber > cur) ?? changes[0] : [...changes].reverse().find((c) => c.modifiedStartLineNumber < cur) ?? changes[changes.length - 1];
    if (!target) return;
    const line = Math.max(1, target.modifiedStartLineNumber);
    ed.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
    ed.getModifiedEditor().revealLineInCenter(line);
    ed.getModifiedEditor().focus();
  };

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--ed-bg)' }}>
      <div className="console-toolbar">
        <button className="icon-btn sm" title="Previous change" onClick={() => go(-1)}>
          <ArrowUp size={14} />
        </button>
        <button className="icon-btn sm" title="Next change" onClick={() => go(1)}>
          <ArrowDown size={14} />
        </button>
        <button className={`icon-btn sm${!inline ? ' on' : ''}`} title="Side by side" onClick={() => setInline(false)}>
          <Columns2 size={14} />
        </button>
        <button className={`icon-btn sm${inline ? ' on' : ''}`} title="Unified" onClick={() => setInline(true)}>
          <Rows2 size={14} />
        </button>
        <span className="muted" style={{ marginLeft: 8 }}>
          {error ? <span className="sev-error">{error}</span> : `${counts} change${counts === 1 ? '' : 's'}`}
        </span>
      </div>
      <div ref={host} className="monaco-component" style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
