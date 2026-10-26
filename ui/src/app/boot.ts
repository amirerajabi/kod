// Start-up: theme, engine handshake, language providers, the event stream and session restore.
import { api, errorText, setEngineInfo } from '../api/client';
import type { MetaDto } from '../api/types';
import { connectEvents, onEngineEvent } from '../api/ws';
import { refreshAllDiagnostics, registerCSharp } from '../editor/csharp';
import { allEntries, isDirty, replaceText } from '../editor/models';
import { applyMonacoTheme } from '../editor/monaco';
import { basename, samePath } from '../lib/paths';
import { platform } from '../platform';
import { restoreTabs, useEditors } from '../store/editors';
import { useProblems } from '../store/problems';
import { useProcs } from '../store/procs';
import { effectiveTheme, onSystemThemeChange, useSettings } from '../store/settings';
import { toast, useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';

function applyTheme(): void {
  const dark = effectiveTheme() === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  applyMonacoTheme(dark);
  const s = getComputedStyle(document.documentElement);
  platform.setTitleBarTheme({ color: s.getPropertyValue('--bg-app').trim(), symbolColor: s.getPropertyValue('--fg').trim(), dark });
}

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

  applyTheme();
  useSettings.subscribe((s, prev) => s.settings.theme !== prev.settings.theme && applyTheme());
  onSystemThemeChange(() => useSettings.getState().settings.theme === 'system' && applyTheme());

  const meta = await loadMeta();
  useUi.getState().set({ engineError: null });
  useWorkspace.setState({ meta });
  registerCSharp({ tokenTypes: meta.tokenTypes, tokenModifiers: meta.tokenModifiers });

  let lastRoot: string | undefined;
  let lastState: string | undefined;
  onEngineEvent((e) => {
    switch (e.type) {
      case 'workspace.state': {
        const { type: _t, ...ws } = e;
        useWorkspace.getState().apply(ws);
        if (!samePath(ws.root, lastRoot)) {
          lastRoot = ws.root;
          if (ws.root) void restoreTabs(ws.root);
        }
        if (ws.state === 'ready' && lastState !== 'ready') refreshAllDiagnostics();
        lastState = ws.state;
        break;
      }
      case 'fs.changed':
        for (const f of e.files) onDiskChange(f);
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
    toast('warning', 'The engine restarted', 'Projects are being reloaded.');
    const root = useWorkspace.getState().ws.root;
    if (root) void useWorkspace.getState().open(root);
  });
  await connectEvents();

  // reopen the last workspace, like Rider
  const current = await api.get<{ root?: string }>('/workspace').catch(() => null);
  const last = useWorkspace.getState().recents[0];
  if (!current?.root && last) void useWorkspace.getState().open(last.path);

  // window title follows the workspace and file
  const title = () => {
    const ws = useWorkspace.getState().ws;
    const active = useEditors.getState().active;
    const parts = [active && !active.startsWith('kod-metadata:') ? basename(active) : null, ws.root ? basename(ws.target ?? ws.root) : null, 'Kod'].filter(Boolean);
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
