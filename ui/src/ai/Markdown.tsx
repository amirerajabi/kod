// A small Markdown renderer for AI answers: headings, paragraphs, lists, quotes, tables, fenced code (coloured by
// Monaco, with Copy / Insert at caret) and inline code, bold, italic and links. It builds React elements (no raw
// HTML from the model reaches the page); only Monaco's own colorizer output is set as HTML.
import { Check, Copy, CornerDownLeft } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getEditor } from '../editor/CodeEditor';
import { monaco } from '../editor/monaco';
import { platform } from '../platform';
import { toast } from '../store/ui';

const LANG_ALIASES: Record<string, string> = { cs: 'csharp', 'c#': 'csharp', csharp: 'csharp', js: 'javascript', ts: 'typescript', sh: 'shell', bash: 'shell', ps1: 'powershell', pwsh: 'powershell', xml: 'xml', csproj: 'xml', json: 'json', yml: 'yaml', md: 'markdown', sql: 'sql', py: 'python' };

function languageOf(tag: string): string {
  const t = tag.trim().toLowerCase();
  const id = LANG_ALIASES[t] ?? t;
  return monaco.languages.getLanguages().some((l) => l.id === id) ? id : 'plaintext';
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    const language = languageOf(lang);
    if (language === 'plaintext' || code.length > 60_000) return;
    void monaco.editor.colorize(code, language, { tabSize: 4 }).then((html) => {
      if (live && ref.current) ref.current.innerHTML = html;
    });
    return () => {
      live = false;
    };
  }, [code, lang]);
  const insert = () => {
    const ed = getEditor();
    const sel = ed?.getSelection();
    if (!ed || !sel) return toast('info', 'Open a file and place the caret first');
    ed.executeEdits('kod-ai', [{ range: sel, text: code, forceMoveMarkers: true }]);
    ed.focus();
  };
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span>{lang || 'text'}</span>
        <button className="icon-btn sm" title="Insert at the caret" onClick={insert}>
          <CornerDownLeft size={12} />
        </button>
        <button
          className="icon-btn sm"
          title="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre>
        <code ref={ref}>{code}</code>
      </pre>
    </div>
  );
}

/** Inline: `code`, **bold**, *italic* / _italic_, [text](http…). */
function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([\s\S]+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={k}>{inline(m[3] ?? m[4], k)}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={k}>{inline(m[5] ?? m[6], k)}</em>);
    else if (m[7] !== undefined) {
      const url = m[8];
      out.push(
        /^https?:\/\//i.test(url) ? (
          <a key={k} href={url} onClick={(e) => (e.preventDefault(), platform.openExternal(url))}>
            {m[7]}
          </a>
        ) : (
          <span key={k}>{m[7]}</span>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w#+.-]*)/.exec(line);
    if (fence) {
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={k++} code={body.join('\n')} lang={fence[2]} />);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(4, h[1].length + 1);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={k++}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push(<hr key={k++} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={k++}>
          <Markdown text={body.join('\n')} />
        </blockquote>,
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      blocks.push(
        <div key={k++} className="ai-table">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered && m[1].length <= li[1].length + 1) {
          items.push(m[3]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += `\n${lines[i++].trim()}`;
        } else break;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={k++}>
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) para.push(lines[i++]);
    if (para.length === 0) para.push(lines[i++]);
    blocks.push(<p key={k++}>{inline(para.join('\n'))}</p>);
  }
  return <div className="ai-md">{blocks}</div>;
}
