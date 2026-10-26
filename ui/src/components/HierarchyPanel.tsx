import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight, CircleDot, ExternalLink, GitFork, LoaderCircle, Network, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HierarchyItemDto } from '../api/types';
import { getEditor } from '../editor/CodeEditor';
import { pathOfModel } from '../editor/models';
import { openSymbol } from '../editor/navigation';
import { basename } from '../lib/paths';
import { nodeKey, showHierarchy, useHierarchy, type HierarchyDirection } from '../store/hierarchy';
import { SYMBOL_ICON } from './StructurePanel';

const DIRECTIONS: Record<'call' | 'type', { id: HierarchyDirection; label: string; icon: ReactNode; hint: string }[]> = {
  call: [
    { id: 'callers', label: 'Callers', icon: <ArrowDownToLine size={12} />, hint: 'Who calls this member' },
    { id: 'callees', label: 'Callees', icon: <ArrowUpFromLine size={12} />, hint: 'What this member calls' },
  ],
  type: [
    { id: 'subtypes', label: 'Subtypes', icon: <ArrowDownToLine size={12} />, hint: 'Inheritors and implementations' },
    { id: 'supertypes', label: 'Supertypes', icon: <ArrowUpFromLine size={12} />, hint: 'Base type and interfaces' },
  ],
};

/** Rider's Call Hierarchy (Ctrl+Alt+H) and Type Hierarchy (Ctrl+H) tool window, expanded one level at a time. */
export function HierarchyPanel() {
  const { kind, direction, root, loading, children, open } = useHierarchy();

  const refresh = () => {
    const ed = getEditor();
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    if (model && pos) void showHierarchy(kind, { path: pathOfModel(model), text: model.getValue(), line: pos.lineNumber, column: pos.column });
  };

  if (loading)
    return (
      <div className="panel-empty">
        <LoaderCircle size={16} className="spin" /> Building the hierarchy…
      </div>
    );
  if (!root)
    return (
      <div className="panel-empty">
        <Network size={18} />
        <div>
          Put the caret on a method and press <kbd>Ctrl+Alt+H</kbd> for its callers, or on a type and press <kbd>Ctrl+H</kbd> for its inheritors.
        </div>
      </div>
    );

  const render = (item: HierarchyItemDto, parent: string, depth: number): ReactNode => {
    const key = nodeKey(parent, item);
    const isOpen = !!open[key];
    const kids = children[key];
    // a node that repeats one of its ancestors (recursion) is not expanded again
    const recursive = parent.split('/').includes(item.id);
    const expandable = item.expandable && !recursive;
    const sites = item.callSites?.length ?? 0;
    return (
      <div key={key}>
        <div
          className="tree-row"
          style={{ paddingLeft: 6 + depth * 16 }}
          title={item.detail ?? item.name}
          onClick={() => void openSymbol(item, sites && item.callPath ? { path: item.callPath, range: item.callSites![0] } : undefined)}
        >
          <span
            className="tree-chevron"
            onClick={(e) => {
              e.stopPropagation();
              if (expandable) useHierarchy.getState().toggle(key, item);
            }}
          >
            {expandable ? isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
          </span>
          {SYMBOL_ICON[item.kind] ?? <CircleDot size={14} className="muted" />}
          <span className="tree-label">{item.name}</span>
          {item.detail && <span className="tree-hint hier-detail">{item.detail}</span>}
          {recursive && <span className="badge">recursive</span>}
          {sites > 1 && <span className="badge">{sites} calls</span>}
          {!item.path && <span className="tree-hint">metadata</span>}
          {item.path && <span className="tree-hint">{basename(item.path)}</span>}
          {sites > 0 && (
            <button
              className="icon-btn sm hier-go"
              title="Go to declaration"
              onClick={(e) => {
                e.stopPropagation();
                void openSymbol(item);
              }}
            >
              <ExternalLink size={12} />
            </button>
          )}
        </div>
        {isOpen && kids === 'loading' && (
          <div className="tree-row muted" style={{ paddingLeft: 6 + (depth + 1) * 16 + 18 }}>
            <LoaderCircle size={12} className="spin" /> …
          </div>
        )}
        {isOpen && Array.isArray(kids) && kids.length === 0 && (
          <div className="tree-row muted" style={{ paddingLeft: 6 + (depth + 1) * 16 + 18 }}>
            {direction === 'callers' ? 'No callers' : direction === 'callees' ? 'No calls' : direction === 'subtypes' ? 'No inheritors' : 'No base types'}
          </div>
        )}
        {isOpen && Array.isArray(kids) && kids.map((k) => render(k, key, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="console-toolbar">
        {kind === 'call' ? <Network size={14} /> : <GitFork size={14} />}
        <b>{kind === 'call' ? 'Call hierarchy' : 'Type hierarchy'}</b>
        <div className="topbar-sep" />
        {DIRECTIONS[kind].map((d) => (
          <button key={d.id} className={`proc-chip${direction === d.id ? ' active' : ''}`} title={d.hint} onClick={() => useHierarchy.getState().setDirection(d.id)}>
            {d.icon} {d.label}
          </button>
        ))}
        <div className="flex-1" />
        <button className="icon-btn sm" title="Rebuild for the symbol at the caret" onClick={refresh}>
          <RotateCw size={14} />
        </button>
      </div>
      <div className="result-list tree">{render(root, '', 0)}</div>
    </>
  );
}
