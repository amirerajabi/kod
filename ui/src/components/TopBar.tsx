import { useDebug } from '../store/debug';
import { Bug, ChevronDown, FlaskConical, FolderOpen, Hammer, Menu as MenuIcon, Moon, PanelBottom, PanelLeft, Play, Search, Settings, Square, Sun, SunMoon } from 'lucide-react';
import { openWorkspace } from '../app/actions';
import { runCommand, shortcutOf } from '../app/commands';
import { appMenu } from '../app/menus';
import { basename, samePath } from '../lib/paths';
import { platform } from '../platform';
import { runningOf, useProcs } from '../store/procs';
import { effectiveTheme, useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { FileIcon, KodMark } from './common/icons';
import { showMenuBelow, type MenuItem } from './common/Menu';

const tip = (title: string, id: string) => {
  const k = shortcutOf(id);
  return k ? `${title} (${k})` : title;
};

export function TopBar() {
  const ws = useWorkspace((s) => s.ws);
  const startup = useWorkspace((s) => s.startup);
  const recents = useWorkspace((s) => s.recents);
  const dockVisible = useUi((s) => s.dockVisible);
  const bottomVisible = useUi((s) => s.bottomVisible);
  const theme = useSettings((s) => s.settings.theme);
  useProcs((s) => s.procs); // re-render on process changes
  const debugStatus = useDebug((s) => s.status);
  const running = runningOf('run');
  const building = runningOf('build');
  const project = ws.projects.find((p) => samePath(p.path, startup));
  const hasRoot = !!ws.root;
  const ThemeIcon = theme === 'system' ? SunMoon : effectiveTheme() === 'dark' ? Moon : Sun;
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';

  const workspaceMenu = (): MenuItem[] => [
    { label: 'Open Folder…', icon: <FolderOpen size={14} />, run: () => runCommand('file.openFolder') },
    { label: 'New Project…', run: () => runCommand('file.newProject') },
    'separator',
    ...(recents.length ? recents.slice(0, 8).map((r): MenuItem => ({ label: r.path, run: () => void openWorkspace(r.path) })) : [{ label: 'No recent folders', disabled: true } as MenuItem]),
    ...(hasRoot ? (['separator', { label: 'Reload Projects', run: () => runCommand('file.reloadProjects') }, { label: 'Close Workspace', run: () => runCommand('file.closeWorkspace') }] as MenuItem[]) : []),
  ];

  const runMenu = (): MenuItem[] => {
    const items: MenuItem[] = ws.projects.map((p) => ({
      label: p.name,
      icon: <FileIcon path={p.path} size={14} />,
      checked: samePath(p.path, startup),
      shortcut: p.kind,
      disabled: !p.runnable && p.kind !== 'test',
      run: () => useWorkspace.getState().setStartup(p.path),
    }));
    return items.length ? items : [{ label: ws.state === 'loading' ? 'Loading projects…' : 'No projects', disabled: true }];
  };

  return (
    <header className="topbar" aria-label="Application">
      <div className="brand" aria-label="Kod">
        <KodMark size={18} />
        <span className="brand-name">Kod</span>
      </div>
      <button className="icon-btn" title="Main menu" aria-label="Main menu" onClick={(e) => showMenuBelow(e.currentTarget, appMenu())}>
        <MenuIcon size={16} />
      </button>
      <button className={`icon-btn${dockVisible ? ' on' : ''}`} title={tip('Side panel', 'view.toggleDock')} onClick={() => useUi.getState().toggleDock()}>
        <PanelLeft size={16} />
      </button>
      <button className={`icon-btn${bottomVisible ? ' on' : ''}`} title={tip('Tool windows', 'view.toggleBottom')} onClick={() => useUi.getState().toggleBottom()}>
        <PanelBottom size={16} />
      </button>
      <div className="topbar-sep" />
      <button className="ws-pill" title={ws.root ?? 'Open a folder'} onClick={(e) => showMenuBelow(e.currentTarget, workspaceMenu())}>
        <FolderOpen size={15} className="ic-folder" />
        <span>{ws.root ? basename(ws.target ?? ws.root) : 'Open…'}</span>
        <ChevronDown size={13} className="muted" />
      </button>
      {ws.branch && <span className="muted" style={{ fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }} title="Git branch">⎇ {ws.branch}</span>}
      <div className="flex-1" />
      <button type="button" className="palette-trigger" onClick={() => useUi.getState().openPalette('files')} title="Search files, symbols (#) and actions (>)">
        <Search size={14} />
        <span className="palette-trigger-text">Search everywhere</span>
        <span className="kbd-group">
          <kbd>{platform.os === 'darwin' ? '⇧' : 'Shift'}</kbd>
          <kbd>{platform.os === 'darwin' ? '⇧' : 'Shift'}</kbd>
        </span>
      </button>
      <div className="flex-1" />
      {hasRoot && (
        <>
          <button className="run-config" title="Run configuration" onClick={(e) => showMenuBelow(e.currentTarget, runMenu())}>
            {project ? <FileIcon path={project.path} size={14} /> : null}
            <span>{project?.name ?? (ws.state === 'loading' ? 'Loading…' : 'No project')}</span>
            <ChevronDown size={13} className="muted" />
          </button>
          <button className="icon-btn build" title={tip('Build', 'build.build')} disabled={building.length > 0} onClick={() => runCommand('build.build')}>
            <Hammer size={16} />
          </button>
          <button className="icon-btn run" title={tip(running.length ? 'Rerun' : 'Run', 'run.run')} disabled={!project?.runnable} onClick={() => runCommand('run.run')}>
            <Play size={16} />
          </button>
          <button
            className={`icon-btn${debugStatus !== 'idle' ? ' on' : ''}`}
            title={debugStatus === 'stopped' ? 'Resume (F5)' : tip('Debug', 'run.debug')}
            disabled={!project?.runnable || debugStatus === 'building' || debugStatus === 'starting' || debugStatus === 'running'}
            onClick={() => runCommand('run.debug')}
            style={{ color: project?.runnable ? 'var(--warning)' : undefined }}
          >
            <Bug size={16} />
          </button>
          <button className="icon-btn" title="Run tests" onClick={() => runCommand('run.tests')}>
            <FlaskConical size={16} />
          </button>
          <button className="icon-btn stop" title={tip('Stop', 'run.stop')} disabled={running.length === 0 && building.length === 0 && debugStatus === 'idle'} onClick={() => (running.length || debugStatus !== 'idle' ? runCommand('run.stop') : runCommand('run.stopBuild'))}>
            <Square size={14} />
          </button>
          <div className="topbar-sep" />
        </>
      )}
      <button className="icon-btn" title={`Theme: ${theme} (click for ${nextTheme})`} onClick={() => useSettings.getState().update({ theme: nextTheme })}>
        <ThemeIcon size={16} />
      </button>
      <button className="icon-btn" title={tip('Settings', 'file.settings')} onClick={() => runCommand('file.settings')}>
        <Settings size={16} />
      </button>
    </header>
  );
}
