// Publishes the engine, starts it like the desktop shell does (KOD_READY handshake), and checks that Roslyn answers:
// a completion list after `list.` in a loose C# file. Fails the job on any mismatch.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const out = mkdtempSync(join(tmpdir(), 'kod-engine-'));
execFileSync('dotnet', ['publish', 'engine/src/Kod.Engine/Kod.Engine.csproj', '-c', 'Release', '-o', out, '-nologo', '-v:q'], { stdio: 'inherit' });

const exe = join(out, process.platform === 'win32' ? 'Kod.Engine.exe' : 'Kod.Engine');
const secret = 'ci-smoke';
const child = spawn(exe, ['--port', '0', '--token', secret], { stdio: ['pipe', 'pipe', 'inherit'] });
const fail = (msg) => {
  console.log(`::error::${msg}`);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail('the engine did not report ready within 60 s'), 60_000);

const port = await new Promise((resolve) => {
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('KOD_READY ')) resolve(JSON.parse(line.slice(10)).port);
  });
});
clearTimeout(timer);
const base = `http://127.0.0.1:${port}/api`;
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };

const health = await fetch(`${base}/health`);
if (!health.ok) fail(`/api/health answered ${health.status}`);

const dir = mkdtempSync(join(tmpdir(), 'kod-smoke-'));
const file = join(dir, 'Program.cs');
const text = 'var list = new List<int> { 3, 1, 2 };\nlist.\n';
writeFileSync(file, text);
const res = await fetch(`${base}/intel/completion`, { method: 'POST', headers, body: JSON.stringify({ path: file, text, line: 2, column: 6, triggerCharacter: '.' }) });
if (!res.ok) fail(`completion answered ${res.status}: ${await res.text()}`);
const list = await res.json();
const labels = list.items.map((i) => i.label);
if (!labels.includes('Add') || !labels.includes('Sort')) fail(`completion after "list." lacks Add/Sort (${labels.length} items)`);
console.log(`engine smoke OK: ${labels.length} completions after "list."`);

const exited = new Promise((r) => child.once('exit', r));
child.kill();
await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
// best effort: Windows may hold the binary a moment longer
for (const p of [dir, out]) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    /* the runner is discarded anyway */
  }
}
process.exit(0);
