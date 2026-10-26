using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using Kod.Engine.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>
/// Quick fixes and refactorings (Alt+Enter): Roslyn's own C# code fix and refactoring providers, discovered from the
/// Features assemblies. Quick fixes run for compiler diagnostics in range; refactorings only when the user asks.
/// </summary>
public sealed class CodeActionService(WorkspaceService workspace, InspectionService inspections, ILogger<CodeActionService> log)
{
    private sealed record Cached(CodeAction Action, Solution Snapshot);

    private readonly ConcurrentDictionary<string, Cached> cache = new();
    private readonly ConcurrentQueue<string> order = new();
    private readonly Lazy<(ILookup<string, CodeFixProvider> Fixes, IReadOnlyList<CodeRefactoringProvider> Refactorings)> providers = new(() => Discover(log));

    private static (ILookup<string, CodeFixProvider>, IReadOnlyList<CodeRefactoringProvider>) Discover(ILogger log)
    {
        var fixes = new List<CodeFixProvider>();
        var refactorings = new List<CodeRefactoringProvider>();
        var names = new[] { "Microsoft.CodeAnalysis.Features", "Microsoft.CodeAnalysis.CSharp.Features", "Microsoft.CodeAnalysis.CSharp.Workspaces", "Microsoft.CodeAnalysis.Workspaces" };
        foreach (var name in names)
        {
            Assembly asm;
            try
            {
                asm = Assembly.Load(name);
            }
            catch
            {
                continue;
            }
            Type[] types;
            try
            {
                types = asm.GetTypes();
            }
            catch (ReflectionTypeLoadException e)
            {
                types = e.Types.Where(t => t is not null).ToArray()!;
            }
            foreach (var t in types)
            {
                if (t.IsAbstract || t.ContainsGenericParameters) continue;
                try
                {
                    if (typeof(CodeFixProvider).IsAssignableFrom(t) && t.GetCustomAttribute<ExportCodeFixProviderAttribute>() is { } fa && fa.Languages.Contains(LanguageNames.CSharp))
                    {
                        if (Create(t) is CodeFixProvider p) fixes.Add(p);
                    }
                    else if (typeof(CodeRefactoringProvider).IsAssignableFrom(t) && t.GetCustomAttribute<ExportCodeRefactoringProviderAttribute>() is { } ra && ra.Languages.Contains(LanguageNames.CSharp))
                    {
                        if (Create(t) is CodeRefactoringProvider p) refactorings.Add(p);
                    }
                }
                catch (Exception ex)
                {
                    log.LogDebug(ex, "Skipping provider {Type}", t.FullName);
                }
            }
        }
        log.LogInformation("Code actions: {Fixes} fix providers, {Refactorings} refactoring providers", fixes.Count, refactorings.Count);
        var lookup = fixes
            .SelectMany(f => SafeIds(f).Select(id => (id, f)))
            .ToLookup(x => x.id, x => x.f);
        return (lookup, refactorings);
    }

    private static object? Create(Type t)
    {
        var ctor = t.GetConstructor(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, Type.EmptyTypes);
        return ctor?.Invoke(null);
    }

    private static ImmutableArray<string> SafeIds(CodeFixProvider p)
    {
        try
        {
            return p.FixableDiagnosticIds;
        }
        catch
        {
            return [];
        }
    }

    public async Task<IReadOnlyList<CodeActionDto>> GetAsync(RangeRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text) ?? throw new InvalidOperationException("Not a C# document");
        var text = await doc.GetTextAsync(ct);
        var span = Span(text, r.Range);
        var model = await doc.GetSemanticModelAsync(ct);
        var (fixes, refactorings) = providers.Value;
        var result = new List<CodeActionDto>();
        var snapshot = doc.Project.Solution;

        // diagnostics on the selection, or on the whole line for a bare cursor
        var line = text.Lines.GetLineFromPosition(span.Start);
        var probe = span.IsEmpty ? TextSpan.FromBounds(line.Start, line.End) : span;
        bool Near(Diagnostic d) => d.Location.SourceSpan.IntersectsWith(probe) || d.Location.SourceSpan.Contains(span.Start);
        var diagnostics = model!.GetDiagnostics(probe, ct).Where(Near).ToList();
        diagnostics.AddRange((await inspections.DocumentAsync(doc, probe, ct)).Where(d => InspectionService.IsVisible(d) && Near(d)));

        var fixAll = new Dictionary<string, (CodeFixProvider Provider, string? Key)>();
        foreach (var diag in diagnostics)
        {
            foreach (var provider in FixesFor(diag.Id))
            {
                var found = await RegisterAsync(provider, doc, diag, ct);
                var flat = Flatten(found).ToList();
                foreach (var a in flat) result.Add(Store(a, snapshot, "quickfix", result.Count == 0));
                if (flat.Count > 0 && !fixAll.ContainsKey(diag.Id) && provider.GetFixAllProvider() is not null) fixAll[diag.Id] = (provider, flat[0].EquivalenceKey);
            }
        }

        // Rider's "Fix in file / solution" and "Disable once with comment"
        foreach (var (id, (provider, key)) in fixAll)
        {
            var scopes = provider.GetFixAllProvider()!.GetSupportedFixAllScopes();
            if (scopes.Contains(FixAllScope.Document))
                result.Add(Store(CodeAction.Create($"Fix all '{id}' in file", c => FixAllOrSameAsync(doc, provider, key, id, FixAllScope.Document, c)), snapshot, "quickfix", false));
            if (scopes.Contains(FixAllScope.Solution))
                result.Add(Store(CodeAction.Create($"Fix all '{id}' in solution", c => FixAllOrSameAsync(doc, provider, key, id, FixAllScope.Solution, c)), snapshot, "quickfix", false));
        }
        foreach (var diag in diagnostics.Where(d => d.Severity is DiagnosticSeverity.Warning or DiagnosticSeverity.Info).DistinctBy(d => d.Id))
            result.Add(Store(Suppression(doc, text, diag), snapshot, "quickfix", false));

        if (r.Invoked)
        {
            foreach (var provider in refactorings)
            {
                var found = new List<CodeAction>();
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(2));
                    var ctx = new CodeRefactoringContext(doc, span, a => { lock (found) found.Add(a); }, timeout.Token);
                    await provider.ComputeRefactoringsAsync(ctx);
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    log.LogDebug(ex, "Refactoring {Provider} failed", provider.GetType().Name);
                }
                foreach (var a in Flatten(found)) result.Add(Store(a, snapshot, "refactor", false));
            }
        }

        return result
            .GroupBy(a => (a.Title, a.Kind))
            .Select(g => g.First())
            .ToList();
    }

    public async Task<IReadOnlyList<FileEditsDto>> ApplyAsync(string id, CancellationToken ct)
    {
        if (!cache.TryGetValue(id, out var cached)) throw new InvalidOperationException("This action is no longer available; try again");
        var ops = await cached.Action.GetOperationsAsync(ct);
        var changed = ops.OfType<ApplyChangesOperation>().FirstOrDefault()?.ChangedSolution;
        if (changed is null) return [];
        return await IntelService.DiffAsync(cached.Snapshot, changed, ct);
    }

    private async Task<List<CodeAction>> RegisterAsync(CodeFixProvider provider, Document doc, Diagnostic diag, CancellationToken ct)
    {
        var found = new List<CodeAction>();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            var ctx = new CodeFixContext(doc, diag, (a, _) => { lock (found) found.Add(a); }, timeout.Token);
            await provider.RegisterCodeFixesAsync(ctx);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            log.LogDebug(ex, "Code fix {Provider} failed", provider.GetType().Name);
        }
        return found;
    }

    /// <summary>Roslyn reports some inspections under one id and fixes them under a hidden companion id.</summary>
    private static readonly Dictionary<string, string> FixAliases = new() { ["IDE0005"] = "RemoveUnnecessaryImportsFixable" };

    private IEnumerable<CodeFixProvider> FixesFor(string id)
    {
        var fixes = providers.Value.Fixes;
        return FixAliases.TryGetValue(id, out var alias) ? fixes[id].Concat(fixes[alias]).Distinct() : fixes[id];
    }

    /// <summary>Whether a diagnostic id has a quick fix that can be applied everywhere at once.</summary>
    public bool CanFixAll(string id) => FixesFor(id).Any(p => p.GetFixAllProvider() is not null);

    private async Task<Solution?> FixAllAsync(Document doc, CodeFixProvider provider, string? key, string id, FixAllScope scope, CancellationToken ct)
    {
        var fap = provider.GetFixAllProvider();
        if (fap is null) return null;
        var ctx = new FixAllContext(doc, provider, scope, key, [id], inspections.FixAllProvider(), ct);
        var action = await fap.GetFixAsync(ctx);
        if (action is null) return null;
        var ops = await action.GetOperationsAsync(ct);
        return ops.OfType<ApplyChangesOperation>().FirstOrDefault()?.ChangedSolution;
    }

    private async Task<Solution> FixAllOrSameAsync(Document doc, CodeFixProvider provider, string? key, string id, FixAllScope scope, CancellationToken ct) =>
        await FixAllAsync(doc, provider, key, id, scope, ct) ?? doc.Project.Solution;

    private async Task<IReadOnlyList<Diagnostic>> AllDiagnosticsAsync(Document doc, CancellationToken ct)
    {
        var model = await doc.GetSemanticModelAsync(ct);
        return [.. model?.GetDiagnostics(cancellationToken: ct) ?? [], .. await inspections.DocumentAsync(doc, null, ct)];
    }

    /// <summary>Fixes every <see cref="FixAllRequest.Code"/> in a file or the whole solution (the Inspections window).</summary>
    public async Task<IReadOnlyList<FileEditsDto>> FixAllAsync(FixAllRequest r, CancellationToken ct)
    {
        var solution = workspace.CurrentSolution;
        var scope = r.Scope == "solution" ? FixAllScope.Solution : FixAllScope.Document;
        IEnumerable<Document> docs = scope == FixAllScope.Solution
            ? solution.Projects.SelectMany(p => p.Documents)
            : [workspace.GetDocument(r.Path ?? throw new ArgumentException("A path is required")) ?? throw new InvalidOperationException("Not a C# document")];
        foreach (var doc in docs)
        {
            var sample = (await AllDiagnosticsAsync(doc, ct)).FirstOrDefault(d => d.Id == r.Code);
            if (sample is null) continue;
            foreach (var provider in FixesFor(r.Code))
            {
                var actions = Flatten(await RegisterAsync(provider, doc, sample, ct)).ToList();
                if (actions.Count == 0) continue;
                var changed = await FixAllAsync(doc, provider, actions[0].EquivalenceKey, r.Code, scope, ct);
                if (changed is not null) return await IntelService.DiffAsync(doc.Project.Solution, changed, ct);
            }
            throw new InvalidOperationException($"'{r.Code}' has no fix that applies everywhere");
        }
        throw new InvalidOperationException($"No '{r.Code}' left to fix");
    }

    /// <summary>Syntax style fixes Code Cleanup applies (in this order), then sorted usings and formatting.</summary>
    private static readonly string[] CleanupIds =
    [
        "IDE0005", "IDE0001", "IDE0002", "IDE0004", "IDE0036", "IDE0090", "IDE0034", "IDE0017", "IDE0018", "IDE0029", "IDE0030",
        "IDE0041", "IDE0054", "IDE0074", "IDE0071", "IDE0075", "IDE0082", "IDE0100",
    ];

    /// <summary>Rider's Code Cleanup (Ctrl+E, C) for one file: redundancies removed, syntax style applied, usings sorted, reformatted.</summary>
    public async Task<IReadOnlyList<FileEditsDto>> CleanupAsync(CleanupRequest r, CancellationToken ct)
    {
        var doc = workspace.GetDocument(r.Path, r.Text) ?? throw new InvalidOperationException("Not a C# document");
        var snapshot = doc.Project.Solution;
        var current = doc;
        var present = (await AllDiagnosticsAsync(doc, ct)).Select(d => d.Id).ToHashSet();
        foreach (var id in CleanupIds.Where(present.Contains))
        {
            var sample = (await AllDiagnosticsAsync(current, ct)).FirstOrDefault(d => d.Id == id);
            if (sample is null) continue;
            foreach (var provider in FixesFor(id))
            {
                var actions = Flatten(await RegisterAsync(provider, current, sample, ct)).ToList();
                if (actions.Count == 0) continue;
                if (await FixAllAsync(current, provider, actions[0].EquivalenceKey, id, FixAllScope.Document, ct) is { } changed && changed.GetDocument(current.Id) is { } next)
                {
                    current = next;
                    break;
                }
            }
        }
        if (await current.GetSyntaxRootAsync(ct) is CompilationUnitSyntax unit && SortUsings(unit) is { } sorted)
            current = current.WithSyntaxRoot(sorted);
        current = await Formatter.FormatAsync(current, cancellationToken: ct);
        return await IntelService.DiffAsync(snapshot, current.Project.Solution, ct);
    }

    /// <summary>System usings first, then the rest alphabetically; static and alias usings after (Rider's default order).</summary>
    private static CompilationUnitSyntax? SortUsings(CompilationUnitSyntax unit)
    {
        var usings = unit.Usings;
        if (usings.Count < 2 || usings.Any(u => u.GetLeadingTrivia().Skip(u == usings[0] ? int.MaxValue : 0).Any(t => t.IsDirective || t.IsKind(SyntaxKind.SingleLineCommentTrivia))))
            return null;
        static int Group(UsingDirectiveSyntax u) => u.GlobalKeyword.IsKind(SyntaxKind.GlobalKeyword) ? 0 : u.Alias is not null ? 3 : u.StaticKeyword.IsKind(SyntaxKind.StaticKeyword) ? 2 : 1;
        static string Name(UsingDirectiveSyntax u) => u.Alias?.Name.ToString() ?? u.NamespaceOrType.ToString();
        static bool IsSystem(string n) => n == "System" || n.StartsWith("System.", StringComparison.Ordinal);
        var ordered = usings
            .OrderBy(Group)
            .ThenBy(u => IsSystem(Name(u)) ? 0 : 1)
            .ThenBy(Name, StringComparer.Ordinal)
            .ToList();
        if (ordered.SequenceEqual(usings)) return null;
        var header = usings[0].GetLeadingTrivia();
        var list = ordered.Select((u, i) => u.WithLeadingTrivia(i == 0 ? header : default)).ToList();
        return unit.WithUsings(SyntaxFactory.List(list));
    }

    /// <summary>#pragma warning disable / restore around the diagnostic's lines.</summary>
    private static CodeAction Suppression(Document doc, SourceText text, Diagnostic diag)
    {
        var span = diag.Location.SourceSpan;
        var first = text.Lines.GetLineFromPosition(span.Start);
        var last = text.Lines.GetLineFromPosition(span.End);
        var indent = first.ToString()[..(first.ToString().Length - first.ToString().TrimStart().Length)];
        var eol = text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var changes = new[]
        {
            new TextChange(new TextSpan(first.Start, 0), $"{indent}#pragma warning disable {diag.Id}{eol}"),
            new TextChange(new TextSpan(last.EndIncludingLineBreak, 0), $"{indent}#pragma warning restore {diag.Id}{eol}"),
        };
        return CodeAction.Create($"Disable '{diag.Id}' here with #pragma", _ => Task.FromResult(doc.WithText(text.WithChanges(changes))));
    }

    private CodeActionDto Store(CodeAction action, Solution snapshot, string kind, bool preferred)
    {
        var id = Guid.NewGuid().ToString("N");
        cache[id] = new Cached(action, snapshot);
        order.Enqueue(id);
        while (order.Count > 500 && order.TryDequeue(out var old)) cache.TryRemove(old, out _);
        return new CodeActionDto(id, action.Title, kind, preferred);
    }

    /// <summary>Nested actions ("Add using" → each namespace) become one entry each, titled "Parent: Child".</summary>
    private static IEnumerable<CodeAction> Flatten(IEnumerable<CodeAction> actions)
    {
        foreach (var a in actions)
        {
            // actions that open an options dialog ("Generate new type...") need host UI Kod does not have
            if (a is CodeActionWithOptions) continue;
            var nested = NestedActions(a);
            if (nested.IsDefaultOrEmpty)
            {
                yield return a;
                continue;
            }
            foreach (var n in Flatten(nested))
                yield return new TitledAction(n, nested.Length == 1 || n.Title.StartsWith(a.Title, StringComparison.Ordinal) ? n.Title : $"{a.Title}: {n.Title}");
        }
    }

    private static readonly PropertyInfo? NestedProperty =
        typeof(CodeAction).GetProperty("NestedActions", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
        ?? typeof(CodeAction).GetProperty("NestedCodeActions", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

    private static ImmutableArray<CodeAction> NestedActions(CodeAction a)
    {
        try
        {
            return NestedProperty?.GetValue(a) is ImmutableArray<CodeAction> arr ? arr : default;
        }
        catch
        {
            return default;
        }
    }

    private static TextSpan Span(SourceText text, RangeDto r)
    {
        int Off(int line, int col)
        {
            var l = text.Lines[Math.Clamp(line - 1, 0, text.Lines.Count - 1)];
            return Math.Min(l.Start + Math.Max(0, col - 1), l.End);
        }
        var s = Off(r.StartLine, r.StartColumn);
        return TextSpan.FromBounds(s, Math.Max(s, Off(r.EndLine, r.EndColumn)));
    }

    /// <summary>A nested action under the title shown in the list.</summary>
    private sealed class TitledAction(CodeAction inner, string title) : CodeAction
    {
        public override string Title => title;
        public override string? EquivalenceKey => inner.EquivalenceKey;
        protected override Task<IEnumerable<CodeActionOperation>> ComputeOperationsAsync(CancellationToken ct) => inner.GetOperationsAsync(ct).ContinueWith(t => (IEnumerable<CodeActionOperation>)t.Result, ct);
    }
}
