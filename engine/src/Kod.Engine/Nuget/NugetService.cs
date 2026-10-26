using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Kod.Engine.Workspace;

namespace Kod.Engine.Nuget;

public sealed record PackageDto(string Id, string Version, string? Description, long? TotalDownloads, string? IconUrl, IReadOnlyList<string> Versions, bool Verified, string? Authors, string? Source);

public sealed record PackageReferenceDto(string Id, string? Version, bool Central = false);

public sealed record ProjectPackagesDto(string Project, string ProjectPath, IReadOnlyList<PackageReferenceDto> Packages);

public sealed record SourceDto(string Name, string Url, bool Enabled, bool Http);

public sealed record DependencyGroupDto(string TargetFramework, IReadOnlyList<DependencyDto> Dependencies);

public sealed record DependencyDto(string Id, string? Range);

public sealed record PackageDetailsDto(
    string Id, string Version, string? Title, string? Description, string? Authors, string? ProjectUrl, string? LicenseExpression,
    string? LicenseUrl, string? Published, string? Tags, IReadOnlyList<DependencyGroupDto> DependencyGroups,
    string? Deprecation, IReadOnlyList<string> Vulnerabilities, bool Listed);

/// <summary>
/// The NuGet tool window's back end (Rider's NuGet window): search on any v3 feed, package details from the
/// registration API (description, license, dependencies, deprecation, vulnerabilities), versions from the flat
/// container, the configured sources, and the PackageReferences of every project (central package management too).
/// Installing and removing go through <c>dotnet add/remove package</c> in the UI.
/// </summary>
public sealed class NugetService(IHttpClientFactory http, WorkspaceService workspace, ILogger<NugetService> log)
{
    private const string NugetOrg = "https://api.nuget.org/v3/index.json";
    private readonly ConcurrentDictionary<string, Task<Dictionary<string, string>>> indexes = new();

    private HttpClient Client() => http.CreateClient("nuget");

    /// <summary>Resource URLs of a v3 service index, by type prefix.</summary>
    private Task<Dictionary<string, string>> IndexAsync(string source, CancellationToken ct) =>
        indexes.GetOrAdd(source, async s =>
        {
            using var doc = JsonDocument.Parse(await Client().GetStringAsync(s, ct));
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var r in doc.RootElement.GetProperty("resources").EnumerateArray())
            {
                var type = r.GetProperty("@type").GetString() ?? "";
                var id = r.GetProperty("@id").GetString() ?? "";
                map.TryAdd(type, id);
                map.TryAdd(type.Split('/')[0], id);
            }
            return map;
        });

    private static string? Pick(Dictionary<string, string> idx, params string[] types) =>
        types.Select(t => idx.GetValueOrDefault(t)).FirstOrDefault(u => u is not null);

    // ------------------------------------------------------------------ sources

    /// <summary>The package sources the workspace sees (its NuGet.Config chain), via the dotnet CLI.</summary>
    public async Task<IReadOnlyList<SourceDto>> SourcesAsync(CancellationToken ct)
    {
        var psi = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = workspace.Root ?? Environment.CurrentDirectory };
        foreach (var a in new[] { "nuget", "list", "source", "--format", "detailed" }) psi.ArgumentList.Add(a);
        psi.Environment["DOTNET_CLI_UI_LANGUAGE"] = "en";
        using var p = Process.Start(psi)!;
        var text = await p.StandardOutput.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct);
        var list = new List<SourceDto>();
        var lines = text.Split('\n').Select(l => l.TrimEnd('\r')).ToList();
        for (var i = 0; i < lines.Count; i++)
        {
            var m = System.Text.RegularExpressions.Regex.Match(lines[i], @"^\s*\d+\.\s+(.+?)\s+\[(Enabled|Disabled)\]\s*$");
            if (!m.Success || i + 1 >= lines.Count) continue;
            var url = lines[++i].Trim();
            list.Add(new SourceDto(m.Groups[1].Value, url, m.Groups[2].Value == "Enabled", url.StartsWith("http", StringComparison.OrdinalIgnoreCase)));
        }
        if (list.Count == 0) list.Add(new SourceDto("nuget.org", NugetOrg, true, true));
        return list;
    }

    // ------------------------------------------------------------------ search

    public async Task<IReadOnlyList<PackageDto>> SearchAsync(string query, bool prerelease, string? source, CancellationToken ct)
    {
        var sources = source is { Length: > 0 }
            ? [source]
            : (await SourcesAsync(ct)).Where(s => s.Enabled && s.Http && s.Url.EndsWith("index.json", StringComparison.OrdinalIgnoreCase)).Select(s => s.Url).DefaultIfEmpty(NugetOrg).ToList();
        var results = await Task.WhenAll(sources.Select(async s =>
        {
            try
            {
                return await SearchOneAsync(s, query, prerelease, ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                log.LogDebug(ex, "Search on {Source} failed", s);
                return [];
            }
        }));
        // one entry per id; nuget.org (or the first source) wins
        return results.SelectMany(r => r).GroupBy(p => p.Id, StringComparer.OrdinalIgnoreCase).Select(g => g.First()).ToList();
    }

    private async Task<IReadOnlyList<PackageDto>> SearchOneAsync(string source, string query, bool prerelease, CancellationToken ct)
    {
        var idx = await IndexAsync(source, ct);
        var url = Pick(idx, "SearchQueryService/3.5.0", "SearchQueryService/3.0.0-rc", "SearchQueryService") ?? throw new HttpRequestException("No search service");
        using var doc = JsonDocument.Parse(await Client().GetStringAsync($"{url}?q={Uri.EscapeDataString(query)}&take=40&prerelease={(prerelease ? "true" : "false")}&semVerLevel=2.0.0", ct));
        var list = new List<PackageDto>();
        foreach (var p in doc.RootElement.GetProperty("data").EnumerateArray())
        {
            var versions = p.TryGetProperty("versions", out var vs) ? vs.EnumerateArray().Select(v => v.GetProperty("version").GetString()!).Reverse().ToList() : [];
            string? authors = null;
            if (p.TryGetProperty("authors", out var au))
                authors = au.ValueKind == JsonValueKind.Array ? string.Join(", ", au.EnumerateArray().Select(a => a.GetString())) : au.GetString();
            list.Add(new PackageDto(
                p.GetProperty("id").GetString()!,
                p.GetProperty("version").GetString()!,
                p.TryGetProperty("description", out var d) ? d.GetString() : null,
                p.TryGetProperty("totalDownloads", out var td) && td.ValueKind == JsonValueKind.Number ? td.GetInt64() : null,
                p.TryGetProperty("iconUrl", out var icon) ? icon.GetString() : null,
                versions,
                p.TryGetProperty("verified", out var ver) && ver.ValueKind == JsonValueKind.True,
                authors,
                source));
        }
        return list;
    }

    // ------------------------------------------------------------------ versions and details

    /// <summary>Every version of a package (newest first) from the flat container.</summary>
    public async Task<IReadOnlyList<string>> VersionsAsync(string id, string? source, CancellationToken ct)
    {
        var idx = await IndexAsync(source ?? NugetOrg, ct);
        var baseUrl = Pick(idx, "PackageBaseAddress/3.0.0", "PackageBaseAddress") ?? throw new InvalidOperationException("The source has no package content service");
        using var doc = JsonDocument.Parse(await Client().GetStringAsync($"{baseUrl.TrimEnd('/')}/{id.ToLowerInvariant()}/index.json", ct));
        return doc.RootElement.GetProperty("versions").EnumerateArray().Select(v => v.GetString()!).Reverse().ToList();
    }

    /// <summary>The newest version of each package (stable unless prerelease is on), for the Updates view.</summary>
    public async Task<Dictionary<string, string>> LatestAsync(IReadOnlyList<string> ids, bool prerelease, CancellationToken ct)
    {
        var result = new ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using var gate = new SemaphoreSlim(8);
        await Task.WhenAll(ids.Distinct(StringComparer.OrdinalIgnoreCase).Select(async id =>
        {
            await gate.WaitAsync(ct);
            try
            {
                var versions = await VersionsAsync(id, null, ct);
                var v = versions.FirstOrDefault(x => prerelease || !x.Contains('-'));
                if (v is not null) result[id] = v;
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException)
            {
                // a package from a private feed: no update information
            }
            finally
            {
                gate.Release();
            }
        }));
        return new Dictionary<string, string>(result, StringComparer.OrdinalIgnoreCase);
    }

    public async Task<PackageDetailsDto> DetailsAsync(string id, string? version, string? source, CancellationToken ct)
    {
        var idx = await IndexAsync(source ?? NugetOrg, ct);
        var reg = Pick(idx, "RegistrationsBaseUrl/3.6.0", "RegistrationsBaseUrl/3.4.0", "RegistrationsBaseUrl") ?? throw new InvalidOperationException("The source has no registration service");
        var client = Client();
        var index = JsonNode.Parse(await client.GetStringAsync($"{reg.TrimEnd('/')}/{id.ToLowerInvariant()}/index.json", ct))!;
        var entries = new List<JsonNode>();
        foreach (var page in index["items"]!.AsArray())
        {
            var items = page?["items"]?.AsArray();
            if (items is null && (string?)page?["@id"] is { } pageUrl) items = JsonNode.Parse(await client.GetStringAsync(pageUrl, ct))?["items"]?.AsArray();
            if (items is null) continue;
            foreach (var leaf in items) if (leaf?["catalogEntry"] is { } entry) entries.Add(entry);
        }
        if (entries.Count == 0) throw new InvalidOperationException($"No metadata for {id}");
        static string V(JsonNode e) => (string?)e["version"] ?? "";
        var chosen = version is not null
            ? entries.FirstOrDefault(e => string.Equals(V(e), version, StringComparison.OrdinalIgnoreCase)) ?? entries[^1]
            : entries.LastOrDefault(e => (bool?)e["listed"] != false && !V(e).Contains('-')) ?? entries[^1];

        var groups = new List<DependencyGroupDto>();
        foreach (var g in chosen["dependencyGroups"]?.AsArray() ?? [])
        {
            var deps = (g?["dependencies"]?.AsArray() ?? []).Select(d => new DependencyDto((string?)d?["id"] ?? "?", (string?)d?["range"])).ToList();
            groups.Add(new DependencyGroupDto((string?)g?["targetFramework"] ?? "Any", deps));
        }
        string? deprecation = null;
        if (chosen["deprecation"] is { } dep)
        {
            var reasons = string.Join(", ", (dep["reasons"]?.AsArray() ?? []).Select(r => (string?)r));
            var alt = (string?)dep["alternatePackage"]?["id"];
            deprecation = $"{reasons}{(alt is null ? "" : $" — use {alt} instead")}{((string?)dep["message"] is { } msg ? $": {msg}" : "")}";
        }
        var vulns = (chosen["vulnerabilities"]?.AsArray() ?? []).Select(v => $"{SeverityName((string?)v?["severity"])}: {(string?)v?["advisoryUrl"]}").ToList();
        var authors = chosen["authors"] is JsonArray arr ? string.Join(", ", arr.Select(a => (string?)a)) : (string?)chosen["authors"];
        var tags = chosen["tags"] is JsonArray ta ? string.Join(", ", ta.Select(a => (string?)a)) : (string?)chosen["tags"];
        return new PackageDetailsDto(
            (string?)chosen["id"] ?? id, V(chosen), (string?)chosen["title"], (string?)chosen["description"], authors,
            (string?)chosen["projectUrl"], (string?)chosen["licenseExpression"], (string?)chosen["licenseUrl"], (string?)chosen["published"], tags,
            groups, deprecation, vulns, (bool?)chosen["listed"] != false);
    }

    private static string SeverityName(string? s) => s switch { "0" => "Low", "1" => "Moderate", "2" => "High", "3" => "Critical", _ => "Vulnerability" };

    // ------------------------------------------------------------------ installed

    public IReadOnlyList<ProjectPackagesDto> InstalledAll() =>
        workspace.GetState().Projects.Select(p => new ProjectPackagesDto(p.Name, p.Path, Installed(p.Path))).ToList();

    public static IReadOnlyList<PackageReferenceDto> Installed(string projectPath)
    {
        var doc = XDocument.Load(projectPath);
        var central = CentralVersions(projectPath);
        return doc.Descendants()
            .Where(e => e.Name.LocalName == "PackageReference")
            .Select(e =>
            {
                var id = (string?)e.Attribute("Include") ?? (string?)e.Attribute("Update") ?? "?";
                var version = (string?)e.Attribute("Version") ?? e.Elements().FirstOrDefault(x => x.Name.LocalName == "Version")?.Value ?? (string?)e.Attribute("VersionOverride");
                if (version is null && central.TryGetValue(id, out var cv)) return new PackageReferenceDto(id, cv, Central: true);
                return new PackageReferenceDto(id, version);
            })
            .OrderBy(p => p.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>Directory.Packages.props of central package management, found above the project.</summary>
    private static Dictionary<string, string> CentralVersions(string projectPath)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var dir = new DirectoryInfo(System.IO.Path.GetDirectoryName(projectPath)!); dir is not null; dir = dir.Parent)
        {
            var props = System.IO.Path.Combine(dir.FullName, "Directory.Packages.props");
            if (!File.Exists(props)) continue;
            try
            {
                foreach (var e in XDocument.Load(props).Descendants().Where(e => e.Name.LocalName == "PackageVersion"))
                    if ((string?)e.Attribute("Include") is { } id && (string?)e.Attribute("Version") is { } v) map.TryAdd(id, v);
            }
            catch (System.Xml.XmlException)
            {
            }
            break;
        }
        return map;
    }
}
