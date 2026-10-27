// Start-up: theme, engine handshake, language providers, the event stream and session restore.
import { api, errorText, setEngineInfo } from '../api/client';
import type { MetaDto } from '../api/types';
import { connectEvents, onEngineEvent } from '../api/ws';
import { refreshAllDiagnostics, refreshInlayHints, registerCSharp } from '../editor/csharp';
import { refreshCodeVision, registerCodeVision } from '../editor/codeVision';
import { todosMaybeChanged } from '../components/TodoPanel';
import { registerPostfix } from '../editor/postfix';
import { registerSql } from '../editor/sql';
import { allEntries, isDirty, replaceText } from '../editor/models';
import { basename, samePath } from '../lib/paths';
import { platform } from '../platform';
import { restoreTabs, useEditors } from '../store/editors';
import { useProblems } from '../store/problems';
import { useProcs } from '../store/procs';
import { onSystemThemeChange, useSettings } from '../store/settings';
import { applyThemes } from '../theme/applyTheme';
import { applyFonts } from '../theme/fonts';
import { installUpdateWiring } from './updates';
import { refreshGit } from '../store/git';
import { onTerminalEvent, refont, retheme } from '../store/terminals';
import { newChat, onAiEvent, refreshKeys, useAi } from '../store/ai';
import { discoverTests } from '../store/tests';
import { registerTestLenses } from '../editor/testLens';
import { loadBreakpoints, onDebugEvent } from '../store/debug';
import { registerDebugHover } from '../editor/debugEditor';
import { onMemoryPressure, startMemoryMonitor, syncMemorySettings } from '../store/memory';
import { toast, useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';


async function loadMeta(): Promise<MetaDto> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.get<MetaDto>('/meta');
    } catch (e) {
      useUi.getState().set({ engineError: `Cannot reach the Kod engine: ${errorText(e)}` });
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** attempt)));
    }
  }
}

let booted = false;

export async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  document.documentElement.classList.add(`os-${platform.os}`);
  if (platform.titleBar === 'overlay') document.documentElement.classList.add('titlebar-overlay');
  if (platform.titleBar === 'inset') document.documentElement.classList.add('titlebar-inset');

  applyThemes();
  applyFonts();
  useSettings.subscribe((s, prev) => {
    const a = s.settings, b = prev.settings;
    if (a.uiFontFamily !== b.uiFontFamily || a.uiFontSize !== b.uiFontSize) applyFonts();
    if (a.inlayHints !== b.inlayHints) refreshInlayHints();
    if (a.inspections !== b.inspections) refreshAllDiagnostics();
    if (a.fontFamily !== b.fontFamily || a.fontSize !== b.fontSize || a.terminalFontFamily !== b.terminalFontFamily || a.terminalFontSize !== b.terminalFontSize) refont();
    if (a.theme !== b.theme || a.appThemeLight !== b.appThemeLight || a.appThemeDark !== b.appThemeDark || a.codeTheme !== b.codeTheme) {
      applyThemes();
      retheme();
    }
  });
  onSystemThemeChange(() => useSettings.getState().settings.theme === 'system' && applyThemes());

  const meta = await loadMeta();
  useUi.getState().set({ engineError: null });
  useWorkspace.setState({ meta });
  registerCSharp({ tokenTypes: meta.tokenTypes, tokenModifiers: meta.tokenModifiers });
  registerDebugHover();
  registerTestLenses();
  registerCodeVision();
  registerPostfix();
  registerSql();
  void refreshKeys();
  startMemoryMonitor();
  window.addEventListener('focus', () => refreshGit(100));

  let lastRoot: string | undefined;
  let lastState: string | undefined;
  onEngineEvent((e) => {
    switch (e.type) {
      case 'workspace.state': {
        const { type: _t, ...ws } = e;
        useWorkspace.getState().apply(ws);
        if (!samePath(ws.root, lastRoot)) {
          lastRoot = ws.root;
          loadBreakpoints();
          if (ws.root) void restoreTabs(ws.root);
        }
        if (ws.state === 'ready' && lastState !== 'ready') {
          refreshAllDiagnostics();
          refreshGit(0);
          discoverTests(500);
        }
        lastState = ws.state;
        break;
      }
      case 'fs.changed':
        for (const f of e.files) onDiskChange(f);
        if (e.files.some((f) => /\.cs$/i.test(f))) refreshCodeVision();
        todosMaybeChanged();
        refreshGit(600);
        if (e.files.some((f) => /\.(cs|csproj)$/i.test(f))) discoverTests(2500);
        break;
      case 'term.output':
      case 'term.exit':
        onTerminalEvent(e);
        break;
      case 'ai.delta':
      case 'ai.thinking':
      case 'ai.notice':
      case 'ai.tool':
      case 'ai.done':
        onAiEvent(e);
        break;
      case 'git.changed':
        refreshGit(0);
        break;
      case 'memory.pressure':
        onMemoryPressure(e);
        break;
      case 'debug.state':
      case 'debug.stopped':
      case 'debug.output':
      case 'debug.ended':
        onDebugEvent(e);
        break;
      case 'proc.started':
      case 'proc.output':
      case 'proc.exit':
        useProcs.getState().onEvent(e);
        break;
    }
  });
  platform.onEngineRestarted((info) => {
    setEngineInfo(info);
    void connectEvents();
    syncMemorySettings();
    // the assistant's conversations lived in the old engine
    if (useAi.getState().busy) newChat();
    toast('warning', 'The engine restarted', 'Projects are being reloaded.');
    const root = useWorkspace.getState().ws.root;
    if (root) void useWorkspace.getState().open(root);
  });
  await connectEvents();

  // reopen the last workspace, like Rider
  const current = await api.get<{ root?: string }>('/workspace').catch(() => null);
  const last = useWorkspace.getState().recents[0];
  if (!current?.root && last && useSettings.getState().settings.reopenLastWorkspace) void useWorkspace.getState().open(last.path);
  installUpdateWiring();

  // window title follows the workspace and file
  const title = () => {
    const ws = useWorkspace.getState().ws;
    const active = useEditors.getState().active;
    const tab = useEditors.getState().tabs.find((t) => t.path === active);
    const name = !active || active.startsWith('kod-metadata:') ? null : tab && tab.kind !== 'file' ? tab.title : basename(active);
    const parts = [name, ws.root ? basename(ws.target ?? ws.root) : null, 'Kod'].filter(Boolean);
    platform.setTitle(parts.join(' – '));
  };
  useWorkspace.subscribe(title);
  useEditors.subscribe(title);
  title();

  window.addEventListener('beforeunload', (e) => {
    if (allEntries().some((x) => !x.ephemeral && !x.readOnly && isDirty(x))) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/** A file changed on disk: reload clean editors, warn about dirty ones. */
function onDiskChange(path: string): void {
  const e = allEntries().find((x) => samePath(x.path, path));
  if (!e) return;
  void api
    .get<{ text: string }>('/fs/read', { path: e.path })
    .then((f) => {
      if (f.text === e.model.getValue()) return;
      if (!isDirty(e)) {
        replaceText(e, f.text);
        return;
      }
      toast('warning', `${basename(path)} changed on disk`, 'Your unsaved changes are kept; save to overwrite the file, or close the tab without saving to reload it.', 8000);
    })
    .catch(() => {
      // deleted: keep the editor content, mark it unsaved
      useProblems.getState().clearLive(path);
    });
}
