import { Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { insertAsIs } from '../editor/clipboard';
import { useClipboard, type ClipEntry } from '../store/clipboard';
import { Dialog } from './common/Dialog';
import './run.css';

const firstLine = (t: string) => t.trim().split(/\r?\n/)[0] ?? '';
const lineCount = (t: string) => t.split(/\r?\n/).length;

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/** Paste from History (Ctrl+Shift+V): earlier copies, newest first; type to filter, Enter pastes, Delete forgets. */
export function PasteHistoryDialog() {
  const open = useClipboard((s) => s.open);
  return open ? <PasteHistory /> : null;
}

function PasteHistory() {
  const items = useClipboard((s) => s.items);
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return f ? items.filter((i) => i.text.toLowerCase().includes(f)) : items;
  }, [items, filter]);
  const cur: ClipEntry | undefined = shown[Math.min(index, shown.length - 1)];
  const close = () => useClipboard.setState({ open: false });
  const paste = (e: ClipEntry | undefined) => {
    if (!e) return;
    close();
    // after the dialog hands focus back to the editor
    setTimeout(() => insertAsIs(e.text), 0);
  };

  useEffect(() => {
    listRef.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [index, shown]);

  return (
    <Dialog
      title="Paste from History"
      onClose={close}
      width={720}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} disabled={items.length === 0} onClick={() => useClipboard.getState().clear()}>
            Clear History
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!cur} onClick={() => paste(cur)}>
            Paste
          </button>
        </>
      }
    >
      <input
        className="input"
        style={{ width: '100%' }}
        value={filter}
        placeholder="Filter (Enter pastes, Delete removes the entry)"
        autoFocus
        onChange={(e) => {
          setFilter(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex((i) => Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            paste(cur);
          } else if (e.key === 'Delete' && cur && !filter) {
            e.preventDefault();
            useClipboard.getState().remove(cur.at);
          }
        }}
        spellCheck={false}
      />
      <div ref={listRef} className="result-list paste-list">
        {shown.length === 0 && <div className="panel-empty" style={{ padding: 12 }}>{items.length ? 'Nothing matches' : 'Copy something first: every copy and cut in Kod is kept here'}</div>}
        {shown.map((e, i) => (
          <div key={e.at} className={`result-item${e === cur ? ' selected' : ''}`} onClick={() => setIndex(i)} onDoubleClick={() => paste(e)}>
            <span className="msg mono-text">{firstLine(e.text) || '(whitespace)'}</span>
            {lineCount(e.text) > 1 && <span className="loc">{lineCount(e.text)} lines</span>}
            <span className="loc">{ago(e.at)}</span>
            <button
              className="icon-btn sm"
              title="Remove from the history"
              onClick={(ev) => {
                ev.stopPropagation();
                useClipboard.getState().remove(e.at);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <pre className="paste-preview">{cur?.text ?? ''}</pre>
    </Dialog>
  );
}
