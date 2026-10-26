// Settings › AI: the provider (Claude, ChatGPT, GLM, Gemini, …), its model, base URL and API key (kept encrypted
// by the OS keychain, never in Kod's settings file), and how the assistant works.
import { Download, ExternalLink, KeyRound, LoaderCircle, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorText } from '../../api/client';
import { PROVIDERS, providerById } from '../../ai/providers';
import { platform } from '../../platform';
import { baseUrlOf, fetchModels, modelOf, refreshKeys, saveKey, useAi, type AiEffort, type AiMode } from '../../store/ai';
import { toast } from '../../store/ui';
import { Card, Row, Segmented, Select, ToggleRow } from './controls';

export function AiSection() {
  const config = useAi((s) => s.config);
  const keys = useAi((s) => s.keys);
  const preset = providerById(config.provider);
  const [fetched, setFetched] = useState<Record<string, string[]>>({});
  const [fetching, setFetching] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  useEffect(() => void refreshKeys(), []);
  useEffect(() => setKeyDraft(''), [config.provider]);

  const model = modelOf(config.provider, config);
  const models = [...new Set([...(fetched[preset.id] ?? []), ...preset.models])];
  const set = useAi.getState().setConfig;

  return (
    <>
      <Card title="Provider" description="Kod sends your messages, and the code the assistant reads, to the provider you pick. Ollama and LM Studio run on your machine.">
        <Row label="Provider" htmlFor="ai-provider" keywords="ai provider claude anthropic openai chatgpt glm zhipu gemini deepseek mistral grok qwen openrouter ollama">
          <Select id="ai-provider" value={config.provider} options={PROVIDERS.map((p) => [p.id, p.name] as [string, string])} onChange={(v) => set({ provider: v })} />
        </Row>
        <Row label="Model" htmlFor="ai-model" hint={preset.id === 'anthropic' ? 'claude-opus-5-5 is the most capable everyday model; Haiku is the fastest' : 'Type a model id or pick one'} keywords="ai model">
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <input id="ai-model" className="input settings-text" style={{ width: 230 }} list="ai-model-list" value={model} spellCheck={false} onChange={(e) => set({ models: { ...config.models, [preset.id]: e.target.value.trim() } })} />
            <datalist id="ai-model-list">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button
              type="button"
              className="btn"
              title="Ask the provider which models your key can use"
              disabled={fetching}
              onClick={async () => {
                setFetching(true);
                try {
                  const list = await fetchModels(preset.id);
                  setFetched((f) => ({ ...f, [preset.id]: list }));
                  toast('success', `${list.length} models available`, undefined, 2500);
                } catch (e) {
                  toast('error', 'Could not list the models', errorText(e));
                } finally {
                  setFetching(false);
                }
              }}
            >
              {fetching ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />} Fetch models
            </button>
          </span>
        </Row>
        {preset.kind === 'openai' && (
          <Row label="Base URL" htmlFor="ai-base" hint="The OpenAI-compatible endpoint (…/v1)" keywords="ai base url endpoint server proxy">
            <input id="ai-base" className="input settings-text" style={{ width: 320 }} spellCheck={false} placeholder="https://…/v1" value={baseUrlOf(preset.id, config)} onChange={(e) => set({ baseUrls: { ...config.baseUrls, [preset.id]: e.target.value.trim() } })} />
          </Row>
        )}
        {!preset.local && (
          <Row
            label="API key"
            htmlFor="ai-key"
            hint={
              <>
                {keys[preset.id] ? 'Saved, encrypted by your operating system.' : preset.keyEnv ? `Not saved; Kod uses ${preset.keyEnv} if it is set.` : 'Not saved.'} {preset.note}
              </>
            }
            keywords="ai api key secret token"
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input
                id="ai-key"
                className="input settings-text"
                style={{ width: 230 }}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={keys[preset.id] ? '•••••••• (saved)' : 'Paste your key'}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!keyDraft.trim()}
                onClick={async () => {
                  try {
                    await saveKey(preset.id, keyDraft);
                    setKeyDraft('');
                    toast('success', 'API key saved', undefined, 2000);
                  } catch (e) {
                    toast('error', 'Could not save the key', errorText(e));
                  }
                }}
              >
                <KeyRound size={14} /> Save
              </button>
              {keys[preset.id] && (
                <button type="button" className="icon-btn" title="Remove the saved key" onClick={() => void saveKey(preset.id, null)}>
                  <Trash2 size={14} />
                </button>
              )}
              {preset.keyUrl && (
                <button type="button" className="icon-btn" title="Get a key" onClick={() => platform.openExternal(preset.keyUrl!)}>
                  <ExternalLink size={14} />
                </button>
              )}
            </span>
          </Row>
        )}
        {preset.id === 'anthropic' && (
          <Row label="Base URL" htmlFor="ai-abase" hint="Optional: a proxy or gateway in front of the Anthropic API" keywords="ai base url proxy gateway anthropic">
            <input id="ai-abase" className="input settings-text" style={{ width: 320 }} spellCheck={false} placeholder="https://api.anthropic.com" value={config.baseUrls.anthropic ?? ''} onChange={(e) => set({ baseUrls: { ...config.baseUrls, anthropic: e.target.value.trim() } })} />
          </Row>
        )}
      </Card>
      <Card title="Assistant">
        <Row label="Mode" hint="Agent asks before it edits a file or runs a command; Auto does not ask; Chat only answers" keywords="ai agent mode approval auto chat">
          <Segmented<AiMode>
            label="Mode"
            value={config.mode}
            onChange={(v) => set({ mode: v })}
            options={[
              { value: 'agent', label: 'Agent' },
              { value: 'auto', label: 'Auto' },
              { value: 'chat', label: 'Chat' },
            ]}
          />
        </Row>
        {preset.kind === 'anthropic' && (
          <Row label="Effort" htmlFor="ai-effort" hint="How much Claude thinks before it answers: more is slower and costs more" keywords="ai effort thinking reasoning claude">
            <Select<AiEffort> id="ai-effort" value={config.effort} options={[['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]} onChange={(v) => set({ effort: v })} />
          </Row>
        )}
        <ToggleRow id="ai-ctx" label="Send the current file and selection" hint="The active file's name and the selected text go with every message" keywords="ai context selection file" checked={config.sendContext} onChange={(v) => set({ sendContext: v })} />
      </Card>
    </>
  );
}
