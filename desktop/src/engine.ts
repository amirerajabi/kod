// Engine sidecar: find how to launch it, spawn it, wait for "KOD_READY {port, token}", kill the whole tree on quit.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

export interface EngineInfo {
  baseUrl: string;
  token: string;
}

interface Launch {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}

const READY = 'KOD_READY ';
const exe = process.platform === 'win32' ? 'Kod.Engine.exe' : 'Kod.Engine';

/**
 * KOD_ENGINE_PATH → a prebuilt engine; packaged → resources/engine; dev → the Debug build if present,
 * otherwise `dotnet run` (which compiles first, so it gets a long timeout).
 */
export function resolveLaunch(opts: { isPackaged: boolean; resourcesPath: string; repoRoot: string; dev: boolean }): Launch {
  const extra = ['--parent-pid', String(process.pid), ...(opts.dev ? ['--dev'] : [])];
  if (process.env.KOD_ENGINE_PATH) return { command: process.env.KOD_ENGINE_PATH, args: extra, cwd: path.dirname(process.env.KOD_ENGINE_PATH), timeoutMs: 30_000 };
  if (opts.isPackaged) {
    const dir = path.join(opts.resourcesPath, 'engine');
    return { command: path.join(dir, exe), args: extra, cwd: dir, timeoutMs: 30_000 };
  }
  const project = path.join(opts.repoRoot, 'engine', 'src', 'Kod.Engine');
  const built = path.join(project, 'bin', 'Debug', 'net10.0', exe);
  if (fs.existsSync(built)) return { command: built, args: extra, cwd: path.dirname(built), timeoutMs: 30_000 };
  return { command: 'dotnet', args: ['run', '--project', project, '--', ...extra], cwd: opts.repoRoot, timeoutMs: 240_000 };
}

export class Engine {
  private child: ChildProcess | null = null;
  private stopping = false;
  info: EngineInfo | null = null;
  readonly tail: string[] = [];

  constructor(
    private readonly launch: Launch,
    private readonly onExit: (code: number | null) => void,
  ) {}

  start(): Promise<EngineInfo> {
    const token = randomBytes(24).toString('hex');
    return new Promise((resolve, reject) => {
      const child = spawn(this.launch.command, [...this.launch.args, '--token', token], {
        cwd: this.launch.cwd,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.child = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`The engine did not start within ${this.launch.timeoutMs / 1000} s.\n${this.tail.slice(-15).join('\n')}`));
        this.stop();
      }, this.launch.timeoutMs);
      const remember = (line: string) => {
        this.tail.push(line);
        if (this.tail.length > 80) this.tail.shift();
      };
      readline.createInterface({ input: child.stdout! }).on('line', (line) => {
        if (!this.info && line.startsWith(READY)) {
          try {
            const { port } = JSON.parse(line.slice(READY.length)) as { port: number };
            this.info = { baseUrl: `http://127.0.0.1:${port}`, token };
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(this.info);
            }
            return;
          } catch {
            /* not the handshake */
          }
        }
        remember(line);
      });
      readline.createInterface({ input: child.stderr! }).on('line', (line) => {
        remember(line);
        if (process.env.KOD_ENGINE_LOG) console.error(`[engine] ${line}`);
      });
      child.stdin?.on('error', () => undefined);
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Could not start the engine (${this.launch.command}): ${err.message}`));
      });
      child.once('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`The engine exited (code ${code}) before it was ready.\n${this.tail.slice(-15).join('\n')}`));
        }
        if (!this.stopping) this.onExit(code);
      });
    });
  }

  /** Kills the engine and everything it started (running programs, builds, the terminal). */
  stop(): void {
    this.stopping = true;
    const pid = this.child?.pid;
    if (!pid || this.child?.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        this.child?.kill('SIGTERM');
      }
    }
  }
}
