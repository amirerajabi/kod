import '@xterm/xterm/css/xterm.css';
import { Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { closeTerminal, liveTerminal, newTerminal, useTerminals } from '../store/terminals';

/** The Terminal tool window: real shells (pseudo consoles) in xterm.js; type at the prompt, as in any terminal. */
export function TerminalPane() {
  const terms = useTerminals((s) => s.terms);
  const active = useTerminals((s) => s.active);
  const started = useRef(false);

  useEffect(() => {
    if (terms.length === 0 && !started.current) {
      started.current = true;
      void newTerminal();
    }
  }, [terms.length]);

  return (
    <>
      <div className="console-toolbar">
        <button className="icon-btn sm" title="New terminal" onClick={() => void newTerminal()}>
          <Plus size={14} />
        </button>
        <button className="icon-btn sm" title="Close terminal" disabled={!active} onClick={() => active && closeTerminal(active)}>
          <Trash2 size={14} />
        </button>
        <div className="topbar-sep" />
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', minWidth: 0 }}>
          {terms.map((t) => (
            <button key={t.id} className={`proc-chip${t.id === active ? ' active' : ''}`} onClick={() => useTerminals.setState({ active: t.id })} title={`${t.shell} — ${t.cwd}`}>
              <SquareTerminal size={11} />
              <span>{t.title}</span>
              {t.exited && <span className="muted">(exited)</span>}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--ed-bg)' }}>
        {terms.map((t) => (
          <XtermView key={t.id} id={t.id} visible={t.id === active} />
        ))}
      </div>
    </>
  );
}

function XtermView({ id, visible }: { id: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  // attach the terminal's host element (created once per terminal) to this slot
  useLayoutEffect(() => {
    const t = liveTerminal(id);
    const slot = ref.current;
    if (!t || !slot) return;
    slot.appendChild(t.host);
    if (!t.host.dataset.opened) {
      t.xterm.open(t.host);
      t.host.dataset.opened = '1';
    }
    return () => {
      if (t.host.parentElement === slot) slot.removeChild(t.host);
    };
  }, [id]);

  // fit to the panel while visible
  useEffect(() => {
    const t = liveTerminal(id);
    const slot = ref.current;
    if (!t || !slot || !visible) return;
    const fit = () => {
      try {
        if (slot.clientWidth > 0 && slot.clientHeight > 0) t.fit.fit();
      } catch {
        /* not measurable yet */
      }
    };
    fit();
    t.xterm.focus();
    const ro = new ResizeObserver(fit);
    ro.observe(slot);
    return () => ro.disconnect();
  }, [id, visible]);

  return <div ref={ref} style={{ position: 'absolute', inset: '4px 0 0 8px', display: visible ? 'block' : 'none' }} />;
}
