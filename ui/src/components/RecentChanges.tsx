// Recent Changes (Alt+Shift+C, Rider's): the latest Local History changes of the project at a glance; Enter or a
// click opens the change in the project history.
import { History, LoaderCircle, Tag } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { api } from '../api/client';
import { showChange, when, type HistoryChange } from '../editor/ProjectHistoryView';
import { basename, relative } from '../lib/paths';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';

export function RecentChanges() {
  const open = useUi((s) => s.recentChangesOpen);
  const root = useWorkspace((s) => s.ws.root);
  const [changes, setChanges] = useState<HistoryChange[] | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open || !root) return;
    setChanges(null);
    setIndex(0);
    void api.get<HistoryChange[]>('/history/changes', { path: root }).then(
      (list) => setChanges(list.slice(0, 60)),
      () => setChanges([]),
    );
  }, [open, root]);

  if (!open || !root) return null;
  const close = () => useUi.getState().set({ recentChangesOpen: false });
  const pick = (c: HistoryChange) => {
    close();
    showChange(root, c);
  };
  const items = changes ?? [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter' && items[index]) pick(items[index]);
    else return;
    e.preventDefault();
  };

  return (
    <Dialog
      title={
        <span className="recent-title">
          <History size={15} /> Recent Changes
        </span>
      }
      onClose={close}
      width={620}
    >
      <div className="recent-list" tabIndex={0} onKeyDown={onKey} ref={(el) => el?.focus()} role="listbox" aria-label="Recent changes">
        {!changes && (
          <div className="panel-empty">
            <LoaderCircle size={16} className="spin" />
          </div>
        )}
        {changes?.length === 0 && <div className="panel-empty">No changes yet: every save is kept in Local History.</div>}
        {items.map((c, i) => (
          <div
            key={`${c.kind}:${c.time}:${i}`}
            role="option"
            aria-selected={i === index}
            className={`recent-item${i === index ? ' selected' : ''}${c.kind === 'label' ? ' label' : ''}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => pick(c)}
          >
            {c.kind === 'label' && <Tag size={13} />}
            <span className="recent-label">{c.label}</span>
            <span className="recent-files muted">{c.kind === 'label' ? '' : c.files.length === 1 ? relative(root, c.files[0].path) : `${c.files.length} files: ${c.files.slice(0, 3).map((f) => basename(f.path)).join(', ')}${c.files.length > 3 ? '…' : ''}`}</span>
            <span className="recent-time muted">{when(c.time)}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
