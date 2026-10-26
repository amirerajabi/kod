import { CircleX, Copy, Database, LoaderCircle, Square } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '../app/actions';
import { cancelQuery, consoleSource, useDb, type DbResult } from '../store/database';
import { useEditors } from '../store/editors';

function toDelimited(r: DbResult, sep: string): string {
  const cell = (v: string | null) => {
    if (v === null) return '';
    return sep === ',' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v.replace(/[\t\n]/g, ' ');
  };
  return [r.columns.map(cell).join(sep), ...r.rows.map((row) => row.map(cell).join(sep))].join('\n');
}

/** The Database tool window: the result sets, messages and errors of the last run of a SQL console. */
export function DbResultsPanel() {
  const shown = useDb((s) => s.shownRun);
  const run = useDb((s) => (s.shownRun ? s.runs[s.shownRun] : undefined));
  const [tab, setTab] = useState(0);
  if (!run || !shown)
    return (
      <div className="panel-empty">
        <Database size={18} />
        <div>
          Run a query from a SQL console (<kbd>Ctrl+Enter</kbd>). Open a console from the Database panel.
        </div>
      </div>
    );
  const source = consoleSource(shown);
  const cur = run.results[Math.min(tab, run.results.length - 1)];
  return (
    <>
      <div className="console-toolbar">
        <Database size={14} />
        <b>{source?.name ?? 'Console'}</b>
        {run.running ? (
          <>
            <LoaderCircle size={14} className="spin" />
            <span className="muted">Running…</span>
            <button className="icon-btn sm stop" title="Cancel the query" onClick={() => cancelQuery(shown)}>
              <Square size={12} />
            </button>
          </>
        ) : (
          <span className="muted">
            {run.elapsedMs !== undefined ? `${run.elapsedMs} ms` : ''}
            {cur ? ` · ${cur.rows.length}${cur.truncated ? '+' : ''} row${cur.rows.length === 1 ? '' : 's'}` : ''}
          </span>
        )}
        <div className="topbar-sep" />
        {run.results.length > 1 &&
          run.results.map((_, i) => (
            <button key={i} className={`proc-chip${i === tab ? ' active' : ''}`} onClick={() => setTab(i)}>
              Result {i + 1}
            </button>
          ))}
        <div className="flex-1" />
        {cur && (
          <>
            <button className="btn btn-xs btn-ghost" onClick={() => void copyText(toDelimited(cur, '\t'), 'Rows (TSV)')} title="Copy as tab-separated values (pastes into Excel)">
              <Copy size={12} /> TSV
            </button>
            <button className="btn btn-xs btn-ghost" onClick={() => void copyText(toDelimited(cur, ','), 'Rows (CSV)')}>
              <Copy size={12} /> CSV
            </button>
          </>
        )}
      </div>
      <div className="db-results">
        {run.error && (
          <div
            className="db-error"
            onClick={() => {
              if (run.errorLine) void useEditors.getState().open(shown, { line: run.errorLine, column: 1 });
              else useEditors.getState().activate(shown);
            }}
          >
            <CircleX size={14} className="sev-error" /> {run.error}
            {run.errorLine ? <span className="muted"> (line {run.errorLine})</span> : null}
          </div>
        )}
        {cur && (
          <table className="db-grid">
            <thead>
              <tr>
                <th className="rownum">#</th>
                {cur.columns.map((c, i) => (
                  <th key={i} title={cur.types[i]}>
                    {c || <span className="muted">(no name)</span>}
                    <span className="db-type">{cur.types[i]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cur.rows.map((r, i) => (
                <tr key={i}>
                  <td className="rownum">{i + 1}</td>
                  {r.map((v, j) => (
                    <td key={j} className={v === null ? 'null' : undefined} title={v ?? 'NULL'} onDoubleClick={() => v !== null && void copyText(v, 'Value')}>
                      {v ?? 'NULL'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cur?.truncated && <div className="muted" style={{ padding: 6 }}>Only the first {cur.rows.length} rows are shown.</div>}
        {!run.running && run.messages.length > 0 && (
          <div className="db-messages">
            {run.messages.map((m, i) => (
              <div key={i}>{m}</div>
            ))}
          </div>
        )}
        {!run.running && !run.error && run.results.length === 0 && run.messages.length === 0 && <div className="panel-empty">The statement ran; it returned no rows.</div>}
      </div>
    </>
  );
}
