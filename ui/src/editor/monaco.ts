// One-time Monaco setup: workers, the Kod themes (built from the CSS tokens, so they follow the app theme),
// and the language for each file extension.
import * as monaco from 'monaco-editor';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { basename, extname } from '../lib/paths';

export { monaco };

const g = globalThis as unknown as { MonacoEnvironment?: { getWorker(id: string, label: string): Worker } };
g.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

const BY_EXT: Record<string, string> = {
  '.cs': 'csharp',
  '.csx': 'csharp',
  '.csproj': 'xml',
  '.vbproj': 'xml',
  '.fsproj': 'xml',
  '.props': 'xml',
  '.targets': 'xml',
  '.slnx': 'xml',
  '.xml': 'xml',
  '.config': 'xml',
  '.resx': 'xml',
  '.xaml': 'xml',
  '.axaml': 'xml',
  '.nuspec': 'xml',
  '.manifest': 'xml',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.cshtml': 'razor',
  '.razor': 'razor',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sh': 'shell',
  '.bash': 'shell',
  '.sql': 'sql',
  '.py': 'python',
  '.dockerfile': 'dockerfile',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.ini': 'ini',
  '.editorconfig': 'ini',
  '.sln': 'ini',
  '.fs': 'fsharp',
  '.vb': 'vb',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cpp': 'cpp',
  '.h': 'cpp',
  '.c': 'c',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
};

export function languageOf(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === '.editorconfig' || name === '.gitignore' || name === '.gitattributes') return 'ini';
  return BY_EXT[extname(path)] ?? 'plaintext';
}

/**
 * A CSS token as the 6-digit hex (no '#') Monaco requires. The production CSS minifier shortens colours
 * (#ffffff → #fff), and Monaco throws on anything but #rrggbb in token rules.
 */
function v(styles: CSSStyleDeclaration, name: string): string {
  const raw = styles.getPropertyValue(name).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(raw);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return [...h.slice(0, 3)].map((c) => c + c).join('');
    return h.slice(0, 6);
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(raw);
  if (m) return m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return '808080';
}

/** (Re)defines the "kod" theme from the current CSS tokens. Called at start and on every theme switch. */
export function applyMonacoTheme(dark: boolean): void {
  const s = getComputedStyle(document.documentElement);
  const c = (name: string) => v(s, name);
  const rule = (token: string, color: string, fontStyle?: string): monaco.editor.ITokenThemeRule => ({ token, foreground: c(color), ...(fontStyle ? { fontStyle } : {}) });
  monaco.editor.defineTheme('kod', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      // Monarch (before the semantic tokens arrive, and for non-C# files)
      rule('keyword', '--syn-keyword'),
      rule('string', '--syn-string'),
      rule('string.escape', '--syn-escape'),
      rule('number', '--syn-number'),
      rule('comment', '--syn-comment', 'italic'),
      rule('type', '--syn-class'),
      rule('tag', '--syn-keyword'),
      rule('attribute.name', '--syn-property'),
      rule('attribute.value', '--syn-string'),
      rule('delimiter', '--ed-fg'),
      // Roslyn semantic tokens (engine IntelService.TokenTypes)
      rule('namespace', '--syn-namespace'),
      rule('class', '--syn-class'),
      rule('record', '--syn-class'),
      rule('struct', '--syn-struct'),
      rule('interface', '--syn-interface'),
      rule('enum', '--syn-enum'),
      rule('enumMember', '--syn-constant'),
      rule('typeParameter', '--syn-type-param'),
      rule('delegate', '--syn-class'),
      rule('method', '--syn-method'),
      rule('extensionMethod', '--syn-method', 'italic'),
      rule('property', '--syn-property'),
      rule('field', '--syn-field'),
      rule('event', '--syn-event'),
      rule('constant', '--syn-constant'),
      rule('local', '--syn-local'),
      rule('parameter', '--syn-parameter'),
      rule('label', '--syn-local'),
      rule('controlKeyword', '--syn-control'),
      rule('stringEscape', '--syn-escape'),
      rule('xmlDoc', '--syn-xmldoc', 'italic'),
      rule('preprocessor', '--syn-preprocessor'),
      rule('excluded', '--syn-excluded'),
      rule('operatorOverloaded', '--syn-method'),
      rule('regex', '--syn-string'),
      rule('json', '--syn-string'),
      { token: 'field.static', foreground: c('--syn-field'), fontStyle: 'italic' },
      { token: 'property.static', foreground: c('--syn-property'), fontStyle: 'italic' },
      { token: 'method.static', foreground: c('--syn-method'), fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': `#${c('--ed-bg')}`,
      'editor.foreground': `#${c('--ed-fg')}`,
      'editor.lineHighlightBackground': `#${c('--ed-line')}`,
      'editor.lineHighlightBorder': `#${c('--ed-line')}`,
      'editorLineNumber.foreground': `#${c('--ed-gutter-fg')}`,
      'editorLineNumber.activeForeground': `#${c('--ed-gutter-active')}`,
      'editor.selectionBackground': `#${c('--ed-selection')}`,
      'editor.findMatchHighlightBackground': `#${c('--ed-find')}80`,
      'editorGutter.background': `#${c('--ed-bg')}`,
      'editorWidget.background': `#${c('--bg-elevated')}`,
      'editorWidget.border': `#${c('--border')}`,
      'editorSuggestWidget.background': `#${c('--bg-elevated')}`,
      'editorSuggestWidget.border': `#${c('--border')}`,
      'editorSuggestWidget.selectedBackground': `#${c('--bg-selected')}`,
      'editorHoverWidget.background': `#${c('--bg-elevated')}`,
      'editorHoverWidget.border': `#${c('--border')}`,
      'editorIndentGuide.background1': `#${c('--border-subtle')}`,
      'editorIndentGuide.activeBackground1': `#${c('--border')}`,
      'editorError.foreground': `#${c('--danger')}`,
      'editorWarning.foreground': `#${c('--warning')}`,
      'editorInfo.foreground': `#${c('--info')}`,
      'scrollbarSlider.background': dark ? '#ffffff22' : '#00000022',
      'scrollbarSlider.hoverBackground': dark ? '#ffffff38' : '#00000038',
      'minimap.background': `#${c('--ed-bg')}`,
      'peekViewEditor.background': `#${c('--bg-panel')}`,
      'peekViewResult.background': `#${c('--bg-elevated')}`,
      'peekViewTitle.background': `#${c('--bg-elevated')}`,
      'peekView.border': `#${c('--accent')}`,
      'focusBorder': `#${c('--focus-ring')}`,
      'list.activeSelectionBackground': `#${c('--bg-selected')}`,
      'list.hoverBackground': `#${c('--bg-hover')}`,
      'input.background': `#${c('--bg-input')}`,
      'editorInlayHint.foreground': `#${c('--ed-gutter-fg')}`,
      'editorInlayHint.background': `#${c('--ed-line')}`,
      'editorCodeLens.foreground': `#${c('--ed-gutter-fg')}`,
      'editorStickyScroll.background': `#${c('--ed-bg')}`,
      'editorStickyScrollHover.background': `#${c('--ed-line')}`,
    },
  });
  monaco.editor.setTheme('kod');
}
