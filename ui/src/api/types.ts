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
  | { type: 'proc.output'; id: string; text: string };
