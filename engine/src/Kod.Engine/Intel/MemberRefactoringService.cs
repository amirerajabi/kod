using System.Text;
using Kod.Engine.Infrastructure;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;

namespace Kod.Engine.Intel;

/// <summary>
/// Rider's type and member refactorings: Move Type to Another File / Folder, Pull Members Up, Push Members Down, Inline
/// and Extract Class. Like <see cref="RefactoringService"/>, each returns text edits per file.
/// </summary>
public sealed partial class MemberRefactoringService(IntelService intel, CodeActionService actions, ILogger<MemberRefactoringService> log)
{
    // ------------------------------------------------------------------ what applies here

    public async Task<MoreRefactoringsDto> AvailableAsync(DocRequest r, CancellationToken ct)
    {
        var (_, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var canInline = symbol is ILocalSymbol || symbol is IMethodSymbol { MethodKind: MethodKind.Ordinary } m && m.Locations.Any(l => l.IsInSource) || CanInlineField(symbol);
        try
        {
            var (doc, decl, type, _) = await GenerateService.TypeAtAsync(intel, r.Path, r.Text, r.Line, r.Column, ct, interfaces: true);
            var isClass = type.TypeKind == TypeKind.Class && !type.IsStatic;
            var hasMembers = Movable(type, decl).Any();
            var derived = isClass && hasMembers && (await SymbolFinder.FindDerivedClassesAsync(type, doc.Project.Solution, transitive: false, cancellationToken: ct)).Any(d => d.Locations.Any(l => l.IsInSource));
            return new MoreRefactoringsDto(
                type.Name,
                CanMoveType: decl.Parent is BaseNamespaceDeclarationSyntax or CompilationUnitSyntax && !type.DeclaringSyntaxReferences.Skip(1).Any(),
                CanPullUp: hasMembers && type.TypeKind is TypeKind.Class or TypeKind.Struct && PullTargets(type).Any(),
                CanPushDown: derived,
                CanInline: canInline,
                CanExtractClass: isClass && hasMembers && !type.IsGenericType);
        }
        catch (InvalidOperationException)
        {
            return new MoreRefactoringsDto(null, false, false, false, canInline, false);
        }
    }

    // ------------------------------------------------------------------ shared

    /// <summary>Members of this declaration that can move to another type (overrides stay with the type they override in).</summary>
    private static IEnumerable<ISymbol> Movable(INamedTypeSymbol type, TypeDeclarationSyntax decl) =>
        type.GetMembers().Where(m => !m.IsImplicitlyDeclared && !m.IsOverride
            && m.DeclaringSyntaxReferences.Any(s => s.SyntaxTree == decl.SyntaxTree && decl.Span.Contains(s.Span)) && m switch
            {
                IMethodSymbol x => x.MethodKind == MethodKind.Ordinary,
                IPropertySymbol x => x.ExplicitInterfaceImplementations.IsEmpty,
                IFieldSymbol x => x.AssociatedSymbol is null,
                IEventSymbol x => x.ExplicitInterfaceImplementations.IsEmpty,
                _ => false,
            });

    internal static string MemberId(ISymbol m) => DocumentationCommentId.CreateDeclarationId(m) ?? m.Name;

    private static readonly SymbolDisplayFormat MemberFormat = new(
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeType | SymbolDisplayMemberOptions.IncludeRef,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeParamsRefOut,
        propertyStyle: SymbolDisplayPropertyStyle.ShowReadWriteDescriptor,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier | SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers);

    private static MovableMemberDto ToDto(ISymbol m) => new(
        MemberId(m),
        (m.IsStatic ? "static " : "") + m.ToDisplayString(MemberFormat),
        Kinds.FromSymbol(m),
        CanBeAbstract: m is IMethodSymbol or IPropertySymbol && !m.IsStatic && !m.IsAbstract,
        IsPublic: m.DeclaredAccessibility == Accessibility.Public && !m.IsStatic);

    /// <summary>The declaration to copy (a field declaration with only this variable) and the node to remove.</summary>
    private static (MemberDeclarationSyntax Copy, SyntaxNode Remove) MemberNode(ISymbol m, TypeDeclarationSyntax decl)
    {
        var node = m.DeclaringSyntaxReferences.Select(s => s.GetSyntax()).First(n => n.SyntaxTree == decl.SyntaxTree && decl.Span.Contains(n.Span));
        if (node is VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax { Parent: BaseFieldDeclarationSyntax field } vd } v)
            return vd.Variables.Count == 1 ? (field, field) : (field.WithDeclaration(vd.WithVariables(SyntaxFactory.SingletonSeparatedList(v))), v);
        return ((MemberDeclarationSyntax)node, node);
    }

    /// <summary>Names of members of <paramref name="type"/> the given code uses that do not pass <paramref name="ok"/>.</summary>
    private static List<string> Dependencies(SemanticModel model, IEnumerable<SyntaxNode> nodes, INamedTypeSymbol type, Func<ISymbol, bool> ok, CancellationToken ct)
    {
        var result = new SortedSet<string>();
        foreach (var node in nodes)
        foreach (var name in node.DescendantNodes().OfType<SimpleNameSyntax>())
        {
            if (model.GetSymbolInfo(name, ct).Symbol is not { } s || s is INamedTypeSymbol or ILocalSymbol or IParameterSymbol or ITypeParameterSymbol or INamespaceSymbol) continue;
            s = s.OriginalDefinition;
            if (SymbolEqualityComparer.Default.Equals(s.ContainingType, type) && !ok(s)) result.Add(s.Name);
        }
        return [.. result];
    }

    private static string List(IReadOnlyCollection<string> names) =>
        string.Join(", ", names.Take(4).Select(n => $"'{n}'")) + (names.Count > 4 ? $" and {names.Count - 4} more" : "");

    /// <summary>Usings of <paramref name="from"/> (and its namespace) that <paramref name="docId"/> lacks, so moved code still binds.</summary>
    private static async Task<Solution> CopyUsingsAsync(Solution solution, DocumentId docId, CompilationUnitSyntax from, string? extraNamespace, CancellationToken ct)
    {
        var doc = solution.GetDocument(docId)!;
        if (await doc.GetSyntaxRootAsync(ct) is not CompilationUnitSyntax unit) return solution;
        var have = unit.Usings.Select(u => u.ToString()).ToHashSet();
        var add = from.Usings.Where(u => have.Add(u.ToString())).Select(u => u.WithoutTrivia()).ToList();
        var ns = unit.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax).OfType<BaseNamespaceDeclarationSyntax>().FirstOrDefault()?.Name.ToString();
        if (extraNamespace is not null && !InScope(ns, extraNamespace) && have.Add($"using {extraNamespace};"))
            add.Add(SyntaxFactory.UsingDirective(SyntaxFactory.ParseName(extraNamespace)));
        if (add.Count == 0) return solution;
        return solution.WithDocumentSyntaxRoot(docId, AddUsings(unit, add, Eol(await doc.GetTextAsync(ct))));
    }

    /// <summary>Code in namespace <paramref name="ns"/> sees the types of <paramref name="other"/> without a using.</summary>
    private static bool InScope(string? ns, string other) =>
        ns is not null && (ns == other || ns.StartsWith(other + ".", StringComparison.Ordinal));

    private static CompilationUnitSyntax AddUsings(CompilationUnitSyntax unit, IEnumerable<UsingDirectiveSyntax> usings, string eol)
    {
        var list = usings.Select(u => u.NormalizeWhitespace().WithTrailingTrivia(SyntaxFactory.EndOfLine(eol))).ToList();
        if (list.Count == 0) return unit;
        if (unit.Usings.Count == 0)
        {
            // a blank line between the usings and what follows
            list[^1] = list[^1].WithTrailingTrivia(SyntaxFactory.EndOfLine(eol), SyntaxFactory.EndOfLine(eol));
            var first = unit.GetFirstToken();
            list[0] = list[0].WithLeadingTrivia(first.LeadingTrivia);
            unit = unit.ReplaceToken(first, first.WithLeadingTrivia());
        }
        return unit.AddUsings([.. list]);
    }

    private static string Eol(Microsoft.CodeAnalysis.Text.SourceText text) => GenerateService.Eol(text);

    /// <summary>Simplifies, adds usings for and formats the annotated nodes of every changed document.</summary>
    private static async Task<Solution> CleanUpAsync(Solution before, Solution after, CancellationToken ct)
    {
        foreach (var pc in after.GetChanges(before).GetProjectChanges())
        foreach (var id in pc.GetChangedDocuments().Concat(pc.GetAddedDocuments()))
        {
            var doc = after.GetDocument(id)!;
            doc = await GenerateService.SimplifyAsync(doc, ct);
            doc = await Formatter.FormatAsync(doc, Formatter.Annotation, cancellationToken: ct);
            if (before.GetDocument(id) is { } old) doc = await GenerateService.WithEolAsync(doc, Eol(await old.GetTextAsync(ct)), ct);
            after = doc.Project.Solution;
        }
        return after;
    }

    /// <summary>A new C# file in the type's namespace (file-scoped when the original file is) with the original usings.</summary>
    private static string NewFile(CompilationUnitSyntax original, string? ns, string body, IEnumerable<string>? extraUsings = null)
    {
        var sb = new StringBuilder();
        var usings = original.Usings.Select(u => u.WithoutTrivia().ToString()).Concat(extraUsings?.Select(u => $"using {u};") ?? []).Distinct().ToList();
        foreach (var u in usings) sb.Append(u).Append('\n');
        if (usings.Count > 0) sb.Append('\n');
        var block = original.Members.OfType<NamespaceDeclarationSyntax>().Any();
        if (ns is null) sb.Append(body);
        else if (block) sb.Append("namespace ").Append(ns).Append("\n{\n").Append(body).Append("}\n");
        else sb.Append("namespace ").Append(ns).Append(";\n\n").Append(body);
        return sb.ToString();
    }

    private static async Task<Solution> AddFormattedDocumentAsync(Solution solution, Project project, string path, string text, string eol, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(project.FilePath)!;
        var folders = Path.GetRelativePath(dir, Path.GetDirectoryName(path)!).Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries).Where(f => f != ".").ToList();
        var id = DocumentId.CreateNewId(project.Id);
        solution = solution.AddDocument(id, Path.GetFileName(path), text.Replace("\r\n", "\n").Replace("\n", eol), folders, path);
        var formatted = await Formatter.FormatAsync(solution.GetDocument(id)!, cancellationToken: ct);
        return (await GenerateService.WithEolAsync(formatted, eol, ct)).Project.Solution;
    }

    // ------------------------------------------------------------------ Move Type to Another File / Folder

    public async Task<MoveTypeInfoDto> MoveTypeInfoAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, decl, type, _) = await MovableTypeAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var projectDir = Path.GetDirectoryName(doc.Project.FilePath)!;
        var folders = doc.Project.Documents
            .Select(d => d.FilePath is { } p ? Path.GetDirectoryName(p) : null)
            .OfType<string>()
            .Where(d => PathUtil.IsUnder(d, projectDir) && !IsBuildOutput(Path.GetRelativePath(projectDir, d)))
            .Append(projectDir)
            .Distinct(PathUtil.Comparer)
            .OrderBy(d => d, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var unit = (CompilationUnitSyntax)(await doc.GetSyntaxRootAsync(ct))!;
        return new MoveTypeInfoDto(
            type.Name, type.ContainingNamespace.IsGlobalNamespace ? "" : type.ContainingNamespace.ToDisplayString(),
            Path.GetDirectoryName(doc.FilePath!)!, projectDir, doc.Project.DefaultNamespace, folders, TopLevelTypes(unit).Count() == 1);
    }

    private static bool IsBuildOutput(string relative) =>
        relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) is [var first, ..] && first is "obj" or "bin";

    private static IEnumerable<MemberDeclarationSyntax> TopLevelTypes(CompilationUnitSyntax unit) =>
        unit.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax).OfType<MemberDeclarationSyntax>().Where(n => n is not BaseNamespaceDeclarationSyntax);

    private async Task<(Document Doc, TypeDeclarationSyntax Decl, INamedTypeSymbol Type, SemanticModel Model)> MovableTypeAsync(string path, string? text, int line, int column, CancellationToken ct)
    {
        var found = await GenerateService.TypeAtAsync(intel, path, text, line, column, ct, interfaces: true);
        // the outermost type: a nested type moves with the type that contains it
        var decl = found.Decl.AncestorsAndSelf().OfType<TypeDeclarationSyntax>().Last();
        var type = found.Model.GetDeclaredSymbol(decl, ct)!;
        if (type.DeclaringSyntaxReferences.Length > 1) throw new InvalidOperationException($"'{type.Name}' is partial: move its files instead");
        if (found.Doc.Project.FilePath is null || found.Doc.FilePath is null) throw new InvalidOperationException("The file is not part of a project");
        return (found.Doc, decl, type, found.Model);
    }

    /// <summary>The namespace a folder of the project maps to: the root namespace plus each folder name.</summary>
    internal static string NamespaceFor(Project project, string folder)
    {
        var dir = Path.GetDirectoryName(project.FilePath)!;
        var root = project.DefaultNamespace ?? project.AssemblyName;
        var parts = Path.GetRelativePath(dir, folder).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
            .Where(p => p != ".")
            .Select(p => new string(p.Select((c, i) => char.IsLetterOrDigit(c) || c == '_' ? c : '_').ToArray()))
            .Select(p => char.IsDigit(p[0]) ? "_" + p : p);
        return string.Join(".", new[] { root }.Concat(parts).Where(p => p.Length > 0));
    }

    public async Task<IReadOnlyList<FileEditsDto>> MoveTypeAsync(MoveTypeRequest r, CancellationToken ct)
    {
        var (doc, decl, type, model) = await MovableTypeAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var project = doc.Project;
        var projectDir = Path.GetDirectoryName(project.FilePath)!;
        var folder = Path.GetFullPath(Path.IsPathRooted(r.Folder) ? r.Folder : Path.Combine(projectDir, r.Folder));
        if (!PathUtil.IsUnder(folder, projectDir) && !PathUtil.Equal(folder, projectDir)) throw new InvalidOperationException("Choose a folder inside the project");
        var file = Path.Combine(folder, type.Name + ".cs");
        var unit = (CompilationUnitSyntax)(await doc.GetSyntaxRootAsync(ct))!;
        var onlyType = TopLevelTypes(unit).Count() == 1;
        if (PathUtil.Equal(file, doc.FilePath!) && (!r.UpdateNamespace || NamespaceFor(project, folder) == type.ContainingNamespace.ToDisplayString()))
            throw new InvalidOperationException($"'{type.Name}' is already in {type.Name}.cs there");
        if (!PathUtil.Equal(file, doc.FilePath!) && (File.Exists(file) || project.Solution.GetDocumentIdsWithFilePath(file).Any()))
            throw new InvalidOperationException($"{Path.GetFileName(file)} already exists in that folder");

        var oldNs = type.ContainingNamespace.IsGlobalNamespace ? null : type.ContainingNamespace.ToDisplayString();
        var newNs = r.UpdateNamespace ? NamespaceFor(project, folder) : oldNs;
        var before = project.Solution;
        var solution = before;
        var text = await doc.GetTextAsync(ct);
        var eol = Eol(text);

        // references elsewhere: a using for the new namespace, or the qualified name rewritten
        var referencing = new Dictionary<DocumentId, List<SyntaxNode>>();
        if (newNs != oldNs && newNs is not null)
        {
            foreach (var rs in await SymbolFinder.FindReferencesAsync(type, before, ct))
            foreach (var loc in rs.Locations)
            {
                if (!loc.Location.IsInSource || loc.Location.SourceTree == decl.SyntaxTree && decl.Span.Contains(loc.Location.SourceSpan)) continue;
                var node = (await loc.Location.SourceTree!.GetRootAsync(ct)).FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
                if (!referencing.TryGetValue(loc.Document.Id, out var list)) referencing[loc.Document.Id] = list = [];
                list.Add(node);
            }
        }

        var editor = new SolutionEditor(solution);
        var usingsFor = new HashSet<DocumentId>();
        foreach (var (id, nodes) in referencing)
        {
            if (id == doc.Id && onlyType) continue;
            var de = await editor.GetDocumentEditorAsync(id, ct);
            foreach (var node in nodes)
            {
                if (node.Parent is QualifiedNameSyntax q && q.Right == node || node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node && de.SemanticModel.GetSymbolInfo(ma.Expression, ct).Symbol is INamespaceSymbol)
                {
                    var qualified = SyntaxFactory.ParseName($"global::{newNs}.{node}").WithTriviaFrom(node.Parent).WithAdditionalAnnotations(Simplifier.Annotation);
                    de.ReplaceNode(node.Parent, qualified);
                }
                else if (!InScope(node.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().FirstOrDefault()?.Name.ToString(), newNs!))
                {
                    usingsFor.Add(id);
                }
            }
        }
        if (!onlyType) (await editor.GetDocumentEditorAsync(doc.Id, ct)).RemoveNode(decl, SyntaxRemoveOptions.KeepUnbalancedDirectives);
        solution = editor.GetChangedSolution();
        foreach (var id in usingsFor)
        {
            var d = solution.GetDocument(id)!;
            if (await d.GetSyntaxRootAsync(ct) is CompilationUnitSyntax cu && cu.Usings.All(u => u.Name?.ToString() != newNs))
                solution = solution.WithDocumentSyntaxRoot(id, AddUsings(cu, [SyntaxFactory.UsingDirective(SyntaxFactory.ParseName(newNs!))], Eol(await d.GetTextAsync(ct))));
        }

        // the new file: the type with its comments, without the blank lines before it
        var leading = decl.GetLeadingTrivia().SkipWhile(t => t.IsKind(SyntaxKind.EndOfLineTrivia) || t.IsKind(SyntaxKind.WhitespaceTrivia));
        var body = decl.WithLeadingTrivia(leading).ToFullString().TrimEnd() + "\n";
        // a using of the old namespace when the type uses its other types
        var usesOld = oldNs is not null && decl.DescendantNodes().OfType<SimpleNameSyntax>().Any(n =>
            model.GetSymbolInfo(n, ct).Symbol is INamedTypeSymbol t && t.ContainingType is null && t.ContainingNamespace.ToDisplayString() == oldNs && !SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, type));
        var extra = usesOld && newNs != oldNs && !InScope(newNs, oldNs!) ? new[] { oldNs! } : null;
        var content = NewFile(unit, newNs, body, extra);
        if (onlyType) solution = solution.RemoveDocument(doc.Id);
        solution = await AddFormattedDocumentAsync(solution, project, file, content, eol, ct);
        solution = await CleanUpAsync(before, solution, ct);

        var result = (await IntelService.DiffAsync(before, solution, ct)).ToList();
        if (onlyType)
        {
            result.RemoveAll(f => PathUtil.Equal(f.Path, doc.FilePath!) && !f.Created);
            if (!PathUtil.Equal(file, doc.FilePath!)) result.Add(new FileEditsDto(doc.FilePath!, [], Deleted: true));
            else
            {
                // same file, new namespace: an edit of the whole file rather than delete + create
                var created = result.First(f => PathUtil.Equal(f.Path, file));
                result.Remove(created);
                result.Add(new FileEditsDto(file, [new TextEditDto(IntelService.ToRange(text, new Microsoft.CodeAnalysis.Text.TextSpan(0, text.Length)), created.NewText ?? "")]));
            }
        }
        return result;
    }
}
