// Rider's Find window for Find Usages (Alt+F7): the usages in a tree grouped by usage type, project, folder, file and
// member (each grouping can be switched off), read/write filters, a preview, Previous/Next Occurrence
// (Ctrl+Alt+Up/Down) and pinned tabs that keep a search while new ones open next to it.
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  FileCode,
  LoaderCircle,
  PenLine,
  Pin,
  RotateCw,
  Search,
  SquareFunction,
  Tags,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { UsageDto } from '../api/types';
import { keyLabel } from '../app/commands';
import { basename, dirname, relative } from '../lib/paths';
import { useEditors } from '../store/editors';
import { closeTab, isRead, isWrite, KIND_LABEL, KIND_ORDER, pinSearch, rerunPinned, searchUsages, useUsages, type UsageKind } from '../store/usages';
import { useWorkspace } from '../store/workspace';
import { FileIcon } from './common/icons';
import { Splitter } from './common/Splitter';
import { UsageKindIcon, UsageLine, UsagePreview } from './UsagesPopup';

type GroupBy = 'kind' | 'project' | 'folder' | 'file' | 'member';
const GROUP_ORDER: GroupBy[] = ['kind', 'project', 'folder', 'file', 'member'];

const OPTIONS_KEY = 'kod.usages.view';
interface ViewOptions {
  group: Record<GroupBy, boolean>;
  reads: boolean;
  writes: boolean;
  preview: boolean;
}
const DEFAULTS: ViewOptions = { group: { kind: true, project: true, folder: false, file: true, member: false }, reads: true, writes: true, preview: false };

function loadOptions(): ViewOptions {
  try {
    const v = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null') as Partial<ViewOptions> | null;
    return v ? { ...DEFAULTS, ...v, group: { ...DEFAULTS.group, ...v.group } } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

interface Group {
  key: string;
  by: GroupBy;
  label: string;
  path?: string;
  kind?: UsageKind;
  groups: Group[];
  usages: UsageDto[];
  count: number;
}

function labelOf(by: GroupBy, u: UsageDto, root: string | undefined): string {
  switch (by) {
    case 'kind':
      return KIND_LABEL[u.kind];
    case 'project':
      return u.project;
    case 'folder':
      return relative(root, dirname(u.path)) || basename(dirname(u.path));
    case 'file':
      return basename(u.path);
    case 'member':
      return u.container ?? '(top level)';
  }
}

/** Nests the usages by each grouping in turn; usage types keep Rider's order, the rest go alphabetically. */
function build(usages: UsageDto[], levels: GroupBy[], root: string | undefined, prefix = ''): Group[] {
  if (!levels.length) return [];
  const [by, ...rest] = levels;
  const map = new Map<string, UsageDto[]>();
  for (const u of usages) {
    const k = by === 'file' || by === 'folder' ? (by === 'file' ? u.path : dirname(u.path)).toLowerCase() : labelOf(by, u, root);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(u);
  }
  const groups = [...map.entries()].map(([k, list]): Group => {
    const key = `${prefix}/${by}:${k}`;
    return {
      key,
      by,
      label: labelOf(by, list[0], root),
      path: by === 'file' ? list[0].path : by === 'folder' ? dirname(list[0].path) : undefined,
      kind: by === 'kind' ? list[0].kind : undefined,
      groups: build(list, rest, root, key),
      usages: rest.length ? [] : list,
      count: list.length,
    };
  });
  return by === 'kind' ? groups.sort((a, b) => KIND_ORDER.indexOf(a.kind!) - KIND_ORDER.indexOf(b.kind!)) : groups.sort((a, b) => a.label.localeCompare(b.label));
}

type Row = { type: 'group'; g: Group; depth: number } | { type: 'usage'; u: UsageDto; depth: number };

function GroupIcon({ g }: { g: Group }) {
  if (g.by === 'kind') return <UsageKindIcon kind={g.kind!} />;
  if (g.by === 'project') return <Boxes size={13} className="muted" />;
  if (g.by === 'folder') return <Folder size={13} className="muted" />;
  if (g.by === 'file') return <FileIcon path={g.path!} size={14} />;
  return <SquareFunction size={13} className="muted" />;
}

const GROUP_BUTTONS: { by: GroupBy; title: string; Icon: typeof Tags }[] = [
  { by: 'kind', title: 'Group by usage type', Icon: Tags },
  { by: 'project', title: 'Group by project', Icon: Boxes },
  { by: 'folder', title: 'Group by directory', Icon: Folder },
  { by: 'file', title: 'Group by file', Icon: FileCode },
  { by: 'member', title: 'Group by member', Icon: SquareFunction },
];

export function UsagesPanel() {
  const state = useUsages();
  const root = useWorkspace((s) => s.ws.root);
  const [opts, setOpts] = useState<ViewOptions>(loadOptions);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState(420);
  const dragFrom = useRef(420);
  const listRef = useRef<HTMLDivElement>(null);

  const pinnedTab = state.tab !== null ? state.pinned[state.tab] : undefined;
  const view = pinnedTab ?? { symbol: state.symbol, symbolKind: state.symbolKind, items: state.items, request: state.request };
  const loading = !pinnedTab && state.loading;
  const hasLatest = !!state.request;

  const update = (change: (o: ViewOptions) => ViewOptions) =>
    setOpts((o) => {
      const next = change(o);
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        /* private mode: the defaults next time */
      }
      return next;
    });

  const shown = useMemo(
    () =>
      view.items.filter((u) => {
        if (!opts.reads && u.kind === 'read') return false;
        if (!opts.writes && isWrite(u.kind) && !(opts.reads && isRead(u.kind))) return false;
        return true;
      }),
    [view.items, opts.reads, opts.writes],
  );
  const tree = useMemo(() => build(shown, GROUP_ORDER.filter((g) => opts.group[g]), root), [shown, opts.group, root]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (gs: Group[], depth: number) => {
      for (const g of gs) {
        out.push({ type: 'group', g, depth });
        if (collapsed.has(g.key)) continue;
        walk(g.groups, depth + 1);
        for (const u of g.usages) out.push({ type: 'usage', u, depth: depth + 1 });
      }
    };
    walk(tree, 0);
    if (!tree.length) for (const u of shown) out.push({ type: 'usage', u, depth: 0 });
    return out;
  }, [tree, collapsed, shown]);

  const keyOf = (r: Row) => (r.type === 'group' ? r.g.key : `${r.u.path}:${r.u.range.startLine}:${r.u.range.startColumn}`);
  const selIndex = rows.findIndex((r) => keyOf(r) === sel);
  const selRow = selIndex >= 0 ? rows[selIndex] : undefined;
  const selUsage = selRow?.type === 'usage' ? selRow.u : undefined;

  useEffect(() => {
    setCollapsed(new Set());
    setSel(null);
  }, [view.items]);
  useEffect(() => {
    listRef.current?.querySelector('.usage-tree-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const open = (u: UsageDto, focus = false) => void useEditors.getState().open(u.path, { range: u.range, preview: !focus });
  const toggle = (key: string, to?: boolean) => {
    const next = new Set(collapsed);
    if (to ?? !next.has(key)) next.add(key);
    else next.delete(key);
    setCollapsed(next);
  };
  const allGroups = (gs: Group[]): string[] => gs.flatMap((g) => [g.key, ...allGroups(g.groups)]);

  /** Previous / Next Occurrence: the usage before or after the selection, opened in the editor. */
  const step = (d: 1 | -1) => {
    const usages = rows.filter((r): r is Extract<Row, { type: 'usage' }> => r.type === 'usage');
    if (!usages.length) {
      setCollapsed(new Set());
      return;
    }
    const from = selIndex;
    let next = d === 1 ? usages.find((r) => rows.indexOf(r) > from) : [...usages].reverse().find((r) => rows.indexOf(r) < from);
    next ??= d === 1 ? usages[0] : usages[usages.length - 1];
    setSel(keyOf(next));
    open(next.u);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = selRow;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.ctrlKey && e.altKey) step(e.key === 'ArrowDown' ? 1 : -1);
      else {
        const i = Math.max(0, Math.min(rows.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
        if (rows[i]) setSel(keyOf(rows[i]));
      }
    } else if (e.key === 'ArrowRight' && r?.type === 'group') toggle(r.g.key, false);
    else if (e.key === 'ArrowLeft' && r?.type === 'group' && !collapsed.has(r.g.key)) toggle(r.g.key, true);
    else if (e.key === 'Enter' && r?.type === 'usage') open(r.u, true);
    else if (e.key === 'Enter' && r?.type === 'group') toggle(r.g.key);
    else if (e.key === 'F4' && r?.type === 'usage') open(r.u, true);
    else return;
    e.preventDefault();
  };

  const total = view.items.filter((u) => u.kind !== 'declaration').length;
  const files = new Set(view.items.filter((u) => u.kind !== 'declaration').map((u) => u.path.toLowerCase())).size;

  const tabs: ReactNode =
    state.pinned.length > 0 ? (
      <div className="usage-tabs" role="tablist">
        {state.pinned.map((t, i) => (
          <div key={i} role="tab" aria-selected={state.tab === i} className={`usage-tab${state.tab === i ? ' active' : ''}`} onClick={() => state.set({ tab: i })}>
            <Pin size={11} /> {t.symbol}
            <button
              className="icon-btn usage-tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(i);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        {hasLatest && (
          <div role="tab" aria-selected={state.tab === null} className={`usage-tab${state.tab === null ? ' active' : ''}`} onClick={() => state.set({ tab: null })}>
            {state.symbol}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="usages-window">
      <div className="usages-side-toolbar" role="toolbar" aria-label="Find window" aria-orientation="vertical">
        <button
          className="icon-btn sm"
          title="Rerun"
          disabled={!view.request || loading}
          onClick={() => (state.tab !== null ? void rerunPinned(state.tab) : view.request && void searchUsages({ ...view.request, text: undefined }))}
        >
          <RotateCw size={13} />
        </button>
        <button className="icon-btn sm" title={`Pin tab: keep these results and open the next search in a new tab`} disabled={state.tab !== null || !hasLatest || loading} onClick={pinSearch}>
          <Pin size={13} />
        </button>
        <div className="usages-side-sep" />
        <button className="icon-btn sm" title="Expand all" onClick={() => setCollapsed(new Set())}>
          <ChevronsUpDown size={13} />
        </button>
        <button className="icon-btn sm" title="Collapse all" onClick={() => setCollapsed(new Set(allGroups(tree)))}>
          <ChevronsDownUp size={13} />
        </button>
        <button className="icon-btn sm" title={`Previous occurrence (${keyLabel('Ctrl+Alt+Up')})`} onClick={() => step(-1)} disabled={!shown.length}>
          <ArrowUp size={13} />
        </button>
        <button className="icon-btn sm" title={`Next occurrence (${keyLabel('Ctrl+Alt+Down')})`} onClick={() => step(1)} disabled={!shown.length}>
          <ArrowDown size={13} />
        </button>
        <div className="usages-side-sep" />
        {GROUP_BUTTONS.map(({ by, title, Icon }) => (
          <button key={by} className={`icon-btn sm${opts.group[by] ? ' on' : ''}`} title={title} aria-pressed={opts.group[by]} onClick={() => update((o) => ({ ...o, group: { ...o.group, [by]: !o.group[by] } }))}>
            <Icon size={13} />
          </button>
        ))}
        <div className="usages-side-sep" />
        <button className={`icon-btn sm${opts.reads ? ' on' : ''}`} title="Show read access" aria-pressed={opts.reads} onClick={() => update((o) => ({ ...o, reads: !o.reads }))}>
          <BookOpen size={13} />
        </button>
        <button className={`icon-btn sm${opts.writes ? ' on' : ''}`} title="Show write access" aria-pressed={opts.writes} onClick={() => update((o) => ({ ...o, writes: !o.writes }))}>
          <PenLine size={13} />
        </button>
        <button className={`icon-btn sm${opts.preview ? ' on' : ''}`} title="Preview source" aria-pressed={opts.preview} onClick={() => update((o) => ({ ...o, preview: !o.preview }))}>
          <AppWindow size={13} />
        </button>
      </div>
      <div className="usages-main">
        {tabs}
        {!view.request && !pinnedTab && !loading && !state.error ? (
          <div className="panel-empty">
            <Search size={18} />
            <div>
              Put the caret on a symbol and press <kbd>{keyLabel('Alt+F7')}</kbd> to find its usages, or <kbd>{keyLabel('Ctrl+Alt+F7')}</kbd> to show them in a popup.
            </div>
          </div>
        ) : (
          <div className="usages-body">
            <div className="usage-tree" ref={listRef} tabIndex={0} onKeyDown={onKey} role="tree" aria-label={`Usages of ${view.symbol}`}>
              <div className="usage-tree-root">
                <Search size={13} className="muted" /> Usages of <b>{view.symbol}</b>
                {view.symbolKind && <span className="muted">{view.symbolKind}</span>}
                <span className="muted">
                  {loading ? (
                    <>
                      <LoaderCircle size={12} className="spin" /> searching…
                    </>
                  ) : (
                    `${total} ${total === 1 ? 'usage' : 'usages'} in ${files} ${files === 1 ? 'file' : 'files'}${shown.length < view.items.length ? ` · ${view.items.length - shown.length} hidden by filters` : ''}`
                  )}
                </span>
              </div>
              {!pinnedTab && state.error && <div className="panel-empty">{state.error}</div>}
              {!loading && !state.error && view.items.length === 0 && <div className="panel-empty">No usages of {view.symbol} in the solution.</div>}
              {rows.slice(0, 3000).map((r) => {
                const key = keyOf(r);
                const selected = key === sel;
                const pad = { paddingLeft: 8 + r.depth * 16 };
                if (r.type === 'group') {
                  const isCollapsed = collapsed.has(r.g.key);
                  return (
                    <div
                      key={key}
                      role="treeitem"
                      aria-expanded={!isCollapsed}
                      aria-selected={selected}
                      className={`usage-tree-row group${selected ? ' selected' : ''}`}
                      style={pad}
                      title={r.g.path}
                      onClick={() => {
                        setSel(key);
                        toggle(r.g.key);
                      }}
                    >
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <GroupIcon g={r.g} />
                      <span className="usage-group-label">{r.g.label}</span>
                      <span className="muted">
                        {r.g.count} {r.g.count === 1 ? 'usage' : 'usages'}
                      </span>
                    </div>
                  );
                }
                const u = r.u;
                return (
                  <div
                    key={key}
                    role="treeitem"
                    aria-selected={selected}
                    className={`usage-tree-row${selected ? ' selected' : ''}`}
                    style={{ paddingLeft: 8 + r.depth * 16 + 13 }}
                    title={`${KIND_LABEL[u.kind]} · ${u.path}:${u.range.startLine}`}
                    onClick={() => {
                      setSel(key);
                      open(u);
                    }}
                    onDoubleClick={() => open(u, true)}
                  >
                    {!opts.group.kind && <UsageKindIcon kind={u.kind} />}
                    {!opts.group.file && <span className="usage-file muted">{basename(u.path)}</span>}
                    <span className="usage-pos">
                      ({u.range.startLine}, {u.range.startColumn})
                    </span>
                    <span className="usage-code">
                      <UsageLine u={u} />
                    </span>
                    {!opts.group.member && u.container && <span className="usage-container muted">{u.container}</span>}
                  </div>
                );
              })}
            </div>
            {opts.preview && (
              <Fragment>
                <Splitter direction="vertical" onDragStart={() => (dragFrom.current = previewWidth)} onDrag={(d) => setPreviewWidth(Math.max(200, Math.min(900, dragFrom.current - d)))} />
                <div className="usages-preview-pane" style={{ width: previewWidth }}>
                  {selUsage ? (
                    <>
                      <div className="usages-preview-head" title={selUsage.path}>
                        <FileIcon path={selUsage.path} size={13} /> {relative(root, selUsage.path)}
                      </div>
                      <UsagePreview u={selUsage} />
                    </>
                  ) : (
                    <div className="panel-empty">Select a usage to preview its source.</div>
                  )}
                </div>
              </Fragment>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
