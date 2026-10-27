// Rider's Show Usages popup (Ctrl+Alt+F7, or a click on a Code Vision "N usages"): every usage of the symbol at the
// caret in a list under it. Typing filters (speed search), ↑↓ and Enter go to a usage, the toolbar filters reads and
// writes, shows a preview, and moves the search to the Find window.
import {
  AppWindow,
  ArrowUpFromLine,
  AtSign,
  BookOpen,
  Braces,
  CornerDownRight,
  Diamond,
  Eye,
  Import,
  Link,
  LoaderCircle,
  PanelBottom,
  PenLine,
  Plus,
  Shapes,
  Type,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { UsageDto } from '../api/types';
import { getEditor } from '../editor/CodeEditor';
import { basename, norm } from '../lib/paths';
import { useEditors } from '../store/editors';
import { useUi } from '../store/ui';
import { isRead, isWrite, KIND_LABEL, useUsages, type UsageKind } from '../store/usages';
import './usages.css';

const KIND_ICON: Record<UsageKind, typeof Eye> = {
  declaration: Diamond,
  invocation: CornerDownRight,
  creation: Plus,
  read: BookOpen,
  write: PenLine,
  readwrite: PenLine,
  reference: Link,
  type: Shapes,
  typeof: Braces,
  base: ArrowUpFromLine,
  attribute: AtSign,
  nameof: Type,
  import: Import,
};

export function UsageKindIcon({ kind, size = 13 }: { kind: UsageKind; size?: number }) {
  const Icon = KIND_ICON[kind] ?? Link;
  return <Icon size={size} className={`usage-kind usage-${kind}`} aria-label={KIND_LABEL[kind]} />;
}

/** The usage's line with the matched name marked (and the speed-search text, when it is in the line). */
export function UsageLine({ u, query }: { u: UsageDto; query?: string }) {
  const { line, highlightStart: a, highlightEnd: b } = u;
  const parts: ReactNode[] = [line.slice(0, a), <mark key="m">{line.slice(a, b)}</mark>, line.slice(b)];
  if (!query) return <>{parts}</>;
  const q = query.toLowerCase();
  const hit = (s: string, key: string) => {
    const i = s.toLowerCase().indexOf(q);
    return i < 0 ? s : [s.slice(0, i), <b key={key} className="speed-hit">{s.slice(i, i + q.length)}</b>, s.slice(i + q.length)];
  };
  return (
    <>
      {hit(line.slice(0, a), 'h0')}
      <mark>{line.slice(a, b)}</mark>
      {hit(line.slice(b), 'h1')}
    </>
  );
}

const preview = new Map<string, Promise<string[]>>();
function linesOf(path: string): Promise<string[]> {
  const k = norm(path);
  if (!preview.has(k))
    preview.set(
      k,
      api.get<{ text: string }>('/fs/read', { path }).then(
        (f) => f.text.split(/\r?\n/),
        () => [],
      ),
    );
  return preview.get(k)!;
}

/** A few lines around a usage, its line marked (Rider's preview under the list). */
export function UsagePreview({ u }: { u: UsageDto | undefined }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    setLines(null);
    if (!u) return;
    let live = true;
    void linesOf(u.path).then((l) => live && setLines(l));
    return () => {
      live = false;
    };
  }, [u]);
  if (!u) return <div className="usage-preview muted">Select a usage to preview it.</div>;
  if (!lines) return <div className="usage-preview" />;
  const at = u.range.startLine - 1;
  const from = Math.max(0, at - 4);
  const to = Math.min(lines.length, at + 5);
  const indent = Math.min(...lines.slice(from, to).filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return (
    <div className="usage-preview">
      {lines.slice(from, to).map((l, i) => (
        <div key={from + i} className={`usage-preview-line${from + i === at ? ' current' : ''}`}>
          <span className="usage-preview-no">{from + i + 1}</span>
          <span>{l.slice(Number.isFinite(indent) ? indent : 0) || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export function UsagesPopup() {
  const { popup, items, loading, symbol, symbolKind, error } = useUsages();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [showReads, setShowReads] = useState(true);
  const [showWrites, setShowWrites] = useState(true);
  const [showDecl, setShowDecl] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!popup) return;
    setQuery('');
    setIndex(0);
    // after the editor's own key handling, which keeps the focus otherwise
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [popup]);

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return items.filter((u) => {
      if (u.kind === 'declaration' && !showDecl) return false;
      if (!showReads && u.kind === 'read') return false;
      if (!showWrites && isWrite(u.kind) && !(showReads && isRead(u.kind))) return false;
      if (!q) return true;
      return u.line.toLowerCase().includes(q) || basename(u.path).toLowerCase().includes(q) || (u.container ?? '').toLowerCase().includes(q);
    });
  }, [items, query, showReads, showWrites, showDecl]);
  const total = items.filter((u) => u.kind !== 'declaration').length;
  const files = new Set(shown.filter((u) => u.kind !== 'declaration').map((u) => norm(u.path))).size;

  // under the caret, or above it when the window has no room below; never off-screen
  useLayoutEffect(() => {
    if (!popup || !box.current) return setPlace(null);
    const r = box.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(popup.x, window.innerWidth - r.width - 8));
    const below = popup.y + r.height <= window.innerHeight - 8;
    const lineHeight = 20;
    const top = below ? popup.y : Math.max(8, popup.y - lineHeight - r.height - 4);
    setPlace({ left, top });
  }, [popup, shown.length, showPreview, loading]);

  useEffect(() => {
    if (!popup) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close(false);
    };
    window.addEventListener('mousedown', away, true);
    return () => window.removeEventListener('mousedown', away, true);
  }, [popup]);

  useEffect(() => {
    list.current?.querySelector('.usage-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!popup) return null;

  function close(focusEditor = true) {
    useUsages.getState().set({ popup: null });
    if (focusEditor) getEditor()?.focus();
  }
  const go = (u: UsageDto | undefined) => {
    if (!u) return;
    close(false);
    void useEditors.getState().open(u.path, { range: u.range });
  };
  const toWindow = () => {
    close(false);
    useUi.getState().showBottom('usages');
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const page = 10;
    if (e.key === 'ArrowDown') setIndex((i) => Math.min(shown.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
    else if (e.key === 'PageDown') setIndex((i) => Math.min(shown.length - 1, i + page));
    else if (e.key === 'PageUp') setIndex((i) => Math.max(0, i - page));
    else if (e.key === 'Enter') go(shown[index]);
    else if (e.key === 'Escape') {
      if (query) setQuery('');
      else close();
    } else if (e.key === 'F7' && e.altKey && e.ctrlKey) toWindow();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const sel = shown[Math.min(index, shown.length - 1)];

  return (
    <div
      ref={box}
      className="usages-popup"
      style={place ? { left: place.left, top: place.top } : { left: popup.x, top: popup.y, visibility: 'hidden' }}
      role="dialog"
      aria-label={`Usages of ${symbol}`}
    >
      <div className="usages-popup-head">
        <span className="usages-popup-title">
          Usages of <b>{symbol}</b>
          {symbolKind && <span className="muted"> {symbolKind}</span>}
        </span>
        <span className="muted usages-popup-count">
          {loading ? (
            <>
              <LoaderCircle size={12} className="spin" /> searching…
            </>
          ) : (
            `${shown.length === total || query ? shown.length : `${shown.length} of ${total}`} ${total === 1 ? 'usage' : 'usages'}${files > 1 ? ` in ${files} files` : ''}`
          )}
        </span>
        <div className="flex-1" />
        <button className={`icon-btn sm${showReads ? ' on' : ''}`} title="Show read access" aria-pressed={showReads} onClick={() => setShowReads(!showReads)}>
          <BookOpen size={13} />
        </button>
        <button className={`icon-btn sm${showWrites ? ' on' : ''}`} title="Show write access" aria-pressed={showWrites} onClick={() => setShowWrites(!showWrites)}>
          <PenLine size={13} />
        </button>
        <button className={`icon-btn sm${showDecl ? ' on' : ''}`} title="Show declarations" aria-pressed={showDecl} onClick={() => setShowDecl(!showDecl)}>
          <Diamond size={13} />
        </button>
        <button className={`icon-btn sm${showPreview ? ' on' : ''}`} title="Show preview" aria-pressed={showPreview} onClick={() => setShowPreview(!showPreview)}>
          <AppWindow size={13} />
        </button>
        <button className="icon-btn sm" title="Open in Find window (Ctrl+Alt+F7)" onClick={toWindow}>
          <PanelBottom size={13} />
        </button>
      </div>
      <input
        className="usages-popup-search"
        ref={input}
        value={query}
        placeholder="Type to filter"
        aria-label="Filter usages"
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKey}
      />
      <div className="usages-popup-list" ref={list} role="listbox" aria-label="Usages">
        {error && <div className="usages-popup-empty">{error}</div>}
        {!loading && !error && shown.length === 0 && <div className="usages-popup-empty">{total === 0 ? `No usages of ${symbol} in the solution` : 'Nothing matches the filter'}</div>}
        {shown.slice(0, 500).map((u, i) => (
          <div
            key={`${u.path}:${u.range.startLine}:${u.range.startColumn}`}
            className={`usage-row${u === sel ? ' selected' : ''}`}
            role="option"
            aria-selected={u === sel}
            title={`${KIND_LABEL[u.kind]} · ${u.path}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => go(u)}
          >
            <UsageKindIcon kind={u.kind} />
            <span className="usage-code">
              <UsageLine u={u} query={query} />
            </span>
            {u.container && <span className="usage-container muted">{u.container}</span>}
            <span className="usage-loc muted">
              {basename(u.path)}:{u.range.startLine}
            </span>
          </div>
        ))}
      </div>
      {showPreview && <UsagePreview u={sel} />}
    </div>
  );
}
