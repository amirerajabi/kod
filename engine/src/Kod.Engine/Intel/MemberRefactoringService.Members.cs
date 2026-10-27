using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;

namespace Kod.Engine.Intel;

public sealed partial class MemberRefactoringService
{
    // ------------------------------------------------------------------ Pull Members Up / Push Members Down

    /// <summary>Base classes in source, and interfaces in source the type lists itself (so it is what implements them).</summary>
    private static IEnumerable<INamedTypeSymbol> PullTargets(INamedTypeSymbol type)
    {
        for (var b = type.BaseType; b is not null && b.DeclaringSyntaxReferences.Length > 0; b = b.BaseType)
            if (b.TypeKind == TypeKind.Class) yield return b.OriginalDefinition;
        foreach (var i in type.Interfaces.Where(i => i.DeclaringSyntaxReferences.Length > 0))
            yield return i.OriginalDefinition;
    }

    private static MemberTargetDto Target(INamedTypeSymbol t) =>
        new(MemberId(t), t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat), Kinds.FromSymbol(t), t.DeclaringSyntaxReferences[0].SyntaxTree.FilePath);

    private async Task<List<INamedTypeSymbol>> DerivedAsync(INamedTypeSymbol type, Solution solution, CancellationToken ct) =>
        (await SymbolFinder.FindDerivedClassesAsync(type, solution, transitive: false, cancellationToken: ct))
            .Where(d => d.DeclaringSyntaxReferences.Length > 0).Select(d => d.OriginalDefinition).ToList();

    public async Task<MoveMembersInfoDto> MoveMembersInfoAsync(DocRequest r, bool up, CancellationToken ct)
    {
        var (doc, decl, type, _) = await GenerateService.TypeAtAsync(intel, r.Path, r.Text, r.Line, r.Column, ct);
        var targets = up ? PullTargets(type).ToList() : await DerivedAsync(type, doc.Project.Solution, ct);
        if (targets.Count == 0)
            throw new InvalidOperationException(up ? $"'{type.Name}' has no base class or interface in the solution" : $"'{type.Name}' has no derived classes in the solution");
        return new MoveMembersInfoDto(type.Name, targets.Select(Target).ToList(), Movable(type, decl).Select(ToDto).ToList());
    }

    private static TypeDeclarationSyntax DeclarationOf(INamedTypeSymbol t, CancellationToken ct) =>
        t.DeclaringSyntaxReferences.Select(s => s.GetSyntax(ct)).OfType<TypeDeclarationSyntax>().First();

    /// <summary>The member as an abstract declaration: no body, accessors without bodies, never private.</summary>
    private static MemberDeclarationSyntax AbstractOf(MemberDeclarationSyntax member, ISymbol symbol, SyntaxGenerator g)
    {
        AccessorListSyntax Accessors(IPropertySymbol p)
        {
            var list = new List<AccessorDeclarationSyntax>();
            if (p.GetMethod is not null) list.Add(SyntaxFactory.AccessorDeclaration(SyntaxKind.GetAccessorDeclaration).WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken)));
            if (p.SetMethod is not null) list.Add(SyntaxFactory.AccessorDeclaration(p.SetMethod.IsInitOnly ? SyntaxKind.InitAccessorDeclaration : SyntaxKind.SetAccessorDeclaration).WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken)));
            return SyntaxFactory.AccessorList(SyntaxFactory.List(list));
        }
        MemberDeclarationSyntax result = member switch
        {
            MethodDeclarationSyntax m => m.WithBody(null).WithExpressionBody(null).WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken)),
            PropertyDeclarationSyntax p => p.WithExpressionBody(null).WithInitializer(null).WithSemicolonToken(default).WithAccessorList(Accessors((IPropertySymbol)symbol)),
            IndexerDeclarationSyntax i => i.WithExpressionBody(null).WithSemicolonToken(default).WithAccessorList(Accessors((IPropertySymbol)symbol)),
            _ => throw new InvalidOperationException($"'{symbol.Name}' cannot be abstract"),
        };
        result = (MemberDeclarationSyntax)g.WithModifiers(result, Modifiers(symbol).WithIsAbstract(true).WithIsVirtual(false).WithIsOverride(false).WithAsync(false));
        if (symbol.DeclaredAccessibility == Accessibility.Private) result = (MemberDeclarationSyntax)g.WithAccessibility(result, Accessibility.Protected);
        return result.WithAdditionalAnnotations(Formatter.Annotation);
    }

    /// <summary>The member's modifiers; Roslyn reports a get-only property as read-only, which is no modifier in C#.</summary>
    private static DeclarationModifiers Modifiers(ISymbol s) =>
        s is IFieldSymbol ? DeclarationModifiers.From(s) : DeclarationModifiers.From(s).WithIsReadOnly(false);

    private static DeclarationModifiers AsOverride(ISymbol s) =>
        Modifiers(s).WithIsVirtual(false).WithIsAbstract(false).WithIsNew(false).WithIsOverride(true);

    public async Task<IReadOnlyList<FileEditsDto>> PullUpAsync(PullUpRequest r, CancellationToken ct)
    {
        var (doc, decl, type, model) = await GenerateService.TypeAtAsync(intel, r.Path, r.Text, r.Line, r.Column, ct);
        var target = PullTargets(type).FirstOrDefault(t => MemberId(t) == r.TargetId) ?? throw new InvalidOperationException("Choose the base type to pull the members up to");
        var members = Movable(type, decl).Where(m => r.MemberIds.Contains(MemberId(m))).ToList();
        if (members.Count == 0) throw new InvalidOperationException("Choose the members to pull up");
        var moved = members.Select(m => m.OriginalDefinition).ToHashSet(SymbolEqualityComparer.Default);
        var makeAbstract = members.Where(m => r.Abstract.Contains(MemberId(m)) && m is IMethodSymbol or IPropertySymbol && !m.IsStatic).ToHashSet(SymbolEqualityComparer.Default);
        var toInterface = target.TypeKind == TypeKind.Interface;
        if (toInterface && members.FirstOrDefault(m => m.DeclaredAccessibility != Accessibility.Public || m.IsStatic || m is IFieldSymbol) is { } bad)
            throw new InvalidOperationException($"Only public instance methods, properties and events can be pulled up to an interface: '{bad.Name}' is not one");

        // what moves (bodies included) must not use what stays
        var nodes = members.Where(m => !toInterface && !makeAbstract.Contains(m)).Select(m => MemberNode(m, decl).Copy).ToList();
        var deps = Dependencies(model, nodes, type, s => moved.Contains(s), ct);
        if (deps.Count > 0) throw new InvalidOperationException($"The moved members use {List(deps)}, which stay in '{type.Name}': pull them up too, or make them abstract");

        var solution = doc.Project.Solution;
        var targetDecl = DeclarationOf(target, ct);
        var targetId = solution.GetDocumentId(targetDecl.SyntaxTree) ?? throw new InvalidOperationException($"'{target.Name}' is not in the solution");
        var editor = new SolutionEditor(solution);
        var source = await editor.GetDocumentEditorAsync(doc.Id, ct);
        var dest = await editor.GetDocumentEditorAsync(targetId, ct);
        var g = source.Generator;

        // private members the type still uses become protected in the base
        var stillUsed = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var m in members.Where(m => m.DeclaredAccessibility == Accessibility.Private))
        foreach (var rs in await SymbolFinder.FindReferencesAsync(m, solution, ct))
            if (rs.Locations.Any(l => l.Location.SourceTree == decl.SyntaxTree && decl.Span.Contains(l.Location.SourceSpan) && !members.Any(o => MemberNode(o, decl).Copy.Span.Contains(l.Location.SourceSpan))))
                stillUsed.Add(m);

        foreach (var m in members)
        {
            var (copy, remove) = MemberNode(m, decl);
            if (toInterface)
            {
                dest.AddMember(targetDecl, copy.WithoutLeadingTrivia().WithAdditionalAnnotations(Formatter.Annotation));
                continue;
            }
            if (makeAbstract.Contains(m))
            {
                dest.AddMember(targetDecl, Spaced(AbstractOf(copy, m, g)));
                source.SetModifiers(remove, AsOverride(m));
                if (m.DeclaredAccessibility == Accessibility.Private) source.SetAccessibility(remove, Accessibility.Protected);
                continue;
            }
            SyntaxNode up = copy.WithAdditionalAnnotations(Formatter.Annotation);
            if (stillUsed.Contains(m)) up = g.WithAccessibility(up, Accessibility.Protected);
            dest.AddMember(targetDecl, Spaced(up));
            source.RemoveNode(remove, SyntaxRemoveOptions.KeepNoTrivia);
        }
        if (makeAbstract.Count > 0 && !target.IsAbstract) dest.SetModifiers(targetDecl, DeclarationModifiers.From(target).WithIsAbstract(true));

        // the other types that now miss the new abstract / interface members get stubs
        var newlyRequired = toInterface ? members : members.Where(makeAbstract.Contains).ToList();
        if (newlyRequired.Count > 0)
        {
            foreach (var other in await OtherImplementersAsync(target, type, solution, ct))
            {
                var otherDecl = DeclarationOf(other, ct);
                if (solution.GetDocumentId(otherDecl.SyntaxTree) is not { } otherId) continue;
                var oe = await editor.GetDocumentEditorAsync(otherId, ct);
                foreach (var m in newlyRequired.Where(m => other.GetMembers(m.Name).IsEmpty))
                    oe.AddMember(otherDecl, Spaced(GenerateService.Implement(g, m, model.Compilation, overriding: !toInterface, forceStub: true).WithAdditionalAnnotations(Formatter.Annotation)));
            }
        }

        var after = editor.GetChangedSolution();
        if (targetId != doc.Id) after = await CopyUsingsAsync(after, targetId, (CompilationUnitSyntax)decl.SyntaxTree.GetRoot(ct), Namespace(type), ct);
        after = await CleanUpAsync(solution, after, ct);
        return await IntelService.DiffAsync(solution, after, ct);
    }

    /// <summary>Types other than <paramref name="source"/> (and its subclasses) that must now implement what moved up: classes
    /// that list the interface themselves, or the first non-abstract classes below the base class.</summary>
    private static async Task<List<INamedTypeSymbol>> OtherImplementersAsync(INamedTypeSymbol target, INamedTypeSymbol source, Solution solution, CancellationToken ct)
    {
        bool Below(INamedTypeSymbol t, INamedTypeSymbol b)
        {
            for (var x = t; x is not null; x = x.BaseType)
                if (SymbolEqualityComparer.Default.Equals(x.OriginalDefinition, b)) return true;
            return false;
        }
        IEnumerable<INamedTypeSymbol> found = target.TypeKind == TypeKind.Interface
            ? (await SymbolFinder.FindImplementationsAsync(target, solution, cancellationToken: ct)).OfType<INamedTypeSymbol>()
                .Where(t => t.Interfaces.Any(i => SymbolEqualityComparer.Default.Equals(i.OriginalDefinition, target)))
            : (await SymbolFinder.FindDerivedClassesAsync(target, solution, transitive: true, cancellationToken: ct))
                .Where(t => !t.IsAbstract && AbstractUpTo(t.BaseType, target));
        return found.Where(t => t.DeclaringSyntaxReferences.Length > 0 && !Below(t, source)).Select(t => t.OriginalDefinition).Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default).ToList();

        // only abstract classes between it and the base: the first concrete class implements the member
        static bool AbstractUpTo(INamedTypeSymbol? b, INamedTypeSymbol target)
        {
            for (; b is not null && !SymbolEqualityComparer.Default.Equals(b.OriginalDefinition, target); b = b.BaseType)
                if (!b.IsAbstract) return false;
            return b is not null;
        }
    }

    /// <summary>A blank line before a member added to a type.</summary>
    private static T Spaced<T>(T node) where T : SyntaxNode =>
        node.WithLeadingTrivia(node.GetLeadingTrivia().SkipWhile(t => t.IsKind(SyntaxKind.EndOfLineTrivia)).Prepend(SyntaxFactory.EndOfLine("\n")));

    private static string? Namespace(INamedTypeSymbol t) => t.ContainingNamespace.IsGlobalNamespace ? null : t.ContainingNamespace.ToDisplayString();

    public async Task<IReadOnlyList<FileEditsDto>> PushDownAsync(PushDownRequest r, CancellationToken ct)
    {
        var (doc, decl, type, _) = await GenerateService.TypeAtAsync(intel, r.Path, r.Text, r.Line, r.Column, ct);
        var solution = doc.Project.Solution;
        var derived = await DerivedAsync(type, solution, ct);
        if (derived.Count == 0) throw new InvalidOperationException($"'{type.Name}' has no derived classes in the solution");
        var members = Movable(type, decl).Where(m => r.MemberIds.Contains(MemberId(m))).ToList();
        if (members.Count == 0) throw new InvalidOperationException("Choose the members to push down");
        var keepAbstract = members.Where(m => r.Abstract.Contains(MemberId(m)) && m is IMethodSymbol or IPropertySymbol && !m.IsStatic).ToHashSet(SymbolEqualityComparer.Default);

        // the base class must not use what leaves it
        var spans = members.Select(m => MemberNode(m, decl).Copy.Span).ToList();
        foreach (var m in members.Where(m => !keepAbstract.Contains(m)))
        foreach (var rs in await SymbolFinder.FindReferencesAsync(m, solution, ct))
        foreach (var l in rs.Locations)
            if (l.Location.SourceTree == decl.SyntaxTree && decl.Span.Contains(l.Location.SourceSpan) && !spans.Any(s => s.Contains(l.Location.SourceSpan)))
                throw new InvalidOperationException($"'{m.Name}' is still used in '{type.Name}': push down what uses it too, or keep it abstract");

        var editor = new SolutionEditor(solution);
        var source = await editor.GetDocumentEditorAsync(doc.Id, ct);
        var g = source.Generator;
        var targets = new HashSet<DocumentId>();
        foreach (var d in derived)
        {
            var dDecl = DeclarationOf(d, ct);
            var id = solution.GetDocumentId(dDecl.SyntaxTree);
            if (id is null) continue;
            targets.Add(id);
            var dest = await editor.GetDocumentEditorAsync(id, ct);
            foreach (var m in members)
            {
                // an override there already: it stays (no longer an override unless the base keeps an abstract member)
                var existing = d.GetMembers(m.Name).FirstOrDefault(x => SymbolEqualityComparer.Default.Equals(OverriddenOf(x)?.OriginalDefinition, m));
                if (existing is not null)
                {
                    if (!keepAbstract.Contains(m))
                        foreach (var sr in existing.DeclaringSyntaxReferences)
                            dest.SetModifiers(await sr.GetSyntaxAsync(ct), Modifiers(existing).WithIsOverride(false));
                    continue;
                }
                var copy = MemberNode(m, decl).Copy.WithAdditionalAnnotations(Formatter.Annotation);
                SyntaxNode down = keepAbstract.Contains(m) ? g.WithModifiers(copy, AsOverride(m)) : copy;
                if (keepAbstract.Contains(m) && m.DeclaredAccessibility == Accessibility.Private) down = g.WithAccessibility(down, Accessibility.Protected);
                dest.AddMember(dDecl, Spaced(down));
            }
        }
        foreach (var m in members)
        {
            var (copy, remove) = MemberNode(m, decl);
            if (keepAbstract.Contains(m)) source.ReplaceNode(copy, AbstractOf(copy, m, g));
            else source.RemoveNode(remove, SyntaxRemoveOptions.KeepNoTrivia);
        }
        if (keepAbstract.Count > 0 && !type.IsAbstract) source.SetModifiers(decl, DeclarationModifiers.From(type).WithIsAbstract(true));

        var after = editor.GetChangedSolution();
        foreach (var id in targets.Where(t => t != doc.Id))
            after = await CopyUsingsAsync(after, id, (CompilationUnitSyntax)decl.SyntaxTree.GetRoot(ct), Namespace(type), ct);
        after = await CleanUpAsync(solution, after, ct);
        return await IntelService.DiffAsync(solution, after, ct);
    }

    private static ISymbol? OverriddenOf(ISymbol m) => m switch
    {
        IMethodSymbol x => x.OverriddenMethod,
        IPropertySymbol x => x.OverriddenProperty,
        IEventSymbol x => x.OverriddenEvent,
        _ => null,
    };

    // ------------------------------------------------------------------ Extract Class

    public async Task<ExtractClassInfoDto> ExtractClassInfoAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, decl, type, _) = await ExtractableAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var members = Movable(type, decl).Where(m => !m.IsAbstract && !m.IsVirtual).Select(ToDto).ToList();
        return new ExtractClassInfoDto(type.Name, type.Name + "Details", Path.GetDirectoryName(doc.FilePath!)!, members);
    }

    private async Task<(Document Doc, TypeDeclarationSyntax Decl, INamedTypeSymbol Type, SemanticModel Model)> ExtractableAsync(string path, string? text, int line, int column, CancellationToken ct)
    {
        var found = await GenerateService.TypeAtAsync(intel, path, text, line, column, ct);
        if (found.Type.TypeKind != TypeKind.Class || found.Type.IsStatic) throw new InvalidOperationException("Put the caret in a class to extract a class from it");
        if (found.Type.IsGenericType) throw new InvalidOperationException("Extract Class does not support generic classes yet");
        if (found.Doc.FilePath is null) throw new InvalidOperationException("The file is not saved");
        return found;
    }

    public async Task<IReadOnlyList<FileEditsDto>> ExtractClassAsync(ExtractClassRequest r, CancellationToken ct)
    {
        if (!SyntaxFacts.IsValidIdentifier(r.Name)) throw new ArgumentException($"'{r.Name}' is not a valid class name");
        if (!SyntaxFacts.IsValidIdentifier(r.FieldName)) throw new ArgumentException($"'{r.FieldName}' is not a valid field name");
        var (doc, decl, type, model) = await ExtractableAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var ns = Namespace(type);
        if (model.Compilation.GetTypeByMetadataName(ns is null ? r.Name : $"{ns}.{r.Name}") is not null) throw new InvalidOperationException($"'{r.Name}' already exists");
        if (!type.GetMembers(r.FieldName).IsEmpty) throw new InvalidOperationException($"'{type.Name}' already has a member named '{r.FieldName}'");
        var file = Path.Combine(Path.GetDirectoryName(doc.FilePath!)!, r.Name + ".cs");
        if (File.Exists(file)) throw new InvalidOperationException($"{r.Name}.cs already exists");
        var members = Movable(type, decl).Where(m => !m.IsAbstract && !m.IsVirtual && r.MemberIds.Contains(MemberId(m))).ToList();
        if (members.Count == 0) throw new InvalidOperationException("Choose the members to extract");
        var moved = members.Select(m => m.OriginalDefinition).ToHashSet(SymbolEqualityComparer.Default);
        var nodes = members.ToDictionary(m => m, m => MemberNode(m, decl), SymbolEqualityComparer.Default);
        var deps = Dependencies(model, nodes.Values.Select(n => n.Copy), type, moved.Contains, ct);
        if (deps.Count > 0) throw new InvalidOperationException($"The extracted members use {List(deps)}, which stay in '{type.Name}': extract them too");

        var solution = doc.Project.Solution;
        bool InMoved(Location l) => l.SourceTree == decl.SyntaxTree && nodes.Values.Any(n => n.Copy.Span.Contains(l.SourceSpan));
        bool InType(Location l) => l.SourceTree == decl.SyntaxTree && decl.Span.Contains(l.SourceSpan);
        var inside = new List<(ISymbol Member, SyntaxNode Node)>();
        var usedOutside = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        var root = await decl.SyntaxTree.GetRootAsync(ct);
        foreach (var m in members)
        foreach (var rs in await SymbolFinder.FindReferencesAsync(m, solution, ct))
        foreach (var l in rs.Locations.Select(x => x.Location).Where(x => x.IsInSource && !InMoved(x)))
        {
            if (InType(l)) inside.Add((m, root.FindNode(l.SourceSpan, getInnermostNodeForTie: true)));
            else usedOutside.Add(m);
        }
        // a member that implements an interface keeps a delegating member in the original class
        foreach (var m in members)
            if (type.AllInterfaces.SelectMany(i => i.GetMembers()).Any(im => SymbolEqualityComparer.Default.Equals(type.FindImplementationForInterfaceMember(im), m)))
                usedOutside.Add(m);

        // the new class: members the original still uses become public, fields it assigns lose readonly
        var g = SyntaxGenerator.GetGenerator(doc);
        var body = new StringBuilder($"public class {r.Name}\n{{\n");
        var first = true;
        foreach (var m in members)
        {
            SyntaxNode copy = nodes[m].Copy;
            var needed = usedOutside.Contains(m) || inside.Any(i => SymbolEqualityComparer.Default.Equals(i.Member, m));
            if (needed && m.DeclaredAccessibility != Accessibility.Public) copy = g.WithAccessibility(copy, Accessibility.Public);
            if (m is IFieldSymbol { IsReadOnly: true } && inside.Any(i => SymbolEqualityComparer.Default.Equals(i.Member, m) && IsWrite(i.Node)))
                copy = g.WithModifiers(copy, DeclarationModifiers.From(m).WithIsReadOnly(false));
            var text = copy.ToFullString();
            if (first) text = text.TrimStart('\r', '\n');
            first = false;
            body.Append(text.TrimEnd()).Append('\n');
        }
        body.Append("}\n");

        // the original: a field of the new type, uses rewritten to go through it, delegating members where needed
        var source = await DocumentEditor.CreateAsync(doc, ct);
        var via = SyntaxFactory.IdentifierName(r.FieldName);
        var typeName = SyntaxFactory.IdentifierName(r.Name);
        foreach (var (m, node) in inside)
        {
            if (node is not SimpleNameSyntax name) continue;
            ExpressionSyntax owner = m.IsStatic ? typeName : via;
            if (name.Parent is MemberAccessExpressionSyntax ma && ma.Name == name)
            {
                if (m.IsStatic || ma.Expression is ThisExpressionSyntax) source.ReplaceNode(ma.Expression, owner.WithTriviaFrom(ma.Expression));
                else source.ReplaceNode(ma.Expression, SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, ma.Expression, via).WithTriviaFrom(ma.Expression));
            }
            else if (name.Parent is not MemberBindingExpressionSyntax)
            {
                source.ReplaceNode(name, SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, owner, name.WithoutTrivia()).WithTriviaFrom(name));
            }
        }
        var eol = Eol(await doc.GetTextAsync(ct));
        foreach (var m in members)
        {
            var (_, remove) = nodes[m];
            if (usedOutside.Contains(m) && Delegate(m, r.FieldName, r.Name) is { } stub)
            {
                var member = GenerateService.Prepare(SyntaxFactory.ParseMemberDeclaration(stub)!, eol, blankLine: false);
                if (remove is VariableDeclaratorSyntax)
                {
                    source.RemoveNode(remove);
                    source.AddMember(decl, member);
                }
                else source.ReplaceNode(remove, member.WithLeadingTrivia(remove.GetLeadingTrivia()));
            }
            else source.RemoveNode(remove, SyntaxRemoveOptions.KeepNoTrivia);
        }
        var field = SyntaxFactory.ParseMemberDeclaration($"private readonly {r.Name} {r.FieldName} = new {r.Name}();")!;
        source.InsertMembers(decl, 0, [field.WithAdditionalAnnotations(Formatter.Annotation).WithTrailingTrivia(SyntaxFactory.EndOfLine(eol), SyntaxFactory.EndOfLine(eol))]);

        var after = source.GetChangedDocument().Project.Solution;
        after = await AddFormattedDocumentAsync(after, doc.Project, file, NewFile((CompilationUnitSyntax)root, ns, body.ToString()), eol, ct);
        after = await CleanUpAsync(solution, after, ct);
        return await IntelService.DiffAsync(solution, after, ct);
    }

    private static bool IsWrite(SyntaxNode node)
    {
        var e = node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node ? ma : node;
        return e.Parent switch
        {
            AssignmentExpressionSyntax a => a.Left == e,
            PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax => true,
            ArgumentSyntax a => !a.RefKindKeyword.IsKind(SyntaxKind.None),
            _ => false,
        };
    }

    private static readonly SymbolDisplayFormat Qualified = SymbolDisplayFormat.FullyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    /// <summary>A member of the original class that forwards to the extracted one (so callers elsewhere keep working).</summary>
    private static string? Delegate(ISymbol m, string field, string className)
    {
        var owner = m.IsStatic ? className : field;
        var access = SyntaxFacts.GetText(m.DeclaredAccessibility) is { Length: > 0 } a ? a + " " : "";
        var mods = access + (m.IsStatic ? "static " : "");
        switch (m)
        {
            case IMethodSymbol x:
                var ps = string.Join(", ", x.Parameters.Select(p => $"{(p.IsParams ? "params " : "")}{RefText(p.RefKind)}{p.Type.ToDisplayString(Qualified)} {Esc(p.Name)}"));
                var args = string.Join(", ", x.Parameters.Select(p => $"{RefText(p.RefKind is RefKind.In or RefKind.RefReadOnlyParameter ? RefKind.None : p.RefKind)}{Esc(p.Name)}"));
                var tps = x.TypeParameters.Length > 0 ? $"<{string.Join(", ", x.TypeParameters.Select(t => t.Name))}>" : "";
                var ret = x.ReturnsVoid ? "void" : x.ReturnType.ToDisplayString(Qualified);
                return $"{mods}{ret} {Esc(x.Name)}{tps}({ps}) => {owner}.{Esc(x.Name)}{tps}({args});";
            case IPropertySymbol { IsIndexer: false } p:
                return $"{mods}{p.Type.ToDisplayString(Qualified)} {Esc(p.Name)} {{ {(p.GetMethod is null ? "" : $"get => {owner}.{Esc(p.Name)}; ")}{(p.SetMethod is null ? "" : $"set => {owner}.{Esc(p.Name)} = value; ")}}}";
            case IFieldSymbol f:
                return f.IsConst
                    ? $"{mods.Replace("static ", "")}const {f.Type.ToDisplayString(Qualified)} {Esc(f.Name)} = {className}.{Esc(f.Name)};"
                    : $"{mods}{f.Type.ToDisplayString(Qualified)} {Esc(f.Name)} {{ get => {owner}.{Esc(f.Name)};{(f.IsReadOnly ? "" : $" set => {owner}.{Esc(f.Name)} = value;")} }}";
            case IEventSymbol e:
                return $"{mods}event {e.Type.ToDisplayString(Qualified)} {Esc(e.Name)} {{ add => {owner}.{Esc(e.Name)} += value; remove => {owner}.{Esc(e.Name)} -= value; }}";
            default:
                return null;
        }
    }

    private static string RefText(RefKind k) => k switch { RefKind.Ref => "ref ", RefKind.Out => "out ", RefKind.In => "in ", RefKind.RefReadOnlyParameter => "ref readonly ", _ => "" };

    private static string Esc(string n) => SyntaxFacts.GetKeywordKind(n) != SyntaxKind.None ? "@" + n : n;
}
