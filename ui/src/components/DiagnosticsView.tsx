// Live diagnostics of the debugged program (Visual Studio's Diagnostic Tools): small charts over the last minutes, one
// measure (one unit, one axis) each, with a crosshair tooltip; and the exceptions and garbage collections as they
// happen.
import { Activity } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useDiagnostics, type DiagEvent, type DiagSample } from '../store/diagnostics';
import './diagnostics.css';

interface Series {
  label: string;
  /** A theme token for the line or bars. */
  color: string;
  values: (number | null)[];
}

const fmt = (v: number | null | undefined, unit: string) => (v == null ? '–' : `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`);

/** One small chart: lines (or bars for counts per second) on a shared y axis from 0. */
function Chart({ title, unit, series, bars = false, max: fixedMax, times }: { title: string; unit: string; series: Series[]; bars?: boolean; max?: number; times: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const n = times.length;
  const max = fixedMax ?? Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))) * 1.15;
  const W = 300;
  const H = 70;
  const x = (i: number) => (n <= 1 ? W : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * H;
  const last = n - 1;
  const at = hover ?? last;
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    setHover(Math.max(0, Math.min(last, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  return (
    <div className="diag-chart">
      <div className="diag-chart-head">
        <span className="diag-chart-title">{title}</span>
        {series.map((s) => (
          <span key={s.label} className="diag-legend">
            {series.length > 1 && <span className="diag-swatch" style={{ background: `var(${s.color})` }} />}
            {series.length > 1 && <span className="muted">{s.label}</span>}
            <b>{fmt(s.values[at], unit)}</b>
          </span>
        ))}
        {hover != null && n > 1 && <span className="muted diag-ago">{Math.round((times[last] - times[hover]) / 1000)} s ago</span>}
      </div>
      <svg ref={ref} className="diag-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${title}: ${series.map((s) => `${s.label} ${fmt(s.values[last], unit)}`).join(', ')}`}>
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="diag-base" />
        {series.map((s) =>
          bars ? (
            s.values.map((v, i) => (v ? <rect key={i} x={x(i) - W / Math.max(n, 2) / 2 + 0.5} width={Math.max(1, W / Math.max(n, 2) - 1)} y={y(v)} height={H - y(v)} rx={1} style={{ fill: `var(${s.color})` }} /> : null))
          ) : (
            <polyline
              key={s.label}
              fill="none"
              vectorEffect="non-scaling-stroke"
              strokeWidth={2}
              strokeLinejoin="round"
              style={{ stroke: `var(${s.color})` }}
              points={s.values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ')}
            />
          ),
        )}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="diag-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}

function since(e: DiagEvent, start: number | null) {
  const s = Math.max(0, Math.round((e.time - (start ?? e.time)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function DiagnosticsView() {
  const samples = useDiagnostics((s) => s.samples);
  const events = useDiagnostics((s) => s.events);
  const started = useDiagnostics((s) => s.started);
  const [show, setShow] = useState({ exception: true, gc: false });
  const pick = <K extends keyof DiagSample>(k: K) => samples.map((s) => s[k] as number | null);
  const times = useMemo(() => samples.map((s) => s.time), [samples]);
  const cur = samples.at(-1);
  const exceptions = events.filter((e) => e.kind === 'exception').length;
  const gcs = events.filter((e) => e.kind === 'gc').length;
  const list = events.filter((e) => (e.kind === 'exception' && show.exception) || (e.kind === 'gc' && show.gc) || e.kind === 'info');

  if (!samples.length)
    return (
      <div className="panel-empty">
        <Activity size={18} /> Start debugging (F5): CPU, memory, garbage collections, allocations and exceptions of the program appear here, live.
      </div>
    );

  return (
    <div className="diag">
      <div className="diag-grid">
        <Chart title="CPU" unit="%" times={times} max={100} series={[{ label: 'CPU', color: '--accent', values: pick('cpu') }]} />
        <Chart
          title="Memory"
          unit=" MB"
          times={times}
          series={[
            { label: 'Private', color: '--accent', values: pick('privateMb') },
            ...(cur?.runtime ? [{ label: 'GC heap', color: '--syn-string', values: pick('gcHeapMb') }] : []),
          ]}
        />
        {cur?.runtime && (
          <>
            <Chart
              title="Garbage collections /s"
              unit=""
              bars
              times={times}
              series={[{ label: 'Collections', color: '--warning', values: samples.map((s) => s.gen0 + s.gen1 + s.gen2) }]}
            />
            <Chart title="Allocations" unit=" MB/s" times={times} series={[{ label: 'Allocated', color: '--syn-string', values: pick('allocMbPerSec') }]} />
            <Chart title="Exceptions /s" unit="" bars times={times} series={[{ label: 'Thrown', color: '--danger', values: pick('exceptions') }]} />
            <Chart title="Thread pool" unit="" times={times} series={[{ label: 'Threads', color: '--accent', values: pick('threadPoolThreads') }, { label: 'Queued', color: '--warning', values: pick('threadPoolQueue') }]} />
          </>
        )}
      </div>
      <div className="diag-stats">
        <span>
          <span className="muted">Threads</span> {cur?.threads}
        </span>
        {cur?.timeInGc != null && (
          <span>
            <span className="muted">Time in GC</span> {fmt(cur.timeInGc, '%')}
          </span>
        )}
        {cur?.runtime && (
          <span>
            <span className="muted">Lock contention</span> {fmt(cur.lockContention, '/s')}
          </span>
        )}
        <div className="flex-1" />
        <label className="check">
          <input type="checkbox" checked={show.exception} onChange={(e) => setShow({ ...show, exception: e.target.checked })} /> Exceptions ({exceptions})
        </label>
        <label className="check">
          <input type="checkbox" checked={show.gc} onChange={(e) => setShow({ ...show, gc: e.target.checked })} /> GCs ({gcs})
        </label>
      </div>
      <div className="diag-events">
        {list.length === 0 && <div className="panel-empty">No events yet.</div>}
        {list.slice(0, 300).map((e, i) => (
          <div key={i} className={`diag-event ${e.kind}`} title={e.message ?? e.reason}>
            <span className="muted diag-time">{since(e, started)}</span>
            {e.kind === 'exception' ? (
              <>
                <span className="diag-ex-type">{e.exceptionType}</span>
                <span className="diag-ex-msg">{e.message}</span>
              </>
            ) : e.kind === 'gc' ? (
              <span>
                Gen {e.generation} collection <span className="muted">({e.reason})</span>
              </span>
            ) : (
              <span className="muted">{e.message}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
