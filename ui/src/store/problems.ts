import { create } from 'zustand';
import type { DiagnosticDto } from '../api/types';
import { norm } from '../lib/paths';

interface ProblemsState {
  /** Live diagnostics of open files (from the editor), by normalized path. */
  live: Record<string, DiagnosticDto[]>;
  /** The last build / test run. */
  build: DiagnosticDto[];
  /** "Analyze solution". */
  solution: DiagnosticDto[] | null;
  analyzing: boolean;
  setLive(path: string, list: DiagnosticDto[]): void;
  clearLive(path: string): void;
  set(p: Partial<Pick<ProblemsState, 'build' | 'solution' | 'analyzing'>>): void;
}

export const useProblems = create<ProblemsState>((set) => ({
  live: {},
  build: [],
  solution: null,
  analyzing: false,
  setLive: (path, list) => set((s) => ({ live: { ...s.live, [norm(path)]: list.map((d) => ({ ...d, path })) } })),
  clearLive: (path) =>
    set((s) => {
      const live = { ...s.live };
      delete live[norm(path)];
      return { live };
    }),
  set: (p) => set(p),
}));

/** Every problem, deduplicated: live diagnostics replace build / solution ones for the same file. */
export function allProblems(s: Pick<ProblemsState, 'live' | 'build' | 'solution'>): DiagnosticDto[] {
  const liveFiles = new Set(Object.keys(s.live));
  const seen = new Set<string>();
  const out: DiagnosticDto[] = [];
  const add = (d: DiagnosticDto) => {
    if (d.severity === 'hint') return;
    const k = `${norm(d.path)}|${d.range.startLine}|${d.range.startColumn}|${d.code}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(d);
  };
  for (const list of Object.values(s.live)) list.forEach(add);
  for (const d of [...(s.solution ?? []), ...s.build]) if (!liveFiles.has(norm(d.path))) add(d);
  return out;
}

export function countProblems(list: DiagnosticDto[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of list) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
  }
  return { errors, warnings };
}
