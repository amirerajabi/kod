namespace Kod.Engine.Git;

/// <summary>The git side of pull requests: the remote's URL, file contents at a PR's commits, and checking a PR out.</summary>
public sealed partial class GitService
{
    /// <summary>The fetch URL of a remote (origin by default), or null when there is none.</summary>
    public async Task<string?> RemoteUrlAsync(string remote, CancellationToken ct)
    {
        var repo = await RepoRootAsync(ct);
        if (repo is null) return null;
        var r = await RunAsync(repo, ["remote", "get-url", remote], ct);
        return r.Code == 0 ? r.Out.Trim() : null;
    }

    /// <summary>A file at a commit when the commit is in the local repository; null when the commit is not here.</summary>
    public async Task<(bool Exists, string Text)?> LocalShowAsync(string sha, string rel, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        if ((await RunAsync(repo, ["cat-file", "-e", $"{sha}^{{commit}}"], ct)).Code != 0) return null;
        var r = await RunAsync(repo, ["show", $"{sha}:{rel}"], ct);
        return (r.Code == 0, r.Code == 0 ? r.Out : "");
    }

    /// <summary>
    /// Fetches a pull request and switches to it: a branch of the same repository is tracked under its own name, a fork's
    /// head comes from pull/N/head into pr/N. An existing local branch is fast-forwarded.
    /// </summary>
    public async Task<string> CheckoutPullAsync(string remote, int number, string headRef, bool sameRepo, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        string branch, source;
        if (sameRepo)
        {
            branch = headRef;
            source = $"{remote}/{headRef}";
            await FetchAsync(repo, [remote, $"+refs/heads/{headRef}:refs/remotes/{remote}/{headRef}"], ct);
        }
        else
        {
            branch = $"pr/{number}";
            source = "FETCH_HEAD";
            await FetchAsync(repo, [remote, $"pull/{number}/head"], ct);
        }
        var exists = (await RunAsync(repo, ["rev-parse", "--verify", "--quiet", $"refs/heads/{branch}"], ct)).Code == 0;
        if (!exists)
        {
            await RunOkAsync(repo, sameRepo ? ["switch", "--track", "-c", branch, source] : ["switch", "-c", branch, source], ct);
        }
        else
        {
            await RunOkAsync(repo, ["switch", branch], ct);
            var r = await RunAsync(repo, ["merge", "--ff-only", source], ct);
            if (r.Code != 0) throw new InvalidOperationException($"Switched to {branch}, but it has diverged from the pull request: {FirstLine(r.Err) ?? "fast-forward failed"}");
        }
        Changed();
        return branch;
    }

    private static async Task FetchAsync(string repo, IEnumerable<string> args, CancellationToken ct)
    {
        var r = await RunAsync(repo, ["fetch", "--no-tags", .. args], ct, timeoutMs: 120_000);
        if (r.Code != 0) throw new InvalidOperationException(FirstLine(r.Err) ?? "git fetch failed");
    }
}
