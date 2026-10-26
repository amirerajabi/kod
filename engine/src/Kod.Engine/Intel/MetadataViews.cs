using System.Text;
using Microsoft.CodeAnalysis;

namespace Kod.Engine.Intel;

/// <summary>
/// "Go to definition" on a framework or package symbol: a generated, read-only C# declaration of its type
/// (signatures and summaries, no bodies), with the range of the requested member.
/// </summary>
public sealed class MetadataViews
{
    private static readonly SymbolDisplayFormat MemberFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters | SymbolDisplayGenericsOptions.IncludeTypeConstraints | SymbolDisplayGenericsOptions.IncludeVariance,
        memberOptions: SymbolDisplayMemberOptions.IncludeAccessibility | SymbolDisplayMemberOptions.IncludeModifiers | SymbolDisplayMemberOptions.IncludeParameters
                       | SymbolDisplayMemberOptions.IncludeType | SymbolDisplayMemberOptions.IncludeRef | SymbolDisplayMemberOptions.IncludeExplicitInterface
                       | SymbolDisplayMemberOptions.IncludeConstantValue,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeParamsRefOut
                          | SymbolDisplayParameterOptions.IncludeDefaultValue | SymbolDisplayParameterOptions.IncludeExtensionThis | SymbolDisplayParameterOptions.IncludeOptionalBrackets,
        propertyStyle: SymbolDisplayPropertyStyle.ShowReadWriteDescriptor,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers
                              | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SymbolDisplayFormat TypeNameFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameOnly,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters | SymbolDisplayGenericsOptions.IncludeVariance,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers);

    public MetadataViewDto? Build(ISymbol symbol, Compilation compilation)
    {
        var type = symbol as INamedTypeSymbol ?? symbol.ContainingType;
        while (type?.ContainingType is not null) type = type.ContainingType;
        if (type is null) return null;

        var sb = new StringBuilder();
        var asm = type.ContainingAssembly;
        sb.Append("// ").Append(asm?.Identity.GetDisplayName() ?? "metadata").Append('\n');
        sb.Append("// Generated from metadata: declarations only, read-only.\n\n");
        if (type.ContainingNamespace is { IsGlobalNamespace: false } ns) sb.Append("namespace ").Append(ns.ToDisplayString()).Append(";\n\n");

        var targetLine = -1;
        var targetCol = 0;
        var targetLen = 0;
        WriteType(type, 0);

        var text = sb.ToString();
        var uri = $"kod-metadata:/{asm?.Name ?? "metadata"}/{type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat).Replace("global::", "").Replace('<', '[').Replace('>', ']')}.cs";
        var range = targetLine >= 0 ? new RangeDto(targetLine, targetCol, targetLine, targetCol + targetLen) : new RangeDto(1, 1, 1, 1);
        return new MetadataViewDto(uri, type.Name + " [metadata]", text, range);

        int Line() => sb.ToString().Count(c => c == '\n') + 1;

        void Mark(ISymbol s, string lineText, int indent)
        {
            if (!SymbolEqualityComparer.Default.Equals(s.OriginalDefinition, symbol.OriginalDefinition)) return;
            targetLine = Line();
            var idx = lineText.IndexOf(s.Name, StringComparison.Ordinal);
            targetCol = indent + Math.Max(0, idx) + 1;
            targetLen = s.Name.Length;
        }

        void Doc(ISymbol s, string pad)
        {
            var docs = DocXml.Parse(s);
            if (docs.Summary is null) return;
            sb.Append(pad).Append("/// <summary>").Append(docs.Summary).Append("</summary>\n");
        }

        void WriteType(INamedTypeSymbol t, int depth)
        {
            var pad = new string(' ', depth * 4);
            Doc(t, pad);
            var header = new StringBuilder();
            header.Append(Accessibility(t.DeclaredAccessibility));
            if (t.TypeKind == TypeKind.Class)
            {
                if (t.IsStatic) header.Append("static ");
                else if (t.IsAbstract) header.Append("abstract ");
                else if (t.IsSealed) header.Append("sealed ");
            }
            header.Append(t.IsRecord ? (t.TypeKind == TypeKind.Struct ? "record struct " : "record ") : t.TypeKind switch
            {
                TypeKind.Interface => "interface ",
                TypeKind.Struct => t.IsReadOnly ? "readonly struct " : "struct ",
                TypeKind.Enum => "enum ",
                TypeKind.Delegate => "delegate ",
                _ => "class ",
            });
            header.Append(t.ToDisplayString(TypeNameFormat));
            var bases = new List<string>();
            if (t.BaseType is { SpecialType: not (SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum) } bt && t.TypeKind == TypeKind.Class)
                bases.Add(bt.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat));
            bases.AddRange(t.Interfaces.Select(i => i.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
            if (bases.Count > 0) header.Append(" : ").Append(string.Join(", ", bases));
            var headerText = header.ToString();
            Mark(t, headerText, pad.Length);
            sb.Append(pad).Append(headerText).Append('\n').Append(pad).Append("{\n");

            var inner = pad + "    ";
            var members = t.GetMembers()
                .Where(m => !m.IsImplicitlyDeclared && m.DeclaredAccessibility is Microsoft.CodeAnalysis.Accessibility.Public or Microsoft.CodeAnalysis.Accessibility.Protected or Microsoft.CodeAnalysis.Accessibility.ProtectedOrInternal)
                .Where(m => m is not IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.EventRaise })
                .OrderBy(m => m switch { IFieldSymbol => 0, IMethodSymbol { MethodKind: MethodKind.Constructor } => 1, IPropertySymbol => 2, IEventSymbol => 3, IMethodSymbol => 4, _ => 5 })
                .ThenBy(m => m.Name, StringComparer.Ordinal);
            foreach (var m in members)
            {
                if (m is INamedTypeSymbol nested)
                {
                    WriteType(nested, depth + 1);
                    continue;
                }
                Doc(m, inner);
                string line;
                if (t.TypeKind == TypeKind.Enum && m is IFieldSymbol ef)
                    line = $"{ef.Name} = {ef.ConstantValue},";
                else
                {
                    line = m.ToDisplayString(MemberFormat);
                    if (m is IMethodSymbol or IFieldSymbol or IEventSymbol) line += ";";
                    if (m is IMethodSymbol { MethodKind: MethodKind.Constructor }) line = line.Replace(".ctor", t.Name);
                }
                Mark(m, line, inner.Length);
                sb.Append(inner).Append(line).Append('\n');
            }
            sb.Append(pad).Append("}\n");
        }
    }

    private static string Accessibility(Microsoft.CodeAnalysis.Accessibility a) => a switch
    {
        Microsoft.CodeAnalysis.Accessibility.Public => "public ",
        Microsoft.CodeAnalysis.Accessibility.Protected => "protected ",
        Microsoft.CodeAnalysis.Accessibility.Internal => "internal ",
        Microsoft.CodeAnalysis.Accessibility.ProtectedOrInternal => "protected internal ",
        Microsoft.CodeAnalysis.Accessibility.Private => "private ",
        _ => "",
    };
}
