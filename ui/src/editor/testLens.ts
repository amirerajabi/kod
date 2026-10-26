// "Run test" above every discovered test method and "Run all" above its class (Rider's gutter run icons), with the
// last result in the label.
import { samePath } from '../lib/paths';
import { runTests, stateOf, useTests } from '../store/tests';
import { pathOfModel } from './models';
import { monaco } from './monaco';

const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();

export function registerTestLenses(): void {
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: changed.event,
    provideCodeLenses(model) {
      const path = pathOfModel(model);
      if (!path) return { lenses: [], dispose() {} };
      const tests = useTests.getState().projects.flatMap((p) => p.tests).filter((t) => samePath(t.path, path));
      const lenses: monaco.languages.CodeLens[] = [];
      const classes = new Map<string, number>();
      for (const t of tests) {
        if (t.line > model.getLineCount()) continue;
        const st = stateOf(t.id);
        const mark = st === 'passed' ? '✔ ' : st === 'failed' ? '✘ ' : st === 'running' ? '⟳ ' : '';
        lenses.push({ range: new monaco.Range(t.line, 1, t.line, 1), command: { id: 'kod.runTest', title: `${mark}▶ Run test`, arguments: [t.id] } });
        classes.set(t.className, Math.min(classes.get(t.className) ?? Infinity, t.line));
      }
      // the class lens goes on the class declaration line, found by name above its first test
      for (const [cls, firstLine] of classes) {
        const short = cls.split('.').pop()!;
        let line = firstLine;
        while (line > 1 && !new RegExp(`\\b(class|record)\\s+${short}\\b`).test(model.getLineContent(line))) line--;
        if (line >= 1 && new RegExp(`\\b(class|record)\\s+${short}\\b`).test(model.getLineContent(line)))
          lenses.push({ range: new monaco.Range(line, 1, line, 1), command: { id: 'kod.runTest', title: '▶ Run all tests', arguments: [cls] } });
      }
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider('csharp', provider);
  monaco.editor.registerCommand('kod.runTest', (_a, id: string) => void runTests([id]));
  useTests.subscribe((s, p) => {
    if (s.projects !== p.projects || s.results !== p.results || s.running !== p.running) changed.fire(provider);
  });
}
