using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>
/// Rider's Generate menu (Alt+Insert): constructors, properties, equality and formatting members, overrides, missing
/// members and the dispose pattern for the type at the caret. Members are written with fully qualified names, then
/// simplified, given usings and formatted.
/// </summary>
public sealed class GenerateService(IntelService intel)
{
    /// <summary>The innermost class, struct or record declaration around the caret (not the type a reference there names).</summary>
    internal static async Task<(Document Doc, TypeDeclarationSyntax Decl, INamedTypeSymbol Type, SemanticModel Model)> TypeAtAsync(
        IntelService intel, string path, string? text, int line, int column, CancellationToken ct, bool interfaces = false)
    {
        var doc = intel.Doc(path, text);
        var source = await doc.GetTextAsync(ct);
        var root = (await doc.GetSyntaxRootAsync(ct))!;
        var pos = Math.Clamp(IntelService.Offset(source, line, column), 0, Math.Max(0, root.FullSpan.End - 1));
        var decl = root.FindToken(pos).Parent?.AncestorsAndSelf().OfType<TypeDeclarationSyntax>()
            .FirstOrDefault(t => interfaces || t is not InterfaceDeclarationSyntax);
        var model = (await doc.GetSemanticModelAsync(ct))!;
        if (decl is null || model.GetDeclaredSymbol(decl, ct) is not { } type)
            throw new InvalidOperationException(interfaces ? "Put the caret in a type" : "Put the caret in a class or struct");
        return (doc, decl, type, model);
    }

    private static readonly SymbolDisplayFormat Qualified = SymbolDisplayFormat.FullyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SymbolDisplayFormat Short = SymbolDisplayFormat.MinimallyQualifiedFormat
        .AddMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SymbolDisplayFormat SignatureFormat = new(
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeType | SymbolDisplayMemberOptions.IncludeRef,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeParamsRefOut,
        propertyStyle: SymbolDisplayPropertyStyle.ShowReadWriteDescriptor,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier | SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers);

    // ------------------------------------------------------------------ what can be generated

    public async Task<GenerateInfoDto> InfoAsync(DocRequest r, CancellationToken ct)
    {
        var (_, _, type, model) = await TypeAtAsync(intel, r.Path, r.Text, r.Line, r.Column, ct);
        var members = DataMembers(type).Select(m => MemberDto(m, model.Compilation)).ToList();
        var fields = WrappableFields(type).Select(f => MemberDto(f, model.Compilation)).ToList();
        var overridable = Overridable(type, model.Compilation).Select(Signature).ToList();
        var missing = Missing(type).Select(Signature).ToList();
        var hasEquals = type.IsRecord || type.GetMembers(nameof(Equals)).OfType<IMethodSymbol>().Any(m => !m.IsImplicitlyDeclared && m.Parameters.Length == 1);
        var hasToString = type.GetMembers(nameof(ToString)).OfType<IMethodSymbol>().Any(m => !m.IsImplicitlyDeclared && m.Parameters.Length == 0);
        return new GenerateInfoDto(
            type.Name, Kinds.FromSymbol(type), members, fields, overridable, missing, hasEquals, hasToString,
            IsDisposable(type, model.Compilation), type.IsSealed || type.TypeKind == TypeKind.Struct);
    }

    private static GenerateMemberDto MemberDto(ISymbol m, Compilation compilation)
    {
        var t = MemberType(m);
        return new GenerateMemberDto(
            m.Name, m.Name, t.ToDisplayString(Short), m is IFieldSymbol ? "field" : "property", Assignable(m),
            t.IsReferenceType && t.NullableAnnotation != NullableAnnotation.Annotated, IsDisposable(t, compilation));
    }

    private static ITypeSymbol MemberType(ISymbol m) => m switch
    {
        IFieldSymbol f => f.Type,
        IPropertySymbol p => p.Type,
        _ => throw new ArgumentException(m.Name),
    };

    /// <summary>Instance fields and properties a constructor, Equals or ToString can use.</summary>
    private static IEnumerable<ISymbol> DataMembers(INamedTypeSymbol type) =>
        type.GetMembers().Where(m => !m.IsStatic && !m.IsImplicitlyDeclared && m.Locations.Any(l => l.IsInSource) && m switch
        {
            IFieldSymbol f => !f.IsConst && f.AssociatedSymbol is null,
            IPropertySymbol p => !p.IsIndexer && p.ExplicitInterfaceImplementations.IsEmpty && p.GetMethod is not null,
            _ => false,
        });

    /// <summary>A field, a property with a setter or an auto-property (its backing field is assignable in a constructor).</summary>
    private static bool Assignable(ISymbol m) => m switch
    {
        IFieldSymbol => true,
        IPropertySymbol p => p.SetMethod is not null || p.ContainingType.GetMembers().OfType<IFieldSymbol>().Any(f => SymbolEqualityComparer.Default.Equals(f.AssociatedSymbol, p)),
        _ => false,
    };

    /// <summary>Fields Generate › Properties can wrap: those without a property of the name it would get.</summary>
    private static IEnumerable<IFieldSymbol> WrappableFields(INamedTypeSymbol type) =>
        type.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsConst && !f.IsImplicitlyDeclared && f.AssociatedSymbol is null
            && f.Locations.Any(l => l.IsInSource) && PropertyName(f.Name) is { } n && n != f.Name && type.GetMembers(n).IsEmpty);

    internal static string? PropertyName(string field)
    {
        var n = field.StartsWith("m_", StringComparison.Ordinal) ? field[2..] : field.TrimStart('_');
        return n.Length == 0 ? null : char.ToUpperInvariant(n[0]) + n[1..];
    }

    internal static string ParameterName(string member)
    {
        var n = member.StartsWith("m_", StringComparison.Ordinal) ? member[2..] : member.TrimStart('_');
        if (n.Length == 0) n = "value";
        n = char.ToLowerInvariant(n[0]) + n[1..];
        return SyntaxFacts.GetKeywordKind(n) != SyntaxKind.None ? "@" + n : n;
    }

    private static bool IsDisposable(ITypeSymbol t, Compilation c) =>
        c.GetSpecialType(SpecialType.System_IDisposable) is { } d && (SymbolEqualityComparer.Default.Equals(t, d) || t.AllInterfaces.Contains(d, SymbolEqualityComparer.Default));

    private static GenerateSignatureDto Signature(ISymbol m) =>
        new(Id(m), m.ToDisplayString(SignatureFormat), Kinds.FromSymbol(m), m.ContainingType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat));

    /// <summary>The member with its containing type and parameters: tells IComparer&lt;A&gt;.Compare from IComparer&lt;B&gt;.Compare.</summary>
    private static string Id(ISymbol m) => m.ToDisplayString();

    /// <summary>Base members already overridden here or by a nearer base, and the members those override.</summary>
    private static HashSet<ISymbol> Overridden(IEnumerable<INamedTypeSymbol> types)
    {
        var set = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var t in types)
        foreach (var m in t.GetMembers())
            for (var o = OverriddenMember(m); o is not null; o = OverriddenMember(o))
                set.Add(o.OriginalDefinition);
        return set;
    }

    private static ISymbol? OverriddenMember(ISymbol m) => m switch
    {
        IMethodSymbol x => x.OverriddenMethod,
        IPropertySymbol x => x.OverriddenProperty,
        IEventSymbol x => x.OverriddenEvent,
        _ => null,
    };

    private static IEnumerable<INamedTypeSymbol> Bases(INamedTypeSymbol type)
    {
        for (var b = type.BaseType; b is not null; b = b.BaseType) yield return b;
    }

    private static bool CanOverride(ISymbol m) => m switch
    {
        IMethodSymbol x => x.MethodKind == MethodKind.Ordinary && x.Name != "Finalize",
        IPropertySymbol or IEventSymbol => true,
        _ => false,
    };

    /// <summary>Virtual, abstract and override members of the base classes that are not overridden yet.</summary>
    private static List<ISymbol> Overridable(INamedTypeSymbol type, Compilation compilation)
    {
        if (type.TypeKind != TypeKind.Class) return type.TypeKind == TypeKind.Struct ? ObjectOverrides(type, compilation) : [];
        var seen = Overridden([type]);
        var result = new List<ISymbol>();
        foreach (var b in Bases(type))
        {
            foreach (var m in b.GetMembers())
            {
                if (m.IsStatic || m.IsSealed || !(m.IsVirtual || m.IsAbstract || m.IsOverride) || !CanOverride(m) || seen.Contains(m.OriginalDefinition)) continue;
                if (!compilation.IsSymbolAccessibleWithin(m, type)) continue;
                result.Add(m);
            }
            foreach (var m in b.GetMembers())
                for (var o = OverriddenMember(m); o is not null; o = OverriddenMember(o))
                    seen.Add(o.OriginalDefinition);
        }
        return result;
    }

    /// <summary>A struct can only override object's (ValueType's) Equals, GetHashCode and ToString.</summary>
    private static List<ISymbol> ObjectOverrides(INamedTypeSymbol type, Compilation compilation)
    {
        var mine = Overridden([type]);
        return compilation.GetSpecialType(SpecialType.System_Object).GetMembers()
            .Where(m => m.IsVirtual && CanOverride(m) && !mine.Contains(m)).ToList();
    }

    /// <summary>Interface members without an implementation and abstract base members without an override.</summary>
    private static List<ISymbol> Missing(INamedTypeSymbol type)
    {
        var result = new List<ISymbol>();
        foreach (var i in type.AllInterfaces)
        foreach (var m in i.GetMembers())
            if (m.IsAbstract && !m.IsStatic && CanOverride(m) && type.FindImplementationForInterfaceMember(m) is null)
                result.Add(m);
        if (type.TypeKind == TypeKind.Class)
        {
            var overridden = Overridden([type, .. Bases(type)]);
            foreach (var b in Bases(type).Where(b => b.IsAbstract))
            foreach (var m in b.GetMembers())
                if (m.IsAbstract && CanOverride(m) && !overridden.Contains(m.OriginalDefinition))
                    result.Add(m);
        }
        return result;
    }

    // ------------------------------------------------------------------ generate

    public async Task<IReadOnlyList<FileEditsDto>> GenerateAsync(GenerateRequest r, CancellationToken ct)
    {
        var (doc, decl, type, model) = await TypeAtAsync(intel, r.Path, r.Text, r.Line, r.Column, ct);
        var compilation = model.Compilation;
        var nullable = model.GetNullableContext(decl.SpanStart).AnnotationsEnabled();
        var picked = DataMembers(type).Where(m => r.MemberIds.Contains(m.Name)).ToList();
        var texts = new List<string>();
        var nodes = new List<SyntaxNode>();
        var replace = new List<SyntaxNode>();
        string? addInterface = null;
        var self = type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        var isStruct = type.TypeKind == TypeKind.Struct;

        switch (r.Kind)
        {
            case "constructor":
                texts.Add(Constructor(type, picked.Where(Assignable).ToList(), r.NullChecks, compilation));
                break;
            case "properties":
            case "readonlyProperties":
                foreach (var f in WrappableFields(type).Where(f => r.MemberIds.Contains(f.Name)))
                    texts.Add(WrapField(f, r.Kind == "properties" && r.Mutable && !f.IsReadOnly));
                if (texts.Count == 0) throw new InvalidOperationException("Choose the fields to wrap");
                break;
            case "equality":
                if (type.IsRecord) throw new InvalidOperationException("A record already has equality members");
                texts.AddRange(Equality(type, picked, r.Operators, r.Equatable, self, nullable, isStruct));
                replace.AddRange(ExistingEquality(type, decl));
                if (r.Equatable && !type.AllInterfaces.Any(i => i.Name == "IEquatable" && i.TypeArguments.Length == 1 && SymbolEqualityComparer.Default.Equals(i.TypeArguments[0], type)))
                    addInterface = $"global::System.IEquatable<{self}>";
                break;
            case "formatting":
                var parts = picked.Select(m => $"{{nameof({m.Name})}}: {{{m.Name}}}");
                texts.Add($"public override string ToString() => $\"{(picked.Count == 0 ? type.Name : string.Join(", ", parts))}\";");
                replace.AddRange(Declared(type, decl, m => m is IMethodSymbol { Name: nameof(ToString), Parameters.Length: 0 }));
                break;
            case "overrides":
                var g = SyntaxGenerator.GetGenerator(doc);
                var overridable = Overridable(type, compilation);
                nodes.AddRange(overridable.Where(m => r.MemberIds.Contains(Id(m))).Select(m => Implement(g, m, compilation, overriding: true)));
                if (nodes.Count == 0) throw new InvalidOperationException("Choose the members to override");
                break;
            case "missing":
                var gen = SyntaxGenerator.GetGenerator(doc);
                nodes.AddRange(Missing(type).Where(m => r.MemberIds.Contains(Id(m))).Select(m => Implement(gen, m, compilation, overriding: m.ContainingType.TypeKind != TypeKind.Interface)));
                if (nodes.Count == 0) throw new InvalidOperationException("Nothing is missing");
                break;
            case "dispose":
                if (type.GetMembers("Dispose").OfType<IMethodSymbol>().Any(m => m.Parameters.Length == 0 && !m.IsImplicitlyDeclared))
                    throw new InvalidOperationException($"{type.Name} already has a Dispose method");
                texts.AddRange(Dispose(type, picked, isStruct, nullable));
                if (!IsDisposable(type, compilation)) addInterface = "global::System.IDisposable";
                break;
            default:
                throw new ArgumentException($"Unknown kind '{r.Kind}'");
        }

        var source = await doc.GetTextAsync(ct);
        var eol = source.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        foreach (var t in texts)
        {
            var member = SyntaxFactory.ParseMemberDeclaration(t.Replace("\n", eol), options: decl.SyntaxTree.Options);
            if (member is null || member.ContainsDiagnostics) throw new InvalidOperationException("Kod could not generate valid code for this type");
            nodes.Add(member);
        }

        var root = (await doc.GetSyntaxRootAsync(ct))!;
        var updated = decl.RemoveNodes(replace, SyntaxRemoveOptions.KeepNoTrivia) ?? decl;
        var index = InsertIndex(updated, r.Kind);
        var prepared = nodes.Select((n, i) => Prepare((MemberDeclarationSyntax)n, eol, blankLine: index > 0 || i > 0)).ToList();
        updated = updated.WithMembers(updated.Members.InsertRange(index, prepared));
        if (addInterface is not null) updated = AddBase(updated, addInterface);
        return await FinishAsync(doc.Project.Solution, doc.WithSyntaxRoot(root.ReplaceNode(decl, updated)), ct);
    }

    /// <summary>Adds the usings the annotated names need, shortens them and formats what was generated.</summary>
    internal static async Task<IReadOnlyList<FileEditsDto>> FinishAsync(Solution before, Document doc, CancellationToken ct)
    {
        var eol = before.GetDocument(doc.Id) is { } old ? Eol(await old.GetTextAsync(ct)) : "\n";
        doc = await SimplifyAsync(doc, ct);
        doc = await Formatter.FormatAsync(doc, Formatter.Annotation, cancellationToken: ct);
        doc = await WithEolAsync(doc, eol, ct);
        return await IntelService.DiffAsync(before, doc.Project.Solution, ct);
    }

    /// <summary>Shortens the annotated names first (global usings count), then adds usings for what is still qualified:
    /// ImportAdder alone does not see global usings and would add one only for the simplifier to take it out again.</summary>
    internal static async Task<Document> SimplifyAsync(Document doc, CancellationToken ct)
    {
        doc = await Simplifier.ReduceAsync(doc, Simplifier.Annotation, cancellationToken: ct);
        doc = await ImportAdder.AddImportsAsync(doc, Simplifier.AddImportsAnnotation, cancellationToken: ct);
        return await Simplifier.ReduceAsync(doc, Simplifier.Annotation, cancellationToken: ct);
    }

    internal static string Eol(SourceText text) => text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";

    /// <summary>The formatter writes the platform's line breaks: give the file its own back.</summary>
    internal static async Task<Document> WithEolAsync(Document doc, string eol, CancellationToken ct)
    {
        var text = (await doc.GetTextAsync(ct)).ToString();
        var fixedText = eol == "\n" ? text.Replace("\r\n", "\n") : Regex.Replace(text, "(?<!\r)\n", "\r\n");
        return fixedText == text ? doc : doc.WithText(SourceText.From(fixedText, (await doc.GetTextAsync(ct)).Encoding));
    }

    /// <summary>Marks qualified names for simplification and usings, the member for formatting, and gives it a blank line before.</summary>
    internal static MemberDeclarationSyntax Prepare(MemberDeclarationSyntax member, string eol, bool blankLine)
    {
        member = member.ReplaceNodes(
            member.DescendantNodes().Where(n => n is AliasQualifiedNameSyntax or QualifiedNameSyntax or MemberAccessExpressionSyntax && n.Parent is not (QualifiedNameSyntax or MemberAccessExpressionSyntax)),
            (_, n) => n.WithAdditionalAnnotations(Simplifier.Annotation, Simplifier.AddImportsAnnotation));
        member = member.WithAdditionalAnnotations(Formatter.Annotation).WithTrailingTrivia(SyntaxFactory.EndOfLine(eol));
        return blankLine ? member.WithLeadingTrivia(member.GetLeadingTrivia().Insert(0, SyntaxFactory.EndOfLine(eol))) : member;
    }

    /// <summary>Constructors after the constructors (else the fields), properties after the properties, the rest at the end.</summary>
    private static int InsertIndex(TypeDeclarationSyntax decl, string kind)
    {
        var ms = decl.Members;
        int After(Func<MemberDeclarationSyntax, bool> p) => ms.LastIndexOf(p) + 1;
        return kind switch
        {
            "constructor" => After(m => m is ConstructorDeclarationSyntax) is > 0 and var c ? c : After(m => m is FieldDeclarationSyntax),
            "properties" or "readonlyProperties" => After(m => m is PropertyDeclarationSyntax) is > 0 and var p ? p
                : After(m => m is ConstructorDeclarationSyntax) is > 0 and var c2 ? c2 : After(m => m is FieldDeclarationSyntax),
            _ => ms.Count,
        };
    }

    private static TypeDeclarationSyntax AddBase(TypeDeclarationSyntax decl, string name)
    {
        var bt = SyntaxFactory.SimpleBaseType(SyntaxFactory.ParseTypeName(name)).WithAdditionalAnnotations(Simplifier.Annotation, Simplifier.AddImportsAnnotation);
        if (decl.BaseList is { Types: [.., var lastType] } bl)
        {
            // the line break after the last base type moves after the new one
            var types = bl.Types.Replace(lastType, lastType.WithoutTrailingTrivia());
            var comma = SyntaxFactory.Token(SyntaxKind.CommaToken).WithTrailingTrivia(SyntaxFactory.Space);
            return decl.WithBaseList(bl.WithTypes(SyntaxFactory.SeparatedList(types.Append(bt.WithTrailingTrivia(lastType.GetTrailingTrivia())), types.GetSeparators().Append(comma))));
        }
        // "class C" + " : I" before the line break that follows the name
        var last = decl.TypeParameterList ?? (SyntaxNode?)decl.ParameterList;
        var trailing = last?.GetTrailingTrivia() ?? decl.Identifier.TrailingTrivia;
        var list = SyntaxFactory.BaseList(SyntaxFactory.Token(SyntaxKind.ColonToken).WithLeadingTrivia(SyntaxFactory.Space).WithTrailingTrivia(SyntaxFactory.Space), SyntaxFactory.SingletonSeparatedList<BaseTypeSyntax>(bt))
            .WithTrailingTrivia(trailing);
        decl = last switch
        {
            TypeParameterListSyntax tp => decl.WithTypeParameterList(tp.WithoutTrailingTrivia()),
            ParameterListSyntax pl => decl.WithParameterList(pl.WithoutTrailingTrivia()),
            _ => decl.WithIdentifier(decl.Identifier.WithTrailingTrivia()),
        };
        return decl.WithBaseList(list);
    }

    /// <summary>Declarations of this type (in this part) whose symbol matches: replaced by the generated ones.</summary>
    private static IEnumerable<SyntaxNode> Declared(INamedTypeSymbol type, TypeDeclarationSyntax decl, Func<ISymbol, bool> match) =>
        type.GetMembers().Where(m => !m.IsImplicitlyDeclared && match(m))
            .SelectMany(m => m.DeclaringSyntaxReferences)
            .Where(s => s.SyntaxTree == decl.SyntaxTree && decl.Span.Contains(s.Span))
            .Select(s => s.GetSyntax())
            .Select(n => n is VariableDeclaratorSyntax ? n.Parent!.Parent! : n);

    private static IEnumerable<SyntaxNode> ExistingEquality(INamedTypeSymbol type, TypeDeclarationSyntax decl) =>
        Declared(type, decl, m => m is IMethodSymbol x && (
            x is { Name: nameof(Equals), Parameters.Length: 1 } && !x.IsStatic
            || x is { Name: nameof(GetHashCode), Parameters.Length: 0 }
            || x.MethodKind == MethodKind.UserDefinedOperator && x.Name is "op_Equality" or "op_Inequality" && x.Parameters.All(p => SymbolEqualityComparer.Default.Equals(p.Type.OriginalDefinition, type))));

    // ------------------------------------------------------------------ the members

    private static string Constructor(INamedTypeSymbol type, IReadOnlyList<ISymbol> members, bool nullChecks, Compilation compilation)
    {
        var ps = new List<string>();
        var body = new StringBuilder();
        var names = new HashSet<string>();
        string? baseCall = null;
        // a base class without an accessible parameterless constructor: forward the parameters of its smallest one
        if (type.BaseType is { SpecialType: not SpecialType.System_Object } bt && type.TypeKind == TypeKind.Class
            && !bt.InstanceConstructors.Any(c => c.Parameters.All(p => p.IsOptional || p.IsParams) && compilation.IsSymbolAccessibleWithin(c, type)))
        {
            var bc = bt.InstanceConstructors.Where(c => compilation.IsSymbolAccessibleWithin(c, type)).OrderBy(c => c.Parameters.Length).FirstOrDefault();
            if (bc is not null)
            {
                foreach (var p in bc.Parameters)
                {
                    names.Add(p.Name);
                    ps.Add($"{p.Type.ToDisplayString(Qualified)} {Escape(p.Name)}");
                }
                baseCall = $" : base({string.Join(", ", bc.Parameters.Select(p => Escape(p.Name)))})";
            }
        }
        foreach (var m in members)
        {
            var t = MemberType(m);
            var p = ParameterName(m.Name);
            while (!names.Add(p)) p += "1";
            ps.Add($"{t.ToDisplayString(Qualified)} {p}");
            var target = p.TrimStart('@') == m.Name ? $"this.{m.Name}" : m.Name;
            var check = nullChecks && t.IsReferenceType && t.NullableAnnotation != NullableAnnotation.Annotated ? $" ?? throw new global::System.ArgumentNullException(nameof({p}))" : "";
            body.Append($"    {target} = {p}{check};\n");
        }
        var types = members.Select(m => MemberType(m));
        if (type.InstanceConstructors.Any(c => !c.IsImplicitlyDeclared && c.Parameters.Length == ps.Count && baseCall is null
                && c.Parameters.Select(p => p.Type).SequenceEqual(types, SymbolEqualityComparer.Default)))
            throw new InvalidOperationException("A constructor with these parameters already exists");
        var access = type.IsAbstract ? "protected" : "public";
        return $"{access} {type.Name}({string.Join(", ", ps)}){baseCall}\n{{\n{body}}}";
    }

    private static string Escape(string name) => SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None ? "@" + name : name;

    private static string WrapField(IFieldSymbol f, bool mutable)
    {
        var name = PropertyName(f.Name)!;
        var mods = "public " + (f.IsStatic ? "static " : "");
        var t = f.Type.ToDisplayString(Qualified);
        return mutable
            ? $"{mods}{t} {name}\n{{\n    get => {f.Name};\n    set => {f.Name} = value;\n}}"
            : $"{mods}{t} {name} => {f.Name};";
    }

    /// <summary>== for primitives, strings and enums, Equals for floating point (NaN), EqualityComparer for the rest.</summary>
    private static string Compare(ISymbol m, string other)
    {
        var t = MemberType(m);
        if (t.SpecialType is SpecialType.System_Single or SpecialType.System_Double) return $"{m.Name}.Equals({other}.{m.Name})";
        if (t.TypeKind == TypeKind.Enum || t.SpecialType is >= SpecialType.System_Boolean and <= SpecialType.System_String)
            return $"{m.Name} == {other}.{m.Name}";
        return $"global::System.Collections.Generic.EqualityComparer<{t.ToDisplayString(Qualified)}>.Default.Equals({m.Name}, {other}.{m.Name})";
    }

    private static IEnumerable<string> Equality(INamedTypeSymbol type, IReadOnlyList<ISymbol> members, bool operators, bool equatable, string self, bool nullable, bool isStruct)
    {
        var o = nullable ? "?" : "";
        var q = nullable && !isStruct ? "?" : "";
        var withBase = !isStruct && type.BaseType is { SpecialType: not SpecialType.System_Object } b
                       && b.GetMembers(nameof(Equals)).OfType<IMethodSymbol>().Any(m => m.IsOverride && m.Parameters.Length == 1);
        var conds = members.Select(m => Compare(m, "other")).ToList();
        if (withBase) conds.Insert(0, "base.Equals(other)");
        var all = conds.Count == 0 ? "true" : string.Join(" && ", conds);
        if (all.Length > 80) all = string.Join("\n        && ", conds);
        var access = equatable || isStruct ? "public" : "protected";
        if (isStruct)
        {
            yield return $"{access} bool Equals({self} other) => {all};";
            yield return $"public override bool Equals(object{o} obj) => obj is {self} other && Equals(other);";
        }
        else
        {
            yield return $"{access} bool Equals({self}{q} other)\n{{\n    if (other is null) return false;\n    if (ReferenceEquals(this, other)) return true;\n    return {all};\n}}";
            yield return $"public override bool Equals(object{o} obj)\n{{\n    if (obj is null) return false;\n    if (ReferenceEquals(this, obj)) return true;\n    if (obj.GetType() != GetType()) return false;\n    return Equals(({self})obj);\n}}";
        }
        var hashed = members.Select(m => m.Name).ToList();
        if (withBase) hashed.Insert(0, "base.GetHashCode()");
        if (hashed.Count == 0) yield return "public override int GetHashCode() => 0;";
        else if (hashed.Count == 1 && !withBase && MemberType(members[0]).SpecialType != SpecialType.None) yield return $"public override int GetHashCode() => {hashed[0]}.GetHashCode();";
        else if (hashed.Count <= 8) yield return $"public override int GetHashCode() => global::System.HashCode.Combine({string.Join(", ", hashed)});";
        else yield return $"public override int GetHashCode()\n{{\n    var hashCode = new global::System.HashCode();\n{string.Concat(hashed.Select(h => $"    hashCode.Add({h});\n"))}    return hashCode.ToHashCode();\n}}";
        if (operators)
        {
            var eq = isStruct ? "left.Equals(right)" : "Equals(left, right)";
            yield return $"public static bool operator ==({self}{q} left, {self}{q} right) => {eq};";
            yield return $"public static bool operator !=({self}{q} left, {self}{q} right) => !{eq};";
        }
    }

    private static IEnumerable<string> Dispose(INamedTypeSymbol type, IReadOnlyList<ISymbol> members, bool isStruct, bool nullable)
    {
        var calls = string.Concat(members.Select(m =>
        {
            var t = MemberType(m);
            var maybeNull = t.IsReferenceType && (!nullable || t.NullableAnnotation == NullableAnnotation.Annotated) || t.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T;
            return $"{m.Name}{(maybeNull ? "?" : "")}.Dispose();\n";
        }));
        var baseDispose = type.BaseType?.GetMembers("Dispose").OfType<IMethodSymbol>()
            .FirstOrDefault(m => m.Parameters.Length == 1 && m.Parameters[0].Type.SpecialType == SpecialType.System_Boolean && (m.IsVirtual || m.IsOverride || m.IsAbstract));
        string Indent(string s, int n) => string.Concat(s.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => new string(' ', n) + l + "\n"));
        if (baseDispose is not null)
        {
            yield return $"protected override void Dispose(bool disposing)\n{{\n    if (disposing)\n    {{\n{Indent(calls, 8)}    }}\n    base.Dispose(disposing);\n}}";
            yield break;
        }
        if (isStruct || type.IsSealed)
        {
            yield return $"public void Dispose()\n{{\n{Indent(calls, 4)}}}";
            yield break;
        }
        yield return "public void Dispose()\n{\n    Dispose(true);\n    global::System.GC.SuppressFinalize(this);\n}";
        yield return $"protected virtual void Dispose(bool disposing)\n{{\n    if (disposing)\n    {{\n{Indent(calls, 8)}    }}\n}}";
    }

    /// <summary>An override (calling base, or a stub for an abstract member) or an interface member stub.</summary>
    internal static SyntaxNode Implement(SyntaxGenerator g, ISymbol m, Compilation compilation, bool overriding, bool forceStub = false)
    {
        var stub = forceStub || !overriding || m.IsAbstract;
        var notImplemented = g.ThrowStatement(g.ObjectCreationExpression(g.TypeExpression(compilation.GetTypeByMetadataName("System.NotImplementedException")!)));
        var access = !overriding ? Accessibility.Public
            : m.DeclaredAccessibility == Accessibility.ProtectedOrInternal && !SymbolEqualityComparer.Default.Equals(m.ContainingAssembly, compilation.Assembly) ? Accessibility.Protected
            : m.DeclaredAccessibility;
        SyntaxNode decl;
        switch (m)
        {
            case IMethodSymbol method:
            {
                var name = method.IsGenericMethod ? g.GenericName(method.Name, method.TypeParameters.Select(t => g.IdentifierName(t.Name))) : g.IdentifierName(method.Name);
                var call = g.InvocationExpression(g.MemberAccessExpression(g.BaseExpression(), name),
                    method.Parameters.Select(p => g.Argument(p.RefKind is RefKind.In or RefKind.RefReadOnlyParameter ? RefKind.None : p.RefKind, g.IdentifierName(Escape(p.Name)))));
                SyntaxNode[] body = stub ? [notImplemented] : method.ReturnsVoid ? [g.ExpressionStatement(call)] : [g.ReturnStatement(call)];
                decl = g.MethodDeclaration(method, body);
                if (decl is MethodDeclarationSyntax md) decl = md.WithConstraintClauses(default);
                break;
            }
            case IPropertySymbol prop:
            {
                SyntaxNode Access() => prop.IsIndexer ? g.ElementAccessExpression(g.BaseExpression(), prop.Parameters.Select(p => g.IdentifierName(Escape(p.Name)))) : g.MemberAccessExpression(g.BaseExpression(), prop.Name);
                SyntaxNode[]? get = prop.GetMethod is null ? null : stub ? [notImplemented] : [g.ReturnStatement(Access())];
                SyntaxNode[]? set = prop.SetMethod is null ? null : stub ? [notImplemented] : [g.ExpressionStatement(g.AssignmentStatement(Access(), g.IdentifierName("value")))];
                decl = prop.IsIndexer ? g.IndexerDeclaration(prop, get, set) : g.PropertyDeclaration(prop, get, set);
                break;
            }
            case IEventSymbol ev:
                decl = g.EventDeclaration(ev.Name, g.TypeExpression(ev.Type), access, overriding ? DeclarationModifiers.Override : DeclarationModifiers.None);
                break;
            default:
                throw new InvalidOperationException($"'{m.Name}' cannot be implemented");
        }
        decl = g.WithModifiers(decl, overriding ? DeclarationModifiers.Override : DeclarationModifiers.None);
        decl = g.WithAccessibility(decl, access);
        return WithBodies(decl, notImplemented);
    }

    /// <summary>The generator leaves an abstract member without bodies: give them the stub, and accessors Rider's
    /// expression bodies (get =&gt; base.P;).</summary>
    private static SyntaxNode WithBodies(SyntaxNode decl, SyntaxNode stub)
    {
        var block = SyntaxFactory.Block((StatementSyntax)stub);
        if (decl is MethodDeclarationSyntax { Body: null, ExpressionBody: null } md)
            return md.WithBody(block).WithSemicolonToken(default);
        if (decl is not BasePropertyDeclarationSyntax { AccessorList: { } list } prop) return decl;
        var accessors = list.Accessors.Select(a =>
        {
            var body = a.Body ?? (a.ExpressionBody is null ? block : null);
            if (body is not { Statements: [var only] }) return a;
            ExpressionSyntax? e = only switch
            {
                ReturnStatementSyntax { Expression: { } x } => x,
                ExpressionStatementSyntax x => x.Expression,
                ThrowStatementSyntax { Expression: { } x } => SyntaxFactory.ThrowExpression(x),
                _ => null,
            };
            return e is null ? a.WithBody(body) : a.WithBody(null).WithExpressionBody(SyntaxFactory.ArrowExpressionClause(e)).WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken));
        });
        var updated = list.WithAccessors(SyntaxFactory.List(accessors));
        // get-only: public string Name => ...;
        if (updated.Accessors is [{ Keyword.RawKind: (int)SyntaxKind.GetKeyword, ExpressionBody: { } arrow, AttributeLists.Count: 0, Modifiers.Count: 0 }])
        {
            var semi = SyntaxFactory.Token(SyntaxKind.SemicolonToken);
            return prop switch
            {
                PropertyDeclarationSyntax p => p.WithAccessorList(null).WithExpressionBody(arrow).WithSemicolonToken(semi),
                IndexerDeclarationSyntax i => i.WithAccessorList(null).WithExpressionBody(arrow).WithSemicolonToken(semi),
                _ => prop.WithAccessorList(updated),
            };
        }
        return prop.WithAccessorList(updated);
    }
}
