import { History, LoaderCircle, RotateCw, Tag, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../api/client';
import { askConfirm, askText, toast } from '../store/ui';
import { useEditors } from '../store/editors';
import { DiffView } from './DiffView';
import { getEntry } from './models';

interface Revision {
  id: string;
  time: number;
  label: string;
  size: number;
}

function when(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

/** Rider's Local History of a file: every saved version, each diffed against the current text, with Revert. */
export function HistoryView({ path }: { path: string }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = () =>
    api.get<Revision[]>('/history/list', { path }).then(
      (list) => {
        setRevisions(list);
        setSelected((s) => (s && list.some((r) => r.id === s) ? s : (list[0]?.id ?? null)));
      },
      () => setRevisions([]),
    );
  useEffect(() => void load(), [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const revert = async (r: Revision) => {
    if ((await askConfirm({ title: 'Revert to this revision', message: `Replace the file's content with the version from ${when(r.time)}?\n\nThe current text stays in the history.`, okLabel: 'Revert' })) !== 'ok') return;
    try {
      const { text } = await api.get<{ text: string }>('/history/text', { path, id: r.id });
      const entry = getEntry(path);
      if (entry && !entry.readOnly) {
        // an undoable edit, left unsaved like any other change
        await api.post('/history/label', { path, text: entry.model.getValue(), label: 'Before revert' });
        entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text }], () => null);
        await useEditors.getState().open(path);
      } else {
        await api.post('/fs/write', { path, text, label: 'Reverted' });
      }
      toast('success', 'Reverted', `To the version from ${when(r.time)}`, 2500);
      void load();
    } catch (e) {
      toast('error', 'Revert failed', errorText(e));
    }
  };

  const putLabel = async () => {
    const label = await askText({ title: 'Put label', placeholder: 'Before the big refactoring', okLabel: 'Put Label' });
    if (!label) return;
    const entry = getEntry(path);
    try {
      await api.post('/history/label', { path, text: entry?.model.getValue(), label });
      void load();
    } catch (e) {
      toast('error', 'Could not put the label', errorText(e));
    }
  };

  return (
    <div className="history-view">
      <div className="history-list">
        <div className="console-toolbar">
          <History size={14} />
          <b>Local History</b>
          <div className="flex-1" />
          <button className="icon-btn sm" title="Put Label" onClick={() => void putLabel()}>
            <Tag size={14} />
          </button>
          <button className="icon-btn sm" title="Refresh" onClick={() => void load()}>
            <RotateCw size={14} />
          </button>
        </div>
        <div className="result-list">
          {!revisions && (
            <div className="panel-empty">
              <LoaderCircle size={16} className="spin" />
            </div>
          )}
          {revisions?.length === 0 && <div className="panel-empty">No history yet. Every save of this file keeps a revision here.</div>}
          {revisions?.map((r) => (
            <div key={r.id} className={`result-item${r.id === selected ? ' selected' : ''}`} onClick={() => setSelected(r.id)} title={`${r.size} characters`}>
              <span className="msg">{when(r.time)}</span>
              <span className={`history-label${r.label === 'Saved' ? ' muted' : ''}`}>{r.label}</span>
              <button
                className="icon-btn sm history-revert"
                title="Revert to this revision"
                onClick={(e) => {
                  e.stopPropagation();
                  void revert(r);
                }}
              >
                <Undo2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="history-diff">
        {selected ? <DiffView key={selected} spec={{ path, left: `history:${selected}`, right: 'working' }} /> : <div className="panel-empty">Select a revision to compare it with the current text.</div>}
      </div>
    </div>
  );
}
