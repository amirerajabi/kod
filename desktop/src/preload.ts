// The window.kod bridge (ui/src/platform.ts). Only these calls cross into the main process.
import { contextBridge, ipcRenderer } from 'electron';

type EngineInfo = { baseUrl: string; token: string };

const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';

contextBridge.exposeInMainWorld('kod', {
  kind: 'electron',
  os,
  titleBar: os === 'win32' ? 'overlay' : os === 'darwin' ? 'inset' : 'native',
  getEngine: (): Promise<EngineInfo> => ipcRenderer.invoke('engine:info'),
  pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:folder', title),
  pickFile: (title?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> => ipcRenderer.invoke('dialog:file', title, filters),
  setTitle: (title: string) => ipcRenderer.send('win:title', String(title)),
  setTitleBarTheme: (t: { color: string; symbolColor: string; dark: boolean }) => ipcRenderer.send('win:titlebar', t),
  reveal: (p: string) => ipcRenderer.send('shell:reveal', String(p)),
  openExternal: (url: string) => ipcRenderer.send('shell:open', String(url)),
  onEngineRestarted: (cb: (info: EngineInfo) => void) => {
    const h = (_e: unknown, info: EngineInfo) => cb(info);
    ipcRenderer.on('engine:restarted', h);
    return () => ipcRenderer.removeListener('engine:restarted', h);
  },
  appVersion: process.argv.find((a) => a.startsWith('--kod-version='))?.slice('--kod-version='.length) ?? '0.0.0',
  // ---- updates (the Rowlit updater)
  onUpdateStatus: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('update:status', h);
    return () => ipcRenderer.removeListener('update:status', h);
  },
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: (opts?: { manual?: boolean }) => ipcRenderer.invoke('update:check', { manual: opts?.manual === true }),
  configureUpdates: (opts: { autoCheck: boolean }) => ipcRenderer.invoke('update:configure', { autoCheck: opts?.autoCheck === true }),
  quitAndInstall: () => ipcRenderer.invoke('update:install'),
  cancelUpdateDownload: () => ipcRenderer.invoke('update:cancel'),
  showNotification: (n: { title: string; body: string }) => void ipcRenderer.invoke('notify', { title: String(n?.title ?? ''), body: String(n?.body ?? '') }),
  // ---- secrets (AI API keys, encrypted by the OS)
  hasSecret: (name: string): Promise<boolean> => ipcRenderer.invoke('secrets:has', String(name)),
  getSecret: (name: string): Promise<string | null> => ipcRenderer.invoke('secrets:get', String(name)),
  setSecret: (name: string, value: string | null): Promise<void> => ipcRenderer.invoke('secrets:set', String(name), value === null ? null : String(value)),
});
