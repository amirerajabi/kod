import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { SymbolDto } from '../api/types';
import { relative } from '../lib/paths';
import { saveHooks, useEditors } from '../store/editors';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { searchUsages, useUsages, type UsageRequest } from '../store/usages';
import { useWorkspace } from '../store/workspace';
import { scheduleDiagnostics } from './csharp';
import { attachDebugDecorations, toggleBreakpointAtCursor } from './debugEditor';
import { attachGitDecorations } from './gitEditor';
import { entryOfModel, getEntry } from './models';
import { attachNavigation } from './navigation';
import { attachBookmarks } from './bookmarks';
import { runConsole } from './sql';
import { SqlConsoleBar } from '../components/DatabasePanel';
import { monaco } from './monaco';

let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
export const getEditor = () => editorInstance;

/** Runs a Monaco action on the editor (format, rename, go to definition...). */
export function editorAction(id: string): void {
  const ed = editorInstance;
  if (!ed) return;
  ed.focus();
  void ed.getAction(id)?.run();
}

/** What Find / Show Usages search for: the symbol at the caret of a C# editor. */
function usageRequest(): UsageRequest | null {
  const ed = editorInstance;
  const model = ed?.getModel();
  const entry = entryOfModel(model);
  const pos = ed?.getPosition();
  if (!ed || !model || !entry || !pos || model.getLanguageId() !== 'csharp') return null;
  const word = model.getWordAtPosition(pos)?.word ?? 'symbol';
  return { path: entry.path, text: model.getValue(), line: pos.lineNumber, column: pos.column, word };
}

/** Find Usages (Alt+F7): the results in the Find tool window. */
export async function findUsages(): Promise<void> {
  const req = usageRequest();
  if (!req) return;
  useUsages.getState().set({ popup: null });
  useUi.getState().showBottom('usages');
  await searchUsages(req);
}

/** Show Usages (Ctrl+Alt+F7, Rider's): a popup under the caret; a single usage is opened right away. */
export async function showUsages(): Promise<void> {
  const ed = editorInstance;
  const req = usageRequest();
  const pos = ed?.getPosition();
  if (!ed || !req || !pos) return;
  const at = ed.getScrolledVisiblePosition(pos);
  const box = ed.getDomNode()!.getBoundingClientRect();
  const x = box.left + (at?.left ?? 0);
  const y = box.top + (at ? at.top + at.height : 0) + 2;
  useUsages.getState().set({ popup: { x, y } });
  const items = await searchUsages(req);
  const usages = items?.filter((u) => u.kind !== 'declaration') ?? [];
  if (usages.length === 1 && useUsages.getState().popup) {
    useUsages.getState().set({ popup: null });
    void useEditors.getState().open(usages[0].path, { range: usages[0].range });
  }
}

function editorOptions(): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  const s = useSettings.getState().settings;
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: Math.round(s.fontSize * 1.5),
    fontLigatures: s.ligatures,
    tabSize: s.tabSize,
    insertSpaces: s.insertSpaces,
    wordWrap: s.wordWrap ? 'on' : 'off',
    minimap: { enabled: s.minimap, renderCharacters: false, scale: 1, maxColumn: 100 },
    stickyScroll: { enabled: s.stickyScroll },
    renderWhitespace: s.renderWhitespace,
    // Power Save Mode: completion only on Ctrl+Space, no animations
    quickSuggestions: s.powerSave ? false : { other: true, comments: false, strings: true },
    smoothScrolling: !s.powerSave,
    cursorBlinking: s.powerSave ? 'solid' : 'smooth',
    cursorSmoothCaretAnimation: s.powerSave ? 'off' : 'on',
  };
}

export function CodeEditor() {
  const host = useRef<HTMLDivElement>(null);
  const active = useEditors((s) => s.active);
  const reveal = useEditors((s) => s.reveal);
  const settings = useSettings((s) => s.settings);
  const [symbols, setSymbols] = useState<SymbolDto[]>([]);
  const [crumbs, setCrumbs] = useState<SymbolDto[]>([]);
  const symbolsRef = useRef<SymbolDto[]>([]);

  // create once
  useEffect(() => {
    const ed = monaco.editor.create(host.current!, {
      ...editorOptions(),
      model: null,
      automaticLayout: true,
      theme: 'kod',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      'semanticHighlighting.enabled': true,
      fixedOverflowWidgets: true,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      suggest: { showStatusBar: true, preview: true, selectionMode: 'always' },
      inlayHints: { enabled: 'on' },
      inlineSuggest: { enabled: true, mode: 'subwordSmart', showToolbar: 'onHover' },
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
      padding: { top: 6 },
      mouseWheelZoom: true,
      linkedEditing: true,
      glyphMargin: true,
      'bracketPairColorization.independentColorPoolPerBracketType': true,
    } as monaco.editor.IStandaloneEditorConstructionOptions);
    editorInstance = ed;

    // right-click › AI (the selection, or the whole file)
    for (const [i, [id, label]] of ([
      ['ai.explain', 'AI: Explain This Code'],
      ['ai.fix', 'AI: Find and Fix Problems'],
      ['ai.tests', 'AI: Write Unit Tests'],
      ['ai.doc', 'AI: Add Documentation Comments'],
    ] as const).entries()) {
      ed.addAction({ id: `kod.${id}`, label, contextMenuGroupId: '0_ai', contextMenuOrder: i, run: () => void import('../app/commands').then((m) => m.runCommand(id)) });
    }

    ed.addAction({ id: 'kod.usages.find', label: 'Find Usages', contextMenuGroupId: 'navigation', contextMenuOrder: 2, run: () => void findUsages() });
    ed.addAction({ id: 'kod.usages.show', label: 'Show Usages', contextMenuGroupId: 'navigation', contextMenuOrder: 2.1, run: () => void showUsages() });
    // next to Cut / Copy / Paste, as Rider's Copy/Paste Special
    ed.addAction({ id: 'kod.copyPathReference', label: 'Copy Path/Reference…', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 10, run: () => void import('./clipboard').then((m) => m.copyPathReference()) });
    ed.addAction({ id: 'kod.pasteHistory', label: 'Paste from History…', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 11, run: () => void import('./clipboard').then((m) => m.pasteFromHistory()) });
    ed.addAction({ id: 'kod.generate', label: 'Generate…', contextMenuGroupId: '1_modification', contextMenuOrder: 0, precondition: 'editorLangId == csharp', run: () => void import('./generate').then((m) => m.generateMenu(ed)) });

    // right-click › Local History (Rider's): the file, or only the selected lines
    ed.addAction({ id: 'kod.history.show', label: 'Local History: Show History', contextMenuGroupId: '9_history', contextMenuOrder: 0, run: () => void import('../app/commands').then((m) => m.runCommand('history.show')) });
    ed.addAction({
      id: 'kod.history.selection',
      label: 'Local History: Show History for Selection',
      contextMenuGroupId: '9_history',
      contextMenuOrder: 1,
      precondition: 'editorHasSelection',
      run: () => void import('../app/commands').then((m) => m.runCommand('history.selection')),
    });

    // Rider keys on top of Monaco's own (F12, Shift+F12, F2, Ctrl+Space, Ctrl+Shift+Space...)
    ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => ed.trigger('kod', 'editor.action.quickFix', {}));
    // AI inline completions: Alt+\ asks for a suggestion now, Ctrl+Right takes its next word
    ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Backslash, () => ed.trigger('kod', 'editor.action.inlineSuggest.trigger', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow, () => ed.trigger('kod', 'editor.action.inlineSuggest.acceptNextWord', {}), 'inlineSuggestionVisible');
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => ed.trigger('kod', 'editor.action.formatDocument', {}));
    ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F7, () => void findUsages());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.F7, () => void showUsages());
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F6, () => ed.trigger('kod', 'editor.action.rename', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => ed.trigger('kod', 'editor.action.revealDefinition', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB, () => ed.trigger('kod', 'editor.action.goToImplementation', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, () => ed.trigger('kod', 'editor.action.commentLine', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, () => ed.trigger('kod', 'editor.action.copyLinesDownAction', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => ed.trigger('kod', 'editor.action.deleteLines', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => ed.trigger('kod', 'editor.action.smartSelect.expand', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyW, () => ed.trigger('kod', 'editor.action.smartSelect.shrink', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.UpArrow, () => ed.trigger('kod', 'editor.action.moveLinesUpAction', {}));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.DownArrow, () => ed.trigger('kod', 'editor.action.moveLinesDownAction', {}));

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runConsole(ed), "editorLangId == 'sql'");
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runConsole(ed, true), "editorLangId == 'sql'");
    ed.addCommand(monaco.KeyCode.F9, () => toggleBreakpointAtCursor(ed));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8, () => toggleBreakpointAtCursor(ed));
    const detachDebug = attachDebugDecorations(ed);
    const detachGit = attachGitDecorations(ed);
    const detachNav = attachNavigation(ed);
    const detachBookmarks = attachBookmarks(ed);

    ed.onDidChangeCursorSelection((e) => {
      const model = ed.getModel();
      const sel = e.selection;
      useUi.getState().set({ cursor: { line: sel.positionLineNumber, column: sel.positionColumn, selected: model ? model.getValueLengthInRange(sel) : 0 } });
      setCrumbs(crumbsAt(symbolsRef.current, sel.positionLineNumber, sel.positionColumn));
    });
    ed.onDidChangeModelContent(() => {
      const entry = entryOfModel(ed.getModel());
      if (!entry) return;
      scheduleDiagnostics(entry);
      if (useSettings.getState().settings.autoSave === 'afterDelay') scheduleAutoSave(entry.path);
    });
    ed.onDidBlurEditorText(() => {
      if (useSettings.getState().settings.autoSave === 'onFocusChange') void useEditors.getState().saveAll();
    });

    saveHooks.formatBeforeSave = async (path) => {
      const entry = getEntry(path);
      if (!entry || ed.getModel() !== entry.model) return;
      await ed.getAction('editor.action.formatDocument')?.run();
    };

    return () => {
      detachDebug();
      detachGit();
      detachNav();
      detachBookmarks();
      editorInstance = null;
      ed.dispose();
    };
  }, []);

  // settings
  useEffect(() => {
    editorInstance?.updateOptions(editorOptions());
  }, [settings]);

  // switch the model with the active tab, keeping each tab's scroll / cursor / folding
  const prevPath = useRef<string | null>(null);
  useEffect(() => {
    const ed = editorInstance;
    if (!ed) return;
    if (prevPath.current) {
      const prev = getEntry(prevPath.current);
      if (prev && ed.getModel() === prev.model) prev.viewState = ed.saveViewState();
    }
    prevPath.current = active;
    const entry = active ? getEntry(active) : undefined;
    ed.setModel(entry?.model ?? null);
    if (entry) {
      ed.updateOptions({ readOnly: entry.readOnly, wordBasedSuggestions: entry.model.getLanguageId() === 'csharp' ? 'off' : 'currentDocument' });
      if (entry.viewState) ed.restoreViewState(entry.viewState);
      scheduleDiagnostics(entry, 0);
      ed.focus();
    }
    setSymbols([]);
    symbolsRef.current = [];
    setCrumbs([]);
  }, [active]);

  // reveal a location (go to, search result, problem)
  useEffect(() => {
    const ed = editorInstance;
    if (!ed || !reveal || !active || reveal.path !== active) return;
    const range = new monaco.Range(reveal.line, reveal.column, reveal.endLine ?? reveal.line, reveal.endColumn ?? reveal.column);
    ed.setSelection(range);
    ed.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
    ed.focus();
  }, [reveal, active]);

  // document symbols for the breadcrumbs (C# only), refreshed after edits
  useEffect(() => {
    const entry = active ? getEntry(active) : undefined;
    if (!entry || entry.model.getLanguageId() !== 'csharp' || entry.model.uri.scheme !== 'file') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.post<SymbolDto[]>('/intel/symbols', { path: entry.path, text: entry.model.getValue() });
        if (cancelled) return;
        symbolsRef.current = res;
        setSymbols(res);
        const p = editorInstance?.getPosition();
        if (p) setCrumbs(crumbsAt(res, p.lineNumber, p.column));
      } catch {
        /* engine busy */
      }
    };
    void load();
    const sub = entry.model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(load, 1200);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      sub.dispose();
    };
  }, [active]);

  const root = useWorkspace((s) => s.ws.root);
  const tab = useEditors((s) => s.tabs.find((t) => t.path === s.active));
  const rel = tab ? (tab.kind === 'metadata' ? tab.title : relative(root, tab.path)) : '';

  return (
    <>
      {tab && (tab.kind === 'file' || tab.kind === 'metadata') && (
        <div className="breadcrumbs" aria-label="Breadcrumbs">
          {rel.split(/[\\/]/).map((seg, i, arr) => (
            <span key={`p${i}`} className="crumb" style={{ cursor: 'default' }}>
              {seg}
              {(i < arr.length - 1 || crumbs.length > 0) && <ChevronRight size={12} />}
            </span>
          ))}
          {crumbs.map((c, i) => (
            <span
              key={`s${i}`}
              className="crumb"
              onClick={() => {
                const ed = editorInstance;
                if (!ed) return;
                ed.setPosition({ lineNumber: c.selectionRange.startLine, column: c.selectionRange.startColumn });
                ed.revealLineInCenterIfOutsideViewport(c.selectionRange.startLine);
                ed.focus();
              }}
            >
              {c.name}
              {i < crumbs.length - 1 && <ChevronRight size={12} />}
            </span>
          ))}
          {symbols.length === 0 && null}
        </div>
      )}
      {tab?.kind === 'sql' && <SqlConsoleBar path={tab.path} run={(all) => editorInstance && runConsole(editorInstance, all)} />}
      {tab?.kind === 'metadata' && <div className="readonly-banner">Decompiled declarations from metadata (read-only). Members have no bodies.</div>}
      <div className="editor-host">
        {/* monaco-component: Monaco mounts its context menu in this element (outside .monaco-editor), so it needs the theme colour variables */}
        <div ref={host} className="monaco monaco-component" />
      </div>
    </>
  );
}

function crumbsAt(symbols: SymbolDto[], line: number, column: number): SymbolDto[] {
  const path: SymbolDto[] = [];
  let level = symbols;
  for (;;) {
    const hit = level.find((s) => inRange(s, line, column));
    if (!hit) return path;
    path.push(hit);
    level = hit.children;
  }
}

function inRange(s: SymbolDto, line: number, column: number): boolean {
  const r = s.range;
  if (line < r.startLine || line > r.endLine) return false;
  if (line === r.startLine && column < r.startColumn) return false;
  if (line === r.endLine && column > r.endColumn) return false;
  return true;
}

const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleAutoSave(path: string): void {
  clearTimeout(autoSaveTimers.get(path));
  autoSaveTimers.set(
    path,
    setTimeout(() => {
      autoSaveTimers.delete(path);
      void useEditors.getState().save(path);
    }, 1000),
  );
}
