import { CircleAlert, Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { canStopUpdateDownload, describeUpdate, openReleasePage, restartToUpdate, stopUpdateDownload } from '../app/updates';
import { updateNotice, useUpdates } from '../store/updates';
import { openSettings } from './settings/nav';
import './updates.css';

/**
 * The update state at the right of the status bar (Rowlit): checking, a new version available, download progress with
 * a stop (×) control, "Restart to update" once it is ready, or a muted mark after a failed check. A click opens
 * Settings › Updates; on "Restart to update" it restarts.
 */
export function UpdateChip() {
  const status = useUpdates((s) => s.status);
  const d = describeUpdate(status);
  if (!status || !d.chip) return null;
  const ready = status.state === 'ready' && status.mode === 'install';
  const error = status.state === 'error';
  const downloading = status.state === 'downloading';
  const Icon = status.state === 'checking' ? LoaderCircle : ready ? RefreshCw : error ? CircleAlert : Download;
  const main = (
    <button
      type="button"
      className={`sb-item sb-update tone-${d.tone}${ready ? ' ready' : ''}`}
      onClick={() => (ready ? void restartToUpdate() : openSettings('updates'))}
      title={ready ? `${d.text} Click to restart now.` : `${d.text} Click for update settings.`}
      aria-label={error ? 'Update check failed — update settings' : ready ? `Restart to update to Kod ${status.version}` : d.chip}
    >
      <Icon size={12} className={status.state === 'checking' ? 'spin' : undefined} aria-hidden="true" />
      {!error && <span className="sb-update-label">{d.chip}</span>}
      {d.percent !== undefined && (
        <span className="sb-update-bar" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.percent}>
          <span className="sb-update-fill" style={{ width: `${d.percent}%` }} />
        </span>
      )}
    </button>
  );
  if (!downloading || !canStopUpdateDownload()) return main;
  return (
    <span className="sb-update-group">
      {main}
      <button type="button" className="sb-item sb-update-stop" onClick={() => void stopUpdateDownload()} title="Stop download" aria-label="Stop download">
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

/** Persistent card in the toast stack: "Kod X.Y.Z is ready — Restart now / Later" (or "available — Download"). */
export function UpdateNotice() {
  const status = useUpdates((s) => s.status);
  const dismissed = useUpdates((s) => s.dismissed);
  const notice = updateNotice(status, dismissed);
  if (!notice) return null;
  const ready = notice.kind === 'ready';
  const later = () => useUpdates.getState().dismiss(notice.version);
  return (
    <div className="toast toast-info update-notice" role="group" aria-label="Update">
      {ready ? <RefreshCw size={16} className="sev-info" /> : <Download size={16} className="sev-info" />}
      <div className="toast-body">
        <div>
          Kod {notice.version} is {ready ? 'ready' : 'available'}
        </div>
        <div className="toast-detail">{ready ? 'Restart to finish updating, or it installs when you quit.' : 'Download the new version from GitHub.'}</div>
        <div className="update-notice-actions">
          {ready ? (
            <button type="button" className="btn btn-xs btn-primary" onClick={() => void restartToUpdate()}>
              Restart now
            </button>
          ) : (
            <button type="button" className="btn btn-xs btn-primary" onClick={() => openReleasePage(notice.releaseUrl)}>
              Download
            </button>
          )}
          <button type="button" className="btn btn-xs" onClick={later}>
            Later
          </button>
        </div>
      </div>
      <button type="button" className="icon-btn sm" onClick={later} aria-label="Dismiss update notice">
        <X size={14} />
      </button>
    </div>
  );
}
