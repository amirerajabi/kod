import { ChevronDown, ChevronRight, LoaderCircle, Replace, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorText, isAbort } from '../api/client';
import type { SearchFileResult } from '../api/types';
import { basename, dirname, relative } from '../lib/paths';
import { applyFileEdits, useEditors } from '../store/editors';
import { askConfirm, toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { FileIcon } from './common/icons';

/** Find (and replace) in files across the workspace. */
export function SearchPanel() {
  const root = useWorkspace((s) => s.ws.root);
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [include, setInclude] = useState('');
  const [opts, setOpts] = useState({ regex: false, matchCase: false, wholeWord: false });
  const [results, setResults] = useState<SearchFileResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const input = useRef<HTMLInputElement>(null);
  const ac = useRef<AbortController | null>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (!root || query.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      ac.current?.abort();
      const c = new AbortController();
      ac.current = c;
      setBusy(true);
      try {
        const res = await api.post<SearchFileResult[]>('/fs/search', { query, include: include || undefined, ...opts }, c.signal);
        setResults(res);
      } catch (e) {
        if (!isAbort(e)) toast('error', 'Search failed', errorText(e));
      } finally {
        if (ac.current === c) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, include, opts, root]);

  const total = results.reduce((n, f) => n + f.matches.length, 0);

  const replaceAll = async () => {
    if (!total) return;
    const ok = await askConfirm({ title: 'Replace all', message: `Replace ${total} match${total === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'} with "${replace}"?`, okLabel: 'Replace' });
    if (ok !== 'ok') return;
    const flags = (opts.matchCase ? '' : 'i') + 'g';
    let pattern = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
    const re = new RegExp(pattern, flags);
    const files = results.map((f) => ({
      path: f.path,
      edits: f.matches.map((m) => {
        re.lastIndex = 0;
        const original = m.preview.substr(m.previewColumn - 1, m.length);
        const text = opts.regex ? original.replace(re, replace) : replace;
        return { range: { startLine: m.line, startColumn: m.column, endLine: m.line, endColumn: m.column + m.length }, newText: text };
      }),
    }));
    const n = await applyFileEdits(files);
    toast('success', `Replaced in ${n} file${n === 1 ? '' : 's'}`, 'Open files were changed in the editor; save them to keep the change.');
  };

  const Toggle = ({ k, label, title }: { k: keyof typeof opts; label: string; title: string }) => (
    <button className={`toggle-btn${opts[k] ? ' on' : ''}`} title={title} aria-pressed={opts[k]} onClick={() => setOpts({ ...opts, [k]: !opts[k] })}>
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-header">
        <span className="panel-title">Find in files</span>
        <button className={`icon-btn sm${showReplace ? ' on' : ''}`} title="Replace" onClick={() => setShowReplace(!showReplace)}>
          <Replace size={14} />
        </button>
      </div>
      <div className="search-form">
        <div className="search-row">
          <input ref={input} className="input sm" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Toggle k="matchCase" label="Aa" title="Match case" />
          <Toggle k="wholeWord" label="W" title="Whole words" />
          <Toggle k="regex" label=".*" title="Regular expression" />
        </div>
        {showReplace && (
          <div className="search-row">
            <input className="input sm" placeholder="Replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
            <button className="btn btn-xs" disabled={!total} onClick={() => void replaceAll()}>
              All
            </button>
          </div>
        )}
        <input className="input sm" placeholder="Files to include, e.g. *.cs, *.json" value={include} onChange={(e) => setInclude(e.target.value)} />
      </div>
      <div className="search-summary">
        {busy ? (
          <>
            <LoaderCircle size={11} className="spin" /> Searching…
          </>
        ) : query.length >= 2 ? (
          `${total} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}${total >= 5000 ? ' (limit reached)' : ''}`
        ) : (
          'Type at least 2 characters'
        )}
      </div>
      <div className="result-list">
        {results.map((f) => (
          <div key={f.path}>
            <div className="result-file" onClick={() => setCollapsed({ ...collapsed, [f.path]: !collapsed[f.path] })} title={f.path}>
              {collapsed[f.path] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <FileIcon path={f.path} size={14} />
              {basename(f.path)}
              <span className="muted">{relative(root, dirname(f.path))}</span>
              <span className="badge" style={{ marginLeft: 'auto' }}>
                {f.matches.length}
              </span>
            </div>
            {!collapsed[f.path] &&
              f.matches.map((m, i) => (
                <div key={i} className="result-item" onClick={() => void useEditors.getState().open(f.path, { range: { startLine: m.line, startColumn: m.column, endLine: m.line, endColumn: m.column + m.length }, preview: true })}>
                  <span className="text">
                    {m.preview.slice(0, m.previewColumn - 1).trimStart()}
                    <mark>{m.preview.substr(m.previewColumn - 1, m.length)}</mark>
                    {m.preview.slice(m.previewColumn - 1 + m.length)}
                  </span>
                  <span className="loc">{m.line}</span>
                </div>
              ))}
          </div>
        ))}
        {!busy && query.length >= 2 && results.length === 0 && (
          <div className="panel-empty">
            <Search size={20} />
            <div>No results</div>
          </div>
        )}
      </div>
    </div>
  );
}
