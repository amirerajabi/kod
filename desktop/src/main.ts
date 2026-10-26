// Kod desktop shell: one window, the UI on kod://app (or the Vite dev server), the engine as a sidecar.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, Notification, protocol, safeStorage, screen, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine, resolveLaunch, type EngineInfo } from './engine';
import { createUpdater } from './updater';
import type { UpdateController } from './updater-core';

const DEV_URL = process.env.KOD_DEV_URL;
const repoRoot = path.resolve(__dirname, '..', '..');
const uiDir = app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(repoRoot, 'ui', 'dist');
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
/** The app icon for the window and the taskbar: resources/icon.png when installed, build/icon.png in dev. */
const iconFile = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '..', 'build', 'icon.png');
const smokeTest = !!process.env.KOD_SMOKE_SHOT;

// Windows groups taskbar buttons (and picks their icon) by AppUserModelId: the installer's shortcut uses the appId,
// so the running window must too, or the taskbar shows the default Electron icon.
if (process.platform === 'win32') app.setAppUserModelId('dev.kod.ide');

protocol.registerSchemesAsPrivileged([{ scheme: 'kod', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } }]);

// a smoke test runs beside an installed Kod: its own profile, no single-instance hand-off
if (process.env.KOD_SMOKE_SHOT) app.setPath('userData', path.join(app.getPath('temp'), `kod-smoke-${process.pid}`));
else if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let engineReady: Promise<EngineInfo> | null = null;
let restarts = 0;
let updater: UpdateController | null = null;
const updaterReady = app.whenReady().then(() => createUpdater((m) => console.log(`[updates] ${m}`), smokeTest)).then((u) => (updater = u));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  'connect-src http://127.0.0.1:* ws://127.0.0.1:*',
].join('; ');

function startEngine(): Promise<EngineInfo> {
  const launch = resolveLaunch({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot, dev: !!DEV_URL });
  const e = new Engine(launch, (code) => {
    // the engine died under us: restart it (a few times) and hand the new address to the UI
    if (restarts++ >= 3) {
      dialog.showErrorBox('Kod engine stopped', `The engine exited with code ${code} and could not be restarted.\n\n${e.tail.slice(-20).join('\n')}`);
      return;
    }
    engineReady = startEngine();
    void engineReady.then((info) => win?.webContents.send('engine:restarted', info)).catch((err: Error) => dialog.showErrorBox('Kod engine', err.message));
  });
  engine = e;
  return e.start();
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function loadState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as WindowState;
    if (s.width >= 600 && s.height >= 400) {
      if (s.x !== undefined && s.y !== undefined) {
        const area = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height }).workArea;
        if (s.x + 100 > area.x + area.width || s.y + 50 > area.y + area.height) return { width: s.width, height: s.height, maximized: s.maximized };
      }
      return s;
    }
  } catch {
    /* first start */
  }
  return { width: 1440, height: 920 };
}

function createWindow(): void {
  const state = loadState();
  const dark = nativeTheme.shouldUseDarkColors;
  const chrome: Electron.BrowserWindowConstructorOptions =
    process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: { color: dark ? '#1b1d21' : '#f5f6f8', symbolColor: dark ? '#e6e8eb' : '#1c1f24', height: 40 } }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
        : {};
  win = new BrowserWindow({
    ...state,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'Kod',
    backgroundColor: dark ? '#1b1d21' : '#f5f6f8',
    ...(fs.existsSync(iconFile) ? { icon: iconFile } : {}),
    autoHideMenuBar: true,
    ...chrome,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--kod-version=${app.getVersion()}`],
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.setMenu(null);

  const save = () => {
    if (!win) return;
    const b = win.getNormalBounds();
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch {
      /* best effort */
    }
  };
  win.on('close', save);
  win.on('closed', () => (win = null));

  // the renderer reports unsaved files through beforeunload
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: ['Quit without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'Some files have unsaved changes.',
      detail: 'Quit and lose the changes?',
    });
    if (choice === 0) e.preventDefault();
  });

  // the window only ever shows Kod; links open in the browser
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('kod://app') && !(DEV_URL && url.startsWith(DEV_URL))) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEV_URL) win.webContents.on('before-input-event', (_e, input) => input.key === 'F12' && input.control && input.shift && win?.webContents.toggleDevTools());

  void win.loadURL(DEV_URL ?? 'kod://app/index.html');

  // smoke test: KOD_SMOKE_SHOT=out.png captures the window once the UI has settled, then quits
  const shot = process.env.KOD_SMOKE_SHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const img = await win!.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        app.quit();
      }, Number(process.env.KOD_SMOKE_DELAY ?? 6000)),
    );
  }
}

ipcMain.handle('engine:info', () => engineReady ?? Promise.reject(new Error('The engine is not running')));
ipcMain.handle('dialog:folder', async (_e, title?: string) => {
  const r = await dialog.showOpenDialog(win!, { title: title ?? 'Open folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle('dialog:file', async (_e, title?: string, filters?: Electron.FileFilter[]) => {
  const r = await dialog.showOpenDialog(win!, { title: title ?? 'Open file', properties: ['openFile'], filters: Array.isArray(filters) ? filters : undefined });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.on('win:title', (_e, title: string) => win?.setTitle(String(title).slice(0, 300)));
ipcMain.on('win:titlebar', (_e, t: { color: string; symbolColor: string; dark: boolean }) => {
  const hex = /^#[0-9a-f]{6}$/i;
  nativeTheme.themeSource = t?.dark ? 'dark' : 'light';
  if (process.platform === 'win32' && win && hex.test(t?.color) && hex.test(t?.symbolColor)) win.setTitleBarOverlay({ color: t.color, symbolColor: t.symbolColor, height: 40 });
});
ipcMain.on('shell:reveal', (_e, p: string) => {
  if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p);
});
ipcMain.on('shell:open', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
});

// ---- updates (the Rowlit updater: status pushed as update:status)
ipcMain.handle('update:status', async () => (await updaterReady).status);
ipcMain.handle('update:check', async (_e, opts?: { manual?: boolean }) => (await updaterReady).check({ manual: opts?.manual === true }));
ipcMain.handle('update:configure', async (_e, opts?: { autoCheck?: boolean }) => (await updaterReady).configure({ autoCheck: opts?.autoCheck === true }));
ipcMain.handle('update:install', async () => (await updaterReady).quitAndInstall());
ipcMain.handle('update:cancel', async () => (await updaterReady).stopDownload());
ipcMain.handle('notify', (_e, n: { title?: string; body?: string }) => {
  if (win && !win.isFocused() && Notification.isSupported()) new Notification({ title: String(n?.title ?? 'Kod'), body: String(n?.body ?? ''), icon: iconFile }).show();
});

// ---- secrets (AI API keys): encrypted with the OS keychain (DPAPI / Keychain / libsecret) in userData/secrets.json
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}
const secretName = (name: unknown) => {
  const s = String(name ?? '');
  if (!/^[\w.-]{1,64}$/.test(s)) throw new Error('Invalid secret name');
  return s;
};
ipcMain.handle('secrets:has', (_e, name: string) => !!readSecrets()[secretName(name)]);
ipcMain.handle('secrets:get', (_e, name: string) => {
  const stored = readSecrets()[secretName(name)];
  if (!stored || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
});
ipcMain.handle('secrets:set', (_e, name: string, value: string | null) => {
  const all = readSecrets();
  const n = secretName(name);
  if (value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system has no secure storage for keys');
    all[n] = safeStorage.encryptString(String(value)).toString('base64');
  } else delete all[n];
  fs.writeFileSync(secretsFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  // kod://app/<path> serves the built UI
  protocol.handle('kod', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(uiDir, rel));
    if (!file.startsWith(uiDir)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!rel.endsWith('.html')) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });

  engineReady = startEngine();
  engineReady.catch((err: Error) => {
    dialog.showErrorBox('Kod could not start its engine', `${err.message}\n\nKod needs the .NET 10 SDK (dotnet) on PATH.`);
  });
  if (!DEV_URL && !fs.existsSync(path.join(uiDir, 'index.html'))) {
    dialog.showErrorBox('Kod', `The UI is not built (${uiDir}). Run "npm run build" in the ui folder.`);
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  updater?.dispose();
  engine?.stop();
});
process.on('exit', () => engine?.stop());
