using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using Kod.Engine.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>
/// Quick fixes and refactorings (Alt+Enter): Roslyn's own C# code fix and refactoring providers, discovered from the
/// Features assemblies. Quick fixes run for compiler diagnostics in range; refactorings only when the user asks.
/// </summary>
public sealed class CodeActionService(WorkspaceService workspace, ILogger<CodeActionService> log)
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
        var diagnostics = model!.GetDiagnostics(probe, ct).Where(d => d.Location.SourceSpan.IntersectsWith(probe) || d.Location.SourceSpan.Contains(span.Start)).ToList();

        foreach (var diag in diagnostics)
        {
            foreach (var provider in fixes[diag.Id])
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
                foreach (var a in Flatten(found)) result.Add(Store(a, snapshot, "quickfix", result.Count == 0));
            }
        }

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
