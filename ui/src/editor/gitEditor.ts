// Git in the editor (Rider style): coloured bars in the gutter for lines added / changed / deleted since HEAD
// (compared with the live text, saved or not), and Annotate (git blame) shown before each line on request.
import { api } from '../api/client';
import { diffLines } from '../lib/linediff';
import { useGit } from '../store/git';
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

export function attachGitDecorations(ed: monaco.editor.IStandaloneCodeEditor): () => void {
  const gutter = ed.createDecorationsCollection();
  const blame = ed.createDecorationsCollection();
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
      if (blameOn) void renderBlame();
    }
  });
  const onBlame = () => void renderBlame();
  blameListeners.add(onBlame);
  schedule(0);
  return () => {
    clearTimeout(timer);
    offContent.dispose();
    offModel.dispose();
    offGit();
    blameListeners.delete(onBlame);
  };
}
