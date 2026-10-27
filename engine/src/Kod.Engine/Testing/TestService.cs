using System.Collections.Concurrent;
using System.Xml.Linq;
using Kod.Engine.Infrastructure;
using Kod.Engine.Processes;
using Kod.Engine.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Kod.Engine.Testing;

public sealed record TestCaseDto(string Id, string Name, string ClassName, string Namespace, string Path, int Line, string Framework);

public sealed record TestProjectDto(string Name, string ProjectPath, IReadOnlyList<TestCaseDto> Tests);

/// <param name="Coverage">Collect code coverage (coverlet when the test projects reference coverlet.collector, else Microsoft Code Coverage) as Cobertura.</param>
public sealed record TestRunRequest(string? ProjectPath, IReadOnlyList<string>? Tests, bool Coverage = false);

public sealed record TestRunDto(string RunId, string ProcId, IReadOnlyList<string> Projects);

public sealed record TestResultDto(string Id, string DisplayName, string Outcome, double DurationMs, string? Message, string? StackTrace, string? Output);

/// <summary>
/// The test explorer's back end. Discovery reads the test projects with Roslyn (xUnit, NUnit, MSTest attributes), so
/// every test has a file and line without building. Runs go through <c>dotnet test</c> with a TRX logger; the results
/// are read from the TRX files once the process exits.
/// </summary>
public sealed class TestService(WorkspaceService workspace, ProcessService processes)
{
    private static readonly Dictionary<string, string> Attributes = new(StringComparer.Ordinal)
    {
        ["Fact"] = "xUnit", ["Theory"] = "xUnit", ["SkippableFact"] = "xUnit", ["SkippableTheory"] = "xUnit",
        ["Test"] = "NUnit", ["TestCase"] = "NUnit", ["TestCaseSource"] = "NUnit",
        ["TestMethod"] = "MSTest", ["DataTestMethod"] = "MSTest",
    };

    private readonly ConcurrentDictionary<string, (string Dir, IReadOnlyList<string> Projects)> runs = new();

    public async Task<IReadOnlyList<TestProjectDto>> DiscoverAsync(CancellationToken ct)
    {
        var solution = workspace.CurrentSolution;
        var result = new List<TestProjectDto>();
        var testProjects = workspace.GetState().Projects.Where(p => p.Kind == "test").ToList();
        foreach (var tp in testProjects)
        {
            var project = solution.Projects.FirstOrDefault(p => PathUtil.Equal(p.FilePath, tp.Path));
            if (project is null) continue;
            var compilation = await project.GetCompilationAsync(ct);
            if (compilation is null) continue;
            var tests = new List<TestCaseDto>();
            foreach (var tree in compilation.SyntaxTrees)
            {
                if (tree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)) continue;
                var root = await tree.GetRootAsync(ct);
                SemanticModel? model = null;
                foreach (var m in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
                {
                    var framework = m.AttributeLists.SelectMany(a => a.Attributes).Select(a => Attributes.GetValueOrDefault(AttrName(a))).FirstOrDefault(f => f is not null);
                    if (framework is null) continue;
                    model ??= compilation.GetSemanticModel(tree);
                    if (model.GetDeclaredSymbol(m, ct) is not IMethodSymbol sym) continue;
                    var type = sym.ContainingType;
                    var ns = type.ContainingNamespace is { IsGlobalNamespace: false } n ? n.ToDisplayString() : "";
                    var className = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat).Replace("global::", "");
                    var line = m.Identifier.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                    tests.Add(new TestCaseDto($"{className}.{sym.Name}", sym.Name, className, ns, tree.FilePath, line, framework));
                }
            }
            result.Add(new TestProjectDto(tp.Name, tp.Path, tests.DistinctBy(t => t.Id).OrderBy(t => t.ClassName).ThenBy(t => t.Line).ToList()));
        }
        return result;
    }

    private static string AttrName(AttributeSyntax a)
    {
        var name = a.Name switch
        {
            QualifiedNameSyntax q => q.Right.Identifier.ValueText,
            AliasQualifiedNameSyntax al => al.Name.Identifier.ValueText,
            SimpleNameSyntax s => s.Identifier.ValueText,
            _ => a.Name.ToString(),
        };
        return name.EndsWith("Attribute", StringComparison.Ordinal) ? name[..^9] : name;
    }

    /// <summary>Starts <c>dotnet test</c> for one project (or every test project) with an optional test filter.</summary>
    public TestRunDto Run(TestRunRequest req)
    {
        var all = workspace.GetState().Projects.Where(p => p.Kind == "test").Select(p => p.Path).ToList();
        if (req.ProjectPath is not null) req = req with { ProjectPath = PathUtil.Normalize(req.ProjectPath) };
        var target = req.ProjectPath ?? workspace.Target ?? (all.Count == 1 ? all[0] : null);
        if (target is null)
        {
            if (all.Count == 0) throw new InvalidOperationException("There are no test projects in this workspace");
            target = all[0];
        }
        var runId = Guid.NewGuid().ToString("N")[..12];
        var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "kod-tests", runId);
        Directory.CreateDirectory(dir);
        var args = new List<string> { "test", target, "-nologo", "--results-directory", dir, "--logger", "trx", "--logger", "console;verbosity=normal" };
        var projects = req.ProjectPath is not null || target.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) ? new[] { target } : all.ToArray();
        if (req.Coverage)
        {
            args.Add("--collect");
            args.Add(projects.All(UsesCoverlet) ? "XPlat Code Coverage" : "Code Coverage;Format=cobertura");
        }
        if (req.Tests is { Count: > 0 })
        {
            // FullyQualifiedName~X also matches theory rows and NUnit test cases of that method
            args.Add("--filter");
            args.Add(string.Join('|', req.Tests.Select(t => $"FullyQualifiedName~{Escape(t)}")));
        }
        var title = req.Tests is { Count: 1 } ? $"Test {req.Tests[0].Split('.').Last()}" : $"Test {System.IO.Path.GetFileNameWithoutExtension(target)}";
        if (req.Coverage) title += " with coverage";
        var proc = processes.Start(new StartRequest("test", title, "dotnet", args, System.IO.Path.GetDirectoryName(target)));
        runs[runId] = (dir, projects);
        return new TestRunDto(runId, proc.Id, projects);
    }

    private static bool UsesCoverlet(string project)
    {
        try
        {
            return File.ReadAllText(project).Contains("coverlet.collector", StringComparison.OrdinalIgnoreCase);
        }
        catch (IOException)
        {
            return false;
        }
    }

    /// <summary>The coverage of a run (every Cobertura report it wrote, merged), or null when it collected none.</summary>
    public CoverageDto? Coverage(string runId)
    {
        if (!runs.TryGetValue(runId, out var run)) throw new InvalidOperationException("Unknown test run");
        if (!Directory.Exists(run.Dir)) return null;
        // coverlet writes each report twice (the attachment and a copy under In/<machine>): read each content once
        var reports = Directory.EnumerateFiles(run.Dir, "*.cobertura.xml", SearchOption.AllDirectories)
            .DistinctBy(f => (new FileInfo(f).Length, File.ReadAllText(f).GetHashCode()))
            .ToList();
        return reports.Count == 0 ? null : CoverageReader.Read(reports);
    }

    private static string Escape(string s) => s.Replace("(", "\\(").Replace(")", "\\)").Replace("|", "\\|").Replace("&", "\\&").Replace("!", "\\!");

    public IReadOnlyList<TestResultDto> Results(string runId)
    {
        if (!runs.TryGetValue(runId, out var run)) throw new InvalidOperationException("Unknown test run");
        var list = new List<TestResultDto>();
        if (!Directory.Exists(run.Dir)) return list;
        foreach (var trx in Directory.EnumerateFiles(run.Dir, "*.trx", SearchOption.AllDirectories)) list.AddRange(ParseTrx(trx));
        return list;
    }

    public static IReadOnlyList<TestResultDto> ParseTrx(string file)
    {
        var doc = XDocument.Load(file);
        XNamespace ns = doc.Root!.Name.Namespace;
        // test id -> ClassName.MethodName (the stable id the explorer uses)
        var defs = doc.Descendants(ns + "UnitTest").ToDictionary(
            u => (string?)u.Attribute("id") ?? "",
            u =>
            {
                if (u.Element(ns + "TestMethod") is not { } tm) return (string?)u.Attribute("name") ?? "";
                var cls = ((string?)tm.Attribute("className") ?? "").Replace('+', '.');
                var name = (string?)tm.Attribute("name") ?? "";
                // some adapters already put the full name in "name"
                return name.StartsWith(cls + ".", StringComparison.Ordinal) ? name : $"{cls}.{name}";
            });
        var list = new List<TestResultDto>();
        foreach (var r in doc.Descendants(ns + "UnitTestResult"))
        {
            var testId = (string?)r.Attribute("testId") ?? "";
            var id = defs.GetValueOrDefault(testId) ?? (string?)r.Attribute("testName") ?? "";
            var paren = id.IndexOf('(');
            if (paren > 0) id = id[..paren];
            // className may carry the assembly-qualified suffix in some adapters
            var comma = id.IndexOf(',');
            if (comma > 0) id = id[..comma];
            var duration = TimeSpan.TryParse((string?)r.Attribute("duration"), out var d) ? d.TotalMilliseconds : 0;
            var output = r.Element(ns + "Output");
            var err = output?.Element(ns + "ErrorInfo");
            list.Add(new TestResultDto(
                id,
                (string?)r.Attribute("testName") ?? id,
                (string?)r.Attribute("outcome") ?? "Unknown",
                duration,
                err?.Element(ns + "Message")?.Value.Trim(),
                err?.Element(ns + "StackTrace")?.Value.Trim(),
                output?.Element(ns + "StdOut")?.Value.Trim()));
        }
        return list;
    }
}
