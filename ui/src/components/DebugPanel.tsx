import { ArrowDownToLine, ArrowUpFromLine, Bug, ChevronDown, ChevronRight, CircleDot, Eraser, LoaderCircle, Pause, Play, RotateCw, Square, StepForward, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { keyLabel } from '../app/commands';
import { basename } from '../lib/paths';
import { evaluate, startDebugging, step, stopDebugging, useDebug, type Variable } from '../store/debug';
import { useEditors } from '../store/editors';

/** The Debug tool window: session toolbar, call stack, variables of the selected frame, breakpoints and the console. */
export function DebugPanel() {
  const status = useDebug((s) => s.status);
  const program = useDebug((s) => s.program);
  const reason = useDebug((s) => s.reason);
  const frames = useDebug((s) => s.frames);
  const frameId = useDebug((s) => s.frameId);
  const stopped = status === 'stopped';
  const active = status !== 'idle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="console-toolbar">
        {stopped ? (
          <button className="icon-btn sm run" title={`Resume (${keyLabel('F5')})`} onClick={() => void step('continue')}>
            <Play size={14} />
          </button>
        ) : (
          <button className="icon-btn sm" title="Pause" disabled={status !== 'running'} onClick={() => void step('pause')}>
            <Pause size={14} />
          </button>
        )}
        <button className="icon-btn sm" title="Step over (F10, F8)" disabled={!stopped} onClick={() => void step('next')}>
          <StepForward size={14} />
        </button>
        <button className="icon-btn sm" title="Step into (F11, F7)" disabled={!stopped} onClick={() => void step('stepIn')}>
          <ArrowDownToLine size={14} />
        </button>
        <button className="icon-btn sm" title="Step out (Shift+F11, Shift+F8)" disabled={!stopped} onClick={() => void step('stepOut')}>
          <ArrowUpFromLine size={14} />
        </button>
        <button className="icon-btn sm stop" title="Stop (Shift+F5)" disabled={!active} onClick={() => void stopDebugging()}>
          <Square size={12} />
        </button>
        <button
          className="icon-btn sm"
          title="Restart"
          disabled={!active}
          onClick={async () => {
            await stopDebugging();
            void startDebugging();
          }}
        >
          <RotateCw size={14} />
        </button>
        <div className="topbar-sep" />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)' }}>
          {status === 'idle' ? (
            <span className="muted">
              <Bug size={13} style={{ verticalAlign: -2 }} /> Not debugging — press <kbd>F5</kbd> or the bug button; click the gutter to add breakpoints.
            </span>
          ) : status === 'building' || status === 'starting' ? (
            <>
              <LoaderCircle size={13} className="spin" /> {status === 'building' ? 'Building' : 'Starting'} {program}…
            </>
          ) : stopped ? (
            <span style={{ color: 'var(--warning)' }}>Paused{reason ? ` (${reason})` : ''} — {program}</span>
          ) : (
            <span style={{ color: 'var(--success)' }}>Running — {program}</span>
          )}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 280, borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="section-label">Frames</div>
          <div className="result-list">
            {frames.length === 0 && <div className="panel-empty" style={{ padding: 12 }}>{stopped ? 'No frames' : 'Shown while paused'}</div>}
            {frames.map((f) => (
              <div
                key={f.id}
                className={`result-item${f.id === frameId ? ' selected' : ''}`}
                style={{ paddingLeft: 10 }}
                title={f.path ? `${f.path}:${f.line}` : f.name}
                onClick={() => {
                  useDebug.setState({ frameId: f.id });
                  if (f.path) void useEditors.getState().open(f.path, { line: f.line, column: f.column || 1 });
                }}
              >
                <span className="msg" style={{ opacity: f.path ? 1 : 0.6 }}>{f.name}</span>
                {f.path && <span className="loc">{basename(f.path)}:{f.line}</span>}
              </div>
            ))}
          </div>
          <BreakpointList />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="section-label">Variables</div>
          <div className="result-list" style={{ fontFamily: 'var(--font-mono)' }}>
            {stopped && frameId !== null ? <Scopes frameId={frameId} /> : <div className="panel-empty" style={{ padding: 12 }}>Shown while paused</div>}
          </div>
          <DebugConsole />
        </div>
      </div>
    </div>
  );
}

function Scopes({ frameId }: { frameId: number }) {
  const seq = useDebug((s) => s.stopSeq);
  const [scopes, setScopes] = useState<{ name: string; variablesReference: number }[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.post<{ name: string; variablesReference: number }[]>('/debug/scopes', { frameId }).then((s) => !cancelled && setScopes(s), () => !cancelled && setScopes([]));
    return () => {
      cancelled = true;
    };
  }, [frameId, seq]);
  return (
    <>
      {scopes.map((s, i) => (
        <VarNode key={`${seq}:${frameId}:${s.name}`} v={{ name: s.name, value: '', variablesReference: s.variablesReference }} depth={0} open={i === 0} scope />
      ))}
    </>
  );
}

function VarNode({ v, depth, open: initiallyOpen = false, scope = false }: { v: Variable; depth: number; open?: boolean; scope?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [children, setChildren] = useState<Variable[] | null>(null);
  useEffect(() => {
    if (!open || children || !v.variablesReference) return;
    api.post<Variable[]>('/debug/variables', { reference: v.variablesReference }).then(setChildren, () => setChildren([]));
  }, [open, children, v.variablesReference]);
  const expandable = v.variablesReference > 0;
  return (
    <>
      <div className="result-item" style={{ paddingLeft: 8 + depth * 14, gap: 6 }} onClick={() => expandable && setOpen(!open)} title={v.type ? `${v.name}: ${v.type}` : v.name}>
        <span className="tree-chevron">{expandable ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
        <span style={{ color: scope ? 'var(--fg)' : 'var(--syn-field)', fontWeight: scope ? 600 : 400, fontFamily: scope ? 'var(--font-ui)' : undefined }}>{v.name}</span>
        {!scope && (
          <>
            <span className="muted">=</span>
            <span className="text" style={{ color: /^".*"$/.test(v.value) ? 'var(--syn-string)' : /^-?\d/.test(v.value) ? 'var(--syn-number)' : 'var(--fg)' }}>
              {v.value}
            </span>
            {v.type && <span className="loc">{v.type}</span>}
          </>
        )}
      </div>
      {open && children?.map((c, i) => <VarNode key={`${c.name}:${i}`} v={c} depth={depth + 1} />)}
    </>
  );
}

function BreakpointList() {
  const breakpoints = useDebug((s) => s.breakpoints);
  const all = Object.values(breakpoints).flatMap((f) => f.bps.map((b) => ({ path: f.path, ...b })));
  return (
    <>
      <div className="section-label" style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>Breakpoints</span>
        <button className="icon-btn sm" title="Remove all breakpoints" disabled={all.length === 0} onClick={() => useDebug.getState().clearAll()}>
          <Trash2 size={13} />
        </button>
      </div>
      <div className="result-list" style={{ flex: '0 1 auto', maxHeight: '40%' }}>
        {all.length === 0 && <div className="muted" style={{ padding: '0 12px 8px', fontSize: 'var(--text-xs)' }}>Click the gutter or press F9 to add one</div>}
        {all.map((b) => (
          <div key={`${b.path}:${b.line}`} className="result-item" style={{ paddingLeft: 10 }} onClick={() => void useEditors.getState().open(b.path, { line: b.line })}>
            <CircleDot size={12} style={{ color: '#e5484d' }} />
            <span className="msg">
              {basename(b.path)}:{b.line}
            </span>
            {b.condition && <span className="loc">{b.condition}</span>}
            <button
              className="icon-btn sm"
              title="Remove"
              style={{ marginLeft: 'auto' }}
              onClick={(e) => {
                e.stopPropagation();
                useDebug.getState().toggle(b.path, b.line);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function DebugConsole() {
  const output = useDebug((s) => s.output);
  const stopped = useDebug((s) => s.status === 'stopped');
  const [expr, setExpr] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [output]);
  return (
    <div style={{ height: '45%', minHeight: 90, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-subtle)' }}>
      <div className="section-label" style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>Console</span>
        <button className="icon-btn sm" title="Clear" onClick={() => useDebug.setState({ output: '' })}>
          <Eraser size={13} />
        </button>
      </div>
      <pre ref={ref} className="console-out">
        {output}
      </pre>
      <div className="console-input">
        <span className="prompt">›</span>
        <input
          value={expr}
          disabled={!stopped}
          placeholder={stopped ? 'Evaluate an expression in the selected frame (Enter)' : 'Evaluate expressions while paused'}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key !== 'Enter' || !expr.trim()) return;
            const text = expr.trim();
            setExpr('');
            const r = await evaluate(text, 'repl');
            useDebug.setState((s) => ({ output: `${s.output}> ${text}\n${r ? r.result : '(not available)'}\n` }));
          }}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
