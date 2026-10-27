import { useDebug } from '../store/debug';
import { useGit } from '../store/git';
import { showBranchMenu } from './GitBranchMenu';
import { Bug, GitBranch, ChevronDown, FlaskConical, FolderOpen, Hammer, Layers, Menu as MenuIcon, Moon, PanelBottom, PanelLeft, Play, Search, Settings, Settings2, Sparkles, Square, Sun, SunMoon } from 'lucide-react';
import { activeConfig, allConfigs, useRunConfigs } from '../store/runConfigs';
import { RunConfigsDialog } from './RunConfigsDialog';
import { AttachDialog, BreakpointDialog } from './DebugDialogs';
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
  const aiVisible = useUi((s) => s.aiVisible);
  const theme = useSettings((s) => s.settings.theme);
  useProcs((s) => s.procs); // re-render on process changes
  const debugStatus = useDebug((s) => s.status);
  const gitBranch = useGit((s) => s.status?.branch);
  const running = runningOf('run');
  const building = runningOf('build');
  useRunConfigs((s) => s.saved);
  useRunConfigs((s) => s.activeId);
  const editingConfigs = useRunConfigs((s) => s.editing);
  const configs = allConfigs();
  const config = activeConfig();
  const project = ws.projects.find((p) => samePath(p.path, startup));
  const canRun = !!config && (config.type === 'compound' || !!project?.runnable);
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
    // run configurations (one generated per runnable project, plus the user's); tests run from the Unit Tests window
    const items: MenuItem[] = configs.map((c) => ({
      label: c.name,
      icon: c.type === 'compound' ? <Layers size={14} /> : <FileIcon path={c.project ?? ''} size={14} />,
      checked: c.id === config?.id,
      shortcut: c.type === 'compound' ? 'compound' : c.hotReload ? 'hot reload' : ws.projects.find((p) => samePath(p.path, c.project))?.kind,
      run: () => useRunConfigs.getState().setActive(c.id),
    }));
    return [
      ...(items.length ? items : [{ label: ws.state === 'loading' ? 'Loading projects…' : ws.projects.length ? 'No runnable projects' : 'No projects', disabled: true } as MenuItem]),
      'separator',
      { label: 'Edit Configurations…', icon: <Settings2 size={14} />, run: () => runCommand('run.editConfigs') },
    ];
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
      {(gitBranch || ws.branch) && (
        <button className="ws-pill" style={{ fontWeight: 400 }} title="Git branches" onClick={(e) => void showBranchMenu(e.currentTarget)}>
          <GitBranch size={14} className="muted" />
          <span>{gitBranch ?? ws.branch}</span>
          <ChevronDown size={13} className="muted" />
        </button>
      )}
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
            {config?.type === 'compound' ? <Layers size={14} /> : config?.project ? <FileIcon path={config.project} size={14} /> : null}
            <span>{config?.name ?? (ws.state === 'loading' ? 'Loading…' : 'No project')}</span>
            <ChevronDown size={13} className="muted" />
          </button>
          <button className="icon-btn build" title={tip('Build', 'build.build')} disabled={building.length > 0} onClick={() => runCommand('build.build')}>
            <Hammer size={16} />
          </button>
          <button className="icon-btn run" title={tip(running.length ? 'Rerun' : 'Run', 'run.run')} disabled={!canRun} onClick={() => runCommand('run.run')}>
            <Play size={16} />
          </button>
          <button
            className={`icon-btn${debugStatus !== 'idle' ? ' on' : ''}`}
            title={debugStatus === 'stopped' ? 'Resume (F5)' : tip('Debug', 'run.debug')}
            disabled={!canRun || debugStatus === 'building' || debugStatus === 'starting' || debugStatus === 'running'}
            onClick={() => runCommand('run.debug')}
            style={{ color: canRun ? 'var(--warning)' : undefined }}
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
      <button className={`icon-btn${aiVisible ? ' on' : ''}`} title={tip('AI Assistant', 'view.ai')} onClick={() => runCommand('view.ai')}>
        <Sparkles size={16} />
      </button>
      <button className="icon-btn" title={tip('Settings', 'file.settings')} onClick={() => runCommand('file.settings')}>
        <Settings size={16} />
      </button>
      {editingConfigs && <RunConfigsDialog />}
      <BreakpointDialog />
      <AttachDialog />
    </header>
  );
}
