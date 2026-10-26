// Auto-update in the renderer (the Rowlit flow): mirrors the main process status (desktop/src/updater-core.ts) into the
// updates store, reports the "Automatically check for updates" setting, announces a new version once, and implements
// Check for Updates. The main process does the checking, downloading and installing; nothing here is a modal dialog.
// The status bar chip and Settings › Updates show the same state machine (describeUpdate).
import { platform, type UpdateStatus } from '../platform';
import { useSettings } from '../store/settings';
import { toast } from '../store/ui';
import { useUpdates } from '../store/updates';

export const REPO_URL = 'https://github.com/amirerajabi/kod';
export const RELEASES_URL = `${REPO_URL}/releases`;

const announced = new Set<string>();

/** One toast / OS notification per version and kind. */
function announceUpdate(prev: UpdateStatus | null, next: UpdateStatus): void {
  const v = next.version;
  if (!v || next.downloadStopped || (prev?.state === next.state && prev?.version === v)) return;
  const once = (key: string) => {
    if (announced.has(`${key}:${v}`)) return false;
    announced.add(`${key}:${v}`);
    return true;
  };
  const notify = (title: string, body: string) => platform.showNotification?.({ title, body });
  if (next.mode === 'install' && (next.state === 'available' || next.state === 'downloading') && once('arrived')) {
    toast('info', `Kod ${v} is available`, 'Downloading in the background — progress is in the status bar.');
  } else if (next.mode === 'install' && next.state === 'ready' && once('ready')) {
    announced.add(`arrived:${v}`);
    notify(`Kod ${v} is ready`, 'Restart Kod to finish updating, or it installs when you quit.');
  } else if (next.mode === 'notify' && next.state === 'available' && once('ready')) {
    notify(`Kod ${v} is available`, 'Download the new version from GitHub.');
  }
}

/** Status subscription and the auto-check setting (the main process checks nothing until it hears it). */
export function installUpdateWiring(): void {
  if (!platform.onUpdateStatus) return;
  platform.onUpdateStatus((s) => {
    const prev = useUpdates.getState().status;
    useUpdates.getState().setStatus(s);
    announceUpdate(prev, s);
  });
  platform.getUpdateStatus?.().then((s) => {
    useUpdates.getState().setStatus(s);
    if (s.version && (s.state === 'ready' || s.state === 'downloading' || s.state === 'available')) {
      announced.add(`arrived:${s.version}`);
      if (s.state === 'ready' || s.mode === 'notify') announced.add(`ready:${s.version}`);
    }
  }, () => undefined);
  const configure = () => platform.configureUpdates?.({ autoCheck: useSettings.getState().settings.autoCheckUpdates })?.catch(() => undefined);
  configure();
  useSettings.subscribe((s, prev) => s.settings.autoCheckUpdates !== prev.settings.autoCheckUpdates && configure());
}

function report(s: UpdateStatus): void {
  switch (s.state) {
    case 'up-to-date':
      toast('success', "You're up to date", `Kod ${s.currentVersion} is the latest version.`);
      break;
    case 'downloading':
      if (s.version && announced.has(`arrived:${s.version}`)) break;
      if (s.version) announced.add(`arrived:${s.version}`);
      toast('info', s.version ? `Downloading Kod ${s.version}…` : 'Downloading the update…', "You'll be asked to restart when it is ready.");
      break;
    case 'disabled':
      toast('info', 'Updates are not checked in this build', s.message);
      break;
    case 'error':
      toast('warning', "Couldn't check for updates", s.message);
      break;
    default:
      break;
  }
}

/** Check for Updates. The browser build has no updater: it opens the releases page instead. */
export async function checkForUpdatesNow(): Promise<void> {
  if (!platform.checkForUpdates) {
    platform.openExternal(RELEASES_URL);
    return;
  }
  useUpdates.getState().setStatus({ ...(useUpdates.getState().status ?? { mode: 'install', currentVersion: platform.appVersion ?? '' }), state: 'checking' });
  let s: UpdateStatus;
  try {
    s = await platform.checkForUpdates({ manual: true });
  } catch (e) {
    toast('warning', "Couldn't check for updates", e instanceof Error ? e.message : String(e));
    return;
  }
  const u = useUpdates.getState();
  u.undismiss();
  u.setStatus(s);
  report(s);
}

export async function restartToUpdate(): Promise<void> {
  const ok = await platform.quitAndInstall?.().catch(() => false);
  if (!ok) toast('warning', 'The update could not be installed now', 'It will be installed when Kod quits.');
}

export const canStopUpdateDownload = () => typeof platform.cancelUpdateDownload === 'function';

export async function stopUpdateDownload(): Promise<void> {
  await platform.cancelUpdateDownload?.().catch(() => undefined);
  const s = await platform.getUpdateStatus?.().catch(() => undefined);
  if (s) useUpdates.getState().setStatus(s);
}

export const resumeUpdateDownload = () => checkForUpdatesNow();

export function openReleasePage(url?: string): void {
  platform.openExternal(url ?? RELEASES_URL);
}

export type UpdateTone = 'muted' | 'busy' | 'accent' | 'success' | 'warning';

export interface UpdateDescription {
  tone: UpdateTone;
  /** Settings › Updates status line. */
  text: string;
  /** Status bar chip label (null: no chip). */
  chip: string | null;
  percent?: number;
  stopped?: boolean;
}

/** One line about the update state, shared by the status bar chip and Settings › Updates. */
export function describeUpdate(s: UpdateStatus | null): UpdateDescription {
  const v = s?.version;
  switch (s?.state) {
    case 'checking':
      return { tone: 'busy', text: 'Checking for updates…', chip: 'Checking for updates…' };
    case 'up-to-date':
      return { tone: 'success', text: `You're up to date — Kod ${s.currentVersion} is the latest version.`, chip: null };
    case 'available':
      if (s.downloadStopped) return { tone: 'accent', text: `Download stopped — Kod ${v} is available.`, chip: 'Download stopped', stopped: true };
      return s.mode === 'notify'
        ? { tone: 'accent', text: `Kod ${v} is available to download.`, chip: `v${v} available` }
        : { tone: 'accent', text: `Kod ${v} is available — downloading in the background…`, chip: `v${v} available` };
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.round(s.percent ?? 0)));
      return { tone: 'busy', text: `Downloading Kod ${v ?? 'update'}… ${percent}%`, chip: `Downloading ${percent}%`, percent };
    }
    case 'ready':
      return { tone: 'accent', text: `Kod ${v} is ready — restart to finish updating (or it installs when you quit).`, chip: 'Restart to update' };
    case 'error':
      return { tone: 'warning', text: `Couldn't check for updates${s.message ? `: ${s.message}` : '.'}`, chip: 'Update check failed' };
    case 'disabled':
      return { tone: 'muted', text: s.message ?? 'Updates are not checked in this build.', chip: null };
    case 'idle':
      return { tone: 'muted', text: 'Not checked yet in this session.', chip: null };
    default:
      return { tone: 'muted', text: 'Updates come with the desktop app.', chip: null };
  }
}
