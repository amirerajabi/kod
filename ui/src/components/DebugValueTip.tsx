import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { enterValueTip, leaveValueTip, useDebug } from '../store/debug';
import { VarNode } from './DebugPanel';
import './debugTip.css';

/** Rider's debugger tooltip: the hovered expression's value under the word, expandable like the Variables tree
 *  (children can be set, collections and long strings viewed). */
export function DebugValueTip() {
  const tip = useDebug((s) => s.tip);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // under the word, or above it when there is no room below; never off-screen, also as it grows (expanded nodes)
  useLayoutEffect(() => {
    const el = box.current;
    if (!tip || !el) return setPlace(null);
    // the side is chosen once, so growing does not flip the popup away from under the mouse
    const below = tip.y + 2 + el.offsetHeight <= window.innerHeight - 8;
    const fit = () => {
      const left = Math.max(8, Math.min(tip.x, window.innerWidth - el.offsetWidth - 8));
      const top = below ? Math.max(8, Math.min(tip.y + 2, window.innerHeight - el.offsetHeight - 8)) : Math.max(8, tip.y - tip.height - el.offsetHeight - 2);
      setPlace({ left, top });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tip]);

  useEffect(() => {
    if (!tip) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) useDebug.setState({ tip: null });
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && useDebug.setState({ tip: null });
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={box}
      className="debug-tip mono"
      style={place ? { left: place.left, top: place.top } : { left: tip.x, top: tip.y, visibility: 'hidden' }}
      onMouseEnter={enterValueTip}
      onMouseLeave={leaveValueTip}
    >
      <VarNode
        key={`${tip.expression}:${tip.x}:${tip.y}`}
        v={{ name: tip.expression, value: tip.result, type: tip.type, variablesReference: tip.variablesReference, evaluateName: tip.expression }}
        depth={0}
        parentRef={0}
      />
    </div>
  );
}
