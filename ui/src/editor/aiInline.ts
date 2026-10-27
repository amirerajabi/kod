// AI inline completions (ghost text, like GitHub Copilot): when typing pauses, the code around the caret goes to the
// AI provider of Settings › AI and its answer shows in grey. Tab accepts, Ctrl+→ a word, Esc dismisses, Alt+\ asks.
import { api, isAbort } from '../api/client';
import { inlinePayload, useAi } from '../store/ai';
import { useSettings } from '../store/settings';
import { toast } from '../store/ui';
import { pathOfModel } from './models';
import { monaco } from './monaco';

/** Recent answers by the code around the caret: undo / redo or moving back does not ask again. */
const cache = new Map<string, string>();
let lastError = 0;

const wait = (ms: number, token: monaco.CancellationToken) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(!token.isCancellationRequested), ms);
    token.onCancellationRequested(() => {
      clearTimeout(t);
      resolve(false);
    });
  });

export function registerAiInline(): void {
  monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, context, token) {
      const s = useSettings.getState().settings;
      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      if ((!s.aiInline && !explicit) || s.powerSave) return { items: [] };
      const path = pathOfModel(model);
      if (!path || model.uri.scheme !== 'file' || model.getValueLength() > 2_000_000) return { items: [] };
      const line = model.getLineContent(position.lineNumber);
      const after = line.slice(position.column - 1);
      // mid-line (anything but closing brackets and quotes after the caret): no suggestion
      if (!explicit && /[^\s)\]}"';,]/.test(after)) return { items: [] };
      if (!explicit && !line.trim()) {
        // an empty line right after another empty one: nothing to go on
        const prev = position.lineNumber > 1 ? model.getLineContent(position.lineNumber - 1).trim() : '';
        if (!prev) return { items: [] };
      }
      const full = model.getFullModelRange();
      const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
      const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, full.endLineNumber, full.endColumn));
      const key = `${path}\n${prefix.slice(-1500)}\u0000${suffix.slice(0, 300)}`;
      let text = cache.get(key);
      if (text === undefined) {
        if (!explicit && !(await wait(s.aiInlineDelay, token))) return { items: [] };
        const ctrl = new AbortController();
        token.onCancellationRequested(() => ctrl.abort());
        try {
          const res = await api.post<{ text: string }>(
            '/ai/inline',
            { provider: await inlinePayload(), path, language: model.getLanguageId(), prefix: prefix.slice(-6000), suffix: suffix.slice(0, 2000) },
            ctrl.signal,
          );
          text = res.text;
        } catch (e) {
          if (!isAbort(e) && Date.now() - lastError > 60_000) {
            lastError = Date.now();
            toast('warning', 'AI inline completion failed', `${e instanceof Error ? e.message : String(e)}\n(${useAi.getState().config.provider}: check the key and the completion model in Settings › AI)`, 8000);
          }
          return { items: [] };
        }
        cache.set(key, text);
        if (cache.size > 100) cache.delete(cache.keys().next().value!);
      }
      if (!text.trim()) return { items: [] };
      return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
    },
    disposeInlineCompletions() {},
  });
}
