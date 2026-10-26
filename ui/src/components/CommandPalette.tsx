import { ChevronRight, CornerDownLeft, File, Hash, Search, Terminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, isAbort } from '../api/client';
import type { WorkspaceSymbolDto } from '../api/types';
import { COMMANDS, keyLabel } from '../app/commands';
import { getEditor } from '../editor/CodeEditor';
import { fuzzy } from '../lib/fuzzy';
import { basename, dirname, relative } from '../lib/paths';
import { useEditors } from '../store/editors';
import { useUi, type PaletteMode } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { FileIcon } from './common/icons';

interface Item {
  key: string;
  label: string;
  hits?: number[];
  detail?: string;
  icon: ReactNode;
  keys?: string;
  run: () => void;
}

const PREFIX: Record<string, PaletteMode> = { '>': 'commands', '#': 'symbols', ':': 'line' };

function modeOf(text: string): { mode: PaletteMode; query: string } {
  const p = PREFIX[text[0]];
  return p ? { mode: p, query: text.slice(1).trim() } : { mode: 'files', query: text.trim() };
}

function Highlight({ text, hits }: { text: string; hits?: number[] }) {
  if (!hits?.length) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>))}
    </>
  );
}

/** Search Everywhere: files (default), > actions, # symbols, : line. */
export function CommandPalette() {
  const open = useUi((s) => s.palette);
  const seed = useUi((s) => s.paletteSeed);
  const root = useWorkspace((s) => s.ws.root);
  const [text, setText] = useState('');
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [symbols, setSymbols] = useState<WorkspaceSymbolDto[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(seed);
    setSel(0);
    setTimeout(() => input.current?.focus(), 0);
    if (root) void useWorkspace.getState().loadFiles().then(setFiles).catch(() => setFiles([]));
  }, [open, seed, root]);

  const { mode, query } = modeOf(text);

  useEffect(() => {
    if (mode !== 'symbols' || !query) {
      setSymbols([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      api
        .get<WorkspaceSymbolDto[]>('/intel/workspaceSymbols', { q: query }, ac.signal)
        .then(setSymbols)
        .catch((e) => !isAbort(e) && setSymbols([]));
    }, 180);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [mode, query]);

  const close = () => useUi.getState().set({ palette: null });

  const items = useMemo((): Item[] => {
    if (mode === 'commands') {
      return COMMANDS.map((c) => ({ c, m: fuzzy(query, `${c.category}: ${c.title}`) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score)
        .slice(0, 100)
        .map(({ c, m }) => ({ key: c.id, label: `${c.category}: ${c.title}`, hits: m!.hits, icon: <Terminal size={14} />, keys: c.keys?.[0] ? keyLabel(c.keys[0]) : undefined, run: () => void c.run() }));
    }
    if (mode === 'symbols') {
      return symbols.map((s) => ({
        key: `${s.path}:${s.range.startLine}:${s.name}`,
        label: s.name,
        hits: fuzzy(query, s.name)?.hits,
        detail: `${s.kind}${s.container ? ` · ${s.container}` : ''} — ${basename(s.path)}:${s.range.startLine}`,
        icon: <Hash size={14} />,
        run: () => void useEditors.getState().open(s.path, { range: s.range }),
      }));
    }
    if (mode === 'line') {
      const [l, c] = query.split(/[:,]/).map((x) => parseInt(x, 10));
      const ed = getEditor();
      const lines = ed?.getModel()?.getLineCount() ?? 0;
      if (!ed?.getModel()) return [{ key: 'none', label: 'Open a file first', icon: <ChevronRight size={14} />, run: () => {} }];
      if (!l) return [{ key: 'hint', label: `Type a line number between 1 and ${lines}`, icon: <ChevronRight size={14} />, run: () => {} }];
      return [
        {
          key: 'go',
          label: `Go to line ${l}${c ? `, column ${c}` : ''}`,
          icon: <CornerDownLeft size={14} />,
          run: () => {
            const pos = { lineNumber: Math.min(l, lines), column: c || 1 };
            ed.setPosition(pos);
            ed.revealPositionInCenter(pos);
            ed.focus();
          },
        },
      ];
    }
    // files: open tabs first when the query is empty
    if (!query) {
      const recent = useEditors.getState().tabs.filter((t) => t.kind === 'file');
      const rest = files.filter((f) => /\.(cs|csproj|json|razor|cshtml|md|xml|slnx?)$/i.test(f)).slice(0, 60);
      const seen = new Set<string>();
      return [...recent.map((t) => t.path), ...rest]
        .filter((p) => !seen.has(p) && !!seen.add(p))
        .slice(0, 80)
        .map((p) => ({ key: p, label: basename(p), detail: relative(root, dirname(p)), icon: <FileIcon path={p} size={14} />, run: () => void useEditors.getState().open(p) }));
    }
    const scored: { p: string; score: number; hits: number[] }[] = [];
    for (const p of files) {
      const name = basename(p);
      const m = fuzzy(query, name);
      if (m) {
        scored.push({ p, score: m.score + 10 + (/\.cs$/i.test(name) ? 2 : 0), hits: m.hits });
        continue;
      }
      if (/[\\/]/.test(query)) {
        const rel = relative(root, p);
        const mr = fuzzy(query, rel);
        if (mr) scored.push({ p, score: mr.score, hits: [] });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 100).map(({ p, hits }) => ({ key: p, label: basename(p), hits, detail: relative(root, dirname(p)), icon: <FileIcon path={p} size={14} />, run: () => void useEditors.getState().open(p) }));
  }, [mode, query, files, symbols, root]);

  useEffect(() => setSel(0), [text]);
  useEffect(() => {
    list.current?.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    it.run();
  };

  const placeholder = mode === 'commands' ? 'Find an action' : mode === 'symbols' ? 'Find a type or member' : mode === 'line' ? 'Line[:column]' : 'Search files (> actions, # symbols, : line)';

  return (
    <div className="overlay soft" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Search everywhere">
        <div className="palette-input-row">
          {mode === 'files' ? <File size={16} /> : mode === 'commands' ? <Terminal size={16} /> : mode === 'symbols' ? <Hash size={16} /> : <Search size={16} />}
          <input
            ref={input}
            className="palette-input"
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') setSel((s) => Math.min(items.length - 1, s + 1));
              else if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
              else if (e.key === 'Enter') choose(sel);
              else if (e.key === 'Tab') {
                // cycle the modes like Rider's Search Everywhere tabs
                const order = ['', '>', '#'];
                const cur = order.indexOf(text[0] && PREFIX[text[0]] ? text[0] : '');
                setText(order[(cur + 1) % order.length] + query);
              } else return;
              e.preventDefault();
            }}
            spellCheck={false}
          />
          <span className="palette-mode">{mode === 'files' ? 'Files' : mode === 'commands' ? 'Actions' : mode === 'symbols' ? 'Symbols' : 'Line'}</span>
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {items.length === 0 && <div className="palette-empty">{mode === 'symbols' && !query ? 'Type a symbol name' : root || mode !== 'files' ? 'No matches' : 'Open a folder to search its files'}</div>}
          {items.map((it, i) => (
            <div key={it.key} role="option" aria-selected={i === sel} className={`palette-item${i === sel ? ' selected' : ''}`} onMouseMove={() => setSel(i)} onClick={() => choose(i)}>
              <span className="palette-icon">{it.icon}</span>
              <span className="palette-label">
                <Highlight text={it.label} hits={it.hits} />
              </span>
              <span className="palette-detail">{it.detail}</span>
              {it.keys && <span className="menu-shortcut">{it.keys}</span>}
            </div>
          ))}
        </div>
        <div className="palette-footer">
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span>Tab: files → actions → symbols</span>
          <span>: line</span>
        </div>
      </div>
    </div>
  );
}
