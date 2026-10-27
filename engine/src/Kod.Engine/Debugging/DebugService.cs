using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;

namespace Kod.Engine.Debugging;

public sealed record BreakpointDto(int Line, string? Condition = null);

/// <summary><see cref="Docker"/>: debug inside a container (Rider's fast mode, see <see cref="Kod.Engine.Docker.DockerService.PrepareDebugAsync"/>).</summary>
public sealed record DebugStartRequest(string ProjectPath, Dictionary<string, List<BreakpointDto>>? Breakpoints, bool StopAtEntry = false, bool Docker = false);

public sealed record FrameDto(int Id, string Name, string? Path, int Line, int Column);

public sealed record ScopeDto(string Name, int VariablesReference, bool Expensive);

/// <param name="EvaluateName">The expression that evaluates to this variable (for the visualizers), when the debugger knows it.</param>
public sealed record VariableDto(string Name, string Value, string? Type, int VariablesReference, string? EvaluateName = null);

public sealed record EvaluateDto(string Result, string? Type, int VariablesReference);

public sealed record VerifiedBreakpointDto(int Line, bool Verified, string? Message);

/// <summary>
/// One debug session at a time: netcoredbg in DAP mode (--interpreter=vscode) over stdio. The engine is the DAP client;
/// the UI talks to it with small requests and gets debug.* events (state, stopped with the call stack, output, ended).
/// </summary>
public sealed class DebugService(DebugAdapter adapter, WorkspaceService workspace, Kod.Engine.Docker.DockerService docker, LiveDiagnostics diagnostics, EventHub hub, ILogger<DebugService> log) : IDisposable
{
    private readonly object sync = new();
    private Session? session;

    public object State()
    {
        var s = session;
        return new { active = s is not null, state = s?.State ?? "idle", program = s?.Program, threadId = s?.StoppedThread };
    }

    public async Task<object> StartAsync(DebugStartRequest req, CancellationToken ct)
    {
        Stop();
        req = req with { ProjectPath = PathUtil.Normalize(req.ProjectPath) };
        var project = workspace.CurrentSolution.Projects.FirstOrDefault(p => PathUtil.Equal(p.FilePath, req.ProjectPath))
                      ?? throw new InvalidOperationException("The project is not loaded yet");
        var program = project.OutputFilePath ?? throw new InvalidOperationException("The project has no output assembly");
        if (!File.Exists(program)) throw new InvalidOperationException($"{System.IO.Path.GetFileName(program)} is not built yet");
        var cwd = System.IO.Path.GetDirectoryName(req.ProjectPath)!;

        Session s;
        string launchCwd = cwd;
        var env = LaunchEnv(cwd);
        string? container = null;
        if (req.Docker)
        {
            var web = File.ReadAllText(req.ProjectPath).Contains("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase);
            void Progress(string text) => hub.Publish("debug.output", new { category = "console", text });
            var dc = await docker.PrepareDebugAsync(req.ProjectPath, System.IO.Path.GetDirectoryName(program)!, System.IO.Path.GetFileName(program), web, Progress, ct);
            container = dc.Container;
            s = new Session("docker", dc.AdapterArgs, dc.Program, hub, log);
            launchCwd = dc.Cwd;
            env = dc.Env;
        }
        else
        {
            var exe = adapter.Locate() ?? throw new InvalidOperationException("The debugger (netcoredbg) is not installed. Settings › Debugger downloads it.");
            s = new Session(exe, [], program, hub, log);
        }
        lock (sync) session = s;
        s.Ended += () =>
        {
            diagnostics.Stop();
            lock (sync)
                if (session == s) session = null;
            if (container is not null) _ = docker.RemoveAsync(container);
        };
        try
        {
            await s.StartAsync(cwd, launchCwd, env, req.Breakpoints ?? [], req.StopAtEntry, ct);
            if (!req.Docker) _ = WatchAsync(s);
        }
        catch
        {
            s.Dispose();
            throw;
        }
        return State();
    }

    /// <summary>Live diagnostics on the program: its id from the debugger's process event, else netcoredbg's child.</summary>
    private async Task WatchAsync(Session s)
    {
        for (var i = 0; i < 40 && session == s; i++)
        {
            if ((s.DebuggeePid ?? (s.AdapterPid is { } a ? LiveDiagnostics.ChildOf(a) : null)) is { } pid)
            {
                diagnostics.Start(pid);
                return;
            }
            await Task.Delay(250);
        }
    }

    /// <summary>ASP.NET Core apps get their development environment and the URL of their first launch profile.</summary>
    private static Dictionary<string, string> LaunchEnv(string projectDir)
    {
        var env = new Dictionary<string, string> { ["ASPNETCORE_ENVIRONMENT"] = "Development", ["DOTNET_ENVIRONMENT"] = "Development" };
        var settings = System.IO.Path.Combine(projectDir, "Properties", "launchSettings.json");
        try
        {
            if (File.Exists(settings) && JsonNode.Parse(File.ReadAllText(settings), documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true })?["profiles"] is JsonObject profiles)
            {
                foreach (var (_, p) in profiles)
                {
                    if ((string?)p?["commandName"] != "Project") continue;
                    if ((string?)p?["applicationUrl"] is { } url) env["ASPNETCORE_URLS"] = url;
                    if (p?["environmentVariables"] is JsonObject vars)
                        foreach (var (k, v) in vars) env[k] = v?.ToString() ?? "";
                    break;
                }
            }
        }
        catch (JsonException)
        {
        }
        return env;
    }

    internal Session Active() => session ?? throw new InvalidOperationException("No debug session");

    public Task<IReadOnlyList<VerifiedBreakpointDto>> SetBreakpointsAsync(string path, List<BreakpointDto> lines, CancellationToken ct) =>
        session is { } s ? s.SetBreakpointsAsync(path, lines, ct) : Task.FromResult<IReadOnlyList<VerifiedBreakpointDto>>([]);

    public Task StepAsync(string command, CancellationToken ct) => Active().StepAsync(command, ct);
    public Task<IReadOnlyList<ScopeDto>> ScopesAsync(int frameId, CancellationToken ct) => Active().ScopesAsync(frameId, ct);
    public Task<IReadOnlyList<VariableDto>> VariablesAsync(int reference, CancellationToken ct) => Active().VariablesAsync(reference, ct);
    public Task<EvaluateDto> EvaluateAsync(string expression, int? frameId, string context, CancellationToken ct) => Active().EvaluateAsync(expression, frameId, context, ct);

    public Task<VisualDto> VisualizeAsync(VisualizeRequest r, CancellationToken ct) => Visualizers.VisualizeAsync(Active(), r, ct);

    public void Stop()
    {
        Session? s;
        lock (sync)
        {
            s = session;
            session = null;
        }
        s?.Dispose();
    }

    public void Dispose() => Stop();

    // ------------------------------------------------------------------ the DAP session

    internal sealed class Session(string exe, IReadOnlyList<string> adapterArgs, string program, EventHub hub, ILogger log) : IDisposable
    {
        private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonObject>> pending = new();
        private readonly TaskCompletionSource initialized = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly SemaphoreSlim writeLock = new(1, 1);
        private Process? proc;
        private int seq;
        private int disposed;

        public string Program { get; } = program;
        public string State { get; private set; } = "starting";
        public int? StoppedThread { get; private set; }
        /// <summary>The program's process id, when the debugger reports it.</summary>
        public int? DebuggeePid { get; private set; }
        public int? AdapterPid => proc?.Id;
        public event Action? Ended;

        public async Task StartAsync(string hostCwd, string cwd, Dictionary<string, string> env, Dictionary<string, List<BreakpointDto>> breakpoints, bool stopAtEntry, CancellationToken ct)
        {
            var psi = new ProcessStartInfo(exe)
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = hostCwd,
            };
            foreach (var a in adapterArgs) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add("--interpreter=vscode");
            proc = Process.Start(psi) ?? throw new InvalidOperationException("Could not start netcoredbg");
            proc.EnableRaisingEvents = true;
            proc.Exited += (_, _) => End(null);
            _ = Task.Run(ReadLoop);
            _ = Task.Run(async () =>
            {
                string? line;
                while ((line = await proc.StandardError.ReadLineAsync()) is not null) log.LogDebug("netcoredbg: {Line}", line);
            });
            Publish("debug.state", new { state = "starting", program = Program });

            await RequestAsync("initialize", new JsonObject
            {
                ["clientID"] = "kod", ["clientName"] = "Kod", ["adapterID"] = "coreclr", ["pathFormat"] = "path",
                ["linesStartAt1"] = true, ["columnsStartAt1"] = true, ["supportsVariableType"] = true, ["supportsRunInTerminalRequest"] = false,
            }, ct);
            var envObj = new JsonObject();
            foreach (var (k, v) in env) envObj[k] = v;
            var launch = RequestAsync("launch", new JsonObject
            {
                ["name"] = ".NET Launch", ["type"] = "coreclr", ["request"] = "launch", ["program"] = Program, ["args"] = new JsonArray(),
                ["cwd"] = cwd, ["env"] = envObj, ["stopAtEntry"] = stopAtEntry, ["console"] = "internalConsole", ["justMyCode"] = true,
            }, ct);
            // netcoredbg answers 'initialized' once launch is under way: breakpoints, then configurationDone
            var first = await Task.WhenAny(initialized.Task, launch, Task.Delay(TimeSpan.FromSeconds(30), ct));
            if (first == launch) await launch; // a failed launch throws here
            foreach (var (path, lines) in breakpoints) await SetBreakpointsAsync(path, lines, ct);
            await RequestAsync("setExceptionBreakpoints", new JsonObject { ["filters"] = new JsonArray() }, ct);
            await RequestAsync("configurationDone", new JsonObject(), ct);
            await launch;
            SetState("running");
        }

        public async Task<IReadOnlyList<VerifiedBreakpointDto>> SetBreakpointsAsync(string path, List<BreakpointDto> lines, CancellationToken ct)
        {
            var bps = new JsonArray();
            foreach (var b in lines)
            {
                var o = new JsonObject { ["line"] = b.Line };
                if (!string.IsNullOrWhiteSpace(b.Condition)) o["condition"] = b.Condition;
                bps.Add(o);
            }
            var body = await RequestAsync("setBreakpoints", new JsonObject { ["source"] = new JsonObject { ["path"] = path, ["name"] = System.IO.Path.GetFileName(path) }, ["breakpoints"] = bps }, ct);
            return body["breakpoints"] is JsonArray arr
                ? arr.Select(x => new VerifiedBreakpointDto((int?)x?["line"] ?? 0, (bool?)x?["verified"] ?? false, (string?)x?["message"])).ToList()
                : [];
        }

        public async Task StepAsync(string command, CancellationToken ct)
        {
            var thread = StoppedThread ?? await FirstThreadAsync(ct);
            switch (command)
            {
                case "continue":
                case "next":
                case "stepIn":
                case "stepOut":
                    if (State != "stopped") return;
                    SetState("running");
                    await RequestAsync(command, new JsonObject { ["threadId"] = thread }, ct);
                    break;
                case "pause":
                    if (State != "running") return;
                    await RequestAsync("pause", new JsonObject { ["threadId"] = thread }, ct);
                    break;
                default:
                    throw new ArgumentException($"Unknown debug command '{command}'");
            }
        }

        private async Task<int> FirstThreadAsync(CancellationToken ct)
        {
            var body = await RequestAsync("threads", new JsonObject(), ct);
            return body["threads"] is JsonArray { Count: > 0 } t ? (int?)t[0]?["id"] ?? 0 : 0;
        }

        public async Task<IReadOnlyList<ScopeDto>> ScopesAsync(int frameId, CancellationToken ct)
        {
            var body = await RequestAsync("scopes", new JsonObject { ["frameId"] = frameId }, ct);
            return body["scopes"] is JsonArray arr
                ? arr.Select(x => new ScopeDto((string?)x?["name"] ?? "", (int?)x?["variablesReference"] ?? 0, (bool?)x?["expensive"] ?? false)).ToList()
                : [];
        }

        public async Task<IReadOnlyList<VariableDto>> VariablesAsync(int reference, CancellationToken ct, int max = 500)
        {
            var args = new JsonObject { ["variablesReference"] = reference };
            // big arrays: ask for the first ones only (the debugger may still send all; they are cut below)
            if (max < 500) args["count"] = max;
            var body = await RequestAsync("variables", args, ct);
            return body["variables"] is JsonArray arr
                ? arr.Select(x => new VariableDto((string?)x?["name"] ?? "", (string?)x?["value"] ?? "", (string?)x?["type"], (int?)x?["variablesReference"] ?? 0, (string?)x?["evaluateName"])).Take(max).ToList()
                : [];
        }

        public async Task<EvaluateDto> EvaluateAsync(string expression, int? frameId, string context, CancellationToken ct)
        {
            var args = new JsonObject { ["expression"] = expression, ["context"] = context };
            if (frameId is { } f) args["frameId"] = f;
            var body = await RequestAsync("evaluate", args, ct);
            return new EvaluateDto((string?)body["result"] ?? "", (string?)body["type"], (int?)body["variablesReference"] ?? 0);
        }

        private async Task OnStoppedAsync(JsonObject body)
        {
            var thread = (int?)body["threadId"] ?? await FirstThreadAsync(CancellationToken.None);
            StoppedThread = thread;
            SetState("stopped", publish: false);
            var frames = new List<FrameDto>();
            try
            {
                var st = await RequestAsync("stackTrace", new JsonObject { ["threadId"] = thread, ["startFrame"] = 0, ["levels"] = 64 }, CancellationToken.None);
                if (st["stackFrames"] is JsonArray arr)
                    foreach (var f in arr)
                        frames.Add(new FrameDto((int?)f?["id"] ?? 0, (string?)f?["name"] ?? "?", (string?)f?["source"]?["path"], (int?)f?["line"] ?? 0, (int?)f?["column"] ?? 0));
            }
            catch (Exception ex)
            {
                log.LogDebug(ex, "stackTrace failed");
            }
            Publish("debug.stopped", new { reason = (string?)body["reason"], description = (string?)body["description"] ?? (string?)body["text"], threadId = thread, frames });
        }

        private void SetState(string state, bool publish = true)
        {
            State = state;
            if (state != "stopped") StoppedThread = null;
            if (publish) Publish("debug.state", new { state, program = Program });
        }

        private void Publish(string type, object payload) => hub.Publish(type, payload);

        // ---- wire protocol: Content-Length framed JSON

        private async Task<JsonObject> RequestAsync(string command, JsonObject args, CancellationToken ct)
        {
            var id = Interlocked.Increment(ref seq);
            var tcs = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending[id] = tcs;
            var msg = new JsonObject { ["seq"] = id, ["type"] = "request", ["command"] = command, ["arguments"] = args };
            var bytes = Encoding.UTF8.GetBytes(msg.ToJsonString());
            await writeLock.WaitAsync(ct);
            try
            {
                var stdin = proc!.StandardInput.BaseStream;
                await stdin.WriteAsync(Encoding.ASCII.GetBytes($"Content-Length: {bytes.Length}\r\n\r\n"), ct);
                await stdin.WriteAsync(bytes, ct);
                await stdin.FlushAsync(ct);
            }
            finally
            {
                writeLock.Release();
            }
            using var reg = ct.Register(() => tcs.TrySetCanceled());
            var timeout = command is "launch" or "configurationDone" ? TimeSpan.FromSeconds(60) : TimeSpan.FromSeconds(20);
            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeout, CancellationToken.None));
            if (done != tcs.Task)
            {
                pending.TryRemove(id, out _);
                throw new TimeoutException($"The debugger did not answer '{command}'");
            }
            return await tcs.Task;
        }

        private async Task ReadLoop()
        {
            var stream = proc!.StandardOutput.BaseStream;
            var header = new StringBuilder();
            try
            {
                while (true)
                {
                    header.Clear();
                    int length = -1;
                    // headers end with an empty line
                    while (true)
                    {
                        var line = await ReadLineAsync(stream);
                        if (line is null) return;
                        if (line.Length == 0) break;
                        if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) length = int.Parse(line[15..].Trim());
                    }
                    if (length < 0) continue;
                    var buf = new byte[length];
                    var read = 0;
                    while (read < length)
                    {
                        var n = await stream.ReadAsync(buf.AsMemory(read, length - read));
                        if (n == 0) return;
                        read += n;
                    }
                    Dispatch(JsonNode.Parse(buf)?.AsObject());
                }
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
            {
            }
            finally
            {
                End(null);
            }
        }

        private static async Task<string?> ReadLineAsync(Stream s)
        {
            var sb = new StringBuilder();
            var one = new byte[1];
            while (true)
            {
                var n = await s.ReadAsync(one);
                if (n == 0) return sb.Length > 0 ? sb.ToString() : null;
                if (one[0] == '\n') return sb.ToString().TrimEnd('\r');
                sb.Append((char)one[0]);
            }
        }

        private void Dispatch(JsonObject? msg)
        {
            if (msg is null) return;
            switch ((string?)msg["type"])
            {
                case "response":
                    if (pending.TryRemove((int?)msg["request_seq"] ?? -1, out var tcs))
                    {
                        if ((bool?)msg["success"] == true) tcs.TrySetResult(msg["body"]?.AsObject() ?? new JsonObject());
                        else tcs.TrySetException(new InvalidOperationException((string?)msg["message"] ?? (string?)msg["body"]?["error"]?["format"] ?? $"{msg["command"]} failed"));
                    }
                    break;
                case "event":
                    var body = msg["body"]?.AsObject() ?? new JsonObject();
                    switch ((string?)msg["event"])
                    {
                        case "initialized":
                            initialized.TrySetResult();
                            break;
                        case "process":
                            DebuggeePid = (int?)body["systemProcessId"];
                            break;
                        case "stopped":
                            _ = OnStoppedAsync(body);
                            break;
                        case "continued":
                            SetState("running");
                            break;
                        case "output":
                            var category = (string?)body["category"] ?? "console";
                            if (category == "telemetry") break;
                            Publish("debug.output", new { category, text = (string?)body["output"] ?? "" });
                            break;
                        case "exited":
                            Publish("debug.output", new { category = "console", text = $"\nProcess exited with code {(int?)body["exitCode"] ?? 0}.\n" });
                            break;
                        case "terminated":
                            End(null);
                            break;
                    }
                    break;
            }
        }

        private void End(string? reason)
        {
            if (Interlocked.Exchange(ref disposed, 1) == 1) return;
            foreach (var (_, t) in pending) t.TrySetException(new InvalidOperationException("The debug session ended"));
            pending.Clear();
            initialized.TrySetResult();
            if (proc is { HasExited: false } p)
            {
                // Kill(entireProcessTree) can throw on a child that is already exiting and then skip netcoredbg itself:
                // ask nicely, kill the tree, then make sure of the adapter
                try
                {
                    var bytes = Encoding.UTF8.GetBytes(new JsonObject { ["seq"] = 999_999, ["type"] = "request", ["command"] = "disconnect", ["arguments"] = new JsonObject { ["terminateDebuggee"] = true } }.ToJsonString());
                    var stdin = p.StandardInput.BaseStream;
                    stdin.Write(Encoding.ASCII.GetBytes($"Content-Length: {bytes.Length}\r\n\r\n"));
                    stdin.Write(bytes);
                    stdin.Flush();
                    p.WaitForExit(1500);
                }
                catch
                {
                    // the pipe is gone
                }
                try
                {
                    if (!p.HasExited) p.Kill(entireProcessTree: true);
                }
                catch
                {
                    // a child was already exiting
                }
                try
                {
                    if (!p.HasExited) p.Kill();
                }
                catch
                {
                    // already gone
                }
            }
            State = "idle";
            Publish("debug.ended", new { reason });
            Ended?.Invoke();
        }

        public void Dispose() => End("stopped");
    }
}
