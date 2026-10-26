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

        // ---- NuGet
        api.MapGet("/nuget/search", (string q, bool? prerelease, NugetService n, CancellationToken ct) => n.SearchAsync(q, prerelease == true, ct));
        api.MapGet("/nuget/installed", (string project) => NugetService.Installed(project));

        return api;
    }
}
