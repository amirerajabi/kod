// The AI providers Kod knows. "anthropic" is Claude through the Anthropic SDK in the engine; every other one is an
// OpenAI-compatible chat completions API. Model lists are suggestions — "Fetch models" asks the provider for its own.

export interface ProviderPreset {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai';
  baseUrl?: string;
  /** Environment variable used when no key is saved. */
  keyEnv?: string;
  models: string[];
  /** No key needed (a local server). */
  local?: boolean;
  keyUrl?: string;
  note?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    kind: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5'],
    keyUrl: 'https://platform.claude.com/settings/keys',
    note: 'Without a key Kod uses ANTHROPIC_API_KEY or your `ant auth login` profile.',
  },
  { id: 'openai', name: 'ChatGPT (OpenAI)', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o4-mini'], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'glm', name: 'GLM (Zhipu, bigmodel.cn)', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPUAI_API_KEY', models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'zai', name: 'GLM (Z.ai, international)', kind: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', keyEnv: 'ZAI_API_KEY', models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'], keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'gemini', name: 'Gemini (Google)', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', models: ['mistral-large-latest', 'codestral-latest', 'mistral-small-latest'], keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', name: 'Grok (xAI)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4', 'grok-3-mini'], keyUrl: 'https://console.x.ai' },
  { id: 'qwen', name: 'Qwen (Alibaba DashScope)', kind: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY', models: ['qwen-max', 'qwen-plus', 'qwen3-coder-plus'], keyUrl: 'https://dashscope.console.aliyun.com/apiKey' },
  { id: 'openrouter', name: 'OpenRouter (many models)', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', models: ['anthropic/claude-opus-5-5', 'openai/gpt-5', 'z-ai/glm-4.6', 'google/gemini-2.5-pro'], keyUrl: 'https://openrouter.ai/keys' },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5-coder', 'llama3.1', 'deepseek-coder-v2'], local: true, note: 'Runs on your machine; nothing leaves it.' },
  { id: 'lmstudio', name: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', models: [], local: true },
  { id: 'custom', name: 'Other (OpenAI-compatible)', kind: 'openai', baseUrl: '', models: [], note: 'Any server that speaks the OpenAI chat completions API.' },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

export const secretNameOf = (providerId: string) => `ai.${providerId}`;
