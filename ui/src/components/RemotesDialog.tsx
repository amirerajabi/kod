import { Check, Globe, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../api/client';
import { refreshGit } from '../store/git';
import { askConfirm, toast, useUi } from '../store/ui';
import { Dialog } from './common/Dialog';

interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

interface Draft {
  oldName?: string;
  name: string;
  url: string;
}

/** Git › Manage Remotes (Rider's Git Remotes dialog): list, add, edit name and URL, remove. */
export function RemotesDialog() {
  const open = useUi((s) => s.remotesOpen);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => void api.get<Remote[]>('/git/remotes').then(setRemotes, (e) => setError(errorText(e)));
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(null);
    load();
  }, [open]);

  if (!open) return null;
  const close = () => useUi.getState().set({ remotesOpen: false });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (draft.oldName) await api.post('/git/remotes/update', { name: draft.name.trim(), url: draft.url.trim(), oldName: draft.oldName });
      else await api.post('/git/remotes/add', { name: draft.name.trim(), url: draft.url.trim() });
      setDraft(null);
      load();
      refreshGit(0);
      toast('success', draft.oldName ? `Updated remote ${draft.name.trim()}` : `Added remote ${draft.name.trim()}`, undefined, 2500);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: Remote) => {
    if ((await askConfirm({ title: 'Remove remote', message: `Remove the remote ${r.name} (${r.fetchUrl})?\n\nIts remote-tracking branches are removed too; nothing on the server changes.`, okLabel: 'Remove', danger: true })) !== 'ok') return;
    try {
      await api.post('/git/remotes/remove', { name: r.name, url: r.fetchUrl });
      load();
      refreshGit(0);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const editor = draft && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginTop: 8 }}>
      <div className="form-grid" style={{ gridTemplateColumns: '60px 1fr' }}>
        <label className="form-label" htmlFor="rm-name">Name</label>
        <input id="rm-name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus={!draft.oldName} />
        <label className="form-label" htmlFor="rm-url">URL</label>
        <input
          id="rm-url"
          className="input"
          placeholder="https://github.com/you/repo.git  or  git@github.com:you/repo.git"
          value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && draft.name.trim() && draft.url.trim() && void save()}
          autoFocus={!!draft.oldName}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn btn-xs" onClick={() => setDraft(null)}>
          <X size={12} /> Cancel
        </button>
        <button className="btn btn-xs btn-primary" disabled={busy || !draft.name.trim() || !draft.url.trim()} onClick={() => void save()}>
          <Check size={12} /> {draft.oldName ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  );

  return (
    <Dialog
      title="Git Remotes"
      onClose={close}
      width={620}
      footer={
        <button className="btn btn-primary" onClick={close}>
          Done
        </button>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span className="muted" style={{ flex: 1 }}>
          Remotes are the servers you fetch from and push to.
        </span>
        <button className="btn btn-xs" disabled={!!draft} onClick={() => setDraft({ name: remotes.some((r) => r.name === 'origin') ? '' : 'origin', url: '' })}>
          <Plus size={12} /> Add remote
        </button>
      </div>
      {remotes.length === 0 && !draft && <div className="panel-empty">No remotes yet. Add one to push your commits.</div>}
      {remotes.map((r) =>
        draft?.oldName === r.name ? (
          <div key={r.name}>{editor}</div>
        ) : (
          <div key={r.name} className="pkg" style={{ cursor: 'default' }}>
            <div className="pkg-icon">
              <Globe size={16} />
            </div>
            <div className="pkg-body">
              <div className="pkg-name">
                <span>{r.name}</span>
              </div>
              <div className="pkg-desc" style={{ userSelect: 'text' }}>
                {r.fetchUrl}
                {r.pushUrl !== r.fetchUrl && <> (push: {r.pushUrl})</>}
              </div>
            </div>
            <button className="icon-btn sm" title="Edit" disabled={!!draft} onClick={() => setDraft({ oldName: r.name, name: r.name, url: r.fetchUrl })}>
              <Pencil size={13} />
            </button>
            <button className="icon-btn sm" title="Remove" disabled={!!draft} onClick={() => void remove(r)}>
              <Trash2 size={13} />
            </button>
          </div>
        ),
      )}
      {draft && !draft.oldName && editor}
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}
