// Memory: the status bar indicator (Rider's memory indicator, plus Power Save Mode) and the Memory dialog: what Kod
// uses and where, freeing it, and unloading projects you are not working on.
import { BatteryLow, Brush, Eraser, LoaderCircle, MemoryStick, Settings2 } from 'lucide-react';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { samePath } from '../lib/paths';
import { formatMb, freeMemory, refreshMemory, totalMb, useMemory, windowMb, type ProcessMemory } from '../store/memory';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';
import { openSettings } from './settings/nav';
import './memory.css';

const openMemory = () => useMemory.setState({ dialogOpen: true });

/** Status bar: Power Save Mode when on, and Kod's memory with the engine's share of its limit. */
export function MemoryIndicator() {
  const enabled = useSettings((s) => s.settings.memoryIndicator);
  const powerSave = useSettings((s) => s.settings.powerSave);
  const mem = useMemory(useShallow((s) => ({ engine: s.engine, processes: s.processes, jsHeapMb: s.jsHeapMb, history: s.history, freeing: s.freeing, dialogOpen: s.dialogOpen })));
  const engine = mem.engine;
  const share = engine ? Math.min(100, (engine.privateMb / engine.settings.softLimitMb) * 100) : 0;
  return (
    <>
      {powerSave && (
        <button className="sb-item sev-warning" title="Power Save Mode is on: no inlay hints, Code Vision, inspections or automatic completion. Click to turn it off." onClick={() => useSettings.getState().update({ powerSave: false })}>
          <BatteryLow /> Power save
        </button>
      )}
      {enabled && engine && (
        <button
          className={`sb-item mem-indicator${share > 90 ? ' high' : share > 70 ? ' warn' : ''}`}
          title={`Kod uses ${formatMb(totalMb(mem))}: engine ${formatMb(engine.privateMb)} (limit ${formatMb(engine.settings.softLimitMb)}), window ${formatMb(windowMb(mem))}.\nClick for details and to free memory.`}
          onClick={openMemory}
        >
          {mem.freeing ? <LoaderCircle className="spin" /> : <span className="mem-bar" aria-hidden><span style={{ width: `${share}%` }} /></span>}
          {formatMb(totalMb(mem))}
        </button>
      )}
    </>
  );
}

const KIND: Record<string, string> = { Browser: 'Main process', Tab: 'Window (editor)', GPU: 'Graphics (GPU)', Utility: 'Utility', Zygote: 'Helper', 'Sandbox helper': 'Helper' };

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="mem-spark" />;
  const max = Math.max(...values) * 1.1;
  const min = Math.min(...values) * 0.9;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / Math.max(1, max - min)) * 30}`).join(' ');
  return (
    <svg className="mem-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Memory over the last minutes">
      <polyline points={pts} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="mem-stat" title={hint}>
      <span className="muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function MemoryDialog() {
  const open = useMemory((s) => s.dialogOpen);
  const mem = useMemory();
  const settings = useSettings((s) => s.prefs);
  const ws = useWorkspace((s) => s.ws);
  const startup = useWorkspace((s) => s.startup);
  useEffect(() => {
    if (open) void refreshMemory();
  }, [open]);
  if (!open) return null;
  const close = () => useMemory.setState({ dialogOpen: false });
  const engine = mem.engine;
  const groups = new Map<string, number>();
  for (const p of mem.processes as ProcessMemory[]) {
    const kind = KIND[p.type] ?? p.type;
    const label = kind === 'Utility' && p.name && p.name !== 'Utility' ? p.name : kind;
    groups.set(label, (groups.get(label) ?? 0) + (p.privateKb || p.workingSetKb) / 1024);
  }
  if (!mem.processes.length && mem.jsHeapMb != null) groups.set('Window (JavaScript heap)', mem.jsHeapMb);
  const total = totalMb(mem);
  const rows: [string, number, string?][] = [
    ...(engine ? [['Code engine (Roslyn)', engine.privateMb, `Managed heap ${formatMb(engine.heapSizeMb)}, of which ${formatMb(engine.fragmentedMb)} free gaps`] as [string, number, string]] : []),
    ...[...groups.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v] as [string, number]),
  ];
  const projects = ws.projects;
  const loaded = projects.filter((p) => !p.unloaded);
  const unloadOthers = () => {
    const keep = startup ?? loaded[0]?.path;
    void useWorkspace.getState().setUnloaded(loaded.filter((p) => !samePath(p.path, keep)).map((p) => p.path), true);
  };

  return (
    <Dialog
      title={
        <span className="mem-title">
          <MemoryStick size={16} /> Memory
        </span>
      }
      onClose={close}
      width={640}
      footer={
        <>
          <label className="mem-toggle" title="Turns off inlay hints, Code Vision, inspections, inline blame, the minimap and the automatic completion popup">
            <input type="checkbox" checked={settings.powerSave} onChange={(e) => useSettings.getState().update({ powerSave: e.target.checked })} /> Power Save Mode
          </label>
          <div className="flex-1" />
          <button className="btn" onClick={() => { close(); openSettings('memory'); }}>
            <Settings2 size={15} /> Settings
          </button>
          <button className="btn" disabled={mem.freeing} title="Drops the engine's caches as well as Roslyn's compilations and syntax trees. They are rebuilt as you work, so the next completion or Find Usages may be slower." onClick={() => void freeMemory(true)}>
            <Eraser size={15} /> Deep clean
          </button>
          <button className="btn btn-primary" disabled={mem.freeing} title="Empties caches and gives freed memory back to the system" onClick={() => void freeMemory(false)}>
            {mem.freeing ? <LoaderCircle size={15} className="spin" /> : <Brush size={15} />} Free memory
          </button>
        </>
      }
    >
      <div className="mem-summary">
        <div>
          <div className="mem-total">{formatMb(total)}</div>
          <div className="muted">
            in use by Kod{engine ? ` · ${formatMb(engine.machineMb)} installed` : ''}
          </div>
        </div>
        <Sparkline values={mem.history} />
      </div>
      {engine && (
        <div className="mem-limit" title="When the engine goes over its limit it drops its caches and compilations, and warns you if that is not enough">
          <span className="muted">Engine limit</span>
          <span className="mem-limit-bar">
            <span style={{ width: `${Math.min(100, (engine.privateMb / engine.settings.softLimitMb) * 100)}%` }} />
          </span>
          <span>
            {formatMb(engine.privateMb)} of {formatMb(engine.settings.softLimitMb)}
          </span>
        </div>
      )}

      <div className="section-label">Where it goes</div>
      <div className="mem-rows">
        {rows.map(([label, mb, hint]) => (
          <div key={label} className="mem-row" title={hint}>
            <span className="mem-row-label">{label}</span>
            <span className="mem-row-bar">
              <span style={{ width: `${total ? Math.max(1, (mb / total) * 100) : 0}%` }} />
            </span>
            <span className="mem-row-value">{formatMb(mb)}</span>
          </div>
        ))}
      </div>

      {engine && (
        <>
          <div className="section-label">Engine</div>
          <div className="mem-stats">
            <Stat label="Projects" value={`${engine.projects} loaded${engine.unloadedProjects ? `, ${engine.unloadedProjects} unloaded` : ''}`} />
            <Stat label="Documents" value={`${engine.documents} (${engine.openDocuments} open)`} />
            <Stat label="Garbage collections" value={`${engine.gen0} / ${engine.gen1} / ${engine.gen2}`} hint="Generation 0 / 1 / 2 collections since the engine started" />
            <Stat label="Time in GC" value={`${engine.pausePercent.toFixed(1)}%`} hint={`${Math.round(engine.pauseMs)} ms paused in total`} />
            {engine.caches.map((c) => (
              <Stat key={c.name} label={c.name} value={String(c.count)} />
            ))}
            <Stat
              label="Last freed"
              value={engine.lastTrim ? `${formatMb(engine.lastFreedMb ?? 0)}, ${new Date(engine.lastTrim).toLocaleTimeString()}` : 'not yet'}
              hint={engine.lastTrimReason ? `Why: ${engine.lastTrimReason}` : 'Kod frees memory when you are idle, when the window is hidden, and above the limit'}
            />
          </div>
        </>
      )}

      {projects.length > 1 && (
        <>
          <div className="section-label mem-projects-head">
            <span>Projects</span>
            <span className="flex-1" />
            {loaded.length > 1 && (
              <button className="btn btn-xs" onClick={unloadOthers} title="Keep only the run configuration's project loaded">
                Unload all but the run configuration
              </button>
            )}
            {projects.some((p) => p.unloaded) && (
              <button className="btn btn-xs" onClick={() => void useWorkspace.getState().setUnloaded(projects.filter((p) => p.unloaded).map((p) => p.path), false)}>
                Load all
              </button>
            )}
          </div>
          <div className="mem-projects">
            {projects.map((p) => (
              <label key={p.path} className={`mem-project${p.unloaded ? ' unloaded' : ''}`} title={p.unloaded ? 'Unloaded: no completion, analysis or Find Usages inside it; code using it compiles against its last build' : p.path}>
                <input type="checkbox" checked={!p.unloaded} onChange={(e) => void useWorkspace.getState().setUnloaded([p.path], !e.target.checked)} />
                <span>{p.name}</span>
                <span className="muted">{p.unloaded ? 'unloaded' : p.kind}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {useUi.getState().wsStatus !== 'open' && <div className="muted">The engine is not connected.</div>}
    </Dialog>
  );
}
