using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>Inlay hints, Code Vision counts, postfix template contexts and Go to Type Declaration.</summary>
public sealed partial class IntelService
{
    // ------------------------------------------------------------------ inlay hints

    private static readonly SymbolDisplayFormat HintFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    /// <summary>Parameter names before literal-ish arguments and the inferred types of var / lambda parameters (Rider's
    /// default "push-to-hint" set), within the visible range.</summary>
    public async Task<IReadOnlyList<InlayHintDto>> InlayHintsAsync(RangeRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text);
        if (doc is null) return [];
        var text = await doc.GetTextAsync(ct);
        var root = await doc.GetSyntaxRootAsync(ct);
        var model = await doc.GetSemanticModelAsync(ct);
        if (root is null || model is null) return [];
        var span = ToSpan(text, r.Range);
        var hints = new List<InlayHintDto>();

        InlayHintDto At(int position, string label, string kind, bool left, bool right)
        {
            var p = text.Lines.GetLinePosition(position);
            return new InlayHintDto(p.Line + 1, p.Character + 1, label, kind, left, right);
        }

        string? TypeLabel(ITypeSymbol? t) =>
            t is null or IErrorTypeSymbol || t.IsAnonymousType || t.TypeKind == TypeKind.Error ? null : t.ToDisplayString(HintFormat);

        foreach (var node in root.DescendantNodes(span))
        {
            ct.ThrowIfCancellationRequested();
            if (!node.Span.IntersectsWith(span)) continue;
            switch (node)
            {
                case ArgumentListSyntax args when args.Parent is InvocationExpressionSyntax or BaseObjectCreationExpressionSyntax or ConstructorInitializerSyntax:
                    AddParameterHints(args.Arguments, args.Parent!, model, hints, At, ct);
                    break;
                case BracketedArgumentListSyntax bargs when bargs.Parent is ElementAccessExpressionSyntax:
                    AddParameterHints(bargs.Arguments, bargs.Parent, model, hints, At, ct);
                    break;
                case VariableDeclarationSyntax { Type.IsVar: true } decl when decl.Variables.Count == 1:
                {
                    var v = decl.Variables[0];
                    if (v.Initializer is { } init && IsObviousType(init.Value)) break;
                    if (model.GetDeclaredSymbol(v, ct) is ILocalSymbol local && TypeLabel(local.Type) is { } label)
                        hints.Add(At(v.Identifier.Span.End, ": " + label, "type", false, false));
                    break;
                }
                case ForEachStatementSyntax { Type.IsVar: true } fe:
                    if (model.GetDeclaredSymbol(fe, ct) is ILocalSymbol fl && TypeLabel(fl.Type) is { } fel)
                        hints.Add(At(fe.Identifier.Span.End, ": " + fel, "type", false, false));
                    break;
                case SingleVariableDesignationSyntax d when d.Parent is DeclarationExpressionSyntax { Type.IsVar: true } or ParenthesizedVariableDesignationSyntax:
                    if (model.GetDeclaredSymbol(d, ct) is ILocalSymbol dl && TypeLabel(dl.Type) is { } dll)
                        hints.Add(At(d.Identifier.Span.End, ": " + dll, "type", false, false));
                    break;
                case SimpleLambdaExpressionSyntax sl:
                    if (model.GetDeclaredSymbol(sl.Parameter, ct) is IParameterSymbol sp && TypeLabel(sp.Type) is { } spl)
                        hints.Add(At(sl.Parameter.SpanStart, spl, "type", false, true));
                    break;
                case ParenthesizedLambdaExpressionSyntax pl:
                    foreach (var p in pl.ParameterList.Parameters)
                        if (p.Type is null && model.GetDeclaredSymbol(p, ct) is IParameterSymbol pp && TypeLabel(pp.Type) is { } ppl)
                            hints.Add(At(p.Identifier.SpanStart, ppl, "type", false, true));
                    break;
            }
            if (hints.Count > 2000) break;
        }
        return hints;
    }

    private static bool IsObviousType(ExpressionSyntax e) => e switch
    {
        ObjectCreationExpressionSyntax or ArrayCreationExpressionSyntax or CastExpressionSyntax or DefaultExpressionSyntax => true,
        BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AsExpression) => true,
        LiteralExpressionSyntax l => !l.IsKind(SyntaxKind.NullLiteralExpression) && !l.IsKind(SyntaxKind.DefaultLiteralExpression),
        InterpolatedStringExpressionSyntax => true,
        AwaitExpressionSyntax a => IsObviousType(a.Expression),
        _ => false,
    };

    private static void AddParameterHints(SeparatedSyntaxList<ArgumentSyntax> arguments, SyntaxNode call, SemanticModel model, List<InlayHintDto> hints,
        Func<int, string, string, bool, bool, InlayHintDto> at, CancellationToken ct)
    {
        if (arguments.Count == 0) return;
        var info = model.GetSymbolInfo(call, ct);
        var symbol = info.Symbol ?? (info.CandidateSymbols.Length == 1 ? info.CandidateSymbols[0] : null);
        var parameters = symbol switch
        {
            IMethodSymbol m => m.Parameters,
            IPropertySymbol p => p.Parameters,
            _ => default,
        };
        if (parameters.IsDefaultOrEmpty) return;
        var methodName = symbol!.Name;
        for (var i = 0; i < arguments.Count; i++)
        {
            var arg = arguments[i];
            if (arg.NameColon is not null) return; // named arguments: the rest are named or positional by name
            if (i >= parameters.Length && !parameters[^1].IsParams) return;
            var param = i < parameters.Length ? parameters[i] : parameters[^1];
            if (param.IsParams && i > param.Ordinal) continue; // only the first element of a params array
            if (!ShowsParameterHint(arg.Expression)) continue;
            var name = param.Name;
            if (name.Length <= 1 && parameters.Length == 1) continue;
            // SetName(name), Contains(item): the method name already says it
            if (parameters.Length == 1 && methodName.EndsWith(name, StringComparison.OrdinalIgnoreCase)) continue;
            hints.Add(at(arg.SpanStart, name + ":", "parameter", false, true));
        }
    }

    private static bool ShowsParameterHint(ExpressionSyntax e) => e switch
    {
        LiteralExpressionSyntax or DefaultExpressionSyntax or InterpolatedStringExpressionSyntax => true,
        BaseObjectCreationExpressionSyntax or ArrayCreationExpressionSyntax or ImplicitArrayCreationExpressionSyntax or CollectionExpressionSyntax => true,
        AnonymousFunctionExpressionSyntax => true,
        PrefixUnaryExpressionSyntax p => p.Operand is LiteralExpressionSyntax,
        CastExpressionSyntax c => ShowsParameterHint(c.Expression),
        TypeOfExpressionSyntax => true,
        _ => false,
    };

    // ------------------------------------------------------------------ Code Vision

    /// <summary>Types and members of a file that get lenses; the counts come from <see cref="CodeVisionAsync"/> on demand.</summary>
    public async Task<IReadOnlyList<CodeVisionEntryDto>> CodeVisionEntriesAsync(TextRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text);
        if (doc is null) return [];
        var root = await doc.GetSyntaxRootAsync(ct);
        var text = await doc.GetTextAsync(ct);
        if (root is null) return [];
        var list = new List<CodeVisionEntryDto>();
        void Add(SyntaxToken id, string kind, bool implementable)
        {
            var p = text.Lines.GetLinePosition(id.SpanStart);
            list.Add(new CodeVisionEntryDto(p.Line + 1, p.Character + 1, kind, implementable));
        }
        // members that can have implementations / overrides: in interfaces, or virtual / abstract / override
        static bool Overridable(MemberDeclarationSyntax m) =>
            m.Parent is InterfaceDeclarationSyntax || m.Modifiers.Any(k => k.IsKind(SyntaxKind.VirtualKeyword) || k.IsKind(SyntaxKind.AbstractKeyword) || k.IsKind(SyntaxKind.OverrideKeyword));
        foreach (var node in root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax))
        {
            switch (node)
            {
                case BaseTypeDeclarationSyntax t:
                    Add(t.Identifier, "type", t is InterfaceDeclarationSyntax || (t is ClassDeclarationSyntax or RecordDeclarationSyntax { ClassOrStructKeyword.RawKind: 0 or (int)SyntaxKind.ClassKeyword }
                        && !t.Modifiers.Any(k => k.IsKind(SyntaxKind.SealedKeyword) || k.IsKind(SyntaxKind.StaticKeyword))));
                    break;
                case DelegateDeclarationSyntax d: Add(d.Identifier, "type", false); break;
                case MethodDeclarationSyntax m: Add(m.Identifier, "member", Overridable(m)); break;
                case ConstructorDeclarationSyntax c: Add(c.Identifier, "member", false); break;
                case PropertyDeclarationSyntax p: Add(p.Identifier, "member", Overridable(p)); break;
                case EventDeclarationSyntax e: Add(e.Identifier, "member", Overridable(e)); break;
                case IndexerDeclarationSyntax ix: Add(ix.ThisKeyword, "member", Overridable(ix)); break;
                case BaseFieldDeclarationSyntax f:
                    foreach (var v in f.Declaration.Variables) Add(v.Identifier, "member", f is EventFieldDeclarationSyntax && Overridable(f));
                    break;
            }
        }
        return list;
    }

    public async Task<CodeVisionDto?> CodeVisionAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null) return null;
        symbol = symbol.OriginalDefinition;
        var solution = doc.Project.Solution;
        var usages = 0;
        foreach (var rs in await SymbolFinder.FindReferencesAsync(symbol, solution, ct))
        {
            // constructors are found as their type's references too; count each call site once
            usages += rs.Locations.Count(l => l.Location.IsInSource && !l.IsImplicit);
        }

        var impl = 0;
        string? label = null;
        switch (symbol)
        {
            case INamedTypeSymbol { TypeKind: TypeKind.Interface } i:
                impl = (await SymbolFinder.FindImplementationsAsync(i, solution, transitive: true, cancellationToken: ct)).Count();
                label = impl == 1 ? "implementation" : "implementations";
                break;
            case INamedTypeSymbol { TypeKind: TypeKind.Class, IsSealed: false, IsStatic: false } c:
                impl = (await SymbolFinder.FindDerivedClassesAsync(c, solution, transitive: true, cancellationToken: ct)).Count();
                label = impl == 1 ? "inheritor" : "inheritors";
                break;
            case IMethodSymbol or IPropertySymbol or IEventSymbol when symbol.ContainingType?.TypeKind == TypeKind.Interface:
                impl = (await SymbolFinder.FindImplementationsAsync(symbol, solution, cancellationToken: ct)).Count();
                label = impl == 1 ? "implementation" : "implementations";
                break;
            case IMethodSymbol or IPropertySymbol or IEventSymbol when symbol.IsVirtual || symbol.IsAbstract || symbol.IsOverride:
                impl = (await SymbolFinder.FindOverridesAsync(symbol, solution, cancellationToken: ct)).Count();
                label = impl == 1 ? "override" : "overrides";
                break;
        }
        return new CodeVisionDto(usages, impl, label);
    }

    // ------------------------------------------------------------------ postfix templates

    /// <summary>The expression a postfix template applies to: <paramref name="r"/> is the position right after the '.'.</summary>
    public async Task<PostfixContextDto?> PostfixAsync(DocRequest r, CancellationToken ct)
    {
        var doc = Doc(r.Path, r.Text);
        var text = await doc.GetTextAsync(ct);
        var afterDot = Offset(text, r.Line, r.Column);
        var dot = afterDot - 1;
        if (dot <= 0 || text[dot] != '.') return null;
        var root = await doc.GetSyntaxRootAsync(ct);
        var model = await doc.GetSemanticModelAsync(ct);
        var token = root!.FindToken(dot);
        // "x.var" followed by another statement parses as a declaration of type x.var: the dot is in a qualified name
        SyntaxNode? left = token.IsKind(SyntaxKind.DotToken)
            ? token.Parent switch
            {
                MemberAccessExpressionSyntax m => m.Expression,
                QualifiedNameSyntax q => q.Left,
                _ => null,
            }
            : null;
        if (left is null || model is null) return null;
        var access = token.Parent!;

        // the largest expression that ends at the dot (a > b.if wraps "a > b"), short of assignments and lambdas
        var expr = left;
        for (var n = access.Parent; n is ExpressionSyntax and not AssignmentExpressionSyntax and not AnonymousFunctionExpressionSyntax and not ConditionalExpressionSyntax; n = n.Parent)
        {
            if (n.Span.End != access.Span.End || n is MemberAccessExpressionSyntax or InvocationExpressionSyntax or ElementAccessExpressionSyntax or QualifiedNameSyntax) break;
            expr = n;
        }
        var start = expr.SpanStart;
        if (start >= dot) return null;
        var exprText = text.ToString(TextSpan.FromBounds(start, dot));
        var wordEnd = afterDot;
        while (wordEnd < text.Length && (char.IsLetterOrDigit(text[wordEnd]) || text[wordEnd] == '_')) wordEnd++;

        // bind the expression text on its own at that position (the half-typed ".word" breaks the tree around it)
        var parsed = SyntaxFactory.ParseExpression(exprText);
        var type = model.GetSpeculativeTypeInfo(start, parsed, SpeculativeBindingOption.BindAsExpression).Type;
        var isType = model.GetSpeculativeSymbolInfo(start, parsed, SpeculativeBindingOption.BindAsExpression).Symbol is ITypeSymbol;
        if ((type is null or IErrorTypeSymbol) && parsed is NameSyntax
            && model.GetSpeculativeSymbolInfo(start, parsed, SpeculativeBindingOption.BindAsTypeOrNamespace).Symbol is ITypeSymbol named)
        {
            isType = true;
            type = named;
        }
        if (type is IErrorTypeSymbol) type = null;
        var compilation = model.Compilation;

        bool Implements(ITypeSymbol? t, SpecialType special) => t is not null && (t.SpecialType == special || t.AllInterfaces.Any(i => i.OriginalDefinition.SpecialType == special));
        var isEnumerable = type is IArrayTypeSymbol || (type?.SpecialType != SpecialType.System_String && Implements(type, SpecialType.System_Collections_IEnumerable));
        var countProperty = type is IArrayTypeSymbol || type?.SpecialType == SpecialType.System_String ? "Length"
            : HasProperty(type, "Count") ? "Count"
            : HasProperty(type, "Length") ? "Length" : null;
        var exceptionType = compilation.GetTypeByMetadataName("System.Exception");
        var isException = false;
        for (var t = type as INamedTypeSymbol; t is not null; t = t.BaseType)
            if (SymbolEqualityComparer.Default.Equals(t, exceptionType)) isException = true;
        var isAwaitable = !isType && type is not null && type.GetMembers("GetAwaiter").OfType<IMethodSymbol>().Any(m => m.Parameters.Length == 0);
        var isDisposable = Implements(type, SpecialType.System_IDisposable) || type?.AllInterfaces.Any(i => i.Name == "IAsyncDisposable") == true;
        var canBeNull = type is { IsReferenceType: true } || type?.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T || type is ITypeParameterSymbol;
        var isStatement = false;
        for (var n = access; n is not null && n.SpanStart == start; n = n.Parent)
        {
            if (n is StatementSyntax or GlobalStatementSyntax or IncompleteMemberSyntax)
            {
                isStatement = true;
                break;
            }
        }

        var range = ToRange(text, TextSpan.FromBounds(start, wordEnd));
        return new PostfixContextDto(
            range, exprText, type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            type?.SpecialType == SpecialType.System_Boolean, isEnumerable, countProperty, canBeNull, isAwaitable, isDisposable, isException, isType,
            type?.SpecialType == SpecialType.System_Void, isStatement, SuggestName(exprText, type));
    }

    private static bool HasProperty(ITypeSymbol? type, string name)
    {
        for (var t = type; t is not null; t = t.BaseType)
            if (t.GetMembers(name).OfType<IPropertySymbol>().Any()) return true;
        return type?.AllInterfaces.Any(i => i.GetMembers(name).OfType<IPropertySymbol>().Any()) == true;
    }

    /// <summary>A variable name for .var / .foreach: the last identifier of the expression, else one from the type.</summary>
    private static string SuggestName(string expr, ITypeSymbol? type)
    {
        var tail = new string(expr.Reverse().TakeWhile(c => char.IsLetterOrDigit(c) || c == '_').Reverse().ToArray());
        if (tail.StartsWith("Get", StringComparison.Ordinal) && tail.Length > 3) tail = tail[3..];
        var name = tail.Length > 0 && char.IsLetter(tail[0]) ? tail : type is IArrayTypeSymbol at ? at.ElementType.Name + "s" : type?.Name ?? "value";
        if (name.Length == 0) name = "value";
        name = char.ToLowerInvariant(name[0]) + name[1..];
        return SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None ? "@" + name : name;
    }

    // ------------------------------------------------------------------ type declaration

    /// <summary>Go to Type Declaration: the type of the variable, parameter, member or expression at the caret.</summary>
    public async Task<DefinitionDto> TypeDefinitionAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        ITypeSymbol? type = symbol switch
        {
            ILocalSymbol l => l.Type,
            IParameterSymbol p => p.Type,
            IFieldSymbol f => f.Type,
            IPropertySymbol p => p.Type,
            IEventSymbol e => e.Type,
            IMethodSymbol m => m.MethodKind == MethodKind.Constructor ? m.ContainingType : m.ReturnType,
            ITypeSymbol t => t,
            _ => null,
        };
        while (type is IArrayTypeSymbol arr) type = arr.ElementType;
        if (type is IPointerTypeSymbol ptr) type = ptr.PointedAtType;
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n) type = n.TypeArguments[0];
        if (type is null) return new DefinitionDto([], null);
        var def = type.OriginalDefinition;
        var locations = await SourceLocationsAsync(def, ct);
        if (locations.Count > 0) return new DefinitionDto(locations, null);
        var compilation = await doc.Project.GetCompilationAsync(ct);
        return new DefinitionDto([], compilation is null ? null : metadata.Build(def, compilation));
    }
}
