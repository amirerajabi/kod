import { useRef } from 'react';

/** A 1 px divider with a wider hit area. `direction="vertical"` resizes widths (col-resize). */
export function Splitter({
  direction,
  onDragStart,
  onDrag,
  onDoubleClick,
}: {
  direction: 'vertical' | 'horizontal';
  onDragStart?: () => void;
  onDrag: (delta: number) => void;
  onDoubleClick?: () => void;
}) {
  const start = useRef(0);
  return (
    <div
      className={`splitter splitter-${direction}`}
      role="separator"
      aria-orientation={direction}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = direction === 'vertical' ? e.clientX : e.clientY;
        onDragStart?.();
        document.body.classList.add(direction === 'vertical' ? 'resizing-col' : 'resizing-row');
        const move = (ev: PointerEvent) => onDrag((direction === 'vertical' ? ev.clientX : ev.clientY) - start.current);
        const up = () => {
          document.body.classList.remove('resizing-col', 'resizing-row');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}
