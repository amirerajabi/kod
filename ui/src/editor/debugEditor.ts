// The debugger in the editor: breakpoint dots in the glyph margin (click to toggle), the execution line while stopped,
// breakpoints that move with the edited text and, while paused (as in Rider): the value popup over the hovered
// expression, inline values after the lines of the current method, and Run to Cursor from the line numbers.
import { api } from '../api/client';
import { showContextMenu, type MenuItem } from '../components/common/Menu';
import { hideValueTip, hoverValue, runToCursor, showValueTip, useDebug, type Breakpoint, type Variable } from '../store/debug';
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

  // inline values: after each line of the method up to the execution line, the values of the locals it mentions
  const valueDecos = ed.createDecorationsCollection();
  let valuesKey = '';
  const renderValues = () => {
    const model = ed.getModel();
    const path = pathOfModel(model);
    const d = useDebug.getState();
    const frame = d.frames.find((f) => f.id === d.frameId);
    const on = !!model && !!path && d.status === 'stopped' && !!frame?.path && frame.path.toLowerCase() === path.toLowerCase();
    const key = on ? `${d.stopSeq}:${frame!.id}:${path}` : '';
    if (key === valuesKey) return;
    valuesKey = key;
    valueDecos.clear();
    if (!on) return;
    void localsOf(frame!.id).then((locals) => {
      if (valuesKey !== key || ed.getModel() !== model) return;
      valueDecos.set(inlineValues(model!, frame!.line, locals));
    });
  };

  // Run to Cursor from the line numbers: hovering one while paused turns it into a green arrow, a click runs there
  const runToDecos = ed.createDecorationsCollection();
  let runToLine = 0;
  const setRunTo = (line: number) => {
    if (line === runToLine) return;
    runToLine = line;
    runToDecos.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { lineNumberClassName: 'kod-run-to' } }] : []);
  };

  // the value popup: the expression under a resting mouse, evaluated in the selected frame
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  let tipKey = '';
  const dropTip = () => {
    clearTimeout(tipTimer);
    tipKey = '';
    hideValueTip();
  };
  const offMove = ed.onMouseMove((e) => {
    const d = useDebug.getState();
    if (d.status !== 'stopped') {
      setRunTo(0);
      return;
    }
    const pos = e.target.position;
    const csharp = ed.getModel()?.getLanguageId() === 'csharp';
    setRunTo(csharp && e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && pos ? pos.lineNumber : 0);
    const model = ed.getModel();
    const found = csharp && model && pos && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ? expressionAt(model, pos, ed.getSelection()) : null;
    if (!found) return dropTip();
    const key = `${d.stopSeq}:${d.frameId}:${found.line}:${found.start}:${found.expression}`;
    if (key === tipKey) return;
    clearTimeout(tipTimer);
    tipKey = key;
    hideValueTip();
    tipTimer = setTimeout(async () => {
      const r = await hoverValue(found.expression);
      if (tipKey !== key) return;
      const at = ed.getScrolledVisiblePosition({ lineNumber: found.line, column: found.start });
      const box = ed.getDomNode()?.getBoundingClientRect();
      if (!r || !at || !box) return;
      showValueTip({ x: box.left + at.left, y: box.top + at.top + at.height, height: at.height, expression: found.expression, ...r });
    }, 350);
  });
  const offLeave = ed.onMouseLeave(() => {
    setRunTo(0);
    dropTip();
  });
  const offScroll = ed.onDidScrollChange(() => {
    clearTimeout(tipTimer);
    tipKey = '';
    if (useDebug.getState().tip) useDebug.setState({ tip: null });
  });
  const offKey = ed.onKeyDown(() => {
    clearTimeout(tipTimer);
    tipKey = '';
    if (useDebug.getState().tip) useDebug.setState({ tip: null });
  });

  const offDebug = useDebug.subscribe((s, p) => {
    render();
    renderValues();
    if (s.status !== 'stopped' && p.status === 'stopped') setRunTo(0);
  });
  const offTabs = useEditors.subscribe((s, p) => s.active !== p.active && setTimeout(render, 0));
  const offModel = ed.onDidChangeModel(() => {
    render();
    renderValues();
  });

  // edits move the dots: write the tracked lines back to the store
  let timer: ReturnType<typeof setTimeout> | undefined;
  const offContent = ed.onDidChangeModelContent(() => {
    // edited text: the values no longer line up with it
    valueDecos.clear();
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
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && runToLine && e.target.position?.lineNumber === runToLine && !e.event.rightButton) {
      const path = pathOfModel(ed.getModel());
      e.event.preventDefault();
      e.event.stopPropagation();
      if (path) void runToCursor(path, runToLine);
      setRunTo(0);
      return;
    }
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
  renderValues();
  return () => {
    offDebug();
    offTabs();
    offModel.dispose();
    offContent.dispose();
    offMouse.dispose();
    offMove.dispose();
    offLeave.dispose();
    offScroll.dispose();
    offKey.dispose();
    clearTimeout(timer);
    clearTimeout(tipTimer);
  };
}

/** The locals (and arguments) of a frame: its first scope. */
async function localsOf(frameId: number): Promise<Variable[]> {
  try {
    const scopes = await api.post<{ name: string; variablesReference: number }[]>('/debug/scopes', { frameId });
    return scopes[0] ? await api.post<Variable[]>('/debug/variables', { reference: scopes[0].variablesReference }) : [];
  } catch {
    return [];
  }
}

/** Code with string literals and comments blanked out (same length, so columns still match). */
const codeOnly = (line: string) =>
  line
    .replace(/@?\$?"(?:[^"\\]|\\.|"")*"?|'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length))
    .replace(/\/\/.*$/, (m) => ' '.repeat(m.length));

const BLOCK = /^\s*(?:}\s*)?(?:if|else|for|foreach|while|do|switch|using|lock|fixed|try|catch|finally|checked|unchecked|unsafe)\b/;

/** The first line of the method (or lambda, accessor, local function) the line is in: its opening brace's line. */
function methodStart(model: monaco.editor.ITextModel, line: number): number {
  let depth = 0;
  const stop = Math.max(1, line - 300);
  for (let l = line; l >= stop; l--) {
    const text = codeOnly(model.getLineContent(l));
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') {
        if (depth > 0) {
          depth--;
          continue;
        }
        // an enclosing block: whose header is it?
        let header = text.slice(0, i).trim();
        let h = l;
        while (!header && h > 1) header = codeOnly(model.getLineContent(--h)).trim();
        if (/\b(?:class|struct|record|interface|namespace|enum)\b/.test(header)) return l + 1;
        if (!BLOCK.test(header) && /(?:\)|=>|\bget|\bset|\binit|\badd|\bremove)\s*(?:where\b.*|:.*)?$/.test(header)) return h;
      }
    }
  }
  return stop;
}

/** "name = value" after the lines from the method's start to the execution line, for the locals each line mentions. */
function inlineValues(model: monaco.editor.ITextModel, execLine: number, locals: Variable[]): monaco.editor.IModelDeltaDecoration[] {
  const values = new Map(locals.filter((v) => v.name !== 'this' && /^[A-Za-z_]\w*$/.test(v.name)).map((v) => [v.name, v.value]));
  if (!values.size || execLine > model.getLineCount()) return [];
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (let l = methodStart(model, execLine); l <= execLine; l++) {
    const text = codeOnly(model.getLineContent(l));
    const names: string[] = [];
    for (const m of text.matchAll(/[A-Za-z_]\w*/g)) {
      const before = text.slice(0, m.index).trimEnd();
      const after = text.slice(m.index! + m[0].length).trimStart();
      // member access and calls are not the local
      if (before.endsWith('.') || after.startsWith('(') || !values.has(m[0]) || names.includes(m[0])) continue;
      names.push(m[0]);
    }
    if (!names.length) continue;
    const shown = names.slice(0, 6).map((n) => `${n} = ${clip(values.get(n)!)}`).join(', ');
    out.push({
      range: new monaco.Range(l, model.getLineMaxColumn(l), l, model.getLineMaxColumn(l)),
      options: { after: { content: `    ${shown}`, inlineClassName: 'kod-inline-value' }, showIfCollapsed: true },
    });
  }
  return out;
}

const clip = (v: string) => (v.length > 60 ? v.slice(0, 57) + '…' : v);

/** The expression to evaluate at a point: the selection when the point is in it, else the identifier with the
 *  member accesses before it (a.b.c); none for keywords, literals, calls and declarations' types. */
export function expressionAt(model: monaco.editor.ITextModel, position: monaco.IPosition, selection: monaco.Selection | null): { expression: string; line: number; start: number } | null {
  if (selection && !selection.isEmpty() && selection.startLineNumber === selection.endLineNumber && selection.containsPosition(position)) {
    const text = model.getValueInRange(selection).trim();
    if (text) return { expression: text, line: selection.startLineNumber, start: selection.startColumn };
  }
  const word = model.getWordAtPosition(position);
  if (!word || /^\d/.test(word.word) || KEYWORDS.has(word.word)) return null;
  const line = model.getLineContent(position.lineNumber);
  if (codeOnly(line)[word.startColumn - 1] === ' ') return null; // in a string or comment
  // extend left over member access: foo.Bar.Baz
  let start = word.startColumn - 1;
  while (start > 0) {
    const m = /([A-Za-z_][A-Za-z0-9_]*)\s*\??\.$/.exec(line.slice(0, start));
    if (!m) break;
    start -= m[0].length;
  }
  const expression = line.slice(start, word.endColumn - 1).replace(/\s+/g, '');
  if (!expression || /^\d/.test(expression)) return null;
  return { expression, line: position.lineNumber, start: start + 1 };
}

const KEYWORDS = new Set(
  'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await get set init nameof yield'.split(' '),
);

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
/** While paused, a hovered variable shows its value popup instead of its quick info (the C# hover asks this). */
export async function hasDebugValueAt(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<boolean> {
  if (useDebug.getState().status !== 'stopped') return false;
  const found = expressionAt(model, position, null);
  return !!found && !!(await hoverValue(found.expression));
}
