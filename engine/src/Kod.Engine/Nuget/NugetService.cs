using System.Text.Json;
using System.Xml.Linq;

namespace Kod.Engine.Nuget;

public sealed record PackageDto(string Id, string Version, string? Description, long? TotalDownloads, string? IconUrl, IReadOnlyList<string> Versions, bool Verified);

public sealed record PackageReferenceDto(string Id, string? Version);

/// <summary>nuget.org search (the v3 search service) and the PackageReference items of a project file.</summary>
public sealed class NugetService(IHttpClientFactory http)
{
    private string? searchUrl;

    public async Task<IReadOnlyList<PackageDto>> SearchAsync(string query, bool prerelease, CancellationToken ct)
    {
        var client = http.CreateClient("nuget");
        searchUrl ??= await ResolveSearchUrlAsync(client, ct);
        var url = $"{searchUrl}?q={Uri.EscapeDataString(query)}&take=30&prerelease={(prerelease ? "true" : "false")}&semVerLevel=2.0.0";
        using var doc = JsonDocument.Parse(await client.GetStringAsync(url, ct));
        var list = new List<PackageDto>();
        foreach (var p in doc.RootElement.GetProperty("data").EnumerateArray())
        {
            var versions = p.TryGetProperty("versions", out var vs)
                ? vs.EnumerateArray().Select(v => v.GetProperty("version").GetString()!).Reverse().Take(40).ToList()
                : [];
            list.Add(new PackageDto(
                p.GetProperty("id").GetString()!,
                p.GetProperty("version").GetString()!,
                p.TryGetProperty("description", out var d) ? d.GetString() : null,
                p.TryGetProperty("totalDownloads", out var td) && td.ValueKind == JsonValueKind.Number ? td.GetInt64() : null,
                p.TryGetProperty("iconUrl", out var icon) ? icon.GetString() : null,
                versions,
                p.TryGetProperty("verified", out var ver) && ver.ValueKind == JsonValueKind.True));
        }
        return list;
    }

    private static async Task<string> ResolveSearchUrlAsync(HttpClient client, CancellationToken ct)
    {
        using var index = JsonDocument.Parse(await client.GetStringAsync("https://api.nuget.org/v3/index.json", ct));
        foreach (var r in index.RootElement.GetProperty("resources").EnumerateArray())
            if (r.GetProperty("@type").GetString() is { } t && t.StartsWith("SearchQueryService", StringComparison.Ordinal))
                return r.GetProperty("@id").GetString()!;
        return "https://azuresearch-usnc.nuget.org/query";
    }

    public static IReadOnlyList<PackageReferenceDto> Installed(string projectPath)
    {
        var doc = XDocument.Load(projectPath);
        return doc.Descendants()
            .Where(e => e.Name.LocalName == "PackageReference")
            .Select(e => new PackageReferenceDto(
                (string?)e.Attribute("Include") ?? (string?)e.Attribute("Update") ?? "?",
                (string?)e.Attribute("Version") ?? e.Elements().FirstOrDefault(x => x.Name.LocalName == "Version")?.Value))
            .OrderBy(p => p.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
