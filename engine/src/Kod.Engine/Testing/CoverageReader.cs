using System.Globalization;
using System.Xml.Linq;

namespace Kod.Engine.Testing;

/// <param name="Partial">Lines with branches only some of which ran.</param>
public sealed record FileCoverageDto(string Path, int Covered, int Total, IReadOnlyList<int> CoveredLines, IReadOnlyList<int> UncoveredLines, IReadOnlyList<int> Partial);

public sealed record AssemblyCoverageDto(string Name, int Covered, int Total);

public sealed record CoverageDto(int Covered, int Total, IReadOnlyList<AssemblyCoverageDto> Assemblies, IReadOnlyList<FileCoverageDto> Files);

/// <summary>
/// Reads Cobertura reports (coverlet's coverage.cobertura.xml, Microsoft Code Coverage's *.cobertura.xml) and merges
/// them per file: a line counts as covered when any report ran it.
/// </summary>
public static class CoverageReader
{
    public static CoverageDto Read(IEnumerable<string> reports)
    {
        // file -> line -> (hits, partial)
        var files = new Dictionary<string, Dictionary<int, (long Hits, bool Partial)>>(StringComparer.OrdinalIgnoreCase);
        var assemblies = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var report in reports)
        {
            XDocument doc;
            try
            {
                doc = XDocument.Load(report);
            }
            catch (Exception ex) when (ex is IOException or System.Xml.XmlException)
            {
                continue;
            }
            var sources = doc.Descendants("source").Select(s => s.Value.Trim()).Where(s => s.Length > 0).ToList();
            foreach (var package in doc.Descendants("package"))
            {
                var asm = (string?)package.Attribute("name") ?? "?";
                foreach (var cls in package.Descendants("class"))
                {
                    var file = Resolve((string?)cls.Attribute("filename"), sources);
                    if (file is null) continue;
                    if (!assemblies.TryGetValue(asm, out var set)) assemblies[asm] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    set.Add(file);
                    if (!files.TryGetValue(file, out var lines)) files[file] = lines = [];
                    // a class's <lines> holds every line of its methods
                    foreach (var line in cls.Elements("lines").Elements("line"))
                    {
                        if (!int.TryParse((string?)line.Attribute("number"), out var n)) continue;
                        _ = long.TryParse((string?)line.Attribute("hits"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var hits);
                        var partial = string.Equals((string?)line.Attribute("branch"), "true", StringComparison.OrdinalIgnoreCase) && (string?)line.Attribute("condition-coverage") is { } cc && !cc.StartsWith("100%", StringComparison.Ordinal);
                        if (!lines.TryGetValue(n, out var prev))
                        {
                            lines[n] = (hits, partial);
                            continue;
                        }
                        // partial only while no report ran every branch of it
                        var stillPartial = (prev.Hits == 0 || prev.Partial) && (hits == 0 || partial);
                        lines[n] = (prev.Hits + hits, stillPartial);
                    }
                }
            }
        }

        var dtos = files.Select(kv =>
        {
            var covered = kv.Value.Where(l => l.Value.Hits > 0).Select(l => l.Key).Order().ToList();
            var uncovered = kv.Value.Where(l => l.Value.Hits == 0).Select(l => l.Key).Order().ToList();
            var partial = kv.Value.Where(l => l.Value.Hits > 0 && l.Value.Partial).Select(l => l.Key).Order().ToList();
            return new FileCoverageDto(kv.Key, covered.Count, kv.Value.Count, covered, uncovered, partial);
        }).OrderBy(f => f.Path, StringComparer.OrdinalIgnoreCase).ToList();
        var byPath = dtos.ToDictionary(f => f.Path, StringComparer.OrdinalIgnoreCase);
        var asms = assemblies.Select(a => new AssemblyCoverageDto(a.Key, a.Value.Sum(f => byPath[f].Covered), a.Value.Sum(f => byPath[f].Total)))
            .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ToList();
        return new CoverageDto(dtos.Sum(f => f.Covered), dtos.Sum(f => f.Total), asms, dtos);
    }

    /// <summary>An absolute filename (Microsoft Code Coverage), or relative to one of the report's sources (coverlet).</summary>
    private static string? Resolve(string? filename, List<string> sources)
    {
        if (string.IsNullOrEmpty(filename)) return null;
        if (Path.IsPathRooted(filename)) return Path.GetFullPath(filename);
        foreach (var s in sources)
        {
            var full = Path.GetFullPath(Path.Combine(s, filename));
            if (File.Exists(full)) return full;
        }
        return sources.Count > 0 ? Path.GetFullPath(Path.Combine(sources[0], filename)) : null;
    }
}
