// C# language features for Monaco, answered by the engine (Roslyn). Every request carries the model's text,
// so results always match what is on screen, saved or not.
import { api, errorText, isAbort } from '../api/client';
import type {
  CodeActionDto,
  CompletionListDto,
  CompletionResolveDto,
  DefinitionDto,
  DiagnosticDto,
  FileEditsDto,
  HoverDto,
  InlayHintDto,
  LocationDto,
  MetadataViewDto,
  RangeDto,
  SignatureHelpDto,
  SymbolDto,
  TextEditDto,
} from '../api/types';
import { applyFileEdits, useEditors } from '../store/editors';
import { useProblems } from '../store/problems';
import { useSettings } from '../store/settings';
import { toast } from '../store/ui';
import { hasDebugValueAt } from './debugEditor';
import { allEntries, ensureModel, ensureVirtualModel, entryOfModel, getEntry, pathOfModel, type ModelEntry } from './models';
import { monaco } from './monaco';
import { CSHARP_SNIPPETS } from './snippets';
import { inCSharpString } from './sql';

type Model = monaco.editor.ITextModel;
const L = 'csharp';

export const toRange = (r: RangeDto): monaco.IRange => ({ startLineNumber: r.startLine, startColumn: r.startColumn, endLineNumber: r.endLine, endColumn: r.endColumn });

function signal(token: monaco.CancellationToken): AbortSignal {
  const ac = new AbortController();
  token.onCancellationRequested(() => ac.abort());
  return ac.signal;
}

async function call<T>(path: string, body: unknown, token?: monaco.CancellationToken): Promise<T | null> {
  try {
    return await api.post<T>(path, body, token ? signal(token) : undefined);
  } catch (e) {
    if (!isAbort(e)) console.warn(path, errorText(e));
    return null;
  }
}

const docReq = (m: Model, p: monaco.Position, extra: object = {}) => ({ path: pathOfModel(m), text: m.getValue(), line: p.lineNumber, column: p.column, ...extra });

const CK = monaco.languages.CompletionItemKind;
const COMPLETION_KIND: Record<string, monaco.languages.CompletionItemKind> = {
  class: CK.Class, structure: CK.Struct, interface: CK.Interface, enum: CK.Enum, enummember: CK.EnumMember, delegate: CK.Function,
  method: CK.Method, extensionmethod: CK.Method, property: CK.Property, field: CK.Field, event: CK.Event, constant: CK.Constant,
  local: CK.Variable, parameter: CK.Variable, rangevariable: CK.Variable, namespace: CK.Module, typeparameter: CK.TypeParameter,
  keyword: CK.Keyword, snippet: CK.Snippet, label: CK.Reference, operator: CK.Operator, module: CK.Module, assembly: CK.Module,
  file: CK.File, folder: CK.Folder, text: CK.Text,
};

const SK = monaco.languages.SymbolKind;
const SYMBOL_KIND: Record<string, monaco.languages.SymbolKind> = {
  namespace: SK.Namespace, class: SK.Class, structure: SK.Struct, interface: SK.Interface, enum: SK.Enum, enummember: SK.EnumMember,
  delegate: SK.Function, method: SK.Method, constructor: SK.Constructor, property: SK.Property, field: SK.Field, constant: SK.Constant,
  event: SK.Event, operator: SK.Operator,
};

/** Metadata views by URI, so the editor opener can turn a Ctrl+click into a tab. */
const metadataViews = new Map<string, MetadataViewDto>();

/** Fires to make Monaco re-request semantic tokens (e.g. when the workspace finished loading). */
const tokensChanged = new monaco.Emitter<void>();
export const refreshSemanticTokens = () => tokensChanged.fire();

const hintsChanged = new monaco.Emitter<void>();
export const refreshInlayHints = () => hintsChanged.fire();

async function toLocations(list: LocationDto[]): Promise<monaco.languages.Location[]> {
  const out: monaco.languages.Location[] = [];
  for (const l of list) {
    try {
      const e = await ensureModel(l.path, { ephemeral: true });
      out.push({ uri: e.model.uri, range: toRange(l.range) });
    } catch {
      /* file vanished */
    }
  }
  return out;
}

function metadataLocation(view: MetadataViewDto): monaco.languages.Location {
  metadataViews.set(view.uri, view);
  const e = ensureVirtualModel(view.uri, view.uri, view.text);
  return { uri: e.model.uri, range: toRange(view.range) };
}

export function registerCSharp(legend: monaco.languages.SemanticTokensLegend): void {
  monaco.languages.registerCompletionItemProvider(L, {
    triggerCharacters: ['.', ' ', '<', '#'],
    async provideCompletionItems(model, position, context, token) {
      if (!pathOfModel(model)) return null;
      const trigger = context.triggerCharacter;
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      // a space only opens the list where C# expects a type or member next (new |, override |, ...)
      if (trigger === ' ' && !/\b(new|override|using|partial|is|as|case)\s$/.test(before)) return { suggestions: [] };
      if (trigger === '<' && !/\w<$/.test(before)) return { suggestions: [] };
      const res = await call<CompletionListDto>('/intel/completion', docReq(model, position, { triggerCharacter: trigger }), token);
      if (!res) return null;
      const suggestions = res.items.map((it): monaco.languages.CompletionItem & { _list?: string; _index?: number; _edits?: boolean } => {
        const replace = toRange(it.range);
        const insert = { ...replace, endLineNumber: position.lineNumber, endColumn: Math.max(replace.startColumn, position.column) };
        return {
          label: it.detail ? { label: it.label, description: it.detail } : it.label,
          kind: COMPLETION_KIND[it.kind] ?? CK.Text,
          filterText: it.filterText,
          sortText: it.sortText,
          insertText: it.insertText,
          range: replace.startLineNumber === replace.endLineNumber && replace.startLineNumber === position.lineNumber ? { insert, replace } : insert,
          additionalTextEdits: it.additionalEdits?.map((e) => ({ range: toRange(e.range), text: e.newText })),
          preselect: it.preselect,
          _list: res.listId,
          _index: it.index,
          _edits: it.editsOnResolve,
        };
      });
      // a cut-down list (the best of thousands): the editor asks again as the user types, the engine re-filters its cached list
      return { suggestions, incomplete: res.incomplete ?? false };
    },
    async resolveCompletionItem(item, token) {
      const x = item as typeof item & { _list?: string; _index?: number; _edits?: boolean };
      if (!x._list) return item;
      const res = await call<CompletionResolveDto>('/intel/completion/resolve', { listId: x._list, index: x._index, edits: !!x._edits }, token);
      if (res?.documentation) item.documentation = { value: res.documentation };
      // the using directive of a type from another namespace (Monaco waits for it when the item is accepted)
      if (res?.additionalEdits?.length) item.additionalTextEdits = res.additionalEdits.map((e) => ({ range: toRange(e.range), text: e.newText }));
      return item;
    },
  });

  monaco.languages.registerCompletionItemProvider(L, {
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const word = model.getWordUntilPosition(position);
      const before = line.slice(0, word.startColumn - 1);
      if (/[.\w]$/.test(before) || /^\s*\/\//.test(line) || inCSharpString(model, position)) return { suggestions: [] };
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        suggestions: CSHARP_SNIPPETS.map((s) => ({
          label: { label: s.prefix, description: s.description },
          kind: CK.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: '```csharp\n' + s.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d/g, '') + '\n```' },
          range,
          sortText: '~' + s.prefix,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(L, {
    async provideHover(model, position, token) {
      if (!pathOfModel(model) || (await hasDebugValueAt(model, position))) return null;
      const res = await call<HoverDto>('/intel/hover', docReq(model, position), token);
      if (!res) return null;
      return { contents: [{ value: res.markdown }], range: res.range ? toRange(res.range) : undefined };
    },
  });

  monaco.languages.registerSignatureHelpProvider(L, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position, token) {
      if (!pathOfModel(model)) return null;
      const res = await call<SignatureHelpDto>('/intel/signature', docReq(model, position), token);
      if (!res || res.signatures.length === 0) return null;
      return {
        value: {
          signatures: res.signatures.map((s) => ({
            label: s.label,
            documentation: s.documentation ? { value: s.documentation } : undefined,
            parameters: s.parameters.map((p) => ({ label: [p.start, p.end] as [number, number], documentation: p.documentation ? { value: p.documentation } : undefined })),
          })),
          activeSignature: res.activeSignature,
          activeParameter: res.activeParameter,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDefinitionProvider(L, {
    async provideDefinition(model, position, token) {
      if (!pathOfModel(model)) return null;
      const res = await call<DefinitionDto>('/intel/definition', docReq(model, position), token);
      if (!res) return null;
      if (res.locations.length > 0) return toLocations(res.locations);
      return res.metadata ? [metadataLocation(res.metadata)] : null;
    },
  });

  monaco.languages.registerTypeDefinitionProvider(L, {
    async provideTypeDefinition(model, position, token) {
      if (!pathOfModel(model)) return null;
      const res = await call<DefinitionDto>('/intel/typeDefinition', docReq(model, position), token);
      if (!res) return null;
      if (res.locations.length > 0) return toLocations(res.locations);
      return res.metadata ? [metadataLocation(res.metadata)] : null;
    },
  });

  monaco.languages.registerInlayHintsProvider(L, {
    onDidChangeInlayHints: hintsChanged.event,
    async provideInlayHints(model, range, token) {
      const path = pathOfModel(model);
      if (!path || model.uri.scheme !== 'file' || !useSettings.getState().settings.inlayHints) return { hints: [], dispose() {} };
      const r = { startLine: range.startLineNumber, startColumn: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn };
      const res = await call<InlayHintDto[]>('/intel/inlayHints', { path, text: model.getValue(), range: r }, token);
      return {
        hints: (res ?? []).map((h) => ({
          position: { lineNumber: h.line, column: h.column },
          label: h.label,
          kind: h.kind === 'type' ? monaco.languages.InlayHintKind.Type : monaco.languages.InlayHintKind.Parameter,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
        })),
        dispose() {},
      };
    },
  });

  monaco.languages.registerImplementationProvider(L, {
    async provideImplementation(model, position, token) {
      if (!pathOfModel(model)) return null;
      const res = await call<LocationDto[]>('/intel/implementations', docReq(model, position), token);
      return res ? toLocations(res) : null;
    },
  });

  monaco.languages.registerReferenceProvider(L, {
    async provideReferences(model, position, context, token) {
      if (!pathOfModel(model)) return null;
      const res = await call<LocationDto[]>('/intel/references', docReq(model, position), token);
      if (!res) return null;
      return toLocations(context.includeDeclaration ? res : res.filter((r) => !r.isDefinition));
    },
  });

  monaco.languages.registerRenameProvider(L, {
    async resolveRenameLocation(model, position, token) {
      const res = await call<{ range: RangeDto; text: string }>('/intel/prepareRename', docReq(model, position), token);
      if (!res) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: 'This element cannot be renamed' };
      return { range: toRange(res.range), text: res.text };
    },
    async provideRenameEdits(model, position, newName) {
      let files: FileEditsDto[];
      try {
        files = await api.post<FileEditsDto[]>('/intel/rename', docReq(model, position, { newName }));
      } catch (e) {
        return { edits: [], rejectReason: errorText(e) };
      }
      const open: monaco.languages.IWorkspaceTextEdit[] = [];
      const closed: FileEditsDto[] = [];
      for (const f of files) {
        const e = getEntry(f.path);
        if (e && !e.ephemeral) for (const ed of f.edits) open.push({ resource: e.model.uri, textEdit: { range: toRange(ed.range), text: ed.newText }, versionId: undefined });
        else closed.push(f);
      }
      if (closed.length) await applyFileEdits(closed);
      if (files.length > 1) toast('success', `Renamed to ${newName}`, `${files.length} files changed`, 3000);
      return { edits: open };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(L, {
    async provideDocumentFormattingEdits(model, _options, token) {
      const res = await call<TextEditDto[]>('/intel/format', { path: pathOfModel(model), text: model.getValue(), range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 } }, token);
      return res?.map((e) => ({ range: toRange(e.range), text: e.newText })) ?? null;
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider(L, {
    async provideDocumentRangeFormattingEdits(model, range, _options, token) {
      const r = { startLine: range.startLineNumber, startColumn: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn };
      const res = await call<TextEditDto[]>('/intel/formatRange', { path: pathOfModel(model), text: model.getValue(), range: r }, token);
      return res?.map((e) => ({ range: toRange(e.range), text: e.newText })) ?? null;
    },
  });

  monaco.languages.registerDocumentSemanticTokensProvider(L, {
    onDidChange: tokensChanged.event,
    getLegend: () => legend,
    async provideDocumentSemanticTokens(model, _lastResultId, token) {
      if (!pathOfModel(model)) return null;
      const res = await call<{ data: number[] }>('/intel/semanticTokens', { path: pathOfModel(model), text: model.getValue() }, token);
      return res ? { data: Uint32Array.from(res.data) } : null;
    },
    releaseDocumentSemanticTokens() {},
  });

  monaco.languages.registerDocumentSymbolProvider(L, {
    displayName: 'C#',
    async provideDocumentSymbols(model, token) {
      if (!pathOfModel(model)) return null;
      const res = await call<SymbolDto[]>('/intel/symbols', { path: pathOfModel(model), text: model.getValue() }, token);
      const map = (s: SymbolDto): monaco.languages.DocumentSymbol => ({
        name: s.name,
        detail: s.detail ?? '',
        kind: SYMBOL_KIND[s.kind] ?? SK.Variable,
        tags: [],
        range: toRange(s.range),
        selectionRange: toRange(s.selectionRange),
        children: s.children.map(map),
      });
      return res?.map(map) ?? null;
    },
  });

  monaco.languages.registerCodeActionProvider(
    L,
    {
      async provideCodeActions(model, range, context, token) {
        if (!pathOfModel(model) || model.uri.scheme !== 'file') return null;
        const invoked = context.trigger === monaco.languages.CodeActionTriggerType.Invoke;
        if (!invoked && context.markers.length === 0) return { actions: [], dispose() {} };
        const r = { startLine: range.startLineNumber, startColumn: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn };
        const res = await call<CodeActionDto[]>('/intel/codeActions', { path: pathOfModel(model), text: model.getValue(), range: r, invoked }, token);
        const actions = (res ?? []).map((a) => ({
          title: a.title,
          kind: a.kind === 'quickfix' ? 'quickfix' : 'refactor',
          isPreferred: a.isPreferred,
          diagnostics: a.kind === 'quickfix' ? context.markers : undefined,
          command: { id: 'kod.applyCodeAction', title: a.title, arguments: [a.id] },
        }));
        return { actions, dispose() {} };
      },
    },
    { providedCodeActionKinds: ['quickfix', 'refactor'] },
  );

  monaco.editor.registerCommand('kod.applyCodeAction', (_accessor, id: string) => applyCodeAction(id));

  // Ctrl+click / F12 into another file or a metadata view: open it as a tab
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const sel = selectionOrPosition;
      const range: RangeDto | undefined = !sel
        ? undefined
        : 'startLineNumber' in sel
          ? { startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn }
          : { startLine: sel.lineNumber, startColumn: sel.column, endLine: sel.lineNumber, endColumn: sel.column };
      const view = metadataViews.get(resource.toString());
      if (view) {
        useEditors.getState().openMetadata(range ? { ...view, range } : view);
        return true;
      }
      const entry = entryOfModel(monaco.editor.getModel(resource));
      const path = entry?.path ?? resource.fsPath;
      void useEditors.getState().open(path, { range });
      return true;
    },
  });
}

/** Applies a quick fix / refactoring the engine offered (Alt+Enter, Refactor This). */
export async function applyCodeAction(id: string): Promise<void> {
  try {
    const files = await api.post<FileEditsDto[]>('/intel/codeActions/apply', { id });
    await applyFileEdits(files);
  } catch (e) {
    toast('error', 'The action could not be applied', errorText(e));
  }
}

// ---------------------------------------------------------------- diagnostics

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const MS = monaco.MarkerSeverity;

/** Refresh the markers of a C# model shortly after its last change. */
export function scheduleDiagnostics(e: ModelEntry, delay = 450): void {
  if (e.model.getLanguageId() !== L || e.model.uri.scheme !== 'file' || e.model.isDisposed()) return;
  clearTimeout(timers.get(e.path));
  timers.set(
    e.path,
    setTimeout(async () => {
      timers.delete(e.path);
      if (e.model.isDisposed()) return;
      const version = e.model.getVersionId();
      const body = { path: e.path, text: e.model.getValue() };
      const res = await call<DiagnosticDto[]>('/intel/diagnostics', body);
      if (!res || e.model.isDisposed() || e.model.getVersionId() !== version) return;
      setMarkers(e.model, 'kod', res, 'C#');
      useProblems.getState().setLive(e.path, res);

      // inspections (IDE + project analyzers) are slower: they follow the compiler's answer
      if (!useSettings.getState().settings.inspections) {
        monaco.editor.setModelMarkers(e.model, 'kod.ide', []);
        return;
      }
      const ide = await call<DiagnosticDto[]>('/intel/analyzerDiagnostics', body);
      if (!ide || e.model.isDisposed() || e.model.getVersionId() !== version) return;
      setMarkers(e.model, 'kod.ide', ide, 'Inspection');
      useProblems.getState().setLive(e.path, [...res, ...ide]);
    }, delay),
  );
}

function setMarkers(model: Model, owner: string, list: DiagnosticDto[], source: string): void {
  monaco.editor.setModelMarkers(
    model,
    owner,
    list.map((d) => ({
      ...toRange(d.range),
      severity: d.severity === 'error' ? MS.Error : d.severity === 'warning' ? MS.Warning : d.severity === 'info' ? MS.Info : MS.Hint,
      message: d.message,
      code: d.code,
      source,
      tags: d.unnecessary ? [monaco.MarkerTag.Unnecessary] : [],
    })),
  );
}

export function refreshAllDiagnostics(): void {
  for (const e of allEntries()) if (!e.ephemeral) scheduleDiagnostics(e, 50);
  refreshSemanticTokens();
  refreshInlayHints();
}
