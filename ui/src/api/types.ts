// Engine contracts (engine/src/Kod.Engine/**/Dtos). Lines and columns are 1-based like Monaco.

export interface RangeDto {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface TextEditDto {
  range: RangeDto;
  newText: string;
}

export interface FileEditsDto {
  path: string;
  edits: TextEditDto[];
  created?: boolean;
  newText?: string;
  deleted?: boolean;
}

export type LoadState = 'none' | 'loading' | 'ready' | 'failed';

export interface ProjectDto {
  name: string;
  path: string;
  targetFramework?: string;
  kind: 'exe' | 'library' | 'test' | 'web';
  runnable: boolean;
}

export interface WorkspaceStateDto {
  state: LoadState;
  root?: string;
  target?: string;
  message?: string;
  projects: ProjectDto[];
  warnings: string[];
  branch?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface FileText {
  path: string;
  text: string;
  eol: string;
  readOnly: boolean;
}

export interface SearchMatch {
  line: number;
  column: number;
  length: number;
  preview: string;
  previewColumn: number;
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface CompletionItemDto {
  index: number;
  label: string;
  kind: string;
  detail?: string;
  filterText: string;
  sortText: string;
  insertText: string;
  range: RangeDto;
  additionalEdits?: TextEditDto[];
  preselect: boolean;
  isSnippet: boolean;
}

export interface CompletionListDto {
  listId: string;
  items: CompletionItemDto[];
}

export interface HoverDto {
  markdown: string;
  range?: RangeDto;
}

export interface SignatureHelpDto {
  signatures: { label: string; documentation?: string; parameters: { start: number; end: number; documentation?: string }[] }[];
  activeSignature: number;
  activeParameter: number;
}

export interface DiagnosticDto {
  severity: 'error' | 'warning' | 'info' | 'hint';
  code: string;
  message: string;
  range: RangeDto;
  unnecessary: boolean;
  path: string;
}

export interface LocationDto {
  path: string;
  range: RangeDto;
  preview?: string;
  isDefinition?: boolean;
}

export interface MetadataViewDto {
  uri: string;
  title: string;
  text: string;
  range: RangeDto;
}

export interface DefinitionDto {
  locations: LocationDto[];
  metadata?: MetadataViewDto;
}

export interface SymbolDto {
  name: string;
  detail?: string;
  kind: string;
  range: RangeDto;
  selectionRange: RangeDto;
  children: SymbolDto[];
}

export interface WorkspaceSymbolDto {
  name: string;
  container?: string;
  kind: string;
  path: string;
  range: RangeDto;
}

export interface CodeActionDto {
  id: string;
  title: string;
  kind: 'quickfix' | 'refactor';
  isPreferred: boolean;
}

export interface ProcDto {
  id: string;
  kind: string;
  title: string;
  commandLine: string;
  cwd: string;
  startedAt: number;
  exitCode?: number;
  endedAt?: number;
}

export interface MetaDto {
  version: string;
  os: 'windows' | 'macos' | 'linux';
  shell: string;
  home: string;
  runtime: string;
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface PackageDto {
  id: string;
  version: string;
  description?: string;
  totalDownloads?: number;
  iconUrl?: string;
  versions: string[];
  verified: boolean;
}

export interface PackageReferenceDto {
  id: string;
  version?: string;
}

export type EngineEvent =
  | ({ type: 'workspace.state' } & WorkspaceStateDto)
  | { type: 'fs.changed'; dirs: string[]; files: string[] }
  | ({ type: 'proc.started' } & ProcDto)
  | ({ type: 'proc.exit' } & ProcDto)
  | { type: 'proc.output'; id: string; text: string }
  | { type: 'debug.state' | 'debug.stopped' | 'debug.output' | 'debug.ended'; [k: string]: unknown }
  | { type: 'git.changed' }
  | { type: 'term.output'; id: string; data: string }
  | { type: 'term.exit'; id: string; exitCode: number }
  | { type: 'ai.delta' | 'ai.thinking' | 'ai.notice'; sessionId: string; text: string }
  | { type: 'ai.tool'; sessionId: string; callId: string; name: string; title: string; status: AiToolStatus; input?: string; output?: string; changedFile?: string }
  | { type: 'ai.done'; sessionId: string; stopReason: string; error?: string; usage?: { input: number; output: number; cached: number } };

export type AiToolStatus = 'approval' | 'running' | 'done' | 'error' | 'denied';

// ---- inlay hints, Code Vision, postfix templates (engine Intel/Dtos.cs)

export interface InlayHintDto {
  line: number;
  column: number;
  label: string;
  kind: 'type' | 'parameter';
  paddingLeft: boolean;
  paddingRight: boolean;
}

export interface CodeVisionEntryDto {
  line: number;
  column: number;
  kind: 'type' | 'member';
  implementable: boolean;
}

export interface CodeVisionDto {
  usages: number;
  implementations: number;
  implementationsLabel?: string;
}

export interface PostfixContextDto {
  range: RangeDto;
  expression: string;
  type?: string;
  isBool: boolean;
  isEnumerable: boolean;
  countProperty?: string;
  canBeNull: boolean;
  isAwaitable: boolean;
  isDisposable: boolean;
  isException: boolean;
  isType: boolean;
  isVoid: boolean;
  isStatement: boolean;
  suggestedName: string;
}

// ---- hierarchies and navigation

export interface HierarchyItemDto {
  id: string;
  name: string;
  detail?: string;
  kind: string;
  path?: string;
  range?: RangeDto;
  expandable: boolean;
  callSites?: RangeDto[];
  callPath?: string;
}

export interface RelatedFileDto {
  path: string;
  reason: string;
}

// ---- refactorings

export interface RefactoringsDto {
  symbolName?: string;
  symbolKind?: string;
  canRename: boolean;
  canChangeSignature: boolean;
  canSafeDelete: boolean;
  canExtractInterface: boolean;
  roslyn: CodeActionDto[];
}

export interface SignatureInfoDto {
  name: string;
  kind: 'method' | 'constructor';
  returnType?: string;
  parameters: { name: string; type: string; defaultValue?: string; modifier?: string; isParams: boolean }[];
  isExtension: boolean;
  overloads: number;
}

export interface SignatureParameterEditDto {
  originalIndex: number;
  name: string;
  type: string;
  defaultValue?: string | null;
  callSiteValue?: string | null;
}

export interface SafeDeleteCheckDto {
  name: string;
  kind: string;
  usages: LocationDto[];
}

export interface ExtractInterfaceInfoDto {
  typeName: string;
  suggestedName: string;
  folder: string;
  members: { id: string; display: string; kind: string }[];
}

// ---- inspections

export interface InspectionDto {
  severity: 'error' | 'warning' | 'info' | 'hint';
  code: string;
  message: string;
  range: RangeDto;
  path: string;
  title: string;
  category: string;
  helpLink?: string;
  unnecessary: boolean;
  fixable: boolean;
}
