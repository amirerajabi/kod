// HTTP Client tool window: the responses of .http requests (newest first), each with its body (formatted JSON / XML,
// or the image), headers and the request that was sent.
import { Copy, Globe, LoaderCircle, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../app/actions';
import { monaco } from '../editor/monaco';
import { useEditors } from '../store/editors';
import { setHttpEnv, useHttp, type HttpExchange } from '../store/http';
import { useSettings } from '../store/settings';
import './http.css';

const statusClass = (s: number) => (s >= 500 ? 'sev-error' : s >= 400 ? 'sev-warning' : s >= 300 ? 'http-redirect' : 'http-ok');

function size(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

function languageOf(type?: string): string {
  if (!type) return 'plaintext';
  if (type.includes('json')) return 'json';
  if (type.includes('xml')) return 'xml';
  if (type.includes('html')) return 'html';
  if (type.includes('javascript')) return 'javascript';
  if (type.includes('css')) return 'css';
  return 'plaintext';
}

export function pretty(body: string, lang: string): string {
  if (lang === 'json') {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  if (lang === 'xml' && !body.includes('\n') && body.length < 500_000) {
    let depth = 0;
    return body
      .replace(/>\s*</g, '>\n<')
      .split('\n')
      .map((l) => {
        if (/^<\//.test(l)) depth = Math.max(0, depth - 1);
        const out = '  '.repeat(depth) + l;
        if (/^<[^!?/][^>]*[^/]>$/.test(l) && !/<\/[^>]+>$/.test(l)) depth++;
        return out;
      })
      .join('\n');
  }
  return body;
}

/** A read-only Monaco view of a text (the response body). */
export function ReadOnlyCode({ text, language }: { text: string; language: string }) {
  const host = useRef<HTMLDivElement>(null);
  const fontSize = useSettings((s) => s.settings.fontSize);
  const fontFamily = useSettings((s) => s.settings.fontFamily);
  useEffect(() => {
    const model = monaco.editor.createModel(text, language);
    const ed = monaco.editor.create(host.current!, {
      model,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      folding: true,
      renderLineHighlight: 'none',
      fontSize: fontSize - 1,
      fontFamily,
      theme: 'kod',
    });
    return () => {
      ed.dispose();
      model.dispose();
    };
  }, [text, language, fontSize, fontFamily]);
  return <div ref={host} className="http-code" />;
}

function ExchangeView({ x }: { x: HttpExchange }) {
  const [tab, setTab] = useState<'body' | 'headers' | 'request'>('body');
  const r = x.response;
  const lang = languageOf(r?.contentType);
  const body = useMemo(() => (r && !r.binary ? pretty(r.body, lang) : ''), [r, lang]);
  const requestText = [`${x.request.method} ${x.request.url}`, ...x.request.headers.map(([k, v]) => `${k}: ${v}`), '', x.request.body].join('\n').trimEnd();
  return (
    <div className="http-view">
      <div className="http-status">
        {x.running ? (
          <span className="muted">
            <LoaderCircle size={14} className="spin" /> Sending…
          </span>
        ) : x.error ? (
          <span className="sev-error">{x.error}</span>
        ) : r ? (
          <>
            <span className={`http-code-chip ${statusClass(r.status)}`}>
              {r.status} {r.reason}
            </span>
            <span className="muted">{Math.round(r.ms)} ms</span>
            <span className="muted">{size(r.size)}{r.truncated ? ' (first 4 MB shown)' : ''}</span>
            {r.contentType && <span className="muted">{r.contentType}</span>}
          </>
        ) : null}
        <div className="flex-1" />
        <div className="subtabs http-subtabs">
          {(['body', 'headers', 'request'] as const).map((t) => (
            <button key={t} className={`subtab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'body' ? 'Body' : t === 'headers' ? `Headers${r ? ` (${r.headers.length})` : ''}` : 'Request'}
            </button>
          ))}
        </div>
        {r && !r.binary && tab === 'body' && (
          <button className="icon-btn sm" title="Copy the body" onClick={() => void copyText(r.body, 'Response body')}>
            <Copy size={14} />
          </button>
        )}
      </div>
      <div className="http-body">
        {tab === 'body' && r && (r.binary ? r.contentType?.startsWith('image/') ? <img className="http-image" src={`data:${r.contentType};base64,${r.body}`} alt="Response" /> : <div className="panel-empty">Binary response ({size(r.size)}).</div> : <ReadOnlyCode text={body} language={lang} />)}
        {tab === 'headers' && r && (
          <table className="http-headers">
            <tbody>
              {r.headers.map((h, i) => (
                <tr key={i}>
                  <td>{h.name}</td>
                  <td>{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'request' && <ReadOnlyCode text={requestText} language="http" />}
      </div>
    </div>
  );
}

export function HttpPanel() {
  const history = useHttp((s) => s.history);
  const selected = useHttp((s) => s.selected);
  const env = useHttp((s) => s.env);
  const envNames = useHttp((s) => s.envNames);
  const current = history.find((h) => h.id === selected) ?? history[0];
  return (
    <div className="http-panel">
      <div className="http-list">
        <div className="panel-header">
          <span className="panel-title">Requests</span>
          {envNames.length > 0 && (
            <select className="input sm" value={env} title="Environment (http-client.env.json)" onChange={(e) => setHttpEnv(e.target.value)}>
              <option value="">No environment</option>
              {envNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn sm" title="Clear" disabled={!history.length} onClick={() => useHttp.setState({ history: [], selected: null })}>
            <Trash2 size={14} />
          </button>
        </div>
        <div className="panel-body">
          {history.length === 0 && (
            <div className="panel-empty">
              <Globe size={20} />
              <div>
                Open or create a <code>.http</code> file and click <b>▶ Send request</b> (or press Ctrl+Enter in a request). Right-click a web project › Generate HTTP Requests to start from its endpoints.
              </div>
            </div>
          )}
          {history.map((h) => (
            <button
              key={h.id}
              className={`http-item${h.id === current?.id ? ' selected' : ''}`}
              title={`${h.title}\n${new Date(h.at).toLocaleTimeString()}`}
              onClick={() => useHttp.setState({ selected: h.id })}
              onDoubleClick={() => void useEditors.getState().open(h.file, { line: h.line })}
            >
              <span className="http-method">{h.request.method}</span>
              <span className="http-url">{h.request.url.replace(/^https?:\/\/[^/]+/, '') || '/'}</span>
              {h.running ? <LoaderCircle size={12} className="spin" /> : h.response ? <span className={statusClass(h.response.status)}>{h.response.status}</span> : <span className="sev-error">✕</span>}
            </button>
          ))}
        </div>
      </div>
      {current ? <ExchangeView key={current.id} x={current} /> : <div className="http-view" />}
    </div>
  );
}
