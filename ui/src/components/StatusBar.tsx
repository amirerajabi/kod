import { AlertTriangle, CircleX, GitBranch, Keyboard, LoaderCircle, Plug, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { getEntry } from '../editor/models';
import { useEditors } from '../store/editors';
import { allProblems, countProblems, useProblems } from '../store/problems';
import { groupOf, useProcs } from '../store/procs';
import { useSettings } from '../store/settings';
import { askConfirm, useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { UpdateChip } from './UpdateChip';

const LANG: Record<string, string> = { csharp: 'C#', xml: 'XML', json: 'JSON', markdown: 'Markdown', plaintext: 'Plain Text', razor: 'Razor', javascript: 'JavaScript', typescript: 'TypeScript' };

export function StatusBar() {
  const wsStatus = useUi((s) => s.wsStatus);
  const ws = useWorkspace((s) => s.ws);
  const cursor = useUi((s) => s.cursor);
  const active = useEditors((s) => s.active);
  const tabs = useEditors((s) => s.tabs);
  const live = useProblems((s) => s.live);
  const build = useProblems((s) => s.build);
  const solution = useProblems((s) => s.solution);
  const procs = useProcs((s) => s.procs);
  const settings = useSettings((s) => s.settings);
  const counts = useMemo(() => countProblems(allProblems({ live, build, solution })), [live, build, solution]);
  const running = Object.values(procs).filter((p) => p.info.exitCode == null && p.info.kind !== 'terminal');
  const entry = active ? getEntry(active) : undefined;
  const tab = tabs.find((t) => t.path === active);
  const lang = entry?.model.getLanguageId();
  const eol = entry?.model.getEOL() === '\r\n' ? 'CRLF' : 'LF';

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className={`sb-item ws-${wsStatus}`} title={wsStatus === 'open' ? 'Engine connected' : `Engine: ${wsStatus}`}>
        <Plug />
      </span>
      {ws.state === 'loading' && (
        <span className="sb-item" title={ws.message}>
          <LoaderCircle className="spin" /> {ws.message ?? 'Loading projects…'}
        </span>
      )}
      {ws.state === 'ready' && ws.root && (
        <span className="sb-item muted" title={ws.message ?? ''}>
          {ws.projects.length} project{ws.projects.length === 1 ? '' : 's'}
        </span>
      )}
      {ws.state === 'failed' && (
        <button className="sb-item sev-error" title={ws.message} onClick={() => void askConfirm({ title: 'Project load failed', message: ws.message ?? 'Unknown error', okLabel: 'Reload' }).then((a) => { if (a === 'ok') void useWorkspace.getState().reload(); })}>
          <CircleX /> Projects failed to load
        </button>
      )}
      {ws.warnings.length > 0 && (
        <button className="sb-item sev-warning" onClick={() => void askConfirm({ title: 'Project load warnings', message: ws.warnings.join('\n\n'), okLabel: 'Reload projects' }).then((a) => { if (a === 'ok') void useWorkspace.getState().reload(); })}>
          <TriangleAlert /> {ws.warnings.length} load warning{ws.warnings.length === 1 ? '' : 's'}
        </button>
      )}
      {ws.branch && (
        <span className="sb-item" title="Git branch">
          <GitBranch /> {ws.branch}
        </span>
      )}
      {ws.root && (
        <button className="sb-item" title="Problems (Alt+6)" onClick={() => useUi.getState().showBottom('problems')}>
          <CircleX className={counts.errors ? 'sev-error' : 'muted'} /> {counts.errors}
          <AlertTriangle className={counts.warnings ? 'sev-warning' : 'muted'} /> {counts.warnings}
        </button>
      )}
      {running.map((p) => (
        <button key={p.info.id} className="sb-item" title={p.info.commandLine} onClick={() => useUi.getState().showBottom(groupOf(p.info.kind))}>
          <LoaderCircle className="spin" /> {p.info.title}
        </button>
      ))}
      <div className="flex-1" />
      {entry && (
        <>
          <button className="sb-item muted" title="Go to line (Ctrl+G)" onClick={() => useUi.getState().openPalette('line', ':')}>
            {cursor.line}:{cursor.column}
            {cursor.selected > 0 && ` (${cursor.selected} chars)`}
          </button>
          <span className="sb-item muted">{eol}</span>
          <span className="sb-item muted">UTF-8</span>
          <span className="sb-item muted">{settings.insertSpaces ? `${settings.tabSize} spaces` : 'Tabs'}</span>
          <span className="sb-item muted">{LANG[lang ?? ''] ?? lang}</span>
          {tab?.readOnly && <span className="sb-item muted">Read-only</span>}
        </>
      )}
      <UpdateChip />
      <button className="sb-item" title="Keyboard shortcuts" onClick={() => useUi.getState().set({ shortcutsOpen: true })}>
        <Keyboard />
      </button>
    </footer>
  );
}
