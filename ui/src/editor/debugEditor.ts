// The debugger in the editor: breakpoint dots in the glyph margin (click to toggle), the execution line while stopped,
// breakpoints that move with the edited text, and hover evaluation of the expression under the mouse.
import { showContextMenu, type MenuItem } from '../components/common/Menu';
import { evaluate, runToCursor, useDebug, type Breakpoint } from '../store/debug';
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
        .map((b) => {
          const off = b.enabled === false;
          const kind = off ? ' off' : b.suspend === false ? ' log' : b.condition || b.hitCondition ? ' cond' : '';
          return {
            range: new monaco.Range(b.line, 1, b.line, 1),
            options: {
              isWholeLine: true,
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              glyphMarginClassName: `kod-bp${kind}${live && !off && b.verified === false ? ' unverified' : ''}`,
              glyphMarginHoverMessage: { value: describe(b) },
              className: `kod-bp-line${off ? ' off' : ''}`,
            },
          };
        }),
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
      useDebug.getState().setLines(path, lines.map((line, i) => ({ ...old[i], line, verified: undefined })));
    }, 400);
  });

  // click toggles; Shift+click adds a logpoint (Rider); right-click: the breakpoint's menu
  const offMouse = ed.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
    const path = pathOfModel(ed.getModel());
    if (!path || ed.getModel()?.getLanguageId() !== 'csharp') return;
    const line = e.target.position.lineNumber;
    const has = bpAt(path, line);
    if (e.event.rightButton) {
      e.event.preventDefault();
      showContextMenu(e.event.browserEvent, gutterMenu(path, line));
    } else if (e.event.shiftKey && !has) {
      useDebug.getState().update(path, line, { suspend: false });
      useDebug.setState({ editing: { path, line } });
    } else useDebug.getState().toggle(path, line);
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

const bpAt = (path: string, line: number) => Object.values(useDebug.getState().breakpoints).find((b) => b.path.toLowerCase() === path.toLowerCase())?.bps.find((b) => b.line === line);

/** The gutter hover: what the breakpoint does. */
function describe(b: Breakpoint): string {
  const parts = [b.enabled === false ? 'Disabled breakpoint' : b.suspend === false ? 'Logpoint' : 'Breakpoint'];
  if (b.condition) parts.push(`when \`${b.condition}\``);
  if (b.hitCondition) parts.push(`on hit \`${b.hitCondition}\``);
  if (b.logMessage) parts.push(`logs \`${b.logMessage}\``);
  if (b.temporary) parts.push('(removed once hit)');
  return `${parts.join(' ')}\n\nClick to remove · right-click for properties`;
}

function gutterMenu(path: string, line: number): MenuItem[] {
  const b = bpAt(path, line);
  const d = useDebug.getState();
  if (!b)
    return [
      { label: 'Add Breakpoint', run: () => d.toggle(path, line) },
      { label: 'Add Logpoint…', run: () => (d.update(path, line, { suspend: false }), useDebug.setState({ editing: { path, line } })) },
      { label: 'Add Conditional Breakpoint…', run: () => useDebug.setState({ editing: { path, line } }) },
      ...(d.status === 'stopped' ? (['separator', { label: 'Run to This Line', run: () => void runToCursor(path, line) }] as MenuItem[]) : []),
    ];
  return [
    { label: 'Edit Breakpoint…', run: () => useDebug.setState({ editing: { path, line } }) },
    { label: b.enabled === false ? 'Enable' : 'Disable', run: () => d.update(path, line, { enabled: b.enabled === false ? undefined : false }) },
    { label: 'Remove', danger: true, run: () => d.toggle(path, line) },
    ...(d.status === 'stopped' ? (['separator', { label: 'Run to This Line', run: () => void runToCursor(path, line) }] as MenuItem[]) : []),
  ];
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
