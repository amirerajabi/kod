using System.Collections.Concurrent;
using System.Text;
using Kod.Engine.Infrastructure;
using Porta.Pty;

namespace Kod.Engine.Processes;

/// <summary>With <see cref="Args"/>, <see cref="Shell"/> is any program run in the terminal (docker exec -it …).</summary>
public sealed record TerminalStartRequest(string? Cwd, int Cols, int Rows, string? Shell, IReadOnlyList<string>? Args = null, string? Title = null);

public sealed record TerminalDto(string Id, string Title, string Cwd, string Shell, int? ExitCode);

/// <summary>
/// Real terminals: a pseudo console (ConPTY on Windows, forkpty on macOS/Linux) per terminal, so the shell runs as it
/// does in a terminal emulator — its own prompt and line editing, colours, interactive programs, Ctrl+C. Output goes to
/// the UI (xterm.js) as term.output events, batched every 16 ms; keystrokes and resizes come back as requests.
/// </summary>
public sealed class TerminalService(EventHub hub, ILogger<TerminalService> log) : IDisposable
{
    private sealed class Term(IPtyConnection pty, TerminalDto info)
    {
        public IPtyConnection Pty { get; } = pty;
        public TerminalDto Info { get; set; } = info;
        public readonly StringBuilder Pending = new();
        public readonly object Lock = new();
        public Timer? Flush;
    }

    private readonly ConcurrentDictionary<string, Term> terms = new();

    public IReadOnlyList<TerminalDto> List() => terms.Values.Select(t => t.Info).ToList();

    public static string DefaultShell()
    {
        if (OperatingSystem.IsWindows())
        {
            // PowerShell 7, then Windows PowerShell, then cmd
            foreach (var candidate in new[] { "pwsh.exe", "powershell.exe" })
                foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
                    if (File.Exists(Path.Combine(dir, candidate))) return Path.Combine(dir, candidate);
            return Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
        }
        return Environment.GetEnvironmentVariable("SHELL") is { Length: > 0 } sh ? sh : File.Exists("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
    }

    public async Task<TerminalDto> StartAsync(TerminalStartRequest req, CancellationToken ct)
    {
        var cwd = string.IsNullOrWhiteSpace(req.Cwd) || !Directory.Exists(req.Cwd) ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) : req.Cwd!;
        var shell = string.IsNullOrWhiteSpace(req.Shell) ? DefaultShell() : req.Shell!;
        // a bare program name ("docker"): its full path, for the pseudo console
        if (!Path.IsPathRooted(shell))
        {
            var exts = OperatingSystem.IsWindows() ? new[] { ".exe", ".cmd", "" } : [""];
            var found = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .SelectMany(d => exts.Select(e => Path.Combine(d, shell + e)))
                .FirstOrDefault(File.Exists);
            if (found is not null) shell = found;
        }
        var env = new Dictionary<string, string>();
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) env[(string)e.Key] = (string?)e.Value ?? "";
        env["TERM"] = "xterm-256color";
        env["COLORTERM"] = "truecolor";
        env["TERM_PROGRAM"] = "Kod";
        var name = Path.GetFileNameWithoutExtension(shell).ToLowerInvariant();
        var args = req.Args is { Count: > 0 } custom ? custom.ToArray() : name switch
        {
            "pwsh" or "powershell" => new[] { "-NoLogo" },
            "bash" or "zsh" or "fish" => new[] { "-l" },
            _ => [],
        };
        var pty = await PtyProvider.SpawnAsync(new PtyOptions
        {
            Name = "Kod",
            App = shell,
            CommandLine = args,
            Cwd = cwd,
            Cols = Math.Clamp(req.Cols, 20, 500),
            Rows = Math.Clamp(req.Rows, 5, 200),
            Environment = env,
        }, ct);
        var id = Guid.NewGuid().ToString("N")[..12];
        var term = new Term(pty, new TerminalDto(id, req.Title ?? (Path.GetFileName(cwd) is { Length: > 0 } f ? f : cwd), cwd, shell, null));
        terms[id] = term;
        term.Flush = new Timer(_ => FlushOutput(term), null, 16, 16);
        pty.ProcessExited += (_, e) =>
        {
            term.Info = term.Info with { ExitCode = e.ExitCode };
            FlushOutput(term);
            hub.Publish("term.exit", new { id, exitCode = e.ExitCode });
            term.Flush?.Dispose();
            terms.TryRemove(id, out Term? _);
        };
        _ = Task.Run(() => PumpAsync(term));
        return term.Info;
    }

    private async Task PumpAsync(Term term)
    {
        var decoder = Encoding.UTF8.GetDecoder();
        var bytes = new byte[8192];
        var chars = new char[8192 + 4];
        try
        {
            int n;
            while ((n = await term.Pty.ReaderStream.ReadAsync(bytes)) > 0)
            {
                var c = decoder.GetChars(bytes, 0, n, chars, 0, flush: false);
                lock (term.Lock) term.Pending.Append(chars, 0, c);
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // the shell exited
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "terminal read failed");
        }
    }

    private void FlushOutput(Term term)
    {
        string text;
        lock (term.Lock)
        {
            if (term.Pending.Length == 0) return;
            text = term.Pending.ToString();
            term.Pending.Clear();
        }
        hub.Publish("term.output", new { id = term.Info.Id, data = text });
    }

    public async Task WriteAsync(string id, string data, CancellationToken ct)
    {
        if (!terms.TryGetValue(id, out var term)) throw new InvalidOperationException("The terminal has exited");
        var bytes = Encoding.UTF8.GetBytes(data);
        await term.Pty.WriterStream.WriteAsync(bytes, ct);
        await term.Pty.WriterStream.FlushAsync(ct);
    }

    public void Resize(string id, int cols, int rows)
    {
        if (terms.TryGetValue(id, out var term)) term.Pty.Resize(Math.Clamp(cols, 20, 500), Math.Clamp(rows, 5, 200));
    }

    public void Kill(string id)
    {
        if (!terms.TryRemove(id, out var term)) return;
        try
        {
            term.Pty.Kill();
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "terminal kill failed");
        }
        term.Flush?.Dispose();
        term.Pty.Dispose();
    }

    public void Dispose()
    {
        foreach (var id in terms.Keys.ToList()) Kill(id);
    }
}
