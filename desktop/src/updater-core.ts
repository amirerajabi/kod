// Auto-update state machine (the Rowlit updater, electron-free so it stays testable). updater.ts wires it to
// electron-updater, the app and the renderer.
//
//   idle --check--> checking --> up-to-date
//                            \-> install mode: downloading --> ready  (Windows, signed macOS: Restart now / Later)
//                                                  \-- stopDownload() --> available (downloadStopped): no automatic check or
//                                                       timer restarts that version; a manual check resumes it
//                            \-> notify mode:  available             (ad-hoc signed macOS: open the release page)
//   any --error--> error (logged; a manual check reports it gently, automatic checks stay silent)
//   disabled: dev runs, unpackaged builds, Linux, smoke tests. Nothing is ever checked.

export type UpdateMode = 'install' | 'notify' | 'disabled';
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  mode: UpdateMode;
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
  releaseUrl?: string;
  downloadStopped?: boolean;
}

/** GitHub repository the releases (and latest.yml) are published to (electron-builder.yml publish). */
export const RELEASE_OWNER = 'amirerajabi';
export const RELEASE_REPO = 'kod';
export const RELEASES_URL = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases`;

/** First automatic check after start, then every 6 hours. */
export const INITIAL_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function releasePageUrl(version: string | undefined): string {
  return version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL;
}

/** builder-util-runtime's CancellationToken, as far as the controller uses it. */
export interface Canceller {
  cancel(): void;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease?: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  downloadUpdate?(cancel?: Canceller): Promise<unknown>;
}

export interface UpdateControllerOptions {
  updater: UpdaterLike | null;
  mode: UpdateMode;
  disabledReason?: string;
  currentVersion: string;
  send(status: UpdateStatus): void;
  log(message: string): void;
  silentInstall?: boolean;
  createCanceller?(): Canceller;
}

function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].slice(0, 300);
}

export class UpdateController {
  private current: UpdateStatus;
  private readonly startedAt = Date.now();
  private firstTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<UpdateStatus> | null = null;
  private autoCheck = false;
  private download: { canceller: Canceller; version?: string } | null = null;
  private unwinding: Promise<void> = Promise.resolve();
  private readonly stopped = new Set<string>();

  constructor(private readonly o: UpdateControllerOptions) {
    const mode = o.updater ? o.mode : 'disabled';
    this.current = o.updater
      ? { state: 'idle', mode, currentVersion: o.currentVersion }
      : { state: 'disabled', mode, currentVersion: o.currentVersion, message: o.disabledReason ?? 'Updates are not available in this build.' };
    const u = o.updater;
    if (!u) return;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = o.mode === 'install';
    u.allowPrerelease = false;
    u.on('checking-for-update', () => this.set({ state: 'checking' }));
    u.on('update-available', (info: { version?: string }) => {
      this.o.log(`update available: ${info?.version} (${o.mode})`);
      this.onAvailable(info?.version);
    });
    u.on('update-not-available', () => this.set({ state: 'up-to-date' }));
    u.on('download-progress', (p: { percent?: number }) => {
      if (this.current.state !== 'downloading') return;
      const percent = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
      if (percent !== this.current.percent) this.set({ ...this.current, percent });
    });
    u.on('update-downloaded', (info: { version?: string }) => {
      const version = info?.version ?? this.current.version;
      this.o.log(`update downloaded: ${version}`);
      this.set({ state: 'ready', version, releaseUrl: releasePageUrl(version) });
    });
    u.on('error', (e: unknown) => this.fail(e));
  }

  get status(): UpdateStatus {
    return this.current;
  }

  /** The renderer reports "Automatically check for updates"; nothing is checked automatically before that. */
  configure(opts: { autoCheck: boolean }): void {
    if (!this.o.updater || opts.autoCheck === this.autoCheck) return;
    this.autoCheck = opts.autoCheck;
    this.clearTimers();
    if (!opts.autoCheck) return;
    const delay = Math.max(0, INITIAL_CHECK_DELAY_MS - (Date.now() - this.startedAt));
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.check();
    }, delay);
    this.intervalTimer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.firstTimer.unref?.();
    this.intervalTimer.unref?.();
  }

  check(opts: { manual?: boolean } = {}): Promise<UpdateStatus> {
    const u = this.o.updater;
    if (!u) return Promise.resolve(this.current);
    if (this.current.state === 'ready' || this.current.state === 'downloading') return Promise.resolve(this.current);
    if (this.inflight) return this.inflight;
    if (opts.manual) this.stopped.clear();
    this.inflight = (async () => {
      try {
        this.set({ state: 'checking' });
        const r = await u.checkForUpdates();
        if (this.current.state === 'checking') {
          if (!r || !r.isUpdateAvailable) this.set({ state: 'up-to-date' });
          else this.onAvailable(r.updateInfo?.version);
        }
      } catch (e) {
        this.fail(e);
      } finally {
        this.inflight = null;
      }
      return this.current;
    })();
    return this.inflight;
  }

  stopDownload(): boolean {
    const d = this.download;
    if (!this.o.updater || this.current.state !== 'downloading' || !d) return false;
    this.download = null;
    if (d.version) this.stopped.add(d.version);
    this.set({ state: 'available', version: d.version, releaseUrl: releasePageUrl(d.version), downloadStopped: true });
    try {
      d.canceller.cancel();
    } catch (e) {
      this.o.log(`update download cancel failed: ${messageOf(e)}`);
    }
    return true;
  }

  quitAndInstall(): boolean {
    const u = this.o.updater;
    if (!u || this.o.mode !== 'install' || this.current.state !== 'ready') return false;
    this.clearTimers();
    if (this.o.silentInstall) u.quitAndInstall(true, true);
    else u.quitAndInstall();
    return true;
  }

  dispose(): void {
    this.clearTimers();
  }

  private onAvailable(version: string | undefined): void {
    if (this.o.mode !== 'install') this.set({ state: 'available', version, releaseUrl: releasePageUrl(version) });
    else if (version && this.stopped.has(version)) this.set({ state: 'available', version, releaseUrl: releasePageUrl(version), downloadStopped: true });
    else this.startDownload(version);
  }

  private startDownload(version: string | undefined): void {
    const u = this.o.updater;
    this.set({ state: 'downloading', version, percent: 0 });
    if (!u?.downloadUpdate || this.download) return;
    const mine = { canceller: this.o.createCanceller?.() ?? { cancel: () => undefined }, version };
    this.download = mine;
    const run = this.unwinding.then(() => (this.download === mine ? u.downloadUpdate!(mine.canceller) : undefined));
    this.unwinding = run.then(
      () => {
        if (this.download === mine) this.download = null;
      },
      (e: unknown) => {
        if (this.download !== mine) return;
        this.download = null;
        this.fail(e);
      },
    );
  }

  private fail(e: unknown): void {
    const message = messageOf(e);
    if (this.current.state === 'error' && this.current.message === message) return;
    this.o.log(`update error: ${message}`);
    if (this.current.state === 'ready') return;
    this.set({ state: 'error', message });
  }

  private set(next: Omit<UpdateStatus, 'mode' | 'currentVersion'>): void {
    const status = { ...next, mode: this.current.mode, currentVersion: this.o.currentVersion } as UpdateStatus;
    const keys = Object.keys(status) as (keyof UpdateStatus)[];
    if (keys.length === Object.keys(this.current).length && keys.every((k) => status[k] === this.current[k])) return;
    this.current = status;
    try {
      this.o.send(this.current);
    } catch (e) {
      this.o.log(`update status not delivered: ${messageOf(e)}`);
    }
  }

  private clearTimers(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.firstTimer = null;
    this.intervalTimer = null;
  }
}

export function updateModeFor(os: NodeJS.Platform, macSigned = false): UpdateMode {
  if (os === 'win32') return 'install';
  if (os === 'darwin') return macSigned ? 'install' : 'notify';
  return 'disabled';
}
