// Coverage tool window: the line coverage of the last "Run with Coverage", per assembly and per file (sortable), the
// files opening at their first uncovered line; and the switch for the gutter marks in the editor.
import { Eye, EyeOff, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { relative } from '../lib/paths';
import { formatPercent, percent, setCoverage, showCoverage, useCoverage, type FileCoverage } from '../store/coverage';
import { useEditors } from '../store/editors';
import { runTests, useTests } from '../store/tests';
import { useWorkspace } from '../store/workspace';
import { FileIcon } from './common/icons';
import './coverage.css';

type SortKey = 'name' | 'percent' | 'uncovered';

function Bar({ covered, total }: { covered: number; total: number }) {
  const p = percent(covered, total);
  return (
    <span className="cov-bar" aria-hidden>
      <span className={p >= 80 ? 'good' : p >= 50 ? 'fair' : 'poor'} style={{ width: `${p}%` }} />
    </span>
  );
}

export function CoveragePanel() {
  const data = useCoverage((s) => s.data);
  const at = useCoverage((s) => s.at);
  const show = useCoverage((s) => s.show);
  const running = useTests((s) => s.running.size > 0);
  const root = useWorkspace((s) => s.ws.root);
  const [sort, setSort] = useState<SortKey>('percent');
  const [filter, setFilter] = useState('');

  const files = useMemo(() => {
    const list = (data?.files ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));
    const by: Record<SortKey, (a: FileCoverage, b: FileCoverage) => number> = {
      name: (a, b) => a.path.localeCompare(b.path),
      percent: (a, b) => percent(a.covered, a.total) - percent(b.covered, b.total) || a.path.localeCompare(b.path),
      uncovered: (a, b) => b.total - b.covered - (a.total - a.covered),
    };
    return [...list].sort(by[sort]);
  }, [data, sort, filter]);

  const open = (f: FileCoverage) => void useEditors.getState().open(f.path, { line: f.uncoveredLines[0] ?? f.coveredLines[0] ?? 1 });

  return (
    <div className="cov-panel">
      <div className="console-toolbar">
        <button className="icon-btn sm run" title="Run all tests with coverage" disabled={running} onClick={() => void runTests([], undefined, true)}>
          <ShieldCheck size={14} />
        </button>
        <button className={`icon-btn sm${show ? ' on' : ''}`} title={show ? 'Hide the coverage marks in the editor' : 'Show the coverage marks in the editor'} aria-pressed={show} onClick={() => showCoverage(!show)}>
          {show ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="icon-btn sm" title="Clear the coverage" disabled={!data} onClick={() => setCoverage(null)}>
          <Trash2 size={14} />
        </button>
        {data && (
          <>
            <span className="cov-total">
              <Bar covered={data.covered} total={data.total} /> {formatPercent(data.covered, data.total)}
            </span>
            <span className="muted">
              {data.covered} / {data.total} lines{at ? ` · ${new Date(at).toLocaleTimeString()}` : ''}
            </span>
          </>
        )}
        <div className="flex-1" />
        {data && <input className="input sm cov-filter" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </div>
      {!data ? (
        <div className="panel-empty">No coverage yet. Run tests with coverage (the shield button here or in the Tests window); covered lines get a green bar in the editor gutter, uncovered ones a red bar.</div>
      ) : (
        <div className="cov-body">
          {data.assemblies.length > 1 && (
            <div className="cov-assemblies">
              {data.assemblies.map((a) => (
                <div key={a.name} className="cov-asm" title={`${a.covered} of ${a.total} lines`}>
                  <span className="cov-asm-name">{a.name}</span>
                  <Bar covered={a.covered} total={a.total} />
                  <span className="cov-pct">{formatPercent(a.covered, a.total)}</span>
                </div>
              ))}
            </div>
          )}
          <table className="cov-table">
            <thead>
              <tr>
                <th onClick={() => setSort('name')} className={sort === 'name' ? 'sorted' : undefined}>
                  File
                </th>
                <th onClick={() => setSort('percent')} className={sort === 'percent' ? 'sorted' : undefined}>
                  Coverage
                </th>
                <th onClick={() => setSort('uncovered')} className={sort === 'uncovered' ? 'sorted' : undefined}>
                  Uncovered lines
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.path} onDoubleClick={() => open(f)} onClick={() => open(f)} title={f.path}>
                  <td>
                    <FileIcon path={f.path} isDir={false} /> {relative(root ?? undefined, f.path)}
                  </td>
                  <td>
                    <Bar covered={f.covered} total={f.total} /> <span className="cov-pct">{formatPercent(f.covered, f.total)}</span>
                  </td>
                  <td className="cov-num">{f.total - f.covered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
