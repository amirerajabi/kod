using Kod.Engine.Infrastructure;
using Kod.Engine.Processes;
using Kod.Engine.Workspace;

namespace Kod.Engine.Database;

/// <param name="Provider">The EF Core provider package the project references (SqlServer, Npgsql, Sqlite, MySql…).</param>
/// <param name="Version">The EF Core package version (the Design package is added in the same version).</param>
public sealed record EfProjectDto(string Name, string Path, bool HasDesign, string? Provider, bool Runnable, string? Version);

public sealed record EfScaffoldRequest(
    DbConnectionDto Connection, string Project, string Startup, string Context, string OutputDir, string ContextDir,
    bool DataAnnotations, IReadOnlyList<string>? Tables, bool Force);

/// <summary>
/// The EF Core tool window's back end. The window drives <c>dotnet ef</c> itself (its output shows in the Build window);
/// the engine tells it which projects use EF Core, and starts scaffolding so the connection string never shows in the
/// command line.
/// </summary>
public sealed class EfService(WorkspaceService workspace, ProcessService processes)
{
    private static readonly (string Assembly, string Provider)[] Providers =
    [
        ("Microsoft.EntityFrameworkCore.SqlServer", "SQL Server"),
        ("Npgsql.EntityFrameworkCore.PostgreSQL", "PostgreSQL"),
        ("Microsoft.EntityFrameworkCore.Sqlite", "SQLite"),
        ("Pomelo.EntityFrameworkCore.MySql", "MySQL"),
        ("MySql.EntityFrameworkCore", "MySQL"),
        ("Microsoft.EntityFrameworkCore.Cosmos", "Cosmos DB"),
        ("Microsoft.EntityFrameworkCore.InMemory", "In-memory"),
        ("Oracle.EntityFrameworkCore", "Oracle"),
    ];

    /// <summary>Projects that reference EF Core (its assembly in their references), with the provider and the Design package.</summary>
    public IReadOnlyList<EfProjectDto> Projects()
    {
        var dtos = workspace.GetState().Projects;
        var list = new List<EfProjectDto>();
        foreach (var group in workspace.CurrentSolution.Projects.Where(p => p.FilePath is not null).GroupBy(p => p.FilePath!, PathUtil.Comparer))
        {
            var paths = group.First().MetadataReferences.Select(r => r.Display ?? "").ToList();
            var refs = paths.Select(Path.GetFileNameWithoutExtension).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (!refs.Contains("Microsoft.EntityFrameworkCore")) continue;
            var dto = dtos.FirstOrDefault(d => PathUtil.Equal(d.Path, group.Key));
            list.Add(new EfProjectDto(
                dto?.Name ?? Path.GetFileNameWithoutExtension(group.Key), group.Key, refs.Contains("Microsoft.EntityFrameworkCore.Design") || References(group.Key, "Microsoft.EntityFrameworkCore.Design"),
                Providers.FirstOrDefault(p => refs.Contains(p.Assembly)).Provider, dto?.Runnable ?? false,
                // …/packages/microsoft.entityframeworkcore/9.0.4/lib/…
                paths.Select(p => System.Text.RegularExpressions.Regex.Match(p, @"microsoft\.entityframeworkcore[\\/]([^\\/]+)[\\/]", System.Text.RegularExpressions.RegexOptions.IgnoreCase)).FirstOrDefault(m => m.Success)?.Groups[1].Value));
        }
        return list.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>A package the project file names (Design is build-only: it is not among the compile references).</summary>
    private static bool References(string project, string package)
    {
        try
        {
            return File.ReadAllText(project).Contains($"\"{package}\"", StringComparison.OrdinalIgnoreCase);
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static string ProviderPackage(string kind) => kind switch
    {
        "sqlserver" => "Microsoft.EntityFrameworkCore.SqlServer",
        "postgres" => "Npgsql.EntityFrameworkCore.PostgreSQL",
        "mysql" => "Pomelo.EntityFrameworkCore.MySql",
        "sqlite" => "Microsoft.EntityFrameworkCore.Sqlite",
        _ => throw new ArgumentException($"EF Core cannot scaffold a '{kind}' database"),
    };

    /// <summary>dotnet ef dbcontext scaffold, the connection string masked in the Build window.</summary>
    public ProcDto Scaffold(EfScaffoldRequest r)
    {
        var cs = DatabaseService.ConnectionStringOf(r.Connection);
        var args = new List<string>
        {
            "ef", "dbcontext", "scaffold", cs, ProviderPackage(r.Connection.Kind),
            "--project", r.Project, "--startup-project", r.Startup,
            "--context", r.Context, "--output-dir", r.OutputDir, "--context-dir", r.ContextDir, "--no-onconfiguring",
        };
        if (r.DataAnnotations) args.Add("--data-annotations");
        if (r.Force) args.Add("--force");
        foreach (var t in r.Tables ?? [])
        {
            args.Add("--table");
            args.Add(t);
        }
        return processes.Start(new StartRequest("ef", $"Scaffold {r.Context}", "dotnet", args, Path.GetDirectoryName(r.Project), Mask: [cs]));
    }
}
