// Auto-update through GitHub Releases (electron-updater reads latest.yml from the release). The state machine is in
// updater-core.ts; this file wires Electron to it. Disabled in dev runs, unpackaged builds, smoke tests, on Linux and
// with KOD_DISABLE_UPDATES=1. Windows: background download, then "Restart now / Later"; Later installs on quit.
import { app, BrowserWindow } from 'electron';
import { UpdateController, updateModeFor, type UpdaterLike, type UpdateStatus } from './updater-core';

function broadcast(status: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:status', status);
}

function disabledReason(smokeTest: boolean): string | null {
  if (smokeTest) return 'Updates are off during the smoke test.';
  if (!app.isPackaged) return 'Updates are only checked in installed builds.';
  if (process.env.KOD_DISABLE_UPDATES === '1') return 'Updates are turned off (KOD_DISABLE_UPDATES).';
  if (process.platform === 'linux') return 'Automatic updates are not available on Linux.';
  return null;
}

export async function createUpdater(log: (m: string) => void, smokeTest: boolean): Promise<UpdateController> {
  const currentVersion = app.getVersion();
  const reason = disabledReason(smokeTest);
  if (reason) return new UpdateController({ updater: null, mode: 'disabled', disabledReason: reason, currentVersion, send: broadcast, log });
  try {
    const { autoUpdater } = await import('electron-updater');
    const { CancellationToken } = await import('builder-util-runtime');
    const prefix = (level: string) => (...args: unknown[]) => log(`[${level}] ${args.map(String).join(' ')}`);
    autoUpdater.logger = { info: prefix('info'), warn: prefix('warn'), error: prefix('error'), debug: () => undefined };
    return new UpdateController({
      updater: autoUpdater as unknown as UpdaterLike,
      mode: updateModeFor(process.platform),
      currentVersion,
      send: broadcast,
      log,
      createCanceller: () => new CancellationToken(),
      silentInstall: process.platform === 'win32',
    });
  } catch (e) {
    log(`updates disabled: ${(e as Error).message}`);
    return new UpdateController({ updater: null, mode: 'disabled', disabledReason: 'The updater could not be started.', currentVersion, send: broadcast, log });
  }
}
