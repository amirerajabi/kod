// The debugger in the editor: breakpoint dots in the glyph margin (click to toggle), the execution line while stopped,
// breakpoints that move with the edited text, and hover evaluation of the expression under the mouse.
import { evaluate, useDebug } from '../store/debug';
import { useEditors } from '../store/editors';
import { pathOfModel } from './models';
import { monaco } from './monaco';
import './debug.css';

export function attachDebugDecorations(ed: monaco.editor.IStandaloneCodeEditor): () => void {
  const bpDecos = ed.createDecorationsCollection();
  const lineDecos = ed.createDecorationsCollection();
  let lastLines = '';

  const render = () => {
    const model = ed.getModel();
    const path = pathOfModel(model);
    if (!model || !path) {
      bpDecos.clear();
      lineDecos.clear();
      return;
    }
    const d = useDebug.getState();
    const bps = Object.values(d.breakpoints).find((b) => b.path.toLowerCase() === path.toLowerCase())?.bps ?? [];
    const live = d.status !== 'idle';
    bpDecos.set(
      bps
        .filter((b) => b.line <= model.getLineCount())
        .map((b) => ({
          range: new monaco.Range(b.line, 1, b.line, 1),
          options: {
            isWholeLine: true,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            glyphMarginClassName: `kod-bp${b.condition ? ' cond' : ''}${live && b.verified === false ? ' unverified' : ''}`,
            glyphMarginHoverMessage: { value: b.condition ? `Breakpoint when \`${b.condition}\`` : 'Breakpoint (click to remove)' },
            className: 'kod-bp-line',
          },
        })),
    );
    lastLines = bps.map((b) => b.line).join(',');
    const frame = d.frames.find((f) => f.id === d.frameId);
    if (d.status === 'stopped' && frame?.path && frame.path.toLowerCase() === path.toLowerCase()) {
      const top = frame.id === d.frames[0]?.id;
      lineDecos.set([
        {
          range: new monaco.Range(frame.line, 1, frame.line, 1),
          options: { isWholeLine: true, className: top ? 'kod-exec-line' : 'kod-frame-line', glyphMarginClassName: top ? 'kod-exec-glyph' : 'kod-frame-glyph', zIndex: 20 },
        },
      ]);
    } else lineDecos.clear();
  };

  const offDebug = useDebug.subscribe(render);
  const offTabs = useEditors.subscribe((s, p) => s.active !== p.active && setTimeout(render, 0));
  const offModel = ed.onDidChangeModel(render);

  // edits move the dots: write the tracked lines back to the store
  let timer: ReturnType<typeof setTimeout> | undefined;
  const offContent = ed.onDidChangeModelContent(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const path = pathOfModel(ed.getModel());
      if (!path) return;
      const lines = [...new Set(bpDecos.getRanges().map((r) => r.startLineNumber))].sort((a, b) => a - b);
      if (lines.join(',') === lastLines) return;
      const old = Object.values(useDebug.getState().breakpoints).find((b) => b.path.toLowerCase() === path.toLowerCase())?.bps ?? [];
      useDebug.getState().setLines(path, lines.map((line, i) => ({ line, condition: old[i]?.condition })));
    }, 400);
  });

  const offMouse = ed.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
    const path = pathOfModel(ed.getModel());
    if (path && ed.getModel()?.getLanguageId() === 'csharp') useDebug.getState().toggle(path, e.target.position.lineNumber);
  });

  render();
  return () => {
    offDebug();
    offTabs();
    offModel.dispose();
    offContent.dispose();
    offMouse.dispose();
    clearTimeout(timer);
  };
}

/** F9 / Ctrl+F8 at the caret. */
export function toggleBreakpointAtCursor(ed: monaco.editor.IStandaloneCodeEditor | null): void {
  const path = pathOfModel(ed?.getModel());
  const pos = ed?.getPosition();
  if (path && pos) useDebug.getState().toggle(path, pos.lineNumber);
}

/** While stopped, hovering an identifier (or a.b.c chain) shows its value in the current frame. */
export function registerDebugHover(): void {
  monaco.languages.registerHoverProvider('csharp', {
    async provideHover(model, position) {
      if (useDebug.getState().status !== 'stopped') return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const line = model.getLineContent(position.lineNumber);
      // extend left over member access: foo.Bar.Baz
      let start = word.startColumn - 1;
      while (start > 0) {
        const m = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(line.slice(0, start));
        if (!m) break;
        start -= m[0].length;
      }
      const expression = line.slice(start, word.endColumn - 1).replace(/^this\./, 'this.');
      if (!expression || /^\d/.test(expression)) return null;
      const r = await evaluate(expression, 'hover');
      if (!r) return null;
      return {
        range: new monaco.Range(position.lineNumber, start + 1, position.lineNumber, word.endColumn),
        contents: [{ value: '```csharp\n' + `${expression} = ${r.result}` + (r.type ? `  // ${r.type}` : '') + '\n```' }],
      };
    },
  });
}
