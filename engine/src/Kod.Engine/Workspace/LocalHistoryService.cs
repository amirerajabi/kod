using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Kod.Engine.Infrastructure;

namespace Kod.Engine.Workspace;

public sealed record HistoryRevisionDto(string Id, long Time, string Label, int Size);

public sealed record HistoryLabelBody(string Path, string? Text, string Label);

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
