// Live diagnostics of the program being debugged (Visual Studio's Diagnostic Tools): a sample a second (CPU, memory,
// GC heap, collections, allocations, exceptions, thread pool) and the exceptions and garbage collections as they happen.
import { create } from 'zustand';

export interface DiagSample {
  time: number;
  cpu: number;
  workingSetMb: number;
  privateMb: number;
  threads: number;
  gcHeapMb: number | null;
  gen0: number;
  gen1: number;
  gen2: number;
  timeInGc: number | null;
  allocMbPerSec: number | null;
  exceptions: number;
  threadPoolThreads: number | null;
  threadPoolQueue: number | null;
  lockContention: number;
  /** The runtime's own counters arrive (a .NET program reachable over EventPipe). */
  runtime: boolean;
}

export interface DiagEvent {
  kind: 'exception' | 'gc' | 'info';
  time: number;
  exceptionType?: string;
  message?: string;
  generation?: number;
  reason?: string;
}

interface DiagState {
  pid: number | null;
  samples: DiagSample[];
  events: DiagEvent[];
  started: number | null;
}

const KEEP = 300;

export const useDiagnostics = create<DiagState>(() => ({ pid: null, samples: [], events: [], started: null }));

export function onDiagEvent(e: { type: string; [k: string]: unknown }): void {
  if (e.type === 'debug.diag') {
    const { type: _t, pid, ...sample } = e as unknown as DiagSample & { type: string; pid: number };
    useDiagnostics.setState((s) => {
      const fresh = s.pid !== pid;
      return {
        pid,
        started: fresh ? sample.time : s.started,
        samples: [...(fresh ? [] : s.samples), sample].slice(-KEEP),
        events: fresh ? [] : s.events,
      };
    });
  } else if (e.type === 'debug.diag.event') {
    const { type: _t, ...ev } = e as unknown as DiagEvent & { type: string };
    useDiagnostics.setState((s) => ({ events: [ev, ...s.events].slice(0, 500) }));
  }
}
