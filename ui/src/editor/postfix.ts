// Postfix templates (expr.if, expr.foreach, expr.var… — Rider / ReSharper names) and Surround With (Ctrl+Alt+T).
// The engine finds the expression before the '.' and what it is (bool, collection, nullable, task…); the templates
// themselves are snippets built here.
import { api, isAbort } from '../api/client';
import type { PostfixContextDto } from '../api/types';
import type { MenuItem } from '../components/common/Menu';
import { pathOfModel } from './models';
import { showAtCaret } from './navigation';
import { monaco } from './monaco';

/** Text inside a snippet: $, } and \ are syntax there. */
const esc = (s: string) => s.replace(/[\\$}]/g, (c) => `\\${c}`);

interface Postfix {
  key: string;
  description: string;
  /** Statement templates replace the whole expression statement. */
  statement?: boolean;
  applies(c: PostfixContextDto): boolean;
  body(e: string, c: PostfixContextDto): string;
}

const block = (head: string) => `${head}\n{\n\t$0\n}`;
const not = (e: string) => (/^[\w.]+$/.test(e) ? `!${e}` : `!(${e})`);

const TEMPLATES: Postfix[] = [
  { key: 'if', description: 'if (expr)', statement: true, applies: (c) => c.isBool, body: (e) => block(`if (${e})`) },
  { key: 'else', description: 'if (!expr)', statement: true, applies: (c) => c.isBool, body: (e) => block(`if (${not(e)})`) },
  { key: 'not', description: '!expr', applies: (c) => c.isBool, body: (e) => `${not(e)}$0` },
  { key: 'while', description: 'while (expr)', statement: true, applies: (c) => c.isBool, body: (e) => block(`while (${e})`) },
  { key: 'null', description: 'if (expr == null)', statement: true, applies: (c) => c.canBeNull && !c.isType, body: (e) => block(`if (${e} == null)`) },
  { key: 'notnull', description: 'if (expr != null)', statement: true, applies: (c) => c.canBeNull && !c.isType, body: (e) => block(`if (${e} != null)`) },
  { key: 'nn', description: 'if (expr != null)', statement: true, applies: (c) => c.canBeNull && !c.isType, body: (e) => block(`if (${e} != null)`) },
  { key: 'foreach', description: 'foreach (var x in expr)', statement: true, applies: (c) => c.isEnumerable && !c.isType, body: (e) => block(`foreach (var \${1:item} in ${e})`) },
  {
    key: 'for',
    description: 'for (var i = 0; i < expr.Count; i++)',
    statement: true,
    applies: (c) => !!c.countProperty && !c.isType,
    body: (e, c) => block(`for (var \${1:i} = 0; \${1:i} < ${e}.${c.countProperty}; \${1:i}++)`),
  },
  {
    key: 'forr',
    description: 'for (var i = expr.Count - 1; i >= 0; i--)',
    statement: true,
    applies: (c) => !!c.countProperty && !c.isType,
    body: (e, c) => block(`for (var \${1:i} = ${e}.${c.countProperty} - 1; \${1:i} >= 0; \${1:i}--)`),
  },
  { key: 'var', description: 'var x = expr;', statement: true, applies: (c) => !c.isVoid && !c.isType, body: (e, c) => `var \${1:${esc(c.suggestedName)}} = ${e};$0` },
  { key: 'return', description: 'return expr;', statement: true, applies: (c) => !c.isType, body: (e) => `return ${e};$0` },
  { key: 'yield', description: 'yield return expr;', statement: true, applies: (c) => !c.isType && !c.isVoid, body: (e) => `yield return ${e};$0` },
  { key: 'throw', description: 'throw expr;', statement: true, applies: (c) => c.isException && !c.isType, body: (e) => `throw ${e};$0` },
  { key: 'await', description: 'await expr', applies: (c) => c.isAwaitable, body: (e) => `await ${e}$0` },
  { key: 'using', description: 'using (expr) { }', statement: true, applies: (c) => c.isDisposable && !c.isType, body: (e) => block(`using (${e})`) },
  { key: 'lock', description: 'lock (expr) { }', statement: true, applies: (c) => c.canBeNull && !c.isType, body: (e) => block(`lock (${e})`) },
  { key: 'switch', description: 'switch (expr) { }', statement: true, applies: (c) => !c.isType && !c.isVoid, body: (e) => `switch (${e})\n{\n\tcase \${1:value}:\n\t\t$0\n\t\tbreak;\n}` },
  { key: 'sw', description: 'expr switch { }', applies: (c) => !c.isType && !c.isVoid, body: (e) => `${e} switch\n{\n\t\${1:_} => $0\n}` },
  { key: 'par', description: '(expr)', applies: () => true, body: (e) => `(${e})$0` },
  { key: 'cast', description: '((T)expr)', applies: (c) => !c.isType, body: (e) => `((\${1:T})${e})$0` },
  { key: 'arg', description: 'Method(expr)', applies: (c) => !c.isType, body: (e) => `\${1:Method}(${e})$0` },
  { key: 'cw', description: 'Console.WriteLine(expr);', statement: true, applies: (c) => !c.isType && !c.isVoid, body: (e) => `Console.WriteLine(${e});$0` },
  { key: 'new', description: 'new T()', applies: (c) => c.isType, body: (e) => `new ${e}($1)$0` },
  { key: 'typeof', description: 'typeof(T)', applies: (c) => c.isType, body: (e) => `typeof(${e})$0` },
  { key: 'nameof', description: 'nameof(expr)', applies: () => true, body: (e) => `nameof(${e})$0` },
];

/** One engine call per '.', reused while the template name is typed. */
let last: { key: string; value: Promise<PostfixContextDto | null> } | null = null;

function context(model: monaco.editor.ITextModel, line: number, dotColumn: number, token: monaco.CancellationToken): Promise<PostfixContextDto | null> {
  const before = model.getLineContent(line).slice(0, dotColumn - 1);
  const key = `${model.uri.toString()}|${line}|${dotColumn}|${before}`;
  if (last?.key === key) return last.value;
  const ac = new AbortController();
  token.onCancellationRequested(() => ac.abort());
  const value = api
    .post<PostfixContextDto | undefined>('/intel/postfix', { path: pathOfModel(model), text: model.getValue(), line, column: dotColumn + 1 }, ac.signal)
    .then((r) => r ?? null)
    .catch((e) => {
      if (isAbort(e)) last = null;
      return null;
    });
  last = { key, value };
  return value;
}

export function registerPostfix(): void {
  monaco.languages.registerCompletionItemProvider('csharp', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, _ctx, token) {
      if (!pathOfModel(model) || model.uri.scheme !== 'file') return { suggestions: [] };
      const lineText = model.getLineContent(position.lineNumber);
      const m = /([\w)\]"'>])\.(\w*)$/.exec(lineText.slice(0, position.column - 1));
      if (!m) return { suggestions: [] };
      const dotColumn = position.column - m[2].length - 1;
      const c = await context(model, position.lineNumber, dotColumn, token);
      // the expression must start on this line: a completion replaces text on one line only
      if (!c || c.range.startLine !== position.lineNumber) return { suggestions: [] };
      const range = new monaco.Range(position.lineNumber, c.range.startColumn, position.lineNumber, position.column);
      const e = esc(c.expression);
      return {
        suggestions: TEMPLATES.filter((t) => t.applies(c) && (!t.statement || c.isStatement)).map((t) => ({
          label: { label: t.key, description: t.description },
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: 'postfix template',
          filterText: `${c.expression}.${t.key}`,
          sortText: `~~${t.key}`,
          insertText: t.body(e, c),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      };
    },
  });
}

// ---------------------------------------------------------------- Surround With

interface Surround {
  label: string;
  /** Lines only: wraps whole statements. */
  lines?: boolean;
  wrap(body: string): string;
}

const SURROUND: Surround[] = [
  { label: 'if', lines: true, wrap: (b) => `if (\${1:condition})\n{\n${b}\n}$0` },
  { label: 'if / else', lines: true, wrap: (b) => `if (\${1:condition})\n{\n${b}\n}\nelse\n{\n\t$0\n}` },
  { label: 'while', lines: true, wrap: (b) => `while (\${1:condition})\n{\n${b}\n}$0` },
  { label: 'do / while', lines: true, wrap: (b) => `do\n{\n${b}\n} while (\${1:condition});$0` },
  { label: 'for', lines: true, wrap: (b) => `for (var \${1:i} = 0; \${1:i} < \${2:length}; \${1:i}++)\n{\n${b}\n}$0` },
  { label: 'foreach', lines: true, wrap: (b) => `foreach (var \${1:item} in \${2:collection})\n{\n${b}\n}$0` },
  { label: 'try / catch', lines: true, wrap: (b) => `try\n{\n${b}\n}\ncatch (\${1:Exception} \${2:ex})\n{\n\t$0\n}` },
  { label: 'try / finally', lines: true, wrap: (b) => `try\n{\n${b}\n}\nfinally\n{\n\t$0\n}` },
  { label: 'try / catch / finally', lines: true, wrap: (b) => `try\n{\n${b}\n}\ncatch (\${1:Exception} \${2:ex})\n{\n\t$3\n}\nfinally\n{\n\t$0\n}` },
  { label: 'using', lines: true, wrap: (b) => `using (\${1:var resource = expression})\n{\n${b}\n}$0` },
  { label: 'lock', lines: true, wrap: (b) => `lock (\${1:_sync})\n{\n${b}\n}$0` },
  { label: '{ } block', lines: true, wrap: (b) => `{\n${b}\n}$0` },
  { label: '#region', lines: true, wrap: (b) => `#region \${1:Name}\n\n${b.replace(/^\t/gm, '')}\n\n#endregion$0` },
  { label: '#if', lines: true, wrap: (b) => `#if \${1:DEBUG}\n${b.replace(/^\t/gm, '')}\n#endif$0` },
  { label: '( ) parentheses', wrap: (b) => `(${b})$0` },
  { label: '!( ) negation', wrap: (b) => `!(${b})$0` },
  { label: '(T) cast', wrap: (b) => `((\${1:T})${b})$0` },
  { label: '" " string', wrap: (b) => `"${b}"$0` },
];

/** Ctrl+Alt+T: wrap the selection (or the caret line) in a statement or an expression template. */
export function surroundWith(ed: monaco.editor.ICodeEditor): void {
  const model = ed.getModel();
  const sel = ed.getSelection();
  if (!model || !sel || model.getLanguageId() !== 'csharp') return;
  // inside one line (not the whole of it): expression templates; otherwise whole lines
  const firstCol = model.getLineFirstNonWhitespaceColumn(sel.startLineNumber);
  const lastCol = model.getLineLastNonWhitespaceColumn(sel.startLineNumber);
  const inLine = !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber && (sel.startColumn > firstCol || sel.endColumn < lastCol);
  const items = SURROUND.filter((s) => !!s.lines !== inLine);

  const run = (s: Surround) => {
    ed.focus();
    if (inLine) {
      const text = model.getValueInRange(sel);
      ed.setSelection(sel);
      insertSnippet(ed, s.wrap(esc(text)));
      return;
    }
    let end = sel.endLineNumber;
    if (end > sel.startLineNumber && sel.endColumn === 1) end--; // a selection ending at the start of a line excludes it
    const lines: string[] = [];
    for (let l = sel.startLineNumber; l <= end; l++) lines.push(model.getLineContent(l));
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), Infinity);
    const body = lines.map((l) => (l.trim() ? `\t${esc(l.slice(Number.isFinite(indent) ? indent : 0))}` : '')).join('\n');
    const start = Number.isFinite(indent) ? indent + 1 : 1;
    ed.setSelection(new monaco.Selection(sel.startLineNumber, start, end, model.getLineMaxColumn(end)));
    insertSnippet(ed, s.wrap(body));
  };

  showAtCaret(ed, [{ label: 'Surround with', disabled: true }, 'separator', ...items.map((s): MenuItem => ({ label: s.label, run: () => run(s) }))]);
}

function insertSnippet(ed: monaco.editor.ICodeEditor, snippet: string): void {
  const ctl = ed.getContribution('snippetController2') as { insert(template: string): void } | null;
  ctl?.insert(snippet);
}
