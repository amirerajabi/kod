import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

export type MenuItem =
  | 'separator'
  | {
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      run?: () => void;
      submenu?: MenuItem[];
    };

interface MenuState {
  open: { x: number; y: number; items: MenuItem[]; minWidth?: number } | null;
  show(x: number, y: number, items: MenuItem[], minWidth?: number): void;
  hide(): void;
}

export const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items, minWidth) => set({ open: { x, y, items, minWidth } }),
  hide: () => set({ open: null }),
}));

export function showContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  useMenu.getState().show(e.clientX, e.clientY, items);
}

export function showMenuBelow(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect();
  useMenu.getState().show(r.left, r.bottom + 4, items, r.width);
}

export function MenuHost() {
  const open = useMenu((s) => s.open);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && (e.target as HTMLElement).closest?.('.menu')) return;
      useMenu.getState().hide();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (!open) return null;
  return <MenuList x={open.x} y={open.y} items={open.items} minWidth={open.minWidth} root />;
}

function MenuList({ x, y, items, minWidth, root }: { x: number; y: number; items: MenuItem[]; minWidth?: number; root?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = x + r.width > window.innerWidth - 4 ? Math.max(4, root ? window.innerWidth - r.width - 4 : x - r.width - (minWidth ?? 0)) : x;
    const ny = y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : y;
    setPos({ x: nx, y: ny });
  }, [x, y, root, minWidth]);

  // keyboard navigation for the root list
  useEffect(() => {
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      const enabled = items.map((it, i) => (it !== 'separator' && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = enabled.indexOf(active);
        const next = e.key === 'ArrowDown' ? enabled[(cur + 1) % enabled.length] : enabled[(cur - 1 + enabled.length) % enabled.length];
        setActive(next ?? -1);
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        const it = items[active];
        if (it !== 'separator' && it.run) {
          useMenu.getState().hide();
          it.run();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [root, items, active]);

  return (
    <>
      <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y, minWidth: minWidth ? Math.max(220, minWidth) : undefined }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) =>
          it === 'separator' ? (
            <div key={i} className="menu-sep" role="separator" />
          ) : (
            <div
              key={i}
              role="menuitem"
              aria-disabled={it.disabled}
              className={`menu-item${active === i ? ' active' : ''}${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}`}
              onMouseEnter={(e) => {
                setActive(i);
                if (it.submenu) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSub({ index: i, x: r.right + 2, y: r.top - 4 });
                } else setSub(null);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (it.disabled || it.submenu) return;
                useMenu.getState().hide();
                it.run?.();
              }}
            >
              <span className="menu-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
              <span className="menu-label">{it.label}</span>
              {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
              {it.submenu && <ChevronRight size={14} className="menu-shortcut" />}
            </div>
          ),
        )}
      </div>
      {sub && items[sub.index] !== 'separator' && (items[sub.index] as { submenu?: MenuItem[] }).submenu && (
        <MenuList x={sub.x} y={sub.y} items={(items[sub.index] as { submenu: MenuItem[] }).submenu} minWidth={ref.current?.offsetWidth} />
      )}
    </>
  );
}
