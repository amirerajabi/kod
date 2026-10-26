using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;

namespace Kod.Engine.Intel;

/// <summary>Call and type hierarchies, Go to Base / Related Files: symbols travel to the UI as ids (project + documentation
/// comment id) so a node can be expanded or opened later, also when it lives in a referenced assembly.</summary>
public sealed partial class IntelService
{
    private static readonly SymbolDisplayFormat DetailFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeContainingType,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    // ------------------------------------------------------------------ ids

    private static string? IdOf(ISymbol symbol, Project project)
    {
        var docId = DocumentationCommentId.CreateDeclarationId(symbol.OriginalDefinition);
        return string.IsNullOrEmpty(docId) ? null : $"{project.Id.Id:N}|{docId}";
    }

    internal async Task<(ISymbol Symbol, Project Project)?> ResolveIdAsync(string id, CancellationToken ct)
    {
        var bar = id.IndexOf('|');
        if (bar < 0 || !Guid.TryParse(id[..bar], out var guid)) return null;
        var solution = workspace.CurrentSolution;
        var project = solution.Projects.FirstOrDefault(p => p.Id.Id == guid);
        var docId = id[(bar + 1)..];
        foreach (var p in project is null ? solution.Projects : [project, .. solution.Projects.Where(x => x != project)])
        {
            var compilation = await p.GetCompilationAsync(ct);
            if (compilation is null) continue;
            var s = DocumentationCommentId.GetFirstSymbolForDeclarationId(docId, compilation);
            if (s is not null) return (s, p);
        }
        return null;
    }

    /// <summary>The project a symbol is declared in (its first source location), else <paramref name="fallback"/>.</summary>
    private static Project ProjectOf(ISymbol symbol, Solution solution, Project fallback)
    {
        var tree = symbol.Locations.FirstOrDefault(l => l.IsInSource)?.SourceTree;
        return tree is not null && solution.GetDocument(tree)?.Project is { } p ? p : fallback;
    }

    private async Task<HierarchyItemDto?> ItemAsync(ISymbol symbol, Solution solution, Project fallback, bool expandable, CancellationToken ct,
        IReadOnlyList<RangeDto>? callSites = null, string? callPath = null)
    {
        var project = ProjectOf(symbol, solution, fallback);
        var id = IdOf(symbol, project);
        if (id is null) return null;
        var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        LocationDto? at = loc is null ? null : await LocationAsync(loc, true, ct);
        var name = symbol switch
        {
            IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } m => m.ContainingType.Name,
            INamedTypeSymbol t => t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            _ => symbol.Name,
        };
        var detail = symbol switch
        {
            INamedTypeSymbol t => t.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : null,
            _ => symbol.ToDisplayString(DetailFormat),
        };
        return new HierarchyItemDto(id, name, detail, Kinds.FromSymbol(symbol), at?.Path, at?.Range, expandable, callSites, callPath);
    }

    // ------------------------------------------------------------------ roots

    /// <summary>The hierarchy root at the caret: the method / property for calls, the (containing) type for types.</summary>
    public async Task<HierarchyItemDto?> HierarchyRootAsync(DocRequest r, string kind, CancellationToken ct)
    {
        var (doc, symbol, text) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null || symbol is ILocalSymbol or IParameterSymbol or IRangeVariableSymbol || (kind == "call" && symbol is INamedTypeSymbol))
        {
            // nothing usable under the caret: the member (or type) that encloses it
            var model = await doc.GetSemanticModelAsync(ct);
            symbol = model?.GetEnclosingSymbol(Offset(text, r.Line, r.Column), ct);
            while (symbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction }) symbol = symbol.ContainingSymbol;
        }
        if (symbol is null) return null;
        symbol = symbol.OriginalDefinition;
        if (kind == "type")
        {
            var type = symbol as INamedTypeSymbol ?? symbol.ContainingType;
            return type is null ? null : await ItemAsync(type, doc.Project.Solution, doc.Project, true, ct);
        }
        return symbol is IMethodSymbol or IPropertySymbol or IEventSymbol or IFieldSymbol
            ? await ItemAsync(symbol, doc.Project.Solution, doc.Project, true, ct)
            : null;
    }

    // ------------------------------------------------------------------ children

    /// <summary>One level of a hierarchy: callers / callees of a member, supertypes / subtypes of a type.</summary>
    public async Task<IReadOnlyList<HierarchyItemDto>> HierarchyChildrenAsync(HierarchyRequest r, CancellationToken ct)
    {
        if (await ResolveIdAsync(r.Id, ct) is not var (symbol, project)) return [];
        var solution = project.Solution;
        var list = new List<HierarchyItemDto>();
        switch (r.Direction)
        {
            case "callers":
            {
                var targets = new List<ISymbol> { symbol };
                // calls through the interface member or the overridden base member reach this one too
                if (symbol.ContainingType is { } owner)
                {
                    foreach (var i in owner.AllInterfaces)
                    foreach (var m in i.GetMembers())
                        if (SymbolEqualityComparer.Default.Equals(owner.FindImplementationForInterfaceMember(m), symbol)) targets.Add(m);
                }
                if (symbol is IMethodSymbol { OverriddenMethod: { } om }) targets.Add(om.OriginalDefinition);
                if (symbol is IPropertySymbol { OverriddenProperty: { } op }) targets.Add(op.OriginalDefinition);
                var byCaller = new Dictionary<ISymbol, List<Location>>(SymbolEqualityComparer.Default);
                foreach (var t in targets)
                foreach (var c in await SymbolFinder.FindCallersAsync(t, solution, ct))
                {
                    var caller = c.CallingSymbol;
                    while (caller is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction }) caller = caller.ContainingSymbol;
                    if (!byCaller.TryGetValue(caller, out var locs)) byCaller[caller] = locs = [];
                    locs.AddRange(c.Locations.Where(l => l.IsInSource));
                }
                foreach (var (caller, locs) in byCaller)
                {
                    var sites = new List<RangeDto>();
                    string? sitePath = null;
                    foreach (var l in locs.Take(50))
                    {
                        var at = await LocationAsync(l, false, ct);
                        sitePath ??= at.Path;
                        if (string.Equals(sitePath, at.Path, StringComparison.OrdinalIgnoreCase)) sites.Add(at.Range);
                    }
                    if (await ItemAsync(caller, solution, project, caller is IMethodSymbol or IPropertySymbol or IEventSymbol, ct, sites, sitePath) is { } item) list.Add(item);
                }
                break;
            }
            case "callees":
            {
                var byCallee = new Dictionary<ISymbol, List<RangeDto>>(SymbolEqualityComparer.Default);
                string? path = null;
                foreach (var sr in symbol.DeclaringSyntaxReferences)
                {
                    var node = await sr.GetSyntaxAsync(ct);
                    var doc = solution.GetDocument(node.SyntaxTree);
                    if (doc is null) continue;
                    var model = await doc.GetSemanticModelAsync(ct);
                    var text = await doc.GetTextAsync(ct);
                    if (model is null) continue;
                    path ??= doc.FilePath;
                    foreach (var n in node.DescendantNodes())
                    {
                        ISymbol? target = n switch
                        {
                            InvocationExpressionSyntax inv => model.GetSymbolInfo(inv, ct).Symbol,
                            BaseObjectCreationExpressionSyntax oc => model.GetSymbolInfo(oc, ct).Symbol,
                            ConstructorInitializerSyntax ci => model.GetSymbolInfo(ci, ct).Symbol,
                            IdentifierNameSyntax id when id.Parent is not InvocationExpressionSyntax && (id.Parent is not MemberAccessExpressionSyntax ma || ma.Parent is not InvocationExpressionSyntax)
                                => model.GetSymbolInfo(id, ct).Symbol is IPropertySymbol or IEventSymbol ? model.GetSymbolInfo(id, ct).Symbol : null,
                            _ => null,
                        };
                        if (target is IMethodSymbol { ReducedFrom: { } reduced }) target = reduced;
                        if (target is null || target is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction }) continue;
                        target = target.OriginalDefinition;
                        if (!byCallee.TryGetValue(target, out var sites)) byCallee[target] = sites = [];
                        if (string.Equals(path, doc.FilePath, StringComparison.OrdinalIgnoreCase)) sites.Add(ToRange(text, n.Span));
                    }
                }
                foreach (var (callee, sites) in byCallee)
                    if (await ItemAsync(callee, solution, project, callee.Locations.Any(l => l.IsInSource), ct, sites, path) is { } item) list.Add(item);
                break;
            }
            case "supertypes" when symbol is INamedTypeSymbol type:
            {
                if (type.BaseType is { } bt && type.TypeKind == TypeKind.Class)
                    if (await ItemAsync(bt.OriginalDefinition, solution, project, true, ct) is { } item) list.Add(item);
                foreach (var i in type.Interfaces)
                    if (await ItemAsync(i.OriginalDefinition, solution, project, true, ct) is { } item) list.Add(item);
                break;
            }
            case "subtypes" when symbol is INamedTypeSymbol type:
            {
                IEnumerable<INamedTypeSymbol> found = type.TypeKind == TypeKind.Interface
                    ? [.. await SymbolFinder.FindDerivedInterfacesAsync(type, solution, transitive: false, cancellationToken: ct),
                       .. await SymbolFinder.FindImplementationsAsync(type, solution, transitive: false, cancellationToken: ct)]
                    : await SymbolFinder.FindDerivedClassesAsync(type, solution, transitive: false, cancellationToken: ct);
                foreach (var t in found.Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default))
                    if (await ItemAsync(t, solution, project, true, ct) is { } item) list.Add(item);
                break;
            }
        }
        return list.OrderBy(i => i.Path is null).ThenBy(i => i.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Opens a hierarchy / navigation item: its source, or a metadata view for a framework or package symbol.</summary>
    public async Task<DefinitionDto> SymbolDefinitionAsync(string id, CancellationToken ct)
    {
        if (await ResolveIdAsync(id, ct) is not var (symbol, project)) return new DefinitionDto([], null);
        var locations = await SourceLocationsAsync(symbol, ct);
        if (locations.Count > 0) return new DefinitionDto(locations, null);
        var compilation = await project.GetCompilationAsync(ct);
        return new DefinitionDto([], compilation is null ? null : metadata.Build(symbol, compilation));
    }

    // ------------------------------------------------------------------ Go to Base Symbols

    /// <summary>Base type and interfaces of a type; the overridden member and the interface members a member implements.</summary>
    public async Task<IReadOnlyList<HierarchyItemDto>> BaseSymbolsAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, text) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null or ILocalSymbol or IParameterSymbol)
        {
            var model = await doc.GetSemanticModelAsync(ct);
            symbol = model?.GetEnclosingSymbol(Offset(text, r.Line, r.Column), ct);
        }
        if (symbol is null) return [];
        symbol = symbol.OriginalDefinition;
        var solution = doc.Project.Solution;
        var bases = new List<ISymbol>();
        if (symbol is INamedTypeSymbol type)
        {
            if (type.BaseType is { SpecialType: not SpecialType.System_Object and not SpecialType.System_ValueType } bt) bases.Add(bt.OriginalDefinition);
            bases.AddRange(type.Interfaces.Select(i => i.OriginalDefinition));
        }
        else
        {
            switch (symbol)
            {
                case IMethodSymbol { OverriddenMethod: { } m }: bases.Add(m.OriginalDefinition); break;
                case IPropertySymbol { OverriddenProperty: { } p }: bases.Add(p.OriginalDefinition); break;
                case IEventSymbol { OverriddenEvent: { } e }: bases.Add(e.OriginalDefinition); break;
            }
            if (symbol.ContainingType is { } owner)
            {
                foreach (var i in owner.AllInterfaces)
                foreach (var m in i.GetMembers())
                    if (SymbolEqualityComparer.Default.Equals(owner.FindImplementationForInterfaceMember(m)?.OriginalDefinition, symbol)) bases.Add(m.OriginalDefinition);
            }
        }
        var list = new List<HierarchyItemDto>();
        foreach (var b in bases.Distinct(SymbolEqualityComparer.Default))
            if (await ItemAsync(b!, solution, doc.Project, false, ct) is { } item) list.Add(item);
        return list;
    }

    // ------------------------------------------------------------------ related files

    /// <summary>Rider's Go to Related Files: other partial parts, base types, interfaces, inheritors, tests and code-behind.</summary>
    public async Task<IReadOnlyList<RelatedFileDto>> RelatedFilesAsync(TextRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text);
        var list = new List<RelatedFileDto>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Path.GetFullPath(r.Path) };
        void Add(string? path, string reason)
        {
            if (path is not null && File.Exists(path) && seen.Add(Path.GetFullPath(path))) list.Add(new RelatedFileDto(path, reason));
        }

        // code-behind pairs: X.razor ↔ X.razor.cs / .razor.css, X.cshtml ↔ X.cshtml.cs, X.xaml ↔ X.xaml.cs
        var file = r.Path;
        foreach (var ext in new[] { ".razor", ".cshtml", ".xaml", ".axaml" })
        {
            if (file.EndsWith(ext + ".cs", StringComparison.OrdinalIgnoreCase)) Add(file[..^3], "markup");
            if (file.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
            {
                Add(file + ".cs", "code-behind");
                Add(file + ".css", "styles");
            }
        }
        if (doc is null) return list;

        var root = await doc.GetSyntaxRootAsync(ct);
        var model = await doc.GetSemanticModelAsync(ct);
        if (root is null || model is null) return list;
        var solution = doc.Project.Solution;
        var types = root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax)
            .OfType<BaseTypeDeclarationSyntax>()
            .Select(t => model.GetDeclaredSymbol(t, ct))
            .OfType<INamedTypeSymbol>()
            .ToList();
        string? PathOf(ISymbol s) => s.Locations.FirstOrDefault(l => l.IsInSource)?.SourceTree?.FilePath;

        foreach (var t in types)
        {
            foreach (var l in t.Locations.Where(l => l.IsInSource)) Add(l.SourceTree?.FilePath, "partial part");
            if (t.BaseType is { } bt) Add(PathOf(bt), "base type");
            foreach (var i in t.Interfaces) Add(PathOf(i), "interface");
        }

        // naming conventions: Foo ↔ IFoo, Foo ↔ FooTests / FooTest
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in types)
        {
            var n = t.Name;
            names.Add(n.Length > 1 && n[0] == 'I' && char.IsUpper(n[1]) ? n[1..] : "I" + n);
            names.Add(n + "Tests");
            names.Add(n + "Test");
            if (n.EndsWith("Tests", StringComparison.Ordinal)) names.Add(n[..^5]);
            else if (n.EndsWith("Test", StringComparison.Ordinal)) names.Add(n[..^4]);
        }
        foreach (var d in solution.Projects.SelectMany(p => p.Documents))
        {
            var stem = Path.GetFileNameWithoutExtension(d.FilePath);
            if (stem is not null && names.Contains(stem))
                Add(d.FilePath, stem.EndsWith("Test", StringComparison.OrdinalIgnoreCase) || stem.EndsWith("Tests", StringComparison.OrdinalIgnoreCase) ? "tests" : "by name");
        }

        foreach (var t in types)
        {
            IEnumerable<INamedTypeSymbol> derived = t.TypeKind == TypeKind.Interface
                ? await SymbolFinder.FindImplementationsAsync(t, solution, transitive: false, cancellationToken: ct)
                : t.TypeKind == TypeKind.Class ? await SymbolFinder.FindDerivedClassesAsync(t, solution, transitive: false, cancellationToken: ct) : [];
            foreach (var d in derived.Take(30)) Add(PathOf(d), t.TypeKind == TypeKind.Interface ? "implementation" : "inheritor");
        }
        return list;
    }
}
