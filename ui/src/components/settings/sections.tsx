import { Bug, Download, Keyboard, LoaderCircle, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../../api/client';
import { keyLabel } from '../../app/commands';
import { isMac } from '../../platform';
import { useSettings } from '../../store/settings';
import { toast, useUi } from '../../store/ui';
import { Card, Num, Row, Segmented, Select, ToggleRow } from './controls';
import { AppThemePicker, CodeThemePicker } from './ThemePicker';

const useS = () => useSettings((x) => x.settings);
const up = (p: Parameters<ReturnType<typeof useSettings.getState>['update']>[0]) => useSettings.getState().update(p);

export function GeneralSection() {
  const s = useS();
  return (
    <>
      <Card title="Startup">
        <ToggleRow id="set-reopen" label="Reopen the last folder or solution" hint="When Kod starts, open what you worked on last" keywords="startup restore session recent workspace" checked={s.reopenLastWorkspace} onChange={(v) => up({ reopenLastWorkspace: v })} />
      </Card>
      <Card title="Files" description="Saving and the editor tabs.">
        <Row label="Auto save" htmlFor="set-autosave" hint="Save files without pressing Save" keywords="save automatically delay focus">
          <Select id="set-autosave" value={s.autoSave} options={[['off', 'Off'], ['afterDelay', 'After a short delay'], ['onFocusChange', 'When the editor loses focus']]} onChange={(v) => up({ autoSave: v })} />
        </Row>
        <ToggleRow id="set-preview" label="Single click opens a preview tab" hint="The tab is replaced by the next file you click; edit or double-click it to keep it" keywords="preview tab italic explorer" checked={s.previewTabs} onChange={(v) => up({ previewTabs: v })} />
        <ToggleRow id="set-ignored" label="Show build folders in the explorer" hint="bin, obj, .git, .vs, node_modules…" keywords="hidden ignored bin obj explorer files" checked={s.showIgnored} onChange={(v) => up({ showIgnored: v })} />
      </Card>
      <Card title="Keyboard">
        <Row label="Keyboard shortcuts" hint={`Every command and its keys (Rider keymap)${' '}(${keyLabel('Ctrl+K Ctrl+S')})`} keywords="keys bindings hotkeys keymap shortcuts rider">
          <button
            type="button"
            className="btn"
            onClick={() => {
              useUi.getState().set({ settingsOpen: false, shortcutsOpen: true });
            }}
          >
            <Keyboard size={16} /> Show shortcuts…
          </button>
        </Row>
      </Card>
    </>
  );
}

export function AppearanceSection() {
  const s = useS();
  return (
    <>
      <Card title="Color theme" description="The look of the whole window: panels, menus, dialogs, tool windows and the title bar.">
        <Row label="Mode" hint={`System follows ${isMac ? 'macOS' : 'Windows'} between your light and dark theme`} keywords="theme dark light system appearance">
          <Segmented
            label="Mode"
            value={s.theme}
            onChange={(v) => up({ theme: v })}
            options={[
              { value: 'system', label: 'System', icon: <Monitor size={14} /> },
              { value: 'light', label: 'Light', icon: <Sun size={14} /> },
              { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
            ]}
          />
        </Row>
        <Row label="Theme" stacked labelHidden keywords="color colour theme palette nord midnight violet paper solarized darcula intellij jetbrains">
          <AppThemePicker />
        </Row>
      </Card>
      <Card title="Code theme" description="Syntax colours of the C# editor and every other code view.">
        <Row label="Code theme" stacked labelHidden keywords="code editor syntax highlighting monaco theme rider darcula visual studio vscode github dracula monokai one dark solarized">
          <CodeThemePicker />
        </Row>
      </Card>
      <Card title="Text">
        <Row label="Editor font size" htmlFor="set-fs" hint={`${isMac ? '⌘' : 'Ctrl'} + mouse wheel over the editor changes it too`} keywords="font text size zoom">
          <Num id="set-fs" value={s.fontSize} min={9} max={32} onChange={(v) => up({ fontSize: v })} />
        </Row>
        <Row label="Editor font" htmlFor="set-ff" hint="A CSS font list; the first installed one is used" keywords="font family monospace jetbrains mono cascadia consolas">
          <input id="set-ff" className="input settings-text" style={{ width: 260 }} value={s.fontFamily} onChange={(e) => up({ fontFamily: e.target.value })} />
        </Row>
        <ToggleRow id="set-lig" label="Font ligatures" hint="=> != >= drawn as one glyph where the font supports it" keywords="ligatures font" checked={s.ligatures} onChange={(v) => up({ ligatures: v })} />
      </Card>
    </>
  );
}

export function EditorSection() {
  const s = useS();
  return (
    <>
      <Card title="Editing">
        <Row label="Tab size" htmlFor="set-tab" hint="Spaces per indent level" keywords="indent tabs">
          <Num id="set-tab" value={s.tabSize} min={1} max={8} onChange={(v) => up({ tabSize: v })} />
        </Row>
        <ToggleRow id="set-spaces" label="Indent with spaces" hint="Off: indent with tab characters" keywords="indent tabs spaces" checked={s.insertSpaces} onChange={(v) => up({ insertSpaces: v })} />
        <ToggleRow id="set-wrap" label="Wrap long lines" keywords="word wrap" checked={s.wordWrap} onChange={(v) => up({ wordWrap: v })} />
        <ToggleRow id="set-fmt" label="Reformat C# code on save" hint={`Same as Reformat Code (${keyLabel('Ctrl+Alt+L')})`} keywords="format save roslyn" checked={s.formatOnSave} onChange={(v) => up({ formatOnSave: v })} />
      </Card>
      <Card title="Display">
        <ToggleRow id="set-minimap" label="Show the minimap" keywords="minimap overview scrollbar" checked={s.minimap} onChange={(v) => up({ minimap: v })} />
        <ToggleRow id="set-blame" label="Show who changed the current line" hint="Author, time and commit message at the end of the caret line (like GitToolBox)" keywords="git blame inline annotate author gittoolbox" checked={s.inlineBlame} onChange={(v) => up({ inlineBlame: v })} />
        <ToggleRow id="set-sticky" label="Sticky scroll" hint="Keep the enclosing type and member visible at the top" keywords="sticky scroll header" checked={s.stickyScroll} onChange={(v) => up({ stickyScroll: v })} />
        <Row label="Show whitespace" htmlFor="set-ws" keywords="whitespace spaces tabs dots">
          <Select id="set-ws" value={s.renderWhitespace} options={[['none', 'Never'], ['selection', 'In the selection'], ['all', 'Always']]} onChange={(v) => up({ renderWhitespace: v })} />
        </Row>
      </Card>
    </>
  );
}

export function BuildSection() {
  const s = useS();
  return (
    <Card title="Build & run" description="How Kod drives the dotnet CLI.">
      <ToggleRow id="set-savebuild" label="Save all files before build, run and debug" keywords="save build run" checked={s.saveBeforeBuild} onChange={(v) => up({ saveBeforeBuild: v })} />
    </Card>
  );
}

interface AdapterDto {
  installed: boolean;
  path?: string;
  version?: string;
  downloadable: boolean;
}

export function DebuggerSection() {
  const [adapter, setAdapter] = useState<AdapterDto | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api.get<AdapterDto>('/debug/adapter').then(setAdapter, () => setAdapter(null));
  useEffect(load, []);
  return (
    <Card title="Debugger" description="Kod debugs .NET programs with netcoredbg, the open-source debugger from Samsung (MIT licence).">
      <Row label="netcoredbg" hint={adapter?.installed ? adapter.path : 'Not installed. Kod downloads it from github.com/Samsung/netcoredbg on first use.'} keywords="debugger netcoredbg breakpoints download install">
        {adapter?.installed ? (
          <span className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Bug size={14} /> {adapter.version ?? 'Installed'}
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || adapter?.downloadable === false}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/debug/adapter/install');
                toast('success', 'Debugger installed');
              } catch (e) {
                toast('error', 'Could not install the debugger', errorText(e));
              } finally {
                setBusy(false);
                load();
              }
            }}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />} Download debugger
          </button>
        )}
      </Row>
    </Card>
  );
}
