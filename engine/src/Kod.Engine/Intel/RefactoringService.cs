using System.Text;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Rename;

namespace Kod.Engine.Intel;

/// <summary>
/// Rider's own refactorings (Refactor This, Ctrl+Shift+R) that Roslyn only offers behind host dialogs: Change Signature,
/// Safe Delete and Extract Interface. Each one returns text edits per file, like rename.
/// </summary>
public sealed class RefactoringService(WorkspaceService workspace, IntelService intel, CodeActionService actions)
{
    // ------------------------------------------------------------------ what applies here

    public async Task<RefactoringsDto> AvailableAsync(RangeRequest r, CancellationToken ct)
    {
        var (_, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Range.StartLine, r.Range.StartColumn, ct);
        var roslyn = (await actions.GetAsync(r with { Invoked = true }, ct)).Where(a => a.Kind == "refactor").ToList();
        if (symbol is null || !symbol.Locations.Any(l => l.IsInSource))
            return new RefactoringsDto(symbol?.Name, symbol is null ? null : Kinds.FromSymbol(symbol), false, false, false, false, roslyn);
        var method = SignatureTarget(symbol);
        return new RefactoringsDto(
            symbol.Name,
            symbol is IParameterSymbol ? "parameter" : symbol is ILocalSymbol ? "local" : Kinds.FromSymbol(symbol),
            CanRename: true,
            CanChangeSignature: method is not null,
            CanSafeDelete: symbol is INamedTypeSymbol or IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.Constructor } or IPropertySymbol or IFieldSymbol or IEventSymbol or IParameterSymbol or ILocalSymbol,
            CanExtractInterface: (symbol as INamedTypeSymbol ?? symbol.ContainingType) is { TypeKind: TypeKind.Class or TypeKind.Struct },
            roslyn);
    }

    /// <summary>The method or constructor whose signature Change Signature edits (also from one of its parameters).</summary>
    private static IMethodSymbol? SignatureTarget(ISymbol symbol)
    {
        if (symbol is IParameterSymbol { ContainingSymbol: IMethodSymbol pm }) symbol = pm;
        if (symbol is INamedTypeSymbol { InstanceConstructors: var ctors } t && ctors.Count(c => !c.IsImplicitlyDeclared) == 1 && t.TypeKind != TypeKind.Interface)
            symbol = ctors.First(c => !c.IsImplicitlyDeclared);
        return symbol is IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.Constructor } m && m.Locations.Any(l => l.IsInSource)
            ? (IMethodSymbol)m.OriginalDefinition
            : null;
    }

    // ------------------------------------------------------------------ Change Signature

    public async Task<SignatureInfoDto> SignatureAsync(DocRequest r, CancellationToken ct)
    {
        var (_, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var m = symbol is null ? null : SignatureTarget(symbol);
        if (m is null) throw new InvalidOperationException("Put the caret on a method or constructor to change its signature");
        var ps = m.Parameters.Select(p => new SignatureParameterInfoDto(
            p.Name,
            p.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat.AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier)),
            p.HasExplicitDefaultValue ? DefaultText(p) : null,
            p.RefKind switch { RefKind.Ref => "ref", RefKind.Out => "out", RefKind.In => "in", RefKind.RefReadOnlyParameter => "ref readonly", _ => p.IsThis ? "this" : null },
            p.IsParams)).ToList();
        var overloads = m.ContainingType.GetMembers(m.Name).Count(x => x is IMethodSymbol);
        return new SignatureInfoDto(
            m.MethodKind == MethodKind.Constructor ? m.ContainingType.Name : m.Name,
            m.MethodKind == MethodKind.Constructor ? "constructor" : "method",
            m.MethodKind == MethodKind.Constructor ? null : m.ReturnType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            ps, m.IsExtensionMethod, overloads);
    }

    private static string DefaultText(IParameterSymbol p) => p.ExplicitDefaultValue switch
    {
        null => p.Type.IsValueType && p.Type.OriginalDefinition.SpecialType != SpecialType.System_Nullable_T ? "default" : "null",
        string s => SymbolDisplay.FormatLiteral(s, quote: true),
        bool b => b ? "true" : "false",
        char c => SymbolDisplay.FormatLiteral(c, quote: true),
        var v when p.Type.TypeKind == TypeKind.Enum => p.Type.GetMembers().OfType<IFieldSymbol>().FirstOrDefault(f => Equals(f.ConstantValue, v)) is { } f ? $"{p.Type.Name}.{f.Name}" : $"({p.Type.Name}){v}",
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture) + (p.ExplicitDefaultValue is float ? "f" : p.ExplicitDefaultValue is decimal ? "m" : p.ExplicitDefaultValue is long ? "L" : ""),
        var v => v.ToString() ?? "default",
    };

    public async Task<IReadOnlyList<FileEditsDto>> ChangeSignatureAsync(ChangeSignatureRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var method = symbol is null ? null : SignatureTarget(symbol);
        if (method is null) throw new InvalidOperationException("Put the caret on a method or constructor to change its signature");
        Validate(method, r.Parameters);
        var before = doc.Project.Solution;
        var after = await ApplySignatureAsync(before, method, r.Parameters, ct);
        return await IntelService.DiffAsync(before, after, ct);
    }

    private static void Validate(IMethodSymbol method, IReadOnlyList<SignatureParameterEditDto> ps)
    {
        var names = new HashSet<string>();
        foreach (var p in ps)
        {
            if (!SyntaxFacts.IsValidIdentifier(p.Name.TrimStart('@'))) throw new ArgumentException($"'{p.Name}' is not a valid parameter name");
            if (!names.Add(p.Name)) throw new ArgumentException($"There are two parameters named '{p.Name}'");
            if (p.OriginalIndex >= method.Parameters.Length) throw new ArgumentException("Unknown parameter");
            if (p.OriginalIndex < 0)
            {
                var type = SyntaxFactory.ParseTypeName(p.Type);
                if (string.IsNullOrWhiteSpace(p.Type) || type.ContainsDiagnostics || type.ToString() != p.Type.Trim()) throw new ArgumentException($"'{p.Type}' is not a valid type");
                if (string.IsNullOrWhiteSpace(p.CallSiteValue) && string.IsNullOrWhiteSpace(p.DefaultValue))
                    throw new ArgumentException($"New parameter '{p.Name}' needs a value for existing calls or a default value");
            }
            foreach (var expr in new[] { p.DefaultValue, p.CallSiteValue })
                if (!string.IsNullOrWhiteSpace(expr) && SyntaxFactory.ParseExpression(expr).ContainsDiagnostics) throw new ArgumentException($"'{expr}' is not a valid expression");
        }
        if (method.IsExtensionMethod && (ps.Count == 0 || ps[0].OriginalIndex != 0)) throw new ArgumentException("The 'this' parameter of an extension method stays first");
        var seenOptional = false;
        foreach (var p in ps)
        {
            var optional = !string.IsNullOrWhiteSpace(p.OriginalIndex >= 0 ? p.DefaultValue ?? (method.Parameters[p.OriginalIndex].HasExplicitDefaultValue ? "x" : null) : p.DefaultValue);
            var isParams = p.OriginalIndex >= 0 && method.Parameters[p.OriginalIndex].IsParams;
            if (isParams && p != ps[^1]) throw new ArgumentException("A params parameter must be the last one");
            if (seenOptional && !optional && !isParams) throw new ArgumentException($"'{p.Name}' must have a default value: it comes after an optional parameter");
            seenOptional |= optional;
        }
    }

    /// <summary>Renames, reorders, removes and adds parameters of a method, its overrides / implementations / the members it
    /// implements, and rewrites the argument lists of every call.</summary>
    private async Task<Solution> ApplySignatureAsync(Solution solution, IMethodSymbol method, IReadOnlyList<SignatureParameterEditDto> ps, CancellationToken ct)
    {
        var docId = DocumentationCommentId.CreateDeclarationId(method);
        var projectId = solution.GetDocument(method.Locations.First(l => l.IsInSource).SourceTree)!.Project.Id;

        async Task<IMethodSymbol> Resolve(Solution s)
        {
            var c = await s.GetProject(projectId)!.GetCompilationAsync(ct);
            return DocumentationCommentId.GetFirstSymbolForDeclarationId(docId!, c!) as IMethodSymbol ?? throw new InvalidOperationException("The method could not be found again");
        }

        // 1. renames (Renamer also updates named arguments and uses in the body)
        foreach (var p in ps.Where(p => p.OriginalIndex >= 0))
        {
            var m = await Resolve(solution);
            var param = m.Parameters[p.OriginalIndex];
            if (param.Name != p.Name) solution = await Renamer.RenameSymbolAsync(solution, param, new SymbolRenameOptions(), p.Name, ct);
        }

        // 2. the cascade: overrides, implementations and the members this one overrides / implements
        var root = await Resolve(solution);
        var related = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default) { root };
        var queue = new Queue<IMethodSymbol>([root]);
        while (queue.Count > 0)
        {
            var m = queue.Dequeue();
            var next = new List<ISymbol>();
            next.AddRange(await SymbolFinder.FindOverridesAsync(m, solution, cancellationToken: ct));
            next.AddRange(await SymbolFinder.FindImplementationsAsync(m, solution, cancellationToken: ct));
            if (m.OverriddenMethod is { } o) next.Add(o.OriginalDefinition);
            if (m.ContainingType is { } owner)
                foreach (var i in owner.AllInterfaces)
                foreach (var im in i.GetMembers().OfType<IMethodSymbol>())
                    if (SymbolEqualityComparer.Default.Equals(owner.FindImplementationForInterfaceMember(im), m)) next.Add(im.OriginalDefinition);
            foreach (var n in next.OfType<IMethodSymbol>())
                if (n.Locations.Any(l => l.IsInSource) && related.Add((IMethodSymbol)n.OriginalDefinition)) queue.Enqueue((IMethodSymbol)n.OriginalDefinition);
        }

        // 3. call sites and declarations, per document
        var edits = new Dictionary<DocumentId, List<(SyntaxNode Node, Func<SyntaxNode, SyntaxNode> Rewrite)>>();
        void Edit(Document d, SyntaxNode node, Func<SyntaxNode, SyntaxNode> rewrite)
        {
            if (!edits.TryGetValue(d.Id, out var list)) edits[d.Id] = list = [];
            if (!list.Any(e => e.Node == node)) list.Add((node, rewrite));
        }
        var original = root.Parameters;
        foreach (var m in related)
        {
            foreach (var rs in await SymbolFinder.FindReferencesAsync(m, solution, ct))
            {
                if (rs.Definition is not IMethodSymbol) continue;
                foreach (var loc in rs.Locations)
                {
                    if (!loc.Location.IsInSource) continue;
                    var d = solution.GetDocument(loc.Location.SourceTree);
                    var tree = loc.Location.SourceTree!;
                    var node = (await tree.GetRootAsync(ct)).FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
                    if (d is null || CallArguments(node) is not { } args) continue;
                    var reduced = false;
                    if (m.IsExtensionMethod && d is not null)
                    {
                        var model = await d.GetSemanticModelAsync(ct);
                        reduced = model?.GetSymbolInfo(args.Parent!, ct).Symbol is IMethodSymbol { ReducedFrom: not null };
                    }
                    var isReduced = reduced;
                    Edit(d!, args, current => RewriteArguments((BaseArgumentListSyntax)current, original, ps, isReduced));
                }
            }
            foreach (var sr in m.DeclaringSyntaxReferences)
            {
                var decl = await sr.GetSyntaxAsync(ct);
                var d = solution.GetDocument(decl.SyntaxTree);
                var list = decl switch
                {
                    BaseMethodDeclarationSyntax bm => bm.ParameterList,
                    TypeDeclarationSyntax { ParameterList: { } pl } => pl,
                    _ => null,
                };
                if (d is null || list is null) continue;
                Edit(d, list, current => RewriteParameters((ParameterListSyntax)current, original, ps));
            }
        }

        foreach (var (id, list) in edits)
        {
            var d = solution.GetDocument(id)!;
            var editor = await DocumentEditor.CreateAsync(d, ct);
            // inner argument lists first, so F(G(a, b), c) rewrites G's arguments inside F's
            foreach (var (node, rewrite) in list.OrderByDescending(e => e.Node.SpanStart).ThenBy(e => e.Node.Span.Length))
                editor.ReplaceNode(node, (current, _) => rewrite(current));
            solution = editor.GetChangedDocument().Project.Solution;
        }
        return solution;
    }

    private static BaseArgumentListSyntax? CallArguments(SyntaxNode node)
    {
        for (var n = node; n is not null; n = n.Parent)
        {
            switch (n)
            {
                case InvocationExpressionSyntax inv when inv.Expression.Span.Contains(node.Span): return inv.ArgumentList;
                case BaseObjectCreationExpressionSyntax oc when oc.ArgumentList is { } al && !al.Span.Contains(node.Span): return al;
                case ConstructorInitializerSyntax ci: return ci.ArgumentList;
                case PrimaryConstructorBaseTypeSyntax pc: return pc.ArgumentList;
                case ArgumentSyntax or StatementSyntax or MemberDeclarationSyntax: return null;
            }
        }
        return null;
    }

    private static SyntaxNode RewriteArguments(BaseArgumentListSyntax list, IReadOnlyList<IParameterSymbol> original, IReadOnlyList<SignatureParameterEditDto> ps, bool reduced)
    {
        var offset = reduced ? 1 : 0;
        // which original parameter each argument belongs to: by name, else by position (a params tail all maps to the last)
        var byParam = new Dictionary<int, List<ArgumentSyntax>>();
        for (var i = 0; i < list.Arguments.Count; i++)
        {
            var a = list.Arguments[i];
            int index;
            if (a.NameColon is { } nc)
            {
                var name = nc.Name.Identifier.ValueText;
                var edit = ps.FirstOrDefault(p => p.Name == name && p.OriginalIndex >= 0);
                index = edit?.OriginalIndex ?? original.ToList().FindIndex(p => p.Name == name);
            }
            else
            {
                index = Math.Min(i + offset, original.Count - 1);
                if (i + offset >= original.Count && !original[^1].IsParams) index = -1;
            }
            if (index < 0) continue;
            if (!byParam.TryGetValue(index, out var l)) byParam[index] = l = [];
            l.Add(a);
        }

        var args = new List<ArgumentSyntax>();
        var named = false; // once a parameter is skipped, the following arguments need their names
        foreach (var p in ps.Skip(offset))
        {
            if (p.OriginalIndex >= 0 && byParam.TryGetValue(p.OriginalIndex, out var mine))
            {
                foreach (var a in mine)
                    args.Add(named && a.NameColon is null && !original[p.OriginalIndex].IsParams ? a.WithNameColon(SyntaxFactory.NameColon(p.Name)).WithoutLeadingTrivia() : a.WithoutLeadingTrivia());
                continue;
            }
            if (p.OriginalIndex < 0 && !string.IsNullOrWhiteSpace(p.CallSiteValue))
            {
                var a = SyntaxFactory.Argument(SyntaxFactory.ParseExpression(p.CallSiteValue.Trim()));
                args.Add(named ? a.WithNameColon(SyntaxFactory.NameColon(p.Name)) : a);
                continue;
            }
            named = true; // left to its default value
        }
        var separated = SyntaxFactory.SeparatedList(args, Enumerable.Repeat(SyntaxFactory.Token(SyntaxKind.CommaToken).WithTrailingTrivia(SyntaxFactory.Space), Math.Max(0, args.Count - 1)));
        return list switch
        {
            ArgumentListSyntax al => al.WithArguments(separated),
            BracketedArgumentListSyntax bl => bl.WithArguments(separated),
            _ => list,
        };
    }

    private static SyntaxNode RewriteParameters(ParameterListSyntax list, IReadOnlyList<IParameterSymbol> original, IReadOnlyList<SignatureParameterEditDto> ps)
    {
        var result = new List<ParameterSyntax>();
        foreach (var p in ps)
        {
            if (p.OriginalIndex >= 0 && p.OriginalIndex < list.Parameters.Count)
            {
                var existing = list.Parameters[p.OriginalIndex];
                if (p.DefaultValue is { } dv)
                    existing = string.IsNullOrWhiteSpace(dv)
                        ? existing.WithDefault(null)
                        : existing.WithDefault(SyntaxFactory.EqualsValueClause(SyntaxFactory.ParseExpression(dv.Trim())).WithLeadingTrivia(SyntaxFactory.Space));
                result.Add(existing.WithoutLeadingTrivia());
                continue;
            }
            var np = SyntaxFactory.Parameter(SyntaxFactory.Identifier(p.Name)).WithType(SyntaxFactory.ParseTypeName(p.Type.Trim()).WithTrailingTrivia(SyntaxFactory.Space));
            if (!string.IsNullOrWhiteSpace(p.DefaultValue)) np = np.WithDefault(SyntaxFactory.EqualsValueClause(SyntaxFactory.ParseExpression(p.DefaultValue.Trim())).WithLeadingTrivia(SyntaxFactory.Space));
            result.Add(np);
        }
        return list.WithParameters(SyntaxFactory.SeparatedList(result, Enumerable.Repeat(SyntaxFactory.Token(SyntaxKind.CommaToken).WithTrailingTrivia(SyntaxFactory.Space), Math.Max(0, result.Count - 1))));
    }

    // ------------------------------------------------------------------ Safe Delete

    public async Task<SafeDeleteCheckDto> SafeDeleteCheckAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null || !symbol.Locations.Any(l => l.IsInSource)) throw new InvalidOperationException("Nothing here can be deleted");
        symbol = symbol.OriginalDefinition;
        var usages = new List<LocationDto>();
        foreach (var rs in await SymbolFinder.FindReferencesAsync(symbol, doc.Project.Solution, ct))
        {
            // a type's constructors are part of the type: their calls are usages of it
            if (!SymbolEqualityComparer.Default.Equals(rs.Definition.OriginalDefinition, symbol) && !(symbol is INamedTypeSymbol && rs.Definition is IMethodSymbol { MethodKind: MethodKind.Constructor } c && SymbolEqualityComparer.Default.Equals(c.ContainingType, symbol)))
                continue;
            foreach (var l in rs.Locations)
                if (l.Location.IsInSource && !IsInside(l.Location, symbol)) usages.Add(await IntelService.LocationAsync(l.Location, false, ct));
        }
        return new SafeDeleteCheckDto(symbol.Name, symbol is IParameterSymbol ? "parameter" : symbol is ILocalSymbol ? "local" : Kinds.FromSymbol(symbol), IntelService.Dedupe(usages));
    }

    /// <summary>A recursive call or a type's reference to itself does not keep it alive.</summary>
    private static bool IsInside(Location l, ISymbol symbol) =>
        symbol is not IParameterSymbol and not ILocalSymbol && symbol.DeclaringSyntaxReferences.Any(r => r.SyntaxTree == l.SourceTree && r.Span.Contains(l.SourceSpan));

    public async Task<IReadOnlyList<FileEditsDto>> SafeDeleteAsync(SafeDeleteRequest r, CancellationToken ct)
    {
        var check = await SafeDeleteCheckAsync(new DocRequest(r.Path, r.Text, r.Line, r.Column), ct);
        if (check.Usages.Count > 0 && !r.Force) throw new InvalidOperationException($"'{check.Name}' is still used in {check.Usages.Count} places");
        var (doc, symbol, _) = await intel.SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        symbol = symbol!.OriginalDefinition;
        var solution = doc.Project.Solution;

        if (symbol is IParameterSymbol { ContainingSymbol: IMethodSymbol owner } param && SignatureTarget(owner) is { } method)
        {
            var ps = method.Parameters.Where(p => p.Ordinal != param.Ordinal)
                .Select(p => new SignatureParameterEditDto(p.Ordinal, p.Name, p.Type.ToDisplayString(), null, null)).ToList();
            return await IntelService.DiffAsync(solution, await ApplySignatureAsync(solution, method, ps, ct), ct);
        }

        var deleted = new List<string>();
        foreach (var group in symbol.DeclaringSyntaxReferences.GroupBy(s => s.SyntaxTree))
        {
            var d = solution.GetDocument(group.Key);
            if (d is null) continue;
            var editor = await DocumentEditor.CreateAsync(d, ct);
            foreach (var sr in group)
            {
                var node = await sr.GetSyntaxAsync(ct);
                // a field / local declarator: the whole declaration when it declares only this one
                if (node is VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax { Variables.Count: 1 } vd })
                    node = vd.Parent is FieldDeclarationSyntax or EventFieldDeclarationSyntax or LocalDeclarationStatementSyntax ? vd.Parent : node;
                editor.RemoveNode(node, SyntaxRemoveOptions.KeepUnbalancedDirectives);
            }
            var changed = editor.GetChangedDocument();
            solution = changed.Project.Solution;
            // a file left without types goes with them
            if (symbol is INamedTypeSymbol && await changed.GetSyntaxRootAsync(ct) is CompilationUnitSyntax unit
                && !unit.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax).Any(n => n is MemberDeclarationSyntax and not BaseNamespaceDeclarationSyntax)
                && d.FilePath is { } fp)
                deleted.Add(fp);
        }
        var result = (await IntelService.DiffAsync(doc.Project.Solution, solution, ct)).ToList();
        foreach (var path in deleted)
        {
            result.RemoveAll(f => string.Equals(f.Path, path, StringComparison.OrdinalIgnoreCase));
            result.Add(new FileEditsDto(path, [], Deleted: true));
        }
        return result;
    }

    // ------------------------------------------------------------------ Extract Interface

    public async Task<ExtractInterfaceInfoDto> ExtractInterfaceInfoAsync(DocRequest r, CancellationToken ct)
    {
        var type = await TypeAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var members = Candidates(type).Select(m => new InterfaceMemberDto(DocumentationCommentId.CreateDeclarationId(m) ?? m.Name, Display(m), Kinds.FromSymbol(m))).ToList();
        var path = type.Locations.First(l => l.IsInSource).SourceTree!.FilePath;
        return new ExtractInterfaceInfoDto(type.Name, "I" + type.Name, Path.GetDirectoryName(path)!, members);
    }

    private async Task<INamedTypeSymbol> TypeAtAsync(string path, string? text, int line, int column, CancellationToken ct)
    {
        var (doc, symbol, source) = await intel.SymbolAtAsync(path, text, line, column, ct);
        var type = symbol as INamedTypeSymbol ?? symbol?.ContainingType;
        if (type is null)
        {
            var model = await doc.GetSemanticModelAsync(ct);
            type = model?.GetEnclosingSymbol(IntelService.Offset(source, line, column), ct) is { } e ? e as INamedTypeSymbol ?? e.ContainingType : null;
        }
        if (type is not { TypeKind: TypeKind.Class or TypeKind.Struct } || !type.Locations.Any(l => l.IsInSource))
            throw new InvalidOperationException("Put the caret in a class or struct to extract an interface");
        return (INamedTypeSymbol)type.OriginalDefinition;
    }

    private static IEnumerable<ISymbol> Candidates(INamedTypeSymbol type) =>
        type.GetMembers().Where(m => m.DeclaredAccessibility == Accessibility.Public && !m.IsStatic && !m.IsImplicitlyDeclared && m switch
        {
            IMethodSymbol mm => mm.MethodKind == MethodKind.Ordinary,
            IPropertySymbol or IEventSymbol => true,
            _ => false,
        });

    private static readonly SymbolDisplayFormat MemberFormat = new(
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters | SymbolDisplayGenericsOptions.IncludeTypeConstraints,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeType | SymbolDisplayMemberOptions.IncludeRef,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeParamsRefOut
                          | SymbolDisplayParameterOptions.IncludeDefaultValue | SymbolDisplayParameterOptions.IncludeExtensionThis,
        propertyStyle: SymbolDisplayPropertyStyle.ShowReadWriteDescriptor,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier | SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers);

    private static string Display(ISymbol m) => m.ToDisplayString(MemberFormat);

    public async Task<IReadOnlyList<FileEditsDto>> ExtractInterfaceAsync(ExtractInterfaceRequest r, CancellationToken ct)
    {
        if (!SyntaxFacts.IsValidIdentifier(r.Name)) throw new ArgumentException($"'{r.Name}' is not a valid name");
        var type = await TypeAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        var chosen = Candidates(type).Where(m => r.MemberIds.Contains(DocumentationCommentId.CreateDeclarationId(m))).ToList();
        var decl = type.DeclaringSyntaxReferences.Select(s => s.GetSyntax(ct)).OfType<TypeDeclarationSyntax>().First();
        var doc = workspace.GetDocument(decl.SyntaxTree.FilePath, PathUtil.Comparer.Equals(decl.SyntaxTree.FilePath, r.Path) ? r.Text : null) ?? throw new InvalidOperationException("Not a C# document");
        var dir = Path.GetDirectoryName(decl.SyntaxTree.FilePath)!;
        var file = Path.Combine(dir, r.Name + ".cs");
        if (File.Exists(file) || doc.Project.Documents.Any(d => string.Equals(d.FilePath, file, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException($"{r.Name}.cs already exists");

        // the interface, in the type's namespace
        var sb = new StringBuilder();
        var ns = type.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() : null;
        var usings = (await doc.GetSyntaxRootAsync(ct) as CompilationUnitSyntax)?.Usings.Select(u => u.ToString()).ToList() ?? [];
        foreach (var u in usings) sb.Append(u).Append('\n');
        if (usings.Count > 0) sb.Append('\n');
        if (ns is not null) sb.Append("namespace ").Append(ns).Append(";\n\n");
        var typeParams = type.TypeParameters.Length > 0 ? "<" + string.Join(", ", type.TypeParameters.Select(t => t.Name)) + ">" : "";
        sb.Append("public interface ").Append(r.Name).Append(typeParams).Append("\n{\n");
        foreach (var m in chosen)
        {
            var line = m is IEventSymbol e ? $"event {Display(e)};" : Display(m) + ";";
            if (m is IPropertySymbol prop)
            {
                // only the accessors callers can use
                var accessors = (prop.GetMethod is { DeclaredAccessibility: Accessibility.Public } ? "get; " : "")
                                + (prop.SetMethod is { DeclaredAccessibility: Accessibility.Public } ? prop.SetMethod.IsInitOnly ? "init; " : "set; " : "");
                var head = prop.IsIndexer
                    ? $"{prop.Type.ToDisplayString(MemberFormat)} this[{string.Join(", ", prop.Parameters.Select(x => x.ToDisplayString(MemberFormat)))}]"
                    : $"{prop.Type.ToDisplayString(MemberFormat)} {prop.Name}";
                line = $"{head} {{ {accessors}}}";
            }
            sb.Append("    ").Append(line).Append('\n');
        }
        sb.Append("}\n");

        // the type implements it
        var editor = await DocumentEditor.CreateAsync(doc, ct);
        var target = (TypeDeclarationSyntax)(await doc.GetSyntaxRootAsync(ct))!.FindNode(decl.Identifier.Span).AncestorsAndSelf().OfType<TypeDeclarationSyntax>().First();
        editor.ReplaceNode(target, (current, generator) =>
        {
            // the generator leaves "Calculator:ICalculator": give the base list Rider's spacing
            var updated = (TypeDeclarationSyntax)generator.AddInterfaceType(current, SyntaxFactory.ParseTypeName(r.Name + typeParams));
            var bl = updated.BaseList!;
            var types = bl.Types.Select((t, i) => i == bl.Types.Count - 1 ? t.WithoutLeadingTrivia() : t.WithoutTrivia());
            var commas = Enumerable.Repeat(SyntaxFactory.Token(SyntaxKind.CommaToken).WithTrailingTrivia(SyntaxFactory.Space), bl.Types.Count - 1);
            var before = bl.GetFirstToken().GetPreviousToken();
            updated = updated.ReplaceToken(before, before.WithTrailingTrivia(before.TrailingTrivia.Where(t => !t.IsKind(SyntaxKind.WhitespaceTrivia))));
            bl = updated.BaseList!;
            return updated.WithBaseList(bl.WithColonToken(bl.ColonToken.WithLeadingTrivia(SyntaxFactory.Space).WithTrailingTrivia(SyntaxFactory.Space)).WithTypes(SyntaxFactory.SeparatedList(types, commas)));
        });
        var solution = editor.GetChangedDocument().Project.Solution;
        var folders = doc.Folders;
        solution = solution.AddDocument(DocumentId.CreateNewId(doc.Project.Id), r.Name + ".cs", sb.ToString(), folders, file);
        var formatted = await Formatter.FormatAsync(solution.GetDocument(doc.Id)!, Formatter.Annotation, cancellationToken: ct);
        return await IntelService.DiffAsync(doc.Project.Solution, formatted.Project.Solution, ct);
    }
}
