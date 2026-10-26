using System.Diagnostics;
using System.Text;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;

namespace Kod.Engine.Git;

public sealed record GitFileDto(string Path, string Rel, string Index, string WorkTree, string? OrigPath, bool Staged, bool Unstaged, bool Untracked, bool Conflicted);

/// <summary><see cref="Operation"/> is the merge, rebase, cherry-pick or revert in progress (it stopped for conflicts or an edit).</summary>
public sealed record GitStatusDto(bool IsRepo, string? Root, string? Branch, string? Upstream, int Ahead, int Behind, bool Detached, IReadOnlyList<GitFileDto> Files, string? Operation = null);

public sealed record GitBranchDto(string Name, string Hash, string? Upstream, bool Current, bool Remote);

public sealed record GitCommitDto(string Hash, string Short, IReadOnlyList<string> Parents, string Author, string Email, string Date, IReadOnlyList<string> Refs, string Subject);

public sealed record GitCommitFileDto(string Status, string Path, string? OrigPath);

public sealed record GitCommitDetailDto(string Hash, string Message, IReadOnlyList<GitCommitFileDto> Files);

public sealed record GitRemoteDto(string Name, string FetchUrl, string PushUrl);

public sealed record GitBlameLineDto(int Line, string Hash, string Author, long Time, string Summary);

/// <summary>
/// Git through the git CLI (the user's own install, config and credential helpers): status, file contents at a
/// revision (for diffs), staging, commit, branches, log, commit details and blame. Network operations (fetch, pull,
/// push) run as processes from the UI so their output and credential prompts are visible.
/// </summary>
public sealed partial class GitService(WorkspaceService workspace, EventHub hub, ILogger<GitService> log)
{
    private string? cachedFor;
    private string? cachedRoot;

    // ------------------------------------------------------------------ plumbing

    private sealed record Result(int Code, string Out, string Err);

    private static async Task<Result> RunAsync(string cwd, IEnumerable<string> args, CancellationToken ct, string? stdin = null, int timeoutMs = 30_000, IReadOnlyDictionary<string, string>? env = null)
    {
        var psi = new ProcessStartInfo("git")
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = stdin is not null,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
        psi.Environment["LC_ALL"] = "C";
        if (env is not null)
            foreach (var (k, v) in env) psi.Environment[k] = v;
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("git is not installed (or not on PATH)");
        if (stdin is not null)
        {
            await p.StandardInput.WriteAsync(stdin);
            p.StandardInput.Close();
        }
        var outTask = p.StandardOutput.ReadToEndAsync(ct);
        var errTask = p.StandardError.ReadToEndAsync(ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeoutMs);
        try
        {
            await p.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                p.Kill(entireProcessTree: true);
            }
            catch
            {
                // gone
            }
            throw new TimeoutException($"git {string.Join(' ', psi.ArgumentList.Take(2))} took too long");
        }
        return new Result(p.ExitCode, await outTask, await errTask);
    }

    private static async Task<string> RunOkAsync(string cwd, IEnumerable<string> args, CancellationToken ct, string? stdin = null)
    {
        var r = await RunAsync(cwd, args, ct, stdin);
        if (r.Code != 0) throw new InvalidOperationException(FirstLine(r.Err) ?? $"git exited with {r.Code}");
        return r.Out;
    }

    private static string? FirstLine(string s) => s.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0 && !l.StartsWith("hint:", StringComparison.Ordinal));

    /// <summary>The repository that contains the open folder, or null.</summary>
    public async Task<string?> RepoRootAsync(CancellationToken ct)
    {
        var root = workspace.Root;
        if (root is null) return null;
        if (cachedFor == root) return cachedRoot;
        try
        {
            var r = await RunAsync(root, ["rev-parse", "--show-toplevel"], ct);
            cachedRoot = r.Code == 0 ? PathUtil.Normalize(r.Out.Trim()) : null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            log.LogDebug(ex, "git not available");
            cachedRoot = null;
        }
        cachedFor = root;
        return cachedRoot;
    }

    private async Task<string> RepoAsync(CancellationToken ct) =>
        await RepoRootAsync(ct) ?? throw new InvalidOperationException("The open folder is not in a Git repository");

    private static string Rel(string repo, string path) => System.IO.Path.GetRelativePath(repo, PathUtil.Normalize(path)).Replace('\\', '/');

    private static string Abs(string repo, string rel) => PathUtil.Normalize(System.IO.Path.Combine(repo, rel.Replace('/', System.IO.Path.DirectorySeparatorChar)));

    private void Changed() => hub.Publish("git.changed", new { });

    // ------------------------------------------------------------------ status

    public async Task<GitStatusDto> StatusAsync(CancellationToken ct)
    {
        var repo = await RepoRootAsync(ct);
        if (repo is null) return new GitStatusDto(false, null, null, null, 0, 0, false, []);
        var raw = await RunOkAsync(repo, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], ct);
        string? branch = null, upstream = null;
        int ahead = 0, behind = 0;
        var detached = false;
        var files = new List<GitFileDto>();
        var parts = raw.Split('\0');
        for (var i = 0; i < parts.Length; i++)
        {
            var e = parts[i];
            if (e.Length == 0) continue;
            if (e.StartsWith("# branch.head ", StringComparison.Ordinal))
            {
                branch = e[14..];
                detached = branch == "(detached)";
            }
            else if (e.StartsWith("# branch.upstream ", StringComparison.Ordinal)) upstream = e[18..];
            else if (e.StartsWith("# branch.ab ", StringComparison.Ordinal))
            {
                var ab = e[12..].Split(' ');
                ahead = int.Parse(ab[0].TrimStart('+'));
                behind = int.Parse(ab[1].TrimStart('-'));
            }
            else if (e[0] is '1' or '2' or 'u')
            {
                var f = e.Split(' ', e[0] == '1' ? 9 : e[0] == '2' ? 10 : 11);
                var xy = f[1];
                var rel = f[^1];
                string? orig = null;
                if (e[0] == '2') orig = parts[++i];
                var conflicted = e[0] == 'u';
                files.Add(new GitFileDto(Abs(repo, rel), rel, xy[0].ToString(), xy[1].ToString(), orig is null ? null : Abs(repo, orig), !conflicted && xy[0] != '.', !conflicted && xy[1] != '.', false, conflicted));
            }
            else if (e[0] == '?')
            {
                var rel = e[2..];
                files.Add(new GitFileDto(Abs(repo, rel), rel, "?", "?", null, false, false, true, false));
            }
        }
        return new GitStatusDto(true, repo, detached ? null : branch, upstream, ahead, behind, detached, files.OrderBy(f => f.Rel, StringComparer.OrdinalIgnoreCase).ToList(), await OperationAsync(repo, ct));
    }

    /// <summary>A file's content at a revision: "HEAD", ":" (the index), or a commit hash. Missing = empty.</summary>
    public async Task<object> ShowAsync(string path, string rev, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var spec = rev == ":" ? $":{Rel(repo, path)}" : $"{rev}:{Rel(repo, path)}";
        var r = await RunAsync(repo, ["show", spec], ct);
        return new { exists = r.Code == 0, text = r.Code == 0 ? r.Out : "" };
    }

    // ------------------------------------------------------------------ changes

    public async Task StageAsync(IReadOnlyList<string> paths, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        await RunOkAsync(repo, ["add", "-A", "--", .. paths.Select(p => Rel(repo, p))], ct);
        Changed();
    }

    public async Task UnstageAsync(IReadOnlyList<string> paths, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var hasHead = (await RunAsync(repo, ["rev-parse", "--verify", "HEAD"], ct)).Code == 0;
        if (hasHead) await RunOkAsync(repo, ["restore", "--staged", "--", .. paths.Select(p => Rel(repo, p))], ct);
        else await RunOkAsync(repo, ["rm", "--cached", "-r", "-q", "--", .. paths.Select(p => Rel(repo, p))], ct);
        Changed();
    }

    /// <summary>Rollback: tracked files go back to HEAD, untracked ones are deleted.</summary>
    public async Task DiscardAsync(IReadOnlyList<string> paths, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var status = await StatusAsync(ct);
        var untracked = status.Files.Where(f => f.Untracked && paths.Any(p => PathUtil.Equal(p, f.Path))).Select(f => f.Rel).ToList();
        var tracked = paths.Select(p => Rel(repo, p)).Except(untracked).ToList();
        var hasHead = (await RunAsync(repo, ["rev-parse", "--verify", "HEAD"], ct)).Code == 0;
        if (tracked.Count > 0)
        {
            if (hasHead) await RunOkAsync(repo, ["restore", "--source=HEAD", "--staged", "--worktree", "--", .. tracked], ct);
            else await RunOkAsync(repo, ["rm", "--cached", "-q", "--", .. tracked], ct);
        }
        if (untracked.Count > 0) await RunOkAsync(repo, ["clean", "-f", "-q", "--", .. untracked], ct);
        Changed();
    }

    /// <summary>Commits the given files (all changes when none are given), like Rider's commit of the checked files.</summary>
    public async Task<string> CommitAsync(string message, IReadOnlyList<string>? paths, bool amend, IReadOnlyList<PartialFileDto>? partial, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(message) && !amend) throw new ArgumentException("Write a commit message");
        var repo = await RepoAsync(ct);
        var args = new List<string> { "commit", "-F", "-" };
        if (amend) args.Add("--amend");
        if (partial is { Count: > 0 })
        {
            // some files commit only chosen hunks / lines: build the index from exactly the selection, then commit it
            await StagePartialAsync(repo, paths ?? [], partial, ct);
        }
        else if (paths is { Count: > 0 })
        {
            var rels = paths.Select(p => Rel(repo, p)).ToList();
            await RunOkAsync(repo, ["add", "-A", "--", .. rels], ct);
            args.Add("--");
            args.AddRange(rels);
        }
        else
        {
            await RunOkAsync(repo, ["add", "-A"], ct);
        }
        var r = await RunAsync(repo, args, ct, stdin: message);
        Changed();
        if (r.Code != 0) throw new InvalidOperationException(FirstLine(r.Err) ?? FirstLine(r.Out) ?? "git commit failed");
        return (await RunOkAsync(repo, ["rev-parse", "--short", "HEAD"], ct)).Trim();
    }

    public async Task<string> LastMessageAsync(CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var r = await RunAsync(repo, ["log", "-1", "--pretty=%B"], ct);
        return r.Code == 0 ? r.Out.TrimEnd() : "";
    }

    // ------------------------------------------------------------------ branches

    public async Task<IReadOnlyList<GitBranchDto>> BranchesAsync(CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var raw = await RunOkAsync(repo, ["for-each-ref", "--format=%(refname)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)", "refs/heads", "refs/remotes"], ct);
        var list = new List<GitBranchDto>();
        foreach (var line in raw.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var f = line.Split('\t');
            var remote = f[0].StartsWith("refs/remotes/", StringComparison.Ordinal);
            var name = remote ? f[0]["refs/remotes/".Length..] : f[0]["refs/heads/".Length..];
            if (remote && name.EndsWith("/HEAD", StringComparison.Ordinal)) continue;
            list.Add(new GitBranchDto(name, f[1], string.IsNullOrEmpty(f[2]) ? null : f[2], f[3] == "*", remote));
        }
        return list;
    }

    public async Task CheckoutAsync(string name, bool create, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        if (create) await RunOkAsync(repo, ["switch", "-c", name], ct);
        else
        {
            var branches = await BranchesAsync(ct);
            var remote = branches.FirstOrDefault(b => b.Remote && b.Name == name);
            if (remote is not null)
            {
                var local = name[(name.IndexOf('/') + 1)..];
                if (branches.Any(b => !b.Remote && b.Name == local)) await RunOkAsync(repo, ["switch", local], ct);
                else await RunOkAsync(repo, ["switch", "--track", name], ct);
            }
            else await RunOkAsync(repo, ["switch", name], ct);
        }
        Changed();
    }

    public async Task DeleteBranchAsync(string name, bool force, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        await RunOkAsync(repo, ["branch", force ? "-D" : "-d", name], ct);
        Changed();
    }

    // ------------------------------------------------------------------ history

    public async Task<IReadOnlyList<GitCommitDto>> LogAsync(string? path, bool all, int max, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var args = new List<string> { "log", $"--max-count={Math.Clamp(max, 1, 2000)}", "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%D%x1f%s%x1e" };
        if (all) args.Add("--all");
        if (path is not null)
        {
            args.Add("--follow");
            args.Add("--");
            args.Add(Rel(repo, path));
        }
        var r = await RunAsync(repo, args, ct);
        if (r.Code != 0) return []; // e.g. no commits yet
        return r.Out.Split('\x1e', StringSplitOptions.RemoveEmptyEntries)
            .Select(rec => rec.Trim('\n', '\r').Split('\x1f'))
            .Where(f => f.Length >= 8)
            .Select(f => new GitCommitDto(f[0], f[1], f[2].Split(' ', StringSplitOptions.RemoveEmptyEntries), f[3], f[4], f[5],
                f[6].Split(", ", StringSplitOptions.RemoveEmptyEntries).Select(x => x.Replace("HEAD -> ", "")).ToList(), f[7]))
            .ToList();
    }

    public async Task<GitCommitDetailDto> CommitDetailAsync(string hash, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        if (!System.Text.RegularExpressions.Regex.IsMatch(hash, "^[0-9a-fA-F]{4,40}$")) throw new ArgumentException("Not a commit hash");
        var message = (await RunOkAsync(repo, ["show", "-s", "--pretty=format:%B", hash], ct)).TrimEnd();
        var raw = await RunOkAsync(repo, ["show", "--pretty=format:", "--name-status", "-M", "-z", hash], ct);
        var parts = raw.Split('\0', StringSplitOptions.RemoveEmptyEntries).Select(p => p.Trim('\n')).Where(p => p.Length > 0).ToList();
        var files = new List<GitCommitFileDto>();
        for (var i = 0; i < parts.Count; i++)
        {
            var status = parts[i];
            if (status.StartsWith('R') || status.StartsWith('C'))
            {
                var from = parts[++i];
                var to = parts[++i];
                files.Add(new GitCommitFileDto(status[..1], Abs(repo, to), Abs(repo, from)));
            }
            else files.Add(new GitCommitFileDto(status[..1], Abs(repo, parts[++i]), null));
        }
        return new GitCommitDetailDto(hash, message, files);
    }

    // ------------------------------------------------------------------ blame

    public async Task<IReadOnlyList<GitBlameLineDto>> BlameAsync(string path, string? text, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        // no commit yet: git blame fails ("no such ref: HEAD"), but every line is simply not committed yet
        if ((await RunAsync(repo, ["rev-parse", "--verify", "HEAD"], ct)).Code != 0)
        {
            var count = (text ?? await File.ReadAllTextAsync(path, ct)).Split('\n').Length;
            return Enumerable.Range(1, count).Select(n => new GitBlameLineDto(n, new string('0', 40), "", 0, "")).ToList();
        }
        // --contents - blames the editor's text, so unsaved lines show as "Not committed yet"
        var args = new List<string> { "blame", "--porcelain" };
        if (text is not null) args.AddRange(["--contents", "-"]);
        args.Add("--");
        args.Add(Rel(repo, path));
        var r = await RunAsync(repo, args, ct, stdin: text);
        if (r.Code != 0) throw new InvalidOperationException(FirstLine(r.Err) ?? "git blame failed");
        var info = new Dictionary<string, (string Author, long Time, string Summary)>();
        var list = new List<GitBlameLineDto>();
        string? hash = null;
        var line = 0;
        string author = "", summary = "";
        long time = 0;
        foreach (var l in r.Out.Split('\n'))
        {
            if (l.StartsWith('\t'))
            {
                if (hash is null) continue;
                if (!info.ContainsKey(hash)) info[hash] = (author, time, summary);
                var (a, t, s) = info[hash];
                list.Add(new GitBlameLineDto(line, hash, a, t, s));
                continue;
            }
            var sp = l.Split(' ');
            if (sp.Length >= 3 && sp[0].Length == 40 && sp[0].All(Uri.IsHexDigit))
            {
                hash = sp[0];
                line = int.Parse(sp[2]);
                if (info.TryGetValue(hash, out var known)) (author, time, summary) = known;
            }
            else if (l.StartsWith("author ", StringComparison.Ordinal)) author = l[7..];
            else if (l.StartsWith("author-time ", StringComparison.Ordinal)) time = long.Parse(l[12..]);
            else if (l.StartsWith("summary ", StringComparison.Ordinal)) summary = l[8..];
        }
        return list;
    }

    // ------------------------------------------------------------------ remotes

    public async Task<IReadOnlyList<GitRemoteDto>> RemotesAsync(CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var raw = await RunOkAsync(repo, ["remote", "-v"], ct);
        var map = new Dictionary<string, (string? Fetch, string? Push)>();
        foreach (var line in raw.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var m = System.Text.RegularExpressions.Regex.Match(line.Trim(), @"^(\S+)\s+(\S+)\s+\((fetch|push)\)$");
            if (!m.Success) continue;
            var cur = map.GetValueOrDefault(m.Groups[1].Value);
            map[m.Groups[1].Value] = m.Groups[3].Value == "fetch" ? (m.Groups[2].Value, cur.Push) : (cur.Fetch, m.Groups[2].Value);
        }
        return map.Select(kv => new GitRemoteDto(kv.Key, kv.Value.Fetch ?? kv.Value.Push ?? "", kv.Value.Push ?? kv.Value.Fetch ?? "")).OrderBy(r => r.Name != "origin").ThenBy(r => r.Name).ToList();
    }

    private static void CheckRemote(string name, string url)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9._/-]*$")) throw new ArgumentException($"'{name}' is not a valid remote name");
        if (string.IsNullOrWhiteSpace(url) || url.StartsWith('-')) throw new ArgumentException("Enter the remote's URL");
    }

    public async Task AddRemoteAsync(string name, string url, CancellationToken ct)
    {
        CheckRemote(name, url);
        var repo = await RepoAsync(ct);
        await RunOkAsync(repo, ["remote", "add", name, url.Trim()], ct);
        Changed();
    }

    public async Task UpdateRemoteAsync(string oldName, string name, string url, CancellationToken ct)
    {
        CheckRemote(name, url);
        var repo = await RepoAsync(ct);
        if (oldName != name) await RunOkAsync(repo, ["remote", "rename", oldName, name], ct);
        await RunOkAsync(repo, ["remote", "set-url", name, url.Trim()], ct);
        Changed();
    }

    public async Task RemoveRemoteAsync(string name, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        await RunOkAsync(repo, ["remote", "remove", name], ct);
        Changed();
    }

    // ------------------------------------------------------------------ init

    public async Task InitAsync(CancellationToken ct)
    {
        var root = workspace.Root ?? throw new InvalidOperationException("No folder is open");
        await RunOkAsync(root, ["init"], ct);
        cachedFor = null;
        Changed();
    }
}
