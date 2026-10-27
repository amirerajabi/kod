// .http / .rest files: colouring, "▶ Send request" and "Copy as cURL" above every request, Ctrl+Enter to send the
// request at the caret, and completion of the variables, methods and common headers.
import { parseHttpFile } from '../lib/httpFile';
import { copyAsCurl, sendHttpRequest } from '../store/http';
import { pathOfModel } from './models';
import { monaco } from './monaco';

const HEADERS = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-Match',
  'If-None-Match', 'Origin', 'Referer', 'User-Agent', 'X-Api-Key', 'X-Correlation-Id', 'X-Requested-With',
];
const VALUES: Record<string, string[]> = {
  'content-type': ['application/json', 'application/xml', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'],
  accept: ['application/json', 'application/xml', 'text/html', '*/*'],
  authorization: ['Bearer {{token}}', 'Basic {{credentials}}'],
};

export function registerHttp(): void {
  monaco.languages.register({ id: 'http', extensions: ['.http', '.rest'], aliases: ['HTTP'] });
  monaco.languages.setMonarchTokensProvider('http', {
    tokenizer: {
      root: [
        [/^###.*$/, 'comment.doc'],
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^@[\w.-]+/, 'variable', '@varValue'],
        [/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(?=\s)/, 'keyword', '@url'],
        [/^[\w-]+(?=\s*:)/, 'attribute.name', '@header'],
        [/\{\{[^}]*\}\}/, 'variable'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(\.\d+)?/, 'number'],
        [/\b(true|false|null)\b/, 'keyword'],
      ],
      url: [
        [/\{\{[^}]*\}\}/, 'variable'],
        [/HTTP\/[\d.]+/, 'keyword'],
        [/$/, '', '@pop'],
        [/[^{\s]+|\{/, 'string.link'],
      ],
      header: [
        [/\{\{[^}]*\}\}/, 'variable'],
        [/$/, '', '@pop'],
        [/:/, 'delimiter'],
        [/[^{]+|\{/, 'string'],
      ],
      varValue: [
        [/\{\{[^}]*\}\}/, 'variable'],
        [/$/, '', '@pop'],
        [/[^{]+|\{/, 'string'],
      ],
    },
  });

  const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses(model) {
      const path = pathOfModel(model);
      if (!path) return { lenses: [], dispose() {} };
      const lenses = parseHttpFile(model.getValue()).requests.flatMap((r) => {
        const range = new monaco.Range(r.line, 1, r.line, 1);
        return [
          { range, command: { id: 'kod.http.send', title: '▶ Send request', arguments: [path, r.line] } },
          { range, command: { id: 'kod.http.curl', title: 'Copy as cURL', arguments: [path, r.line] } },
        ];
      });
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider('http', provider);
  monaco.editor.registerCommand('kod.http.send', (_a, path: string, line: number) => void sendHttpRequest(path, line));
  monaco.editor.registerCommand('kod.http.curl', (_a, path: string, line: number) => void copyAsCurl(path, line));

  monaco.editor.addEditorAction({
    id: 'kod.http.sendAtCaret',
    label: 'Send HTTP Request',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    precondition: 'editorLangId == http',
    contextMenuGroupId: '0_http',
    run: (ed) => {
      const path = pathOfModel(ed.getModel());
      const pos = ed.getPosition();
      if (path && pos) void sendHttpRequest(path, pos.lineNumber);
    },
  });

  monaco.languages.registerCompletionItemProvider('http', {
    triggerCharacters: ['{', ':', ' '],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const K = monaco.languages.CompletionItemKind;
      // {{variable}}
      const open = /\{\{\s*([\w$.-]*)$/.exec(before);
      if (open) {
        const vars = Object.keys(parseHttpFile(model.getValue()).vars);
        const dyn = ['$guid', '$timestamp', '$isoTimestamp', '$randomInt', '$datetime'];
        const start = position.column - open[1].length;
        const r = new monaco.Range(position.lineNumber, start, position.lineNumber, position.column);
        return { suggestions: [...vars.map((v) => ({ label: v, kind: K.Variable, insertText: v, range: r })), ...dyn.map((v) => ({ label: v, kind: K.Function, insertText: v, range: r }))] };
      }
      // Header: value
      const header = /^([\w-]+)\s*:\s*[^:]*$/.exec(before);
      if (header) {
        const values = VALUES[header[1].toLowerCase()] ?? [];
        return { suggestions: values.map((v) => ({ label: v, kind: K.Value, insertText: v, range })) };
      }
      if (/^\s*[\w-]*$/.test(before)) {
        return {
          suggestions: [
            ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({ label: m, kind: K.Keyword, insertText: `${m} `, range, sortText: '0' + m })),
            ...HEADERS.map((h) => ({ label: h, kind: K.Property, insertText: `${h}: `, range, sortText: '1' + h })),
          ],
        };
      }
      return { suggestions: [] };
    },
  });
}
