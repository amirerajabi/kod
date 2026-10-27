// The desktop bridge (desktop/src/preload.ts exposes window.kod) or, in a plain browser (npm run dev), a fallback
// that reads the engine address from ?engine=PORT&token=TOKEN and asks for paths with prompt().

export interface EngineInfo {
  baseUrl: string;
  token: string;
}

export interface Platform {
  kind: 'electron' | 'browser';
  os: 'win32' | 'darwin' | 'linux';
  /** How the window draws its caption: Windows overlay buttons, macOS inset traffic lights, or a native frame. */
  titleBar: 'overlay' | 'inset' | 'native';
  getEngine(): Promise<EngineInfo>;
  pickFolder(title?: string): Promise<string | null>;
  pickFile(title?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  setTitle(title: string): void;
  setTitleBarTheme(t: { color: string; symbolColor: string; dark: boolean }): void;
  reveal(path: string): void;
  openExternal(url: string): void;
  onEngineRestarted(cb: (info: EngineInfo) => void): () => void;
  appVersion?: string;
  // ---- updates (desktop only; the Rowlit updater)
  onUpdateStatus?(cb: (status: UpdateStatus) => void): () => void;
  getUpdateStatus?(): Promise<UpdateStatus>;
  checkForUpdates?(opts?: { manual?: boolean }): Promise<UpdateStatus>;
  configureUpdates?(opts: { autoCheck: boolean }): Promise<void>;
  quitAndInstall?(): Promise<boolean>;
  cancelUpdateDownload?(): Promise<boolean>;
  showNotification?(n: { title: string; body: string }): void;
  /** Desktop: called before the window closes; the shell waits (up to 5 s) for the returned promise. */
  onBeforeClose?(cb: () => Promise<void>): void;
  // ---- memory (desktop only): every Electron process, and dropping what the window can rebuild
  getProcessMemory?(): Promise<{ pid: number; type: string; name: string; workingSetKb: number; privateKb: number; cpu: number }[]>;
  freeRendererMemory?(): void;
  // ---- secrets (AI API keys); the desktop encrypts them with the OS keychain, the browser keeps them for the tab only
  hasSecret(name: string): Promise<boolean>;
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string | null): Promise<void>;
}

export type UpdateMode = 'install' | 'notify' | 'disabled';
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  /** install: downloaded in the background, restart to install. notify: only announced (unsigned macOS). */
  mode: UpdateMode;
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
  releaseUrl?: string;
  downloadStopped?: boolean;
}

declare global {
  interface Window {
    kod?: Platform;
  }
}

function browserPlatform(): Platform {
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? 'darwin' : /Win/.test(ua) ? 'win32' : 'linux';
  return {
    kind: 'browser',
    os,
    titleBar: 'native',
    async getEngine() {
      const q = new URLSearchParams(location.search);
      const port = q.get('engine') ?? sessionStorage.getItem('kod.engine.port');
      const token = q.get('token') ?? sessionStorage.getItem('kod.engine.token');
      if (!port || !token) throw new Error('Start the engine and open this page with ?engine=PORT&token=TOKEN');
      sessionStorage.setItem('kod.engine.port', port);
      sessionStorage.setItem('kod.engine.token', token);
      return { baseUrl: `http://127.0.0.1:${port}`, token };
    },
    async pickFolder(title) {
      return window.prompt(title ?? 'Folder path') || null;
    },
    async pickFile(title) {
      return window.prompt(title ?? 'File path') || null;
    },
    setTitle(title) {
      document.title = title;
    },
    setTitleBarTheme() {},
    reveal() {},
    openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },
    onEngineRestarted() {
      return () => {};
    },
    // npm run dev in a browser: no keychain, so keys live only as long as the tab
    async hasSecret(name) {
      return !!sessionStorage.getItem(`kod.secret.${name}`);
    },
    async getSecret(name) {
      return sessionStorage.getItem(`kod.secret.${name}`);
    },
    async setSecret(name, value) {
      if (value) sessionStorage.setItem(`kod.secret.${name}`, value);
      else sessionStorage.removeItem(`kod.secret.${name}`);
    },
  };
}

export const platform: Platform = window.kod ?? browserPlatform();

export const isMac = platform.os === 'darwin';
