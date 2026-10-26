using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Text;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Classification;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.QuickInfo;
using Microsoft.CodeAnalysis.Rename;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>C# language features on top of the workspace snapshot: completion, hover, signature help, diagnostics,
/// navigation, find usages, rename, formatting, semantic colouring and outline.</summary>
public sealed class IntelService(WorkspaceService workspace, MetadataViews metadata)
{
    private readonly ConcurrentDictionary<string, (Document Doc, CompletionList List)> completionCache = new();
    private readonly ConcurrentQueue<string> completionOrder = new();

    // ------------------------------------------------------------------ helpers

    private Document Doc(string path, string? text) =>
        workspace.GetDocument(path, text) ?? throw new InvalidOperationException($"{Path.GetFileName(path)} is not a C# document");

    private static int Offset(SourceText text, int line, int column)
    {
        var l = Math.Clamp(line - 1, 0, text.Lines.Count - 1);
        var tl = text.Lines[l];
        return Math.Min(tl.Start + Math.Max(0, column - 1), tl.End);
    }

    public static RangeDto ToRange(SourceText text, TextSpan span)
    {
        var s = text.Lines.GetLinePosition(Math.Min(span.Start, text.Length));
        var e = text.Lines.GetLinePosition(Math.Min(span.End, text.Length));
        return new RangeDto(s.Line + 1, s.Character + 1, e.Line + 1, e.Character + 1);
    }

    public static RangeDto ToRange(FileLinePositionSpan span) =>
        new(span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1, span.EndLinePosition.Line + 1, span.EndLinePosition.Character + 1);

    private static TextSpan ToSpan(SourceText text, RangeDto r)
    {
        var start = Offset(text, r.StartLine, r.StartColumn);
        var end = Offset(text, r.EndLine, r.EndColumn);
        return TextSpan.FromBounds(start, Math.Max(start, end));
    }

    // ------------------------------------------------------------------ completion

    public async Task<CompletionListDto> CompleteAsync(DocRequest r, CancellationToken ct)
    {
        var doc = Doc(r.Path, r.Text);
        var text = await doc.GetTextAsync(ct);
        var pos = Offset(text, r.Line, r.Column);
        var service = CompletionService.GetService(doc);
        if (service is null) return new CompletionListDto("", []);
        var trigger = r.TriggerCharacter is { Length: 1 } ch ? CompletionTrigger.CreateInsertionTrigger(ch[0]) : CompletionTrigger.Invoke;
        var list = await service.GetCompletionsAsync(doc, pos, trigger, cancellationToken: ct);
        var items = list.ItemsList;
        var listId = Guid.NewGuid().ToString("N");
        completionCache[listId] = (doc, list);
        completionOrder.Enqueue(listId);
        while (completionOrder.Count > 4 && completionOrder.TryDequeue(out var old)) completionCache.TryRemove(old, out _);

        var defaultRange = ToRange(text, list.Span);
        var result = new List<CompletionItemDto>(items.Count);
        var complex = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            var insert = item.Properties.TryGetValue("InsertionText", out var ins) ? ins : item.DisplayText;
            var range = defaultRange;
            List<TextEditDto>? extra = null;
            if (item.IsComplexTextEdit && complex++ < 60)
            {
                try
                {
                    var change = await service.GetChangeAsync(doc, item, cancellationToken: ct);
                    var changes = change.TextChanges.IsDefaultOrEmpty ? [change.TextChange] : change.TextChanges;
                    var main = changes.FirstOrDefault(c => c.Span.IntersectsWith(list.Span) || c.Span.End == list.Span.End);
                    if (main.NewText is not null && text.Lines.GetLineFromPosition(main.Span.Start).LineNumber == text.Lines.GetLineFromPosition(pos).LineNumber && main.Span.Start <= pos)
                    {
                        insert = main.NewText;
                        range = ToRange(text, main.Span);
                        extra = changes.Where(c => c != main).Select(c => new TextEditDto(ToRange(text, c.Span), c.NewText ?? "")).ToList();
                    }
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    // keep the plain insertion
                }
            }
            result.Add(new CompletionItemDto(
                i,
                item.DisplayTextPrefix + item.DisplayText + item.DisplayTextSuffix,
                Kinds.FromTags(item.Tags),
                string.IsNullOrEmpty(item.InlineDescription) ? null : item.InlineDescription,
                item.FilterText,
                item.SortText,
                insert,
                range,
                extra is { Count: > 0 } ? extra : null,
                item.Rules.MatchPriority > MatchPriority.Default,
                false));
        }
        return new CompletionListDto(listId, result);
    }

    public async Task<string?> ResolveCompletionAsync(CompletionResolveRequest r, CancellationToken ct)
    {
        if (!completionCache.TryGetValue(r.ListId, out var entry)) return null;
        var items = entry.List.ItemsList;
        if (r.Index < 0 || r.Index >= items.Count) return null;
        var service = CompletionService.GetService(entry.Doc);
        if (service is null) return null;
        var desc = await service.GetDescriptionAsync(entry.Doc, items[r.Index], ct);
        if (desc is null || desc.Text.Length == 0) return null;
        var lines = desc.Text.Split('\n', 2);
        var md = new StringBuilder();
        md.Append("```csharp\n").Append(lines[0].TrimEnd()).Append("\n```");
        if (lines.Length > 1 && lines[1].Trim().Length > 0) md.Append("\n\n").Append(Markdown.Escape(lines[1].Trim()));
        return md.ToString();
    }

    // ------------------------------------------------------------------ hover

    public async Task<HoverDto?> HoverAsync(DocRequest r, CancellationToken ct)
    {
        var doc = Doc(r.Path, r.Text);
        var text = await doc.GetTextAsync(ct);
        var pos = Offset(text, r.Line, r.Column);
        var service = QuickInfoService.GetService(doc);
        if (service is null) return null;
        var info = await service.GetQuickInfoAsync(doc, pos, ct);
        if (info is null || info.Sections.IsDefaultOrEmpty) return null;
        var md = new StringBuilder();
        foreach (var section in info.Sections)
        {
            var body = section.Text.Trim();
            if (body.Length == 0) continue;
            if (md.Length > 0) md.Append("\n\n");
            if (section.Kind == QuickInfoSectionKinds.Description) md.Append("```csharp\n").Append(body).Append("\n```");
            else md.Append(Markdown.Escape(body));
        }
        return md.Length == 0 ? null : new HoverDto(md.ToString(), ToRange(text, info.Span));
    }

    // ------------------------------------------------------------------ signature help

    public async Task<SignatureHelpDto?> SignatureHelpAsync(DocRequest r, CancellationToken ct)
    {
        var doc = Doc(r.Path, r.Text);
        var text = await doc.GetTextAsync(ct);
        var pos = Offset(text, r.Line, r.Column);
        var root = await doc.GetSyntaxRootAsync(ct);
        var model = await doc.GetSemanticModelAsync(ct);
        if (root is null || model is null) return null;

        var token = root.FindToken(Math.Max(0, pos - 1));
        for (var node = token.Parent; node is not null; node = node.Parent)
        {
            BaseArgumentListSyntax? args = node as BaseArgumentListSyntax;
            if (args is null) continue;
            var open = args.ChildTokens().FirstOrDefault();
            var close = args.ChildTokens().LastOrDefault();
            if (pos <= open.SpanStart || (!close.IsMissing && pos > close.SpanStart)) continue;

            var methods = new List<IMethodSymbol>();
            IMethodSymbol? chosen = null;
            switch (args.Parent)
            {
                case InvocationExpressionSyntax inv:
                    methods.AddRange(model.GetMemberGroup(inv.Expression, ct).OfType<IMethodSymbol>());
                    var info = model.GetSymbolInfo(inv, ct);
                    // while typing, overload resolution fails: its best candidate is still the right guess
                    chosen = info.Symbol as IMethodSymbol ?? info.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
                    break;
                case BaseObjectCreationExpressionSyntax creation:
                    if (model.GetTypeInfo(creation, ct).Type is INamedTypeSymbol t)
                        methods.AddRange(t.InstanceConstructors.Where(c => model.IsAccessible(pos, c)));
                    chosen = model.GetSymbolInfo(creation, ct).Symbol as IMethodSymbol;
                    break;
                case ConstructorInitializerSyntax init:
                    var ctor = model.GetEnclosingSymbol(init.SpanStart, ct) as IMethodSymbol;
                    var target = init.IsKind(SyntaxKind.BaseConstructorInitializer) ? ctor?.ContainingType.BaseType : ctor?.ContainingType;
                    if (target is not null) methods.AddRange(target.InstanceConstructors.Where(c => model.IsAccessible(pos, c)));
                    chosen = model.GetSymbolInfo(init, ct).Symbol as IMethodSymbol;
                    break;
                case ElementAccessExpressionSyntax ea:
                    if (model.GetTypeInfo(ea.Expression, ct).Type is { } et)
                        methods.AddRange(et.GetMembers().OfType<IPropertySymbol>().Where(p => p.IsIndexer && p.GetMethod is not null).Select(p => p.GetMethod!));
                    break;
                case PrimaryConstructorBaseTypeSyntax pc:
                    if (model.GetTypeInfo(pc.Type, ct).Type is INamedTypeSymbol bt) methods.AddRange(bt.InstanceConstructors);
                    break;
            }
            if (methods.Count == 0) continue;
            methods = methods.Distinct<IMethodSymbol>(SymbolEqualityComparer.Default).ToList();

            var activeParam = args.Arguments.GetSeparators().Count(s => s.SpanStart < pos);
            var argCount = args.Arguments.Count;
            var active = chosen is not null ? methods.FindIndex(m => SymbolEqualityComparer.Default.Equals(m.OriginalDefinition, chosen.OriginalDefinition)) : -1;
            if (active < 0) active = Math.Max(0, methods.FindIndex(m => m.Parameters.Length >= Math.Max(argCount, activeParam + 1) || m.Parameters.Any(p => p.IsParams)));
            var signatures = methods.Select(m => BuildSignature(m)).ToList();
            var sig = methods[active];
            if (sig.Parameters.Length > 0 && activeParam >= sig.Parameters.Length && sig.Parameters[^1].IsParams) activeParam = sig.Parameters.Length - 1;
            return new SignatureHelpDto(signatures, active, activeParam);
        }
        return null;
    }

    private static SignatureDto BuildSignature(IMethodSymbol m)
    {
        var sb = new StringBuilder();
        var isCtor = m.MethodKind == MethodKind.Constructor;
        var isIndexer = m.AssociatedSymbol is IPropertySymbol { IsIndexer: true };
        if (!isCtor) sb.Append((isIndexer ? ((IPropertySymbol)m.AssociatedSymbol!).Type : m.ReturnType).ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)).Append(' ');
        sb.Append(isCtor || isIndexer ? m.ContainingType.Name : m.Name);
        if (m.TypeParameters.Length > 0) sb.Append('<').Append(string.Join(", ", m.TypeParameters.Select(t => t.Name))).Append('>');
        sb.Append(isIndexer ? '[' : '(');
        var ps = new List<SignatureParameterDto>();
        var docs = DocXml.Parse(m.OriginalDefinition);
        for (var i = 0; i < m.Parameters.Length; i++)
        {
            if (i > 0) sb.Append(", ");
            var p = m.Parameters[i];
            var start = sb.Length;
            sb.Append(p.ToDisplayString(ParamFormat));
            ps.Add(new SignatureParameterDto(start, sb.Length, docs.Params.GetValueOrDefault(p.Name)));
        }
        sb.Append(isIndexer ? ']' : ')');
        return new SignatureDto(sb.ToString(), docs.Summary, ps);
    }

    private static readonly SymbolDisplayFormat ParamFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName
                          | SymbolDisplayParameterOptions.IncludeParamsRefOut | SymbolDisplayParameterOptions.IncludeDefaultValue,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    // ------------------------------------------------------------------ diagnostics

    public async Task<IReadOnlyList<DiagnosticDto>> DiagnosticsAsync(TextRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text);
        if (doc is null) return [];
        var model = await doc.GetSemanticModelAsync(ct);
        var text = await doc.GetTextAsync(ct);
        if (model is null) return [];
        return model.GetDiagnostics(cancellationToken: ct)
            .Where(d => d.Severity != DiagnosticSeverity.Hidden || d.Id is "CS8019")
            .Select(d => ToDto(d, text, doc.FilePath ?? r.Path))
            .ToList();
    }

    /// <summary>Errors and warnings of every project (the Problems panel's "Analyze solution").</summary>
    public async Task<IReadOnlyList<DiagnosticDto>> SolutionDiagnosticsAsync(CancellationToken ct)
    {
        var solution = workspace.CurrentSolution;
        var seen = new HashSet<string>();
        var list = new List<DiagnosticDto>();
        foreach (var project in solution.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct);
            if (compilation is null) continue;
            foreach (var d in compilation.GetDiagnostics(ct))
            {
                if (d.Severity < DiagnosticSeverity.Warning || !d.Location.IsInSource) continue;
                var tree = d.Location.SourceTree!;
                var dto = ToDto(d, await tree.GetTextAsync(ct), tree.FilePath);
                if (seen.Add($"{dto.Path}|{dto.Code}|{dto.Range}|{dto.Message}")) list.Add(dto);
                if (list.Count >= 5000) return list;
            }
        }
        return list;
    }

    private static DiagnosticDto ToDto(Diagnostic d, SourceText text, string path)
    {
        var severity = d.Severity switch
        {
            DiagnosticSeverity.Error => "error",
            DiagnosticSeverity.Warning => "warning",
            DiagnosticSeverity.Info => "info",
            _ => "hint",
        };
        var unnecessary = d.Id == "CS8019" || d.Descriptor.CustomTags.Contains(WellKnownDiagnosticTags.Unnecessary);
        return new DiagnosticDto(severity, d.Id, d.GetMessage(), ToRange(text, d.Location.SourceSpan), unnecessary, path);
    }

    // ------------------------------------------------------------------ navigation

    private async Task<(Document Doc, ISymbol? Symbol, SourceText Text)> SymbolAtAsync(string path, string? textOverride, int line, int column, CancellationToken ct)
    {
        var doc = Doc(path, textOverride);
        var text = await doc.GetTextAsync(ct);
        var pos = Offset(text, line, column);
        var symbol = await SymbolFinder.FindSymbolAtPositionAsync(doc, pos, ct);
        if (symbol is null && pos > 0) symbol = await SymbolFinder.FindSymbolAtPositionAsync(doc, pos - 1, ct);
        if (symbol is IMethodSymbol { ReducedFrom: { } reduced }) symbol = reduced;
        return (doc, symbol, text);
    }

    public async Task<DefinitionDto> DefinitionAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null) return new DefinitionDto([], null);
        var def = symbol.OriginalDefinition;
        var locations = await SourceLocationsAsync(def, ct);
        if (locations.Count > 0) return new DefinitionDto(locations, null);
        // a type or member from a referenced assembly: a generated read-only declaration view
        var compilation = await doc.Project.GetCompilationAsync(ct);
        return new DefinitionDto([], compilation is null ? null : metadata.Build(def, compilation));
    }

    public async Task<IReadOnlyList<LocationDto>> ImplementationsAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null) return [];
        var solution = doc.Project.Solution;
        var found = new List<ISymbol>();
        symbol = symbol.OriginalDefinition;
        if (symbol is INamedTypeSymbol type)
        {
            if (type.TypeKind == TypeKind.Interface)
                found.AddRange(await SymbolFinder.FindImplementationsAsync(type, solution, cancellationToken: ct));
            else
                found.AddRange(await SymbolFinder.FindDerivedClassesAsync(type, solution, cancellationToken: ct));
        }
        else
        {
            found.AddRange(await SymbolFinder.FindImplementationsAsync(symbol, solution, cancellationToken: ct));
            if (symbol.IsVirtual || symbol.IsAbstract || symbol.IsOverride)
                found.AddRange(await SymbolFinder.FindOverridesAsync(symbol, solution, cancellationToken: ct));
        }
        var list = new List<LocationDto>();
        foreach (var s in found.Distinct(SymbolEqualityComparer.Default)) list.AddRange(await SourceLocationsAsync(s!, ct));
        return Dedupe(list);
    }

    public async Task<IReadOnlyList<LocationDto>> ReferencesAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null) return [];
        var solution = doc.Project.Solution;
        var refs = await SymbolFinder.FindReferencesAsync(symbol.OriginalDefinition, solution, ct);
        var list = new List<LocationDto>();
        foreach (var rs in refs)
        {
            foreach (var loc in rs.Definition.Locations.Where(l => l.IsInSource))
                list.Add(await LocationAsync(loc, isDefinition: true, ct));
            foreach (var rl in rs.Locations)
                if (rl.Location.IsInSource) list.Add(await LocationAsync(rl.Location, isDefinition: false, ct));
        }
        return Dedupe(list);
    }

    private static async Task<List<LocationDto>> SourceLocationsAsync(ISymbol symbol, CancellationToken ct)
    {
        var list = new List<LocationDto>();
        foreach (var loc in symbol.Locations.Where(l => l.IsInSource))
            list.Add(await LocationAsync(loc, true, ct));
        return list;
    }

    private static async Task<LocationDto> LocationAsync(Location loc, bool isDefinition, CancellationToken ct)
    {
        var tree = loc.SourceTree!;
        var text = await tree.GetTextAsync(ct);
        var range = ToRange(text, loc.SourceSpan);
        var preview = text.Lines[range.StartLine - 1].ToString().Trim();
        return new LocationDto(tree.FilePath, range, preview.Length > 200 ? preview[..200] : preview, isDefinition);
    }

    private static List<LocationDto> Dedupe(List<LocationDto> list) =>
        list.Where(l => !string.IsNullOrEmpty(l.Path))
            .GroupBy(l => (l.Path.ToLowerInvariant(), l.Range))
            .Select(g => g.OrderByDescending(x => x.IsDefinition).First())
            .OrderBy(l => l.Path, StringComparer.OrdinalIgnoreCase).ThenBy(l => l.Range.StartLine)
            .ToList();

    // ------------------------------------------------------------------ rename

    public async Task<PrepareRenameDto?> PrepareRenameAsync(DocRequest r, CancellationToken ct)
    {
        var (doc, symbol, text) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null || !symbol.Locations.Any(l => l.IsInSource)) return null;
        var root = await doc.GetSyntaxRootAsync(ct);
        var pos = Offset(text, r.Line, r.Column);
        var token = root!.FindToken(pos);
        if (!token.IsKind(SyntaxKind.IdentifierToken) && pos > 0) token = root.FindToken(pos - 1);
        if (!token.IsKind(SyntaxKind.IdentifierToken)) return null;
        return new PrepareRenameDto(ToRange(text, token.Span), token.ValueText);
    }

    public async Task<IReadOnlyList<FileEditsDto>> RenameAsync(RenameRequest r, CancellationToken ct)
    {
        var (doc, symbol, _) = await SymbolAtAsync(r.Path, r.Text, r.Line, r.Column, ct);
        if (symbol is null) throw new InvalidOperationException("Nothing to rename here");
        if (!symbol.Locations.Any(l => l.IsInSource)) throw new InvalidOperationException($"'{symbol.Name}' is defined in a referenced assembly and cannot be renamed");
        if (!SyntaxFacts.IsValidIdentifier(r.NewName.TrimStart('@'))) throw new ArgumentException($"'{r.NewName}' is not a valid identifier");
        var solution = doc.Project.Solution;
        var renamed = await Renamer.RenameSymbolAsync(solution, symbol, new SymbolRenameOptions(), r.NewName, ct);
        return await DiffAsync(solution, renamed, ct);
    }

    /// <summary>Text edits per file between two snapshots (multi-targeted projects share files: one entry per path).</summary>
    public static async Task<IReadOnlyList<FileEditsDto>> DiffAsync(Solution before, Solution after, CancellationToken ct)
    {
        var result = new Dictionary<string, FileEditsDto>(PathUtil.Comparer);
        foreach (var pc in after.GetChanges(before).GetProjectChanges())
        {
            foreach (var id in pc.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            {
                var oldDoc = before.GetDocument(id)!;
                var newDoc = after.GetDocument(id)!;
                if (oldDoc.FilePath is null || result.ContainsKey(oldDoc.FilePath)) continue;
                var oldText = await oldDoc.GetTextAsync(ct);
                var changes = await newDoc.GetTextChangesAsync(oldDoc, ct);
                result[oldDoc.FilePath] = new FileEditsDto(oldDoc.FilePath, changes.Select(c => new TextEditDto(ToRange(oldText, c.Span), c.NewText ?? "")).ToList());
            }
            foreach (var id in pc.GetAddedDocuments())
            {
                var added = after.GetDocument(id)!;
                var path = added.FilePath;
                if (path is null)
                {
                    var dir = Path.GetDirectoryName(pc.NewProject.FilePath);
                    if (dir is null) continue;
                    path = Path.Combine([dir, .. added.Folders, added.Name]);
                }
                if (result.ContainsKey(path)) continue;
                var content = (await added.GetTextAsync(ct)).ToString();
                result[path] = new FileEditsDto(path, [], Created: true, NewText: content);
            }
        }
        return result.Values.ToList();
    }

    // ------------------------------------------------------------------ formatting

    public async Task<IReadOnlyList<TextEditDto>> FormatAsync(RangeRequest r, bool wholeDocument, CancellationToken ct)
    {
        var doc = Doc(r.Path, r.Text);
        var text = await doc.GetTextAsync(ct);
        var formatted = wholeDocument
            ? await Formatter.FormatAsync(doc, cancellationToken: ct)
            : await Formatter.FormatAsync(doc, ToSpan(text, r.Range), cancellationToken: ct);
        var changes = await formatted.GetTextChangesAsync(doc, ct);
        return changes.Select(c => new TextEditDto(ToRange(text, c.Span), c.NewText ?? "")).ToList();
    }

    // ------------------------------------------------------------------ semantic tokens

    public static readonly string[] TokenTypes =
    [
        "namespace", "class", "struct", "interface", "enum", "enumMember", "typeParameter", "delegate", "method",
        "extensionMethod", "property", "field", "event", "constant", "local", "parameter", "label", "keyword",
        "controlKeyword", "string", "number", "comment", "xmlDoc", "preprocessor", "record", "excluded", "operatorOverloaded",
        "stringEscape", "regex", "json",
    ];

    public static readonly string[] TokenModifiers = ["static"];

    private static readonly Dictionary<string, int> TokenIndex = TokenTypes.Select((t, i) => (t, i)).ToDictionary(x => x.t, x => x.i);

    private static string? MapClassification(string c) => c switch
    {
        ClassificationTypeNames.NamespaceName => "namespace",
        ClassificationTypeNames.ClassName => "class",
        ClassificationTypeNames.RecordClassName => "record",
        ClassificationTypeNames.StructName or ClassificationTypeNames.RecordStructName => "struct",
        ClassificationTypeNames.InterfaceName => "interface",
        ClassificationTypeNames.EnumName => "enum",
        ClassificationTypeNames.EnumMemberName => "enumMember",
        ClassificationTypeNames.TypeParameterName => "typeParameter",
        ClassificationTypeNames.DelegateName => "delegate",
        ClassificationTypeNames.MethodName => "method",
        ClassificationTypeNames.ExtensionMethodName => "extensionMethod",
        ClassificationTypeNames.PropertyName => "property",
        ClassificationTypeNames.FieldName => "field",
        ClassificationTypeNames.EventName => "event",
        ClassificationTypeNames.ConstantName => "constant",
        ClassificationTypeNames.LocalName => "local",
        ClassificationTypeNames.ParameterName => "parameter",
        ClassificationTypeNames.LabelName => "label",
        ClassificationTypeNames.Keyword => "keyword",
        ClassificationTypeNames.ControlKeyword => "controlKeyword",
        ClassificationTypeNames.StringLiteral or ClassificationTypeNames.VerbatimStringLiteral => "string",
        ClassificationTypeNames.StringEscapeCharacter => "stringEscape",
        ClassificationTypeNames.NumericLiteral => "number",
        ClassificationTypeNames.Comment => "comment",
        ClassificationTypeNames.PreprocessorKeyword => "preprocessor",
        ClassificationTypeNames.ExcludedCode => "excluded",
        ClassificationTypeNames.OperatorOverloaded => "operatorOverloaded",
        _ when c.StartsWith("xml doc comment", StringComparison.Ordinal) => "xmlDoc",
        _ when c.StartsWith("regex", StringComparison.Ordinal) => "regex",
        _ when c.StartsWith("json", StringComparison.Ordinal) => "json",
        _ => null,
    };

    public async Task<SemanticTokensDto> SemanticTokensAsync(TextRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text);
        if (doc is null) return new SemanticTokensDto([]);
        var text = await doc.GetTextAsync(ct);
        var spans = await Classifier.GetClassifiedSpansAsync(doc, new TextSpan(0, text.Length), ct);

        // Roslyn reports several classifications for one span (e.g. "method name" + "static symbol") and nests some
        // (escapes inside strings): merge equal spans, then cut outer spans around inner ones so nothing overlaps.
        var merged = new List<(TextSpan Span, int Type, int Mods)>();
        foreach (var g in spans.GroupBy(s => s.TextSpan))
        {
            var isStatic = g.Any(s => s.ClassificationType == ClassificationTypeNames.StaticSymbol);
            var type = g.Select(s => MapClassification(s.ClassificationType)).FirstOrDefault(t => t is not null);
            if (type is null) continue;
            merged.Add((g.Key, TokenIndex[type], isStatic ? 1 : 0));
        }
        merged.Sort((a, b) => a.Span.Start != b.Span.Start ? a.Span.Start.CompareTo(b.Span.Start) : b.Span.Length.CompareTo(a.Span.Length));
        var flat = new List<(TextSpan Span, int Type, int Mods)>();
        foreach (var m in merged)
        {
            if (flat.Count > 0 && m.Span.Start < flat[^1].Span.End)
            {
                var outer = flat[^1];
                if (m.Span.End > outer.Span.End) continue; // partial overlap: keep the first
                flat[^1] = (TextSpan.FromBounds(outer.Span.Start, m.Span.Start), outer.Type, outer.Mods);
                flat.Add(m);
                if (m.Span.End < outer.Span.End) flat.Add((TextSpan.FromBounds(m.Span.End, outer.Span.End), outer.Type, outer.Mods));
                continue;
            }
            flat.Add(m);
        }

        var data = new List<int>(flat.Count * 5);
        int prevLine = 0, prevChar = 0;
        foreach (var (span, type, mods) in flat)
        {
            if (span.IsEmpty) continue;
            var start = text.Lines.GetLinePosition(span.Start);
            var end = text.Lines.GetLinePosition(span.End);
            for (var line = start.Line; line <= end.Line; line++)
            {
                var tl = text.Lines[line];
                var from = line == start.Line ? start.Character : 0;
                var to = line == end.Line ? end.Character : tl.End - tl.Start;
                if (to <= from) continue;
                var dl = line - prevLine;
                data.Add(dl);
                data.Add(dl == 0 ? from - prevChar : from);
                data.Add(to - from);
                data.Add(type);
                data.Add(mods);
                prevLine = line;
                prevChar = from;
            }
        }
        return new SemanticTokensDto([.. data]);
    }

    // ------------------------------------------------------------------ symbols

    public async Task<IReadOnlyList<SymbolDto>> DocumentSymbolsAsync(TextRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text);
        if (doc is null) return [];
        var root = await doc.GetSyntaxRootAsync(ct);
        var text = await doc.GetTextAsync(ct);
        return root is null ? [] : Outline.Build(root, text);
    }

    public async Task<IReadOnlyList<WorkspaceSymbolDto>> WorkspaceSymbolsAsync(string query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query)) return [];
        var solution = workspace.CurrentSolution;
        var found = await SymbolFinder.FindSourceDeclarationsWithPatternAsync(solution, query.Trim(), SymbolFilter.TypeAndMember, ct);
        var list = new List<WorkspaceSymbolDto>();
        var seen = new HashSet<string>();
        foreach (var s in found)
        {
            var loc = s.Locations.FirstOrDefault(l => l.IsInSource);
            if (loc is null) continue;
            var span = loc.GetLineSpan();
            if (!seen.Add($"{span.Path}|{span.StartLinePosition}")) continue;
            var container = s.ContainingType?.ToDisplayString() ?? (s.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : null);
            list.Add(new WorkspaceSymbolDto(s.Name, container, Kinds.FromSymbol(s), span.Path, ToRange(span)));
            if (list.Count >= 300) break;
        }
        return list.OrderBy(x => x.Name.Length).ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }
}
