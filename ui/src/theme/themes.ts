// Colour themes (app) and code themes (the editor), as in Rowlit. tokens.css stays the source of the two base themes
// (Light / Dark); every other theme is a set of overrides of its base block, applied as inline custom properties on
// <html> (applyThemes). settings.theme is the mode (system | light | dark); one light and one dark app theme are kept
// (so "System" switches between the user's two favourites) plus the code theme ('match' = derived from the app theme).

export type ThemeBase = 'light' | 'dark';
export type ThemeVars = Readonly<Record<string, string>>;

export interface AppTheme {
  id: string;
  name: string;
  base: ThemeBase;
  description: string;
  vars: ThemeVars;
}

export interface CodeTheme {
  id: string;
  name: string;
  base: ThemeBase;
  group: 'kod' | 'jetbrains' | 'popular';
  description: string;
  vars: ThemeVars;
}

export const MATCH_APP = 'match';

const glass = (rgb: string, dark: boolean): Record<string, string> => ({ '--glass-bg': `rgb(${rgb} / ${dark ? 70 : 62}%)` });

// ------------------------------------------------------------------ app themes (Rowlit's palettes)

const MIDNIGHT: ThemeVars = {
  '--bg-app': '#0b0f17', '--bg-panel': '#111722', '--bg-elevated': '#171f2c', '--bg-hover': '#1b2433', '--bg-selected': '#1d3354',
  '--bg-sunken': '#0d121b', '--bg-active': '#243045', '--bg-input': '#0d121b', '--bg-selected-inactive': '#1c2534',
  '--border': '#2e3a50', '--border-strong': '#5d6d86', '--border-subtle': '#1b2433', '--fg': '#e2e8f0', '--fg-muted': '#94a3b8',
  '--fg-disabled': '#4f5b6e', '--fg-muted-on-selected': '#b6c3d6', '--accent': '#60a5fa', '--accent-fg': '#0b1220', '--accent-hover': '#93c5fd',
  '--accent-soft': '#142640', '--accent-on-selected': '#a9cdfd', '--focus-ring': '#93c5fd', '--success-soft': '#10261b', '--warning-soft': '#2a2413',
  '--danger-soft': '#2e191c', '--info-soft': '#0f262c',
  '--syn-keyword': '#7aa2f7', '--syn-string': '#9ece6a', '--syn-comment': '#7f8ca3', '--syn-number': '#ff9e64', '--syn-function': '#bb9af7', '--syn-type': '#7dcfff', '--syn-variable': '#e0af68',
  ...glass('17 23 34', true),
};

const NORD: ThemeVars = {
  '--bg-app': '#272c36', '--bg-panel': '#2e3440', '--bg-elevated': '#353c4a', '--bg-hover': '#3a4150', '--bg-selected': '#3c4f66',
  '--bg-sunken': '#2a2f3a', '--bg-active': '#434c5e', '--bg-input': '#2a2f3a', '--bg-selected-inactive': '#3b4252',
  '--border': '#485164', '--border-strong': '#7b879c', '--border-subtle': '#3a4150', '--fg': '#eceff4', '--fg-muted': '#aab4c4',
  '--fg-disabled': '#646f85', '--fg-muted-on-selected': '#c5cdda', '--accent': '#88c0d0', '--accent-fg': '#1f242d', '--accent-hover': '#a3d0dd',
  '--accent-soft': '#36475a', '--accent-on-selected': '#b4dbe6', '--focus-ring': '#8fbcbb', '--success': '#a3be8c', '--warning': '#ebcb8b',
  '--danger': '#e3949b', '--info': '#8fbcbb', '--danger-text': '#efb1b6', '--success-soft': '#38443d', '--warning-soft': '#45433f',
  '--danger-soft': '#463a43', '--info-soft': '#344548',
  '--syn-keyword': '#81a1c1', '--syn-string': '#a3be8c', '--syn-comment': '#929db1', '--syn-number': '#c6a4c2', '--syn-function': '#88c0d0', '--syn-type': '#8fbcbb', '--syn-variable': '#ebcb8b',
  ...glass('46 52 64', true),
};

const VIOLET: ThemeVars = {
  '--bg-app': '#21222c', '--bg-panel': '#282a36', '--bg-elevated': '#2f3241', '--bg-hover': '#343746', '--bg-selected': '#44475a',
  '--bg-sunken': '#23242f', '--bg-active': '#4a4d62', '--bg-input': '#23242f', '--bg-selected-inactive': '#393b4b',
  '--border': '#44475a', '--border-strong': '#7a7fa3', '--border-subtle': '#343746', '--fg': '#f8f8f2', '--fg-muted': '#acb0c8',
  '--fg-disabled': '#636781', '--fg-muted-on-selected': '#c9cce0', '--accent': '#bd93f9', '--accent-fg': '#1e1f29', '--accent-hover': '#cfaefb',
  '--accent-soft': '#3a3352', '--accent-on-selected': '#dcc4fd', '--focus-ring': '#d2b4fc', '--success': '#50fa7b', '--warning': '#ffb86c',
  '--danger': '#ff6e6e', '--info': '#8be9fd', '--danger-text': '#ff9a9a', '--success-soft': '#24392f', '--warning-soft': '#3e3430',
  '--danger-soft': '#422a32', '--info-soft': '#263c47',
  '--syn-keyword': '#ff79c6', '--syn-string': '#f1fa8c', '--syn-comment': '#8e98c9', '--syn-number': '#bd93f9', '--syn-function': '#50fa7b', '--syn-type': '#8be9fd', '--syn-variable': '#ffb86c',
  ...glass('40 42 54', true),
};

const DARCULA: ThemeVars = {
  '--bg-app': '#1e1f22', '--bg-panel': '#2b2d30', '--bg-elevated': '#2b2d30', '--bg-hover': '#393b40', '--bg-selected': '#2e436e',
  '--bg-sunken': '#1e1f22', '--bg-active': '#43454a', '--bg-input': '#1e1f22', '--bg-selected-inactive': '#393b40',
  '--border': '#43454a', '--border-strong': '#6f737a', '--border-subtle': '#393b40', '--fg': '#dfe1e5', '--fg-muted': '#9da0a8',
  '--fg-disabled': '#5a5d63', '--fg-muted-on-selected': '#b4b8bf', '--accent': '#548af7', '--accent-fg': '#ffffff', '--accent-hover': '#6d9cf9',
  '--accent-soft': '#25324d', '--accent-on-selected': '#a8c3fb', '--focus-ring': '#548af7',
  ...glass('43 45 48', true),
};

const PAPER: ThemeVars = {
  '--bg-app': '#f2eee5', '--bg-panel': '#fbf9f4', '--bg-elevated': '#fffdf9', '--bg-hover': '#ede8dd', '--bg-selected': '#d9ebe6',
  '--bg-sunken': '#efebe1', '--bg-active': '#e5dfd2', '--bg-input': '#fffdf9', '--bg-selected-inactive': '#ebe6da',
  '--border': '#cfc7b6', '--border-strong': '#8c8474', '--border-subtle': '#e8e2d6', '--fg': '#2a251f', '--fg-muted': '#655d52',
  '--fg-disabled': '#a59d8f', '--fg-muted-on-selected': '#575046', '--accent': '#0f766e', '--accent-fg': '#ffffff', '--accent-hover': '#115e59',
  '--accent-soft': '#e2f0ec', '--accent-on-selected': '#0b5550', '--focus-ring': '#0f766e', '--success-soft': '#edf6eb', '--warning-soft': '#fbf3e6',
  '--danger-soft': '#f8e6e2', '--info-soft': '#e2f0f1',
  '--syn-keyword': '#9a3412', '--syn-string': '#4d6b0f', '--syn-comment': '#736a5d', '--syn-number': '#a14a07', '--syn-function': '#6d28d9', '--syn-type': '#0e6a7d', '--syn-variable': '#8a5a00',
  ...glass('251 249 244', false),
};

const SOLARIZED_LIGHT: ThemeVars = {
  '--bg-app': '#f1ead6', '--bg-panel': '#fdf6e3', '--bg-elevated': '#fffaee', '--bg-hover': '#efe8d2', '--bg-selected': '#dfe6dc',
  '--bg-sunken': '#f3ecd8', '--bg-active': '#e8e0c8', '--bg-input': '#fffaee', '--bg-selected-inactive': '#ede5cf',
  '--border': '#d4c9a8', '--border-strong': '#8a8f84', '--border-subtle': '#ece4cc', '--fg': '#073642', '--fg-muted': '#4b6168',
  '--fg-disabled': '#a3a99c', '--fg-muted-on-selected': '#435960', '--accent': '#1f6aa5', '--accent-fg': '#ffffff', '--accent-hover': '#18578a',
  '--accent-soft': '#e3ebe6', '--accent-on-selected': '#154f7d', '--focus-ring': '#1f6aa5', '--success': '#5c6b00', '--warning': '#9c4a12',
  '--danger': '#bb2420', '--info': '#1c706b', '--success-soft': '#ecefd5', '--warning-soft': '#f8e8d2', '--danger-soft': '#f9e2d6', '--info-soft': '#e4efe8',
  '--syn-keyword': '#5e6b00', '--syn-string': '#1d7a72', '--syn-comment': '#5f6f73', '--syn-number': '#b33275', '--syn-function': '#1f6aa5', '--syn-type': '#9c4a12', '--syn-variable': '#8a6400',
  ...glass('253 246 227', false),
};

const INTELLIJ_LIGHT: ThemeVars = {
  '--bg-app': '#f7f8fa', '--bg-panel': '#ffffff', '--bg-elevated': '#ffffff', '--bg-hover': '#ebecf0', '--bg-selected': '#d4e2ff',
  '--bg-sunken': '#f2f3f5', '--bg-active': '#dfe1e5', '--bg-input': '#ffffff', '--bg-selected-inactive': '#e6e7ea',
  '--border': '#d3d5db', '--border-strong': '#8c8f96', '--border-subtle': '#ebecf0', '--fg': '#000000', '--fg-muted': '#6c707e',
  '--accent': '#3574f0', '--accent-hover': '#2f68d8', '--accent-soft': '#edf3ff', '--accent-on-selected': '#2a5bc2', '--focus-ring': '#3574f0',
  ...glass('247 248 250', false),
};

/** The app themes, light ones first (the picker groups them by base). */
export const APP_THEMES: readonly AppTheme[] = [
  { id: 'light', name: 'Light', base: 'light', description: 'Crisp and neutral', vars: {} },
  { id: 'paper', name: 'Paper', base: 'light', description: 'Warm paper, teal accent', vars: PAPER },
  { id: 'solarized-light', name: 'Solarized Light', base: 'light', description: 'Low-glare cream', vars: SOLARIZED_LIGHT },
  { id: 'intellij-light', name: 'IntelliJ Light', base: 'light', description: 'JetBrains light, blue accent', vars: INTELLIJ_LIGHT },
  { id: 'dark', name: 'Dark', base: 'dark', description: 'Soft graphite', vars: {} },
  { id: 'midnight', name: 'Midnight', base: 'dark', description: 'Deep blue-black', vars: MIDNIGHT },
  { id: 'nord', name: 'Nord', base: 'dark', description: 'Arctic slate, frost blue', vars: NORD },
  { id: 'violet', name: 'Violet', base: 'dark', description: 'Dracula-style purple', vars: VIOLET },
  { id: 'darcula', name: 'Darcula', base: 'dark', description: 'JetBrains new UI dark', vars: DARCULA },
];

// ------------------------------------------------------------------ code themes (the C# editor surface + syntax)

/** Every key a code theme sets: the editor surface and the Roslyn token colours. */
const code = (
  ed: { bg: string; fg: string; line: string; gutter: string; gutterActive: string; selection: string },
  s: { keyword: string; control?: string; string: string; number: string; comment: string; type: string; iface?: string; struct?: string; method: string; member: string; local?: string; param?: string; ns?: string; escape?: string; preproc?: string },
): ThemeVars => ({
  '--ed-bg': ed.bg, '--ed-fg': ed.fg, '--ed-line': ed.line, '--ed-gutter-fg': ed.gutter, '--ed-gutter-active': ed.gutterActive, '--ed-selection': ed.selection,
  '--syn-keyword': s.keyword, '--syn-control': s.control ?? s.keyword, '--syn-string': s.string, '--syn-escape': s.escape ?? s.number,
  '--syn-number': s.number, '--syn-comment': s.comment, '--syn-xmldoc': s.comment, '--syn-class': s.type, '--syn-interface': s.iface ?? s.type,
  '--syn-struct': s.struct ?? s.type, '--syn-enum': s.struct ?? s.type, '--syn-type-param': s.iface ?? s.type, '--syn-method': s.method,
  '--syn-property': s.member, '--syn-field': s.member, '--syn-event': s.member, '--syn-constant': s.member, '--syn-local': s.local ?? ed.fg,
  '--syn-parameter': s.param ?? s.local ?? ed.fg, '--syn-namespace': s.ns ?? ed.fg, '--syn-preprocessor': s.preproc ?? s.comment, '--syn-excluded': ed.gutter,
});

export const CODE_THEMES: readonly CodeTheme[] = [
  {
    id: 'rider-dark', name: 'Rider Dark', base: 'dark', group: 'jetbrains', description: 'Rider’s default dark scheme',
    vars: code({ bg: '#1e1f22', fg: '#bdbdbd', line: '#26282e', gutter: '#4b5059', gutterActive: '#a1a3ab', selection: '#214283' },
      { keyword: '#6c95eb', string: '#c9a26d', number: '#ed94c0', comment: '#85c46c', type: '#c191ff', struct: '#e1bfff', method: '#39cc9b', member: '#66c3cc', escape: '#d688d4', preproc: '#9b9b9b' }),
  },
  {
    id: 'rider-light', name: 'Rider Light', base: 'light', group: 'jetbrains', description: 'Rider’s default light scheme',
    vars: code({ bg: '#ffffff', fg: '#080808', line: '#f5f8fe', gutter: '#adb0b8', gutterActive: '#4c4f57', selection: '#a6d2ff' },
      { keyword: '#0033b3', string: '#067d17', number: '#1750eb', comment: '#8c8c8c', type: '#008080', method: '#00627a', member: '#871094', ns: '#000000', escape: '#0037a6', preproc: '#9e880d' }),
  },
  {
    id: 'darcula', name: 'Darcula', base: 'dark', group: 'jetbrains', description: 'IntelliJ classic dark',
    vars: code({ bg: '#2b2b2b', fg: '#a9b7c6', line: '#323232', gutter: '#606366', gutterActive: '#a4a3a3', selection: '#214283' },
      { keyword: '#cc7832', string: '#6a8759', number: '#6897bb', comment: '#808080', type: '#a9b7c6', iface: '#a9b7c6', method: '#ffc66d', member: '#9876aa', escape: '#cc7832', preproc: '#bbb529' }),
  },
  {
    id: 'vs-dark', name: 'Visual Studio Dark', base: 'dark', group: 'popular', description: 'VS 2022 / VS Code Dark+',
    vars: code({ bg: '#1e1e1e', fg: '#d4d4d4', line: '#2a2a2a', gutter: '#858585', gutterActive: '#c6c6c6', selection: '#264f78' },
      { keyword: '#569cd6', control: '#c586c0', string: '#ce9178', number: '#b5cea8', comment: '#6a9955', type: '#4ec9b0', iface: '#b8d7a3', struct: '#86c691', method: '#dcdcaa', member: '#9cdcfe', local: '#9cdcfe', escape: '#d7ba7d', preproc: '#9b9b9b' }),
  },
  {
    id: 'vs-light', name: 'Visual Studio Light', base: 'light', group: 'popular', description: 'VS 2022 / VS Code Light+',
    vars: code({ bg: '#ffffff', fg: '#000000', line: '#f3f3f3', gutter: '#237893', gutterActive: '#0b216f', selection: '#add6ff' },
      { keyword: '#0000ff', control: '#af00db', string: '#a31515', number: '#098658', comment: '#008000', type: '#267f99', iface: '#2b91af', method: '#795e26', member: '#001080', local: '#001080', escape: '#ee0000', preproc: '#808080' }),
  },
  {
    id: 'github-dark', name: 'GitHub Dark', base: 'dark', group: 'popular', description: 'GitHub’s dark code view',
    vars: code({ bg: '#0d1117', fg: '#e6edf3', line: '#161b22', gutter: '#6e7681', gutterActive: '#e6edf3', selection: '#264f78' },
      { keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', comment: '#8b949e', type: '#ffa657', method: '#d2a8ff', member: '#79c0ff' }),
  },
  {
    id: 'github-light', name: 'GitHub Light', base: 'light', group: 'popular', description: 'GitHub’s light code view',
    vars: code({ bg: '#ffffff', fg: '#1f2328', line: '#f6f8fa', gutter: '#8c959f', gutterActive: '#1f2328', selection: '#b6e3ff' },
      { keyword: '#cf222e', string: '#0a3069', number: '#0550ae', comment: '#6e7781', type: '#953800', method: '#8250df', member: '#0550ae' }),
  },
  {
    id: 'dracula', name: 'Dracula', base: 'dark', group: 'popular', description: 'Purple, pink and green',
    vars: code({ bg: '#282a36', fg: '#f8f8f2', line: '#44475a66', gutter: '#6272a4', gutterActive: '#f8f8f2', selection: '#44475a' },
      { keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4', type: '#8be9fd', method: '#50fa7b', member: '#ffb86c' }),
  },
  {
    id: 'monokai', name: 'Monokai', base: 'dark', group: 'popular', description: 'The classic',
    vars: code({ bg: '#272822', fg: '#f8f8f2', line: '#3e3d32', gutter: '#90908a', gutterActive: '#f8f8f2', selection: '#49483e' },
      { keyword: '#f92672', string: '#e6db74', number: '#ae81ff', comment: '#88846f', type: '#66d9ef', method: '#a6e22e', member: '#fd971f' }),
  },
  {
    id: 'one-dark', name: 'One Dark', base: 'dark', group: 'popular', description: 'Atom’s One Dark',
    vars: code({ bg: '#282c34', fg: '#abb2bf', line: '#2c313c', gutter: '#636d83', gutterActive: '#abb2bf', selection: '#3e4451' },
      { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#7f848e', type: '#e5c07b', method: '#61afef', member: '#e06c75' }),
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', base: 'dark', group: 'popular', description: 'Low-contrast teal',
    vars: code({ bg: '#002b36', fg: '#93a1a1', line: '#073642', gutter: '#586e75', gutterActive: '#93a1a1', selection: '#274642' },
      { keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#657b83', type: '#b58900', method: '#268bd2', member: '#cb4b16' }),
  },
  {
    id: 'solarized-light', name: 'Solarized Light', base: 'light', group: 'popular', description: 'Cream and teal',
    vars: code({ bg: '#fdf6e3', fg: '#586e75', line: '#eee8d5', gutter: '#93a1a1', gutterActive: '#586e75', selection: '#eee8d5' },
      { keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#93a1a1', type: '#b58900', method: '#268bd2', member: '#cb4b16' }),
  },
];

export const CODE_GROUPS: readonly { id: CodeTheme['group']; title: string }[] = [
  { id: 'jetbrains', title: 'JetBrains' },
  { id: 'popular', title: 'Popular' },
];

// ------------------------------------------------------------------ resolution

/** The base blocks of tokens.css, as far as previews and derivations need them. */
export const BASE: Record<ThemeBase, Record<string, string>> = {
  light: {
    '--bg-app': '#f5f6f8', '--bg-panel': '#ffffff', '--bg-sunken': '#eef0f3', '--bg-hover': '#eceef2', '--bg-selected': '#dde8fb', '--border': '#ccd1d9',
    '--border-subtle': '#e8ebef', '--fg': '#1c1f24', '--fg-muted': '#5f6673', '--fg-disabled': '#a0a6b0', '--accent': '#2563eb',
    ...CODE_THEMES.find((t) => t.id === 'rider-light')!.vars,
  },
  dark: {
    '--bg-app': '#1b1d21', '--bg-panel': '#24272d', '--bg-sunken': '#1f2125', '--bg-hover': '#30343c', '--bg-selected': '#2e4466', '--border': '#41464f',
    '--border-subtle': '#30343c', '--fg': '#e6e8eb', '--fg-muted': '#9aa1ab', '--fg-disabled': '#646a74', '--accent': '#5b9cff',
    ...CODE_THEMES.find((t) => t.id === 'rider-dark')!.vars,
  },
};

export const appThemeById = (id: string | undefined) => APP_THEMES.find((t) => t.id === id);
export const codeThemeById = (id: string | undefined) => CODE_THEMES.find((t) => t.id === id);

/** Editor colours derived from an app theme ("Match app theme"): the Rider scheme of its base, tinted by the theme. */
export function matchVars(app: AppTheme): Record<string, string> {
  const v = app.vars;
  if (!Object.keys(v).length) return {};
  const bg = v['--bg-panel'];
  const fg = v['--fg'];
  const out: Record<string, string> = {};
  if (bg) out['--ed-bg'] = bg;
  if (fg) out['--ed-fg'] = out['--syn-local'] = out['--syn-parameter'] = out['--syn-namespace'] = fg;
  if (v['--bg-hover']) out['--ed-line'] = v['--bg-hover'];
  if (v['--fg-disabled']) out['--ed-gutter-fg'] = out['--syn-excluded'] = v['--fg-disabled'];
  if (v['--fg-muted']) out['--ed-gutter-active'] = v['--fg-muted'];
  if (v['--bg-selected']) out['--ed-selection'] = v['--bg-selected'];
  const map: [string, string[]][] = [
    ['--syn-keyword', ['--syn-keyword', '--syn-control']],
    ['--syn-string', ['--syn-string']],
    ['--syn-number', ['--syn-number', '--syn-escape']],
    ['--syn-comment', ['--syn-comment', '--syn-xmldoc', '--syn-preprocessor']],
    ['--syn-type', ['--syn-class', '--syn-interface', '--syn-struct', '--syn-enum', '--syn-type-param']],
    ['--syn-function', ['--syn-method']],
    ['--syn-variable', ['--syn-property', '--syn-field', '--syn-event', '--syn-constant']],
  ];
  for (const [from, tos] of map) if (v[from]) for (const t of tos) out[t] = v[from];
  return out;
}

/** Full token map of a theme for previews (base block + overrides). */
export const tokensOf = (base: ThemeBase, ...vars: ThemeVars[]): Record<string, string> => Object.assign({}, BASE[base], ...vars);
