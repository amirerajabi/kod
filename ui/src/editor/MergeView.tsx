import { ArrowDown, ArrowUp, Check, GitMerge, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api/client';
import { useEditors } from '../store/editors';
import { refreshGit } from '../store/git';
import { useSettings } from '../store/settings';
import { askConfirm, toast } from '../store/ui';
import { getEntry, replaceText } from './models';
import { languageOf, monaco } from './monaco';

interface Conflict {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  merged: string;
  operation?: string;
}

/** A conflict block in the result: <<<<<<< ours ||||||| base ======= theirs >>>>>>>. Lines are 1-based. */
interface Block {
  start: number;
  base?: number;
  sep: number;
  end: number;
}

export function parseBlocks(model: monaco.editor.ITextModel): Block[] {
  const blocks: Block[] = [];
  let cur: Partial<Block> | null = null;
  for (let l = 1; l <= model.getLineCount(); l++) {
    const t = model.getLineContent(l);
    if (t.startsWith('<<<<<<<')) cur = { start: l };
    else if (cur && t.startsWith('|||||||') && cur.sep === undefined) cur.base = l;
    else if (cur && t.startsWith('=======') && cur.sep === undefined) cur.sep = l;
    else if (cur && cur.sep !== undefined && t.startsWith('>>>>>>>')) {
      blocks.push({ start: cur.start!, base: cur.base, sep: cur.sep, end: l });
      cur = null;
    }
  }
  return blocks;
}

function sideText(model: monaco.editor.ITextModel, from: number, to: number): string {
  // lines from..to inclusive (empty when to < from), each with its line break
  const out: string[] = [];
  for (let l = from; l <= to; l++) out.push(model.getLineContent(l) + '\n');
  return out.join('');
}

export type Side = 'ours' | 'theirs' | 'both' | 'base';

/** Replaces one conflict block with the chosen side(s). */
export function resolveBlock(model: monaco.editor.ITextModel, b: Block, side: Side): void {
  const ours = sideText(model, b.start + 1, (b.base ?? b.sep) - 1);
  const theirs = sideText(model, b.sep + 1, b.end - 1);
  const base = b.base ? sideText(model, b.base + 1, b.sep - 1) : '';
  const text = side === 'ours' ? ours : side === 'theirs' ? theirs : side === 'both' ? ours + theirs : base;
  const endCol = b.end < model.getLineCount() ? 1 : model.getLineMaxColumn(b.end);
  const range = new monaco.Range(b.start, 1, b.end < model.getLineCount() ? b.end + 1 : b.end, endCol);
  model.pushEditOperations([], [{ range, text: b.end < model.getLineCount() ? text : text.replace(/\n$/, '') }], () => null);
}

// one CodeLens provider for every merge result model (scheme kod-merge)
let registered = false;
function registerLenses(): void {
  if (registered) return;
  registered = true;
  const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses(model) {
      const lenses: monaco.languages.CodeLens[] = [];
      for (const b of parseBlocks(model)) {
        const range = new monaco.Range(b.start, 1, b.start, 1);
        const cmd = (title: string, side: Side) => ({ range, command: { id: 'kod.merge.accept', title, arguments: [model.uri.toString(), b.start, side] } });
        lenses.push(cmd('Accept Yours', 'ours'), cmd('Accept Theirs', 'theirs'), cmd('Accept Both', 'both'));
        if (b.base) lenses.push(cmd('Accept Base', 'base'));
      }
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider({ scheme: 'kod-merge' } as monaco.languages.LanguageSelector, provider);
  monaco.editor.registerCommand('kod.merge.accept', (_a, uri: string, start: number, side: Side) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    const b = model ? parseBlocks(model).find((x) => x.start === start) : undefined;
    if (model && b) resolveBlock(model, b, side);
  });
}

/** Rider's three-way merge: your version, the result (with the conflicts to resolve) and theirs. */
export function MergeView({ path }: { path: string }) {
  const leftHost = useRef<HTMLDivElement>(null);
  const centerHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const result = useRef<monaco.editor.ITextModel | null>(null);
  const center = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const settings = useSettings((s) => s.settings);

  useEffect(() => {
    registerLenses();
    let disposed = false;
    const editors: monaco.editor.IStandaloneCodeEditor[] = [];
    const models: monaco.editor.ITextModel[] = [];
    (async () => {
      let c: Conflict;
      try {
        c = await api.get<Conflict>('/git/conflict', { path });
      } catch (e) {
        setError(errorText(e));
        return;
      }
      if (disposed) return;
      setConflict(c);
      const lang = languageOf(path);
      const stamp = Date.now();
      const mk = (text: string, scheme: string, side: string) => {
        const m = monaco.editor.createModel(text, lang, monaco.Uri.from({ scheme, path: `/${stamp}/${side}/${path.replace(/\\/g, '/')}` }));
        models.push(m);
        return m;
      };
      const opts = (readOnly: boolean): monaco.editor.IStandaloneEditorConstructionOptions => ({
        automaticLayout: true,
        readOnly,
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        glyphMargin: false,
        lineNumbersMinChars: 3,
        theme: 'kod',
      });
      const l = monaco.editor.create(leftHost.current!, { ...opts(true), model: mk(c.ours, 'kod-merge-side', 'ours') });
      const r = monaco.editor.create(rightHost.current!, { ...opts(true), model: mk(c.theirs, 'kod-merge-side', 'theirs') });
      const m = mk(c.merged, 'kod-merge', 'result');
      const ce = monaco.editor.create(centerHost.current!, { ...opts(false), model: m });
      editors.push(l, ce, r);
      result.current = m;
      center.current = ce;
      // keep the three scrolled together, like Rider
      let syncing = false;
      for (const ed of editors)
        ed.onDidScrollChange((e) => {
          if (syncing || !e.scrollTopChanged) return;
          syncing = true;
          for (const o of editors) if (o !== ed) o.setScrollTop(e.scrollTop);
          syncing = false;
        });
      let decos: string[] = [];
      const update = () => {
        const blocks = parseBlocks(m);
        setLeft(blocks.length);
        decos = ce.deltaDecorations(
          decos,
          blocks.flatMap((b) => [
            { range: new monaco.Range(b.start, 1, (b.base ?? b.sep) - 1, 1), options: { isWholeLine: true, className: 'merge-ours' } },
            { range: new monaco.Range(b.sep, 1, b.end, 1), options: { isWholeLine: true, className: 'merge-theirs' } },
          ]),
        );
      };
      m.onDidChangeContent(update);
      update();
      const first = parseBlocks(m)[0];
      if (first) ce.revealLineInCenter(first.start);
    })();
    return () => {
      disposed = true;
      for (const e of editors) e.dispose();
      for (const m of models) m.dispose();
      result.current = null;
      center.current = null;
    };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = (side: Side) => {
    const m = result.current;
    if (!m) return;
    // from the bottom up, so earlier blocks keep their lines
    for (const b of parseBlocks(m).reverse()) resolveBlock(m, b, side);
  };

  const go = (dir: 1 | -1) => {
    const ed = center.current;
    const m = result.current;
    if (!ed || !m) return;
    const line = ed.getPosition()?.lineNumber ?? 0;
    const blocks = parseBlocks(m);
    const b = dir > 0 ? (blocks.find((x) => x.start > line) ?? blocks[0]) : ([...blocks].reverse().find((x) => x.start < line) ?? blocks[blocks.length - 1]);
    if (!b) return;
    ed.setPosition({ lineNumber: b.start, column: 1 });
    ed.revealLineInCenter(b.start);
    ed.focus();
  };

  const close = () => void useEditors.getState().close(`kod-merge:${path}`);

  const apply = async () => {
    const m = result.current;
    if (!m) return;
    if (parseBlocks(m).length > 0 && (await askConfirm({ title: 'Conflicts left', message: `${parseBlocks(m).length} conflicts are not resolved. Save the result with the conflict markers and mark the file resolved anyway?`, okLabel: 'Apply anyway', danger: true })) !== 'ok')
      return;
    try {
      const text = m.getValue();
      await api.post('/git/resolve', { path, text });
      const open = getEntry(path);
      if (open) replaceText(open, text);
      refreshGit(0);
      toast('success', 'Conflict resolved', path.split(/[\\/]/).pop(), 2500);
      close();
    } catch (e) {
      toast('error', 'Could not save the result', errorText(e));
    }
  };

  const rebase = conflict?.operation === 'rebase';
  return (
    <div className="merge-view">
      <div className="console-toolbar">
        <GitMerge size={14} />
        <b>{path.split(/[\\/]/).pop()}</b>
        <span className={left ? 'sev-warning' : 'muted'}>{error ?? (left ? `${left} conflict${left === 1 ? '' : 's'} left` : 'All conflicts resolved')}</span>
        <button className="icon-btn sm" title="Previous conflict" onClick={() => go(-1)}>
          <ArrowUp size={14} />
        </button>
        <button className="icon-btn sm" title="Next conflict" onClick={() => go(1)}>
          <ArrowDown size={14} />
        </button>
        <div className="topbar-sep" />
        <button className="btn btn-xs" onClick={() => all('ours')} disabled={!left}>
          Accept All {rebase ? 'Upstream' : 'Yours'}
        </button>
        <button className="btn btn-xs" onClick={() => all('theirs')} disabled={!left}>
          Accept All {rebase ? 'From Commit' : 'Theirs'}
        </button>
        <div className="flex-1" />
        <button className="btn btn-xs" onClick={close}>
          <X size={12} /> Cancel
        </button>
        <button className="btn btn-xs btn-primary" onClick={() => void apply()} disabled={!conflict}>
          <Check size={12} /> Apply
        </button>
      </div>
      <div className="merge-heads">
        <span>{rebase ? 'Upstream (being rebased onto)' : 'Yours (current branch)'}</span>
        <span>Result</span>
        <span>{rebase ? 'Your commit' : 'Theirs (being merged)'}</span>
      </div>
      <div className="merge-panes">
        <div ref={leftHost} className="merge-pane monaco-component" />
        <div ref={centerHost} className="merge-pane result monaco-component" />
        <div ref={rightHost} className="merge-pane monaco-component" />
      </div>
    </div>
  );
}
