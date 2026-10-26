using Kod.Engine.Debugging;
using Kod.Engine.Git;
using Kod.Engine.Testing;
using Kod.Engine.Intel;
using Kod.Engine.Nuget;
using Kod.Engine.Processes;
using Kod.Engine.Workspace;

namespace Kod.Engine.Endpoints;

public sealed record PathBody(string Path);
public sealed record WriteBody(string Path, string Text);
public sealed record CreateBody(string Path, bool IsDir, string? Text);
public sealed record RenameBody(string From, string To);
public sealed record InputBody(string Text);
public sealed record IdBody(string Id);
public sealed record BreakpointsBody(string Path, List<BreakpointDto> Breakpoints);
public sealed record StepBody(string Command);
public sealed record FrameBody(int FrameId);
public sealed record VariablesBody(int Reference);
public sealed record EvaluateBody(string Expression, int? FrameId, string? Context);
public sealed record PathsBody(List<string> Paths);
public sealed record CommitBody(string Message, List<string>? Paths, bool Amend);
public sealed record CheckoutBody(string Name, bool Create);
public sealed record BlameBody(string Path, string? Text);
public sealed record LatestBody(List<string> Ids, bool Prerelease);

public static class Endpoints
{
    public static RouteGroupBuilder MapKod(this RouteGroupBuilder api)
    {
        api.MapGet("/meta", () => new
        {
            version = typeof(Endpoints).Assembly.GetName().Version?.ToString(3),
            os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux",
            shell = OperatingSystem.IsWindows() ? Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe" : File.Exists("/bin/zsh") ? "/bin/zsh" : "/bin/bash",
            home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            runtime = Environment.Version.ToString(),
            tokenTypes = IntelService.TokenTypes,
            tokenModifiers = IntelService.TokenModifiers,
        });

        // ---- workspace
        api.MapGet("/workspace", (WorkspaceService ws) => ws.GetState());
        api.MapPost("/workspace/open", (PathBody b, WorkspaceService ws) => ws.Open(b.Path));
        api.MapPost("/workspace/close", (WorkspaceService ws) => { ws.Close(); return Results.NoContent(); });
        api.MapPost("/workspace/reload", (WorkspaceService ws) => { ws.Reload(); return Results.NoContent(); });
        api.MapPost("/workspace/documentClosed", (PathBody b, WorkspaceService ws) => { ws.CloseDocument(b.Path); return Results.NoContent(); });

        // ---- files
        api.MapGet("/fs/list", (string path, bool? showIgnored, FileService fs) => fs.List(path, showIgnored == true));
        api.MapGet("/fs/files", (FileService fs) => fs.AllFiles());
        api.MapGet("/fs/read", (string path, FileService fs) => fs.Read(path));
        api.MapPost("/fs/write", (WriteBody b, FileService fs, WorkspaceService ws) =>
        {
            fs.Write(b.Path, b.Text);
            if (b.Path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) ws.GetDocument(b.Path, b.Text);
            return Results.NoContent();
        });
        api.MapPost("/fs/create", (CreateBody b, FileService fs) => new { path = fs.Create(b.Path, b.IsDir, b.Text) });
        api.MapPost("/fs/rename", (RenameBody b, FileService fs) => new { path = fs.Rename(b.From, b.To) });
        api.MapPost("/fs/delete", (PathBody b, FileService fs) => { fs.Delete(b.Path); return Results.NoContent(); });
        api.MapPost("/fs/search", (SearchRequest b, FileService fs, CancellationToken ct) => fs.Search(b, ct));

        // ---- C# intelligence
        var intel = api.MapGroup("/intel");
        intel.MapPost("/completion", (DocRequest r, IntelService s, CancellationToken ct) => s.CompleteAsync(r, ct));
        intel.MapPost("/completion/resolve", async (CompletionResolveRequest r, IntelService s, CancellationToken ct) => new { documentation = await s.ResolveCompletionAsync(r, ct) });
        intel.MapPost("/hover", async (DocRequest r, IntelService s, CancellationToken ct) => await s.HoverAsync(r, ct) is { } h ? Results.Ok(h) : Results.NoContent());
        intel.MapPost("/signature", async (DocRequest r, IntelService s, CancellationToken ct) => await s.SignatureHelpAsync(r, ct) is { } h ? Results.Ok(h) : Results.NoContent());
        intel.MapPost("/diagnostics", (TextRequest r, IntelService s, CancellationToken ct) => s.DiagnosticsAsync(r, ct));
        intel.MapGet("/solutionDiagnostics", (IntelService s, CancellationToken ct) => s.SolutionDiagnosticsAsync(ct));
        intel.MapPost("/definition", (DocRequest r, IntelService s, CancellationToken ct) => s.DefinitionAsync(r, ct));
        intel.MapPost("/implementations", (DocRequest r, IntelService s, CancellationToken ct) => s.ImplementationsAsync(r, ct));
        intel.MapPost("/references", (DocRequest r, IntelService s, CancellationToken ct) => s.ReferencesAsync(r, ct));
        intel.MapPost("/prepareRename", async (DocRequest r, IntelService s, CancellationToken ct) => await s.PrepareRenameAsync(r, ct) is { } p ? Results.Ok(p) : Results.NoContent());
        intel.MapPost("/rename", (RenameRequest r, IntelService s, CancellationToken ct) => s.RenameAsync(r, ct));
        intel.MapPost("/format", (RangeRequest r, IntelService s, CancellationToken ct) => s.FormatAsync(r, wholeDocument: true, ct));
        intel.MapPost("/formatRange", (RangeRequest r, IntelService s, CancellationToken ct) => s.FormatAsync(r, wholeDocument: false, ct));
        intel.MapPost("/semanticTokens", (TextRequest r, IntelService s, CancellationToken ct) => s.SemanticTokensAsync(r, ct));
        intel.MapPost("/symbols", (TextRequest r, IntelService s, CancellationToken ct) => s.DocumentSymbolsAsync(r, ct));
        intel.MapGet("/workspaceSymbols", (string q, IntelService s, CancellationToken ct) => s.WorkspaceSymbolsAsync(q, ct));
        intel.MapPost("/codeActions", (RangeRequest r, CodeActionService s, CancellationToken ct) => s.GetAsync(r, ct));
        intel.MapPost("/codeActions/apply", (IdBody b, CodeActionService s, CancellationToken ct) => s.ApplyAsync(b.Id, ct));

        // ---- processes (build, run, test, terminal)
        api.MapGet("/proc", (ProcessService p) => p.List());
        api.MapPost("/proc/start", (StartRequest r, ProcessService p) => p.Start(r));
        api.MapPost("/proc/{id}/input", (string id, InputBody b, ProcessService p) => { p.WriteInput(id, b.Text); return Results.NoContent(); });
        api.MapPost("/proc/{id}/stop", (string id, ProcessService p) => { p.Stop(id); return Results.NoContent(); });

        // ---- debugger (netcoredbg over DAP)
        var debug = api.MapGroup("/debug");
        debug.MapGet("/adapter", (DebugAdapter a) => a.Describe());
        debug.MapPost("/adapter/install", (DebugAdapter a, CancellationToken ct) => a.InstallAsync(ct));
        debug.MapGet("/state", (DebugService d) => d.State());
        debug.MapPost("/start", (DebugStartRequest r, DebugService d, CancellationToken ct) => d.StartAsync(r, ct));
        debug.MapPost("/stop", (DebugService d) => { d.Stop(); return Results.NoContent(); });
        debug.MapPost("/breakpoints", (BreakpointsBody b, DebugService d, CancellationToken ct) => d.SetBreakpointsAsync(b.Path, b.Breakpoints, ct));
        debug.MapPost("/step", async (StepBody b, DebugService d, CancellationToken ct) => { await d.StepAsync(b.Command, ct); return Results.NoContent(); });
        debug.MapPost("/scopes", (FrameBody b, DebugService d, CancellationToken ct) => d.ScopesAsync(b.FrameId, ct));
        debug.MapPost("/variables", (VariablesBody b, DebugService d, CancellationToken ct) => d.VariablesAsync(b.Reference, ct));
        debug.MapPost("/evaluate", (EvaluateBody b, DebugService d, CancellationToken ct) => d.EvaluateAsync(b.Expression, b.FrameId, b.Context ?? "repl", ct));

        // ---- Git
        var git = api.MapGroup("/git");
        git.MapGet("/status", (GitService g, CancellationToken ct) => g.StatusAsync(ct));
        git.MapGet("/show", (string path, string rev, GitService g, CancellationToken ct) => g.ShowAsync(path, rev, ct));
        git.MapPost("/stage", async (PathsBody b, GitService g, CancellationToken ct) => { await g.StageAsync(b.Paths, ct); return Results.NoContent(); });
        git.MapPost("/unstage", async (PathsBody b, GitService g, CancellationToken ct) => { await g.UnstageAsync(b.Paths, ct); return Results.NoContent(); });
        git.MapPost("/discard", async (PathsBody b, GitService g, CancellationToken ct) => { await g.DiscardAsync(b.Paths, ct); return Results.NoContent(); });
        git.MapPost("/commit", async (CommitBody b, GitService g, CancellationToken ct) => new { hash = await g.CommitAsync(b.Message, b.Paths, b.Amend, ct) });
        git.MapGet("/lastMessage", async (GitService g, CancellationToken ct) => new { message = await g.LastMessageAsync(ct) });
        git.MapGet("/branches", (GitService g, CancellationToken ct) => g.BranchesAsync(ct));
        git.MapPost("/checkout", async (CheckoutBody b, GitService g, CancellationToken ct) => { await g.CheckoutAsync(b.Name, b.Create, ct); return Results.NoContent(); });
        git.MapPost("/deleteBranch", async (CheckoutBody b, GitService g, CancellationToken ct) => { await g.DeleteBranchAsync(b.Name, b.Create, ct); return Results.NoContent(); });
        git.MapGet("/log", (string? path, bool? all, int? max, GitService g, CancellationToken ct) => g.LogAsync(path, all ?? true, max ?? 300, ct));
        git.MapGet("/commit", (string hash, GitService g, CancellationToken ct) => g.CommitDetailAsync(hash, ct));
        git.MapPost("/blame", (BlameBody b, GitService g, CancellationToken ct) => g.BlameAsync(b.Path, b.Text, ct));
        git.MapPost("/init", async (GitService g, CancellationToken ct) => { await g.InitAsync(ct); return Results.NoContent(); });

        // ---- tests
        api.MapGet("/tests/discover", (TestService t, CancellationToken ct) => t.DiscoverAsync(ct));
        api.MapPost("/tests/run", (TestRunRequest r, TestService t) => t.Run(r));
        api.MapGet("/tests/results/{runId}", (string runId, TestService t) => t.Results(runId));

        // ---- NuGet
        api.MapGet("/nuget/search", (string q, bool? prerelease, string? source, NugetService n, CancellationToken ct) => n.SearchAsync(q, prerelease == true, source, ct));
        api.MapGet("/nuget/installed", (string project) => NugetService.Installed(project));
        api.MapGet("/nuget/installedAll", (NugetService n) => n.InstalledAll());
        api.MapGet("/nuget/sources", (NugetService n, CancellationToken ct) => n.SourcesAsync(ct));
        api.MapGet("/nuget/versions", (string id, string? source, NugetService n, CancellationToken ct) => n.VersionsAsync(id, source, ct));
        api.MapGet("/nuget/details", (string id, string? version, string? source, NugetService n, CancellationToken ct) => n.DetailsAsync(id, version, source, ct));
        api.MapPost("/nuget/latest", (LatestBody b, NugetService n, CancellationToken ct) => n.LatestAsync(b.Ids, b.Prerelease, ct));

        return api;
    }
}
