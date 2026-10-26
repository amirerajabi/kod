import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useUi } from '../../store/ui';
import { UpdateNotice } from '../UpdateChip';
import { Dialog } from './Dialog';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      <UpdateNotice />
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'warning' ? AlertTriangle : t.kind === 'error' ? XCircle : Info;
        return (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon size={16} className={t.kind === 'success' ? 'ws-open' : t.kind === 'error' ? 'sev-error' : t.kind === 'warning' ? 'sev-warning' : 'sev-info'} />
            <div className="toast-body">
              <div>{t.text}</div>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
              {t.action && (
                <button
                  className="btn btn-xs"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    t.action!.run();
                    useUi.getState().dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn sm" onClick={() => useUi.getState().dismiss(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function PromptDialog() {
  const prompt = useUi((s) => s.prompt);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!prompt) return;
    setValue(prompt.value ?? '');
    setTimeout(() => {
      input.current?.focus();
      if (prompt.select) input.current?.setSelectionRange(prompt.select[0], prompt.select[1]);
      else input.current?.select();
    }, 0);
  }, [prompt]);
  if (!prompt) return null;
  const error = value.trim() ? prompt.validate?.(value.trim()) ?? null : null;
  const done = (v: string | null) => {
    useUi.getState().set({ prompt: null });
    prompt.resolve(v);
  };
  return (
    <Dialog
      title={prompt.title}
      onClose={() => done(null)}
      width={440}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!value.trim() || !!error} onClick={() => done(value.trim())}>
            {prompt.okLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {prompt.label && <div className="muted" style={{ marginBottom: 6 }}>{prompt.label}</div>}
      <input
        ref={input}
        className="input"
        value={value}
        placeholder={prompt.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim() && !error) done(value.trim());
        }}
      />
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

export function ConfirmDialog() {
  const c = useUi((s) => s.confirm);
  if (!c) return null;
  const done = (v: 'ok' | 'alt' | 'cancel') => {
    useUi.getState().set({ confirm: null });
    c.resolve(v);
  };
  return (
    <Dialog
      title={c.title}
      onClose={() => done('cancel')}
      width={440}
      footer={
        <>
          {c.altLabel && (
            <button className="btn" onClick={() => done('alt')} style={{ marginRight: 'auto' }}>
              {c.altLabel}
            </button>
          )}
          <button className="btn" onClick={() => done('cancel')}>
            Cancel
          </button>
          <button className={`btn ${c.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done('ok')} autoFocus>
            {c.okLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <div style={{ whiteSpace: 'pre-wrap' }}>{c.message}</div>
    </Dialog>
  );
}
