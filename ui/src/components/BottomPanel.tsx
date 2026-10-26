import { Bug, FlaskConical, GitBranch, Package, AlertTriangle, ChevronDown, ChevronRight, CircleX, Eraser, Hammer, Info, LoaderCircle, Play, Plus, RotateCw, ScanSearch, Search, Square, SquareTerminal, Trash2, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keyLabel } from '../app/commands';
import { parseAnsi } from '../lib/ansi';
import { LOCATION_RE } from '../lib/buildOutput';
import { basename, dirname, norm, relative } from '../lib/paths';
import { useEditors } from '../store/editors';
import { allProblems, countProblems, useProblems } from '../store/problems';
import { dotnetBuild, dotnetRun, dotnetTest, groupOf, startTerminal, useProcs, type ProcGroup, type ProcView } from '../store/procs';
import { useUi, type BottomTab } from '../store/ui';
import { useUsages } from '../store/usages';
import { useWorkspace } from '../store/workspace';
import { runCommand } from '../app/commands';
import { FileIcon } from './common/icons';
import { DebugPanel } from './DebugPanel';
import { GitLogPanel } from './GitLogPanel';
import { NugetWindow } from './NugetWindow';
import { TestsPanel } from './TestsPanel';
import { useTests } from '../store/tests';
import { useDebug } from '../store/debug';
import { Splitter } from './common/Splitter';

export function BottomPanel() {
  const visible = useUi((s) => s.bottomVisible);
  const height = useUi((s) => s.bottomHeight);
  const tab = useUi((s) => s.bottom);
  const live = useProblems((s) => s.live);
  const build = useProblems((s) => s.build);
  const solution = useProblems((s) => s.solution);
  const counts = useMemo(() => countProblems(allProblems({ live, build, solution })), [live, build, solution]);
  const procs = useProcs((s) => s.procs);
  const debugStatus = useDebug((s) => s.status);
  const testsRunning = useTests((s) => s.running.size > 0);
  const [start, setStart] = useState(height);
  if (!visible) return null;
  const runningIn = (g: ProcGroup) => Object.values(procs).some((p) => groupOf(p.info.kind) === g && p.info.exitCode == null);

  const TABS: { id: BottomTab; label: string; icon: ReactNode; badge?: ReactNode }[] = [
    { id: 'run', label: 'Run', icon: runningIn('run') ? <LoaderCircle size={14} className="spin" /> : <Play size={14} /> },
    { id: 'debug', label: 'Debug', icon: debugStatus !== 'idle' ? <Bug size={14} style={{ color: debugStatus === 'stopped' ? 'var(--warning)' : 'var(--success)' }} /> : <Bug size={14} /> },
    { id: 'build', label: 'Build', icon: runningIn('build') ? <LoaderCircle size={14} className="spin" /> : <Hammer size={14} /> },
    { id: 'tests', label: 'Tests', icon: testsRunning ? <LoaderCircle size={14} className="spin" /> : <FlaskConical size={14} /> },
    { id: 'git', label: 'Git', icon: <GitBranch size={14} /> },
    { id: 'nuget', label: 'NuGet', icon: <Package size={14} /> },
    {
      id: 'problems',
      label: 'Problems',
      icon: <CircleX size={14} />,
      badge: counts.errors ? <span className="badge error">{counts.errors}</span> : counts.warnings ? <span className="badge warning">{counts.warnings}</span> : null,
    },
    { id: 'usages', label: 'Find Usages', icon: <ScanSearch size={14} /> },
    { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={14} /> },
  ];

  return (
    <>
      <Splitter
        direction="horizontal"
        onDragStart={() => setStart(height)}
        onDrag={(d) => useUi.getState().setLayout({ bottomHeight: Math.max(120, Math.min(window.innerHeight - 200, start - d)) })}
        onDoubleClick={() => useUi.getState().setLayout({ bottomHeight: 260 })}
      />
      <section className="bottom" style={{ height }} aria-label="Tool windows">
        <div className="bottom-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-label={t.label} aria-selected={tab === t.id} className={`dock-tab${tab === t.id ? ' active' : ''}`} onClick={() => useUi.getState().showBottom(t.id)}>
              {t.icon}
              <span>{t.label}</span>
              {t.badge}
            </button>
          ))}
          <div className="flex-1" />
          <button className="icon-btn sm" title={`Hide (${keyLabel('Ctrl+J')})`} onClick={() => useUi.getState().toggleBottom()}>
            <X size={14} />
          </button>
        </div>
        <div className="bottom-body">
          {tab === 'run' && <ProcessPane group="run" />}
          {tab === 'debug' && <DebugPanel />}
          {tab === 'build' && <ProcessPane group="build" />}
          {tab === 'terminal' && <ProcessPane group="terminal" />}
          {tab === 'tests' && <TestsPanel />}
          {tab === 'git' && <GitLogPanel />}
          {tab === 'nuget' && <NugetWindow />}
          {tab === 'problems' && <ProblemsPane />}
          {tab === 'usages' && <UsagesPane />}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- run / build / terminal

function ProcessPane({ group }: { group: ProcGroup }) {
  const procs = useProcs((s) => s.procs);
  const selectedId = useProcs((s) => s.selected[group]);
  const list = useMemo(() => Object.values(procs).filter((p) => groupOf(p.info.kind) === group).sort((a, b) => a.info.startedAt - b.info.startedAt), [procs, group]);
  const current = list.find((p) => p.info.id === selectedId) ?? list[list.length - 1];

  useEffect(() => {
    if (group === 'terminal' && list.length === 0) void startTerminal();
  }, [group, list.length]);

  if (!current)
    return (
      <div className="panel-empty">
        {group === 'run' ? (
          <>Nothing has run yet. Press <kbd>Shift+F10</kbd> to run the selected project.</>
        ) : group === 'build' ? (
          <>No build output yet. Press <kbd>{keyLabel('Ctrl+Shift+B')}</kbd> to build.</>
        ) : (
          <>Starting a shell…</>
        )}
      </div>
    );

  const running = current.info.exitCode == null;
  const rerun = () => {
    if (group === 'run') void dotnetRun(useWorkspace.getState().ws.projects.find((p) => dirname(p.path) === current.info.cwd)?.path);
    else if (current.info.kind === 'test') void dotnetTest();
    else if (['build', 'rebuild', 'clean', 'restore'].includes(current.info.kind)) void dotnetBuild(current.info.kind as 'build');
  };

  return (
    <>
      <div className="console-toolbar">
        {group !== 'terminal' && (
          <button className="icon-btn sm run" title="Rerun" onClick={rerun} disabled={current.info.kind === 'nuget' || current.info.kind === 'new'}>
            <RotateCw size={14} />
          </button>
        )}
        {group === 'terminal' && (
          <button className="icon-btn sm" title="New terminal" onClick={() => void startTerminal()}>
            <Plus size={14} />
          </button>
        )}
        <button className="icon-btn sm stop" title="Stop" disabled={!running} onClick={() => void useProcs.getState().stop(current.info.id)}>
          <Square size={12} />
        </button>
        <button className="icon-btn sm" title="Clear output" onClick={() => useProcs.getState().clear(current.info.id)}>
          <Eraser size={14} />
        </button>
        <button className="icon-btn sm" title="Close" disabled={running} onClick={() => useProcs.getState().remove(current.info.id)}>
          <Trash2 size={14} />
        </button>
        <div className="topbar-sep" />
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', minWidth: 0 }}>
          {list.slice(-8).map((p) => (
            <button key={p.info.id} className={`proc-chip${p === current ? ' active' : ''}`} onClick={() => useProcs.getState().select(group, p.info.id)} title={p.info.commandLine}>
              <span className={`proc-dot${p.info.exitCode == null ? ' running' : p.info.exitCode === 0 ? ' ok' : ' fail'}`} />
              <span>{p.info.title}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="muted" style={{ whiteSpace: 'nowrap', fontSize: 'var(--text-xs)' }}>
          {running ? 'running' : `exit ${current.info.exitCode}`} · {elapsed(current)}
        </span>
      </div>
      <ConsoleOutput proc={current} />
      {(group === 'run' || group === 'terminal') && running && <ConsoleInput id={current.info.id} terminal={group === 'terminal'} />}
    </>
  );
}

function elapsed(p: ProcView): string {
  const ms = (p.info.endedAt ?? Date.now()) - p.info.startedAt;
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

const RENDER_TAIL = 400_000;

function ConsoleOutput({ proc }: { proc: ProcView }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const text = proc.text.length > RENDER_TAIL ? proc.text.slice(proc.text.length - RENDER_TAIL) : proc.text;
  const spans = useMemo(() => parseAnsi(text).spans, [text]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [spans]);

  return (
    <pre
      ref={ref}
      className="console-out"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      <span className="cmd">
        {proc.info.kind === 'terminal' ? '' : `> ${proc.info.commandLine}\n`}
        {proc.text.length > RENDER_TAIL ? '… (earlier output trimmed)\n' : ''}
      </span>
      {spans.map((s, i) => (
        <span key={i} className={s.cls || undefined}>
          {linkify(s.text)}
        </span>
      ))}
      {proc.info.exitCode != null && proc.info.kind !== 'terminal' && (
        <span className={proc.info.exitCode === 0 ? 'exit-ok' : 'exit-fail'}>{`\nProcess finished with exit code ${proc.info.exitCode}.\n`}</span>
      )}
    </pre>
  );
}

/** file(line,col) in compiler output and stack traces becomes a link that opens the file there. */
function linkify(text: string): ReactNode {
  if (!text.includes('(')) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LOCATION_RE)) {
    out.push(text.slice(last, m.index));
    const [whole, file, line, col] = m;
    out.push(
      <a key={m.index} className="loc" onClick={() => void useEditors.getState().open(file, { line: Number(line), column: Number(col) })}>
        {whole}
      </a>,
    );
    last = m.index! + whole.length;
  }
  if (out.length === 0) return text;
  out.push(text.slice(last));
  return out;
}

function ConsoleInput({ id, terminal }: { id: string; terminal: boolean }) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (terminal) input.current?.focus();
  }, [id, terminal]);
  return (
    <div className="console-input" onClick={() => input.current?.focus()}>
      <span className="prompt">{terminal ? '$' : '›'}</span>
      <input
        ref={input}
        value={value}
        placeholder={terminal ? 'Type a command and press Enter' : 'Input for the program (Enter sends a line)'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            void useProcs.getState().input(id, value + '\n');
            if (value.trim()) setHistory([value, ...history.filter((h) => h !== value)].slice(0, 50));
            setValue('');
            setHi(-1);
          } else if (e.key === 'ArrowUp' && history.length) {
            const n = Math.min(history.length - 1, hi + 1);
            setHi(n);
            setValue(history[n]);
            e.preventDefault();
          } else if (e.key === 'ArrowDown') {
            const n = hi - 1;
            setHi(n);
            setValue(n >= 0 ? history[n] : '');
            e.preventDefault();
          }
        }}
        spellCheck={false}
      />
    </div>
  );
}

// ---------------------------------------------------------------- problems

function ProblemsPane() {
  const state = useProblems();
  const root = useWorkspace((s) => s.ws.root);
  const [filter, setFilter] = useState({ errors: true, warnings: true, info: false });
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const list = allProblems(state).filter((d) => (d.severity === 'error' ? filter.errors : d.severity === 'warning' ? filter.warnings : filter.info));
  const byFile = new Map<string, typeof list>();
  for (const d of list) {
    const k = norm(d.path);
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k)!.push(d);
  }
  const counts = countProblems(allProblems(state));
  const files = [...byFile.values()].sort((a, b) => a[0].path.localeCompare(b[0].path));
  return (
    <>
      <div className="console-toolbar">
        <button className={`proc-chip${filter.errors ? ' active' : ''}`} onClick={() => setFilter({ ...filter, errors: !filter.errors })}>
          <CircleX size={12} className="sev-error" /> {counts.errors} errors
        </button>
        <button className={`proc-chip${filter.warnings ? ' active' : ''}`} onClick={() => setFilter({ ...filter, warnings: !filter.warnings })}>
          <AlertTriangle size={12} className="sev-warning" /> {counts.warnings} warnings
        </button>
        <button className={`proc-chip${filter.info ? ' active' : ''}`} onClick={() => setFilter({ ...filter, info: !filter.info })}>
          <Info size={12} className="sev-info" /> info
        </button>
        <div className="flex-1" />
        <button className="btn btn-xs btn-ghost" disabled={state.analyzing} onClick={() => runCommand('code.analyze')} title="Compile every project and list all errors and warnings">
          {state.analyzing ? <LoaderCircle size={12} className="spin" /> : <ScanSearch size={12} />} Analyze solution
        </button>
      </div>
      <div className="result-list">
        {files.length === 0 && <div className="panel-empty">No problems{state.solution ? ' in the solution' : ' in open files'}.</div>}
        {files.map((items) => {
          const path = items[0].path;
          const k = norm(path);
          return (
            <Fragment key={k}>
              <div className="result-file" onClick={() => setClosed({ ...closed, [k]: !closed[k] })} title={path}>
                {closed[k] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <FileIcon path={path} size={14} />
                {basename(path)}
                <span className="muted">{relative(root, dirname(path))}</span>
                <span className="badge" style={{ marginLeft: 'auto' }}>
                  {items.length}
                </span>
              </div>
              {!closed[k] &&
                items
                  .sort((a, b) => a.range.startLine - b.range.startLine)
                  .map((d, i) => (
                    <div key={i} className="result-item" onClick={() => void useEditors.getState().open(d.path, { range: d.range })} title={d.message}>
                      {d.severity === 'error' ? <CircleX size={13} className="sev-error" /> : d.severity === 'warning' ? <AlertTriangle size={13} className="sev-warning" /> : <Info size={13} className="sev-info" />}
                      <span className="msg">{d.message}</span>
                      <span className="loc">
                        {d.code} ({d.range.startLine}:{d.range.startColumn})
                      </span>
                    </div>
                  ))}
            </Fragment>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- usages

function UsagesPane() {
  const { title, items, loading } = useUsages();
  const root = useWorkspace((s) => s.ws.root);
  if (loading)
    return (
      <div className="panel-empty">
        <LoaderCircle size={16} className="spin" /> Finding usages of {title}…
      </div>
    );
  if (!title)
    return (
      <div className="panel-empty">
        <Search size={18} />
        <div>
          Put the caret on a symbol and press <kbd>Alt+F7</kbd>.
        </div>
      </div>
    );
  const byFile = new Map<string, typeof items>();
  for (const l of items) {
    const k = norm(l.path);
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k)!.push(l);
  }
  return (
    <>
      <div className="console-toolbar">
        <span>
          <b>{title}</b> <span className="muted">— {items.filter((i) => !i.isDefinition).length} usages in {byFile.size} files</span>
        </span>
      </div>
      <div className="result-list">
        {[...byFile.values()].map((list) => (
          <Fragment key={list[0].path}>
            <div className="result-file" title={list[0].path}>
              <FileIcon path={list[0].path} size={14} />
              {basename(list[0].path)}
              <span className="muted">{relative(root, dirname(list[0].path))}</span>
            </div>
            {list.map((l, i) => (
              <div key={i} className="result-item" onClick={() => void useEditors.getState().open(l.path, { range: l.range, preview: true })}>
                <span className="loc">{l.range.startLine}</span>
                <span className="text">{l.preview}</span>
                {l.isDefinition && <span className="badge">definition</span>}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </>
  );
}
