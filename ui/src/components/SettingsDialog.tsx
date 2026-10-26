import { COMMANDS, keyLabel } from '../app/commands';
import { DEFAULT_SETTINGS, useSettings, type Settings } from '../store/settings';
import { useUi } from '../store/ui';
import { Dialog } from './common/Dialog';

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const s = useSettings((x) => x.settings);
  if (!open) return null;
  const set = (p: Partial<Settings>) => useSettings.getState().update(p);
  const close = () => useUi.getState().set({ settingsOpen: false });
  const check = (k: keyof Settings, label: string) => (
    <>
      <span />
      <label className="check">
        <input type="checkbox" checked={s[k] as boolean} onChange={(e) => set({ [k]: e.target.checked } as Partial<Settings>)} /> {label}
      </label>
    </>
  );
  return (
    <Dialog
      title="Settings"
      onClose={close}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} onClick={() => set(DEFAULT_SETTINGS)}>
            Reset to defaults
          </button>
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="settings-grid">
        <div className="section-label" style={{ gridColumn: '1 / -1', padding: 0 }}>Appearance</div>
        <label className="form-label">Theme</label>
        <select className="input" value={s.theme} onChange={(e) => set({ theme: e.target.value as Settings['theme'] })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Follow the system</option>
        </select>

        <div className="section-label" style={{ gridColumn: '1 / -1', padding: '8px 0 0' }}>Editor</div>
        <label className="form-label">Font</label>
        <input className="input" value={s.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} />
        <label className="form-label">Font size</label>
        <input className="input" type="number" min={9} max={32} value={s.fontSize} onChange={(e) => set({ fontSize: Math.max(9, Math.min(32, Number(e.target.value) || 14)) })} />
        {check('ligatures', 'Font ligatures')}
        <label className="form-label">Tab size</label>
        <select className="input" value={s.tabSize} onChange={(e) => set({ tabSize: Number(e.target.value) })}>
          <option value={2}>2</option>
          <option value={4}>4</option>
          <option value={8}>8</option>
        </select>
        {check('insertSpaces', 'Indent with spaces')}
        {check('wordWrap', 'Wrap long lines')}
        {check('minimap', 'Show minimap')}
        {check('stickyScroll', 'Sticky scroll (keep the enclosing type and member visible)')}
        <label className="form-label">Show whitespace</label>
        <select className="input" value={s.renderWhitespace} onChange={(e) => set({ renderWhitespace: e.target.value as Settings['renderWhitespace'] })}>
          <option value="none">Never</option>
          <option value="selection">In the selection</option>
          <option value="all">Always</option>
        </select>

        <div className="section-label" style={{ gridColumn: '1 / -1', padding: '8px 0 0' }}>Files and build</div>
        <label className="form-label">Auto save</label>
        <select className="input" value={s.autoSave} onChange={(e) => set({ autoSave: e.target.value as Settings['autoSave'] })}>
          <option value="off">Off</option>
          <option value="afterDelay">After a short delay</option>
          <option value="onFocusChange">When the editor loses focus</option>
        </select>
        {check('formatOnSave', 'Reformat C# code on save')}
        {check('saveBeforeBuild', 'Save all files before build and run')}
        {check('previewTabs', 'Single click opens a preview tab')}
        {check('showIgnored', 'Show bin, obj and other build folders in the explorer')}
      </div>
    </Dialog>
  );
}

export function ShortcutSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  if (!open) return null;
  const groups = new Map<string, typeof COMMANDS>();
  for (const c of COMMANDS.filter((c) => c.keys?.length)) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category)!.push(c);
  }
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => useUi.getState().set({ shortcutsOpen: false })} width={760}>
      <div style={{ columns: '2 320px', columnGap: 24 }}>
        {[...groups.entries()].map(([cat, list]) => (
          <div key={cat} style={{ breakInside: 'avoid', marginBottom: 14 }}>
            <div className="section-label" style={{ padding: '0 0 4px' }}>{cat}</div>
            {list.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ flex: 1 }}>{c.title}</span>
                <span className="kbd-group">
                  {keyLabel(c.keys![0])
                    .split(' ')
                    .map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
