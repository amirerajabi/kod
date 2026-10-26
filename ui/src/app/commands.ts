// Command registry: every action has an id, a title and optional shortcuts (Rider keymap, Ctrl → ⌘ on macOS).
// The palette lists them; a capture-phase key listener runs the app-level ones even while Monaco has focus.
import { api, errorText } from '../api/client';
import type { DiagnosticDto } from '../api/types';
import { editorAction, findUsages, getEditor } from '../editor/CodeEditor';
import { toggleBreakpointAtCursor } from '../editor/debugEditor';
import { debugActive, startDebugging, step, stopDebugging, useDebug } from '../store/debug';
import { isMac } from '../platform';
import { closeAllTabs, useEditors } from '../store/editors';
import { useProblems } from '../store/problems';
import { dotnetBuild, dotnetRun, runningOf, startTerminal, stopAll } from '../store/procs';
import { effectiveTheme, useSettings } from '../store/settings';
import { toast, useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { openSettings } from '../components/settings/nav';
import { closeWorkspace, createItem, currentFilePath, goToLine, openFolder, openSolutionFile } from './actions';
import { checkForUpdatesNow } from './updates';
import { showBranchMenu } from '../components/GitBranchMenu';
import { toggleBlame } from '../editor/gitEditor';
import { gitFetch, gitPull, gitPush, initRepository, newBranch, openDiff, rollback } from '../store/git';
import { runFailed, runTests, useTests } from '../store/tests';
import { samePath } from '../lib/paths';

function runCurrentFileTests(): void {
  const f = currentFilePath();
  const ids = f ? useTests.getState().projects.flatMap((p) => p.tests).filter((t) => samePath(t.path, f)).map((t) => t.id) : [];
  if (ids.length) void runTests(ids);
  else toast('info', 'No tests in this file');
}

export interface Command {
  id: string;
  title: string;
  category: string;
  keys?: string[];
  run: () => void | Promise<void>;
  /** Runs even when a text field outside the editor has focus. */
  global?: boolean;
  /** The key binding only applies while this holds (otherwise the key goes to the editor). */
  when?: () => boolean;
}

const needsRoot = (fn: () => unknown) => () => {
  if (!useWorkspace.getState().ws.root) {
    toast('info', 'Open a folder or solution first');
    return;
  }
  void fn();
};

export const COMMANDS: Command[] = [
  // File
  { id: 'file.openFolder', title: 'Open Folder…', category: 'File', keys: ['Ctrl+K Ctrl+O'], run: openFolder, global: true },
  { id: 'file.openSolution', title: 'Open Solution or Project…', category: 'File', run: openSolutionFile },
  { id: 'file.newProject', title: 'New Project / Solution…', category: 'File', run: () => useUi.getState().set({ newProjectOpen: true }) },
  { id: 'file.newClass', title: 'New C# Class…', category: 'File', keys: ['Alt+Insert'], run: needsRoot(() => createItem(newItemDir(), 'class')) },
  { id: 'file.newInterface', title: 'New C# Interface…', category: 'File', run: needsRoot(() => createItem(newItemDir(), 'interface')) },
  { id: 'file.newFile', title: 'New File…', category: 'File', run: needsRoot(() => createItem(newItemDir(), 'file')) },
  { id: 'file.save', title: 'Save', category: 'File', keys: ['Ctrl+S'], run: () => void useEditors.getState().save(), global: true },
  { id: 'file.saveAll', title: 'Save All', category: 'File', keys: ['Ctrl+Shift+S'], run: () => void useEditors.getState().saveAll(), global: true },
  { id: 'file.close', title: 'Close Tab', category: 'File', keys: ['Ctrl+F4'], run: () => { const a = useEditors.getState().active; if (a) void useEditors.getState().close(a); }, global: true },
  { id: 'file.closeAll', title: 'Close All Tabs', category: 'File', keys: ['Ctrl+Shift+F4'], run: () => void closeAllTabs() },
  { id: 'file.closeWorkspace', title: 'Close Workspace', category: 'File', run: closeWorkspace },
  { id: 'file.reloadProjects', title: 'Reload Projects', category: 'File', run: needsRoot(() => useWorkspace.getState().reload()) },
  { id: 'file.settings', title: 'Settings…', category: 'File', keys: ['Ctrl+Alt+S', 'Ctrl+,'], run: () => useUi.getState().set({ settingsOpen: true }), global: true },

  // Navigate
  { id: 'nav.searchEverywhere', title: 'Search Everywhere', category: 'Navigate', keys: ['Shift Shift', 'Ctrl+T'], run: () => useUi.getState().openPalette('files'), global: true },
  { id: 'nav.goToFile', title: 'Go to File…', category: 'Navigate', keys: ['Ctrl+Shift+N', 'Ctrl+P'], run: () => useUi.getState().openPalette('files'), global: true },
  { id: 'nav.goToSymbol', title: 'Go to Symbol…', category: 'Navigate', keys: ['Ctrl+N', 'Ctrl+Alt+Shift+N'], run: () => useUi.getState().openPalette('symbols', '#'), global: true },
  { id: 'nav.commands', title: 'Find Action…', category: 'Navigate', keys: ['Ctrl+Shift+A', 'Ctrl+Shift+P', 'F1'], run: () => useUi.getState().openPalette('commands', '>'), global: true },
  { id: 'nav.goToLine', title: 'Go to Line…', category: 'Navigate', keys: ['Ctrl+G'], run: goToLine, global: true },
  { id: 'nav.definition', title: 'Go to Declaration', category: 'Navigate', keys: ['F12', 'Ctrl+B'], run: () => editorAction('editor.action.revealDefinition') },
  { id: 'nav.implementation', title: 'Go to Implementation', category: 'Navigate', keys: ['Ctrl+Alt+B'], run: () => editorAction('editor.action.goToImplementation') },
  { id: 'nav.usages', title: 'Find Usages', category: 'Navigate', keys: ['Alt+F7'], run: () => void findUsages() },
  { id: 'nav.peekUsages', title: 'Peek Usages', category: 'Navigate', keys: ['Shift+F12'], run: () => editorAction('editor.action.referenceSearch.trigger') },
  { id: 'nav.fileStructure', title: 'File Structure', category: 'Navigate', keys: ['Ctrl+F12'], run: () => editorAction('editor.action.quickOutline') },
  { id: 'nav.findInFiles', title: 'Find in Files', category: 'Navigate', keys: ['Ctrl+Shift+F'], run: () => useUi.getState().showDock('search'), global: true },
  { id: 'nav.back', title: 'Back', category: 'Navigate', keys: ['Alt+Left'], run: () => editorAction('workbench.action.navigateBack') },

  // Code
  { id: 'code.complete', title: 'Basic Completion', category: 'Code', keys: ['Ctrl+Space'], run: () => editorAction('editor.action.triggerSuggest') },
  { id: 'code.actions', title: 'Show Context Actions', category: 'Code', keys: ['Alt+Enter', 'Ctrl+.'], run: () => editorAction('editor.action.quickFix') },
  { id: 'code.rename', title: 'Rename…', category: 'Code', keys: ['F2', 'Shift+F6'], run: () => editorAction('editor.action.rename') },
  { id: 'code.format', title: 'Reformat Code', category: 'Code', keys: ['Ctrl+Alt+L', 'Shift+Alt+F'], run: () => editorAction('editor.action.formatDocument') },
  { id: 'code.comment', title: 'Comment Line', category: 'Code', keys: ['Ctrl+/'], run: () => editorAction('editor.action.commentLine') },
  { id: 'code.blockComment', title: 'Comment Block', category: 'Code', keys: ['Ctrl+Shift+/'], run: () => editorAction('editor.action.blockComment') },
  { id: 'code.parameterInfo', title: 'Parameter Info', category: 'Code', keys: ['Ctrl+Shift+Space'], run: () => editorAction('editor.action.triggerParameterHints') },
  { id: 'code.quickDoc', title: 'Quick Documentation', category: 'Code', keys: ['Ctrl+Q', 'Ctrl+K Ctrl+I'], run: () => editorAction('editor.action.showHover') },
  { id: 'code.fold', title: 'Collapse All', category: 'Code', keys: ['Ctrl+Shift+-'], run: () => editorAction('editor.foldAll') },
  { id: 'code.unfold', title: 'Expand All', category: 'Code', keys: ['Ctrl+Shift+='], run: () => editorAction('editor.unfoldAll') },
  { id: 'code.analyze', title: 'Analyze Solution (all errors and warnings)', category: 'Code', run: needsRoot(analyzeSolution) },

  // Build / Run
  { id: 'build.build', title: 'Build Solution', category: 'Build', keys: ['Ctrl+Shift+B', 'Ctrl+F9'], run: needsRoot(() => dotnetBuild('build')), global: true },
  { id: 'build.rebuild', title: 'Rebuild Solution', category: 'Build', run: needsRoot(() => dotnetBuild('rebuild')) },
  { id: 'build.clean', title: 'Clean Solution', category: 'Build', run: needsRoot(() => dotnetBuild('clean')) },
  { id: 'build.restore', title: 'Restore NuGet Packages', category: 'Build', run: needsRoot(() => dotnetBuild('restore')) },
  { id: 'run.run', title: 'Run', category: 'Run', keys: ['Shift+F10', 'Ctrl+F5'], run: needsRoot(() => dotnetRun()), global: true },
  { id: 'run.debug', title: 'Debug / Resume', category: 'Run', keys: ['F5', 'Shift+F9'], run: needsRoot(() => startDebugging()), global: true },
  { id: 'run.stop', title: 'Stop', category: 'Run', keys: ['Shift+F5', 'Ctrl+F2'], run: () => (debugActive() ? void stopDebugging() : stopAll('run')), global: true },
  { id: 'debug.stepOver', title: 'Step Over', category: 'Debug', keys: ['F10', 'F8'], run: () => void step('next'), global: true, when: debugActive },
  { id: 'debug.stepInto', title: 'Step Into', category: 'Debug', keys: ['F11', 'F7'], run: () => void step('stepIn'), global: true, when: debugActive },
  { id: 'debug.stepOut', title: 'Step Out', category: 'Debug', keys: ['Shift+F11', 'Shift+F8'], run: () => void step('stepOut'), global: true, when: debugActive },
  { id: 'debug.pause', title: 'Pause', category: 'Debug', run: () => void step('pause') },
  { id: 'debug.toggleBreakpoint', title: 'Toggle Breakpoint', category: 'Debug', keys: ['F9', 'Ctrl+F8'], run: () => toggleBreakpointAtCursor(getEditor()) },
  { id: 'debug.clearBreakpoints', title: 'Remove All Breakpoints', category: 'Debug', run: () => useDebug.getState().clearAll() },
  { id: 'view.debug', title: 'Debug Window', category: 'View', keys: ['Alt+5'], run: () => useUi.getState().showBottom('debug'), global: true },
  { id: 'run.stopBuild', title: 'Cancel Build', category: 'Build', keys: ['Ctrl+Break'], run: () => stopAll('build'), global: true },
  { id: 'run.tests', title: 'Run All Tests', category: 'Run', keys: ['Ctrl+U Ctrl+L'], run: needsRoot(() => runTests()) },
  { id: 'tests.runFailed', title: 'Run Failed Tests', category: 'Run', keys: ['Ctrl+U Ctrl+F'], run: needsRoot(() => runFailed()) },
  { id: 'tests.runCurrent', title: 'Run Tests in This File', category: 'Run', keys: ['Ctrl+U Ctrl+R'], run: needsRoot(() => runCurrentFileTests()) },
  { id: 'view.tests', title: 'Unit Tests', category: 'View', keys: ['Alt+8'], run: () => useUi.getState().showBottom('tests'), global: true },

  // Git
  { id: 'view.commit', title: 'Commit', category: 'Git', keys: ['Alt+0', 'Ctrl+K Ctrl+C'], run: () => useUi.getState().showDock('commit'), global: true },
  { id: 'view.git', title: 'Git Log', category: 'Git', keys: ['Alt+9'], run: () => useUi.getState().showBottom('git'), global: true },
  { id: 'git.push', title: 'Push…', category: 'Git', keys: ['Ctrl+Shift+K'], run: needsRoot(() => gitPush()), global: true },
  { id: 'git.pull', title: 'Update Project (Pull)', category: 'Git', run: needsRoot(() => gitPull()) },
  { id: 'git.fetch', title: 'Fetch', category: 'Git', run: needsRoot(() => gitFetch()) },
  { id: 'git.newBranch', title: 'New Branch…', category: 'Git', run: needsRoot(() => newBranch()) },
  { id: 'git.branches', title: 'Branches…', category: 'Git', keys: ['Ctrl+Shift+`'], run: needsRoot(() => { const el = document.querySelector<HTMLElement>('.statusbar button[title="Git branches"]'); if (el) void showBranchMenu(el, true); }), global: true },
  { id: 'git.diff', title: 'Show Diff with HEAD', category: 'Git', run: () => { const f = currentFilePath(); if (f) openDiff(f); } },
  { id: 'git.annotate', title: 'Annotate with Git Blame', category: 'Git', run: () => toggleBlame() },
  { id: 'git.rollback', title: 'Rollback Changes in This File…', category: 'Git', run: () => { const f = currentFilePath(); if (f) void rollback([f]); } },
  { id: 'git.init', title: 'Create Git Repository', category: 'Git', run: needsRoot(() => initRepository()) },

  // View
  { id: 'view.toggleDock', title: 'Toggle Side Panel', category: 'View', keys: ['Ctrl+Shift+F12'], run: () => useUi.getState().toggleDock(), global: true },
  { id: 'view.explorer', title: 'Explorer', category: 'View', keys: ['Alt+1'], run: () => toggleDockPanel('explorer'), global: true },
  { id: 'view.structure', title: 'Structure', category: 'View', keys: ['Alt+7'], run: () => useUi.getState().showDock('structure'), global: true },
  { id: 'view.search', title: 'Search', category: 'View', run: () => useUi.getState().showDock('search') },
  { id: 'view.nuget', title: 'NuGet Packages', category: 'View', keys: ['Alt+Shift+7'], run: () => useUi.getState().showDock('nuget'), global: true },
  { id: 'view.toggleBottom', title: 'Toggle Tool Window', category: 'View', keys: ['Ctrl+J', 'Shift+Escape'], run: () => useUi.getState().toggleBottom(), global: true },
  { id: 'view.run', title: 'Run Window', category: 'View', keys: ['Alt+4'], run: () => useUi.getState().showBottom('run'), global: true },
  { id: 'view.build', title: 'Build Window', category: 'View', keys: ['Alt+3'], run: () => useUi.getState().showBottom('build'), global: true },
  { id: 'view.problems', title: 'Problems', category: 'View', keys: ['Alt+6'], run: () => useUi.getState().showBottom('problems'), global: true },
  { id: 'view.terminal', title: 'Terminal', category: 'View', keys: ['Alt+F12', 'Ctrl+`'], run: () => openTerminal(), global: true },
  { id: 'view.newTerminal', title: 'New Terminal', category: 'View', run: () => void startTerminal() },
  { id: 'view.theme', title: 'Toggle Light / Dark Theme', category: 'View', run: () => useSettings.getState().update({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' }) },
  { id: 'view.zoomIn', title: 'Increase Font Size', category: 'View', keys: ['Ctrl+='], run: () => useSettings.getState().update({ fontSize: Math.min(32, useSettings.getState().settings.fontSize + 1) }), global: true },
  { id: 'view.zoomOut', title: 'Decrease Font Size', category: 'View', keys: ['Ctrl+-'], run: () => useSettings.getState().update({ fontSize: Math.max(9, useSettings.getState().settings.fontSize - 1) }), global: true },
  { id: 'view.shortcuts', title: 'Keyboard Shortcuts', category: 'Help', keys: ['Ctrl+K Ctrl+S'], run: () => useUi.getState().set({ shortcutsOpen: true }), global: true },
  { id: 'help.checkForUpdates', title: 'Check for Updates…', category: 'Help', run: () => void checkForUpdatesNow() },
  { id: 'help.about', title: 'About Kod', category: 'Help', run: () => openSettings('updates') },
];

/** Alt+1 style: show the panel, or hide the dock when that panel is already showing. */
function toggleDockPanel(panel: 'explorer'): void {
  const s = useUi.getState();
  if (s.dockVisible && s.dock === panel) s.toggleDock();
  else s.showDock(panel);
}

function newItemDir(): string {
  const file = currentFilePath();
  const root = useWorkspace.getState().ws.root!;
  return file ? file.replace(/[\\/][^\\/]+$/, '') : root;
}

function openTerminal(): void {
  useUi.getState().showBottom('terminal');
  if (runningOf('terminal').length === 0) void startTerminal();
}

async function analyzeSolution(): Promise<void> {
  useProblems.getState().set({ analyzing: true });
  useUi.getState().showBottom('problems');
  try {
    const list = await api.get<DiagnosticDto[]>('/intel/solutionDiagnostics');
    useProblems.getState().set({ solution: list, analyzing: false });
  } catch (e) {
    useProblems.getState().set({ analyzing: false });
    toast('error', 'Analysis failed', errorText(e));
  }
}

export const commandById = (id: string) => COMMANDS.find((c) => c.id === id);
export const runCommand = (id: string) => void commandById(id)?.run();

/** "Ctrl+Shift+B" → "Ctrl+Shift+B" on Windows, "⌘⇧B" on macOS. */
export function keyLabel(k: string): string {
  if (!isMac) return k;
  return k
    .split(' ')
    .map((chord) => chord.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧'))
    .join(' ');
}

export const shortcutOf = (id: string) => {
  const k = commandById(id)?.keys?.[0];
  return k ? keyLabel(k) : undefined;
};

// ---------------------------------------------------------------- key dispatch

function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  if (e.code === 'Backquote') key = '`';
  if (e.code === 'Equal') key = '=';
  if (e.code === 'Minus') key = '-';
  if (e.code === 'Slash') key = '/';
  if (e.code === 'Comma') key = ',';
  if (e.code === 'Period') key = '.';
  return [...parts, key].join('+');
}

/** Shortcuts Monaco implements itself: left to the editor when it has focus. */
const EDITOR_OWNED = new Set(['F9', 'Ctrl+F8', 'F12', 'Ctrl+B', 'Ctrl+Alt+B', 'Alt+F7', 'Shift+F12', 'Ctrl+F12', 'Alt+Left', 'Ctrl+Space', 'Alt+Enter', 'Ctrl+.', 'F2', 'Shift+F6', 'Ctrl+Alt+L', 'Shift+Alt+F', 'Ctrl+/', 'Ctrl+Shift+/', 'Ctrl+Shift+Space', 'Ctrl+Q', 'Ctrl+Shift+-', 'Ctrl+Shift+=']);

export function installKeys(): () => void {
  let pendingChord: string | null = null;
  let chordTimer: ReturnType<typeof setTimeout> | undefined;
  let lastShift = 0;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Shift' && !e.repeat) {
      const now = Date.now();
      if (now - lastShift < 350) {
        lastShift = 0;
        e.preventDefault();
        useUi.getState().openPalette('files');
        return;
      }
      lastShift = now;
      return;
    }
    if (['Control', 'Alt', 'Meta', 'Shift'].includes(e.key)) return;
    lastShift = 0;
    const chord = chordOf(e);
    const full = pendingChord ? `${pendingChord} ${chord}` : chord;
    const target = e.target as HTMLElement | null;
    const inEditor = !!target?.closest?.('.monaco-editor');
    const inField = !inEditor && !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    // dialogs own their keys
    if (document.querySelector('.overlay') && !['Escape'].includes(e.key) && !useUi.getState().palette) {
      if (!(chord === 'Ctrl+S')) return;
    }

    const cmd = COMMANDS.find((c) => c.keys?.includes(full) && (!c.when || c.when()));
    if (cmd) {
      if (inEditor && EDITOR_OWNED.has(full)) return;
      if (inField && !cmd.global) return;
      e.preventDefault();
      e.stopPropagation();
      pendingChord = null;
      void cmd.run();
      return;
    }
    // first half of a two-chord shortcut (Ctrl+K Ctrl+O)
    if (!pendingChord && COMMANDS.some((c) => c.keys?.some((k) => k.startsWith(`${chord} `)))) {
      e.preventDefault();
      e.stopPropagation();
      pendingChord = chord;
      clearTimeout(chordTimer);
      chordTimer = setTimeout(() => (pendingChord = null), 1500);
      return;
    }
    pendingChord = null;
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
