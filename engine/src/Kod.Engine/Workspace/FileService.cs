using System.Text;
using System.Text.RegularExpressions;
using Kod.Engine.Infrastructure;

namespace Kod.Engine.Workspace;

public sealed record FsEntry(string Name, string Path, bool IsDir, long Size);

public sealed record FileText(string Path, string Text, string Eol, bool ReadOnly);

public sealed record SearchRequest(string Query, bool Regex = false, bool MatchCase = false, bool WholeWord = false, string? Include = null);

public sealed record SearchMatch(int Line, int Column, int Length, string Preview, int PreviewColumn);

public sealed record SearchFileResult(string Path, IReadOnlyList<SearchMatch> Matches);

/// <summary>File system operations for the explorer, editors, go-to-file and find in files.</summary>
public sealed class FileService(WorkspaceService workspace, LocalHistoryService history)
{
    private const long MaxEditableBytes = 8 * 1024 * 1024;

    private static readonly HashSet<string> BinaryExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".dll", ".exe", ".pdb", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".zip", ".nupkg", ".snupkg", ".bmp", ".webp",
        ".woff", ".woff2", ".ttf", ".otf", ".pfx", ".snk", ".7z", ".gz", ".tar", ".mp3", ".mp4", ".pdf", ".db", ".sqlite",
    };

    public IReadOnlyList<FsEntry> List(string dir, bool showIgnored = false)
    {
        dir = PathUtil.Normalize(dir);
        if (!Directory.Exists(dir)) throw new DirectoryNotFoundException($"'{dir}' does not exist");
        var info = new DirectoryInfo(dir);
        var dirs = info.EnumerateDirectories()
            .Where(d => showIgnored || !PathUtil.IgnoredDirs.Contains(d.Name))
            .Where(d => !d.Attributes.HasFlag(FileAttributes.Hidden) || d.Name.StartsWith('.'))
            .OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
            .Select(d => new FsEntry(d.Name, d.FullName, true, 0));
        var files = info.EnumerateFiles()
            .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
            .Select(f => new FsEntry(f.Name, f.FullName, false, f.Length));
        return dirs.Concat(files).ToList();
    }

    /// <summary>Every file under the workspace (for Go to File), capped.</summary>
    public IReadOnlyList<string> AllFiles(int max = 50_000)
    {
        var root = workspace.Root ?? throw new InvalidOperationException("No folder is open");
        var list = new List<string>();
        Walk(root);
        return list;

        void Walk(string dir)
        {
            if (list.Count >= max) return;
            try
            {
                foreach (var f in Directory.EnumerateFiles(dir))
                {
                    list.Add(f);
                    if (list.Count >= max) return;
                }
                foreach (var d in Directory.EnumerateDirectories(dir))
                    if (!PathUtil.IgnoredDirs.Contains(Path.GetFileName(d))) Walk(d);
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    // ------------------------------------------------------------------ TODO window

    private static readonly HashSet<string> TodoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".csx", ".razor", ".cshtml", ".xaml", ".axaml", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".scss", ".less", ".html", ".htm",
        ".sql", ".ps1", ".psm1", ".sh", ".bash", ".py", ".yml", ".yaml", ".xml", ".props", ".targets", ".csproj", ".fs", ".vb", ".proto", ".dockerfile",
    };

    /// <summary>TODO / FIXME / HACK / BUG / NOTE / XXX inside comments (Rider's default patterns, any case).</summary>
    private static readonly Regex TodoPattern = new(@"\b(TODO|FIXME|HACK|BUG|NOTE|XXX)\b[:\s]*(.*)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex CommentStart = new(@"//|/\*|<!--|^\s*\*|^\s*#|^\s*--|^\s*@\*", RegexOptions.Compiled);

    public sealed record TodoDto(string Path, int Line, int Column, string Kind, string Text);

    public IReadOnlyList<TodoDto> Todos(CancellationToken ct)
    {
        var list = new List<TodoDto>();
        foreach (var file in AllFiles())
        {
            ct.ThrowIfCancellationRequested();
            var name = Path.GetFileName(file);
            if (!TodoExtensions.Contains(Path.GetExtension(file)) && !name.Equals("Dockerfile", StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                if (new FileInfo(file).Length > 2 * 1024 * 1024) continue;
                var n = 0;
                foreach (var line in File.ReadLines(file))
                {
                    n++;
                    var c = CommentStart.Match(line);
                    if (!c.Success) continue;
                    var m = TodoPattern.Match(line, c.Index);
                    if (!m.Success) continue;
                    // the comment ends where a block comment closes
                    var text = m.Value;
                    foreach (var close in new[] { "*/", "-->", "*@" })
                        if (text.IndexOf(close, StringComparison.Ordinal) is var at and >= 0) text = text[..at];
                    text = text.Trim();
                    list.Add(new TodoDto(file, n, m.Index + 1, m.Groups[1].Value.ToUpperInvariant(), text.Length > 300 ? text[..300] : text));
                    if (list.Count >= 5000) return list;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
        return list;
    }

    public FileText Read(string path)
    {
        path = PathUtil.Normalize(path);
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException($"'{path}' does not exist");
        if (info.Length > MaxEditableBytes) throw new InvalidOperationException($"{info.Name} is too large to open ({info.Length / 1024 / 1024} MB)");
        if (BinaryExtensions.Contains(info.Extension) || LooksBinary(path)) throw new InvalidOperationException($"{info.Name} is a binary file");
        var text = File.ReadAllText(path);
        var eol = text.Contains("\r\n") ? "\r\n" : text.Contains('\n') ? "\n" : Environment.NewLine;
        return new FileText(path, text, eol, info.IsReadOnly);
    }

    public void Write(string path, string text, string label = "Saved")
    {
        path = PathUtil.Normalize(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        history.RecordBaseline(path);
        // keep a BOM if the file had one
        var bom = File.Exists(path) && HasUtf8Bom(path);
        File.WriteAllText(path, text, new UTF8Encoding(bom));
        history.Record(path, text, label);
    }

    public string Create(string path, bool isDir, string? text)
    {
        path = PathUtil.Normalize(path);
        if (File.Exists(path) || Directory.Exists(path)) throw new IOException($"'{Path.GetFileName(path)}' already exists");
        if (isDir)
        {
            Directory.CreateDirectory(path);
        }
        else
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, text ?? "", new UTF8Encoding(false));
        }
        return path;
    }

    public string Rename(string from, string to)
    {
        from = PathUtil.Normalize(from);
        to = PathUtil.Normalize(to);
        if (PathUtil.Equal(from, to)) return to;
        var caseOnly = string.Equals(from, to, StringComparison.OrdinalIgnoreCase);
        if (!caseOnly && (File.Exists(to) || Directory.Exists(to))) throw new IOException($"'{Path.GetFileName(to)}' already exists");
        if (Directory.Exists(from)) Directory.Move(from, to);
        else if (File.Exists(from)) File.Move(from, to);
        else throw new FileNotFoundException($"'{from}' does not exist");
        return to;
    }

    /// <summary>Deletes to the Recycle Bin on Windows; elsewhere deletes the file or folder.</summary>
    public void Delete(string path)
    {
        path = PathUtil.Normalize(path);
        var root = workspace.Root;
        if (root is not null && PathUtil.Equal(path, root)) throw new InvalidOperationException("The workspace folder itself cannot be deleted");
        // a deleted file can come back from Local History
        if (File.Exists(path) && new FileInfo(path).Length <= MaxEditableBytes && !BinaryExtensions.Contains(Path.GetExtension(path)) && !LooksBinary(path))
            history.Record(path, File.ReadAllText(path), "Deleted");
        if (OperatingSystem.IsWindows())
        {
            if (Directory.Exists(path))
                Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(path, Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs, Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            else if (File.Exists(path))
                Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(path, Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs, Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            else throw new FileNotFoundException($"'{path}' does not exist");
            return;
        }
        if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        else if (File.Exists(path)) File.Delete(path);
        else throw new FileNotFoundException($"'{path}' does not exist");
    }

    public IReadOnlyList<SearchFileResult> Search(SearchRequest req, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(req.Query)) return [];
        var pattern = req.Regex ? req.Query : Regex.Escape(req.Query);
        if (req.WholeWord) pattern = $@"\b{pattern}\b";
        var regex = new Regex(pattern, (req.MatchCase ? RegexOptions.None : RegexOptions.IgnoreCase) | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        var include = string.IsNullOrWhiteSpace(req.Include)
            ? null
            : req.Include.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(g => new Regex("^" + Regex.Escape(g).Replace(@"\*", ".*").Replace(@"\?", ".") + "$", RegexOptions.IgnoreCase))
                .ToList();
        var results = new List<SearchFileResult>();
        var total = 0;
        foreach (var file in AllFiles())
        {
            ct.ThrowIfCancellationRequested();
            if (total >= 5000) break;
            var name = Path.GetFileName(file);
            if (include is not null && !include.Any(r => r.IsMatch(name))) continue;
            if (BinaryExtensions.Contains(Path.GetExtension(file))) continue;
            FileInfo fi = new(file);
            if (fi.Length > 4 * 1024 * 1024) continue;
            string[] lines;
            try
            {
                if (LooksBinary(file)) continue;
                lines = File.ReadAllLines(file);
            }
            catch (IOException)
            {
                continue;
            }
            List<SearchMatch>? matches = null;
            for (var i = 0; i < lines.Length; i++)
            {
                foreach (Match m in regex.Matches(lines[i]))
                {
                    if (m.Length == 0) continue;
                    matches ??= [];
                    var line = lines[i];
                    // long lines: a window around the match; PreviewColumn places the highlight inside it
                    var start = line.Length > 240 ? Math.Max(0, m.Index - 40) : 0;
                    var preview = line.Length > 240 ? line.Substring(start, Math.Min(240, line.Length - start)) : line;
                    matches.Add(new SearchMatch(i + 1, m.Index + 1, m.Length, preview, m.Index - start + 1));
                    if (++total >= 5000) break;
                }
                if (total >= 5000) break;
            }
            if (matches is not null) results.Add(new SearchFileResult(file, matches));
        }
        return results;
    }

    private static bool LooksBinary(string path)
    {
        try
        {
            using var fs = File.OpenRead(path);
            Span<byte> buf = stackalloc byte[4096];
            var n = fs.Read(buf);
            if (n >= 2 && ((buf[0] == 0xFF && buf[1] == 0xFE) || (buf[0] == 0xFE && buf[1] == 0xFF))) return false; // UTF-16 BOM
            return buf[..n].IndexOf((byte)0) >= 0;
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static bool HasUtf8Bom(string path)
    {
        try
        {
            using var fs = File.OpenRead(path);
            Span<byte> b = stackalloc byte[3];
            return fs.Read(b) == 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF;
        }
        catch (IOException)
        {
            return false;
        }
    }
}
