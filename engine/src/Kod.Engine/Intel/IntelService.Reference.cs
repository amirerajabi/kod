using Microsoft.CodeAnalysis;

namespace Kod.Engine.Intel;

/// <summary>Copy Reference (Rider's Ctrl+Alt+Shift+C): the fully qualified name of the symbol at the caret.</summary>
public sealed partial class IntelService
{
    private static readonly SymbolDisplayFormat ReferenceFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeContainingType,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers);

    /// <summary>Namespace.Type.Member for the symbol at the position (a local or parameter gives its member), or null.</summary>
    public async Task<string?> ReferenceAsync(DocRequest r, CancellationToken ct)
    {
        var (_, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        while (symbol is ILocalSymbol or IParameterSymbol or IRangeVariableSymbol or ILabelSymbol or ITypeParameterSymbol || symbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction })
            symbol = symbol.ContainingSymbol;
        if (symbol is null or IAssemblySymbol or IModuleSymbol || symbol is INamespaceSymbol { IsGlobalNamespace: true }) return null;
        symbol = symbol.OriginalDefinition;
        // a constructor is named after its type, as Rider copies it
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } ctor) symbol = ctor.ContainingType;
        return symbol.ToDisplayString(ReferenceFormat);
    }
}
