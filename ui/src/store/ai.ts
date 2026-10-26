// The AI assistant: which provider and model to use (Settings › AI), the conversation shown in the AI window, and
// the engine's ai.* events (streamed text, thinking, tool calls waiting for approval, the end of a turn).
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { AiToolStatus, EngineEvent } from '../api/types';
import { providerById, secretNameOf } from '../ai/providers';
import { getEditor } from '../editor/CodeEditor';
import { pathOfModel } from '../editor/models';
import { load, save } from '../lib/storage';
import { platform } from '../platform';
import { useEditors } from './editors';
import { toast, useUi } from './ui';

export type AiMode = 'agent' | 'auto' | 'chat';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AiConfig {
  provider: string;
  /** Per provider: the chosen model and, for OpenAI-compatible servers, the base URL. */
  models: Record<string, string>;
  baseUrls: Record<string, string>;
  mode: AiMode;
  /** Claude only: how hard it thinks (Anthropic effort). */
  effort: AiEffort;
  /** Send the active file and selection with each message. */
  sendContext: boolean;
}

const DEFAULT_CONFIG: AiConfig = { provider: 'anthropic', models: {}, baseUrls: {}, mode: 'agent', effort: 'high', sendContext: true };

export type AiItem =
  | { kind: 'user'; id: string; text: string; context?: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string }
  | { kind: 'tool'; id: string; callId: string; name: string; title: string; status: AiToolStatus; input?: string; output?: string; changedFile?: string }
  | { kind: 'notice'; id: string; text: string; error?: boolean };

interface AiState {
  config: AiConfig;
  sessionId: string;
  items: AiItem[];
  busy: boolean;
  usage: { input: number; output: number; cached: number };
  /** Providers that have a saved key (the keys themselves stay in the OS keychain). */
  keys: Record<string, boolean>;
  setConfig(p: Partial<AiConfig>): void;
}

const newSession = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
let itemSeq = 0;
const nextId = () => `i${++itemSeq}`;

export const useAi = create<AiState>((set, get) => ({
  config: load('ai', DEFAULT_CONFIG),
  sessionId: newSession(),
  items: [],
  busy: false,
  usage: { input: 0, output: 0, cached: 0 },
  keys: {},
  setConfig: (p) => {
    const config = { ...get().config, ...p };
    set({ config });
    save('ai', config);
  },
}));

export function modelOf(providerId: string, config = useAi.getState().config): string {
  return config.models[providerId] ?? providerById(providerId).models[0] ?? '';
}

export function baseUrlOf(providerId: string, config = useAi.getState().config): string {
  return config.baseUrls[providerId] ?? providerById(providerId).baseUrl ?? '';
}

export async function refreshKeys(): Promise<void> {
  const { PROVIDERS } = await import('../ai/providers');
  const entries = await Promise.all(PROVIDERS.map(async (p) => [p.id, await platform.hasSecret(secretNameOf(p.id)).catch(() => false)] as const));
  useAi.setState({ keys: Object.fromEntries(entries) });
}

export async function saveKey(providerId: string, value: string | null): Promise<void> {
  await platform.setSecret(secretNameOf(providerId), value?.trim() || null);
  await refreshKeys();
}

async function providerPayload(providerId: string) {
  const preset = providerById(providerId);
  const config = useAi.getState().config;
  return {
    kind: preset.kind,
    model: modelOf(providerId, config),
    baseUrl: preset.kind === 'openai' ? baseUrlOf(providerId, config) : config.baseUrls[providerId] || undefined,
    apiKey: (await platform.getSecret(secretNameOf(providerId)).catch(() => null)) ?? undefined,
    effort: config.effort,
    keyEnv: preset.keyEnv,
  };
}

export async function fetchModels(providerId: string): Promise<string[]> {
  return api.post<string[]>('/ai/models', { provider: await providerPayload(providerId) });
}

function editorContext(): { activeFile?: string; selection?: string; selectionStartLine?: number; openFiles: string[] } {
  const ed = getEditor();
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  const selection = model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : undefined;
  return {
    activeFile: pathOfModel(model ?? null) ?? useEditors.getState().active ?? undefined,
    selection,
    selectionStartLine: selection ? sel!.startLineNumber : undefined,
    openFiles: useEditors.getState().tabs.map((t) => t.path),
  };
}

export async function sendMessage(text: string, extra?: { selection?: string; startLine?: number; file?: string }): Promise<void> {
  const st = useAi.getState();
  const message = text.trim();
  if (!message || st.busy) return;
  const config = st.config;
  const preset = providerById(config.provider);
  const model = modelOf(config.provider, config);
  if (!model) {
    toast('error', 'Choose a model first', 'Settings › AI');
    useUi.getState().set({ settingsOpen: true });
    return;
  }
  // the agent works on the files on disk: unsaved editors are saved first
  if (config.mode !== 'chat') await useEditors.getState().saveAll();
  const ctx = config.sendContext ? editorContext() : { openFiles: [] as string[] };
  if (extra?.selection) Object.assign(ctx, { selection: extra.selection, selectionStartLine: extra.startLine, activeFile: extra.file ?? ctx.activeFile });
  const contextLabel = ctx.selection ? `${ctx.selection.split('\n').length} selected lines` : ctx.activeFile ? ctx.activeFile.split(/[\\/]/).pop() : undefined;
  useAi.setState((s) => ({ busy: true, items: [...s.items, { kind: 'user', id: nextId(), text: message, context: contextLabel }] }));
  if (!useUi.getState().aiVisible) useUi.getState().setLayout({ aiVisible: true });
  try {
    await api.post('/ai/chat', { sessionId: st.sessionId, provider: await providerPayload(config.provider), message, context: ctx, mode: config.mode });
  } catch (e) {
    useAi.setState((s) => ({ busy: false, items: [...s.items, { kind: 'notice', id: nextId(), text: `${preset.name}: ${errorText(e)}`, error: true }] }));
  }
}

export function stopAi(): void {
  void api.post('/ai/stop', { sessionId: useAi.getState().sessionId }).catch(() => undefined);
}

export function newChat(): void {
  const old = useAi.getState().sessionId;
  void api.post('/ai/reset', { sessionId: old }).catch(() => undefined);
  useAi.setState({ sessionId: newSession(), items: [], busy: false, usage: { input: 0, output: 0, cached: 0 } });
}

export function approve(callId: string, allow: boolean, always = false): void {
  void api.post('/ai/approve', { callId, allow, always }).catch((e) => toast('error', 'Could not answer the assistant', errorText(e)));
}

/** Engine events for the current session. */
export function onAiEvent(e: EngineEvent): void {
  if (!e.type.startsWith('ai.') || !('sessionId' in e) || e.sessionId !== useAi.getState().sessionId) return;
  useAi.setState((s) => {
    const items = [...s.items];
    const last = items[items.length - 1];
    const assistant = () => {
      if (last?.kind === 'assistant') return (items[items.length - 1] = { ...last });
      const a: AiItem = { kind: 'assistant', id: nextId(), text: '', thinking: '' };
      items.push(a);
      return a;
    };
    switch (e.type) {
      case 'ai.delta': {
        const a = assistant() as Extract<AiItem, { kind: 'assistant' }>;
        a.text += e.text;
        break;
      }
      case 'ai.thinking': {
        const a = assistant() as Extract<AiItem, { kind: 'assistant' }>;
        a.thinking += e.text;
        break;
      }
      case 'ai.notice':
        items.push({ kind: 'notice', id: nextId(), text: e.text });
        break;
      case 'ai.tool': {
        const at = items.findIndex((i) => i.kind === 'tool' && i.callId === e.callId);
        const item: AiItem = { kind: 'tool', id: at >= 0 ? items[at].id : nextId(), callId: e.callId, name: e.name, title: e.title, status: e.status, input: e.input, output: e.output, changedFile: e.changedFile };
        if (at >= 0) items[at] = item;
        else items.push(item);
        if (e.status === 'approval' && !document.hasFocus()) platform.showNotification?.({ title: 'Kod AI', body: `Approve: ${e.title}` });
        break;
      }
      case 'ai.done': {
        if (e.error) items.push({ kind: 'notice', id: nextId(), text: e.error, error: e.stopReason === 'error' || e.stopReason === 'refusal' });
        else if (e.stopReason === 'stopped') items.push({ kind: 'notice', id: nextId(), text: 'Stopped.' });
        const u = e.usage ?? { input: 0, output: 0, cached: 0 };
        return { items, busy: false, usage: { input: s.usage.input + u.input, output: s.usage.output + u.output, cached: s.usage.cached + u.cached } };
      }
    }
    return { items };
  });
}
