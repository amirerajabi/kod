import { Bug, Download, Keyboard, LoaderCircle, MemoryStick, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../../api/client';
import { keyLabel } from '../../app/commands';
import { isMac } from '../../platform';
import { useMemory } from '../../store/memory';
import { DEFAULT_SETTINGS, useSettings } from '../../store/settings';
import { toast, useUi } from '../../store/ui';
import { Card, FontPicker, Num, Row, Segmented, Select, ToggleRow } from './controls';
import { AppThemePicker, CodeThemePicker } from './ThemePicker';

const useS = () => useSettings((x) => x.prefs);
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
          <Select
            id="set-autosave"
            value={s.autoSave}
            options={[
              ['rider', 'Like Rider (recommended)'],
              ['afterDelay', 'A second after every change'],
              ['onFocusChange', 'When the editor loses focus'],
              ['off', 'Off: save with Ctrl+S'],
            ]}
            onChange={(v) => up({ autoSave: v })}
          />
        </Row>
        {s.autoSave === 'rider' && (
          <Row label="Save after a quiet moment of" htmlFor="set-autosave-idle" hint="Also saved when Kod loses focus, when you switch or close a tab, before build, run, test and Git, and when Kod quits. Local History keeps every version." keywords="auto save idle seconds rider frame deactivation">
            <Select<number> id="set-autosave-idle" value={s.autoSaveIdleSeconds} options={[[3, '3 seconds'], [5, '5 seconds'], [15, '15 seconds'], [30, '30 seconds'], [60, '1 minute']]} onChange={(v) => up({ autoSaveIdleSeconds: v })} />
          </Row>
        )}
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
      <Card title="Fonts" description="Pick an installed font or type a CSS font list.">
        <Row label="Editor font" htmlFor="set-ff" hint="Code editor, diffs and output" keywords="font family monospace jetbrains mono cascadia consolas fira code editor">
          <FontPicker id="set-ff" kind="mono" value={s.fontFamily} onChange={(v) => up({ fontFamily: v || DEFAULT_SETTINGS.fontFamily })} />
        </Row>
        <Row label="Editor font size" htmlFor="set-fs" hint={`${isMac ? '⌘' : 'Ctrl'} + mouse wheel over the editor changes it too`} keywords="font text size zoom">
          <Num id="set-fs" value={s.fontSize} min={9} max={32} onChange={(v) => up({ fontSize: v })} />
        </Row>
        <ToggleRow id="set-lig" label="Font ligatures" hint="=> != >= drawn as one glyph where the font supports it" keywords="ligatures font" checked={s.ligatures} onChange={(v) => up({ ligatures: v })} />
        <Row label="UI font" htmlFor="set-uif" hint="Menus, panels, dialogs and tool windows; empty = the system font" keywords="font family interface ui window menu segoe inter">
          <FontPicker id="set-uif" kind="ui" value={s.uiFontFamily} placeholder="System default" onChange={(v) => up({ uiFontFamily: v })} />
        </Row>
        <Row label="UI font size" htmlFor="set-uis" keywords="font size interface ui window zoom">
          <Num id="set-uis" value={s.uiFontSize} min={10} max={20} onChange={(v) => up({ uiFontSize: v })} />
        </Row>
        <Row label="Terminal font" htmlFor="set-tf" hint="Empty = the editor font" keywords="font family terminal console shell">
          <FontPicker id="set-tf" kind="mono" value={s.terminalFontFamily} placeholder="Same as the editor" onChange={(v) => up({ terminalFontFamily: v })} />
        </Row>
        <Row label="Terminal font size" htmlFor="set-tfs" hint="0 = one smaller than the editor" keywords="font size terminal console">
          <Num id="set-tfs" value={s.terminalFontSize} min={0} max={32} onChange={(v) => up({ terminalFontSize: v })} />
        </Row>
        <Row label="Reset fonts" keywords="font reset default">
          <button type="button" className="btn" onClick={() => up({ fontFamily: DEFAULT_SETTINGS.fontFamily, fontSize: DEFAULT_SETTINGS.fontSize, uiFontFamily: '', uiFontSize: DEFAULT_SETTINGS.uiFontSize, terminalFontFamily: '', terminalFontSize: 0 })}>
            Restore defaults
          </button>
        </Row>
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
      <Card title="Code insight">
        <ToggleRow id="set-inlay" label="Inlay hints" hint="Parameter names before literal arguments and the inferred types of var and lambda parameters" keywords="inlay hints parameter names types var" checked={s.inlayHints} onChange={(v) => up({ inlayHints: v })} />
        <ToggleRow id="set-vision" label="Code Vision" hint="Usages, implementations and overrides above types and members" keywords="code vision lens usages implementations inheritors" checked={s.codeVision} onChange={(v) => up({ codeVision: v })} />
        <ToggleRow id="set-inspect" label="Code inspections while typing" hint="Roslyn's IDE analyzers and your projects' analyzers (suggestions, unused code, style), not only compiler errors" keywords="inspections analyzers suggestions warnings ide unused" checked={s.inspections} onChange={(v) => up({ inspections: v })} />
      </Card>
    </>
  );
}

const LIMITS: [number, string][] = [
  [0, 'Automatic (a quarter of the RAM)'],
  [1024, '1 GB'],
  [1536, '1.5 GB'],
  [2048, '2 GB'],
  [3072, '3 GB'],
  [4096, '4 GB'],
  [6144, '6 GB'],
  [8192, '8 GB'],
  [12288, '12 GB'],
];

export function MemorySection() {
  const s = useS();
  return (
    <>
      <Card title="Power Save Mode" description="Like Rider's: Kod stops the background work that costs memory and battery while you type.">
        <ToggleRow
          id="set-powersave"
          label="Power Save Mode"
          hint="No inlay hints, Code Vision, inspections, inline blame, minimap or automatic completion popup (Ctrl+Space still completes)"
          keywords="power save battery performance fast slow laptop"
          checked={s.powerSave}
          onChange={(v) => up({ powerSave: v })}
        />
      </Card>
      <Card title="Memory" description="The code engine (Roslyn) holds your solution's compilations; Kod keeps it within a limit and gives memory back when it can.">
        <ToggleRow id="set-memind" label="Show the memory indicator in the status bar" hint="Click it for the breakdown, Free Memory and unloading projects" keywords="memory indicator status bar ram heap" checked={s.memoryIndicator} onChange={(v) => up({ memoryIndicator: v })} />
        <Row label="Engine memory limit" htmlFor="set-memlimit" hint="Above it the engine drops its caches and compilations (rebuilt when needed), then warns you" keywords="memory limit heap xmx ram engine roslyn">
          <Select id="set-memlimit" value={LIMITS.some(([v]) => v === s.engineMemoryLimitMb) ? s.engineMemoryLimitMb : 0} options={LIMITS} onChange={(v) => up({ engineMemoryLimitMb: v })} />
        </Row>
        <ToggleRow id="set-idletrim" label="Give memory back when idle" hint="After a minute without typing, or with the window hidden, Kod compacts its memory and returns what it freed to the system" keywords="idle trim free memory release background minimize" checked={s.idleTrim} onChange={(v) => up({ idleTrim: v })} />
        <ToggleRow id="set-memwarn" label="Warn when memory runs low" hint="When the engine stays above its limit, suggest unloading projects" keywords="low memory warning notification" checked={s.memoryWarnings} onChange={(v) => up({ memoryWarnings: v })} />
        <Row label="Finished outputs to keep" htmlFor="set-keepprocs" hint="Per tool window (Build, Run); older finished ones close themselves" keywords="build run output history processes keep">
          <Num id="set-keepprocs" value={s.keepFinishedProcesses} min={1} max={50} onChange={(v) => up({ keepFinishedProcesses: v })} />
        </Row>
        <Row label="Memory details" hint="What Kod uses and where, Free Memory, and loading or unloading projects" keywords="memory usage details free unload projects">
          <button type="button" className="btn" onClick={() => { useUi.getState().set({ settingsOpen: false }); useMemory.setState({ dialogOpen: true }); }}>
            <MemoryStick size={16} /> Show memory…
          </button>
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
