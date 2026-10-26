import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { FileEditsDto, InspectionDto } from '../api/types';
import { applyFileEdits } from './editors';
import { toast, useUi } from './ui';

interface InspectionsState {
  results: InspectionDto[] | null;
  running: boolean;
  /** When the results were computed (they go stale as the code changes). */
  at: number | null;
}

export const useInspections = create<InspectionsState>(() => ({ results: null, running: false, at: null }));

/** Inspect Code: compiler and analyzer diagnostics of the whole solution, in the Inspections tool window. */
export async function inspectSolution(): Promise<void> {
  useInspections.setState({ running: true });
  useUi.getState().showBottom('inspections');
  try {
    const results = await api.get<InspectionDto[]>('/intel/inspect');
    useInspections.setState({ results, running: false, at: Date.now() });
  } catch (e) {
    useInspections.setState({ running: false });
    toast('error', 'Inspection failed', errorText(e));
  }
}

/** Applies a quick fix to every occurrence of an inspection (solution-wide, or in one file). */
export async function fixAll(code: string, scope: 'solution' | 'document', path?: string): Promise<void> {
  try {
    const files = await api.post<FileEditsDto[]>('/intel/fixAll', { code, scope, path });
    const n = await applyFileEdits(files);
    toast('success', `Fixed '${code}'`, `${n} ${n === 1 ? 'file' : 'files'} changed`, 3000);
    // the fixed occurrences leave the list; Inspect Code again for a fresh picture
    useInspections.setState((s) => (s.results ? { results: s.results.filter((r) => r.code !== code || (scope === 'document' && r.path !== path)) } : {}));
  } catch (e) {
    toast('error', `Could not fix '${code}'`, errorText(e));
  }
}
