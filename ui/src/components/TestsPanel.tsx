import { Check, ChevronDown, ChevronRight, Circle, FlaskConical, LoaderCircle, Play, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { basename } from '../lib/paths';
import { useEditors } from '../store/editors';
import { discoverTests, runFailed, runTests, stateOf, useTests, type TestCase, type TestResult, type TestState } from '../store/tests';
import { showContextMenu } from './common/Menu';

const ICON: Record<TestState, ReactNode> = {
  passed: <Check size={13} className="test-ok" />,
  failed: <X size={13} className="test-fail" />,
  skipped: <Circle size={11} className="test-skip" />,
  running: <LoaderCircle size={13} className="spin" style={{ color: 'var(--accent)' }} />,
  none: <Circle size={11} className="test-none" />,
};

/** Worst state of a group: running > failed > passed > skipped > none. */
function aggregate(states: TestState[]): TestState {
  for (const s of ['running', 'failed', 'passed', 'skipped'] as TestState[]) if (states.includes(s)) return s;
  return 'none';
}

interface Node {
  key: string;
  label: string;
  /** Id prefix that runs everything under this node. */
  runId: string;
  projectPath?: string;
  children: Node[];
  test?: TestCase;
}

/** Rider's Unit Tests window: project › namespace › class › test, with results, filters and the failure details. */
export function TestsPanel() {
  const projects = useTests((s) => s.projects);
  const discovering = useTests((s) => s.discovering);
  const results = useTests((s) => s.results);
  const running = useTests((s) => s.running);
  const selected = useTests((s) => s.selected);
  const [filter, setFilter] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (projects.length === 0) discoverTests();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const store = useTests.getState();
  const tree = useMemo((): Node[] => {
    const q = filter.trim().toLowerCase();
    return projects
      .map((p): Node => {
        const byNs = new Map<string, Map<string, TestCase[]>>();
        for (const t of p.tests) {
          if (q && !`${t.className}.${t.name}`.toLowerCase().includes(q)) continue;
          if (onlyFailed && stateOf(t.id, store) !== 'failed') continue;
          const ns = t.namespace || '(global)';
          const cls = t.className.slice(t.namespace ? t.namespace.length + 1 : 0);
          if (!byNs.has(ns)) byNs.set(ns, new Map());
          const m = byNs.get(ns)!;
          if (!m.has(cls)) m.set(cls, []);
          m.get(cls)!.push(t);
        }
        return {
          key: p.projectPath,
          label: p.name,
          runId: '',
          projectPath: p.projectPath,
          children: [...byNs.entries()].map(([ns, classes]) => ({
            key: `${p.projectPath}|${ns}`,
            label: ns,
            runId: ns === '(global)' ? '' : ns,
            projectPath: p.projectPath,
            children: [...classes.entries()].map(([cls, tests]) => ({
              key: `${p.projectPath}|${ns}|${cls}`,
              label: cls,
              runId: tests[0].className,
              projectPath: p.projectPath,
              children: tests.map((t) => ({ key: t.id, label: t.name, runId: t.id, children: [], test: t })),
            })),
          })),
        };
      })
      .filter((p) => p.children.length > 0 || !q);
  }, [projects, filter, onlyFailed, results, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const allIds = projects.flatMap((p) => p.tests.map((t) => t.id));
  const states = allIds.map((id) => stateOf(id, store));
  const passed = states.filter((s) => s === 'passed').length;
  const failed = states.filter((s) => s === 'failed').length;

  const leafIds = (n: Node): string[] => (n.test ? [n.test.id] : n.children.flatMap(leafIds));
  const run = (n: Node) => (n.test || n.runId ? void runTests([n.runId]) : void runTests([], n.projectPath));
  const open = (t: TestCase) => void useEditors.getState().open(t.path, { line: t.line, column: 1 });

  const renderNode = (n: Node, depth: number): ReactNode => {
    const st = aggregate(leafIds(n).map((id) => stateOf(id, store)));
    const isOpen = !closed[n.key];
    const rows = n.test ? results[n.test.id] ?? [] : [];
    const expandable = n.children.length > 0 || rows.length > 1;
    return (
      <div key={n.key}>
        <div
          className={`result-item${selected === n.key ? ' selected' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => useTests.setState({ selected: n.key })}
          onDoubleClick={() => (n.test ? open(n.test) : setClosed({ ...closed, [n.key]: isOpen }))}
          onContextMenu={(e) =>
            showContextMenu(e, [
              { label: 'Run', icon: <Play size={14} />, run: () => run(n) },
              ...(n.test ? [{ label: 'Go to Test', run: () => open(n.test!) }] : []),
            ])
          }
        >
          <span className="tree-chevron" onClick={(e) => { e.stopPropagation(); setClosed({ ...closed, [n.key]: isOpen }); }}>
            {expandable ? isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
          </span>
          {ICON[st]}
          <span className="msg" style={{ fontWeight: depth === 0 ? 600 : 400 }}>{n.label}</span>
          {n.test && rows.length === 1 && <span className="loc">{Math.round(rows[0].durationMs)} ms</span>}
          {!n.test && <span className="loc">{leafIds(n).length}</span>}
          <button className="icon-btn sm" style={{ marginLeft: 'auto' }} title="Run" onClick={(e) => { e.stopPropagation(); run(n); }}>
            <Play size={12} />
          </button>
        </div>
        {isOpen && n.children.map((c) => renderNode(c, depth + 1))}
        {isOpen &&
          n.test &&
          rows.length > 1 &&
          rows.map((r, i) => (
            <div key={i} className={`result-item${selected === `${n.key}#${i}` ? ' selected' : ''}`} style={{ paddingLeft: 6 + (depth + 1) * 14 + 16 }} onClick={() => useTests.setState({ selected: `${n.key}#${i}` })}>
              {r.outcome === 'Passed' ? ICON.passed : r.outcome === 'Failed' ? ICON.failed : ICON.skipped}
              <span className="msg">{r.displayName.slice(r.displayName.indexOf('(') >= 0 ? r.displayName.indexOf('(') : 0)}</span>
              <span className="loc">{Math.round(r.durationMs)} ms</span>
            </div>
          ))}
      </div>
    );
  };

  // details of the selection
  const sel = selected ?? '';
  const [selId, row] = sel.includes('#') ? [sel.split('#')[0], Number(sel.split('#')[1])] : [sel, -1];
  const selResults = results[selId] ?? [];
  const detail: TestResult | undefined = row >= 0 ? selResults[row] : selResults.find((r) => r.outcome === 'Failed') ?? selResults[0];
  const selTest = projects.flatMap((p) => p.tests).find((t) => t.id === selId);

  return (
    <>
      <div className="console-toolbar">
        <button className="icon-btn sm run" title="Run all tests" onClick={() => void runTests()} disabled={running.size > 0}>
          <Play size={14} />
        </button>
        <button className="icon-btn sm" title="Run failed tests" onClick={runFailed} disabled={running.size > 0 || failed === 0}>
          <RotateCcw size={14} />
        </button>
        <button className="icon-btn sm" title="Refresh (discover tests)" onClick={() => discoverTests()}>
          <RefreshCw size={14} className={discovering ? 'spin' : undefined} />
        </button>
        <button className={`proc-chip${onlyFailed ? ' active' : ''}`} onClick={() => setOnlyFailed(!onlyFailed)}>
          <X size={11} className="test-fail" /> Failed only
        </button>
        <input className="input sm" style={{ width: 220 }} placeholder="Filter tests" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="flex-1" />
        <span style={{ fontSize: 'var(--text-xs)' }} className="muted">
          {running.size > 0 ? (
            <>
              <LoaderCircle size={11} className="spin" /> Running {running.size}…
            </>
          ) : (
            <>
              {allIds.length} tests · <span className="test-ok">{passed} passed</span> · <span className="test-fail">{failed} failed</span>
            </>
          )}
        </span>
      </div>
      <div className="split-pane">
        <div className="pane-left">
          <div className="result-list">
            {projects.length === 0 && (
              <div className="panel-empty">
                <FlaskConical size={18} />
                <div>{discovering ? 'Discovering tests…' : 'No test projects (xUnit, NUnit or MSTest) in this workspace.'}</div>
              </div>
            )}
            {tree.map((n) => renderNode(n, 0))}
          </div>
        </div>
        <div className="pane-right">
          {!selTest && !detail ? (
            <div className="panel-empty">Select a test to see its result.</div>
          ) : (
            <div className="details">
              <div style={{ fontWeight: 600 }}>
                {selTest ? `${selTest.className}.${selTest.name}` : detail?.displayName}
                {selTest && (
                  <a className="link-btn" onClick={() => open(selTest)} style={{ marginLeft: 6 }}>
                    {basename(selTest.path)}:{selTest.line}
                  </a>
                )}
              </div>
              {detail ? (
                <>
                  <div style={{ marginTop: 6 }} className={detail.outcome === 'Passed' ? 'test-ok' : detail.outcome === 'Failed' ? 'test-fail' : 'test-skip'}>
                    {detail.outcome} in {Math.round(detail.durationMs)} ms{row < 0 && selResults.length > 1 ? ` (${selResults.length} cases)` : ''}
                  </div>
                  {detail.message && <pre style={{ color: 'var(--danger-text)' }}>{detail.message}</pre>}
                  {detail.stackTrace && <pre>{linkify(detail.stackTrace)}</pre>}
                  {detail.output && (
                    <>
                      <div className="section-label" style={{ padding: '10px 0 0' }}>Output</div>
                      <pre>{detail.output}</pre>
                    </>
                  )}
                </>
              ) : (
                <div className="muted" style={{ marginTop: 6 }}>Not run yet.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Stack frames "in C:\x\Foo.cs:line 12" become links. */
function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /in (.+?):line (\d+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    const file = m[1];
    const line = Number(m[2]);
    out.push(
      <span key={m.index}>
        in{' '}
        <a className="link-btn" style={{ padding: 0, fontWeight: 400 }} onClick={() => void useEditors.getState().open(file, { line, column: 1 })}>
          {file}:line {line}
        </a>
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
