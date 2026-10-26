// Settings › Updates (Rowlit): the installed version, "Check for updates", the update state (the same state machine as
// the status bar chip), automatic checks and the release notes. The browser build links to the releases page.
import { CircleAlert, CircleCheck, Download, ExternalLink, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { canStopUpdateDownload, checkForUpdatesNow, describeUpdate, openReleasePage, RELEASES_URL, restartToUpdate, resumeUpdateDownload, stopUpdateDownload } from '../../app/updates';
import { platform } from '../../platform';
import { useSettings } from '../../store/settings';
import { useUpdates } from '../../store/updates';
import { KodMark } from '../common/icons';
import { Card, SearchBlock, ToggleRow } from './controls';

export function UpdatesCard() {
  const desktop = typeof platform.checkForUpdates === 'function';
  const status = useUpdates((s) => s.status);
  const autoCheck = useSettings((s) => s.settings.autoCheckUpdates);
  const d = describeUpdate(desktop ? status : null);
  const busy = status?.state === 'checking' || status?.state === 'downloading';
  const ready = status?.state === 'ready' && status.mode === 'install';
  const notifyAvailable = status?.state === 'available' && status.mode === 'notify';
  const downloading = status?.state === 'downloading' && canStopUpdateDownload();
  const version = status?.currentVersion ?? platform.appVersion;
  const Icon = busy ? LoaderCircle : ready ? RefreshCw : status?.state === 'available' ? Download : status?.state === 'error' ? CircleAlert : CircleCheck;
  const releaseUrl = status?.releaseUrl ?? RELEASES_URL;

  return (
    <>
      <Card title="Kod" description={desktop ? 'Updates are downloaded in the background from GitHub Releases and installed when you restart.' : 'New versions are published on GitHub Releases.'}>
        <SearchBlock keywords="updates version check for updates new release notes download restart install about kod">
          <div className="upd-hero">
            <span className="upd-logo" aria-hidden="true">
              <KodMark size={28} />
            </span>
            <div className="upd-info">
              <div className="upd-version">{desktop ? <>Version <span className="tabular">{version}</span></> : 'Kod in the browser'}</div>
              {desktop ? (
                <div className={`upd-status tone-${d.tone}`} role="status" aria-live="polite">
                  <Icon size={14} className={busy ? 'spin' : undefined} aria-hidden="true" />
                  <span>{d.text}</span>
                </div>
              ) : (
                <div className="upd-status tone-muted">The desktop app updates itself.</div>
              )}
              {d.percent !== undefined && (
                <div className="upd-progress" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.percent}>
                  <span style={{ width: `${d.percent}%` }} />
                </div>
              )}
            </div>
            <div className="upd-actions">
              {ready ? (
                <button type="button" className="btn btn-primary" onClick={() => void restartToUpdate()}>
                  <RefreshCw size={16} /> Restart now
                </button>
              ) : notifyAvailable ? (
                <button type="button" className="btn btn-primary" onClick={() => openReleasePage(status?.releaseUrl)}>
                  <Download size={16} /> Download
                </button>
              ) : downloading ? (
                <button type="button" className="btn" onClick={() => void stopUpdateDownload()}>
                  <Square size={14} /> Stop download
                </button>
              ) : d.stopped ? (
                <button type="button" className="btn btn-primary" onClick={() => void resumeUpdateDownload()}>
                  <Download size={16} /> Resume download
                </button>
              ) : desktop ? (
                <button type="button" className="btn" disabled={busy} onClick={() => void checkForUpdatesNow()}>
                  <RefreshCw size={16} className={status?.state === 'checking' ? 'spin' : undefined} /> Check for updates
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => openReleasePage()}>
                  <ExternalLink size={16} /> Releases page
                </button>
              )}
            </div>
          </div>
          <div className="upd-links">
            <button type="button" className="link-btn" onClick={() => openReleasePage(releaseUrl)}>
              {status?.version && status.state !== 'up-to-date' ? `What's new in ${status.version}` : 'Release notes'} <ExternalLink size={12} aria-hidden="true" />
            </button>
          </div>
        </SearchBlock>
      </Card>
      {desktop && (
        <Card title="Automatic updates">
          <ToggleRow
            id="set-updates"
            label="Automatically check for updates"
            hint="At startup and every 6 hours; you'll be notified when a new version is ready"
            keywords="update version release download"
            checked={autoCheck}
            onChange={(v) => useSettings.getState().update({ autoCheckUpdates: v })}
          />
        </Card>
      )}
    </>
  );
}
