namespace Kod.Engine.Intel;

// ---- Generate (Alt+Insert)

/// <summary>A field or property of the type at the caret, offered to the Generate dialogs.</summary>
public sealed record GenerateMemberDto(string Id, string Name, string Type, string Kind, bool Assignable, bool IsReference, bool IsDisposable);

/// <summary>A member of a base type or interface that Generate › Overriding / Missing members can write.</summary>
public sealed record GenerateSignatureDto(string Id, string Display, string Kind, string Owner);

/// <summary>What Generate can write for the type at the caret; <c>Has*</c> mark members the type already declares.</summary>
public sealed record GenerateInfoDto(
    string TypeName, string TypeKind, IReadOnlyList<GenerateMemberDto> Members, IReadOnlyList<GenerateMemberDto> Fields,
    IReadOnlyList<GenerateSignatureDto> Overridable, IReadOnlyList<GenerateSignatureDto> Missing,
    bool HasEquals, bool HasToString, bool IsDisposable, bool IsSealed);

/// <param name="Kind">constructor, properties, readonlyProperties, equality, formatting, overrides, missing or dispose.</param>
/// <param name="Mutable">Properties: get and set (else get only).</param>
/// <param name="NullChecks">Constructor: throw <c>ArgumentNullException</c> for null reference arguments.</param>
/// <param name="Operators">Equality: also == and !=.</param>
/// <param name="Equatable">Equality: implement <c>IEquatable&lt;T&gt;</c>.</param>
public sealed record GenerateRequest(
    string Path, string? Text, int Line, int Column, string Kind, IReadOnlyList<string> MemberIds,
    bool Mutable = false, bool NullChecks = false, bool Operators = true, bool Equatable = true);

// ---- member refactorings (Move Type, Pull Up, Push Down, Inline, Extract Class)

public sealed record MoreRefactoringsDto(string? TypeName, bool CanMoveType, bool CanPullUp, bool CanPushDown, bool CanInline, bool CanExtractClass);

public sealed record MoveTypeInfoDto(string TypeName, string Namespace, string Folder, string ProjectFolder, string? RootNamespace, IReadOnlyList<string> Folders, bool OnlyType);

public sealed record MoveTypeRequest(string Path, string? Text, int Line, int Column, string Folder, bool UpdateNamespace);

/// <summary>A member Pull Up / Push Down / Extract Class can move; <see cref="CanBeAbstract"/>: a method or property with a body.</summary>
public sealed record MovableMemberDto(string Id, string Display, string Kind, bool CanBeAbstract, bool IsPublic);

/// <summary>A base class / interface (Pull Up) or a derived class (Push Down) in source.</summary>
public sealed record MemberTargetDto(string Id, string Name, string Kind, string Path);

public sealed record MoveMembersInfoDto(string TypeName, IReadOnlyList<MemberTargetDto> Targets, IReadOnlyList<MovableMemberDto> Members);

/// <param name="Abstract">Pull Up: members that stay in the class as overrides of a new abstract member; Push Down: members whose
/// abstract declaration stays in the base class.</param>
public sealed record PullUpRequest(string Path, string? Text, int Line, int Column, string TargetId, IReadOnlyList<string> MemberIds, IReadOnlyList<string> Abstract);

public sealed record PushDownRequest(string Path, string? Text, int Line, int Column, IReadOnlyList<string> MemberIds, IReadOnlyList<string> Abstract);

/// <summary>What Inline does at the caret: Roslyn's inline refactorings, or Kod's for a constant / field.</summary>
public sealed record InlineInfoDto(string? Name, string? Kind, IReadOnlyList<CodeActionDto> Roslyn, bool CanInlineField, int Usages, bool CanInlineAllCalls);

/// <param name="Keep">Inline every call of the method but keep its declaration.</param>
/// <param name="ThisCall">Inline only the call at the caret (the method stays).</param>
public sealed record InlineRequest(string Path, string? Text, int Line, int Column, bool Keep = false, bool ThisCall = false);

public sealed record ExtractClassInfoDto(string TypeName, string SuggestedName, string Folder, IReadOnlyList<MovableMemberDto> Members);

public sealed record ExtractClassRequest(string Path, string? Text, int Line, int Column, string Name, string FieldName, IReadOnlyList<string> MemberIds);
