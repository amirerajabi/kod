namespace Kod.Engine.Intel;

/// <summary>1-based lines and columns, like Monaco.</summary>
public sealed record RangeDto(int StartLine, int StartColumn, int EndLine, int EndColumn);

public sealed record TextEditDto(RangeDto Range, string NewText);

/// <summary>Edits for one file; <see cref="NewText"/> is the whole content of a file the change creates, <see cref="Deleted"/> a file it removes.</summary>
public sealed record FileEditsDto(string Path, IReadOnlyList<TextEditDto> Edits, bool Created = false, string? NewText = null, bool Deleted = false);

/// <summary>Position requests carry the editor text, so the answer always matches what is on screen.</summary>
public sealed record DocRequest(string Path, string? Text, int Line, int Column, string? TriggerCharacter = null);

public sealed record RangeRequest(string Path, string? Text, RangeDto Range, bool Invoked = false);

public sealed record TextRequest(string Path, string? Text);

public sealed record CompletionItemDto(
    int Index, string Label, string Kind, string? Detail, string FilterText, string SortText, string InsertText,
    RangeDto Range, IReadOnlyList<TextEditDto>? AdditionalEdits, bool Preselect, bool IsSnippet, bool EditsOnResolve = false);

/// <summary>An item's documentation, and for an item from another namespace the using directive it adds.</summary>
public sealed record CompletionResolveDto(string? Documentation, IReadOnlyList<TextEditDto>? AdditionalEdits);

/// <param name="Incomplete">Only the best matches for the typed prefix: the editor asks again as the user types.</param>
public sealed record CompletionListDto(string ListId, IReadOnlyList<CompletionItemDto> Items, bool Incomplete = false);

public sealed record CompletionResolveRequest(string ListId, int Index, bool Edits = false);

public sealed record HoverDto(string Markdown, RangeDto? Range);

public sealed record SignatureParameterDto(int Start, int End, string? Documentation);

public sealed record SignatureDto(string Label, string? Documentation, IReadOnlyList<SignatureParameterDto> Parameters);

public sealed record SignatureHelpDto(IReadOnlyList<SignatureDto> Signatures, int ActiveSignature, int ActiveParameter);

public sealed record DiagnosticDto(string Severity, string Code, string Message, RangeDto Range, bool Unnecessary, string Path);

public sealed record LocationDto(string Path, RangeDto Range, string? Preview = null, bool IsDefinition = false);

/// <summary>A location in a generated, read-only metadata view (a framework or package type).</summary>
public sealed record MetadataViewDto(string Uri, string Title, string Text, RangeDto Range);

public sealed record DefinitionDto(IReadOnlyList<LocationDto> Locations, MetadataViewDto? Metadata);

public sealed record RenameRequest(string Path, string? Text, int Line, int Column, string NewName);

public sealed record PrepareRenameDto(RangeDto Range, string Text);

public sealed record SymbolDto(string Name, string? Detail, string Kind, RangeDto Range, RangeDto SelectionRange, IReadOnlyList<SymbolDto> Children);

public sealed record WorkspaceSymbolDto(string Name, string? Container, string Kind, string Path, RangeDto Range);

public sealed record CodeActionDto(string Id, string Title, string Kind, bool IsPreferred);

public sealed record SemanticTokensDto(int[] Data);

// ---- inlay hints, Code Vision, postfix templates

/// <summary>A hint drawn before the character at Line:Column ("type" after a var, "parameter" before an argument).</summary>
public sealed record InlayHintDto(int Line, int Column, string Label, string Kind, bool PaddingLeft, bool PaddingRight);

/// <summary>A declaration that gets Code Vision lenses (usages, implementations); counted when it scrolls into view.</summary>
public sealed record CodeVisionEntryDto(int Line, int Column, string Kind, bool Implementable);

public sealed record CodeVisionDto(int Usages, int Implementations, string? ImplementationsLabel);

/// <summary>The expression before a '.' that postfix templates (.if, .foreach, .var…) wrap, and what it can be used as.</summary>
public sealed record PostfixContextDto(
    RangeDto Range, string Expression, string? Type, bool IsBool, bool IsEnumerable, string? CountProperty, bool CanBeNull,
    bool IsAwaitable, bool IsDisposable, bool IsException, bool IsType, bool IsVoid, bool IsStatement, string SuggestedName);

// ---- hierarchies and structural navigation

/// <summary>A symbol in a call / type hierarchy or a navigation list. <see cref="Id"/> finds it again (project + documentation id).</summary>
public sealed record HierarchyItemDto(
    string Id, string Name, string? Detail, string Kind, string? Path, RangeDto? Range, bool Expandable, IReadOnlyList<RangeDto>? CallSites = null, string? CallPath = null);

public sealed record HierarchyRequest(string Id, string Direction);

public sealed record SymbolIdRequest(string Id);

public sealed record RelatedFileDto(string Path, string Reason);

// ---- refactorings

public sealed record RefactoringsDto(
    string? SymbolName, string? SymbolKind, bool CanRename, bool CanChangeSignature, bool CanSafeDelete, bool CanExtractInterface,
    IReadOnlyList<CodeActionDto> Roslyn);

public sealed record SignatureParameterInfoDto(string Name, string Type, string? DefaultValue, string? Modifier, bool IsParams);

public sealed record SignatureInfoDto(string Name, string Kind, string? ReturnType, IReadOnlyList<SignatureParameterInfoDto> Parameters, bool IsExtension, int Overloads);

/// <summary>One parameter of the new signature: an existing one (<see cref="OriginalIndex"/> ≥ 0, maybe renamed or moved)
/// or a new one, passed as <see cref="CallSiteValue"/> at every call (or left to its <see cref="DefaultValue"/>).</summary>
public sealed record SignatureParameterEditDto(int OriginalIndex, string Name, string Type, string? DefaultValue, string? CallSiteValue);

public sealed record ChangeSignatureRequest(string Path, string? Text, int Line, int Column, IReadOnlyList<SignatureParameterEditDto> Parameters);

public sealed record SafeDeleteCheckDto(string Name, string Kind, IReadOnlyList<LocationDto> Usages);

public sealed record SafeDeleteRequest(string Path, string? Text, int Line, int Column, bool Force);

public sealed record InterfaceMemberDto(string Id, string Display, string Kind);

public sealed record ExtractInterfaceInfoDto(string TypeName, string SuggestedName, string Folder, IReadOnlyList<InterfaceMemberDto> Members);

public sealed record ExtractInterfaceRequest(string Path, string? Text, int Line, int Column, string Name, IReadOnlyList<string> MemberIds);

// ---- inspections

public sealed record InspectionDto(
    string Severity, string Code, string Message, RangeDto Range, string Path, string Title, string Category, string? HelpLink, bool Unnecessary, bool Fixable);

public sealed record FixAllRequest(string Code, string Scope, string? Path);

public sealed record CleanupRequest(string Path, string? Text);
