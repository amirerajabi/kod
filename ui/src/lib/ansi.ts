// Minimal ANSI SGR → spans (colours 30–37 / 90–97, bold, reset). Other escape sequences are dropped.

export interface AnsiSpan {
  text: string;
  cls: string;
}

const ESC = /\u001b\[([0-9;?]*)([A-Za-z])/g;

export interface AnsiState {
  fg: number | null;
  bold: boolean;
}

export function parseAnsi(input: string, state: AnsiState = { fg: null, bold: false }): { spans: AnsiSpan[]; state: AnsiState } {
  const spans: AnsiSpan[] = [];
  let last = 0;
  let fg = state.fg;
  let bold = state.bold;
  const push = (text: string) => {
    if (!text) return;
    const cls = [fg !== null ? `ansi-${fg}` : '', bold ? 'ansi-bold' : ''].filter(Boolean).join(' ');
    const prev = spans[spans.length - 1];
    if (prev && prev.cls === cls) prev.text += text;
    else spans.push({ text, cls });
  };
  for (const m of input.matchAll(ESC)) {
    push(input.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2] !== 'm') continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const c of codes) {
      if (c === 0) {
        fg = null;
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) fg = null;
      else if (c >= 30 && c <= 37) fg = c;
      else if (c >= 90 && c <= 97) fg = c - 60;
    }
  }
  push(input.slice(last).replace(/\r(?!\n)/g, ''));
  return { spans, state: { fg, bold } };
}

export function stripAnsi(s: string): string {
  return s.replace(ESC, '');
}
