import { ChevronDown, ChevronRight, Copy, ExternalLink, Eye, EyeOff, FilePlus, FolderPlus, Hammer, ListCollapse, Package, Pencil, Play, RefreshCw, SquareTerminal, Star, TestTube2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api, errorText } from '../api/client';
import type { FsEntry } from '../api/types';
import { onEngineEvent } from '../api/ws';
import { copyText, createItem, deletePath, renamePath } from '../app/actions';
import { extname, isUnder, norm, relative, samePath } from '../lib/paths';
import { platform } from '../platform';
import { useEditors } from '../store/editors';
import { dotnetBuild, dotnetRun, dotnetTest, startTerminal } from '../store/procs';
import { useSettings } from '../store/settings';
import { toast, useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { changeKind, useGit } from '../store/git';
import { FileIcon } from './common/icons';
import { showContextMenu, type MenuItem } from './common/Menu';

interface ExplorerState {
  children: Record<string, FsEntry[] | undefined>;
  expanded: Record<string, boolean>;
  selected: string | null;
  load(dir: string): Promise<void>;
  toggle(dir: string, open?: boolean): void;
  select(path: string | null): void;
  reset(): void;
  collapseAll(): void;
}

export const useExplorer = create<ExplorerState>((set, get) => ({
  children: {},
  expanded: {},
  selected: null,
  load: async (dir) => {
    try {
      const list = await api.get<FsEntry[]>('/fs/list', { path: dir, showIgnored: useSettings.getState().settings.showIgnored });
      set((s) => ({ children: { ...s.children, [norm(dir)]: list } }));
    } catch (e) {
      set((s) => ({ children: { ...s.children, [norm(dir)]: [] } }));
      if (!/does not exist/.test(errorText(e))) toast('error', 'Cannot list folder', errorText(e));
    }
  },
  toggle: (dir, open) => {
    const key = norm(dir);
    const next = open ?? !get().expanded[key];
    set((s) => ({ expanded: { ...s.expanded, [key]: next } }));
    if (next && !get().children[key]) void get().load(dir);
  },
  select: (path) => set({ selected: path }),
  reset: () => set({ children: {}, expanded: {}, selected: null }),
  collapseAll: () => set({ expanded: {} }),
}));

/** Expands the folders down to a file and selects it (Alt+F1 "select in explorer", auto-reveal of the active tab). */
export async function revealInExplorer(path: string): Promise<void> {
  const root = useWorkspace.getState().ws.root;
  if (!root || !isUnder(path, root)) return;
  const segs = relative(root, path).split(/[\\/]/);
  let dir = root;
  const st = useExplorer.getState();
  for (const seg of segs.slice(0, -1)) {
    dir = `${dir}${dir.includes('\\') ? '\\' : '/'}${seg}`;
    if (!st.children[norm(dir)]) await st.load(dir);
    useExplorer.setState((s) => ({ expanded: { ...s.expanded, [norm(dir)]: true } }));
  }
  useExplorer.getState().select(path);
  requestAnimationFrame(() => document.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' }));
}

interface Row {
  entry: FsEntry;
  depth: number;
}

export function Explorer() {
  const root = useWorkspace((s) => s.ws.root);
  const projects = useWorkspace((s) => s.ws.projects);
  const startup = useWorkspace((s) => s.startup);
  const { children, expanded, selected } = useExplorer();
  const active = useEditors((s) => s.active);
  const dirty = useEditors(useShallow((s) => s.tabs.filter((t) => t.dirty).map((t) => norm(t.path))));
  const showIgnored = useSettings((s) => s.settings.showIgnored);
  const treeRef = useRef<HTMLDivElement>(null);
  const gitFiles = useGit((s) => s.status?.files);
  const gitClass = (p: string) => {
    const f = gitFiles?.find((g) => norm(g.path) === norm(p));
    return f ? ` git-${changeKind(f)}` : '';
  };

  useEffect(() => {
    useExplorer.getState().reset();
    if (root) {
      void useExplorer.getState().load(root);
      useExplorer.setState({ expanded: { [norm(root)]: true } });
    }
  }, [root, showIgnored]);

  // keep loaded folders in step with the disk
  useEffect(
    () =>
      onEngineEvent((e) => {
        if (e.type !== 'fs.changed') return;
        const st = useExplorer.getState();
        for (const d of e.dirs) if (st.children[norm(d)]) void st.load(d);
        if (e.dirs.length) useWorkspace.getState().invalidateFiles();
      }),
    [],
  );

  // follow the active editor
  useEffect(() => {
    if (active && !active.startsWith('kod-metadata:')) void revealInExplorer(active);
  }, [active]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (!root) return out;
    const walk = (dir: string, depth: number) => {
      for (const entry of children[norm(dir)] ?? []) {
        out.push({ entry, depth });
        if (entry.isDir && expanded[norm(entry.path)]) walk(entry.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [root, children, expanded]);

  if (!root) return <div className="panel-empty">No folder is open.</div>;

  const projectOfFile = (p: string) => projects.find((x) => samePath(x.path, p));

  const menuFor = (entry: FsEntry): MenuItem[] => {
    const dir = entry.isDir ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, '');
    const project = projectOfFile(entry.path);
    const items: MenuItem[] = [
      {
        label: 'New',
        icon: <FilePlus size={14} />,
        submenu: [
          { label: 'Class…', run: () => void createItem(dir, 'class') },
          { label: 'Interface…', run: () => void createItem(dir, 'interface') },
          { label: 'Record…', run: () => void createItem(dir, 'record') },
          { label: 'Enum…', run: () => void createItem(dir, 'enum') },
          { label: 'Struct…', run: () => void createItem(dir, 'struct') },
          'separator',
          { label: 'File…', run: () => void createItem(dir, 'file') },
          { label: 'Folder…', icon: <FolderPlus size={14} />, run: () => void createItem(dir, 'folder') },
        ],
      },
    ];
    if (project) {
      items.push(
        'separator',
        ...(project.runnable ? [{ label: `Run ${project.name}`, icon: <Play size={14} />, run: () => void dotnetRun(project.path) } as MenuItem] : []),
        { label: `Build ${project.name}`, icon: <Hammer size={14} />, run: () => void dotnetBuild('build', project.path) },
        ...(project.kind === 'test' ? [{ label: 'Run Tests', icon: <TestTube2 size={14} />, run: () => void dotnetTest(project.path) } as MenuItem] : []),
        ...(project.runnable ? [{ label: 'Set as Run Configuration', icon: <Star size={14} />, checked: samePath(startup, project.path), run: () => useWorkspace.getState().setStartup(project.path) } as MenuItem] : []),
        { label: 'Manage NuGet Packages', icon: <Package size={14} />, run: () => useUi.getState().showBottom('nuget') },
      );
    }
    items.push(
      'separator',
      { label: 'Rename…', icon: <Pencil size={14} />, shortcut: 'F2', run: () => void renamePath(entry.path, entry.isDir) },
      { label: 'Delete', icon: <Trash2 size={14} />, shortcut: 'Delete', danger: true, run: () => void deletePath(entry.path, entry.isDir) },
      'separator',
      { label: 'Copy Path', icon: <Copy size={14} />, run: () => void copyText(entry.path) },
      { label: 'Copy Relative Path', run: () => void copyText(relative(root, entry.path)) },
      ...(platform.kind === 'electron' ? [{ label: platform.os === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer', icon: <ExternalLink size={14} />, run: () => platform.reveal(entry.path) } as MenuItem] : []),
      { label: 'Open in Terminal', icon: <SquareTerminal size={14} />, run: () => void startTerminal(dir) },
    );
    return items;
  };

  const activate = (entry: FsEntry, pin: boolean) => {
    useExplorer.getState().select(entry.path);
    if (entry.isDir) useExplorer.getState().toggle(entry.path);
    else void useEditors.getState().open(entry.path, { preview: !pin });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => samePath(r.entry.path, selected));
    const row = rows[i];
    const go = (k: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, k))];
      if (r) {
        useExplorer.getState().select(r.entry.path);
        document.querySelector(`[data-path="${CSS.escape(r.entry.path)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'ArrowRight' && row?.entry.isDir) useExplorer.getState().toggle(row.entry.path, true);
    else if (e.key === 'ArrowLeft' && row) {
      if (row.entry.isDir && expanded[norm(row.entry.path)]) useExplorer.getState().toggle(row.entry.path, false);
      else go(rows.findLastIndex((r, k) => k < i && r.depth < row.depth));
    } else if (e.key === 'Enter' && row) activate(row.entry, true);
    else if (e.key === 'F2' && row) void renamePath(row.entry.path, row.entry.isDir);
    else if (e.key === 'Delete' && row) void deletePath(row.entry.path, row.entry.isDir);
    else return;
    e.preventDefault();
  };

  return (
    <div className="dock-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-header">
        <span className="panel-title">{relative(undefined, root).split(/[\\/]/).pop()}</span>
        <button className="icon-btn sm" title="New C# class" onClick={() => void createItem(selectedDir(selected, rows, root), 'class')}>
          <FilePlus size={15} />
        </button>
        <button className="icon-btn sm" title="New folder" onClick={() => void createItem(selectedDir(selected, rows, root), 'folder')}>
          <FolderPlus size={15} />
        </button>
        <button
          className={`icon-btn sm${showIgnored ? ' on' : ''}`}
          title={showIgnored ? 'Show All Files: on (bin, obj, .git, .vs, node_modules are shown)' : 'Show All Files (also bin, obj, .git, .vs, node_modules)'}
          aria-pressed={showIgnored}
          onClick={() => useSettings.getState().update({ showIgnored: !showIgnored })}
        >
          {showIgnored ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button className="icon-btn sm" title="Refresh" onClick={() => Object.keys(useExplorer.getState().children).forEach((d) => void useExplorer.getState().load(d))}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" title="Collapse all" onClick={() => useExplorer.setState({ expanded: { [norm(root)]: true } })}>
          <ListCollapse size={15} />
        </button>
      </div>
      <div className="panel-body tree" ref={treeRef} tabIndex={0} onKeyDown={onKeyDown} role="tree" aria-label="Files" onContextMenu={(e) => showContextMenu(e, menuFor({ name: '', path: root, isDir: true, size: 0 }))}>
        {rows.map(({ entry, depth }) => {
          const open = entry.isDir && !!expanded[norm(entry.path)];
          const project = projectOfFile(entry.path);
          const ext = extname(entry.path);
          return (
            <div
              key={entry.path}
              data-path={entry.path}
              role="treeitem"
              aria-expanded={entry.isDir ? open : undefined}
              aria-selected={samePath(selected, entry.path)}
              className={`tree-row${samePath(selected, entry.path) ? ' selected' : ''}${showIgnored && isExcluded(root, entry.path) ? ' excluded' : ''}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => activate(entry, false)}
              onDoubleClick={() => !entry.isDir && activate(entry, true)}
              onContextMenu={(e) => {
                useExplorer.getState().select(entry.path);
                showContextMenu(e, menuFor(entry));
              }}
              title={entry.path}
            >
              <span className="tree-chevron">{entry.isDir ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</span>
              <FileIcon path={entry.path} isDir={entry.isDir} open={open} />
              <span className={`tree-label${dirty.includes(norm(entry.path)) ? ' dirty' : ''}${gitClass(entry.path)}`} style={project && samePath(project.path, startup) ? { fontWeight: 600 } : undefined}>
                {entry.name}
              </span>
              {project && <span className="tree-hint">{project.kind}</span>}
              {(ext === '.sln' || ext === '.slnx') && <span className="tree-hint">solution</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Folders Show All Files reveals (the engine's PathUtil.IgnoredDirs); they and everything under them are dimmed. */
const IGNORED = new Set(['bin', 'obj', '.git', '.vs', '.idea', 'node_modules', '.vscode', 'packages', 'testresults', '.kod']);
const isExcluded = (root: string, path: string) => relative(root, path).split(/[\\/]/).some((seg) => IGNORED.has(seg.toLowerCase()));

function selectedDir(selected: string | null, rows: Row[], root: string): string {
  const row = rows.find((r) => samePath(r.entry.path, selected));
  if (!row) return root;
  return row.entry.isDir ? row.entry.path : row.entry.path.replace(/[\\/][^\\/]+$/, '');
}
