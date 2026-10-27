// The HTTP Client: sends the requests of .http files through the engine, keeps the responses (the HTTP Client tool
// window) and the chosen environment of http-client.env.json.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { getEntry } from '../editor/models';
import { parseHttpFile, requestAt, substitute, toCurl, type HttpRequestBlock } from '../lib/httpFile';
import { dirname, isUnder, join } from '../lib/paths';
import { loadRaw, save } from '../lib/storage';
import { copyText } from '../app/actions';
import { toast, useUi } from './ui';
import { useWorkspace } from './workspace';

export interface HttpHeader {
  name: string;
  value: string;
}

export interface HttpResponse {
  status: number;
  reason: string;
  version: string;
  headers: HttpHeader[];
  body: string;
  binary: boolean;
  truncated: boolean;
  size: number;
  ms: number;
  contentType?: string;
  finalUrl: string;
}

export interface HttpExchange {
  id: string;
  title: string;
  request: { method: string; url: string; headers: [string, string][]; body: string };
  response?: HttpResponse;
  error?: string;
  running: boolean;
  at: number;
  file: string;
  line: number;
}

interface HttpState {
  history: HttpExchange[];
  selected: string | null;
  /** The environment of http-client.env.json in use ('' = none). */
  env: string;
  /** The environments found next to the last file sent. */
  envNames: string[];
}

export const useHttp = create<HttpState>(() => ({ history: [], selected: null, env: loadRaw('httpEnv', ''), envNames: [] }));

export function setHttpEnv(env: string): void {
  useHttp.setState({ env });
  save('httpEnv', env);
}

type EnvFile = Record<string, Record<string, unknown>>;

async function readJson(path: string): Promise<EnvFile | null> {
  try {
    const f = await api.get<{ text: string }>('/fs/read', { path });
    return JSON.parse(f.text) as EnvFile;
  } catch {
    return null;
  }
}

/** http-client.env.json (and .private) from the file's folder up to the workspace root, the nearest winning. */
export async function loadEnvironments(file: string): Promise<{ names: string[]; values: (name: string) => Record<string, string> }> {
  const root = useWorkspace.getState().ws.root;
  const files: EnvFile[] = [];
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    for (const name of ['http-client.private.env.json', 'http-client.env.json']) {
      const json = await readJson(join(dir, name));
      if (json) files.push(json);
    }
    if (!root || !isUnder(dir, root) || dirname(dir) === dir) break;
  }
  const names = [...new Set(files.flatMap((f) => Object.keys(f)).filter((k) => !k.startsWith('$')))].sort();
  const flat = (o: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    names,
    // nearest file wins, an environment's own value over $shared
    values: (name) => Object.assign({}, ...[...files].reverse().map((f) => ({ ...flat(f.$shared), ...(name ? flat(f[name]) : {}) }))),
  };
}

let seq = 0;

/** Sends the request at a 1-based line of a .http file (or the one with that index). */
export async function sendHttpRequest(path: string, line: number): Promise<void> {
  const entry = getEntry(path);
  if (!entry) return;
  const file = parseHttpFile(entry.model.getValue());
  const req: HttpRequestBlock | undefined = requestAt(file, line);
  if (!req) {
    toast('info', 'No request here', 'Put the caret inside a request (METHOD URL, headers, a blank line, then the body).');
    return;
  }
  const envs = await loadEnvironments(path);
  let env = useHttp.getState().env;
  if (env && !envs.names.includes(env)) env = '';
  if (!env && envs.names.length) env = envs.names[0];
  useHttp.setState({ envNames: envs.names });
  if (env !== useHttp.getState().env) setHttpEnv(env);
  const envVars = envs.values(env);

  const missing = new Set<string>();
  let body = req.body;
  if (req.bodyFile) {
    try {
      body = (await api.get<{ text: string }>('/fs/read', { path: join(dirname(path), req.bodyFile) })).text;
    } catch (e) {
      toast('error', `Cannot read ${req.bodyFile}`, errorText(e));
      return;
    }
  }
  const sub = (s: string) => substitute(s, file.vars, envVars, missing);
  const request = { method: req.method, url: sub(req.url), headers: req.headers.map(([k, v]) => [k, sub(v)] as [string, string]), body: sub(body) };
  if (missing.size) toast('warning', `Undefined: ${[...missing].join(', ')}`, env ? `Not in the file or the "${env}" environment.` : 'Define them with @name = value, or in http-client.env.json.', 6000);

  const id = `h${++seq}`;
  const exchange: HttpExchange = { id, title: `${request.method} ${request.url}`, request, running: true, at: Date.now(), file: path, line: req.line };
  useHttp.setState((s) => ({ history: [exchange, ...s.history].slice(0, 50), selected: id }));
  useUi.getState().showBottom('http');
  const update = (p: Partial<HttpExchange>) => useHttp.setState((s) => ({ history: s.history.map((h) => (h.id === id ? { ...h, ...p } : h)) }));
  try {
    const response = await api.post<HttpResponse>('/http/send', { method: request.method, url: request.url, headers: request.headers.map(([name, value]) => ({ name, value })), body: request.body || null });
    update({ response, running: false });
  } catch (e) {
    update({ error: errorText(e), running: false });
  }
}

export async function copyAsCurl(path: string, line: number): Promise<void> {
  const entry = getEntry(path);
  if (!entry) return;
  const file = parseHttpFile(entry.model.getValue());
  const req = requestAt(file, line);
  if (!req) return;
  const envs = await loadEnvironments(path);
  const env = envs.values(useHttp.getState().env);
  const missing = new Set<string>();
  const sub = (s: string) => substitute(s, file.vars, env, missing);
  await copyText(toCurl({ method: req.method, url: sub(req.url), headers: req.headers.map(([k, v]) => [k, sub(v)]), body: sub(req.body) }), 'cURL command');
}

interface EndpointsDto {
  baseUrl?: string;
  endpoints: { method: string; route: string; path?: string; line: number }[];
}

/** Writes <Project>.http with a request per endpoint of the project (minimal APIs and controllers), and opens it. */
export async function generateHttpFile(projectPath: string): Promise<void> {
  try {
    const res = await api.get<EndpointsDto>('/http/endpoints', { project: projectPath });
    const name = projectPath.replace(/^.*[\\/]/, '').replace(/\.csproj$/i, '');
    const target = join(dirname(projectPath), `${name}.http`);
    const exists = await api.get('/fs/read', { path: target }).then(() => true, () => false);
    if (!exists) {
      const lines = [`@${name}_HostAddress = ${res.baseUrl ?? 'http://localhost:5000'}`, ''];
      if (res.endpoints.length === 0) lines.push(`GET {{${name}_HostAddress}}/`, 'Accept: application/json', '', '###', '');
      for (const e of res.endpoints) {
        lines.push(`${e.method} {{${name}_HostAddress}}${e.route}`, 'Accept: application/json');
        if (['POST', 'PUT', 'PATCH'].includes(e.method)) lines.push('Content-Type: application/json', '', '{', '}');
        lines.push('', '###', '');
      }
      await api.post('/fs/create', { path: target, isDir: false, text: lines.join('\n') });
      toast('success', `${name}.http: ${res.endpoints.length} request${res.endpoints.length === 1 ? '' : 's'}`, 'Click ▶ Send above a request, or press Ctrl+Enter in it.');
    }
    const { useEditors } = await import('./editors');
    await useEditors.getState().open(target);
  } catch (e) {
    toast('error', 'Could not generate the .http file', errorText(e));
  }
}
