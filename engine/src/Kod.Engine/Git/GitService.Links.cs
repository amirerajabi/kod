using System.Text.RegularExpressions;

namespace Kod.Engine.Git;

/// <param name="RepoPath">The file's path from the repository root (forward slashes).</param>
/// <param name="Url">The file (and lines) on the hosting site at the current commit, when the remote is GitHub or GitLab.</param>
public sealed record FileLinkDto(string? RepoPath, string? Url);

/// <summary>Copy Path/Reference's repository entries: the path from the repository root and a web link to the lines.</summary>
public sealed partial class GitService
{
    private static readonly Regex WebRemoteRe = new(@"^(?:(?:https?|ssh|git)://)?(?:[^@/]+@)?(?<host>[^/:]+)(?::\d+)?[:/](?<path>.+?)(?:\.git)?/?$", RegexOptions.Compiled);

    public async Task<FileLinkDto> LinkAsync(string path, int? line, int? endLine, CancellationToken ct)
    {
        var repo = await RepoRootAsync(ct);
        if (repo is null) return new FileLinkDto(null, null);
        var rel = Rel(repo, path);
        if (rel.StartsWith("..", StringComparison.Ordinal)) return new FileLinkDto(null, null);

        // origin, else the first remote
        var url = await RemoteUrlAsync("origin", ct);
        if (url is null)
        {
            var first = (await RunAsync(repo, ["remote"], ct)).Out.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
            if (first is not null) url = await RemoteUrlAsync(first, ct);
        }
        var head = await RunAsync(repo, ["rev-parse", "HEAD"], ct);
        if (url is null || head.Code != 0 || WebRemoteRe.Match(url.Trim()) is not { Success: true } m) return new FileLinkDto(rel, null);

        var host = m.Groups["host"].Value.ToLowerInvariant();
        if (host == "ssh.github.com") host = "github.com";
        var web = $"https://{host}/{m.Groups["path"].Value}";
        var sha = head.Out.Trim();
        var file = string.Join('/', rel.Split('/').Select(Uri.EscapeDataString));
        string? link = host.Contains("gitlab")
            ? $"{web}/-/blob/{sha}/{file}" + (line is { } l1 ? $"#L{l1}" + (endLine is { } e1 && e1 > l1 ? $"-{e1}" : "") : "")
            : host.Contains("bitbucket") || host.Contains("azure") || host.Contains("visualstudio")
                ? null
                : $"{web}/blob/{sha}/{file}" + (line is { } l2 ? $"#L{l2}" + (endLine is { } e2 && e2 > l2 ? $"-L{e2}" : "") : "");
        return new FileLinkDto(rel, link);
    }
}
