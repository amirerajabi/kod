using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>A usage as Rider's Show Usages popup and Find Usages window list it: what kind of access it is, the member
/// it sits in and its project, with the line and the matched span in it.</summary>
public sealed record UsageDto(
    string Path,
    RangeDto Range,
    string Line,
    int HighlightStart,
    int HighlightEnd,
    string Kind,
    string? Container,
    string Project);

public sealed record UsagesDto(string Symbol, string SymbolKind, IReadOnlyList<UsageDto> Usages);

public sealed partial class IntelService
{
    private static readonly SymbolDisplayFormat UsageSymbolFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeContainingType,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    /// <summary>Find Usages with Rider's detail: declarations plus every reference, each with its access kind (read,
    /// write, invocation, new instance, import, attribute, nameof, base type, type usage) and containing member.</summary>
    public async Task<UsagesDto?> UsagesAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null) return null;
        var solution = doc.Project.Solution;
        var definition = symbol.OriginalDefinition;
        var list = new List<UsageDto>();
        foreach (var rs in await SymbolFinder.FindReferencesAsync(definition, solution, ct))
        {
            foreach (var loc in rs.Definition.Locations.Where(l => l.IsInSource))
                if (solution.GetDocument(loc.SourceTree) is { } d) list.Add(await UsageAsync(d, loc.SourceSpan, "declaration", ct));
            foreach (var rl in rs.Locations)
            {
                if (!rl.Location.IsInSource || rl.IsImplicit) continue;
                var root = await rl.Document.GetSyntaxRootAsync(ct);
                var node = root!.FindNode(rl.Location.SourceSpan, getInnermostNodeForTie: true);
                list.Add(await UsageAsync(rl.Document, rl.Location.SourceSpan, KindOf(node, rs.Definition), ct));
            }
        }
        // multi-targeted projects find each place once per target framework
        var usages = list
            .GroupBy(u => (u.Path.ToLowerInvariant(), u.Range))
            .Select(g => g.OrderByDescending(u => u.Kind == "declaration").First())
            .OrderBy(u => u.Path, StringComparer.OrdinalIgnoreCase).ThenBy(u => u.Range.StartLine).ThenBy(u => u.Range.StartColumn)
            .ToList();
        return new UsagesDto(definition.ToDisplayString(UsageSymbolFormat), KindName(definition), usages);
    }

    private static async Task<UsageDto> UsageAsync(Document doc, TextSpan span, string kind, CancellationToken ct)
    {
        var text = await doc.GetTextAsync(ct);
        var range = ToRange(text, span);
        var line = text.Lines[range.StartLine - 1].ToString();
        var indent = line.Length - line.TrimStart().Length;
        var trimmed = line.Trim();
        var start = Math.Max(0, range.StartColumn - 1 - indent);
        var end = range.EndLine == range.StartLine ? Math.Max(start, range.EndColumn - 1 - indent) : trimmed.Length;
        if (trimmed.Length > 240) trimmed = trimmed[..240];
        string? container = null;
        if (await doc.GetSemanticModelAsync(ct) is { } model && model.GetEnclosingSymbol(span.Start, ct) is { } enclosing)
            container = ContainerName(enclosing);
        return new UsageDto(doc.FilePath ?? "", range, trimmed, Math.Min(start, trimmed.Length), Math.Min(end, trimmed.Length), kind, container, ProjectName(doc.Project));
    }

    /// <summary>"Type.Member" for the member a usage sits in (lambdas and local functions count as their member).</summary>
    private static string? ContainerName(ISymbol s)
    {
        while (s is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction } && s.ContainingSymbol is { } outer) s = outer;
        return s switch
        {
            INamespaceSymbol { IsGlobalNamespace: true } => null,
            INamespaceSymbol ns => ns.ToDisplayString(),
            INamedTypeSymbol t => t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
            IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove, AssociatedSymbol: { } p } => ContainerName(p),
            IMethodSymbol { MethodKind: MethodKind.Constructor } m => $"{m.ContainingType.Name}.ctor",
            IMethodSymbol { Name: WellKnownMemberNames.TopLevelStatementsEntryPointMethodName } => "top-level statements",
            _ when s.ContainingType is { } t => $"{t.Name}.{s.Name}",
            _ => s.Name,
        };
    }

    /// <summary>The project's name without the "(net8.0)" Roslyn adds for each target framework.</summary>
    private static string ProjectName(Project p)
    {
        var paren = p.Name.LastIndexOf('(');
        return paren > 0 && p.Name.EndsWith(')') ? p.Name[..paren] : p.Name;
    }

    private static string KindName(ISymbol s) => s switch
    {
        INamedTypeSymbol { TypeKind: TypeKind.Interface } => "interface",
        INamedTypeSymbol { TypeKind: TypeKind.Struct } => "struct",
        INamedTypeSymbol { TypeKind: TypeKind.Enum } => "enum",
        INamedTypeSymbol { TypeKind: TypeKind.Delegate } => "delegate",
        INamedTypeSymbol { IsRecord: true } => "record",
        INamedTypeSymbol => "class",
        IMethodSymbol { MethodKind: MethodKind.Constructor } => "constructor",
        IMethodSymbol => "method",
        IPropertySymbol => "property",
        IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum } => "enum member",
        IFieldSymbol => "field",
        IEventSymbol => "event",
        ILocalSymbol => "local variable",
        IParameterSymbol => "parameter",
        INamespaceSymbol => "namespace",
        ITypeParameterSymbol => "type parameter",
        _ => s.Kind.ToString().ToLowerInvariant(),
    };

    /// <summary>Rider's usage types, read from the syntax around the reference.</summary>
    private static string KindOf(SyntaxNode node, ISymbol symbol)
    {
        // the name itself: Foo, x.Foo, Foo<T>, global::A.Foo
        SyntaxNode expr = node;
        while (expr.Parent is MemberAccessExpressionSyntax ma && ma.Name == expr
               || expr.Parent is QualifiedNameSyntax qn && qn.Right == expr
               || expr.Parent is AliasQualifiedNameSyntax aq && aq.Name == expr
               || expr.Parent is MemberBindingExpressionSyntax
               || expr.Parent is ConditionalAccessExpressionSyntax ca && ca.WhenNotNull == expr)
            expr = expr.Parent!;
        var parent = expr.Parent;

        if (node.FirstAncestorOrSelf<UsingDirectiveSyntax>() is not null) return "import";
        if (node.FirstAncestorOrSelf<AttributeSyntax>() is { } attr && attr.Name.Span.Contains(node.Span)) return "attribute";
        if (parent is ArgumentSyntax { Parent.Parent: InvocationExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" } } }) return "nameof";
        if (node.FirstAncestorOrSelf<BaseListSyntax>() is not null && symbol is INamedTypeSymbol) return "base";
        if (parent is ObjectCreationExpressionSyntax oc && oc.Type == expr || node is ImplicitObjectCreationExpressionSyntax) return "creation";
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } && node.FirstAncestorOrSelf<ObjectCreationExpressionSyntax>() is not null) return "creation";
        if (parent is InvocationExpressionSyntax inv && inv.Expression == expr) return "invocation";
        if (symbol is IMethodSymbol) return "reference";
        if (symbol is INamedTypeSymbol or INamespaceSymbol or ITypeParameterSymbol)
            return parent is TypeOfExpressionSyntax ? "typeof" : "type";

        // values: fields, properties, locals, parameters, events
        switch (parent)
        {
            case AssignmentExpressionSyntax a when a.Left == expr:
                return a.IsKind(SyntaxKind.SimpleAssignmentExpression) ? "write" : "readwrite";
            case PrefixUnaryExpressionSyntax p when p.IsKind(SyntaxKind.PreIncrementExpression) || p.IsKind(SyntaxKind.PreDecrementExpression):
            case PostfixUnaryExpressionSyntax q when q.IsKind(SyntaxKind.PostIncrementExpression) || q.IsKind(SyntaxKind.PostDecrementExpression):
                return "readwrite";
            case ArgumentSyntax arg when arg.RefKindKeyword.IsKind(SyntaxKind.OutKeyword):
                return "write";
            case ArgumentSyntax arg when arg.RefKindKeyword.IsKind(SyntaxKind.RefKeyword):
                return "readwrite";
            case InitializerExpressionSyntax when expr.Parent is AssignmentExpressionSyntax:
                return "write";
        }
        if (parent is AssignmentExpressionSyntax { Parent: InitializerExpressionSyntax } init && init.Left == expr) return "write";
        if (symbol is IEventSymbol) return "reference";
        return "read";
    }
}
