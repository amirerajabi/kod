using System.Collections.Immutable;
using System.Text;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Tags;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>Kind names the UI maps to Monaco completion / symbol kinds.</summary>
public static class Kinds
{
    private static readonly string[] Order =
    [
        WellKnownTags.Class, WellKnownTags.Structure, WellKnownTags.Interface, WellKnownTags.Enum, WellKnownTags.EnumMember,
        WellKnownTags.Delegate, WellKnownTags.Method, WellKnownTags.ExtensionMethod, WellKnownTags.Property, WellKnownTags.Field,
        WellKnownTags.Event, WellKnownTags.Constant, WellKnownTags.Local, WellKnownTags.Parameter, WellKnownTags.RangeVariable,
        WellKnownTags.Namespace, WellKnownTags.TypeParameter, WellKnownTags.Keyword, WellKnownTags.Snippet, WellKnownTags.Label,
        WellKnownTags.Operator, WellKnownTags.Module, WellKnownTags.Assembly, WellKnownTags.File, WellKnownTags.Folder,
    ];

    public static string FromTags(ImmutableArray<string> tags)
    {
        foreach (var k in Order)
            if (tags.Contains(k)) return k.ToLowerInvariant();
        return "text";
    }

    public static string FromSymbol(ISymbol s) => s switch
    {
        INamedTypeSymbol t => t.TypeKind switch
        {
            TypeKind.Interface => "interface",
            TypeKind.Struct => "structure",
            TypeKind.Enum => "enum",
            TypeKind.Delegate => "delegate",
            _ => "class",
        },
        IMethodSymbol m => m.MethodKind == MethodKind.Constructor ? "constructor" : "method",
        IPropertySymbol => "property",
        IFieldSymbol f => f.IsConst ? "constant" : f.ContainingType?.TypeKind == TypeKind.Enum ? "enummember" : "field",
        IEventSymbol => "event",
        INamespaceSymbol => "namespace",
        _ => "text",
    };
}

public static class Markdown
{
    public static string Escape(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s)
        {
            if (ch is '\\' or '`' or '*' or '_' or '<' or '>' or '#' or '[' or ']') sb.Append('\\');
            sb.Append(ch);
        }
        return sb.ToString().Replace("\r\n", "\n").Replace("\n", "  \n");
    }
}

/// <summary>Summary and parameter text from a symbol's XML documentation.</summary>
public static class DocXml
{
    public sealed record Docs(string? Summary, Dictionary<string, string> Params);

    public static Docs Parse(ISymbol symbol)
    {
        var xml = symbol.GetDocumentationCommentXml(expandIncludes: true);
        var ps = new Dictionary<string, string>();
        if (string.IsNullOrWhiteSpace(xml)) return new Docs(null, ps);
        try
        {
            var root = XElement.Parse(xml.Contains("<member", StringComparison.Ordinal) ? xml : $"<doc>{xml}</doc>");
            var summary = root.Element("summary") is { } s ? Flatten(s) : null;
            foreach (var p in root.Elements("param"))
                if ((string?)p.Attribute("name") is { } n) ps[n] = Flatten(p);
            return new Docs(summary, ps);
        }
        catch (System.Xml.XmlException)
        {
            return new Docs(null, ps);
        }
    }

    private static string Flatten(XElement e)
    {
        var sb = new StringBuilder();
        foreach (var node in e.Nodes())
        {
            switch (node)
            {
                case XText t: sb.Append(t.Value); break;
                case XElement x when x.Name == "see" || x.Name == "seealso":
                    var cref = (string?)x.Attribute("cref") ?? (string?)x.Attribute("langword") ?? x.Value;
                    sb.Append(cref.Length > 2 && cref[1] == ':' ? cref[2..] : cref);
                    break;
                case XElement x when x.Name == "paramref" || x.Name == "typeparamref":
                    sb.Append((string?)x.Attribute("name"));
                    break;
                case XElement x: sb.Append(Flatten(x)); break;
            }
        }
        return string.Join(' ', sb.ToString().Split((char[])[' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries));
    }
}

/// <summary>The document outline (breadcrumbs, Go to Symbol in File).</summary>
public static class Outline
{
    public static IReadOnlyList<SymbolDto> Build(SyntaxNode root, SourceText text)
    {
        var list = new List<SymbolDto>();
        foreach (var child in root.ChildNodes()) Visit(child, text, list);
        return list;
    }

    private static void Visit(SyntaxNode node, SourceText text, List<SymbolDto> into)
    {
        switch (node)
        {
            case BaseNamespaceDeclarationSyntax ns:
            {
                var children = new List<SymbolDto>();
                foreach (var m in ns.Members) Visit(m, text, children);
                into.Add(Make(ns.Name.ToString(), null, "namespace", ns, ns.Name.Span, text, children));
                break;
            }
            case BaseTypeDeclarationSyntax type:
            {
                var children = new List<SymbolDto>();
                if (type is TypeDeclarationSyntax td) foreach (var m in td.Members) Visit(m, text, children);
                if (type is EnumDeclarationSyntax ed)
                    foreach (var m in ed.Members) children.Add(Make(m.Identifier.ValueText, null, "enummember", m, m.Identifier.Span, text, []));
                var kind = type switch
                {
                    InterfaceDeclarationSyntax => "interface",
                    StructDeclarationSyntax => "structure",
                    RecordDeclarationSyntax r when r.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) => "structure",
                    EnumDeclarationSyntax => "enum",
                    _ => "class",
                };
                var name = type.Identifier.ValueText + (type is TypeDeclarationSyntax { TypeParameterList: { } tp } ? tp.ToString() : "");
                into.Add(Make(name, null, kind, type, type.Identifier.Span, text, children));
                break;
            }
            case DelegateDeclarationSyntax d:
                into.Add(Make(d.Identifier.ValueText, d.ParameterList.ToString(), "delegate", d, d.Identifier.Span, text, []));
                break;
            case MethodDeclarationSyntax m:
                into.Add(Make(m.Identifier.ValueText + m.TypeParameterList, $"{m.ParameterList} : {m.ReturnType}", "method", m, m.Identifier.Span, text, []));
                break;
            case ConstructorDeclarationSyntax c:
                into.Add(Make(c.Identifier.ValueText, c.ParameterList.ToString(), "constructor", c, c.Identifier.Span, text, []));
                break;
            case DestructorDeclarationSyntax dd:
                into.Add(Make("~" + dd.Identifier.ValueText, null, "method", dd, dd.Identifier.Span, text, []));
                break;
            case PropertyDeclarationSyntax p:
                into.Add(Make(p.Identifier.ValueText, p.Type.ToString(), "property", p, p.Identifier.Span, text, []));
                break;
            case IndexerDeclarationSyntax ix:
                into.Add(Make("this" + ix.ParameterList, ix.Type.ToString(), "property", ix, ix.ThisKeyword.Span, text, []));
                break;
            case EventDeclarationSyntax e:
                into.Add(Make(e.Identifier.ValueText, e.Type.ToString(), "event", e, e.Identifier.Span, text, []));
                break;
            case BaseFieldDeclarationSyntax f:
                var isConst = f.Modifiers.Any(SyntaxKind.ConstKeyword);
                var fkind = f is EventFieldDeclarationSyntax ? "event" : isConst ? "constant" : "field";
                foreach (var v in f.Declaration.Variables)
                    into.Add(Make(v.Identifier.ValueText, f.Declaration.Type.ToString(), fkind, f, v.Identifier.Span, text, []));
                break;
            case OperatorDeclarationSyntax o:
                into.Add(Make("operator " + o.OperatorToken.Text, o.ParameterList.ToString(), "operator", o, o.OperatorToken.Span, text, []));
                break;
            case ConversionOperatorDeclarationSyntax co:
                into.Add(Make($"{co.ImplicitOrExplicitKeyword.Text} operator {co.Type}", null, "operator", co, co.Type.Span, text, []));
                break;
            case GlobalStatementSyntax:
                break;
        }
    }

    private static SymbolDto Make(string name, string? detail, string kind, SyntaxNode node, TextSpan selection, SourceText text, IReadOnlyList<SymbolDto> children) =>
        new(name, detail, kind, IntelService.ToRange(text, node.Span), IntelService.ToRange(text, selection), children);
}
