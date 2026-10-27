// Code coverage of the last "Run with Coverage": per file, which lines ran, which did not, and which ran only some of
// their branches. Shown in the editor gutter and the Coverage window.
import { create } from 'zustand';
import { norm } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';

export interface FileCoverage {
  path: string;
  covered: number;
  total: number;
  coveredLines: number[];
  uncoveredLines: number[];
  partial: number[];
}

export interface Coverage {
  covered: number;
  total: number;
  assemblies: { name: string; covered: number; total: number }[];
  files: FileCoverage[];
}

interface CoverageState {
  data: Coverage | null;
  byPath: Map<string, FileCoverage>;
  at: number | null;
  /** The gutter marks in the editor. */
  show: boolean;
}

export const useCoverage = create<CoverageState>(() => ({ data: null, byPath: new Map(), at: null, show: loadRaw('coverageShown', true) }));

export function setCoverage(data: Coverage | null): void {
  useCoverage.setState({ data, byPath: new Map((data?.files ?? []).map((f) => [norm(f.path), f])), at: data ? Date.now() : null });
}

export function showCoverage(show: boolean): void {
  useCoverage.setState({ show });
  save('coverageShown', show);
}

export const coverageOf = (path: string) => useCoverage.getState().byPath.get(norm(path));

export const percent = (covered: number, total: number) => (total ? (covered / total) * 100 : 0);

export const formatPercent = (covered: number, total: number) => `${percent(covered, total).toFixed(total && covered !== total ? 1 : 0)}%`;
