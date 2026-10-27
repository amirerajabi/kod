using System.Diagnostics;
using System.Text;
using System.Xml.Linq;
using Kod.Engine.Infrastructure;
using Kod.Engine.Nuget;

namespace Kod.Engine.Workspace;

public sealed record ProjectReferenceDto(string Include, string Path, string Name, bool Exists);

public sealed record ProjectPropertiesDto(
    string Path, string Name, string? Sdk, IReadOnlyDictionary<string, string> Properties,
    IReadOnlyDictionary<string, string> Inherited, string? InheritedFrom,
    IReadOnlyList<ProjectReferenceDto> ProjectReferences, IReadOnlyList<PackageReferenceDto> PackageReferences,
    IReadOnlyList<string> FrameworkReferences);

public sealed record SavePropertiesRequest(string Path, Dictionary<string, string?> Set);

public sealed record ProjectReferenceRequest(string Path, string Reference);

public sealed record PackageRemoveRequest(string Path, string Id);

public sealed record SolutionProjectRequest(string Solution, string Project);

/// <summary>
/// Rider's Project Properties: reads and edits a .csproj in place (XDocument with whitespace kept, so comments,
/// blank lines and the order of everything stay), and adds or removes projects of the solution (dotnet sln).
/// New properties go into the first unconditional PropertyGroup; an empty value removes the property.
/// </summary>
public sealed class ProjectFileService(WorkspaceService workspace, FileService files, ILogger<ProjectFileService> log)
{
    public ProjectPropertiesDto Read(string path)
    {
        path = ProjectPath(path);
        var doc = Load(path, out _);
        var root = doc.Root!;
        var dir = Path.GetDirectoryName(path)!;
        var props = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in UnconditionalGroups(root).SelectMany(g => g.Elements())) props[e.Name.LocalName] = e.Value;
        var (inherited, from) = Inherited(dir);
        var refs = Items(root, "ProjectReference")
            .Select(e => (string?)e.Attribute("Include"))
            .OfType<string>()
            .Select(inc =>
            {
                var full = Path.GetFullPath(Path.Combine(dir, inc.Replace('\\', Path.DirectorySeparatorChar)));
                return new ProjectReferenceDto(inc, full, Path.GetFileNameWithoutExtension(full), File.Exists(full));
            })
            .ToList();
        var frameworks = Items(root, "FrameworkReference").Select(e => (string?)e.Attribute("Include")).OfType<string>().ToList();
        var sdk = (string?)root.Attribute("Sdk") ?? root.Elements().FirstOrDefault(e => e.Name.LocalName == "Sdk")?.Attribute("Name")?.Value;
        return new ProjectPropertiesDto(path, Path.GetFileNameWithoutExtension(path), sdk, props, inherited, from, refs, NugetService.Installed(path), frameworks);
    }

    /// <summary>Sets (or, for a null or empty value, removes) properties; untouched properties stay byte for byte.</summary>
    public ProjectPropertiesDto Save(SavePropertiesRequest req)
    {
        var path = ProjectPath(req.Path);
        Edit(path, root =>
        {
            var changed = false;
            foreach (var (name, raw) in req.Set)
            {
                if (!IsPropertyName(name)) throw new ArgumentException($"'{name}' is not a property name");
                var value = raw?.Trim();
                var existing = UnconditionalGroups(root).SelectMany(g => g.Elements()).Where(e => e.Name.LocalName.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
                if (string.IsNullOrEmpty(value))
                {
                    foreach (var e in existing) RemoveWithIndent(e, dropEmptyParent: false);
                    changed |= existing.Count > 0;
                }
                else if (existing.LastOrDefault() is { } last)
                {
                    if (last.Value == value) continue;
                    last.Value = value;
                    changed = true;
                }
                else
                {
                    AddChild(FirstPropertyGroup(root), new XElement(root.Name.Namespace + name, value), Unit(root));
                    changed = true;
                }
            }
            return changed;
        }, "Project Properties");
        return Read(path);
    }

    public ProjectPropertiesDto AddProjectReference(ProjectReferenceRequest req)
    {
        var path = ProjectPath(req.Path);
        var target = ProjectPath(req.Reference);
        if (PathUtil.Equal(path, target)) throw new ArgumentException("A project cannot reference itself");
        var dir = Path.GetDirectoryName(path)!;
        // dotnet add reference writes backslashes on every OS; so does Kod
        var include = Path.GetRelativePath(dir, target).Replace('/', '\\');
        Edit(path, root =>
        {
            if (Items(root, "ProjectReference").Any(e => (string?)e.Attribute("Include") is { } i && PathUtil.Equal(Path.GetFullPath(Path.Combine(dir, i.Replace('\\', Path.DirectorySeparatorChar))), target)))
                return false;
            var el = new XElement(root.Name.Namespace + "ProjectReference", new XAttribute("Include", include));
            AddChild(ItemGroupFor(root, "ProjectReference"), el, Unit(root));
            return true;
        }, $"Add reference to {Path.GetFileNameWithoutExtension(target)}");
        return Read(path);
    }

    public ProjectPropertiesDto RemoveProjectReference(ProjectReferenceRequest req)
    {
        var path = ProjectPath(req.Path);
        var dir = Path.GetDirectoryName(path)!;
        Edit(path, root =>
        {
            var hits = Items(root, "ProjectReference").Where(e => (string?)e.Attribute("Include") is { } i && (i == req.Reference || PathUtil.Equal(Path.GetFullPath(Path.Combine(dir, i.Replace('\\', Path.DirectorySeparatorChar))), Path.GetFullPath(Path.Combine(dir, req.Reference))))).ToList();
            foreach (var e in hits) RemoveWithIndent(e, dropEmptyParent: true);
            return hits.Count > 0;
        }, "Remove project reference");
        return Read(path);
    }

    public ProjectPropertiesDto RemovePackage(PackageRemoveRequest req)
    {
        var path = ProjectPath(req.Path);
        Edit(path, root =>
        {
            var hits = Items(root, "PackageReference").Where(e => string.Equals((string?)e.Attribute("Include"), req.Id, StringComparison.OrdinalIgnoreCase)).ToList();
            foreach (var e in hits) RemoveWithIndent(e, dropEmptyParent: true);
            return hits.Count > 0;
        }, $"Remove package {req.Id}");
        return Read(path);
    }

    /// <summary><c>dotnet sln add|remove</c> (.sln and .slnx); the watcher reloads the workspace.</summary>
    public async Task SolutionAsync(SolutionProjectRequest req, bool add, CancellationToken ct)
    {
        var sln = PathUtil.Normalize(req.Solution);
        if (!File.Exists(sln) || Path.GetExtension(sln).ToLowerInvariant() is not (".sln" or ".slnx")) throw new FileNotFoundException("The solution file does not exist");
        var project = ProjectPath(req.Project);
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(sln)!,
        };
        foreach (var a in new[] { "sln", sln, add ? "add" : "remove", project }) psi.ArgumentList.Add(a);
        psi.Environment["DOTNET_CLI_UI_LANGUAGE"] = "en";
        psi.Environment["DOTNET_NOLOGO"] = "1";
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("dotnet could not start");
        var o = p.StandardOutput.ReadToEndAsync(ct);
        var e = p.StandardError.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct);
        var output = (await o + "\n" + await e).Trim();
        log.LogInformation("dotnet sln {Action} {Project}: {Output}", add ? "add" : "remove", project, output);
        if (p.ExitCode != 0)
            throw new InvalidOperationException(output.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0) ?? $"dotnet sln exited with {p.ExitCode}");
        ReloadUnlessWatched(sln);
    }

    // ------------------------------------------------------------------ the project file

    private static string ProjectPath(string path)
    {
        path = PathUtil.Normalize(path);
        if (!path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Not a .csproj file");
        if (!File.Exists(path)) throw new FileNotFoundException($"'{Path.GetFileName(path)}' does not exist");
        return path;
    }

    private static XDocument Load(string path, out string text)
    {
        text = File.ReadAllText(path);
        try
        {
            var doc = XDocument.Parse(text, LoadOptions.PreserveWhitespace);
            if (doc.Root?.Name.LocalName != "Project") throw new InvalidOperationException("Not an MSBuild project file");
            return doc;
        }
        catch (System.Xml.XmlException ex)
        {
            throw new InvalidOperationException($"The project file is not valid XML: {ex.Message}");
        }
    }

    /// <summary>Applies an edit and writes the file back (BOM and line endings kept) when it changed something.</summary>
    private void Edit(string path, Func<XElement, bool> edit, string label)
    {
        var doc = Load(path, out var original);
        if (!edit(doc.Root!)) return;
        var sb = new StringBuilder();
        if (doc.Declaration is { } d) sb.Append(d);
        foreach (var n in doc.Nodes())
        {
            if (n is not XText && sb.Length > 0 && sb[^1] != '\n' && n.PreviousNode is not XText) sb.Append('\n');
            sb.Append(n.ToString(SaveOptions.DisableFormatting));
        }
        var text = sb.ToString().Replace("\r\n", "\n");
        if (original.EndsWith('\n') && !text.EndsWith('\n')) text += "\n";
        if (original.Contains("\r\n")) text = text.Replace("\n", "\r\n");
        files.Write(path, text, label);
        ReloadUnlessWatched(path);
    }

    /// <summary>The workspace watcher reloads on project changes under the root (unless a load is running).</summary>
    private void ReloadUnlessWatched(string path)
    {
        if (workspace.Root is not { } root || !PathUtil.IsUnder(path, root) || workspace.GetState().State == LoadState.Loading) workspace.Reload();
    }

    private static bool IsPropertyName(string name) =>
        name.Length > 0 && (char.IsLetter(name[0]) || name[0] == '_') && name.All(c => char.IsLetterOrDigit(c) || c is '_' or '-' or '.');

    private static bool Unconditional(XElement e) => string.IsNullOrWhiteSpace((string?)e.Attribute("Condition"));

    private static IEnumerable<XElement> UnconditionalGroups(XElement root) =>
        root.Elements().Where(e => e.Name.LocalName == "PropertyGroup" && Unconditional(e));

    private static IEnumerable<XElement> Items(XElement root, string kind) =>
        root.Elements().Where(g => g.Name.LocalName == "ItemGroup").SelectMany(g => g.Elements()).Where(e => e.Name.LocalName == kind);

    private static XElement FirstPropertyGroup(XElement root)
    {
        if (UnconditionalGroups(root).FirstOrDefault() is { } g) return g;
        g = new XElement(root.Name.Namespace + "PropertyGroup");
        InsertGroup(root, g, root.Elements().FirstOrDefault(e => e.Name.LocalName != "Sdk" && e.Name.LocalName != "Import"), before: true);
        return g;
    }

    /// <summary>The ItemGroup holding items of this kind, or a new one after the last ItemGroup (or at the end).</summary>
    private static XElement ItemGroupFor(XElement root, string kind)
    {
        var groups = root.Elements().Where(e => e.Name.LocalName == "ItemGroup" && Unconditional(e)).ToList();
        if (groups.FirstOrDefault(g => g.Elements().Any(e => e.Name.LocalName == kind)) is { } existing) return existing;
        var g = new XElement(root.Name.Namespace + "ItemGroup");
        var anchor = groups.LastOrDefault() ?? root.Elements().LastOrDefault(e => e.Name.LocalName == "PropertyGroup");
        InsertGroup(root, g, anchor, before: false);
        return g;
    }

    /// <summary>Inserts a top-level group as its own paragraph (a blank line apart, like the SDK templates).</summary>
    private static void InsertGroup(XElement root, XElement group, XElement? anchor, bool before)
    {
        var indent = root.Elements().Select(IndentOf).FirstOrDefault(i => i.Length > 0) ?? "  ";
        if (anchor is null)
        {
            var last = root.Nodes().LastOrDefault();
            if (last is XText t && string.IsNullOrWhiteSpace(t.Value)) t.AddBeforeSelf(new XText("\n" + indent), group);
            else root.Add(new XText("\n" + indent), group, new XText("\n"));
        }
        else if (before)
        {
            anchor.AddBeforeSelf(group, new XText("\n\n" + indent));
        }
        else
        {
            anchor.AddAfterSelf(new XText("\n\n" + indent), group);
        }
    }

    private static string IndentOf(XElement e)
    {
        if (e.PreviousNode is not XText t) return "";
        var v = t.Value;
        return v[(v.LastIndexOf('\n') + 1)..] is var s && string.IsNullOrWhiteSpace(s) ? s : "";
    }

    /// <summary>One level of indentation, read off the file (two spaces when it has none).</summary>
    private static string Unit(XElement root)
    {
        foreach (var g in root.Elements())
        {
            var outer = IndentOf(g);
            if (g.Elements().FirstOrDefault() is { } c && IndentOf(c) is var inner && inner.Length > outer.Length && inner.StartsWith(outer)) return inner[outer.Length..];
        }
        return root.Elements().Select(IndentOf).FirstOrDefault(i => i.Length > 0) ?? "  ";
    }

    private static void AddChild(XElement parent, XElement child, string unit)
    {
        if (parent.Elements().LastOrDefault() is { } last)
        {
            // before the closing line, so a comment trailing the last property stays with it
            if (parent.LastNode is XText closing && string.IsNullOrWhiteSpace(closing.Value)) closing.AddBeforeSelf(new XText("\n" + IndentOf(last)), child);
            else parent.Add(new XText("\n" + IndentOf(last)), child);
            return;
        }
        var indent = IndentOf(parent);
        if (parent.Nodes().All(n => n is XText t && string.IsNullOrWhiteSpace(t.Value))) parent.RemoveNodes();
        else if (parent.LastNode is XText tail && string.IsNullOrWhiteSpace(tail.Value)) tail.Remove();
        parent.Add(new XText("\n" + indent + unit), child, new XText("\n" + indent));
    }

    /// <summary>Removes an element with the whitespace in front of it (and an ItemGroup left empty).</summary>
    private static void RemoveWithIndent(XElement e, bool dropEmptyParent)
    {
        var parent = e.Parent;
        if (e.PreviousNode is XText t && string.IsNullOrWhiteSpace(t.Value))
        {
            // a blank line in front of the element now separates the next one
            var lines = t.Value.Count(c => c == '\n');
            if (e.NextNode is XText n && string.IsNullOrWhiteSpace(n.Value) && n.NextNode is not null && lines > n.Value.Count(c => c == '\n'))
                n.Value = new string('\n', lines) + n.Value[(n.Value.LastIndexOf('\n') + 1)..];
            t.Remove();
        }
        e.Remove();
        if (!dropEmptyParent || parent is null || parent.Parent is null || parent.Nodes().Any(n => n is not XText x || !string.IsNullOrWhiteSpace(x.Value))) return;
        // the group's own line, and the blank line that set it apart
        if (parent.PreviousNode is XText pt && string.IsNullOrWhiteSpace(pt.Value)) pt.Remove();
        parent.Remove();
    }

    /// <summary>Properties from the nearest Directory.Build.props (MSBuild imports only the first one found going up).</summary>
    private static (Dictionary<string, string> Props, string? From) Inherited(string dir)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var d = new DirectoryInfo(dir); d is not null; d = d.Parent)
        {
            var file = Path.Combine(d.FullName, "Directory.Build.props");
            if (!File.Exists(file)) continue;
            try
            {
                var root = XDocument.Load(file).Root;
                if (root is not null)
                    foreach (var e in UnconditionalGroups(root).SelectMany(g => g.Elements())) map[e.Name.LocalName] = e.Value;
            }
            catch (System.Xml.XmlException)
            {
            }
            return (map, file);
        }
        return (map, null);
    }
}
