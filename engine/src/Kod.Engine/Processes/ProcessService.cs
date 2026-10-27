using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using Kod.Engine.Infrastructure;

namespace Kod.Engine.Processes;

/// <param name="Mask">Secrets in the arguments (a connection string with its password) shown as ••• in the command line.</param>
public sealed record StartRequest(string Kind, string Title, string File, IReadOnlyList<string> Args, string? Cwd, Dictionary<string, string>? Env = null, IReadOnlyList<string>? Mask = null);

public sealed record ProcDto(string Id, string Kind, string Title, string CommandLine, string Cwd, long StartedAt, int? ExitCode, long? EndedAt);

/// <summary>
/// Child processes: dotnet build / run / test / new / add package, and the terminal's shell. Output is read in
/// chunks (prompts without a newline show up), batched, and streamed as proc.output events; stdin is writable.
/// </summary>
public sealed class ProcessService(EventHub hub, ILogger<ProcessService> log) : IDisposable
{
    private sealed class Running(Process process, ProcDto info)
    {
        public Process Process { get; } = process;
        public ProcDto Info { get; set; } = info;
        public readonly StringBuilder Pending = new();
        public readonly object Lock = new();
        public Timer? Flush;
    }

    private readonly ConcurrentDictionary<string, Running> procs = new();

    public IReadOnlyList<ProcDto> List() => procs.Values.Select(p => p.Info).OrderBy(p => p.StartedAt).ToList();

    public ProcDto Start(StartRequest req)
    {
        var cwd = string.IsNullOrWhiteSpace(req.Cwd) ? Environment.CurrentDirectory : req.Cwd!;
        if (!Directory.Exists(cwd)) throw new DirectoryNotFoundException($"'{cwd}' does not exist");
        var psi = new ProcessStartInfo(req.File)
        {
            WorkingDirectory = cwd,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in req.Args) psi.ArgumentList.Add(a);
        psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        psi.Environment["DOTNET_NOLOGO"] = "1";
        psi.Environment["MSBUILDTERMINALLOGGER"] = "off";
        psi.Environment["DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION"] = "1";
        psi.Environment["DOTNET_CLI_UI_LANGUAGE"] = "en";
        if (req.Env is not null) foreach (var (k, v) in req.Env) psi.Environment[k] = v;

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var id = Guid.NewGuid().ToString("N")[..12];
        var commandLine = string.Join(' ', new[] { req.File }.Concat(req.Args.Select(a => req.Mask?.Contains(a) == true ? "•••" : a)).Select(Quote));
        var info = new ProcDto(id, req.Kind, req.Title, commandLine, cwd, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null, null);
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"Could not start {req.File}: {ex.Message}");
        }
        var running = new Running(process, info);
        running.Flush = new Timer(_ => FlushOutput(running), null, 40, 40);
        procs[id] = running;
        hub.Publish("proc.started", info);

        var outTask = Pump(running, process.StandardOutput, "stdout");
        var errTask = Pump(running, process.StandardError, "stderr");
        _ = Task.Run(async () =>
        {
            await process.WaitForExitAsync().ConfigureAwait(false);
            await Task.WhenAll(outTask, errTask).ConfigureAwait(false);
            running.Flush?.Dispose();
            FlushOutput(running);
            int code;
            try
            {
                code = process.ExitCode;
            }
            catch (InvalidOperationException)
            {
                code = -1;
            }
            running.Info = running.Info with { ExitCode = code, EndedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            hub.Publish("proc.exit", running.Info);
            process.Dispose();
            // keep finished entries briefly so a reconnecting UI still sees the result
            _ = Task.Delay(TimeSpan.FromMinutes(2)).ContinueWith(_ => procs.TryRemove(id, out var _));
        });
        return info;
    }

    private async Task Pump(Running r, StreamReader reader, string stream)
    {
        var buffer = new char[4096];
        try
        {
            int n;
            while ((n = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
            {
                lock (r.Lock)
                {
                    // stderr is marked so the UI can colour it; chunks keep their order inside a flush
                    if (stream == "stderr") r.Pending.Append("\u001b[31m").Append(buffer, 0, n).Append("\u001b[0m");
                    else r.Pending.Append(buffer, 0, n);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // process gone
        }
    }

    private void FlushOutput(Running r)
    {
        string text;
        lock (r.Lock)
        {
            if (r.Pending.Length == 0) return;
            text = r.Pending.ToString();
            r.Pending.Clear();
        }
        hub.Publish("proc.output", new { id = r.Info.Id, text });
    }

    public void WriteInput(string id, string text)
    {
        if (!procs.TryGetValue(id, out var r) || r.Info.ExitCode is not null) throw new InvalidOperationException("The process is not running");
        r.Process.StandardInput.Write(text);
        r.Process.StandardInput.Flush();
    }

    public void Stop(string id)
    {
        if (!procs.TryGetValue(id, out var r) || r.Info.ExitCode is not null) return;
        try
        {
            r.Process.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            log.LogDebug(ex, "Stop {Id}", id);
        }
    }

    private static string Quote(string a) => a.Length == 0 || a.Any(char.IsWhiteSpace) ? $"\"{a}\"" : a;

    public void Dispose()
    {
        foreach (var r in procs.Values)
        {
            try
            {
                if (r.Info.ExitCode is null) r.Process.Kill(entireProcessTree: true);
            }
            catch
            {
                // best effort on shutdown
            }
        }
    }
}
