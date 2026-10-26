using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;

namespace Kod.Engine.Ai;

/// <summary>
/// What the agent can do in the open workspace: list, read, search, write and edit files, and run a shell command.
/// Every path is resolved against the workspace root and must stay inside it.
/// </summary>
public sealed class AiTools(WorkspaceService workspace, FileService files)
{
    private const int MaxOutput = 30_000;

    public static readonly IReadOnlyList<AiToolDef> All =
    [
        Def("list_files", "List the files and folders in a workspace folder (build output such as bin, obj and .git is skipped). Use recursive for a tree of the whole folder.", false, """
            {"type":"object","properties":{"path":{"type":"string","description":"Folder, relative to the workspace root; empty for the root"},"recursive":{"type":"boolean","description":"Include sub-folders (capped at 500 entries)"}},"required":[]}
            """),
        Def("read_file", "Read a text file of the workspace with line numbers. Open editors are read with their unsaved text.", false, """
            {"type":"object","properties":{"path":{"type":"string","description":"File, relative to the workspace root"},"start_line":{"type":"integer","description":"First line (1-based)"},"end_line":{"type":"integer","description":"Last line (inclusive)"}},"required":["path"]}
            """),
        Def("search", "Search the text of every workspace file. Returns path:line: text for each match (at most 200).", false, """
            {"type":"object","properties":{"query":{"type":"string"},"regex":{"type":"boolean","description":"Treat query as a .NET regular expression"},"include":{"type":"string","description":"Comma-separated file name globs, e.g. *.cs,*.csproj"}},"required":["query"]}
            """),
        Def("write_file", "Create a file or replace all of its text. Prefer edit_file for changes to an existing file.", true, """
            {"type":"object","properties":{"path":{"type":"string","description":"File, relative to the workspace root"},"content":{"type":"string","description":"The complete new text"}},"required":["path","content"]}
            """),
        Def("edit_file", "Replace one exact occurrence of old_text with new_text in a file. old_text must match the file exactly (including indentation) and be unique; include surrounding lines to make it unique.", true, """
            {"type":"object","properties":{"path":{"type":"string","description":"File, relative to the workspace root"},"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["path","old_text","new_text"]}
            """),
        Def("run_command", "Run a shell command in the workspace root (PowerShell on Windows, sh elsewhere), e.g. dotnet build or dotnet test, and return its output and exit code.", true, """
            {"type":"object","properties":{"command":{"type":"string"},"timeout_seconds":{"type":"integer","description":"Default 120, at most 600"}},"required":["command"]}
            """),
    ];

    private static AiToolDef Def(string name, string description, bool mutates, string schema) =>
        new(name, description, JsonDocument.Parse(schema).RootElement.Clone(), mutates);

    public static bool Mutates(string name) => All.FirstOrDefault(t => t.Name == name)?.Mutates ?? true;

    /// <summary>A short line for the UI: "Read Program.cs", "Run dotnet build".</summary>
    public static string Describe(string name, JsonElement input)
    {
        string S(string key) => input.ValueKind == JsonValueKind.Object && input.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        return name switch
        {
            "list_files" => $"List {(S("path") is { Length: > 0 } p ? p : ".")}",
            "read_file" => $"Read {S("path")}",
            "search" => $"Search \"{S("query")}\"",
            "write_file" => $"Write {S("path")}",
            "edit_file" => $"Edit {S("path")}",
            "run_command" => $"Run {S("command")}",
            _ => name,
        };
    }

    public async Task<(string Output, bool IsError, string? ChangedFile)> RunAsync(string name, JsonElement input, CancellationToken ct)
    {
        try
        {
            if (input.ValueKind != JsonValueKind.Object) throw new AiException("The tool input must be a JSON object");
            return name switch
            {
                "list_files" => (ListFiles(Str(input, "path", optional: true), Bool(input, "recursive")), false, null),
                "read_file" => (ReadFile(Str(input, "path"), Int(input, "start_line"), Int(input, "end_line")), false, null),
                "search" => (Search(Str(input, "query"), Bool(input, "regex"), Str(input, "include", optional: true), ct), false, null),
                "write_file" => WriteFile(Str(input, "path"), Str(input, "content", allowEmpty: true)),
                "edit_file" => EditFile(Str(input, "path"), Str(input, "old_text"), Str(input, "new_text", allowEmpty: true)),
                "run_command" => await RunCommandAsync(Str(input, "command"), Int(input, "timeout_seconds") ?? 120, ct),
                _ => ($"Unknown tool '{name}'", true, null),
            };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is AiException or IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or System.Text.RegularExpressions.RegexParseException)
        {
            return (ex.Message, true, null);
        }
    }

    private string Root => workspace.Root ?? throw new AiException("No folder is open in Kod");

    /// <summary>Resolves a model-supplied path inside the workspace (relative or absolute), refusing anything outside it.</summary>
    public string Resolve(string? path)
    {
        var root = Root;
        var full = PathUtil.Normalize(Path.IsPathRooted(path ?? "") ? path! : Path.Combine(root, path ?? ""));
        if (!PathUtil.Equal(full, root) && !PathUtil.IsUnder(full, root)) throw new AiException($"'{path}' is outside the workspace");
        return full;
    }

    private string Rel(string full) => Path.GetRelativePath(Root, full).Replace('\\', '/');

    private string ListFiles(string? path, bool recursive)
    {
        var dir = Resolve(path);
        if (!Directory.Exists(dir)) throw new AiException($"'{path}' is not a folder");
        var sb = new StringBuilder();
        var count = 0;
        Walk(dir, 0);
        if (count >= 500) sb.AppendLine("… (truncated at 500 entries)");
        return sb.Length == 0 ? "(empty)" : sb.ToString();

        void Walk(string d, int depth)
        {
            foreach (var e in files.List(d))
            {
                if (count++ >= 500) return;
                sb.Append(' ', depth * 2).Append(e.Name).AppendLine(e.IsDir ? "/" : $"  ({e.Size} bytes)");
                if (e.IsDir && recursive) Walk(e.Path, depth + 1);
            }
        }
    }

    private string CurrentText(string full) => workspace.OverlayText(full) ?? files.Read(full).Text;

    private string ReadFile(string path, int? start, int? end)
    {
        var full = Resolve(path);
        if (!File.Exists(full)) throw new AiException($"'{path}' does not exist");
        var lines = CurrentText(full).Split('\n');
        var from = Math.Clamp(start ?? 1, 1, Math.Max(1, lines.Length));
        var to = Math.Clamp(end ?? lines.Length, from, lines.Length);
        var sb = new StringBuilder();
        for (var i = from; i <= to; i++)
        {
            sb.Append(i).Append('\t').AppendLine(lines[i - 1].TrimEnd('\r'));
            if (sb.Length > MaxOutput)
            {
                sb.AppendLine($"… (stopped at line {i} of {lines.Length}; read on with start_line)");
                break;
            }
        }
        return sb.ToString();
    }

    private string Search(string query, bool regex, string? include, CancellationToken ct)
    {
        var results = files.Search(new SearchRequest(query, regex, false, false, include), ct);
        var sb = new StringBuilder();
        var n = 0;
        foreach (var f in results)
            foreach (var m in f.Matches)
            {
                if (n++ >= 200)
                {
                    sb.AppendLine("… (more than 200 matches; narrow the search)");
                    return sb.ToString();
                }
                sb.Append(Rel(f.Path)).Append(':').Append(m.Line).Append(": ").AppendLine(m.Preview.Trim());
            }
        return n == 0 ? "No matches" : sb.ToString();
    }

    private (string, bool, string?) WriteFile(string path, string content)
    {
        var full = Resolve(path);
        var existed = File.Exists(full);
        files.Write(full, content);
        return ($"{(existed ? "Replaced" : "Created")} {Rel(full)} ({content.Split('\n').Length} lines)", false, full);
    }

    private (string, bool, string?) EditFile(string path, string oldText, string newText)
    {
        var full = Resolve(path);
        if (!File.Exists(full)) throw new AiException($"'{path}' does not exist");
        var text = CurrentText(full);
        // the model writes \n; the file may use \r\n
        var crlf = text.Contains("\r\n");
        string Eol(string s) => crlf ? s.Replace("\r\n", "\n").Replace("\n", "\r\n") : s.Replace("\r\n", "\n");
        var find = Eol(oldText);
        var at = text.IndexOf(find, StringComparison.Ordinal);
        if (at < 0) throw new AiException("old_text was not found in the file; read the file again and copy the text exactly");
        if (text.IndexOf(find, at + find.Length, StringComparison.Ordinal) >= 0) throw new AiException("old_text occurs more than once; include more surrounding lines");
        files.Write(full, string.Concat(text.AsSpan(0, at), Eol(newText), text.AsSpan(at + find.Length)));
        return ($"Edited {Rel(full)}", false, full);
    }

    private async Task<(string, bool, string?)> RunCommandAsync(string command, int timeoutSeconds, CancellationToken ct)
    {
        var shell = OperatingSystem.IsWindows() ? Processes.TerminalService.DefaultShell() : "/bin/sh";
        var isCmd = Path.GetFileNameWithoutExtension(shell).Equals("cmd", StringComparison.OrdinalIgnoreCase);
        var psi = new ProcessStartInfo(shell)
        {
            WorkingDirectory = Root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (isCmd)
        {
            psi.ArgumentList.Add("/d");
            psi.ArgumentList.Add("/c");
        }
        else if (OperatingSystem.IsWindows())
        {
            psi.ArgumentList.Add("-NoProfile");
            psi.ArgumentList.Add("-NonInteractive");
            psi.ArgumentList.Add("-Command");
        }
        else
        {
            psi.ArgumentList.Add("-c");
        }
        psi.ArgumentList.Add(command);
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["MSBUILDTERMINALLOGGER"] = "off";
        psi.Environment["NO_COLOR"] = "1";

        using var process = new Process { StartInfo = psi };
        var output = new StringBuilder();
        void Add(string? line)
        {
            if (line is null) return;
            lock (output)
                if (output.Length < MaxOutput * 2) output.AppendLine(line);
        }
        process.OutputDataReceived += (_, e) => Add(e.Data);
        process.ErrorDataReceived += (_, e) => Add(e.Data);
        process.Start();
        process.StandardInput.Close();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(timeoutSeconds, 5, 600)));
        var timedOut = false;
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }
            ct.ThrowIfCancellationRequested();
            timedOut = true;
        }
        string text;
        lock (output) text = output.ToString();
        if (text.Length > MaxOutput) text = string.Concat(text.AsSpan(0, MaxOutput / 3), "\n… (output cut) …\n", text.AsSpan(text.Length - MaxOutput / 2));
        var exit = timedOut ? "timed out and was stopped" : $"exit code {process.ExitCode}";
        return ($"{text.TrimEnd()}\n[{exit}]", timedOut || process.ExitCode != 0, null);
    }

    private static string Str(JsonElement o, string key, bool optional = false, bool allowEmpty = false)
    {
        if (o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
        {
            var s = v.GetString() ?? "";
            if (s.Length > 0 || allowEmpty || optional) return s;
        }
        else if (optional) return "";
        throw new AiException($"Missing '{key}'");
    }

    private static bool Bool(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    private static int? Int(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
}
