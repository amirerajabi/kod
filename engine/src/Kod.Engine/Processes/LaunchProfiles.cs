using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Kod.Engine.Processes;

public sealed record LaunchProfileDto(string Name, string CommandName, string? ApplicationUrl, Dictionary<string, string> Env, string? CommandLineArgs, bool LaunchBrowser, string? LaunchUrl, string? WorkingDirectory);

/// <summary>The profiles of a project's Properties/launchSettings.json (what `dotnet run --launch-profile` reads).</summary>
public static class LaunchProfiles
{
    public static IReadOnlyList<LaunchProfileDto> Read(string projectPath)
    {
        var settings = Path.Combine(Path.GetDirectoryName(projectPath)!, "Properties", "launchSettings.json");
        if (!File.Exists(settings)) return [];
        try
        {
            if (JsonNode.Parse(File.ReadAllText(settings), documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true })?["profiles"] is not JsonObject profiles) return [];
            var list = new List<LaunchProfileDto>();
            foreach (var (name, p) in profiles)
            {
                if (p is not JsonObject o) continue;
                var env = new Dictionary<string, string>();
                if (o["environmentVariables"] is JsonObject vars)
                    foreach (var (k, v) in vars) env[k] = v?.ToString() ?? "";
                list.Add(new LaunchProfileDto(name, (string?)o["commandName"] ?? "Project", (string?)o["applicationUrl"], env, (string?)o["commandLineArgs"], (bool?)o["launchBrowser"] ?? false, (string?)o["launchUrl"], (string?)o["workingDirectory"]));
            }
            return list;
        }
        catch (Exception ex) when (ex is JsonException or IOException or InvalidOperationException)
        {
            return [];
        }
    }

    /// <summary>The profile `dotnet run` would use: the named one, else the first that runs the project.</summary>
    public static LaunchProfileDto? Pick(string projectPath, string? name) =>
        Read(projectPath) is var all && name is not null
            ? all.FirstOrDefault(p => p.Name == name)
            : all.FirstOrDefault(p => p.CommandName == "Project");

    /// <summary>Splits a command line the way the shell would: spaces separate, double quotes group.</summary>
    public static List<string> SplitArgs(string? commandLine)
    {
        var args = new List<string>();
        if (string.IsNullOrWhiteSpace(commandLine)) return args;
        var cur = new StringBuilder();
        bool quoted = false, any = false;
        foreach (var ch in commandLine)
        {
            if (ch == '"')
            {
                quoted = !quoted;
                any = true;
            }
            else if (char.IsWhiteSpace(ch) && !quoted)
            {
                if (any) args.Add(cur.ToString());
                cur.Clear();
                any = false;
            }
            else
            {
                cur.Append(ch);
                any = true;
            }
        }
        if (any) args.Add(cur.ToString());
        return args;
    }
}
