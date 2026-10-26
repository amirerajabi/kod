import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../app/actions';
import { keyLabel } from '../app/commands';
import { CodeEditor } from '../editor/CodeEditor';
import { basename, dirname, norm, samePath } from '../lib/paths';
import { platform } from '../platform';
import { useEditors, type Tab } from '../store/editors';
import { useProblems } from '../store/problems';
import { useUi } from '../store/ui';
import { FileIcon } from './common/icons';
import { showContextMenu, type MenuItem } from './common/Menu';
import { revealInExplorer } from './Explorer';

export function EditorArea() {
  const tabs = useEditors((s) => s.tabs);
  return (
    <section className="workspace" aria-label="Editor">
      {tabs.length > 0 && <TabBar />}
      <CodeEditor />
      {tabs.length === 0 && <EditorEmpty />}
    </section>
  );
}

function TabBar() {
  const tabs = useEditors((s) => s.tabs);
  const active = useEditors((s) => s.active);
  const live = useProblems((s) => s.live);
  const [drag, setDrag] = useState<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);

  // keep the active tab visible
  useEffect(() => {
    const el = scroll.current?.querySelector('.tab.active') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  // two tabs with the same file name show their folder
  const dupes = new Set(tabs.map((t) => t.title).filter((t, i, a) => a.indexOf(t) !== i));

  const menuFor = (t: Tab, i: number): MenuItem[] => {
    const st = useEditors.getState();
    return [
      { label: 'Close', shortcut: keyLabel('Ctrl+F4'), run: () => void st.close(t.path) },
      { label: 'Close Others', disabled: tabs.length < 2, run: () => void st.closeMany(tabs.filter((x) => x !== t).map((x) => x.path)) },
      { label: 'Close Tabs to the Right', disabled: i === tabs.length - 1, run: () => void st.closeMany(tabs.slice(i + 1).map((x) => x.path)) },
      { label: 'Close All', run: () => void st.closeMany(tabs.map((x) => x.path)) },
      { label: 'Close Saved', run: () => void st.closeMany(tabs.filter((x) => !x.dirty).map((x) => x.path)) },
      'separator',
      ...(t.kind === 'file'
        ? ([
            { label: 'Keep Open', disabled: !t.preview, run: () => st.pin(t.path) },
            { label: 'Copy Path', run: () => void copyText(t.path) },
            { label: 'Select in Explorer', run: () => { useUi.getState().showDock('explorer'); void revealInExplorer(t.path); } },
            ...(platform.kind === 'electron' ? [{ label: 'Reveal in File Manager', run: () => platform.reveal(t.path) } as MenuItem] : []),
          ] as MenuItem[])
        : []),
    ];
  };

  return (
    <div className="tabbar" role="tablist" aria-label="Open files">
      <div className="tabbar-scroll" ref={scroll} onWheel={(e) => { if (scroll.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroll.current.scrollLeft += e.deltaY; }}>
        {tabs.map((t, i) => {
          const errors = (live[norm(t.path)] ?? []).some((d) => d.severity === 'error');
          const isActive = samePath(t.path, active) || t.path === active;
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={isActive}
              className={`tab${isActive ? ' active' : ''}${t.preview ? ' preview' : ''}${drag === i ? ' dragging' : ''}`}
              title={t.kind === 'file' ? t.path : t.title}
              draggable
              onDragStart={(e) => {
                setDrag(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (drag === null || drag === i) return;
                e.preventDefault();
                useEditors.getState().move(drag, i);
                setDrag(i);
              }}
              onDragEnd={() => setDrag(null)}
              onClick={() => useEditors.getState().activate(t.path)}
              onDoubleClick={() => useEditors.getState().pin(t.path)}
              onAuxClick={(e) => {
                if (e.button === 1) void useEditors.getState().close(t.path);
              }}
              onContextMenu={(e) => showContextMenu(e, menuFor(t, i))}
            >
              <FileIcon path={t.kind === 'metadata' ? 'x.cs' : t.path} size={14} />
              <span className="tab-title">{t.title}</span>
              {dupes.has(t.title) && t.kind === 'file' && <span className="tab-dir">{basename(dirname(t.path))}</span>}
              {errors && <span className="tab-errors" title="Has errors" />}
              <button
                className={`tab-close${t.dirty ? ' dirty' : ''}`}
                aria-label={`Close ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void useEditors.getState().close(t.path);
                }}
              >
                <span className="tab-dirty-dot" />
                <X />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EditorEmpty() {
  const rows: [string, string][] = [
    ['Search Everywhere', platform.os === 'darwin' ? '⇧ ⇧' : 'Double Shift'],
    ['Go to File', keyLabel('Ctrl+Shift+N')],
    ['Go to Symbol', keyLabel('Ctrl+N')],
    ['Find Action', keyLabel('Ctrl+Shift+A')],
    ['Build', keyLabel('Ctrl+Shift+B')],
    ['Run', 'Shift+F10'],
    ['Context actions', keyLabel('Alt+Enter')],
    ['Terminal', keyLabel('Alt+F12')],
  ];
  return (
    <div className="editor-empty">
      <div className="editor-empty-inner">
        {rows.map(([label, key]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span style={{ textAlign: 'right' }}>{label}</span>
            <span className="kbd-group k">
              {key.split(' ').map((k, i) => (
                <kbd key={i}>{k}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
