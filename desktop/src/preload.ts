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
});
