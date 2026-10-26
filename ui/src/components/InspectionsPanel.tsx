import { AlertTriangle, ChevronDown, ChevronRight, CircleX, ExternalLink, Info, Lightbulb, LoaderCircle, ScanSearch, Wand2 } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { InspectionDto } from '../api/types';
import { basename, dirname, relative } from '../lib/paths';
import { platform } from '../platform';
import { useEditors } from '../store/editors';
import { fixAll, inspectSolution, useInspections } from '../store/inspections';
import { useWorkspace } from '../store/workspace';

type Sev = InspectionDto['severity'];

const SEV_ORDER: Record<Sev, number> = { error: 0, warning: 1, info: 2, hint: 3 };
const SEV_LABEL: Record<Sev, string> = { error: 'errors', warning: 'warnings', info: 'suggestions', hint: 'hints' };

function SevIcon({ s, size = 13 }: { s: Sev; size?: number }) {
  if (s === 'error') return <CircleX size={size} className="sev-error" />;
  if (s === 'warning') return <AlertTriangle size={size} className="sev-warning" />;
  if (s === 'info') return <Info size={size} className="sev-info" />;
  return <Lightbulb size={size} className="muted" />;
}

/** Rider's Inspection Results: every problem in the solution grouped by inspection, with Fix all. */
export function InspectionsPanel() {
  const { results, running, at } = useInspections();
  const root = useWorkspace((s) => s.ws.root);
  const [show, setShow] = useState<Record<Sev, boolean>>({ error: true, warning: true, info: true, hint: false });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const by = new Map<string, InspectionDto[]>();
    for (const r of results ?? []) {
      if (!show[r.severity]) continue;
      const k = `${r.code}|${r.severity}`;
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(r);
    }
    return [...by.values()].sort((a, b) => SEV_ORDER[a[0].severity] - SEV_ORDER[b[0].severity] || b.length - a.length);
  }, [results, show]);

  const counts = useMemo(() => {
    const c: Record<Sev, number> = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const r of results ?? []) c[r.severity]++;
    return c;
  }, [results]);

  return (
    <>
      <div className="console-toolbar">
        <button className="btn btn-xs" disabled={running} onClick={() => void inspectSolution()} title="Run every inspection on the whole solution">
          {running ? <LoaderCircle size={12} className="spin" /> : <ScanSearch size={12} />} Inspect Code
        </button>
        <div className="topbar-sep" />
        {(['error', 'warning', 'info', 'hint'] as Sev[]).map((s) => (
          <button key={s} className={`proc-chip${show[s] ? ' active' : ''}`} onClick={() => setShow({ ...show, [s]: !show[s] })}>
            <SevIcon s={s} size={12} /> {counts[s]} {SEV_LABEL[s]}
          </button>
        ))}
        <div className="flex-1" />
        {at && <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>inspected {new Date(at).toLocaleTimeString()}</span>}
      </div>
      <div className="result-list">
        {!results && !running && (
          <div className="panel-empty">
            <ScanSearch size={18} />
            <div>Inspect Code runs the compiler and every analyzer (Roslyn's IDE inspections and the projects' own analyzers) on the whole solution.</div>
          </div>
        )}
        {running && !results && (
          <div className="panel-empty">
            <LoaderCircle size={16} className="spin" /> Inspecting the solution…
          </div>
        )}
        {results && groups.length === 0 && <div className="panel-empty">No problems found.</div>}
        {groups.map((items) => {
          const first = items[0];
          const k = `${first.code}|${first.severity}`;
          const isOpen = !!open[k];
          return (
            <Fragment key={k}>
              <div className="result-file" onClick={() => setOpen({ ...open, [k]: !isOpen })} title={first.title}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <SevIcon s={first.severity} />
                <span className="insp-title">{first.title || first.message}</span>
                <span className="muted">
                  {first.code} · {first.category}
                </span>
                <span className="badge" style={{ marginLeft: 'auto' }}>
                  {items.length}
                </span>
                {first.fixable && (
                  <button
                    className="btn btn-xs btn-ghost"
                    title={`Apply the quick fix for ${first.code} everywhere in the solution`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void fixAll(first.code, 'solution');
                    }}
                  >
                    <Wand2 size={12} /> Fix all
                  </button>
                )}
                {first.helpLink && (
                  <button
                    className="icon-btn sm"
                    title="Documentation"
                    onClick={(e) => {
                      e.stopPropagation();
                      platform.openExternal(first.helpLink!);
                    }}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>
              {isOpen &&
                items
                  .slice()
                  .sort((a, b) => a.path.localeCompare(b.path) || a.range.startLine - b.range.startLine)
                  .slice(0, 1000)
                  .map((d, i) => (
                    <div key={i} className="result-item" style={{ paddingLeft: 30 }} onClick={() => void useEditors.getState().open(d.path, { range: d.range, preview: true })} title={d.path}>
                      <span className="loc">
                        {basename(d.path)}:{d.range.startLine}
                      </span>
                      <span className="msg">{d.message}</span>
                      <span className="muted insp-dir">{relative(root, dirname(d.path))}</span>
                    </div>
                  ))}
            </Fragment>
          );
        })}
      </div>
    </>
  );
}
