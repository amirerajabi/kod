// Git in the editor (Rider style): coloured bars in the gutter for lines added / changed / deleted since HEAD
// (compared with the live text, saved or not), and Annotate (git blame) shown before each line on request.
import { api } from '../api/client';
import { diffLines } from '../lib/linediff';
import { useGit } from '../store/git';
import { useSettings } from '../store/settings';
import { pathOfModel } from './models';
import { monaco } from './monaco';
import './git.css';

const headCache = new Map<string, { rev: number; text: string | null }>();

async function headText(path: string): Promise<string | null> {
  const rev = useGit.getState().rev;
  const hit = headCache.get(path);
  if (hit && hit.rev === rev) return hit.text;
  try {
    const r = await api.get<{ exists: boolean; text: string }>('/git/show', { path, rev: 'HEAD' });
    const text = r.exists ? r.text : null;
    headCache.set(path, { rev, text });
    return text;
  } catch {
    headCache.set(path, { rev, text: null });
    return null;
  }
}

let blameOn = false;
const blameListeners = new Set<() => void>();
export const isBlameOn = () => blameOn;
export function toggleBlame(): void {
  blameOn = !blameOn;
  for (const l of blameListeners) l();
}

/** "3 days ago" style, as GitToolBox shows it. */
export function timeAgo(seconds: number): string {
  const d = Date.now() / 1000 - seconds;
  const units: [number, string][] = [
    [365 * 86400, 'year'],
    [30 * 86400, 'month'],
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [s, name] of units) if (d >= s) return `${Math.floor(d / s)} ${name}${Math.floor(d / s) === 1 ? '' : 's'} ago`;
  return 'just now';
}

interface BlameLine {
  line: number;
  hash: string;
  author: string;
  time: number;
  summary: string;
}

export function attachGitDecorations(ed: monaco.editor.IStandaloneCodeEditor): () => void {
  const gutter = ed.createDecorationsCollection();
  const blame = ed.createDecorationsCollection();
  const inline = ed.createDecorationsCollection();
  // inline blame of the caret line (GitToolBox): blame of the model's current text, refetched after edits
  let blameCache: { uri: string; version: number; lines: Map<number, BlameLine> } | null = null;
  let inlineTimer: ReturnType<typeof setTimeout> | undefined;

  const renderInline = async () => {
    const model = ed.getModel();
    const path = pathOfModel(model);
    const pos = ed.getPosition();
    if (!useSettings.getState().settings.inlineBlame || !model || !path || !pos || model.uri.scheme !== 'file' || !useGit.getState().status?.isRepo || ed.getSelection()?.isEmpty() === false) {
      inline.clear();
      return;
    }
    const uri = model.uri.toString();
    const version = model.getVersionId();
    if (!blameCache || blameCache.uri !== uri || blameCache.version !== version) {
      try {
        const lines = await api.post<BlameLine[]>('/git/blame', { path, text: model.getValue() });
        if (ed.getModel() !== model || model.getVersionId() !== version) return;
        blameCache = { uri, version, lines: new Map(lines.map((l) => [l.line, l])) };
      } catch {
        inline.clear();
        return;
      }
    }
    const line = ed.getPosition()?.lineNumber ?? pos.lineNumber;
    const b = blameCache.lines.get(line);
    if (!b) {
      inline.clear();
      return;
    }
    const uncommitted = /^0+$/.test(b.hash);
    const max = model.getLineMaxColumn(line);
    inline.set([
      {
        range: new monaco.Range(line, max, line, max),
        options: {
          after: { content: uncommitted ? '      You · Not committed yet' : `      ${b.author}, ${timeAgo(b.time)} • ${b.summary.length > 60 ? `${b.summary.slice(0, 59)}…` : b.summary}`, inlineClassName: 'kod-inline-blame' },
          hoverMessage: uncommitted ? undefined : { value: `**${b.summary}**\n\n${b.author} · ${new Date(b.time * 1000).toLocaleString()} · \`${b.hash.slice(0, 8)}\`` },
        },
      },
    ]);
  };
  const scheduleInline = (ms = 250) => {
    clearTimeout(inlineTimer);
    inlineTimer = setTimeout(() => void renderInline(), ms);
  };
  const offCursor = ed.onDidChangeCursorPosition(() => {
    inline.clear();
    scheduleInline();
  });
  const offSettings = useSettings.subscribe((s, p) => s.settings.inlineBlame !== p.settings.inlineBlame && scheduleInline(0));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const renderGutter = async () => {
    const model = ed.getModel();
    const path = pathOfModel(model);
    const status = useGit.getState().status;
    if (!model || !path || model.uri.scheme !== 'file' || !status?.isRepo) {
      gutter.clear();
      return;
    }
    const my = ++seq;
    const base = await headText(path);
    if (my !== seq || ed.getModel() !== model) return;
    const text = model.getValue();
    // a file that is not in HEAD: everything is new (unless it is ignored, which status would not list)
    const changes = base === null ? (status.files.some((f) => f.path.toLowerCase() === path.toLowerCase()) ? [{ kind: 'added' as const, start: 1, end: model.getLineCount() }] : []) : diffLines(base, text);
    gutter.set(
      changes.map((c) => ({
        range: new monaco.Range(Math.max(1, c.start), 1, Math.max(1, c.end), 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `kod-git-${c.kind}`,
          overviewRuler: { color: c.kind === 'added' ? '#3fb950aa' : c.kind === 'modified' ? '#4f8ef7aa' : '#f85149aa', position: monaco.editor.OverviewRulerLane.Left },
        },
      })),
    );
  };

  const renderBlame = async () => {
    const model = ed.getModel();
    const path = pathOfModel(model);
    if (!blameOn || !model || !path || model.uri.scheme !== 'file') {
      blame.clear();
      return;
    }
    try {
      const lines = await api.post<{ line: number; hash: string; author: string; time: number; summary: string }[]>('/git/blame', { path, text: model.getValue() });
      if (ed.getModel() !== model || !blameOn) return;
      const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
      blame.set(
        lines.map((l) => {
          const uncommitted = /^0+$/.test(l.hash);
          const label = uncommitted ? 'Not committed yet'.padEnd(30) : `${fmt(l.time)} ${l.author.slice(0, 18).padEnd(18)}`;
          return {
            range: new monaco.Range(l.line, 1, l.line, 1),
            options: {
              before: { content: `${label}  `, inlineClassName: uncommitted ? 'kod-blame kod-blame-new' : 'kod-blame' },
              hoverMessage: uncommitted ? undefined : { value: `**${l.hash.slice(0, 8)}** ${l.author}, ${fmt(l.time)}\n\n${l.summary}` },
            },
          };
        }),
      );
    } catch {
      blame.clear();
    }
  };

  const schedule = (ms = 350) => {
    clearTimeout(timer);
    timer = setTimeout(() => void renderGutter(), ms);
  };

  const offContent = ed.onDidChangeModelContent(() => schedule());
  const offModel = ed.onDidChangeModel(() => {
    schedule(0);
    void renderBlame();
  });
  const offGit = useGit.subscribe((s, p) => {
    if (s.rev !== p.rev) {
      schedule(0);
      blameCache = null; // a commit changes who wrote what
      scheduleInline(0);
      if (blameOn) void renderBlame();
    }
  });
  const onBlame = () => void renderBlame();
  blameListeners.add(onBlame);
  schedule(0);
  return () => {
    clearTimeout(timer);
    clearTimeout(inlineTimer);
    offCursor.dispose();
    offSettings();
    offContent.dispose();
    offModel.dispose();
    offGit();
    blameListeners.delete(onBlame);
  };
}
