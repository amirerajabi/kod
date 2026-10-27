using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Intel;

/// <summary>
/// Code inspections beyond the compiler: Roslyn's own IDE analyzers (unused members, redundant casts, simplifications,
/// naming…) from the Features assemblies, plus every analyzer the projects reference (the SDK's CA rules, StyleCop,
/// xunit.analyzers…). Severities follow the projects' .editorconfig.
/// </summary>
public sealed class InspectionService(WorkspaceService workspace, ILogger<InspectionService> log) : ITrimmable
{
    private readonly Lazy<ImmutableArray<DiagnosticAnalyzer>> builtIn = new(() => Discover(log));
    private readonly ConcurrentDictionary<ProjectId, (IReadOnlyList<AnalyzerReference> Refs, ImmutableArray<DiagnosticAnalyzer> Analyzers)> perProject = new();

    public string CacheName => "Analyzer sets";

    public int CacheCount => perProject.Count;

    /// <summary>Forgets projects that left the solution (a reload gives every project a new id); aggressive: all of them.</summary>
    public void Trim(bool aggressive)
    {
        var live = workspace.CurrentSolution.ProjectIds.ToHashSet();
        foreach (var id in perProject.Keys)
            if (aggressive || !live.Contains(id)) perProject.TryRemove(id, out _);
    }

    private static ImmutableArray<DiagnosticAnalyzer> Discover(ILogger log)
    {
        var list = new List<DiagnosticAnalyzer>();
        foreach (var name in new[] { "Microsoft.CodeAnalysis.Features", "Microsoft.CodeAnalysis.CSharp.Features" })
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
                if (t.IsAbstract || t.ContainsGenericParameters || !typeof(DiagnosticAnalyzer).IsAssignableFrom(t)) continue;
                if (t.GetCustomAttribute<DiagnosticAnalyzerAttribute>() is not { } a || !a.Languages.Contains(LanguageNames.CSharp)) continue;
                try
                {
                    if (t.GetConstructor(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, Type.EmptyTypes)?.Invoke(null) is DiagnosticAnalyzer d
                        && !d.SupportedDiagnostics.IsDefaultOrEmpty)
                        list.Add(d);
                }
                catch (Exception ex)
                {
                    log.LogDebug(ex, "Skipping analyzer {Type}", t.FullName);
                }
            }
        }
        log.LogInformation("Inspections: {Count} built-in analyzers", list.Count);
        return [.. list];
    }

    /// <summary>The built-in analyzers plus the project's own analyzer references (one instance per analyzer type).</summary>
    private ImmutableArray<DiagnosticAnalyzer> AnalyzersFor(Project project)
    {
        if (perProject.TryGetValue(project.Id, out var cached) && cached.Refs.SequenceEqual(project.AnalyzerReferences)) return cached.Analyzers;
        var byType = new Dictionary<string, DiagnosticAnalyzer>();
        foreach (var r in project.AnalyzerReferences)
        {
            try
            {
                foreach (var a in r.GetAnalyzers(LanguageNames.CSharp)) byType.TryAdd(a.GetType().FullName!, a);
            }
            catch (Exception ex)
            {
                log.LogDebug(ex, "Analyzer reference {Ref} failed to load", r.Display);
            }
        }
        foreach (var a in builtIn.Value) byType.TryAdd(a.GetType().FullName!, a);
        var analyzers = byType.Values.ToImmutableArray();
        perProject[project.Id] = (project.AnalyzerReferences.ToList(), analyzers);
        return analyzers;
    }

    private CompilationWithAnalyzers? WithAnalyzers(Project project, Compilation compilation)
    {
        var analyzers = AnalyzersFor(project);
        if (analyzers.IsEmpty) return null;
        var options = new CompilationWithAnalyzersOptions(project.AnalyzerOptions, onAnalyzerException: null, concurrentAnalysis: true, logAnalyzerExecutionTime: false, reportSuppressedDiagnostics: false);
        return compilation.WithAnalyzers(analyzers, options);
    }

    /// <summary>Analyzer diagnostics of one document (optionally a span of it); compiler diagnostics are not included.</summary>
    public async Task<IReadOnlyList<Diagnostic>> DocumentAsync(Document doc, TextSpan? span, CancellationToken ct)
    {
        var model = await doc.GetSemanticModelAsync(ct);
        var tree = await doc.GetSyntaxTreeAsync(ct);
        if (model is null || tree is null) return [];
        var cwa = WithAnalyzers(doc.Project, model.Compilation);
        if (cwa is null) return [];
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            var syntax = await cwa.GetAnalyzerSyntaxDiagnosticsAsync(tree, timeout.Token);
            var semantic = await cwa.GetAnalyzerSemanticDiagnosticsAsync(model, span, timeout.Token);
            return syntax.Concat(semantic)
                .Where(d => d.Id != "AD0001" && d.Location.IsInSource && d.Location.SourceTree == tree && (span is null || d.Location.SourceSpan.IntersectsWith(span.Value)))
                .ToList();
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            log.LogDebug("Analyzers timed out on {Path}", doc.FilePath);
            return [];
        }
    }

    /// <summary>Compiler and analyzer diagnostics of every project (Inspect Code).</summary>
    public async Task<IReadOnlyList<(Diagnostic Diagnostic, Project Project)>> SolutionAsync(CancellationToken ct)
    {
        var list = new List<(Diagnostic, Project)>();
        foreach (var project in workspace.CurrentSolution.Projects)
        {
            var compilation = await project.GetCompilationAsync(ct);
            if (compilation is null) continue;
            var cwa = WithAnalyzers(project, compilation);
            var diagnostics = cwa is null ? compilation.GetDiagnostics(ct) : await cwa.GetAllDiagnosticsAsync(ct);
            foreach (var d in diagnostics)
                if (d.Id != "AD0001" && d.Location.IsInSource) list.Add((d, project));
        }
        return list;
    }

    /// <summary>Whether a diagnostic belongs in the editor and the inspection results: hidden ones only when they fade
    /// unnecessary code (unused usings, redundant casts…).</summary>
    public static bool IsVisible(Diagnostic d) =>
        d.Severity != DiagnosticSeverity.Hidden || d.Descriptor.CustomTags.Contains(WellKnownDiagnosticTags.Unnecessary) || d.Id == "CS8019";

    /// <summary>Diagnostics for Fix All: compiler + analyzers, per document.</summary>
    public FixAllContext.DiagnosticProvider FixAllProvider() => new Provider(this);

    private sealed class Provider(InspectionService owner) : FixAllContext.DiagnosticProvider
    {
        public override async Task<IEnumerable<Diagnostic>> GetDocumentDiagnosticsAsync(Document document, CancellationToken ct)
        {
            var model = await document.GetSemanticModelAsync(ct);
            var compiler = model?.GetDiagnostics(cancellationToken: ct) ?? [];
            return [.. compiler, .. await owner.DocumentAsync(document, null, ct)];
        }

        public override Task<IEnumerable<Diagnostic>> GetProjectDiagnosticsAsync(Project project, CancellationToken ct) =>
            Task.FromResult<IEnumerable<Diagnostic>>([]);

        public override async Task<IEnumerable<Diagnostic>> GetAllDiagnosticsAsync(Project project, CancellationToken ct)
        {
            var all = new List<Diagnostic>();
            foreach (var d in project.Documents) all.AddRange(await GetDocumentDiagnosticsAsync(d, ct));
            return all;
        }
    }
}
