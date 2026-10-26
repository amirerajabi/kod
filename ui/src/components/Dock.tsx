import { FolderTree, GitCommitHorizontal, ListTree, Search } from 'lucide-react';
import { useRef, useState } from 'react';
import { shortcutOf } from '../app/commands';
import { DOCK_MAX, DOCK_MIN, useUi, type DockPanel } from '../store/ui';
import { Splitter } from './common/Splitter';
import { CommitPanel } from './CommitPanel';
import { Explorer } from './Explorer';
import { SearchPanel } from './SearchPanel';
import { StructurePanel } from './StructurePanel';

const TABS: { id: DockPanel; label: string; Icon: typeof FolderTree; command: string }[] = [
  { id: 'explorer', label: 'Explorer', Icon: FolderTree, command: 'view.explorer' },
  { id: 'commit', label: 'Commit', Icon: GitCommitHorizontal, command: 'view.commit' },
  { id: 'structure', label: 'Structure', Icon: ListTree, command: 'view.structure' },
  { id: 'search', label: 'Search', Icon: Search, command: 'nav.findInFiles' },
];

/** Left dock: Explorer | Structure | Search | NuGet, tabbed and resizable (the Rowlit dock). */
export function Dock() {
  const visible = useUi((s) => s.dockVisible);
  const width = useUi((s) => s.dockWidth);
  // the NuGet panel moved to the tool windows: an old saved layout falls back to the explorer
  const dock = useUi((s) => (s.dock === 'nuget' ? 'explorer' : s.dock));
  const ref = useRef<HTMLElement>(null);
  const [start, setStart] = useState(width);
  if (!visible) return null;
  return (
    <>
      <aside ref={ref} className="dock" style={{ width: Math.max(DOCK_MIN, Math.min(DOCK_MAX, width)) }} aria-label="Side panel">
        <div className="dock-tabs" role="tablist">
          {TABS.map((t) => {
            const k = shortcutOf(t.command);
            return (
              <button key={t.id} role="tab" aria-selected={dock === t.id} className={`dock-tab${dock === t.id ? ' active' : ''}`} title={k ? `${t.label} (${k})` : t.label} onClick={() => useUi.getState().showDock(t.id)}>
                <t.Icon size={14} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
        <div className="dock-body" role="tabpanel">
          {dock === 'explorer' && <Explorer />}
          {dock === 'commit' && <CommitPanel />}
          {dock === 'structure' && <StructurePanel />}
          {dock === 'search' && <SearchPanel />}
        </div>
      </aside>
      <Splitter
        direction="vertical"
        onDragStart={() => setStart(ref.current?.offsetWidth ?? width)}
        onDrag={(d) => useUi.getState().setLayout({ dockWidth: Math.max(DOCK_MIN, Math.min(DOCK_MAX, start + d)) })}
        onDoubleClick={() => useUi.getState().setLayout({ dockWidth: 300 })}
      />
    </>
  );
}
