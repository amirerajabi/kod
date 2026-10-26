import { COMMANDS, keyLabel } from '../app/commands';
import { useUi } from '../store/ui';
import { Dialog } from './common/Dialog';

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
