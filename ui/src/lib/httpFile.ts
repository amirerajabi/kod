// .http / .rest files (Rider's and Visual Studio's HTTP Client format): requests separated by ###, file variables
// (@name = value), {{variables}} from the file, the environment (http-client.env.json) and dynamic ones ({{$guid}}…).

export interface HttpRequestBlock {
  /** "# @name login" above the request, if any. */
  name?: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  /** "< ./payload.json": the body comes from that file (relative to the .http file). */
  bodyFile?: string;
  /** 1-based line of the request line (where its CodeLens goes). */
  line: number;
  endLine: number;
}

export interface HttpFile {
  vars: Record<string, string>;
  requests: HttpRequestBlock[];
}

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT';
const REQUEST_LINE = new RegExp(`^(${METHODS})\\s+(\\S.*?)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`, 'i');
const URL_ONLY = /^(https?:\/\/\S+|\{\{[^}]+\}\}\S*)\s*$/i;
const VARIABLE = /^@([\w.-]+)\s*=\s*(.*)$/;
const HEADER = /^([\w!#$%&'*+.^`|~-]+)\s*:\s*(.*)$/;
const isComment = (l: string) => /^\s*(#|\/\/)/.test(l) && !/^\s*###/.test(l);

export function parseHttpFile(text: string): HttpFile {
  const lines = text.split(/\r?\n/);
  const vars: Record<string, string> = {};
  const requests: HttpRequestBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    // one block, up to the next ###
    let end = i;
    while (end < lines.length && !(end > i && /^###/.test(lines[end]))) end++;
    if (/^###/.test(lines[i])) i++;
    let name: string | undefined;
    let req: HttpRequestBlock | null = null;
    let state: 'pre' | 'headers' | 'body' = 'pre';
    const body: string[] = [];
    for (let k = i; k < end; k++) {
      const raw = lines[k];
      const line = raw.trim();
      if (state === 'pre') {
        if (!line) continue;
        const named = /^(?:#|\/\/)\s*@name\s+(\S+)/.exec(line);
        if (named) {
          name = named[1];
          continue;
        }
        if (isComment(line)) continue;
        const v = VARIABLE.exec(line);
        if (v) {
          vars[v[1]] = v[2].trim();
          continue;
        }
        const m = REQUEST_LINE.exec(line) ?? (URL_ONLY.test(line) ? ['', 'GET', line] : null);
        if (!m) continue;
        req = { name, method: m[1].toUpperCase(), url: m[2].trim(), headers: [], body: '', line: k + 1, endLine: end };
        state = 'headers';
        continue;
      }
      if (state === 'headers' && req) {
        // a query split over lines: "?page=1" / "&size=10" right below the request line
        if (/^[?&]/.test(line) && req.headers.length === 0) {
          req.url += line;
          continue;
        }
        if (!line) {
          state = 'body';
          continue;
        }
        if (isComment(line)) continue;
        const h = HEADER.exec(line);
        if (h) req.headers.push([h[1], h[2].trim()]);
        continue;
      }
      if (state === 'body') body.push(raw);
    }
    if (req) {
      while (body.length && !body[body.length - 1].trim()) body.pop();
      const file = body.length === 1 ? /^<\s+(.+)$/.exec(body[0].trim()) : null;
      if (file) req.bodyFile = file[1].trim();
      else req.body = body.join('\n');
      requests.push(req);
    }
    i = end;
  }
  return { vars, requests };
}

/** The request whose block holds this 1-based line. */
export function requestAt(file: HttpFile, line: number): HttpRequestBlock | undefined {
  return file.requests.find((r, i) => line > (i === 0 ? 0 : file.requests[i - 1].endLine) && line <= r.endLine);
}

const DYNAMIC: Record<string, (arg: string) => string> = {
  $guid: () => crypto.randomUUID(),
  $uuid: () => crypto.randomUUID(),
  $random_uuid: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: (arg) => {
    const [min, max] = arg.split(/\s+/).filter(Boolean).map(Number);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 1000;
    return String(lo + Math.floor(Math.random() * Math.max(1, hi - lo)));
  },
  $datetime: (arg) => (/rfc1123/i.test(arg) ? new Date().toUTCString() : new Date().toISOString()),
  $localDatetime: () => new Date().toString(),
};

/**
 * Replaces {{name}} (file variables first, then the environment), {{$dynamic args}}, and variables that refer to
 * other variables. Returns the names nobody defined.
 */
export function substitute(text: string, vars: Record<string, string>, env: Record<string, string>, missing: Set<string>): string {
  const resolve = (s: string, depth: number): string =>
    s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr: string) => {
      const [head, ...rest] = expr.split(/\s+/);
      if (head.startsWith('$')) {
        const fn = DYNAMIC[head];
        if (fn) return fn(rest.join(' '));
        missing.add(head);
        return whole;
      }
      const value = vars[head] ?? env[head];
      if (value === undefined) {
        missing.add(head);
        return whole;
      }
      return depth > 5 ? value : resolve(value, depth + 1);
    });
  return resolve(text, 0);
}

/** The request as a curl command (Copy as cURL). */
export function toCurl(r: { method: string; url: string; headers: [string, string][]; body: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = ['curl', '-X', r.method, q(r.url)];
  for (const [k, v] of r.headers) parts.push('-H', q(`${k}: ${v}`));
  if (r.body) parts.push('--data-raw', q(r.body));
  return parts.join(' ');
}
