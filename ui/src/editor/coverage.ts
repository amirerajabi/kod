// Coverage marks in the editor: a bar in the gutter (green: ran, red: never ran, yellow: some branches did not run)
// and the same colours in the overview ruler, on every open model of a covered file.
import { norm } from '../lib/paths';
import { useCoverage } from '../store/coverage';
import { pathOfModel } from './models';
import { monaco } from './monaco';
import './coverage.css';

const applied = new Map<string, string[]>();

function decorate(model: monaco.editor.ITextModel): void {
  const key = model.uri.toString();
  const path = pathOfModel(model);
  const { show, byPath } = useCoverage.getState();
  const file = show && path ? byPath.get(norm(path)) : undefined;
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  if (file) {
    const partial = new Set(file.partial);
    const mark = (line: number, kind: 'covered' | 'uncovered' | 'partial', ruler: string) => {
      if (line < 1 || line > model.getLineCount()) return;
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          linesDecorationsClassName: `cov-${kind}`,
          overviewRuler: { color: ruler, position: monaco.editor.OverviewRulerLane.Left },
          hoverMessage: { value: kind === 'covered' ? 'Covered by tests' : kind === 'partial' ? 'Partly covered: some branches did not run' : 'Not covered by any test' },
        },
      });
    };
    for (const l of file.coveredLines) mark(l, partial.has(l) ? 'partial' : 'covered', partial.has(l) ? '#d4a72c99' : '#3fb95066');
    for (const l of file.uncoveredLines) mark(l, 'uncovered', '#f8514999');
  }
  const next = model.deltaDecorations(applied.get(key) ?? [], decos);
  if (next.length) applied.set(key, next);
  else applied.delete(key);
}

export function registerCoverage(): void {
  const all = () => monaco.editor.getModels().forEach(decorate);
  useCoverage.subscribe((s, p) => {
    if (s.byPath !== p.byPath || s.show !== p.show) all();
  });
  // a file opened after the run gets its marks too (its path is known a tick after the model exists)
  monaco.editor.onDidCreateModel((m) => setTimeout(() => !m.isDisposed() && decorate(m), 0));
  monaco.editor.onWillDisposeModel((m) => applied.delete(m.uri.toString()));
}
