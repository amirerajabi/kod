// Debugger visualizers: a collection or DataTable as a sortable, filterable grid (copy as CSV / TSV), and a string in
// the Text, JSON, XML or HTML viewer.
import { ClipboardCopy, LoaderCircle, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { copyText } from '../app/actions';
import { useDebug } from '../store/debug';
import { Dialog } from './common/Dialog';
import { pretty, ReadOnlyCode } from './HttpPanel';
import './visualizer.css';

interface VisualDto {
  kind: 'table' | 'text' | 'none';
  type?: string;
  columns?: string[];
  rows?: string[][];
  total?: number;
  text?: string;
  message?: string;
}

interface VisualizerState {
  open: boolean;
  title: string;
  loading: boolean;
  data: VisualDto | null;
  error: string | null;
}

const useVisualizer = create<VisualizerState>(() => ({ open: false, title: '', loading: false, data: null, error: null }));

/** Opens the visualizer on an expression of the selected frame (its Variables reference when known). */
export async function visualize(expression: string, variablesReference = 0): Promise<void> {
  useVisualizer.setState({ open: true, title: expression, loading: true, data: null, error: null });
  try {
    const data = await api.post<VisualDto>('/debug/visualize', { expression, frameId: useDebug.getState().frameId, variablesReference });
    useVisualizer.setState({ data, loading: false });
  } catch (e) {
    useVisualizer.setState({ error: errorText(e), loading: false });
  }
}

/** Whether a variable gets the View link: long strings, collections, arrays and data tables. */
export function canVisualize(v: { value: string; type?: string; variablesReference: number }): boolean {
  if (/^".{40,}/s.test(v.value) || /^"[\s\S]*\\n/.test(v.value)) return true;
  if (!v.variablesReference) return false;
  return /\[\]|List|Dictionary|Set\b|Set<|Collection|Queue|Stack|Array|Enumerable|DataTable|Immutable|Span|Memory/.test(v.type ?? '') || /Count = \d+/.test(v.value);
}

const unquoteDisplay = (s: string) => (/^".*"$/s.test(s) ? s.slice(1, -1) : s);

function csv(columns: string[], rows: string[][], sep: string): string {
  const cell = (s: string) => {
    const v = unquoteDisplay(s);
    return sep === ',' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v.replace(/\t/g, ' ').replace(/\n/g, ' ');
  };
  return [columns, ...rows].map((r) => r.map(cell).join(sep)).join('\n');
}

function TableView({ data }: { data: VisualDto }) {
  const columns = data.columns ?? [];
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const rows = useMemo(() => {
    let list = data.rows ?? [];
    if (filter) {
      const f = filter.toLowerCase();
      list = list.filter((r) => r.some((c) => c.toLowerCase().includes(f)));
    }
    if (sort) {
      const num = (s: string) => Number(unquoteDisplay(s));
      list = [...list].sort((a, b) => {
        const x = a[sort.col] ?? '';
        const y = b[sort.col] ?? '';
        const d = !Number.isNaN(num(x)) && !Number.isNaN(num(y)) ? num(x) - num(y) : x.localeCompare(y);
        return sort.desc ? -d : d;
      });
    }
    return list;
  }, [data, filter, sort]);
  const shown = data.rows?.length ?? 0;
  return (
    <div className="vis-table-wrap">
      <div className="vis-toolbar">
        <span className="vis-search">
          <Search size={13} />
          <input className="input sm" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        </span>
        <span className="muted">
          {filter ? `${rows.length} of ` : ''}
          {shown}
          {data.total != null && data.total > shown ? ` (first ${shown} of ${data.total})` : ''} row{shown === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <button className="btn btn-xs" onClick={() => void copyText(csv(columns, rows, '\t'), 'Rows (TSV)')}>
          <ClipboardCopy size={13} /> Copy as TSV
        </button>
        <button className="btn btn-xs" onClick={() => void copyText(csv(columns, rows, ','), 'Rows (CSV)')}>
          <ClipboardCopy size={13} /> Copy as CSV
        </button>
      </div>
      <div className="vis-grid">
        <table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i} onClick={() => setSort(sort?.col === i ? { col: i, desc: !sort.desc } : { col: i, desc: false })}>
                  {c}
                  {sort?.col === i ? (sort.desc ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, k) => (
                  <td key={k} className={/^".*"$/s.test(c) ? 'str' : /^-?\d/.test(c) ? 'num' : c === 'null' ? 'nul' : undefined} title={c}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type TextMode = 'text' | 'json' | 'xml' | 'html';

function TextView({ text }: { text: string }) {
  const guess: TextMode = /^\s*[[{]/.test(text) ? 'json' : /^\s*<(!doctype html|html)/i.test(text) ? 'html' : /^\s*</.test(text) ? 'xml' : 'text';
  const [mode, setMode] = useState<TextMode>(guess);
  const body = useMemo(() => (mode === 'json' ? pretty(text, 'json') : mode === 'xml' ? pretty(text, 'xml') : text), [text, mode]);
  return (
    <div className="vis-table-wrap">
      <div className="vis-toolbar">
        <div className="subtabs http-subtabs">
          {(['text', 'json', 'xml', 'html'] as const).map((m) => (
            <button key={m} className={`subtab${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
              {m === 'text' ? 'Text' : m.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="muted">{text.length.toLocaleString()} characters</span>
        <div className="flex-1" />
        <button className="btn btn-xs" onClick={() => void copyText(text, 'Text')}>
          <ClipboardCopy size={13} /> Copy
        </button>
      </div>
      <div className="vis-text">
        {mode === 'html' ? (
          // rendered with no scripts, no forms, no navigation: only how it looks
          <iframe className="vis-html" sandbox="" srcDoc={text} title="HTML preview" />
        ) : (
          <ReadOnlyCode text={body} language={mode === 'text' ? 'plaintext' : mode} />
        )}
      </div>
    </div>
  );
}

export function VisualizerDialog() {
  const st = useVisualizer();
  if (!st.open) return null;
  const close = () => useVisualizer.setState({ open: false, data: null });
  return (
    <Dialog title={<span className="vis-title">{st.title}{st.data?.type ? <span className="muted"> · {st.data.type}</span> : null}</span>} onClose={close} width={980} className="vis-dialog">
      {st.loading ? (
        <div className="panel-empty">
          <LoaderCircle size={16} className="spin" /> Reading the value from the debugger…
        </div>
      ) : st.error ? (
        <div className="sev-error">{st.error}</div>
      ) : st.data?.kind === 'table' ? (
        <TableView data={st.data} />
      ) : st.data?.kind === 'text' ? (
        <TextView text={st.data.text ?? ''} />
      ) : (
        <div className="muted">{st.data?.message ?? 'Nothing to show.'}</div>
      )}
    </Dialog>
  );
}
