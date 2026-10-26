// The AI Assistant tool window (right side, like Rider's): chat with Claude, ChatGPT, GLM, Gemini and others; in
// agent mode the assistant reads, searches and edits the workspace and runs commands, asking first for anything
// that changes files or runs a command.
import { Ban, Brain, Check, ChevronDown, ChevronRight, CircleAlert, FileCode, LoaderCircle, MessageSquarePlus, Pencil, Play, Search, Send, Settings2, Sparkles, Square, Terminal, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '../ai/Markdown';
import { PROVIDERS, providerById } from '../ai/providers';
import { relative } from '../lib/paths';
import { approve, modelOf, newChat, sendMessage, stopAi, useAi, type AiItem, type AiMode } from '../store/ai';
import { useEditors } from '../store/editors';
import { AI_MAX, AI_MIN, useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { openSettings } from './settings/nav';
import { showMenuBelow, type MenuItem } from './common/Menu';
import { Splitter } from './common/Splitter';
import './ai.css';

const MODES: { id: AiMode; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent', hint: 'Reads and searches freely; asks before editing files or running commands' },
  { id: 'auto', label: 'Auto', hint: 'Edits files and runs commands without asking' },
  { id: 'chat', label: 'Chat', hint: 'Answers only; no access to your files' },
];

export function AiPanel() {
  const visible = useUi((s) => s.aiVisible);
  const width = useUi((s) => s.aiWidth);
  const ref = useRef<HTMLElement>(null);
  const [start, setStart] = useState(width);
  if (!visible) return null;
  return (
    <>
      <Splitter
        direction="vertical"
        onDragStart={() => setStart(ref.current?.offsetWidth ?? width)}
        onDrag={(d) => useUi.getState().setLayout({ aiWidth: Math.max(AI_MIN, Math.min(AI_MAX, start - d)) })}
        onDoubleClick={() => useUi.getState().setLayout({ aiWidth: 400 })}
      />
      <aside ref={ref} className="ai-panel" style={{ width: Math.max(AI_MIN, Math.min(AI_MAX, width)) }} aria-label="AI Assistant">
        <AiHeader />
        <AiTranscript />
        <AiComposer />
      </aside>
    </>
  );
}

function AiHeader() {
  const config = useAi((s) => s.config);
  const keys = useAi((s) => s.keys);
  const preset = providerById(config.provider);
  const model = modelOf(config.provider, config);
  const pick = (el: HTMLElement) => {
    const items: MenuItem[] = PROVIDERS.map((p) => ({
      label: p.name,
      checked: p.id === config.provider,
      shortcut: p.local ? 'local' : keys[p.id] ? 'key saved' : p.id === 'anthropic' ? '' : 'no key',
      run: () => useAi.getState().setConfig({ provider: p.id }),
    }));
    const models = [...new Set([model, ...preset.models].filter(Boolean))];
    showMenuBelow(el, [
      ...models.map((m): MenuItem => ({ label: m, checked: m === model, run: () => useAi.getState().setConfig({ models: { ...config.models, [config.provider]: m } }) })),
      'separator',
      { label: 'Provider', submenu: items },
      { label: 'AI settings…', run: openAiSettings },
    ]);
  };
  return (
    <div className="ai-head">
      <Sparkles size={14} className="ai-mark" />
      <button className="ai-model" title={`${preset.name} · ${model}`} onClick={(e) => pick(e.currentTarget)}>
        <span className="ai-model-provider">{preset.name.replace(/ \(.*\)$/, '')}</span>
        <span className="ai-model-name">{model || 'choose a model'}</span>
        <ChevronDown size={12} />
      </button>
      <div className="segmented ai-modes" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={config.mode === m.id} className={config.mode === m.id ? 'on' : ''} title={m.hint} onClick={() => useAi.getState().setConfig({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      <span style={{ flex: 1 }} />
      <button className="icon-btn sm" title="New chat" onClick={newChat}>
        <MessageSquarePlus size={14} />
      </button>
      <button className="icon-btn sm" title="AI settings" onClick={openAiSettings}>
        <Settings2 size={14} />
      </button>
      <button className="icon-btn sm" title="Hide" onClick={() => useUi.getState().setLayout({ aiVisible: false })}>
        <X size={14} />
      </button>
    </div>
  );
}

export function openAiSettings(): void {
  openSettings('ai');
}

function AiTranscript() {
  const items = useAi((s) => s.items);
  const busy = useAi((s) => s.busy);
  const usage = useAi((s) => s.usage);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  if (items.length === 0) return <AiEmpty />;
  return (
    <div
      ref={ref}
      className="ai-transcript"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {items.map((it, i) => (
        <AiItemView key={it.id} item={it} last={i === items.length - 1} busy={busy} />
      ))}
      {busy && items[items.length - 1]?.kind !== 'assistant' && (
        <div className="ai-working">
          <LoaderCircle size={13} className="spin" /> Working…
        </div>
      )}
      {!busy && usage.input + usage.output > 0 && (
        <div className="ai-usage" title="Tokens used in this chat (input / output / read from cache)">
          {usage.input.toLocaleString()} in · {usage.output.toLocaleString()} out{usage.cached ? ` · ${usage.cached.toLocaleString()} cached` : ''}
        </div>
      )}
    </div>
  );
}

function AiEmpty() {
  const config = useAi((s) => s.config);
  const keys = useAi((s) => s.keys);
  const preset = providerById(config.provider);
  const needsKey = !preset.local && !keys[preset.id] && preset.id !== 'anthropic';
  const ask = (t: string) => void sendMessage(t);
  return (
    <div className="ai-empty">
      <Sparkles size={28} className="ai-mark" />
      <div className="ai-empty-title">AI Assistant</div>
      <div className="muted">Ask about your code, or let the agent change it: it reads the workspace, edits files and runs builds and tests.</div>
      {needsKey && (
        <button className="btn btn-primary" onClick={openAiSettings}>
          Add your {preset.name} API key
        </button>
      )}
      <div className="ai-suggestions">
        {['Explain the selected code', 'Find and fix the build errors', 'Write unit tests for the open file', 'What does this project do?'].map((s) => (
          <button key={s} className="ai-suggestion" onClick={() => ask(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function AiItemView({ item, last, busy }: { item: AiItem; last: boolean; busy: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="ai-user">
          {item.context && (
            <div className="ai-context">
              <FileCode size={11} /> {item.context}
            </div>
          )}
          <div className="ai-user-text">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="ai-assistant">
          {item.thinking && <Thinking text={item.thinking} live={last && busy && !item.text} />}
          {item.text ? <Markdown text={item.text} /> : last && busy ? <LoaderCircle size={13} className="spin muted" /> : null}
        </div>
      );
    case 'notice':
      return <div className={`ai-notice${item.error ? ' error' : ''}`}>{item.error && <CircleAlert size={13} />} {item.text}</div>;
    case 'tool':
      return <ToolView item={item} />;
  }
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-thinking">
      <button className="ai-thinking-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} /> {live ? 'Thinking…' : 'Thought'}
      </button>
      {open && <div className="ai-thinking-body">{text}</div>}
    </div>
  );
}

const TOOL_ICONS: Record<string, typeof FileCode> = { list_files: FileCode, read_file: FileCode, search: Search, write_file: Pencil, edit_file: Pencil, run_command: Terminal };

function ToolView({ item }: { item: Extract<AiItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(item.status === 'approval');
  useEffect(() => {
    if (item.status === 'approval') setOpen(true);
  }, [item.status]);
  const Icon = TOOL_ICONS[item.name] ?? Play;
  const root = useWorkspace((s) => s.ws.root);
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(item.input || '{}') as Record<string, unknown>;
  } catch {
    // shown raw below
  }
  const status =
    item.status === 'running' ? <LoaderCircle size={12} className="spin" /> : item.status === 'done' ? <Check size={12} className="ok" /> : item.status === 'error' ? <CircleAlert size={12} className="err" /> : item.status === 'denied' ? <Ban size={12} className="muted" /> : null;
  return (
    <div className={`ai-tool ${item.status}`}>
      <button className="ai-tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={12} />
        <span className="ai-tool-title">{item.title}</span>
        {status}
      </button>
      {open && (
        <div className="ai-tool-body">
          {item.name === 'edit_file' && typeof input.old_text === 'string' ? (
            <div className="ai-diff">
              <pre className="del">{input.old_text}</pre>
              <pre className="add">{String(input.new_text ?? '')}</pre>
            </div>
          ) : item.name === 'write_file' && typeof input.content === 'string' ? (
            <pre className="add">{input.content.length > 4000 ? `${input.content.slice(0, 4000)}\n…` : input.content}</pre>
          ) : item.name === 'run_command' ? (
            <pre>{`> ${String(input.command ?? '')}`}</pre>
          ) : item.input && item.input !== '{}' ? (
            <pre>{item.input}</pre>
          ) : null}
          {item.output && <pre className={item.status === 'error' ? 'err' : ''}>{item.output}</pre>}
          {item.changedFile && (
            <button className="btn btn-xs" onClick={() => void useEditors.getState().open(item.changedFile!)}>
              <FileCode size={12} /> Open {root ? relative(root, item.changedFile) : item.changedFile}
            </button>
          )}
        </div>
      )}
      {item.status === 'approval' && (
        <div className="ai-approve">
          <span className="muted">Allow this {item.name === 'run_command' ? 'command' : 'change'}?</span>
          <button className="btn btn-xs btn-primary" onClick={() => approve(item.callId, true)}>
            Allow
          </button>
          <button className="btn btn-xs" title={`Do not ask again for ${item.name} in this chat`} onClick={() => approve(item.callId, true, true)}>
            Always
          </button>
          <button className="btn btn-xs" onClick={() => approve(item.callId, false)}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

function AiComposer() {
  const busy = useAi((s) => s.busy);
  const sendContext = useAi((s) => s.config.sendContext);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => {
    const focus = () => ref.current?.focus();
    window.addEventListener('kod:focus-ai', focus);
    return () => window.removeEventListener('kod:focus-ai', focus);
  }, []);
  const send = () => {
    if (!text.trim() || busy) return;
    void sendMessage(text);
    setText('');
  };
  return (
    <div className="ai-composer">
      <textarea
        ref={ref}
        className="input"
        rows={2}
        placeholder="Ask anything, or describe a change…  (Enter to send, Shift+Enter for a new line)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="ai-composer-bar">
        <label className="check" title="Send the open file's name and the selected text with your message">
          <input type="checkbox" checked={sendContext} onChange={(e) => useAi.getState().setConfig({ sendContext: e.target.checked })} /> Current file &amp; selection
        </label>
        <span style={{ flex: 1 }} />
        {busy ? (
          <button className="btn btn-xs" onClick={stopAi} title="Stop">
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="btn btn-xs btn-primary" disabled={!text.trim()} onClick={send}>
            <Send size={12} /> Send
          </button>
        )}
      </div>
    </div>
  );
}
