using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Kod.Engine.Git;

/// <summary>The GitHub repository of a remote; <see cref="Host"/> is github.com or a GitHub Enterprise server.</summary>
public sealed record GhRepoDto(string Host, string Owner, string Name, string WebUrl, string Remote);

/// <summary>What the Pull Requests window needs first: the repository, whether we can talk to GitHub, and as whom.</summary>
public sealed record PullContextDto(GhRepoDto? Repo, bool SignedIn, string? AuthSource, string? User, string? DefaultBranch, string? Error);

public sealed record PullSummaryDto(int Number, string Title, string Url, string State, bool Draft, string Author, string HeadRef, string BaseRef, string CreatedAt, string UpdatedAt, string? Checks, string? Review, int Comments, int Additions, int Deletions);

public sealed record PullCheckDto(string Name, string Status, string? Conclusion, string? Url);

public sealed record PullReviewDto(long Id, string Author, string State, string Body, string? SubmittedAt);

public sealed record PullCommentDto(long Id, string Author, string Body, string CreatedAt, string Url);

/// <summary>An inline comment on a line of a changed file; <see cref="Line"/> is null when the line no longer exists.</summary>
public sealed record PullReviewCommentDto(long Id, long? ReplyTo, string Author, string Body, string Path, int? Line, int? OriginalLine, string Side, string CreatedAt, string DiffHunk, string Url);

public sealed record PullFileDto(string Path, string? PrevPath, string Status, int Additions, int Deletions);

/// <summary><see cref="MergeBaseSha"/> is the left side of the file diffs (what GitHub's "Files changed" compares to).</summary>
public sealed record PullDetailDto(
    int Number, string Title, string Body, string Url, string State, bool Draft, bool Merged, bool? Mergeable, string? MergeableState,
    string Author, string HeadRef, string HeadSha, string? HeadRepo, bool SameRepo, string BaseRef, string BaseSha, string MergeBaseSha,
    string CreatedAt, string UpdatedAt, int Commits, int Additions, int Deletions,
    IReadOnlyList<PullCheckDto> Checks, IReadOnlyList<PullReviewDto> Reviews, IReadOnlyList<PullCommentDto> Comments,
    IReadOnlyList<PullReviewCommentDto> ReviewComments, IReadOnlyList<PullFileDto> Files);

public sealed record PullTokenBody(string? Token);
public sealed record PullCreateBody(string Title, string? Body, string Base, string Head, bool Draft);
public sealed record PullTextBody(string Body);
public sealed record PullReviewBody(string Event, string? Body);
public sealed record PullMergeBody(string Method, string? Title);

/// <summary>
/// GitHub pull requests of the open repository (Rider's Pull Requests window) over the REST API, and GraphQL for the
/// list (checks and review state in one query). The token comes from Settings, else the GitHub CLI (gh auth token),
/// else GH_TOKEN / GITHUB_TOKEN.
/// </summary>
public sealed class PullRequestService(GitService git, IHttpClientFactory http, ILogger<PullRequestService> log)
{
    private string? settingsToken;
    private (string Host, string? Token, string? Source, DateTime At)? auth;

    private sealed record Ctx(GhRepoDto Repo, string Api, string GraphQl, string Token);

    // ------------------------------------------------------------------ repository and auth

    private static readonly Regex RemoteRe = new(@"^(?:(?:https?|ssh|git)://)?(?:[^@/]+@)?(?<host>[^/:]+)(?::\d+)?[:/](?<owner>[^/]+)/(?<name>[^/]+?)(?:\.git)?/?$", RegexOptions.Compiled);

    /// <summary>owner/repo from https (https://host/owner/repo.git), ssh (git@host:owner/repo.git) and ssh:// URLs.</summary>
    public static GhRepoDto? ParseRemote(string url, string remote)
    {
        var m = RemoteRe.Match(url.Trim());
        if (!m.Success) return null;
        var host = m.Groups["host"].Value.ToLowerInvariant();
        if (host == "ssh.github.com") host = "github.com";
        if (host.Contains("gitlab") || host.Contains("bitbucket") || host.Contains("dev.azure.com") || host.Contains("visualstudio.com")) return null;
        var (owner, name) = (m.Groups["owner"].Value, m.Groups["name"].Value);
        return new GhRepoDto(host, owner, name, $"https://{host}/{owner}/{name}", remote);
    }

    private async Task<GhRepoDto?> RepoAsync(CancellationToken ct)
    {
        if (await git.RepoRootAsync(ct) is null) return null;
        var remotes = await git.RemotesAsync(ct);
        foreach (var r in remotes)
            if (ParseRemote(r.FetchUrl, r.Name) is { } repo) return repo;
        return null;
    }

    /// <summary>A token from Settings (null clears it).</summary>
    public void SetToken(string? token)
    {
        settingsToken = string.IsNullOrWhiteSpace(token) ? null : token.Trim();
        auth = null;
    }

    private async Task<(string? Token, string? Source)> TokenAsync(string host, CancellationToken ct)
    {
        if (settingsToken is not null) return (settingsToken, "settings");
        if (auth is { } a && a.Host == host && DateTime.UtcNow - a.At < TimeSpan.FromMinutes(5)) return (a.Token, a.Source);
        string? token = null, source = null;
        if (await GhTokenAsync(host, ct) is { } gh) (token, source) = (gh, "gh");
        else
        {
            var names = host == "github.com" ? new[] { "GH_TOKEN", "GITHUB_TOKEN" } : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
            foreach (var n in names)
                if (Environment.GetEnvironmentVariable(n) is { Length: > 0 } v)
                {
                    (token, source) = (v.Trim(), n);
                    break;
                }
        }
        auth = (host, token, source, DateTime.UtcNow);
        return (token, source);
    }

    private async Task<string?> GhTokenAsync(string host, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("gh") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8 };
        foreach (var a in new[] { "auth", "token", "--hostname", host }) psi.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return null;
            var output = p.StandardOutput.ReadToEndAsync(ct);
            _ = p.StandardError.ReadToEndAsync(ct);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(10_000);
            await p.WaitForExitAsync(cts.Token);
            var token = (await output).Trim();
            return p.ExitCode == 0 && token.Length > 0 ? token : null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or OperationCanceledException or InvalidOperationException)
        {
            log.LogDebug(ex, "gh auth token failed");
            return null;
        }
    }

    private async Task<Ctx> CtxAsync(CancellationToken ct)
    {
        var repo = await RepoAsync(ct) ?? throw new InvalidOperationException("No GitHub remote: the repository has no remote on GitHub");
        var (token, _) = await TokenAsync(repo.Host, ct);
        if (token is null) throw new InvalidOperationException("Not signed in to GitHub: run `gh auth login`, set GITHUB_TOKEN, or add a token in the Pull Requests window");
        var dotCom = repo.Host == "github.com";
        return new Ctx(repo, dotCom ? "https://api.github.com/" : $"https://{repo.Host}/api/v3/", dotCom ? "https://api.github.com/graphql" : $"https://{repo.Host}/api/graphql", token);
    }

    public async Task<PullContextDto> ContextAsync(CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        if (repo is null) return new PullContextDto(null, false, null, null, null, await git.RepoRootAsync(ct) is null ? "The open folder is not in a Git repository" : "The repository has no GitHub remote");
        var (token, source) = await TokenAsync(repo.Host, ct);
        if (token is null) return new PullContextDto(repo, false, null, null, null, null);
        try
        {
            var c = await CtxAsync(ct);
            var user = await SendAsync(c, HttpMethod.Get, "user", null, ct);
            var info = await SendAsync(c, HttpMethod.Get, $"repos/{repo.Owner}/{repo.Name}", null, ct);
            return new PullContextDto(repo, true, source, Str(user, "login"), Str(info, "default_branch"), null);
        }
        catch (InvalidOperationException ex)
        {
            return new PullContextDto(repo, false, source, null, null, ex.Message);
        }
    }

    // ------------------------------------------------------------------ HTTP

    private async Task<JsonElement> SendAsync(Ctx c, HttpMethod method, string path, object? body, CancellationToken ct, string? url = null)
    {
        using var req = new HttpRequestMessage(method, url ?? c.Api + path);
        Headers(req, c.Token);
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var res = await http.CreateClient().SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException(ErrorOf(res.StatusCode, text));
        if (text.Length == 0) return default;
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    private static void Headers(HttpRequestMessage req, string token)
    {
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("Kod/0.3");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        req.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
    }

    private static string ErrorOf(HttpStatusCode code, string text)
    {
        if (code == HttpStatusCode.Unauthorized) return "GitHub rejected the token (401): sign in again with `gh auth login` or check the token";
        string? message = null;
        try
        {
            using var doc = JsonDocument.Parse(text);
            message = Str(doc.RootElement, "message");
            if (doc.RootElement.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array)
            {
                var details = errors.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() : Str(e, "message") ?? Str(e, "code")).Where(s => !string.IsNullOrEmpty(s)).ToList();
                if (details.Count > 0) message = $"{message}: {string.Join("; ", details)}";
            }
        }
        catch (JsonException)
        {
            // not JSON
        }
        return $"GitHub: {message ?? $"{(int)code} {code}"}";
    }

    /// <summary>Every page of a list endpoint (100 per page, at most 3000 items).</summary>
    private async Task<List<JsonElement>> AllAsync(Ctx c, string path, CancellationToken ct, string? arrayProperty = null)
    {
        var list = new List<JsonElement>();
        for (var page = 1; page <= 30; page++)
        {
            var r = await SendAsync(c, HttpMethod.Get, $"{path}{(path.Contains('?') ? '&' : '?')}per_page=100&page={page}", null, ct);
            var items = arrayProperty is null ? r : r.GetProperty(arrayProperty);
            var n = 0;
            foreach (var e in items.EnumerateArray())
            {
                list.Add(e);
                n++;
            }
            if (n < 100) break;
        }
        return list;
    }

    private static string Repo(Ctx c) => $"repos/{c.Repo.Owner}/{c.Repo.Name}";

    private static string? Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int Int(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;

    private static long? Long(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : null;

    private static bool Bool(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    private static JsonElement Obj(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

    private static string Login(JsonElement e, string name = "user") => Str(Obj(e, name), "login") ?? "ghost";

    // ------------------------------------------------------------------ list

    private const string ListQuery = """
        query($q: String!) {
          search(query: $q, type: ISSUE, first: 50) {
            nodes {
              ... on PullRequest {
                number title url state isDraft createdAt updatedAt headRefName baseRefName reviewDecision additions deletions
                author { login }
                comments { totalCount }
                commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
              }
            }
          }
        }
        """;

    /// <summary>The pull requests by state (open, closed, all); mine = authored by me or waiting for my review.</summary>
    public async Task<IReadOnlyList<PullSummaryDto>> ListAsync(string state, bool mine, CancellationToken ct)
    {
        var c = await CtxAsync(ct);
        var q = $"repo:{c.Repo.Owner}/{c.Repo.Name} is:pr sort:updated-desc" + state switch { "open" => " is:open", "closed" => " is:closed", _ => "" };
        var queries = mine ? new[] { q + " author:@me", q + " review-requested:@me" } : [q];
        var results = await Task.WhenAll(queries.Select(query => SendAsync(c, HttpMethod.Post, "", new { query = ListQuery, variables = new { q = query } }, ct, c.GraphQl)));
        var list = new Dictionary<int, PullSummaryDto>();
        foreach (var r in results)
        {
            if (r.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
                throw new InvalidOperationException($"GitHub: {Str(errors[0], "message")}");
            foreach (var n in r.GetProperty("data").GetProperty("search").GetProperty("nodes").EnumerateArray())
            {
                if (n.ValueKind != JsonValueKind.Object || !n.TryGetProperty("number", out _)) continue;
                var commit = Obj(Obj(n, "commits"), "nodes") is { ValueKind: JsonValueKind.Array } nodes && nodes.GetArrayLength() > 0 ? Obj(nodes[0], "commit") : default;
                var checks = Str(Obj(commit, "statusCheckRollup"), "state")?.ToLowerInvariant();
                list[Int(n, "number")] = new PullSummaryDto(Int(n, "number"), Str(n, "title") ?? "", Str(n, "url") ?? "", (Str(n, "state") ?? "OPEN").ToLowerInvariant(), Bool(n, "isDraft"),
                    Str(Obj(n, "author"), "login") ?? "ghost", Str(n, "headRefName") ?? "", Str(n, "baseRefName") ?? "", Str(n, "createdAt") ?? "", Str(n, "updatedAt") ?? "",
                    checks, Str(n, "reviewDecision")?.ToLowerInvariant(), Int(Obj(n, "comments"), "totalCount"), Int(n, "additions"), Int(n, "deletions"));
            }
        }
        return list.Values.OrderByDescending(p => p.UpdatedAt, StringComparer.Ordinal).ToList();
    }

    // ------------------------------------------------------------------ details

    public async Task<PullDetailDto> DetailAsync(int number, CancellationToken ct)
    {
        var c = await CtxAsync(ct);
        var pr = await SendAsync(c, HttpMethod.Get, $"{Repo(c)}/pulls/{number}", null, ct);
        var head = Obj(pr, "head");
        var @base = Obj(pr, "base");
        var headSha = Str(head, "sha") ?? "";
        var baseSha = Str(@base, "sha") ?? "";
        var headRepo = Str(Obj(head, "repo"), "full_name");

        var files = AllAsync(c, $"{Repo(c)}/pulls/{number}/files", ct);
        var comments = AllAsync(c, $"{Repo(c)}/issues/{number}/comments", ct);
        var reviews = AllAsync(c, $"{Repo(c)}/pulls/{number}/reviews", ct);
        var reviewComments = AllAsync(c, $"{Repo(c)}/pulls/{number}/comments", ct);
        var checks = ChecksAsync(c, headSha, ct);
        var mergeBase = MergeBaseAsync(c, baseSha, headSha, ct);
        await Task.WhenAll(files, comments, reviews, reviewComments, checks, mergeBase);

        var merged = Bool(pr, "merged");
        bool? mergeable = Obj(pr, "mergeable").ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
        return new PullDetailDto(
            number, Str(pr, "title") ?? "", Str(pr, "body") ?? "", Str(pr, "html_url") ?? "", merged ? "merged" : Str(pr, "state") ?? "open", Bool(pr, "draft"), merged, mergeable, Str(pr, "mergeable_state"),
            Login(pr), Str(head, "ref") ?? "", headSha, headRepo, string.Equals(headRepo, $"{c.Repo.Owner}/{c.Repo.Name}", StringComparison.OrdinalIgnoreCase),
            Str(@base, "ref") ?? "", baseSha, mergeBase.Result ?? baseSha, Str(pr, "created_at") ?? "", Str(pr, "updated_at") ?? "", Int(pr, "commits"), Int(pr, "additions"), Int(pr, "deletions"),
            checks.Result,
            reviews.Result.Where(r => Str(r, "state") != "PENDING").Select(r => new PullReviewDto(Long(r, "id") ?? 0, Login(r), (Str(r, "state") ?? "").ToLowerInvariant(), Str(r, "body") ?? "", Str(r, "submitted_at"))).ToList(),
            comments.Result.Select(e => new PullCommentDto(Long(e, "id") ?? 0, Login(e), Str(e, "body") ?? "", Str(e, "created_at") ?? "", Str(e, "html_url") ?? "")).ToList(),
            reviewComments.Result.Select(e => new PullReviewCommentDto(Long(e, "id") ?? 0, Long(e, "in_reply_to_id"), Login(e), Str(e, "body") ?? "", Str(e, "path") ?? "",
                Obj(e, "line").ValueKind == JsonValueKind.Number ? Int(e, "line") : null, Obj(e, "original_line").ValueKind == JsonValueKind.Number ? Int(e, "original_line") : null,
                Str(e, "side") ?? "RIGHT", Str(e, "created_at") ?? "", Str(e, "diff_hunk") ?? "", Str(e, "html_url") ?? "")).ToList(),
            files.Result.Select(f => new PullFileDto(Str(f, "filename") ?? "", Str(f, "previous_filename"), Str(f, "status") ?? "modified", Int(f, "additions"), Int(f, "deletions"))).ToList());
    }

    private async Task<string?> MergeBaseAsync(Ctx c, string baseSha, string headSha, CancellationToken ct)
    {
        try
        {
            var r = await SendAsync(c, HttpMethod.Get, $"{Repo(c)}/compare/{baseSha}...{headSha}", null, ct);
            return Str(Obj(r, "merge_base_commit"), "sha");
        }
        catch (InvalidOperationException ex)
        {
            log.LogDebug(ex, "compare failed");
            return null;
        }
    }

    /// <summary>Check runs (GitHub Actions and apps) and commit statuses (older CI integrations) of the head commit.</summary>
    private async Task<IReadOnlyList<PullCheckDto>> ChecksAsync(Ctx c, string sha, CancellationToken ct)
    {
        var list = new List<PullCheckDto>();
        try
        {
            foreach (var r in await AllAsync(c, $"{Repo(c)}/commits/{sha}/check-runs", ct, "check_runs"))
                list.Add(new PullCheckDto(Str(r, "name") ?? "", Str(r, "status") ?? "completed", Str(r, "conclusion"), Str(r, "html_url")));
            var status = await SendAsync(c, HttpMethod.Get, $"{Repo(c)}/commits/{sha}/status", null, ct);
            foreach (var s in Obj(status, "statuses").EnumerateArray())
            {
                var state = Str(s, "state") ?? "pending";
                list.Add(new PullCheckDto(Str(s, "context") ?? "", state == "pending" ? "in_progress" : "completed", state == "pending" ? null : state, Str(s, "target_url")));
            }
        }
        catch (InvalidOperationException ex)
        {
            log.LogDebug(ex, "checks unavailable");
        }
        return list;
    }

    /// <summary>A file at one of the PR's commits: from the local repository when the commit is here, else from GitHub.</summary>
    public async Task<object> ContentAsync(string rel, string sha, CancellationToken ct)
    {
        if (!Regex.IsMatch(sha, "^[0-9a-fA-F]{7,40}$")) throw new ArgumentException("Not a commit hash");
        rel = rel.Replace('\\', '/').TrimStart('/');
        if (rel.Split('/').Contains("..")) throw new ArgumentException("Not a repository path");
        if (await git.LocalShowAsync(sha, rel, ct) is { } local) return new { exists = local.Exists, text = local.Text };
        var c = await CtxAsync(ct);
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{c.Api}{Repo(c)}/contents/{string.Join('/', rel.Split('/').Select(Uri.EscapeDataString))}?ref={sha}");
        Headers(req, c.Token);
        req.Headers.Accept.Clear();
        req.Headers.Accept.ParseAdd("application/vnd.github.raw");
        using var res = await http.CreateClient().SendAsync(req, ct);
        if (res.StatusCode == HttpStatusCode.NotFound) return new { exists = false, text = "" };
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException(ErrorOf(res.StatusCode, text));
        return new { exists = true, text };
    }

    // ------------------------------------------------------------------ actions

    public async Task<string> CheckoutAsync(int number, CancellationToken ct)
    {
        var c = await CtxAsync(ct);
        var pr = await SendAsync(c, HttpMethod.Get, $"{Repo(c)}/pulls/{number}", null, ct);
        var head = Obj(pr, "head");
        var sameRepo = string.Equals(Str(Obj(head, "repo"), "full_name"), $"{c.Repo.Owner}/{c.Repo.Name}", StringComparison.OrdinalIgnoreCase);
        return await git.CheckoutPullAsync(c.Repo.Remote, number, Str(head, "ref") ?? throw new InvalidOperationException("The pull request has no head branch"), sameRepo, ct);
    }

    public async Task<PullSummaryDto> CreateAsync(PullCreateBody b, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(b.Title)) throw new ArgumentException("Enter a title");
        if (string.IsNullOrWhiteSpace(b.Base) || string.IsNullOrWhiteSpace(b.Head)) throw new ArgumentException("Choose the base and head branches");
        var c = await CtxAsync(ct);
        var pr = await SendAsync(c, HttpMethod.Post, $"{Repo(c)}/pulls", new { title = b.Title.Trim(), body = b.Body ?? "", @base = b.Base, head = b.Head, draft = b.Draft }, ct);
        return new PullSummaryDto(Int(pr, "number"), Str(pr, "title") ?? "", Str(pr, "html_url") ?? "", "open", Bool(pr, "draft"), Login(pr), b.Head, b.Base, Str(pr, "created_at") ?? "", Str(pr, "updated_at") ?? "", null, null, 0, 0, 0);
    }

    public async Task CommentAsync(int number, string body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body)) throw new ArgumentException("Write a comment");
        var c = await CtxAsync(ct);
        await SendAsync(c, HttpMethod.Post, $"{Repo(c)}/issues/{number}/comments", new { body }, ct);
    }

    /// <summary>event: approve, request_changes or comment.</summary>
    public async Task ReviewAsync(int number, string ev, string? body, CancellationToken ct)
    {
        var e = ev.ToUpperInvariant() switch
        {
            "APPROVE" => "APPROVE",
            "REQUEST_CHANGES" => "REQUEST_CHANGES",
            "COMMENT" => "COMMENT",
            _ => throw new ArgumentException($"Unknown review event '{ev}'"),
        };
        if (e != "APPROVE" && string.IsNullOrWhiteSpace(body)) throw new ArgumentException("Write what the review is about");
        var c = await CtxAsync(ct);
        await SendAsync(c, HttpMethod.Post, $"{Repo(c)}/pulls/{number}/reviews", new { @event = e, body = body ?? "" }, ct);
    }

    /// <summary>method: merge, squash or rebase.</summary>
    public async Task<string> MergeAsync(int number, string method, string? title, CancellationToken ct)
    {
        if (method is not ("merge" or "squash" or "rebase")) throw new ArgumentException($"Unknown merge method '{method}'");
        var c = await CtxAsync(ct);
        var r = await SendAsync(c, HttpMethod.Put, $"{Repo(c)}/pulls/{number}/merge", string.IsNullOrWhiteSpace(title) ? new { merge_method = method } : new { merge_method = method, commit_title = title }, ct);
        return Str(r, "message") ?? "Pull request merged";
    }
}

public static class PullRequestEndpoints
{
    /// <summary>The Pull Requests window: /git/pulls/…</summary>
    public static RouteGroupBuilder MapPullRequests(this RouteGroupBuilder api)
    {
        var pr = api.MapGroup("/git/pulls");
        pr.MapGet("/context", (PullRequestService s, CancellationToken ct) => s.ContextAsync(ct));
        pr.MapPost("/token", (PullTokenBody b, PullRequestService s) => { s.SetToken(b.Token); return Results.NoContent(); });
        pr.MapGet("/list", (string? state, bool? mine, PullRequestService s, CancellationToken ct) => s.ListAsync(state ?? "open", mine == true, ct));
        pr.MapGet("/content", (string path, string sha, PullRequestService s, CancellationToken ct) => s.ContentAsync(path, sha, ct));
        pr.MapPost("/create", (PullCreateBody b, PullRequestService s, CancellationToken ct) => s.CreateAsync(b, ct));
        pr.MapGet("/{number:int}", (int number, PullRequestService s, CancellationToken ct) => s.DetailAsync(number, ct));
        pr.MapPost("/{number:int}/checkout", async (int number, PullRequestService s, CancellationToken ct) => new { branch = await s.CheckoutAsync(number, ct) });
        pr.MapPost("/{number:int}/comment", async (int number, PullTextBody b, PullRequestService s, CancellationToken ct) => { await s.CommentAsync(number, b.Body, ct); return Results.NoContent(); });
        pr.MapPost("/{number:int}/review", async (int number, PullReviewBody b, PullRequestService s, CancellationToken ct) => { await s.ReviewAsync(number, b.Event, b.Body, ct); return Results.NoContent(); });
        pr.MapPost("/{number:int}/merge", async (int number, PullMergeBody b, PullRequestService s, CancellationToken ct) => new { message = await s.MergeAsync(number, b.Method, b.Title, ct) });
        return api;
    }
}
