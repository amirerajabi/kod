using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kod.Engine.Debugging;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;

namespace Kod.Engine.Docker;

public sealed record DockerInfoDto(bool Installed, bool Running, string? Version, string? ServerArch, string? Error);

public sealed record DockerContainerDto(string Id, string Name, string Image, string State, string Status, string Ports, string? ComposeProject, string? ComposeService, string? ComposeFile);

public sealed record DockerImageDto(string Id, string Repository, string Tag, string Size, string Created);

public sealed record ComposeFileDto(string Path, string Project, IReadOnlyList<string> Services);

public sealed record DockerProjectDto(string Project, string? Dockerfile, string? Context, IReadOnlyList<int> Ports, bool HasBaseStage, string ImageName);

/// <summary>
/// Docker through the docker CLI (Docker Desktop, Podman's docker shim…): containers, images and Compose services for
/// the Services window, a project's Dockerfile for Run in Docker, and Rider's "fast mode" container for debugging:
/// the Dockerfile's base stage with the host build mounted and a Linux netcoredbg inside.
/// </summary>
public sealed class DockerService(WorkspaceService workspace, DebugAdapter adapter, ILogger<DockerService> log)
{
    private sealed record Result(int Code, string Out, string Err);

    private static async Task<Result> RunAsync(IEnumerable<string> args, CancellationToken ct, string? cwd = null, int timeoutMs = 20_000)
    {
        var psi = new ProcessStartInfo("docker")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (cwd is not null) psi.WorkingDirectory = cwd;
        foreach (var a in args) psi.ArgumentList.Add(a);
        Process p;
        try
        {
            p = Process.Start(psi) ?? throw new InvalidOperationException("docker could not start");
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new InvalidOperationException("The docker CLI is not installed (or not on PATH)");
        }
        using (p)
        {
            var o = p.StandardOutput.ReadToEndAsync(ct);
            var e = p.StandardError.ReadToEndAsync(ct);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeoutMs);
            try
            {
                await p.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                try
                {
                    p.Kill(true);
                }
                catch
                {
                }
                throw new TimeoutException("docker did not answer in time (is the Docker engine running?)");
            }
            return new Result(p.ExitCode, await o, await e);
        }
    }

    private static async Task<string> RunOkAsync(IEnumerable<string> args, CancellationToken ct, string? cwd = null, int timeoutMs = 20_000)
    {
        var r = await RunAsync(args, ct, cwd, timeoutMs);
        if (r.Code != 0) throw new InvalidOperationException(r.Err.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? $"docker exited with {r.Code}");
        return r.Out;
    }

    // ------------------------------------------------------------------ status and lists

    public async Task<DockerInfoDto> InfoAsync(CancellationToken ct)
    {
        try
        {
            var r = await RunAsync(["version", "--format", "{{json .}}"], ct, timeoutMs: 10_000);
            string? version = null, arch = null;
            try
            {
                var start = r.Out.IndexOf('{');
                if (start >= 0)
                {
                    using var doc = JsonDocument.Parse(r.Out[start..]);
                    if (doc.RootElement.TryGetProperty("Client", out var c) && c.ValueKind == JsonValueKind.Object) version = c.GetProperty("Version").GetString();
                    if (doc.RootElement.TryGetProperty("Server", out var s) && s.ValueKind == JsonValueKind.Object) arch = s.GetProperty("Arch").GetString();
                }
            }
            catch (JsonException)
            {
            }
            var error = r.Code == 0 ? null : r.Err.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0);
            return new DockerInfoDto(true, r.Code == 0 && arch is not null, version, arch, error is null ? null : "The Docker engine is not running. Start Docker Desktop (or your Docker daemon).");
        }
        catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
        {
            return new DockerInfoDto(!ex.Message.Contains("not installed"), false, null, null, ex.Message);
        }
    }

    private static IEnumerable<JsonElement> JsonLines(string text)
    {
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            JsonElement el;
            try
            {
                using var doc = JsonDocument.Parse(line);
                el = doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                continue;
            }
            yield return el;
        }
    }

    private static string Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) ? v.ToString() : "";

    public async Task<IReadOnlyList<DockerContainerDto>> ContainersAsync(CancellationToken ct)
    {
        var raw = await RunOkAsync(["ps", "-a", "--no-trunc", "--format", "{{json .}}"], ct);
        return JsonLines(raw).Select(j =>
        {
            var labels = Str(j, "Labels").Split(',').Select(l => l.Split('=', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0], p => p[1]);
            return new DockerContainerDto(
                Str(j, "ID")[..Math.Min(12, Str(j, "ID").Length)], Str(j, "Names"), Str(j, "Image"), Str(j, "State"), Str(j, "Status"), Str(j, "Ports"),
                labels.GetValueOrDefault("com.docker.compose.project"), labels.GetValueOrDefault("com.docker.compose.service"),
                labels.GetValueOrDefault("com.docker.compose.project.config_files"));
        }).ToList();
    }

    public async Task<IReadOnlyList<DockerImageDto>> ImagesAsync(CancellationToken ct)
    {
        var raw = await RunOkAsync(["images", "--format", "{{json .}}"], ct);
        return JsonLines(raw).Select(j => new DockerImageDto(Str(j, "ID"), Str(j, "Repository"), Str(j, "Tag"), Str(j, "Size"), Str(j, "CreatedSince"))).ToList();
    }

    private static readonly Regex ComposeName = new(@"^(docker-)?compose(\.[\w-]+)?\.ya?ml$", RegexOptions.IgnoreCase);

    /// <summary>Compose files in the workspace and their services (read from the YAML; no daemon needed).</summary>
    public IReadOnlyList<ComposeFileDto> ComposeFiles()
    {
        var root = workspace.Root;
        if (root is null) return [];
        var list = new List<ComposeFileDto>();
        foreach (var file in Directory.EnumerateFiles(root, "*.y*ml", SearchOption.AllDirectories))
        {
            if (!ComposeName.IsMatch(Path.GetFileName(file))) continue;
            if (file.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(PathUtil.IgnoredDirs.Contains)) continue;
            try
            {
                list.Add(new ComposeFileDto(file, Regex.Replace(Path.GetFileName(Path.GetDirectoryName(file)!).ToLowerInvariant(), "[^a-z0-9_-]", ""), ServicesOf(File.ReadAllLines(file))));
            }
            catch (IOException)
            {
            }
        }
        return list;
    }

    /// <summary>The keys under the top-level "services:" mapping.</summary>
    private static IReadOnlyList<string> ServicesOf(string[] lines)
    {
        var services = new List<string>();
        var inServices = false;
        int? indent = null;
        foreach (var raw in lines)
        {
            var line = raw.TrimEnd();
            if (line.Length == 0 || line.TrimStart().StartsWith('#')) continue;
            var lead = line.Length - line.TrimStart().Length;
            if (lead == 0)
            {
                inServices = line.StartsWith("services:", StringComparison.Ordinal);
                indent = null;
                continue;
            }
            if (!inServices) continue;
            indent ??= lead;
            if (lead == indent && Regex.Match(line.Trim(), @"^[""']?([\w.-]+)[""']?\s*:") is { Success: true } m) services.Add(m.Groups[1].Value);
        }
        return services;
    }

    // ------------------------------------------------------------------ a project's Dockerfile

    public DockerProjectDto Project(string projectPath)
    {
        var dir = Path.GetDirectoryName(PathUtil.Normalize(projectPath))!;
        var name = Path.GetFileNameWithoutExtension(projectPath);
        var dockerfile = new[] { "Dockerfile", "dockerfile" }.Select(f => Path.Combine(dir, f)).FirstOrDefault(File.Exists);
        var image = "kod-" + Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9_.-]", "-");
        if (dockerfile is null) return new DockerProjectDto(projectPath, null, null, [], false, image);
        var text = File.ReadAllText(dockerfile);
        var ports = Regex.Matches(text, @"^\s*EXPOSE\s+(.+)$", RegexOptions.Multiline | RegexOptions.IgnoreCase)
            .SelectMany(m => m.Groups[1].Value.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .Select(p => int.TryParse(p.Split('/')[0], out var n) ? n : 0)
            .Where(p => p > 0).Distinct().ToList();
        // Visual Studio's Dockerfiles copy "Project/Project.csproj": their build context is the solution folder
        var context = Regex.IsMatch(text, $@"COPY\s+\[?""?{Regex.Escape(name)}/", RegexOptions.IgnoreCase) ? Path.GetDirectoryName(dir)! : dir;
        var hasBase = Regex.IsMatch(text, @"^\s*FROM\s+\S+\s+AS\s+base\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase);
        return new DockerProjectDto(projectPath, dockerfile, context, ports, hasBase, image);
    }

    // ------------------------------------------------------------------ debugging in a container

    public sealed record DebugContainer(string Container, string Program, string Cwd, Dictionary<string, string> Env, IReadOnlyList<string> AdapterArgs);

    /// <summary>
    /// Rider's fast mode: the Dockerfile's "base" stage (else the official runtime image for the target framework) runs
    /// idle with the host's build output on /app and a Linux netcoredbg on /remote_debugger; the debugger launches the
    /// app inside it. Breakpoints match because the PDBs carry the host's source paths.
    /// </summary>
    public async Task<DebugContainer> PrepareDebugAsync(string projectPath, string outputDir, string assembly, bool web, Action<string> progress, CancellationToken ct)
    {
        var info = await InfoAsync(ct);
        if (!info.Running) throw new InvalidOperationException(info.Error ?? "The Docker engine is not running");
        var arm = info.ServerArch is "arm64" or "aarch64";
        progress("Getting the Linux debugger for the container…\n");
        var dbgDir = await adapter.InstallLinuxAsync(arm, ct);

        var proj = Project(projectPath);
        string image;
        if (proj.Dockerfile is not null && proj.HasBaseStage)
        {
            image = proj.ImageName + ":debug";
            progress($"docker build --target base -t {image}\n");
            var b = await RunAsync(["build", "--target", "base", "-t", image, "-f", proj.Dockerfile, proj.Context!], ct, timeoutMs: 600_000);
            progress(b.Err + b.Out);
            if (b.Code != 0) throw new InvalidOperationException("docker build of the base stage failed: see the Debug output");
        }
        else
        {
            var tfm = Regex.Match(Path.GetFileName(outputDir.TrimEnd('\\', '/')), @"^net(\d+\.\d+)").Groups[1].Value;
            image = $"mcr.microsoft.com/dotnet/{(web ? "aspnet" : "runtime")}:{(tfm.Length > 0 ? tfm : "10.0")}";
            progress($"No Dockerfile with a 'base' stage: using {image}\n");
        }

        var container = proj.ImageName + "-debug";
        await RunAsync(["rm", "-f", container], ct);
        var ports = proj.Ports.Count > 0 ? proj.Ports : web ? [8080] : [];
        var args = new List<string> { "run", "-d", "--name", container, "-v", $"{outputDir}:/app", "-v", $"{dbgDir}:/remote_debugger:ro", "-w", "/app" };
        foreach (var p in ports) args.AddRange(["-p", $"{p}:{p}"]);
        args.AddRange(["-e", "ASPNETCORE_ENVIRONMENT=Development", "-e", "DOTNET_ENVIRONMENT=Development", "--entrypoint", "tail", image, "-f", "/dev/null"]);
        progress($"docker run {container} (ports {string.Join(", ", ports)})\n");
        await RunOkAsync(args, ct, timeoutMs: 600_000);
        var env = new Dictionary<string, string> { ["ASPNETCORE_ENVIRONMENT"] = "Development", ["DOTNET_ENVIRONMENT"] = "Development" };
        if (web && ports.Count > 0) env["ASPNETCORE_URLS"] = string.Join(";", ports.Select(p => $"http://+:{p}"));
        return new DebugContainer(container, $"/app/{assembly}", "/app", env, ["exec", "-i", container, "/remote_debugger/netcoredbg"]);
    }

    public async Task RemoveAsync(string container)
    {
        try
        {
            await RunAsync(["rm", "-f", container], CancellationToken.None);
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "Could not remove {Container}", container);
        }
    }
}
