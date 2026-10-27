using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Kod.Engine.Infrastructure;

namespace Kod.Engine.Workspace;

public sealed record HistoryRevisionDto(string Id, long Time, string Label, int Size);

public sealed record HistoryLabelBody(string Path, string? Text, string Label);

public sealed record HistoryChangeFileDto(string Path, string Id, string? PrevId, bool Exists);

/// <param name="Kind">"change" (files saved together) or "label" (a project label).</param>
public sealed record HistoryChangeDto(string Kind, long Time, string Label, IReadOnlyList<HistoryChangeFileDto> Files);

public sealed record HistorySelectionBody(string Path, string Text, int StartLine, int EndLine);

public sealed record ProjectLabelBody(string? Root, string Label);

/// <summary>
/// Rider's Local History: every save (and every delete) keeps a revision of the file outside Git, under the local
/// app data folder, one folder per file. Revisions older than 30 days, and beyond 200 per file, are dropped.
/// </summary>
public sealed class LocalHistoryService(ILogger<LocalHistoryService> log)
{
    private const int MaxPerFile = 200;
    private static readonly TimeSpan Keep = TimeSpan.FromDays(30);
    private const int MaxSize = 4 * 1024 * 1024;
    private readonly object sync = new();

    private sealed record Entry(string Id, long Time, string Label, int Size, string Hash);

    private sealed class Index
    {
        public string Path { get; set; } = "";
        public List<Entry> Revisions { get; set; } = [];
    }

    public static string Root => System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kod", "history");

    private static string Hash(string s) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(s)))[..20].ToLowerInvariant();

    private static string DirOf(string path) => System.IO.Path.Combine(Root, Hash(PathUtil.Normalize(path).ToLowerInvariant()));

    private static Index Load(string dir)
    {
        try
        {
            var file = System.IO.Path.Combine(dir, "index.json");
            return File.Exists(file) ? JsonSerializer.Deserialize<Index>(File.ReadAllText(file)) ?? new Index() : new Index();
        }
        catch (JsonException)
        {
            return new Index();
        }
    }

    private static void Save(string dir, Index index) =>
        File.WriteAllText(System.IO.Path.Combine(dir, "index.json"), JsonSerializer.Serialize(index));

    /// <summary>Keeps <paramref name="text"/> as a revision of the file, unless it equals the latest one.</summary>
    public void Record(string path, string text, string label)
    {
        if (text.Length > MaxSize) return;
        try
        {
            lock (sync)
            {
                var dir = DirOf(path);
                Directory.CreateDirectory(dir);
                var index = Load(dir);
                index.Path = PathUtil.Normalize(path);
                var hash = Hash(text);
                if (index.Revisions.Count > 0 && index.Revisions[^1].Hash == hash && label is "Saved" or "External change") return;
                var id = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid().ToString("N")[..6]}";
                File.WriteAllText(System.IO.Path.Combine(dir, id + ".txt"), text, new UTF8Encoding(false));
                index.Revisions.Add(new Entry(id, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), label, text.Length, hash));
                var cutoff = DateTimeOffset.UtcNow.Add(-Keep).ToUnixTimeMilliseconds();
                foreach (var old in index.Revisions.Where((r, i) => r.Time < cutoff || i < index.Revisions.Count - MaxPerFile).ToList())
                {
                    index.Revisions.Remove(old);
                    File.Delete(System.IO.Path.Combine(dir, old.Id + ".txt"));
                }
                Save(dir, index);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log.LogDebug(ex, "Local history could not record {Path}", path);
        }
    }

    /// <summary>Before a save overwrites a file: its first state goes into the history too.</summary>
    public void RecordBaseline(string path)
    {
        try
        {
            if (!File.Exists(path) || new FileInfo(path).Length > MaxSize) return;
            lock (sync)
                if (Load(DirOf(path)).Revisions.Count > 0) return;
            Record(path, File.ReadAllText(path), "Before the first change");
        }
        catch (IOException)
        {
        }
    }

    public IReadOnlyList<HistoryRevisionDto> List(string path)
    {
        lock (sync)
            return Load(DirOf(path)).Revisions.AsEnumerable().Reverse().Select(r => new HistoryRevisionDto(r.Id, r.Time, r.Label, r.Size)).ToList();
    }

    public string Text(string path, string id)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[0-9]+-[0-9a-f]{6}$")) throw new ArgumentException("Unknown revision");
        var file = System.IO.Path.Combine(DirOf(path), id + ".txt");
        return File.Exists(file) ? File.ReadAllText(file) : throw new FileNotFoundException("That revision is gone");
    }

    /// <summary>Whether the file has a history (only files someone edited in Kod record external changes).</summary>
    public bool Has(string path) => Directory.Exists(DirOf(path));

    // ------------------------------------------------------------------ project history (Rider's Local History of a folder)

    private sealed record ProjectLabel(long Time, string Root, string Label);

    private static string LabelsFile => System.IO.Path.Combine(Root, "labels.json");

    /// <summary>A label across the project ("Commit", "Build", or the user's own), shown between the changes.</summary>
    public void PutProjectLabel(string root, string label)
    {
        lock (sync)
        {
            try
            {
                Directory.CreateDirectory(Root);
                var list = LoadLabels();
                list.Add(new ProjectLabel(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), PathUtil.Normalize(root), label.Trim()));
                var cutoff = DateTimeOffset.UtcNow.Add(-Keep).ToUnixTimeMilliseconds();
                File.WriteAllText(LabelsFile, JsonSerializer.Serialize(list.Where(l => l.Time >= cutoff).TakeLast(2000).ToList()));
            }
            catch (IOException ex)
            {
                log.LogDebug(ex, "Could not put the project label");
            }
        }
    }

    private static List<ProjectLabel> LoadLabels()
    {
        try
        {
            return File.Exists(LabelsFile) ? JsonSerializer.Deserialize<List<ProjectLabel>>(File.ReadAllText(LabelsFile)) ?? [] : [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>
    /// The changes under a folder, newest first: revisions of several files made together (a save of all files, a
    /// rename, a refactoring, a revert) form one change; project labels sit between them. Each file of a change carries
    /// the revision before it, so the change can be shown (and reverted) as what it did.
    /// </summary>
    public IReadOnlyList<HistoryChangeDto> Changes(string folder, int limit = 300)
    {
        var prefix = PathUtil.Normalize(folder).TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar;
        var all = new List<(string Path, Entry Rev, string? Prev, bool Exists)>();
        lock (sync)
        {
            if (!Directory.Exists(Root)) return [];
            foreach (var dir in Directory.EnumerateDirectories(Root))
            {
                var index = Load(dir);
                if (index.Revisions.Count == 0 || !index.Path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                var exists = File.Exists(index.Path);
                for (var i = 0; i < index.Revisions.Count; i++)
                    all.Add((index.Path, index.Revisions[i], i > 0 ? index.Revisions[i - 1].Id : null, exists));
            }
        }
        var changes = new List<HistoryChangeDto>();
        // newest first; one change = the same label within two seconds
        foreach (var r in all.OrderByDescending(x => x.Rev.Time))
        {
            // the snapshot taken before the first save is where a file started, not a change (it is the next change's "before")
            if (r.Rev.Label == "Before the first change") continue;
            var last = changes.Count > 0 ? changes[^1] : null;
            var file = new HistoryChangeFileDto(r.Path, r.Rev.Id, r.Prev, r.Exists);
            if (last is not null && last.Label == r.Rev.Label && last.Time - r.Rev.Time <= 2000 && last.Files.All(f => !PathUtil.Equal(f.Path, r.Path)))
                changes[^1] = last with { Files = [.. last.Files, file] };
            else
            {
                if (changes.Count >= limit) break;
                changes.Add(new HistoryChangeDto("change", r.Rev.Time, r.Rev.Label, [file]));
            }
        }
        var root = PathUtil.Normalize(folder);
        List<ProjectLabel> labels;
        lock (sync) labels = LoadLabels();
        var oldest = changes.Count > 0 ? changes[^1].Time : 0;
        foreach (var l in labels.Where(l => l.Time >= oldest && (PathUtil.Equal(l.Root, root) || PathUtil.IsUnder(root, l.Root) || PathUtil.IsUnder(l.Root, root))))
            changes.Add(new HistoryChangeDto("label", l.Time, l.Label, []));
        return changes.OrderByDescending(c => c.Time).ToList();
    }

    /// <summary>
    /// History for a selection: the revisions in which the selected lines read differently from the next newer one
    /// (the lines are found in each revision by the unchanged lines around them).
    /// </summary>
    public IReadOnlyList<HistoryRevisionDto> ForSelection(string path, string current, int startLine, int endLine)
    {
        var lines = current.Replace("\r\n", "\n").Split('\n');
        startLine = Math.Clamp(startLine, 1, lines.Length);
        endLine = Math.Clamp(endLine, startLine, lines.Length);
        // the nearest non-blank lines just outside the selection anchor it in older versions
        string? Anchor(int from, int step)
        {
            for (var i = from; i >= 0 && i < lines.Length; i += step)
                if (lines[i].Trim().Length > 0) return lines[i];
            return null;
        }
        var top = Anchor(startLine - 2, -1);
        var bottom = Anchor(endLine, 1);
        string Region(string text)
        {
            var t = text.Replace("\r\n", "\n").Split('\n');
            var s = top is null ? 0 : Array.FindIndex(t, l => l == top) + 1;
            if (s < 0 || (top is not null && s == 0)) return text;
            var e = bottom is null ? t.Length : Array.FindIndex(t, s, l => l == bottom);
            if (e < 0) return text;
            return string.Join('\n', t[s..e]);
        }
        var list = new List<HistoryRevisionDto>();
        var newer = Region(current);
        foreach (var r in List(path))
        {
            string text;
            try
            {
                text = Text(path, r.Id);
            }
            catch (FileNotFoundException)
            {
                continue;
            }
            var region = Region(text);
            if (region != newer) list.Add(r);
            newer = region;
        }
        return list;
    }

    /// <summary>Files under a folder that have a history, newest change first (Local History of a folder, deleted files).</summary>
    public IReadOnlyList<object> Under(string folder)
    {
        var list = new List<(string Path, long Time, string Label, bool Exists)>();
        if (!Directory.Exists(Root)) return [];
        var prefix = PathUtil.Normalize(folder).TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar;
        foreach (var dir in Directory.EnumerateDirectories(Root))
        {
            var index = Load(dir);
            if (index.Revisions.Count == 0 || !index.Path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            var last = index.Revisions[^1];
            list.Add((index.Path, last.Time, last.Label, File.Exists(index.Path)));
        }
        return list.OrderByDescending(x => x.Time).Take(500).Select(x => (object)new { path = x.Path, time = x.Time, label = x.Label, exists = x.Exists }).ToList();
    }
}
