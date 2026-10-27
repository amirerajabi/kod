using System.Collections.Concurrent;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Xml.Linq;
using Kod.Engine.Infrastructure;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Kod.Engine.Workspace;

public enum LoadState { None, Loading, Ready, Failed }

public sealed record ProjectDto(string Name, string Path, string? TargetFramework, string Kind, bool Runnable, bool Unloaded = false);

public sealed record WorkspaceStatsDto(int Projects, int Unloaded, int Documents, int Open);

public sealed record WorkspaceStateDto(
    LoadState State, string? Root, string? Target, string? Message,
    IReadOnlyList<ProjectDto> Projects, IReadOnlyList<string> Warnings, string? Branch);

/// <summary>
/// The open folder / solution. Holds an immutable Roslyn <see cref="Solution"/> snapshot that is forked with the live
/// text of open editors (overlays), so IntelliSense always sees what the user typed, saved or not. Files that belong to
/// no project (or a folder without any project) get a one-file "miscellaneous" project referencing the framework.
/// </summary>
public sealed class WorkspaceService : IDisposable
{
    private readonly EventHub hub;
    private readonly LocalHistoryService history;
    private readonly ILogger<WorkspaceService> log;
    private readonly object sync = new();
    private readonly SemaphoreSlim loadGate = new(1, 1);
    private readonly Dictionary<string, string> overlays = new(PathUtil.Comparer);
    private readonly Dictionary<string, ProjectId> miscProjects = new(PathUtil.Comparer);
    /// <summary>Projects the user unloaded (Rider's Unload Project): left out of the solution to save memory.</summary>
    private readonly HashSet<string> unloaded = new(PathUtil.Comparer);
    private readonly AdhocWorkspace adhoc = new(MefHostServices.DefaultHost);
    private readonly ConcurrentQueue<(WatcherChangeTypes Kind, string Path, string? OldPath)> fsEvents = new();
    private readonly Timer fsTimer;
    private readonly Timer reloadTimer;

    private MSBuildWorkspace? msbuild;
    private FileSystemWatcher? watcher;
    private CancellationTokenSource? loadCts;
    private Solution current;
    private int generation;
    private LoadState state = LoadState.None;
    private string? message;
    private List<ProjectDto> projects = [];
    private List<string> warnings = [];

    private static readonly Lazy<IReadOnlyList<MetadataReference>> FrameworkRefs = new(LoadFrameworkReferences);

    private const string ImplicitUsings = """
        global using global::System;
        global using global::System.Collections.Generic;
        global using global::System.IO;
        global using global::System.Linq;
        global using global::System.Net.Http;
        global using global::System.Threading;
        global using global::System.Threading.Tasks;
        """;

    public WorkspaceService(EventHub hub, LocalHistoryService history, ILogger<WorkspaceService> log)
    {
        this.hub = hub;
        this.history = history;
        this.log = log;
        current = adhoc.CurrentSolution;
        fsTimer = new Timer(_ => FlushFsEvents(), null, Timeout.Infinite, Timeout.Infinite);
        reloadTimer = new Timer(_ => Reload(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public string? Root { get; private set; }
    public string? Target { get; private set; }

    public Solution CurrentSolution
    {
        get { lock (sync) return current; }
    }

    public WorkspaceStateDto GetState()
    {
        lock (sync) return new WorkspaceStateDto(state, Root, Target, message, projects, warnings, Root is null ? null : GitBranch(Root));
    }

    private void PublishState() => hub.Publish("workspace.state", GetState());

    // ------------------------------------------------------------------ open / load

    /// <summary>Opens a folder, a .sln/.slnx or a .csproj. Loading runs in the background (workspace.state events).</summary>
    public WorkspaceStateDto Open(string path, IEnumerable<string>? unloadedProjects = null)
    {
        path = PathUtil.Normalize(path);
        string root;
        string? target = null;
        if (File.Exists(path))
        {
            var ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext is not (".sln" or ".slnx" or ".csproj")) throw new ArgumentException("Open a folder, a solution (.sln, .slnx) or a project (.csproj)");
            root = Path.GetDirectoryName(path)!;
            target = path;
        }
        else if (Directory.Exists(path))
        {
            root = path;
        }
        else
        {
            throw new DirectoryNotFoundException($"'{path}' does not exist");
        }

        lock (sync)
        {
            generation++;
            loadCts?.Cancel();
            msbuild?.Dispose();
            msbuild = null;
            watcher?.Dispose();
            overlays.Clear();
            miscProjects.Clear();
            unloaded.Clear();
            foreach (var p in unloadedProjects ?? []) unloaded.Add(PathUtil.Normalize(p));
            current = adhoc.CurrentSolution;
            Root = root;
            Target = target;
            projects = [];
            warnings = [];
            state = LoadState.Loading;
            message = "Opening…";
            loadCts = new CancellationTokenSource();
        }
        StartWatcher(root);
        var gen = generation;
        var ct = loadCts.Token;
        _ = Task.Run(() => LoadAsync(gen, ct));
        PublishState();
        return GetState();
    }

    public void Close()
    {
        lock (sync)
        {
            generation++;
            loadCts?.Cancel();
            msbuild?.Dispose();
            msbuild = null;
            watcher?.Dispose();
            watcher = null;
            overlays.Clear();
            miscProjects.Clear();
            unloaded.Clear();
            current = adhoc.CurrentSolution;
            Root = Target = null;
            projects = [];
            warnings = [];
            state = LoadState.None;
            message = null;
        }
        PublishState();
    }

    /// <summary>Re-reads every project (after a .csproj / solution change, a package install, or on request).</summary>
    public void Reload()
    {
        if (Root is null) return;
        int gen;
        CancellationToken ct;
        lock (sync)
        {
            generation++;
            loadCts?.Cancel();
            loadCts = new CancellationTokenSource();
            gen = generation;
            ct = loadCts.Token;
            state = LoadState.Loading;
            message = "Reloading projects…";
        }
        PublishState();
        _ = Task.Run(() => LoadAsync(gen, ct));
    }

    private async Task LoadAsync(int gen, CancellationToken ct)
    {
        await loadGate.WaitAsync(ct).ConfigureAwait(false);
        MSBuildWorkspace? ws = null;
        try
        {
            var root = Root!;
            var targets = FindTargets(root, Target);
            var failures = new List<string>();
            Solution solution;
            if (targets.Count == 0)
            {
                solution = adhoc.CurrentSolution;
            }
            else
            {
                ws = MSBuildWorkspace.Create(new Dictionary<string, string> { ["Configuration"] = "Debug" });
                ws.SkipUnrecognizedProjects = true;
                ws.RegisterWorkspaceFailedHandler(e =>
                {
                    if (e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure) lock (failures) failures.Add(e.Diagnostic.Message);
                });
                var progress = new Progress<ProjectLoadProgress>(p =>
                {
                    lock (sync)
                    {
                        if (gen != generation) return;
                        message = $"{p.Operation}: {Path.GetFileNameWithoutExtension(p.FilePath)}";
                    }
                    PublishState();
                });
                foreach (var t in targets)
                {
                    ct.ThrowIfCancellationRequested();
                    var ext = Path.GetExtension(t).ToLowerInvariant();
                    if (ext is ".sln" or ".slnx")
                    {
                        try
                        {
                            await ws.OpenSolutionAsync(t, progress: progress, cancellationToken: ct).ConfigureAwait(false);
                        }
                        catch (Exception ex) when (ext == ".slnx" && ex is not OperationCanceledException)
                        {
                            // older MSBuildWorkspace builds do not read .slnx: open its projects one by one
                            foreach (var p in SlnxProjects(t)) await OpenProject(ws, p, progress, ct).ConfigureAwait(false);
                        }
                    }
                    else
                    {
                        await OpenProject(ws, t, progress, ct).ConfigureAwait(false);
                    }
                }
                solution = ws.CurrentSolution;
            }

            var dtos = DescribeProjects(solution);
            lock (sync)
            {
                if (gen != generation)
                {
                    ws?.Dispose();
                    return;
                }
                msbuild?.Dispose();
                msbuild = ws;
                ws = null;
                miscProjects.Clear();
                current = WithoutUnloaded(solution);
                foreach (var (path, text) in overlays) ApplyText(path, text);
                projects = dtos.Select(p => p with { Unloaded = unloaded.Contains(p.Path) }).ToList();
                // a solution found in the folder becomes the build target
                if (Target is null && targets is [var only] && Path.GetExtension(only).StartsWith(".sln", StringComparison.OrdinalIgnoreCase)) Target = only;
                warnings = failures.Distinct().Take(50).ToList();
                state = LoadState.Ready;
                message = targets.Count == 0 ? "No projects: files open as miscellaneous files" : null;
            }
            log.LogInformation("Workspace ready: {Count} projects, {Failures} load warnings", dtos.Count, failures.Count);
        }
        catch (OperationCanceledException)
        {
            ws?.Dispose();
            return;
        }
        catch (Exception ex)
        {
            ws?.Dispose();
            log.LogError(ex, "Workspace load failed");
            lock (sync)
            {
                if (gen != generation) return;
                state = LoadState.Failed;
                message = ex.Message;
                current = adhoc.CurrentSolution;
                miscProjects.Clear();
                foreach (var (path, text) in overlays) ApplyText(path, text);
            }
        }
        finally
        {
            loadGate.Release();
        }
        PublishState();
    }

    private static async Task OpenProject(MSBuildWorkspace ws, string path, IProgress<ProjectLoadProgress> progress, CancellationToken ct)
    {
        if (ws.CurrentSolution.Projects.Any(p => PathUtil.Equal(p.FilePath, path))) return;
        await ws.OpenProjectAsync(path, progress: progress, cancellationToken: ct).ConfigureAwait(false);
    }

    private static List<string> FindTargets(string root, string? explicitTarget)
    {
        if (explicitTarget is not null) return [explicitTarget];
        var slnx = Directory.EnumerateFiles(root, "*.slnx").FirstOrDefault();
        var sln = slnx ?? Directory.EnumerateFiles(root, "*.sln").FirstOrDefault();
        if (sln is not null) return [sln];
        var found = new List<string>();
        Walk(root, 0);
        return found;

        void Walk(string dir, int depth)
        {
            if (depth > 6 || found.Count >= 200) return;
            try
            {
                found.AddRange(Directory.EnumerateFiles(dir, "*.csproj"));
                foreach (var sub in Directory.EnumerateDirectories(dir))
                    if (!PathUtil.IgnoredDirs.Contains(Path.GetFileName(sub))) Walk(sub, depth + 1);
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private static IEnumerable<string> SlnxProjects(string slnx)
    {
        var dir = Path.GetDirectoryName(slnx)!;
        return XDocument.Load(slnx).Descendants("Project")
            .Select(e => (string?)e.Attribute("Path"))
            .Where(p => p is not null && p.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            .Select(p => Path.GetFullPath(Path.Combine(dir, p!)));
    }

    private static List<ProjectDto> DescribeProjects(Solution solution)
    {
        var list = new List<ProjectDto>();
        foreach (var group in solution.Projects.Where(p => p.FilePath is not null).GroupBy(p => p.FilePath!, PathUtil.Comparer))
        {
            var p = group.First();
            var name = p.Name;
            string? tfm = null;
            var paren = name.LastIndexOf('(');
            if (paren > 0 && name.EndsWith(')'))
            {
                tfm = name[(paren + 1)..^1];
                name = name[..paren];
            }
            var refs = p.MetadataReferences.Select(r => Path.GetFileName(r.Display ?? "")).ToList();
            var isTest = refs.Any(r => r.StartsWith("xunit", StringComparison.OrdinalIgnoreCase) || r.StartsWith("nunit", StringComparison.OrdinalIgnoreCase)
                                       || r.StartsWith("Microsoft.VisualStudio.TestPlatform", StringComparison.OrdinalIgnoreCase)
                                       || r.StartsWith("MSTest", StringComparison.OrdinalIgnoreCase)
                                       || r.StartsWith("TUnit", StringComparison.OrdinalIgnoreCase));
            var exe = p.CompilationOptions?.OutputKind is OutputKind.ConsoleApplication or OutputKind.WindowsApplication;
            var sdk = "";
            try
            {
                sdk = (string?)XDocument.Load(group.Key).Root?.Attribute("Sdk") ?? "";
            }
            catch
            {
                // unreadable project file: keep the defaults
            }
            var kind = isTest ? "test" : sdk.Contains(".Web", StringComparison.OrdinalIgnoreCase) || sdk.Contains("Razor", StringComparison.OrdinalIgnoreCase) ? "web" : exe ? "exe" : "library";
            list.Add(new ProjectDto(name, group.Key, tfm, kind, !isTest && (exe || kind == "web")));
        }
        return list.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    // ------------------------------------------------------------------ memory: unloaded projects, fresh snapshots

    /// <summary>
    /// Unloads projects (they leave the solution: no compilation, no analysis, no find usages in them) or loads them
    /// back (which re-reads the projects). Projects that reference an unloaded one get its built assembly instead.
    /// </summary>
    public WorkspaceStateDto SetUnloaded(IReadOnlyList<string> paths, bool unload)
    {
        var changed = false;
        lock (sync)
        {
            foreach (var p in paths.Select(PathUtil.Normalize)) changed |= unload ? unloaded.Add(p) : unloaded.Remove(p);
            if (changed && unload && state == LoadState.Ready)
            {
                current = Fresh(WithoutUnloaded(current));
                projects = projects.Select(p => p with { Unloaded = unloaded.Contains(p.Path) }).ToList();
            }
        }
        if (changed && !unload) Reload();
        else if (changed) PublishState();
        return GetState();
    }

    public IReadOnlyList<string> UnloadedProjects
    {
        get { lock (sync) return [.. unloaded]; }
    }

    private Solution WithoutUnloaded(Solution s)
    {
        if (unloaded.Count == 0) return s;
        var gone = s.Projects.Where(p => p.FilePath is not null && unloaded.Contains(PathUtil.Normalize(p.FilePath))).ToList();
        if (gone.Count == 0) return s;
        var goneIds = gone.Select(p => p.Id).ToHashSet();
        foreach (var p in s.Projects.Where(p => !goneIds.Contains(p.Id)).ToList())
        {
            foreach (var r in p.ProjectReferences.Where(r => goneIds.Contains(r.ProjectId)).ToList())
            {
                s = s.RemoveProjectReference(p.Id, r);
                // the unloaded project's last build stands in for it, so the code using it still resolves
                var target = s.GetProject(r.ProjectId);
                var dll = new[] { target?.OutputRefFilePath, target?.OutputFilePath }.FirstOrDefault(File.Exists);
                if (dll is not null) s = s.AddMetadataReference(p.Id, MetadataReference.CreateFromFile(dll, r.Aliases.IsEmpty ? default : new MetadataReferenceProperties(aliases: r.Aliases)));
            }
        }
        foreach (var p in gone) s = s.RemoveProject(p.Id);
        return s;
    }

    /// <summary>
    /// Drops every compilation, syntax tree and semantic model Roslyn cached for the solution (they are rebuilt on
    /// demand): the same projects and texts, as freshly added projects with nothing computed yet.
    /// </summary>
    public void DropSemanticState()
    {
        lock (sync)
        {
            if (state != LoadState.Ready && state != LoadState.Failed) return;
            current = Fresh(current);
        }
    }

    private static Solution Fresh(Solution s)
    {
        var infos = s.Projects.Select(InfoOf).ToList();
        foreach (var p in s.ProjectIds.ToList()) s = s.RemoveProject(p);
        // references go in once every project is back (they may point either way in the list)
        foreach (var info in infos) s = s.AddProject(info.WithProjectReferences([]));
        foreach (var info in infos.Where(i => i.ProjectReferences.Count > 0)) s = s.WithProjectReferences(info.Id, info.ProjectReferences);
        return s;
    }

    private static ProjectInfo InfoOf(Project p)
    {
        static TextLoader Loader(TextDocument d) =>
            d.TryGetText(out var text) && d.TryGetTextVersion(out var version)
                ? TextLoader.From(TextAndVersion.Create(text, version, d.FilePath))
                : d.FilePath is not null ? new FileTextLoader(d.FilePath, Encoding.UTF8) : TextLoader.From(TextAndVersion.Create(SourceText.From(""), VersionStamp.Create()));
        static DocumentInfo Doc(TextDocument d) =>
            DocumentInfo.Create(d.Id, d.Name, d.Folders, d is Document doc ? doc.SourceCodeKind : SourceCodeKind.Regular, Loader(d), d.FilePath);
        return ProjectInfo.Create(p.Id, p.Version, p.Name, p.AssemblyName, p.Language, p.FilePath, p.OutputFilePath,
                p.CompilationOptions, p.ParseOptions, p.Documents.Select(Doc), p.ProjectReferences, p.MetadataReferences, p.AnalyzerReferences,
                p.AdditionalDocuments.Select(Doc), p.IsSubmission, null, p.OutputRefFilePath)
            .WithAnalyzerConfigDocuments(p.AnalyzerConfigDocuments.Select(Doc))
            .WithDefaultNamespace(p.DefaultNamespace)
            .WithCompilationOutputInfo(p.CompilationOutputInfo);
    }

    public WorkspaceStatsDto Stats()
    {
        lock (sync)
            return new WorkspaceStatsDto(
                projects.Count(p => !p.Unloaded), unloaded.Count(u => projects.Any(p => PathUtil.Equal(p.Path, u))),
                current.Projects.Sum(p => p.DocumentIds.Count), overlays.Count);
    }

    // ------------------------------------------------------------------ documents

    /// <summary>
    /// The document for a file, with the editor's current text applied when <paramref name="text"/> is given.
    /// A C# file outside every project gets its own miscellaneous project.
    /// </summary>
    public Document? GetDocument(string path, string? text = null)
    {
        path = PathUtil.Normalize(path);
        lock (sync)
        {
            if (text is not null) overlays[path] = text;
            var ids = FindDocumentIds(current, path);
            if (ids.Count == 0)
            {
                if (!path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return null;
                var content = text ?? ReadDisk(path);
                if (content is null) return null;
                current = AddMisc(current, path, content);
                ids = FindDocumentIds(current, path);
                if (ids.Count == 0) return null;
            }
            else if (text is not null)
            {
                ApplyText(path, text);
            }
            // prefer a real project over a miscellaneous one, and the first target framework
            return ids.Select(id => current.GetDocument(id)).Where(d => d is not null).First()!;
        }
    }

    /// <summary>The editor closed the file: drop its overlay, go back to what is on disk.</summary>
    public void CloseDocument(string path)
    {
        path = PathUtil.Normalize(path);
        lock (sync)
        {
            if (!overlays.Remove(path)) return;
            if (miscProjects.Remove(path, out var misc))
            {
                current = current.RemoveProject(misc);
                return;
            }
            if (ReadDisk(path) is { } disk) ApplyText(path, disk, keepOverlay: false);
        }
    }

    /// <summary>All open (overlayed) texts, used by rename to touch files that are not open.</summary>
    public bool IsOpen(string path)
    {
        lock (sync) return overlays.ContainsKey(PathUtil.Normalize(path));
    }

    /// <summary>The editor's text of an open file (saved or not), or null when it is not open.</summary>
    public string? OverlayText(string path)
    {
        lock (sync) return overlays.TryGetValue(PathUtil.Normalize(path), out var text) ? text : null;
    }

    private void ApplyText(string path, string text, bool keepOverlay = true)
    {
        var ids = FindDocumentIds(current, path);
        if (ids.Count == 0) return;
        var source = SourceText.From(text, Encoding.UTF8);
        foreach (var id in ids)
        {
            var doc = current.GetDocument(id);
            if (doc is null) continue;
            if (doc.TryGetText(out var existing) && existing.Length == text.Length && existing.ToString() == text) continue;
            current = current.WithDocumentText(id, source, PreservationMode.PreserveIdentity);
        }
        if (!keepOverlay) overlays.Remove(path);
    }

    private static List<DocumentId> FindDocumentIds(Solution s, string path)
    {
        var ids = s.GetDocumentIdsWithFilePath(path);
        if (!ids.IsEmpty) return [.. ids];
        // Roslyn's map may compare case-sensitively; editors can hand us a different drive-letter case.
        return s.Projects.SelectMany(p => p.Documents).Where(d => PathUtil.Equal(d.FilePath, path)).Select(d => d.Id).ToList();
    }

    private Solution AddMisc(Solution s, string path, string text)
    {
        var id = ProjectId.CreateNewId(path);
        var name = Path.GetFileNameWithoutExtension(path);
        var info = ProjectInfo.Create(id, VersionStamp.Create(), name, name, LanguageNames.CSharp,
            compilationOptions: new CSharpCompilationOptions(OutputKind.ConsoleApplication, nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true),
            parseOptions: new CSharpParseOptions(LanguageVersion.Preview),
            metadataReferences: FrameworkRefs.Value);
        s = s.AddProject(info);
        s = s.AddDocument(DocumentId.CreateNewId(id), "GlobalUsings.g.cs", SourceText.From(ImplicitUsings));
        s = s.AddDocument(DocumentId.CreateNewId(id, path), Path.GetFileName(path), SourceText.From(text, Encoding.UTF8), filePath: path);
        miscProjects[path] = id;
        return s;
    }

    private static string? ReadDisk(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>
    /// References for miscellaneous files: the Microsoft.NETCore.App reference pack (it carries the XML docs that hover
    /// and signature help show), or the running shared framework when no SDK pack is installed.
    /// </summary>
    private static IReadOnlyList<MetadataReference> LoadFrameworkReferences()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var dir = RefPackDir(runtimeDir) ?? runtimeDir;
        var list = new List<MetadataReference>();
        foreach (var dll in Directory.EnumerateFiles(dir, "*.dll"))
        {
            try
            {
                using (var fs = File.OpenRead(dll))
                using (var pe = new PEReader(fs))
                    if (!pe.HasMetadata) continue;
                var xml = Path.ChangeExtension(dll, ".xml");
                list.Add(MetadataReference.CreateFromFile(dll, documentation: File.Exists(xml) ? XmlDocumentationProvider.CreateFromFile(xml) : null));
            }
            catch
            {
                // native or locked file
            }
        }
        return list;
    }

    /// <summary>dotnet/shared/Microsoft.NETCore.App/10.0.x → dotnet/packs/Microsoft.NETCore.App.Ref/10.0.y/ref/net10.0.</summary>
    private static string? RefPackDir(string runtimeDir)
    {
        try
        {
            var dotnetRoot = Directory.GetParent(runtimeDir)?.Parent?.Parent?.FullName;
            if (dotnetRoot is null) return null;
            var packs = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
            if (!Directory.Exists(packs)) return null;
            var major = Environment.Version.Major;
            var version = Directory.EnumerateDirectories(packs)
                .Select(d => (Dir: d, Ok: Version.TryParse(Path.GetFileName(d).Split('-')[0], out var v), V: v))
                .Where(x => x.Ok && x.V!.Major == major)
                .OrderByDescending(x => x.V)
                .FirstOrDefault();
            if (version.Dir is null) return null;
            var refDir = Path.Combine(version.Dir, "ref", $"net{major}.0");
            return Directory.Exists(refDir) ? refDir : null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    // ------------------------------------------------------------------ file watching

    private void StartWatcher(string root)
    {
        try
        {
            var w = new FileSystemWatcher(root)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                InternalBufferSize = 64 * 1024,
            };
            w.Created += (_, e) => Queue(WatcherChangeTypes.Created, e.FullPath, null);
            w.Deleted += (_, e) => Queue(WatcherChangeTypes.Deleted, e.FullPath, null);
            w.Changed += (_, e) => Queue(WatcherChangeTypes.Changed, e.FullPath, null);
            w.Renamed += (_, e) => Queue(WatcherChangeTypes.Renamed, e.FullPath, e.OldFullPath);
            w.Error += (_, e) => log.LogWarning(e.GetException(), "File watcher error");
            w.EnableRaisingEvents = true;
            lock (sync) watcher = w;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not watch {Root}", root);
        }
    }

    private void Queue(WatcherChangeTypes kind, string path, string? oldPath)
    {
        var root = Root;
        if (root is null || PathUtil.IsIgnored(path, root)) return;
        fsEvents.Enqueue((kind, path, oldPath));
        fsTimer.Change(250, Timeout.Infinite);
    }

    private void FlushFsEvents()
    {
        var dirs = new HashSet<string>(PathUtil.Comparer);
        var files = new HashSet<string>(PathUtil.Comparer);
        var reload = false;
        while (fsEvents.TryDequeue(out var e))
        {
            var ext = Path.GetExtension(e.Path).ToLowerInvariant();
            if (ext is ".csproj" or ".sln" or ".slnx" or ".props" or ".targets") reload = true;
            if (e.Kind != WatcherChangeTypes.Changed)
            {
                dirs.Add(Path.GetDirectoryName(e.Path) ?? e.Path);
                if (e.OldPath is not null) dirs.Add(Path.GetDirectoryName(e.OldPath) ?? e.OldPath);
            }
            files.Add(e.Path);
            if (ext == ".cs") ApplyFsEvent(e.Kind, e.Path, e.OldPath);
        }
        if (files.Count == 0) return;
        RecordExternal(files);
        hub.Publish("fs.changed", new { dirs, files });
        if (reload && state != LoadState.Loading) reloadTimer.Change(1500, Timeout.Infinite);
    }

    /// <summary>
    /// Local History: a file you edited in Kod that another program changed (git checkout, a formatter, another
    /// editor) gets an "External change" revision; Kod's own saves are already the newest revision, so they add none.
    /// </summary>
    private void RecordExternal(IEnumerable<string> files)
    {
        foreach (var f in files)
        {
            try
            {
                if (!history.Has(f) || !File.Exists(f) || new FileInfo(f).Length > 4 * 1024 * 1024) continue;
                history.Record(f, File.ReadAllText(f), "External change");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // locked or gone: the next change records it
            }
        }
    }

    private void ApplyFsEvent(WatcherChangeTypes kind, string path, string? oldPath)
    {
        lock (sync)
        {
            if (state == LoadState.Loading) return;
            if (kind is WatcherChangeTypes.Deleted or WatcherChangeTypes.Renamed)
            {
                var gone = oldPath ?? path;
                var ids = FindDocumentIds(current, gone);
                if (ids.Count > 0 && !File.Exists(gone)) current = current.RemoveDocuments([.. ids]);
                if (kind == WatcherChangeTypes.Deleted) return;
            }
            if (!File.Exists(path)) return;
            var existing = FindDocumentIds(current, path);
            if (existing.Count > 0)
            {
                if (!overlays.ContainsKey(path) && ReadDisk(path) is { } disk) ApplyText(path, disk, keepOverlay: false);
                return;
            }
            // a new file inside a project folder joins that project (SDK projects glob **/*.cs)
            var owner = current.Projects
                .Where(p => p.FilePath is not null && !miscProjects.ContainsValue(p.Id) && PathUtil.IsUnder(path, Path.GetDirectoryName(p.FilePath)!))
                .OrderByDescending(p => p.FilePath!.Length)
                .FirstOrDefault();
            if (owner is null || ReadDisk(path) is not { } text) return;
            var siblings = current.Projects.Where(p => PathUtil.Equal(p.FilePath, owner.FilePath)).ToList();
            foreach (var p in siblings)
            {
                var proj = current.GetProject(p.Id)!;
                current = proj.AddDocument(Path.GetFileName(path), SourceText.From(text, Encoding.UTF8), filePath: path).Project.Solution;
            }
        }
    }

    // ------------------------------------------------------------------ misc

    private static string? GitBranch(string root)
    {
        try
        {
            for (var dir = new DirectoryInfo(root); dir is not null; dir = dir.Parent)
            {
                var head = Path.Combine(dir.FullName, ".git", "HEAD");
                if (!File.Exists(head)) continue;
                var text = File.ReadAllText(head).Trim();
                return text.StartsWith("ref: refs/heads/", StringComparison.Ordinal) ? text[16..] : text.Length >= 7 ? text[..7] : text;
            }
        }
        catch (IOException)
        {
        }
        return null;
    }

    public void Dispose()
    {
        loadCts?.Cancel();
        watcher?.Dispose();
        msbuild?.Dispose();
        adhoc.Dispose();
        fsTimer.Dispose();
        reloadTimer.Dispose();
    }
}
