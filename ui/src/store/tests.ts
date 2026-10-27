// The unit test explorer: tests discovered by the engine (Roslyn), runs through `dotnet test`, and the results of the
// last run per test (theory rows and NUnit cases are kept as children).
import { create } from 'zustand';
import { formatPercent, setCoverage, type Coverage } from './coverage';
import { api, errorText } from '../api/client';
import type { ProcDto } from '../api/types';
import { useEditors } from './editors';
import { useProcs } from './procs';
import { useSettings } from './settings';
import { toast, useUi } from './ui';
import { useWorkspace } from './workspace';

export interface TestCase {
  id: string;
  name: string;
  className: string;
  namespace: string;
  path: string;
  line: number;
  framework: string;
}

export interface TestProject {
  name: string;
  projectPath: string;
  tests: TestCase[];
}

export interface TestResult {
  id: string;
  displayName: string;
  outcome: 'Passed' | 'Failed' | 'NotExecuted' | string;
  durationMs: number;
  message?: string;
  stackTrace?: string;
  output?: string;
}

export type TestState = 'passed' | 'failed' | 'skipped' | 'running' | 'none';

interface TestsStore {
  projects: TestProject[];
  discovering: boolean;
  /** Results of the last run that included each test, by test id; several entries for data-driven tests. */
  results: Record<string, TestResult[]>;
  running: Set<string>;
  runningAll: boolean;
  selected: string | null;
  set(p: Partial<TestsStore>): void;
}

export const useTests = create<TestsStore>((set) => ({
  projects: [],
  discovering: false,
  results: {},
  running: new Set(),
  runningAll: false,
  selected: null,
  set: (p) => set(p),
}));

export function stateOf(id: string, s = useTests.getState()): TestState {
  if (s.running.has(id)) return 'running';
  const r = s.results[id];
  if (!r?.length) return 'none';
  if (r.some((x) => x.outcome === 'Failed')) return 'failed';
  if (r.every((x) => x.outcome === 'NotExecuted')) return 'skipped';
  return 'passed';
}

let discoverTimer: ReturnType<typeof setTimeout> | undefined;

export function discoverTests(delay = 0): void {
  clearTimeout(discoverTimer);
  discoverTimer = setTimeout(async () => {
    if (!useWorkspace.getState().ws.projects.some((p) => p.kind === 'test')) {
      useTests.setState({ projects: [] });
      return;
    }
    useTests.setState({ discovering: true });
    try {
      const projects = await api.get<TestProject[]>('/tests/discover');
      useTests.setState({ projects });
    } catch {
      /* workspace still loading */
    } finally {
      useTests.setState({ discovering: false });
    }
  }, delay);
}

function waitForExit(procId: string): Promise<ProcDto | null> {
  return new Promise((resolve) => {
    const check = () => {
      const p = useProcs.getState().procs[procId]?.info;
      if (p && p.exitCode != null) {
        off();
        resolve(p);
      }
    };
    const off = useProcs.subscribe(check);
    check();
  });
}

/**
 * Runs tests: a list of test ids (methods; a class or namespace prefix runs everything under it), or every test of a
 * project / the solution when `ids` is empty.
 */
export async function runTests(ids: string[] = [], projectPath?: string, coverage = false): Promise<void> {
  if (useTests.getState().runningAll || useTests.getState().running.size) {
    toast('info', 'Tests are already running');
    return;
  }
  if (useSettings.getState().settings.saveBeforeBuild) await useEditors.getState().saveAll();
  const all = useTests.getState().projects.flatMap((p) => p.tests.map((t) => t.id));
  const covered = ids.length ? all.filter((t) => ids.some((x) => t === x || t.startsWith(`${x}.`))) : projectPath ? useTests.getState().projects.find((p) => p.projectPath === projectPath)?.tests.map((t) => t.id) ?? [] : all;
  // run only the projects that own the requested tests
  const owner = projectPath ?? (ids.length ? useTests.getState().projects.find((p) => p.tests.some((t) => covered.includes(t.id)))?.projectPath : undefined);
  useTests.setState({ running: new Set(covered), runningAll: !ids.length });
  useUi.getState().showBottom('tests');
  try {
    const run = await api.post<{ runId: string; procId: string }>('/tests/run', { projectPath: owner, tests: ids.length ? ids : null, coverage });
    const exit = await waitForExit(run.procId);
    const results = await api.get<TestResult[]>(`/tests/results/${run.runId}`);
    const byId: Record<string, TestResult[]> = {};
    for (const r of results) (byId[r.id] ??= []).push(r);
    useTests.setState((s) => {
      const next = { ...s.results };
      for (const id of covered) delete next[id];
      Object.assign(next, byId);
      return { results: next };
    });
    const failed = results.filter((r) => r.outcome === 'Failed').length;
    const passed = results.filter((r) => r.outcome === 'Passed').length;
    if (results.length === 0) {
      useUi.getState().toast({ kind: 'error', text: 'No test results', detail: exit?.exitCode ? 'The build or the test run failed — see the Build window.' : undefined, action: { label: 'Show output', run: () => useUi.getState().showBottom('build') } }, 8000);
    } else if (failed) toast('error', `${failed} test${failed === 1 ? '' : 's'} failed`, `${passed} passed`, 5000);
    else toast('success', `${passed} test${passed === 1 ? '' : 's'} passed`, undefined, 3000);
    if (coverage && results.length) await loadCoverage(run.runId);
  } catch (e) {
    toast('error', 'Could not run the tests', errorText(e));
  } finally {
    useTests.setState({ running: new Set(), runningAll: false });
  }
}

/** The coverage the run collected, shown in the editor and the Coverage window. */
async function loadCoverage(runId: string): Promise<void> {
  const data = await api.get<Coverage | undefined>(`/tests/coverage/${runId}`).catch(() => undefined);
  if (!data) {
    toast('warning', 'No coverage was collected', 'The test project needs Microsoft.NET.Test.Sdk 17.8 or later, or the coverlet.collector package.', 8000);
    return;
  }
  setCoverage(data);
  useUi.getState().toast({ kind: 'info', text: `Coverage: ${formatPercent(data.covered, data.total)} of lines`, detail: `${data.covered} of ${data.total} lines in ${data.files.length} files`, action: { label: 'Show coverage', run: () => useUi.getState().showBottom('coverage') } }, 6000);
}

export function runFailed(): void {
  const s = useTests.getState();
  const failed = Object.keys(s.results).filter((id) => stateOf(id, s) === 'failed');
  if (!failed.length) toast('info', 'No failed tests');
  else void runTests(failed);
}
