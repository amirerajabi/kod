// The tool window stripe on the left edge (Rider's new UI): one button per tool window, the side panel ones at the top
// and the bottom panel ones at the bottom. Only the important windows are on it at first; "More tool windows" (⋯)
// opens any other and chooses which ones stay on the stripe; right-click a button to remove it.
import {
  AlertTriangle,
  Bookmark,
  Bug,
  CircleX,
  Container,
  Database,
  DatabaseZap,
  Ellipsis,
  FlaskConical,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Hammer,
  ListChecks,
  ListTodo,
  ListTree,
  LoaderCircle,
  Network,
  Package,
  Play,
  ScanSearch,
  Search,
  ShieldCheck,
  SquareTerminal,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { shortcutOf } from '../app/commands';
import { useCoverage, formatPercent } from '../store/coverage';
import { useDb } from '../store/database';
import { useDebug } from '../store/debug';
import { useEf } from '../store/ef';
import { useHttp } from '../store/http';
import { useInspections } from '../store/inspections';
import { allProblems, countProblems, useProblems } from '../store/problems';
import { groupOf, useProcs } from '../store/procs';
import { useTests } from '../store/tests';
import { DEFAULT_STRIPE, useUi, type BottomTab, type DockPanel } from '../store/ui';
import { showContextMenu, useMenu, type MenuItem } from './common/Menu';
import { useShallow } from 'zustand/react/shallow';

export interface ToolWindow {
  id: string;
  title: string;
  Icon: LucideIcon;
  area: 'left' | 'bottom';
  /** The command that opens it (for its shortcut). */
  command?: string;
}

export const TOOL_WINDOWS: ToolWindow[] = [
  { id: 'explorer', title: 'Explorer', Icon: FolderTree, area: 'left', command: 'view.explorer' },
  { id: 'commit', title: 'Commit', Icon: GitCommitHorizontal, area: 'left', command: 'view.commit' },
  { id: 'structure', title: 'Structure', Icon: ListTree, area: 'left', command: 'view.structure' },
  { id: 'search', title: 'Find in Files', Icon: Search, area: 'left', command: 'nav.findInFiles' },
  { id: 'database', title: 'Database', Icon: Database, area: 'left', command: 'view.database' },
  { id: 'run', title: 'Run', Icon: Play, area: 'bottom', command: 'view.run' },
  { id: 'debug', title: 'Debug', Icon: Bug, area: 'bottom', command: 'view.debug' },
  { id: 'build', title: 'Build', Icon: Hammer, area: 'bottom', command: 'view.build' },
  { id: 'tests', title: 'Tests', Icon: FlaskConical, area: 'bottom', command: 'view.tests' },
  { id: 'terminal', title: 'Terminal', Icon: SquareTerminal, area: 'bottom', command: 'view.terminal' },
  { id: 'problems', title: 'Problems', Icon: CircleX, area: 'bottom', command: 'view.problems' },
  { id: 'git', title: 'Git', Icon: GitBranch, area: 'bottom', command: 'view.git' },
  { id: 'coverage', title: 'Coverage', Icon: ShieldCheck, area: 'bottom', command: 'view.coverage' },
  { id: 'http', title: 'HTTP Client', Icon: Globe, area: 'bottom', command: 'view.http' },
  { id: 'ef', title: 'EF Core', Icon: DatabaseZap, area: 'bottom', command: 'view.ef' },
  { id: 'nuget', title: 'NuGet', Icon: Package, area: 'bottom', command: 'view.nuget' },
  { id: 'inspections', title: 'Inspections', Icon: ListChecks, area: 'bottom', command: 'view.inspections' },
  { id: 'usages', title: 'Find Usages', Icon: ScanSearch, area: 'bottom' },
  { id: 'hierarchy', title: 'Hierarchy', Icon: Network, area: 'bottom', command: 'view.hierarchy' },
  { id: 'todo', title: 'TODO', Icon: ListTodo, area: 'bottom', command: 'view.todo' },
  { id: 'bookmarks', title: 'Bookmarks', Icon: Bookmark, area: 'bottom', command: 'view.bookmarks' },
  { id: 'services', title: 'Services', Icon: Container, area: 'bottom', command: 'view.services' },
  { id: 'dbresults', title: 'Query Results', Icon: Table2, area: 'bottom' },
];

export const toolWindow = (id: string) => TOOL_WINDOWS.find((t) => t.id === id);

/** The bottom panel's tab id of a tool window ('dbresults' is the 'database' results tab). */
const bottomId = (id: string) => (id === 'dbresults' ? 'database' : id) as BottomTab;
export const windowOfBottom = (tab: BottomTab) => (tab === 'database' ? 'dbresults' : tab);

export function isOpen(id: string, s = useUi.getState()): boolean {
  const w = toolWindow(id);
  if (!w) return false;
  return w.area === 'left' ? s.dockVisible && s.dock === id : s.bottomVisible && s.bottom === bottomId(id);
}

/** Opens a tool window, or hides it when it is the one showing (Rider's stripe buttons toggle). */
export function toggleToolWindow(id: string): void {
  const w = toolWindow(id);
  if (!w) return;
  const ui = useUi.getState();
  if (isOpen(id, ui)) {
    if (w.area === 'left') ui.toggleDock();
    else ui.toggleBottom();
  } else if (w.area === 'left') ui.showDock(id as DockPanel);
  else ui.showBottom(bottomId(id));
}

export function setPinned(id: string, pinned: boolean): void {
  const cur = useUi.getState().stripe;
  const next = pinned ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
  // stripe order follows the registry
  useUi.getState().setLayout({ stripe: TOOL_WINDOWS.map((t) => t.id).filter((t) => next.includes(t)) });
}

/** "More tool windows": open any window, and which windows stay on the stripe. */
export function toolWindowsMenu(): MenuItem[] {
  const pinned = useUi.getState().stripe;
  const others = TOOL_WINDOWS.filter((t) => !pinned.includes(t.id));
  const item = (t: ToolWindow): MenuItem => {
    const k = t.command ? shortcutOf(t.command) : undefined;
    return { label: t.title, icon: <t.Icon size={14} />, shortcut: k, run: () => toggleToolWindow(t.id) };
  };
  return [
    ...(others.length ? others.map(item) : [{ label: 'Every tool window is on the stripe', disabled: true } as MenuItem]),
    'separator',
    {
      label: 'Show on the Stripe',
      submenu: [
        ...TOOL_WINDOWS.filter((t) => t.area === 'left').map((t) => ({ label: t.title, checked: pinned.includes(t.id), run: () => setPinned(t.id, !pinned.includes(t.id)) })),
        'separator' as const,
        ...TOOL_WINDOWS.filter((t) => t.area === 'bottom').map((t) => ({ label: t.title, checked: pinned.includes(t.id), run: () => setPinned(t.id, !pinned.includes(t.id)) })),
      ],
    },
    { label: 'Reset the Stripe', run: () => useUi.getState().setLayout({ stripe: DEFAULT_STRIPE }) },
  ];
}

/** Live state on the buttons: a spinner while it works, the error count, the coverage. */
function useBadges(): Record<string, { busy?: boolean; badge?: ReactNode; tone?: string }> {
  const live = useProblems((s) => s.live);
  const build = useProblems((s) => s.build);
  const solution = useProblems((s) => s.solution);
  const counts = countProblems(allProblems({ live, build, solution }));
  const procs = useProcs((s) => s.procs);
  const debug = useDebug((s) => s.status);
  const tests = useTests((s) => s.running.size > 0);
  const inspecting = useInspections((s) => s.running);
  const db = useDb((s) => Object.values(s.runs).some((r) => r.running));
  const http = useHttp((s) => s.history.some((h) => h.running));
  const ef = useEf((s) => s.loading || !!s.busy);
  const coverage = useCoverage((s) => s.data);
  const running = (g: string) => Object.values(procs).some((p) => groupOf(p.info.kind) === g && p.info.exitCode == null);
  return {
    run: { busy: running('run') },
    build: { busy: running('build') },
    debug: { tone: debug === 'stopped' ? 'warning' : debug !== 'idle' ? 'success' : undefined },
    tests: { busy: tests },
    inspections: { busy: inspecting },
    dbresults: { busy: db },
    http: { busy: http },
    ef: { busy: ef },
    problems: counts.errors ? { badge: counts.errors, tone: 'error' } : counts.warnings ? { badge: counts.warnings, tone: 'warning' } : {},
    coverage: coverage ? { badge: formatPercent(coverage.covered, coverage.total).replace(/\.\d%$/, '%') } : {},
  };
}

function StripeButton({ w, open, temporary, state }: { w: ToolWindow; open: boolean; temporary: boolean; state?: { busy?: boolean; badge?: ReactNode; tone?: string } }) {
  const k = w.command ? shortcutOf(w.command) : undefined;
  const onMenu = (e: MouseEvent) =>
    showContextMenu(e, [
      { label: open ? `Hide ${w.title}` : `Show ${w.title}`, run: () => toggleToolWindow(w.id) },
      temporary ? { label: 'Keep on the Stripe', run: () => setPinned(w.id, true) } : { label: 'Remove from the Stripe', run: () => setPinned(w.id, false) },
    ]);
  return (
    <button
      className={`stripe-btn${open ? ' active' : ''}${temporary ? ' temporary' : ''}${state?.tone ? ` tone-${state.tone}` : ''}`}
      title={k ? `${w.title} (${k})` : w.title}
      aria-label={w.title}
      aria-pressed={open}
      onClick={() => toggleToolWindow(w.id)}
      onContextMenu={onMenu}
    >
      {state?.busy ? <LoaderCircle size={17} className="spin" /> : <w.Icon size={17} />}
      {state?.badge != null && <span className={`stripe-badge${state.tone ? ` ${state.tone}` : ''}`}>{state.badge}</span>}
    </button>
  );
}

export function ToolStripe() {
  const pinned = useUi((s) => s.stripe);
  const ui = useUi(useShallow((s) => ({ dockVisible: s.dockVisible, dock: s.dock, bottomVisible: s.bottomVisible, bottom: s.bottom })));
  const badges = useBadges();
  const openLeft = ui.dockVisible ? ui.dock : null;
  const openBottom = ui.bottomVisible ? windowOfBottom(ui.bottom) : null;
  // an open window that is not pinned shows on the stripe while it is open
  const shown = (area: 'left' | 'bottom') => TOOL_WINDOWS.filter((t) => t.area === area && (pinned.includes(t.id) || t.id === (area === 'left' ? openLeft : openBottom)));
  const render = (t: ToolWindow) => <StripeButton key={t.id} w={t} open={t.id === (t.area === 'left' ? openLeft : openBottom)} temporary={!pinned.includes(t.id)} state={badges[t.id]} />;
  return (
    <nav className="tool-stripe" aria-label="Tool windows">
      <div className="stripe-group">
        {shown('left').map(render)}
        <button
          className="stripe-btn"
          title="More tool windows"
          aria-label="More tool windows"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            useMenu.getState().show(r.right + 4, r.top, toolWindowsMenu());
          }}
        >
          <Ellipsis size={17} />
        </button>
      </div>
      <div className="flex-1" />
      <div className="stripe-group">{shown('bottom').map(render)}</div>
      {/* the problems count stays visible even when Problems is not on the stripe */}
      {!pinned.includes('problems') && badges.problems.badge != null && (
        <button className="stripe-btn" title="Problems" onClick={() => toggleToolWindow('problems')}>
          <AlertTriangle size={17} />
          <span className={`stripe-badge ${badges.problems.tone}`}>{badges.problems.badge}</span>
        </button>
      )}
    </nav>
  );
}
