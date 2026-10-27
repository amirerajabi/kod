using Kod.Engine.Ai;
using Kod.Engine.Debugging;
using Kod.Engine.Git;
using Kod.Engine.Infrastructure;
using Kod.Engine.Testing;
using Kod.Engine.Intel;
using Kod.Engine.Nuget;
using Kod.Engine.Processes;
using Kod.Engine.Workspace;

namespace Kod.Engine.Endpoints;

public sealed record PathBody(string Path);
public sealed record OpenBody(string Path, List<string>? Unloaded = null);
public sealed record UnloadBody(List<string> Paths, bool Unload);
public sealed record TrimBody(bool Deep = false);
public sealed record WriteBody(string Path, string Text, string? Label = null);
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
public sealed record CommitBody(string Message, List<string>? Paths, bool Amend, List<PartialFileDto>? Partial = null);
public sealed record GitActionBody(string Action);
public sealed record ResolveBody(string Path, string Text);
public sealed record AcceptSideBody(List<string> Paths, string Side);
public sealed record HashBody(string Hash, string? Mode = null, string? Name = null, bool Checkout = false);
public sealed record RebaseBody(string Hash, List<RebaseStepDto> Steps);
public sealed record StashBody(string? Message, bool IncludeUntracked, List<string>? Paths);
public sealed record StashActionBody(string Ref, string Action);
public sealed record ShelveBody(string Name, List<string> Paths, bool Keep);
public sealed record ShelfBody(string Id, bool Remove = true);
public sealed record CheckoutBody(string Name, bool Create);
public sealed record BlameBody(string Path, string? Text);
public sealed record LatestBody(List<string> Ids, bool Prerelease);
public sealed record TermInputBody(string Data);
public sealed record TermResizeBody(int Cols, int Rows);
public sealed record RemoteBody(string Name, string Url, string? OldName);

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
        api.MapPost("/workspace/open", (OpenBody b, WorkspaceService ws) => ws.Open(b.Path, b.Unloaded));
        api.MapPost("/workspace/unload", (UnloadBody b, WorkspaceService ws) => ws.SetUnloaded(b.Paths, b.Unload));

        // ---- HTTP Client (.http files)
        api.MapPost("/http/send", (Kod.Engine.Http.HttpSendRequest r, Kod.Engine.Http.HttpRequestService s, CancellationToken ct) => s.SendAsync(r, ct));
        api.MapGet("/http/endpoints", (string project, Kod.Engine.Http.HttpRequestService s, CancellationToken ct) => s.EndpointsAsync(project, ct));

        // ---- EF Core
        api.MapGet("/ef/projects", (Kod.Engine.Database.EfService s) => s.Projects());
        api.MapPost("/ef/scaffold", (Kod.Engine.Database.EfScaffoldRequest r, Kod.Engine.Database.EfService s) => s.Scaffold(r));

        // ---- memory
        api.MapGet("/memory", (MemoryService m) => m.Stats());
        api.MapPost("/memory/trim", (TrimBody b, MemoryService m) => m.TrimAsync(b.Deep, b.Deep ? "Free memory (deep)" : "Free memory"));
        api.MapPost("/memory/settings", (MemorySettingsDto b, MemoryService m) => m.Configure(b));
        api.MapPost("/workspace/close", (WorkspaceService ws) => { ws.Close(); return Results.NoContent(); });
        api.MapPost("/workspace/reload", (WorkspaceService ws) => { ws.Reload(); return Results.NoContent(); });
        api.MapPost("/workspace/documentClosed", (PathBody b, WorkspaceService ws) => { ws.CloseDocument(b.Path); return Results.NoContent(); });

        // ---- files
        api.MapGet("/fs/list", (string path, bool? showIgnored, FileService fs) => fs.List(path, showIgnored == true));
        api.MapGet("/fs/files", (FileService fs) => fs.AllFiles());
        api.MapGet("/fs/read", (string path, FileService fs) => fs.Read(path));
        api.MapPost("/fs/write", (WriteBody b, FileService fs, WorkspaceService ws) =>
        {
            fs.Write(b.Path, b.Text, string.IsNullOrWhiteSpace(b.Label) ? "Saved" : b.Label);
            if (b.Path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) ws.GetDocument(b.Path, b.Text);
            return Results.NoContent();
        });
        api.MapPost("/fs/create", (CreateBody b, FileService fs) => new { path = fs.Create(b.Path, b.IsDir, b.Text) });
        api.MapPost("/fs/rename", (RenameBody b, FileService fs) => new { path = fs.Rename(b.From, b.To) });
        api.MapPost("/fs/delete", (PathBody b, FileService fs) => { fs.Delete(b.Path); return Results.NoContent(); });
        api.MapPost("/fs/search", (SearchRequest b, FileService fs, CancellationToken ct) => fs.Search(b, ct));
        api.MapGet("/fs/todos", (FileService fs, CancellationToken ct) => fs.Todos(ct));

        // ---- local history
        api.MapGet("/history/list", (string path, LocalHistoryService h) => h.List(path));
        api.MapGet("/history/text", (string path, string id, LocalHistoryService h) => new { text = h.Text(path, id) });
        api.MapGet("/history/under", (string path, LocalHistoryService h) => h.Under(path));
        api.MapGet("/history/changes", (string path, LocalHistoryService h) => h.Changes(path));
        api.MapPost("/history/selection", (HistorySelectionBody b, LocalHistoryService h) => h.ForSelection(b.Path, b.Text, b.StartLine, b.EndLine));
        api.MapPost("/history/projectLabel", (ProjectLabelBody b, LocalHistoryService h, WorkspaceService ws) =>
        {
            var root = b.Root ?? ws.Root ?? throw new InvalidOperationException("Open a folder first");
            h.PutProjectLabel(root, b.Label);
            return Results.NoContent();
        });
        api.MapPost("/history/label", (HistoryLabelBody b, LocalHistoryService h) =>
        {
            h.Record(b.Path, b.Text ?? File.ReadAllText(b.Path), b.Label.Trim().Length > 0 ? b.Label.Trim() : "Label");
            return Results.NoContent();
        });

        // ---- C# intelligence
        var intel = api.MapGroup("/intel");
        intel.MapPost("/completion", (DocRequest r, IntelService s, CancellationToken ct) => s.CompleteAsync(r, ct));
        intel.MapPost("/completion/resolve", async (CompletionResolveRequest r, IntelService s, CancellationToken ct) => await s.ResolveCompletionAsync(r, ct) is { } c ? Results.Ok(c) : Results.NoContent());
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
        intel.MapPost("/inlayHints", (RangeRequest r, IntelService s, CancellationToken ct) => s.InlayHintsAsync(r, ct));
        intel.MapPost("/codeVision", (TextRequest r, IntelService s, CancellationToken ct) => s.CodeVisionEntriesAsync(r, ct));
        intel.MapPost("/codeVision/resolve", async (DocRequest r, IntelService s, CancellationToken ct) => await s.CodeVisionAsync(r, ct) is { } c ? Results.Ok(c) : Results.NoContent());
        intel.MapPost("/postfix", async (DocRequest r, IntelService s, CancellationToken ct) => await s.PostfixAsync(r, ct) is { } p ? Results.Ok(p) : Results.NoContent());
        intel.MapPost("/typeDefinition", (DocRequest r, IntelService s, CancellationToken ct) => s.TypeDefinitionAsync(r, ct));

        // ---- hierarchies and structural navigation
        intel.MapPost("/hierarchy/root", async (DocRequest r, string kind, IntelService s, CancellationToken ct) => await s.HierarchyRootAsync(r, kind, ct) is { } h ? Results.Ok(h) : Results.NoContent());
        intel.MapPost("/hierarchy/children", (HierarchyRequest r, IntelService s, CancellationToken ct) => s.HierarchyChildrenAsync(r, ct));
        intel.MapPost("/symbolDefinition", (SymbolIdRequest r, IntelService s, CancellationToken ct) => s.SymbolDefinitionAsync(r.Id, ct));
        intel.MapPost("/baseSymbols", (DocRequest r, IntelService s, CancellationToken ct) => s.BaseSymbolsAsync(r, ct));
        intel.MapPost("/relatedFiles", (TextRequest r, IntelService s, CancellationToken ct) => s.RelatedFilesAsync(r, ct));

        // ---- refactorings (Refactor This)
        intel.MapPost("/refactor/available", (RangeRequest r, RefactoringService s, CancellationToken ct) => s.AvailableAsync(r, ct));
        intel.MapPost("/refactor/signature", (DocRequest r, RefactoringService s, CancellationToken ct) => s.SignatureAsync(r, ct));
        intel.MapPost("/refactor/changeSignature", (ChangeSignatureRequest r, RefactoringService s, CancellationToken ct) => s.ChangeSignatureAsync(r, ct));
        intel.MapPost("/refactor/safeDelete/check", (DocRequest r, RefactoringService s, CancellationToken ct) => s.SafeDeleteCheckAsync(r, ct));
        intel.MapPost("/refactor/safeDelete", (SafeDeleteRequest r, RefactoringService s, CancellationToken ct) => s.SafeDeleteAsync(r, ct));
        intel.MapPost("/refactor/extractInterface/info", (DocRequest r, RefactoringService s, CancellationToken ct) => s.ExtractInterfaceInfoAsync(r, ct));
        intel.MapPost("/refactor/extractInterface", (ExtractInterfaceRequest r, RefactoringService s, CancellationToken ct) => s.ExtractInterfaceAsync(r, ct));

        // ---- inspections
        intel.MapPost("/analyzerDiagnostics", async (TextRequest r, WorkspaceService ws, InspectionService s, CancellationToken ct) =>
        {
            if (ws.GetDocument(r.Path, r.Text) is not { } doc) return [];
            var text = await doc.GetTextAsync(ct);
            return (await s.DocumentAsync(doc, null, ct)).Where(InspectionService.IsVisible).Select(d => IntelService.ToDto(d, text, doc.FilePath ?? r.Path)).ToList();
        });
        intel.MapGet("/inspect", async (InspectionService s, CodeActionService cas, CancellationToken ct) =>
        {
            var list = new List<InspectionDto>();
            var seen = new HashSet<string>();
            foreach (var (d, _) in await s.SolutionAsync(ct))
            {
                if (!InspectionService.IsVisible(d)) continue;
                var tree = d.Location.SourceTree!;
                var dto = IntelService.ToDto(d, await tree.GetTextAsync(ct), tree.FilePath);
                if (!seen.Add($"{dto.Path}|{dto.Code}|{dto.Range}")) continue;
                list.Add(new InspectionDto(dto.Severity, dto.Code, dto.Message, dto.Range, dto.Path, d.Descriptor.Title.ToString(), d.Descriptor.Category, d.Descriptor.HelpLinkUri is { Length: > 0 } h ? h : null, dto.Unnecessary, cas.CanFixAll(d.Id)));
                if (list.Count >= 20000) break;
            }
            return list;
        });
        intel.MapPost("/fixAll", (FixAllRequest r, CodeActionService s, CancellationToken ct) => s.FixAllAsync(r, ct));
        intel.MapPost("/cleanup", (CleanupRequest r, CodeActionService s, CancellationToken ct) => s.CleanupAsync(r, ct));

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
        debug.MapPost("/visualize", (VisualizeRequest r, DebugService d, CancellationToken ct) => d.VisualizeAsync(r, ct));

        // ---- Git
        var git = api.MapGroup("/git");
        git.MapGet("/status", (GitService g, CancellationToken ct) => g.StatusAsync(ct));
        git.MapGet("/show", (string path, string rev, GitService g, CancellationToken ct) => g.ShowAsync(path, rev, ct));
        git.MapPost("/stage", async (PathsBody b, GitService g, CancellationToken ct) => { await g.StageAsync(b.Paths, ct); return Results.NoContent(); });
        git.MapPost("/unstage", async (PathsBody b, GitService g, CancellationToken ct) => { await g.UnstageAsync(b.Paths, ct); return Results.NoContent(); });
        git.MapPost("/discard", async (PathsBody b, GitService g, CancellationToken ct) => { await g.DiscardAsync(b.Paths, ct); return Results.NoContent(); });
        git.MapPost("/commit", async (CommitBody b, GitService g, CancellationToken ct) => new { hash = await g.CommitAsync(b.Message, b.Paths, b.Amend, b.Partial, ct) });
        git.MapPost("/operation", async (GitActionBody b, GitService g, CancellationToken ct) => new { message = await g.OperationActionAsync(b.Action, ct) });
        git.MapGet("/conflict", (string path, GitService g, CancellationToken ct) => g.ConflictAsync(path, ct));
        git.MapPost("/resolve", async (ResolveBody b, GitService g, CancellationToken ct) => { await g.ResolveAsync(b.Path, b.Text, ct); return Results.NoContent(); });
        git.MapPost("/acceptSide", async (AcceptSideBody b, GitService g, CancellationToken ct) => { await g.AcceptSideAsync(b.Paths, b.Side, ct); return Results.NoContent(); });
        git.MapPost("/cherryPick", async (HashBody b, GitService g, CancellationToken ct) => { await g.CherryPickAsync(b.Hash, ct); return Results.NoContent(); });
        git.MapPost("/revertCommit", async (HashBody b, GitService g, CancellationToken ct) => { await g.RevertCommitAsync(b.Hash, ct); return Results.NoContent(); });
        git.MapPost("/reset", async (HashBody b, GitService g, CancellationToken ct) => { await g.ResetAsync(b.Hash, b.Mode ?? "mixed", ct); return Results.NoContent(); });
        git.MapPost("/checkoutRevision", async (HashBody b, GitService g, CancellationToken ct) => { await g.CheckoutRevisionAsync(b.Hash, ct); return Results.NoContent(); });
        git.MapPost("/branchAt", async (HashBody b, GitService g, CancellationToken ct) => { await g.BranchAtAsync(b.Name ?? "", b.Hash, b.Checkout, ct); return Results.NoContent(); });
        git.MapGet("/rebase/plan", (string hash, GitService g, CancellationToken ct) => g.RebasePlanAsync(hash, ct));
        git.MapPost("/rebase", async (RebaseBody b, GitService g, CancellationToken ct) => new { message = await g.RebaseAsync(b.Hash, b.Steps, ct) });
        git.MapGet("/stashes", (GitService g, CancellationToken ct) => g.StashesAsync(ct));
        git.MapPost("/stash", async (StashBody b, GitService g, CancellationToken ct) => { await g.StashAsync(b.Message, b.IncludeUntracked, b.Paths, ct); return Results.NoContent(); });
        git.MapPost("/stash/action", async (StashActionBody b, GitService g, CancellationToken ct) => { await g.StashActionAsync(b.Ref, b.Action, ct); return Results.NoContent(); });
        git.MapGet("/stash/files", (string @ref, GitService g, CancellationToken ct) => g.StashFilesAsync(@ref, ct));
        git.MapGet("/shelves", (GitService g, CancellationToken ct) => g.ShelvesAsync(ct));
        git.MapPost("/shelve", (ShelveBody b, GitService g, CancellationToken ct) => g.ShelveAsync(b.Name, b.Paths, b.Keep, ct));
        git.MapPost("/unshelve", async (ShelfBody b, GitService g, CancellationToken ct) => { await g.UnshelveAsync(b.Id, b.Remove, ct); return Results.NoContent(); });
        git.MapPost("/shelf/delete", async (ShelfBody b, GitService g, CancellationToken ct) => { await g.DeleteShelfAsync(b.Id, ct); return Results.NoContent(); });
        git.MapGet("/shelf/patch", async (string id, GitService g, CancellationToken ct) => new { text = await g.ShelfPatchAsync(id, ct) });
        git.MapGet("/hunks", (string path, GitService g, CancellationToken ct) => g.HunksAsync(path, ct));
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
        api.MapGet("/tests/coverage/{runId}", (string runId, TestService t) => t.Coverage(runId) is { } c ? Results.Ok(c) : Results.NoContent());

        // ---- terminals (pseudo consoles)
        api.MapGet("/term", (TerminalService t) => t.List());
        api.MapPost("/term/start", (TerminalStartRequest r, TerminalService t, CancellationToken ct) => t.StartAsync(r, ct));
        api.MapPost("/term/{id}/input", async (string id, TermInputBody b, TerminalService t, CancellationToken ct) => { await t.WriteAsync(id, b.Data, ct); return Results.NoContent(); });
        api.MapPost("/term/{id}/resize", (string id, TermResizeBody b, TerminalService t) => { t.Resize(id, b.Cols, b.Rows); return Results.NoContent(); });
        api.MapPost("/term/{id}/kill", (string id, TerminalService t) => { t.Kill(id); return Results.NoContent(); });

        // ---- git remotes
        git.MapGet("/remotes", (GitService g, CancellationToken ct) => g.RemotesAsync(ct));
        git.MapPost("/remotes/add", async (RemoteBody b, GitService g, CancellationToken ct) => { await g.AddRemoteAsync(b.Name, b.Url, ct); return Results.NoContent(); });
        git.MapPost("/remotes/update", async (RemoteBody b, GitService g, CancellationToken ct) => { await g.UpdateRemoteAsync(b.OldName ?? b.Name, b.Name, b.Url, ct); return Results.NoContent(); });
        git.MapPost("/remotes/remove", async (RemoteBody b, GitService g, CancellationToken ct) => { await g.RemoveRemoteAsync(b.Name, ct); return Results.NoContent(); });

        // ---- NuGet
        api.MapGet("/nuget/search", (string q, bool? prerelease, string? source, NugetService n, CancellationToken ct) => n.SearchAsync(q, prerelease == true, source, ct));
        api.MapGet("/nuget/installed", (string project) => NugetService.Installed(project));
        api.MapGet("/nuget/installedAll", (NugetService n) => n.InstalledAll());
        api.MapGet("/nuget/sources", (NugetService n, CancellationToken ct) => n.SourcesAsync(ct));
        api.MapGet("/nuget/versions", (string id, string? source, NugetService n, CancellationToken ct) => n.VersionsAsync(id, source, ct));
        api.MapGet("/nuget/details", (string id, string? version, string? source, NugetService n, CancellationToken ct) => n.DetailsAsync(id, version, source, ct));
        api.MapPost("/nuget/latest", (LatestBody b, NugetService n, CancellationToken ct) => n.LatestAsync(b.Ids, b.Prerelease, ct));

        // ---- Docker (the Services window)
        var dk = api.MapGroup("/docker");
        dk.MapGet("/info", (Kod.Engine.Docker.DockerService d, CancellationToken ct) => d.InfoAsync(ct));
        dk.MapGet("/containers", (Kod.Engine.Docker.DockerService d, CancellationToken ct) => d.ContainersAsync(ct));
        dk.MapGet("/images", (Kod.Engine.Docker.DockerService d, CancellationToken ct) => d.ImagesAsync(ct));
        dk.MapGet("/compose", (Kod.Engine.Docker.DockerService d) => d.ComposeFiles());
        dk.MapGet("/project", (string path, Kod.Engine.Docker.DockerService d) => d.Project(path));

        // ---- databases
        var db = api.MapGroup("/db");
        db.MapPost("/test", (Kod.Engine.Database.DbConnectionDto c, Kod.Engine.Database.DatabaseService d, CancellationToken ct) => d.TestAsync(c, ct));
        db.MapPost("/schema", (Kod.Engine.Database.DbConnectionDto c, Kod.Engine.Database.DatabaseService d, CancellationToken ct) => d.SchemaAsync(c, ct));
        db.MapPost("/query", (Kod.Engine.Database.DbQueryRequest r, Kod.Engine.Database.DatabaseService d, CancellationToken ct) => d.QueryAsync(r, ct));
        db.MapPost("/cancel", (IdBody b, Kod.Engine.Database.DatabaseService d) => { d.Cancel(b.Id); return Results.NoContent(); });
        db.MapGet("/discover", (Kod.Engine.Database.DatabaseService d) => d.Discover());

        // ---- AI assistant (events: ai.delta, ai.thinking, ai.tool, ai.notice, ai.done)
        var ai = api.MapGroup("/ai");
        ai.MapPost("/chat", (AiChatRequest r, AiService a) => { a.Start(r); return Results.NoContent(); });
        ai.MapPost("/stop", (AiSessionBody b, AiService a) => { a.Stop(b.SessionId); return Results.NoContent(); });
        ai.MapPost("/reset", (AiSessionBody b, AiService a) => { a.Reset(b.SessionId); return Results.NoContent(); });
        ai.MapPost("/approve", (AiApproveRequest r, AiService a) => { a.Approve(r); return Results.NoContent(); });
        ai.MapPost("/models", async (AiModelsRequest r, AiService a, CancellationToken ct) =>
        {
            try
            {
                return Results.Ok(await a.ModelsAsync(r.Provider, ct));
            }
            catch (Exception ex) when (ex is AiException or HttpRequestException or Anthropic.Exceptions.AnthropicException)
            {
                return Results.Problem(ex.Message, statusCode: 400);
            }
        });
        ai.MapPost("/inline", async (AiInlineRequest r, AiService a, CancellationToken ct) =>
        {
            try
            {
                return Results.Ok(new { text = await a.CompleteInlineAsync(r, ct) });
            }
            catch (Exception ex) when (ex is AiException or HttpRequestException or Anthropic.Exceptions.AnthropicException)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 400);
            }
        });

        return api;
    }
}

public sealed record AiSessionBody(string SessionId);
