import { Box, Braces, ChevronDown, ChevronRight, CircleDot, Hash, Layers, ListTree, Wrench, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { SymbolDto } from '../api/types';
import { getEntry } from '../editor/models';
import { useEditors } from '../store/editors';

export const SYMBOL_ICON: Record<string, ReactNode> = {
  namespace: <Layers size={14} className="muted" />,
  class: <Box size={14} style={{ color: 'var(--syn-class)' }} />,
  structure: <Box size={14} style={{ color: 'var(--syn-struct)' }} />,
  interface: <Box size={14} style={{ color: 'var(--syn-interface)' }} />,
  enum: <ListTree size={14} style={{ color: 'var(--syn-enum)' }} />,
  enummember: <Hash size={14} style={{ color: 'var(--syn-constant)' }} />,
  method: <Braces size={14} style={{ color: 'var(--syn-method)' }} />,
  constructor: <Wrench size={14} style={{ color: 'var(--syn-method)' }} />,
  property: <CircleDot size={14} style={{ color: 'var(--syn-property)' }} />,
  field: <CircleDot size={14} style={{ color: 'var(--syn-field)' }} />,
  constant: <Hash size={14} style={{ color: 'var(--syn-constant)' }} />,
  event: <Zap size={14} style={{ color: 'var(--syn-event)' }} />,
};

/** The outline of the active C# file (Rider's Structure window). */
export function StructurePanel() {
  const active = useEditors((s) => s.active);
  const [symbols, setSymbols] = useState<SymbolDto[] | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const entry = active ? getEntry(active) : undefined;
    if (!entry || entry.model.getLanguageId() !== 'csharp') {
      setSymbols(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.post<SymbolDto[]>('/intel/symbols', { path: entry.path, text: entry.model.getValue() });
        if (!cancelled) setSymbols(res);
      } catch {
        if (!cancelled) setSymbols([]);
      }
    };
    void load();
    const sub = entry.model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(load, 900);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      sub.dispose();
    };
  }, [active]);

  if (!symbols) return <div className="panel-empty">Open a C# file to see its structure.</div>;

  const render = (list: SymbolDto[], depth: number, prefix: string): ReactNode =>
    list.map((s, i) => {
      const key = `${prefix}/${i}:${s.name}`;
      const open = !closed[key];
      return (
        <div key={key}>
          <div
            className="tree-row"
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => active && void useEditors.getState().open(active, { range: s.selectionRange })}
            title={s.detail ? `${s.name} ${s.detail}` : s.name}
          >
            <span className="tree-chevron" onClick={(e) => { e.stopPropagation(); setClosed({ ...closed, [key]: open }); }}>
              {s.children.length > 0 ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
            </span>
            {SYMBOL_ICON[s.kind] ?? <CircleDot size={14} className="muted" />}
            <span className="tree-label">{s.name}</span>
            {s.detail && <span className="tree-hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.detail}</span>}
          </div>
          {open && s.children.length > 0 && render(s.children, depth + 1, key)}
        </div>
      );
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-header">
        <span className="panel-title">Structure</span>
      </div>
      <div className="panel-body tree">{symbols.length ? render(symbols, 0, '') : <div className="panel-empty">No declarations</div>}</div>
    </div>
  );
}
