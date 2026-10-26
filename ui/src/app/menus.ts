import type { MenuItem } from '../components/common/Menu';
import { useWorkspace } from '../store/workspace';
import { openWorkspace } from './actions';
import { commandById, keyLabel } from './commands';

const c = (id: string, label?: string): MenuItem => {
  const cmd = commandById(id);
  if (!cmd) return { label: id, disabled: true };
  return { label: label ?? cmd.title, shortcut: cmd.keys?.[0] ? keyLabel(cmd.keys[0]) : undefined, run: () => void cmd.run() };
};

function recentMenu(): MenuItem[] {
  const recents = useWorkspace.getState().recents;
  if (recents.length === 0) return [{ label: 'No recent folders', disabled: true }];
  return recents.map((r) => ({ label: r.path, run: () => void openWorkspace(r.path) }));
}

/** The application menu (the ☰ button in the top bar). */
export function appMenu(): MenuItem[] {
  return [
    {
      label: 'File',
      submenu: [
        c('file.newProject'),
        c('file.openFolder'),
        c('file.openSolution'),
        { label: 'Open Recent', submenu: recentMenu() },
        'separator',
        c('file.newClass'),
        c('file.newInterface'),
        c('file.newFile'),
        'separator',
        c('file.save'),
        c('file.saveAll'),
        c('file.close'),
        c('file.closeAll'),
        'separator',
        c('file.reloadProjects'),
        c('file.closeWorkspace'),
        'separator',
        c('file.settings'),
      ],
    },
    {
      label: 'Edit',
      submenu: [c('code.comment'), c('code.blockComment'), 'separator', c('code.fold'), c('code.unfold'), 'separator', c('nav.findInFiles')],
    },
    {
      label: 'View',
      submenu: [
        c('view.explorer'),
        c('view.structure'),
        c('view.search'),
        c('view.nuget'),
        c('view.toggleDock'),
        'separator',
        c('view.run'),
        c('view.build'),
        c('view.problems'),
        c('view.terminal'),
        c('view.toggleBottom'),
        'separator',
        c('view.theme'),
        c('view.zoomIn'),
        c('view.zoomOut'),
      ],
    },
    {
      label: 'Navigate',
      submenu: [c('nav.searchEverywhere'), c('nav.goToFile'), c('nav.goToSymbol'), c('nav.goToLine'), 'separator', c('nav.definition'), c('nav.implementation'), c('nav.usages'), c('nav.peekUsages'), c('nav.fileStructure'), 'separator', c('nav.commands')],
    },
    {
      label: 'Code',
      submenu: [c('code.complete'), c('code.parameterInfo'), c('code.quickDoc'), 'separator', c('code.actions'), c('code.rename'), c('code.format'), 'separator', c('code.analyze')],
    },
    {
      label: 'Build',
      submenu: [c('build.build'), c('build.rebuild'), c('build.clean'), c('build.restore'), 'separator', c('run.stopBuild')],
    },
    {
      label: 'Run',
      submenu: [
        c('run.run'),
        c('run.debug'),
        c('run.stop'),
        'separator',
        c('debug.stepOver'),
        c('debug.stepInto'),
        c('debug.stepOut'),
        c('debug.pause'),
        'separator',
        c('debug.toggleBreakpoint'),
        c('debug.clearBreakpoints'),
        'separator',
        c('run.tests'),
        'separator',
        c('view.newTerminal'),
      ],
    },
    {
      label: 'Git',
      submenu: [
        c('view.commit'),
        c('git.push'),
        c('git.pull'),
        c('git.fetch'),
        'separator',
        c('git.branches'),
        c('git.newBranch'),
        'separator',
        c('git.diff'),
        c('git.annotate'),
        c('git.rollback'),
        'separator',
        c('view.git'),
        c('git.init'),
      ],
    },
    {
      label: 'Tests',
      submenu: [c('run.tests'), c('tests.runFailed'), c('tests.runCurrent'), 'separator', c('view.tests')],
    },
    { label: 'Help', submenu: [c('view.shortcuts'), c('nav.commands'), 'separator', c('help.checkForUpdates'), c('help.about')] },
  ];
}
