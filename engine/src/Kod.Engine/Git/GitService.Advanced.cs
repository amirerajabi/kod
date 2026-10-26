using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kod.Engine.Infrastructure;

namespace Kod.Engine.Git;

public sealed record ConflictDto(string Path, string Base, string Ours, string Theirs, string Merged, string? Operation);

public sealed record GitStashDto(string Ref, string Hash, long Time, string Message);

public sealed record GitShelfDto(string Id, string Name, long Time, IReadOnlyList<string> Files);

public sealed record RebaseCommitDto(string Hash, string Short, string Subject, string Author);

/// <summary>One step of an interactive rebase: pick, reword (with <see cref="Message"/>), edit, squash, fixup or drop.</summary>
public sealed record RebaseStepDto(string Hash, string Action, string? Message);

public sealed record DiffLineDto(char Kind, string Text);

public sealed record DiffHunkDto(string Header, int OldStart, int OldCount, int NewStart, int NewCount, IReadOnlyList<DiffLineDto> Lines);

public sealed record FileHunksDto(string Path, IReadOnlyList<string> FileHeader, IReadOnlyList<DiffHunkDto> Hunks, bool Binary);

/// <summary>A file committed in part: the chosen hunks, each with the indexes (into its lines) of the chosen changed lines,
/// or null for the whole hunk.</summary>
public sealed record PartialHunkDto(int Index, IReadOnlyList<int>? Lines);

public sealed record PartialFileDto(string Path, IReadOnlyList<PartialHunkDto> Hunks);

/// <summary>Merge conflicts, merge / rebase / cherry-pick state, stash, shelf, cherry-pick, revert, reset, interactive
/// rebase and partial (hunk / line) commits.</summary>
public sealed partial class GitService
{
    private static readonly Dictionary<string, string> NoEditor = new() { ["GIT_EDITOR"] = "true", ["GIT_SEQUENCE_EDITOR"] = "true" };

    private static void CheckRev(string rev)
    {
        if (!Regex.IsMatch(rev, @"^[0-9a-fA-F]{4,40}$|^stash@\{\d+\}$")) throw new ArgumentException("Not a commit");
    }

    private async Task<string> GitDirAsync(string repo, CancellationToken ct) =>
        PathUtil.Normalize((await RunOkAsync(repo, ["rev-parse", "--absolute-git-dir"], ct)).Trim());

    // ------------------------------------------------------------------ operation in progress

    /// <summary>"merge", "rebase", "cherry-pick" or "revert" while one is stopped; null otherwise.</summary>
    private async Task<string?> OperationAsync(string repo, CancellationToken ct)
    {
        try
        {
            var dir = await GitDirAsync(repo, ct);
            if (Directory.Exists(Path.Combine(dir, "rebase-merge")) || Directory.Exists(Path.Combine(dir, "rebase-apply"))) return "rebase";
            if (File.Exists(Path.Combine(dir, "MERGE_HEAD"))) return "merge";
            if (File.Exists(Path.Combine(dir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
            if (File.Exists(Path.Combine(dir, "REVERT_HEAD"))) return "revert";
        }
        catch (InvalidOperationException)
        {
        }
        return null;
    }

    /// <summary>Continue, abort or skip the stopped merge / rebase / cherry-pick / revert.</summary>
    public async Task<string> OperationActionAsync(string action, CancellationToken ct)
    {
        if (action is not ("continue" or "abort" or "skip")) throw new ArgumentException("Unknown action");
        var repo = await RepoAsync(ct);
        var op = await OperationAsync(repo, ct) ?? throw new InvalidOperationException("No merge, rebase or cherry-pick is in progress");
        if (action == "skip" && op == "merge") throw new InvalidOperationException("A merge cannot be skipped");
        var r = await RunAsync(repo, [op, $"--{action}"], ct, timeoutMs: 120_000, env: NoEditor);
        Changed();
        if (r.Code != 0 && await OperationAsync(repo, ct) is null) throw new InvalidOperationException(FirstLine(r.Err) ?? FirstLine(r.Out) ?? $"git {op} --{action} failed");
        var name = char.ToUpperInvariant(op[0]) + op[1..];
        return await OperationAsync(repo, ct) is { } still
            ? $"The {still} stopped again: {FirstLine(r.Out) ?? FirstLine(r.Err) ?? "resolve the conflicts"}"
            : $"{name} {(action == "continue" ? "completed" : action == "abort" ? "aborted" : "step skipped")}";
    }

    // ------------------------------------------------------------------ conflicts

    public async Task<ConflictDto> ConflictAsync(string path, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var rel = Rel(repo, path);
        async Task<string> Stage(int n)
        {
            var r = await RunAsync(repo, ["show", $":{n}:{rel}"], ct);
            return r.Code == 0 ? r.Out : "";
        }
        var merged = File.Exists(path) ? await File.ReadAllTextAsync(path, ct) : "";
        return new ConflictDto(PathUtil.Normalize(path), await Stage(1), await Stage(2), await Stage(3), merged, await OperationAsync(repo, ct));
    }

    /// <summary>Writes the merge result and marks the file resolved.</summary>
    public async Task ResolveAsync(string path, string text, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        await File.WriteAllTextAsync(path, text, new UTF8Encoding(false), ct);
        await RunOkAsync(repo, ["add", "--", Rel(repo, path)], ct);
        Changed();
    }

    /// <summary>Accept Yours / Accept Theirs for whole files.</summary>
    public async Task AcceptSideAsync(IReadOnlyList<string> paths, string side, CancellationToken ct)
    {
        if (side is not ("ours" or "theirs")) throw new ArgumentException("Unknown side");
        var repo = await RepoAsync(ct);
        var rels = paths.Select(p => Rel(repo, p)).ToList();
        var r = await RunAsync(repo, ["checkout", $"--{side}", "--", .. rels], ct);
        // a file deleted on that side: accepting it means deleting it
        if (r.Code != 0) await RunOkAsync(repo, ["rm", "-q", "--", .. rels], ct);
        else await RunOkAsync(repo, ["add", "--", .. rels], ct);
        Changed();
    }

    // ------------------------------------------------------------------ commits from the log

    public async Task CherryPickAsync(string hash, CancellationToken ct)
    {
        CheckRev(hash);
        var repo = await RepoAsync(ct);
        var r = await RunAsync(repo, ["cherry-pick", hash], ct, timeoutMs: 120_000, env: NoEditor);
        Changed();
        if (r.Code != 0 && await OperationAsync(repo, ct) is null) throw new InvalidOperationException(FirstLine(r.Err) ?? "git cherry-pick failed");
    }

    public async Task RevertCommitAsync(string hash, CancellationToken ct)
    {
        CheckRev(hash);
        var repo = await RepoAsync(ct);
        var r = await RunAsync(repo, ["revert", "--no-edit", hash], ct, timeoutMs: 120_000, env: NoEditor);
        Changed();
        if (r.Code != 0 && await OperationAsync(repo, ct) is null) throw new InvalidOperationException(FirstLine(r.Err) ?? "git revert failed");
    }

    public async Task ResetAsync(string hash, string mode, CancellationToken ct)
    {
        CheckRev(hash);
        if (mode is not ("soft" or "mixed" or "hard" or "keep")) throw new ArgumentException("Unknown reset mode");
        var repo = await RepoAsync(ct);
        await RunOkAsync(repo, ["reset", $"--{mode}", hash], ct);
        Changed();
    }

    public async Task CheckoutRevisionAsync(string hash, CancellationToken ct)
    {
        CheckRev(hash);
        var repo = await RepoAsync(ct);
        await RunOkAsync(repo, ["switch", "--detach", hash], ct);
        Changed();
    }

    public async Task BranchAtAsync(string name, string hash, bool checkout, CancellationToken ct)
    {
        CheckRev(hash);
        if (!Regex.IsMatch(name, @"^[^\s~^:?*\[\\]+$") || name.StartsWith('-')) throw new ArgumentException("Not a valid branch name");
        var repo = await RepoAsync(ct);
        await RunOkAsync(repo, checkout ? ["switch", "-c", name, hash] : ["branch", name, hash], ct);
        Changed();
    }

    // ------------------------------------------------------------------ interactive rebase

    /// <summary>The commits an interactive rebase from <paramref name="hash"/> (inclusive) rewrites, oldest first.</summary>
    public async Task<IReadOnlyList<RebaseCommitDto>> RebasePlanAsync(string hash, CancellationToken ct)
    {
        CheckRev(hash);
        var repo = await RepoAsync(ct);
        var isRoot = (await RunAsync(repo, ["rev-parse", "--verify", "-q", $"{hash}^"], ct)).Code != 0;
        var range = isRoot ? "HEAD" : $"{hash}^..HEAD";
        var raw = await RunOkAsync(repo, ["log", "--reverse", "--first-parent", "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1e", range], ct);
        var list = raw.Split('\x1e', StringSplitOptions.RemoveEmptyEntries)
            .Select(r => r.Trim('\n', '\r').Split('\x1f'))
            .Where(f => f.Length >= 4)
            .Select(f => new RebaseCommitDto(f[0], f[1], f[2], f[3]))
            .ToList();
        if (list.Count == 0 || !list.Any(c => c.Hash.StartsWith(hash, StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("That commit is not in the current branch's history");
        return list;
    }

    /// <summary>Runs git rebase -i with the given plan (git's own sequencer: conflicts and "edit" stop it as usual).</summary>
    public async Task<string> RebaseAsync(string hash, IReadOnlyList<RebaseStepDto> steps, CancellationToken ct)
    {
        CheckRev(hash);
        var repo = await RepoAsync(ct);
        if (await OperationAsync(repo, ct) is { } op) throw new InvalidOperationException($"A {op} is already in progress");
        var known = (await RebasePlanAsync(hash, ct)).ToDictionary(c => c.Hash);
        if (steps.Count == 0 || steps.Any(s => !known.ContainsKey(s.Hash))) throw new ArgumentException("The plan does not match the branch");
        var first = steps.FirstOrDefault(s => s.Action != "drop");
        if (first?.Action is "squash" or "fixup") throw new ArgumentException("The first commit cannot be squashed into a previous one");

        var tmp = Path.Combine(Path.GetTempPath(), $"kod-rebase-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tmp);
        static string Sh(string p) => "'" + p.Replace('\\', '/').Replace("'", "'\\''") + "'";
        var todo = new StringBuilder();
        var n = 0;
        foreach (var s in steps)
        {
            switch (s.Action)
            {
                case "pick" or "edit" or "squash" or "fixup" or "drop":
                    todo.Append(s.Action).Append(' ').Append(s.Hash).Append('\n');
                    break;
                case "reword":
                    todo.Append("pick ").Append(s.Hash).Append('\n');
                    var msg = Path.Combine(tmp, $"msg{++n}.txt");
                    await File.WriteAllTextAsync(msg, (s.Message ?? "").Trim() + "\n", new UTF8Encoding(false), ct);
                    todo.Append("exec git commit --amend --allow-empty --no-verify -F ").Append(Sh(msg)).Append('\n');
                    break;
                default:
                    throw new ArgumentException($"Unknown rebase action '{s.Action}'");
            }
        }
        var todoFile = Path.Combine(tmp, "todo.txt");
        await File.WriteAllTextAsync(todoFile, todo.ToString(), new UTF8Encoding(false), ct);
        var env = new Dictionary<string, string> { ["GIT_SEQUENCE_EDITOR"] = $"cp {Sh(todoFile)}", ["GIT_EDITOR"] = "true" };
        var isRoot = (await RunAsync(repo, ["rev-parse", "--verify", "-q", $"{hash}^"], ct)).Code != 0;
        var r = await RunAsync(repo, ["rebase", "-i", "--autostash", isRoot ? "--root" : $"{hash}^"], ct, timeoutMs: 300_000, env: env);
        Changed();
        // the exec lines read the message files; keep them while the rebase is stopped
        if (await OperationAsync(repo, ct) is null)
        {
            try
            {
                Directory.Delete(tmp, true);
            }
            catch (IOException)
            {
            }
            if (r.Code != 0) throw new InvalidOperationException(FirstLine(r.Err) ?? "git rebase failed");
            return "Rebase done";
        }
        return "The rebase stopped: " + (FirstLine(r.Err) ?? FirstLine(r.Out) ?? "resolve the conflicts or finish the edit, then continue");
    }

    // ------------------------------------------------------------------ stash

    public async Task<IReadOnlyList<GitStashDto>> StashesAsync(CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var r = await RunAsync(repo, ["stash", "list", "--format=%gd%x1f%H%x1f%ct%x1f%gs"], ct);
        if (r.Code != 0) return [];
        return r.Out.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Split('\x1f'))
            .Where(f => f.Length >= 4)
            .Select(f => new GitStashDto(f[0], f[1], long.TryParse(f[2], out var t) ? t * 1000 : 0, f[3]))
            .ToList();
    }

    public async Task StashAsync(string? message, bool includeUntracked, IReadOnlyList<string>? paths, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var args = new List<string> { "stash", "push" };
        if (includeUntracked) args.Add("--include-untracked");
        if (!string.IsNullOrWhiteSpace(message)) args.AddRange(["-m", message.Trim()]);
        if (paths is { Count: > 0 })
        {
            args.Add("--");
            args.AddRange(paths.Select(p => Rel(repo, p)));
        }
        await RunOkAsync(repo, args, ct);
        Changed();
    }

    public async Task StashActionAsync(string stashRef, string action, CancellationToken ct)
    {
        CheckRev(stashRef);
        if (action is not ("apply" or "pop" or "drop")) throw new ArgumentException("Unknown stash action");
        var repo = await RepoAsync(ct);
        var r = await RunAsync(repo, ["stash", action, "--index", stashRef], ct);
        // --index fails when the index cannot be restored exactly: retry without it
        if (r.Code != 0 && action != "drop") r = await RunAsync(repo, ["stash", action, stashRef], ct);
        else if (r.Code != 0) r = await RunAsync(repo, ["stash", "drop", stashRef], ct);
        Changed();
        if (r.Code != 0) throw new InvalidOperationException(FirstLine(r.Err) ?? $"git stash {action} failed");
    }

    public async Task<IReadOnlyList<GitCommitFileDto>> StashFilesAsync(string stashRef, CancellationToken ct)
    {
        CheckRev(stashRef);
        var repo = await RepoAsync(ct);
        var files = new List<GitCommitFileDto>();
        foreach (var line in (await RunOkAsync(repo, ["stash", "show", "--name-status", stashRef], ct)).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var f = line.Split('\t');
            if (f.Length >= 2) files.Add(new GitCommitFileDto(f[0][..1], Abs(repo, f[^1]), f.Length > 2 ? Abs(repo, f[1]) : null));
        }
        // untracked files live in the stash's third parent
        var u = await RunAsync(repo, ["show", "--pretty=format:", "--name-only", $"{stashRef}^3"], ct);
        if (u.Code == 0)
            foreach (var rel in u.Out.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                files.Add(new GitCommitFileDto("U", Abs(repo, rel.Trim()), null));
        return files;
    }

    // ------------------------------------------------------------------ shelf

    private async Task<string> ShelfDirAsync(string repo, CancellationToken ct)
    {
        var dir = Path.Combine(await GitDirAsync(repo, ct), "kod-shelf");
        Directory.CreateDirectory(dir);
        return dir;
    }

    public async Task<IReadOnlyList<GitShelfDto>> ShelvesAsync(CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var dir = await ShelfDirAsync(repo, ct);
        var list = new List<GitShelfDto>();
        foreach (var json in Directory.EnumerateFiles(dir, "*.json"))
        {
            try
            {
                if (JsonSerializer.Deserialize<GitShelfDto>(await File.ReadAllTextAsync(json, ct)) is { } s) list.Add(s);
            }
            catch (JsonException)
            {
            }
        }
        return list.OrderByDescending(s => s.Time).ToList();
    }

    /// <summary>Saves the changes of the files as a patch outside the working tree, then (unless kept) rolls them back.</summary>
    public async Task<GitShelfDto> ShelveAsync(string name, IReadOnlyList<string> paths, bool keep, CancellationToken ct)
    {
        if (paths.Count == 0) throw new ArgumentException("Choose the files to shelve");
        var repo = await RepoAsync(ct);
        var status = await StatusAsync(ct);
        var rels = paths.Select(p => Rel(repo, p)).ToList();
        var untracked = status.Files.Where(f => f.Untracked && paths.Any(p => PathUtil.Equal(p, f.Path))).Select(f => f.Rel).ToList();
        // new files: "intent to add" makes them part of the diff
        if (untracked.Count > 0) await RunOkAsync(repo, ["add", "-N", "--", .. untracked], ct);
        string patch;
        try
        {
            patch = await RunOkAsync(repo, ["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--", .. rels], ct);
        }
        finally
        {
            if (untracked.Count > 0) await RunAsync(repo, ["reset", "-q", "--", .. untracked], ct);
        }
        if (string.IsNullOrWhiteSpace(patch)) throw new InvalidOperationException("Those files have no changes to shelve");
        var dir = await ShelfDirAsync(repo, ct);
        var id = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        var shelf = new GitShelfDto(id, string.IsNullOrWhiteSpace(name) ? $"Shelved {DateTime.Now:g}" : name.Trim(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), rels);
        await File.WriteAllTextAsync(Path.Combine(dir, id + ".patch"), patch, new UTF8Encoding(false), ct);
        await File.WriteAllTextAsync(Path.Combine(dir, id + ".json"), JsonSerializer.Serialize(shelf), ct);
        if (!keep) await DiscardAsync(paths, ct);
        Changed();
        return shelf;
    }

    public async Task UnshelveAsync(string id, bool remove, CancellationToken ct)
    {
        if (!Regex.IsMatch(id, @"^\d+$")) throw new ArgumentException("Unknown shelf");
        var repo = await RepoAsync(ct);
        var dir = await ShelfDirAsync(repo, ct);
        var patch = Path.Combine(dir, id + ".patch");
        if (!File.Exists(patch)) throw new FileNotFoundException("That shelf is gone");
        var r = await RunAsync(repo, ["apply", "--whitespace=nowarn", patch], ct);
        if (r.Code != 0)
        {
            // the files changed since: a three-way apply leaves conflict markers instead of failing
            r = await RunAsync(repo, ["apply", "--3way", "--whitespace=nowarn", patch], ct);
            if (r.Code != 0) throw new InvalidOperationException(FirstLine(r.Err) ?? "The shelved changes do not apply");
        }
        if (remove) DeleteShelfFiles(dir, id);
        Changed();
    }

    public async Task DeleteShelfAsync(string id, CancellationToken ct)
    {
        if (!Regex.IsMatch(id, @"^\d+$")) throw new ArgumentException("Unknown shelf");
        DeleteShelfFiles(await ShelfDirAsync(await RepoAsync(ct), ct), id);
        Changed();
    }

    public async Task<string> ShelfPatchAsync(string id, CancellationToken ct)
    {
        if (!Regex.IsMatch(id, @"^\d+$")) throw new ArgumentException("Unknown shelf");
        var file = Path.Combine(await ShelfDirAsync(await RepoAsync(ct), ct), id + ".patch");
        return File.Exists(file) ? await File.ReadAllTextAsync(file, ct) : throw new FileNotFoundException("That shelf is gone");
    }

    private static void DeleteShelfFiles(string dir, string id)
    {
        File.Delete(Path.Combine(dir, id + ".patch"));
        File.Delete(Path.Combine(dir, id + ".json"));
    }

    // ------------------------------------------------------------------ hunks and partial commits

    private static readonly Regex HunkHeader = new(@"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", RegexOptions.Compiled);

    private static FileHunksDto ParseDiff(string path, string diff)
    {
        var header = new List<string>();
        var hunks = new List<DiffHunkDto>();
        List<DiffLineDto>? lines = null;
        Match? h = null;
        string? hText = null;
        var binary = false;
        void Close()
        {
            if (h is null || lines is null) return;
            hunks.Add(new DiffHunkDto(hText!, int.Parse(h.Groups[1].Value), h.Groups[2].Success ? int.Parse(h.Groups[2].Value) : 1,
                int.Parse(h.Groups[3].Value), h.Groups[4].Success ? int.Parse(h.Groups[4].Value) : 1, lines));
        }
        foreach (var raw in diff.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            var m = HunkHeader.Match(line);
            if (m.Success)
            {
                Close();
                h = m;
                hText = line;
                lines = [];
                continue;
            }
            if (lines is null)
            {
                if (line.StartsWith("Binary files", StringComparison.Ordinal) || line.StartsWith("GIT binary patch", StringComparison.Ordinal)) binary = true;
                if (line.Length > 0) header.Add(line);
                continue;
            }
            if (line.Length == 0) continue;
            if (line[0] is ' ' or '+' or '-' or '\\') lines.Add(new DiffLineDto(line[0], line[1..]));
        }
        Close();
        return new FileHunksDto(path, header, hunks, binary);
    }

    /// <summary>The changes of a file against HEAD, as hunks (the Commit window's partial selection).</summary>
    public async Task<FileHunksDto> HunksAsync(string path, CancellationToken ct)
    {
        var repo = await RepoAsync(ct);
        var diff = await RunOkAsync(repo, ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3", "--", Rel(repo, path)], ct);
        return ParseDiff(PathUtil.Normalize(path), diff);
    }

    /// <summary>A patch with only the chosen hunks and lines: an unchosen "-" line stays as context, an unchosen "+" line is left out.</summary>
    private static string PartialPatch(FileHunksDto file, PartialFileDto choice)
    {
        var sb = new StringBuilder();
        foreach (var l in file.FileHeader) sb.Append(l).Append('\n');
        var delta = 0;
        var any = false;
        foreach (var pick in choice.Hunks.OrderBy(x => x.Index))
        {
            if (pick.Index < 0 || pick.Index >= file.Hunks.Count) continue;
            var hunk = file.Hunks[pick.Index];
            var chosen = pick.Lines is null ? null : new HashSet<int>(pick.Lines);
            var body = new List<string>();
            int oldCount = 0, newCount = 0, changes = 0;
            for (var i = 0; i < hunk.Lines.Count; i++)
            {
                var l = hunk.Lines[i];
                var on = chosen is null || chosen.Contains(i);
                switch (l.Kind)
                {
                    case ' ':
                        body.Add(" " + l.Text);
                        oldCount++;
                        newCount++;
                        break;
                    case '-' when on:
                        body.Add("-" + l.Text);
                        oldCount++;
                        changes++;
                        break;
                    case '-':
                        body.Add(" " + l.Text);
                        oldCount++;
                        newCount++;
                        break;
                    case '+' when on:
                        body.Add("+" + l.Text);
                        newCount++;
                        changes++;
                        break;
                    case '+':
                        // left out: so is its "\ No newline at end of file" marker
                        if (i + 1 < hunk.Lines.Count && hunk.Lines[i + 1].Kind == '\\') i++;
                        break;
                    case '\\':
                        body.Add("\\" + l.Text);
                        break;
                }
            }
            if (changes == 0) continue;
            any = true;
            var newStart = hunk.OldStart + delta;
            sb.Append($"@@ -{hunk.OldStart},{oldCount} +{newStart},{newCount} @@\n");
            foreach (var b in body) sb.Append(b).Append('\n');
            delta += newCount - oldCount;
        }
        return any ? sb.ToString() : "";
    }

    /// <summary>The index becomes HEAD + the whole files + the chosen parts of the partial ones.</summary>
    private async Task StagePartialAsync(string repo, IReadOnlyList<string> whole, IReadOnlyList<PartialFileDto> partial, CancellationToken ct)
    {
        var hasHead = (await RunAsync(repo, ["rev-parse", "--verify", "HEAD"], ct)).Code == 0;
        if (!hasHead) throw new InvalidOperationException("The first commit cannot be partial");
        var patches = new List<string>();
        foreach (var p in partial)
        {
            var hunks = await HunksAsync(p.Path, ct);
            if (hunks.Binary) throw new InvalidOperationException($"{Path.GetFileName(p.Path)} is binary: commit it whole");
            var patch = PartialPatch(hunks, p);
            if (patch.Length > 0) patches.Add(patch);
        }
        await RunOkAsync(repo, ["reset", "-q"], ct);
        var wholeRels = whole.Where(w => !partial.Any(p => PathUtil.Equal(p.Path, w))).Select(w => Rel(repo, w)).ToList();
        if (wholeRels.Count > 0) await RunOkAsync(repo, ["add", "-A", "--", .. wholeRels], ct);
        foreach (var patch in patches) await RunOkAsync(repo, ["apply", "--cached", "--recount", "--whitespace=nowarn", "-"], ct, stdin: patch);
    }
}
