namespace Kod.Engine.Intel;

/// <summary>1-based lines and columns, like Monaco.</summary>
public sealed record RangeDto(int StartLine, int StartColumn, int EndLine, int EndColumn);

public sealed record TextEditDto(RangeDto Range, string NewText);

/// <summary>Edits for one file; <see cref="NewText"/> is the whole content of a file the change creates.</summary>
public sealed record FileEditsDto(string Path, IReadOnlyList<TextEditDto> Edits, bool Created = false, string? NewText = null);

/// <summary>Position requests carry the editor text, so the answer always matches what is on screen.</summary>
public sealed record DocRequest(string Path, string? Text, int Line, int Column, string? TriggerCharacter = null);

public sealed record RangeRequest(string Path, string? Text, RangeDto Range, bool Invoked = false);

public sealed record TextRequest(string Path, string? Text);

public sealed record CompletionItemDto(
    int Index, string Label, string Kind, string? Detail, string FilterText, string SortText, string InsertText,
    RangeDto Range, IReadOnlyList<TextEditDto>? AdditionalEdits, bool Preselect, bool IsSnippet);

public sealed record CompletionListDto(string ListId, IReadOnlyList<CompletionItemDto> Items);

public sealed record CompletionResolveRequest(string ListId, int Index);

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
