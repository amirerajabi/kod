import { useRef, useState } from 'react';
import { DOCK_MAX, DOCK_MIN, useUi } from '../store/ui';
import { Splitter } from './common/Splitter';
import { CommitPanel } from './CommitPanel';
import { DatabasePanel } from './DatabasePanel';
import { Explorer } from './Explorer';
import { SearchPanel } from './SearchPanel';
import { StructurePanel } from './StructurePanel';

/** The side panel: the left tool window open on the stripe (Explorer, Commit, Structure, Find in Files, Database), resizable. */
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
        <div className="dock-body">
          {dock === 'explorer' && <Explorer />}
          {dock === 'commit' && <CommitPanel />}
          {dock === 'structure' && <StructurePanel />}
          {dock === 'search' && <SearchPanel />}
          {dock === 'database' && <DatabasePanel />}
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
