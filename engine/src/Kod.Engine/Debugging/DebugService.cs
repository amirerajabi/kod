using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;

namespace Kod.Engine.Debugging;

/// <param name="HitCondition">"N" or "= N" (the Nth hit), "&gt;= N", "&gt; N", "% N" (every Nth); the engine counts, netcoredbg has no hit counts.</param>
/// <param name="LogMessage">Printed to the console on a hit, {expressions} evaluated in the frame (netcoredbg has no logpoints either).</param>
/// <param name="Suspend">False: log and go on without pausing.</param>
public sealed record BreakpointDto(int Line, string? Condition = null, string? HitCondition = null, string? LogMessage = null, bool Suspend = true);

/// <summary><see cref="Docker"/>: debug inside a container (Rider's fast mode, see <see cref="Kod.Engine.Docker.DockerService.PrepareDebugAsync"/>).
/// The rest come from the run configuration: launch profile (<see cref="NoProfile"/> ignores launchSettings.json), program arguments,
/// environment variables, working directory.</summary>
public sealed record DebugStartRequest(
    string ProjectPath,
    Dictionary<string, List<BreakpointDto>>? Breakpoints,
    bool StopAtEntry = false,
    bool Docker = false,
    string? Profile = null,
    bool NoProfile = false,
    List<string>? Args = null,
    Dictionary<string, string>? Env = null,
    string? Cwd = null,
    List<string>? ExceptionFilters = null);

public sealed record AttachRequest(int ProcessId, Dictionary<string, List<BreakpointDto>>? Breakpoints, List<string>? ExceptionFilters = null);

public sealed record DotnetProcessDto(int Id, string Name, string? Path, long? StartedAt, string? Title);

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
        var projectDir = System.IO.Path.GetDirectoryName(req.ProjectPath)!;
        var cwd = string.IsNullOrWhiteSpace(req.Cwd) ? projectDir : req.Cwd!;

        Session s;
        string launchCwd = cwd;
        var (env, profileArgs) = LaunchEnv(req.ProjectPath, req.NoProfile ? null : req.Profile ?? "", req.Env);
        var args = req.Args is { Count: > 0 } ? req.Args : profileArgs;
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
            var envObj = new JsonObject();
            foreach (var (k, v) in env) envObj[k] = v;
            var launch = new JsonObject
            {
                ["name"] = ".NET Launch", ["type"] = "coreclr", ["request"] = "launch", ["program"] = s.Program, ["args"] = new JsonArray(args.Select(a => (JsonNode?)a).ToArray()),
                ["cwd"] = launchCwd, ["env"] = envObj, ["stopAtEntry"] = req.StopAtEntry, ["console"] = "internalConsole", ["justMyCode"] = true,
            };
            await s.StartAsync(projectDir, "launch", launch, req.Breakpoints ?? [], req.ExceptionFilters ?? [], ct);
            if (!req.Docker) _ = WatchAsync(s);
        }
        catch
        {
            s.Dispose();
            throw;
        }
        return State();
    }

    /// <summary>Attaches to a running .NET process (Rider's Attach to Process); stopping detaches and leaves it running.</summary>
    public async Task<object> AttachAsync(AttachRequest req, CancellationToken ct)
    {
        Stop();
        var exe = adapter.Locate() ?? throw new InvalidOperationException("The debugger (netcoredbg) is not installed. Settings › Debugger downloads it.");
        string name;
        try
        {
            using var p = Process.GetProcessById(req.ProcessId);
            name = p.ProcessName;
        }
        catch (ArgumentException)
        {
            throw new InvalidOperationException($"Process {req.ProcessId} is not running");
        }
        var s = new Session(exe, [], $"{name} ({req.ProcessId})", hub, log) { Attached = true };
        lock (sync) session = s;
        s.Ended += () =>
        {
            diagnostics.Stop();
            lock (sync)
                if (session == s) session = null;
        };
        try
        {
            var attach = new JsonObject { ["name"] = ".NET Attach", ["type"] = "coreclr", ["request"] = "attach", ["processId"] = req.ProcessId, ["justMyCode"] = true };
            await s.StartAsync(Environment.CurrentDirectory, "attach", attach, req.Breakpoints ?? [], req.ExceptionFilters ?? [], ct);
            diagnostics.Start(req.ProcessId);
        }
        catch
        {
            s.Dispose();
            throw;
        }
        return State();
    }

    /// <summary>The .NET processes that can be attached to (those with a diagnostics endpoint), Kod's own engine left out.</summary>
    public static IReadOnlyList<DotnetProcessDto> Processes()
    {
        var list = new List<DotnetProcessDto>();
        foreach (var pid in Microsoft.Diagnostics.NETCore.Client.DiagnosticsClient.GetPublishedProcesses())
        {
            if (pid == Environment.ProcessId) continue;
            try
            {
                using var p = Process.GetProcessById(pid);
                string? path = null;
                long? started = null;
                try
                {
                    path = p.MainModule?.FileName;
                    started = new DateTimeOffset(p.StartTime).ToUnixTimeMilliseconds();
                }
                catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException)
                {
                    // another user's or an elevated process
                }
                list.Add(new DotnetProcessDto(pid, p.ProcessName, path, started, string.IsNullOrEmpty(p.MainWindowTitle) ? null : p.MainWindowTitle));
            }
            catch (ArgumentException)
            {
                // exited meanwhile
            }
        }
        return list.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ThenBy(p => p.Id).ToList();
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

    /// <summary>
    /// The development environment, then the launch profile's URL, variables and arguments (<paramref name="profile"/>: a name,
    /// "" for the one `dotnet run` picks, null for none), then the run configuration's own variables.
    /// </summary>
    private static (Dictionary<string, string> Env, List<string> Args) LaunchEnv(string projectPath, string? profile, Dictionary<string, string>? extra)
    {
        var env = new Dictionary<string, string> { ["ASPNETCORE_ENVIRONMENT"] = "Development", ["DOTNET_ENVIRONMENT"] = "Development" };
        List<string> args = [];
        if (profile is not null && Kod.Engine.Processes.LaunchProfiles.Pick(projectPath, profile.Length == 0 ? null : profile) is { } p)
        {
            if (p.ApplicationUrl is { } url) env["ASPNETCORE_URLS"] = url;
            foreach (var (k, v) in p.Env) env[k] = v;
            args = Kod.Engine.Processes.LaunchProfiles.SplitArgs(p.CommandLineArgs);
        }
        if (extra is not null) foreach (var (k, v) in extra) env[k] = v;
        return (env, args);
    }

    internal Session Active() => session ?? throw new InvalidOperationException("No debug session");

    public Task<IReadOnlyList<VerifiedBreakpointDto>> SetBreakpointsAsync(string path, List<BreakpointDto> lines, CancellationToken ct) =>
        session is { } s ? s.SetBreakpointsAsync(path, lines, ct) : Task.FromResult<IReadOnlyList<VerifiedBreakpointDto>>([]);

    public Task StepAsync(string command, CancellationToken ct) => Active().StepAsync(command, ct);
    public Task<IReadOnlyList<ScopeDto>> ScopesAsync(int frameId, CancellationToken ct) => Active().ScopesAsync(frameId, ct);
    public Task<IReadOnlyList<VariableDto>> VariablesAsync(int reference, CancellationToken ct) => Active().VariablesAsync(reference, ct);
    public Task<EvaluateDto> EvaluateAsync(string expression, int? frameId, string context, CancellationToken ct) => Active().EvaluateAsync(expression, frameId, context, ct);

    public Task<VisualDto> VisualizeAsync(VisualizeRequest r, CancellationToken ct) => Visualizers.VisualizeAsync(Active(), r, ct);
    public Task<EvaluateDto> SetVariableAsync(int reference, string name, string value, CancellationToken ct) => Active().SetVariableAsync(reference, name, value, ct);
    public Task RunToAsync(string path, int line, CancellationToken ct) => Active().RunToAsync(PathUtil.Normalize(path), line, ct);

    public Task SetExceptionFiltersAsync(List<string> filters, CancellationToken ct) =>
        session is { } s ? s.SetExceptionFiltersAsync(filters, ct) : Task.CompletedTask;

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
        /// <summary>The breakpoints as the UI set them, by normalized path: hit counts and logpoints are matched against them.</summary>
        private readonly ConcurrentDictionary<string, List<BreakpointDto>> breakpoints = new(StringComparer.OrdinalIgnoreCase);
        private readonly ConcurrentDictionary<string, int> hits = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>Run to Cursor: a breakpoint of the engine's own, gone at the next stop.</summary>
        private (string Path, int Line)? runTo;

        public string Program { get; } = program;
        /// <summary>Attached to a process Kod did not start: stopping detaches.</summary>
        public bool Attached { get; init; }
        public string State { get; private set; } = "starting";
        public int? StoppedThread { get; private set; }
        /// <summary>The program's process id, when the debugger reports it.</summary>
        public int? DebuggeePid { get; private set; }
        public int? AdapterPid => proc?.Id;
        public event Action? Ended;

        /// <param name="request">"launch" or "attach", with its DAP arguments.</param>
        public async Task StartAsync(string hostCwd, string request, JsonObject arguments, Dictionary<string, List<BreakpointDto>> initial, List<string> exceptionFilters, CancellationToken ct)
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
            var start = RequestAsync(request, arguments, ct);
            // netcoredbg answers 'initialized' once launch / attach is under way: breakpoints, then configurationDone
            var first = await Task.WhenAny(initialized.Task, start, Task.Delay(TimeSpan.FromSeconds(30), ct));
            if (first == start) await start; // a failed launch throws here
            foreach (var (path, lines) in initial) await SetBreakpointsAsync(path, lines, ct);
            await SetExceptionFiltersAsync(exceptionFilters, ct);
            await RequestAsync("configurationDone", new JsonObject(), ct);
            await start;
            SetState("running");
        }

        /// <summary>"all" (every thrown exception) and / or "user-unhandled" (not caught by user code).</summary>
        public Task SetExceptionFiltersAsync(List<string> filters, CancellationToken ct) =>
            RequestAsync("setExceptionBreakpoints", new JsonObject { ["filters"] = new JsonArray(filters.Select(f => (JsonNode?)f).ToArray()) }, ct);

        public async Task<IReadOnlyList<VerifiedBreakpointDto>> SetBreakpointsAsync(string path, List<BreakpointDto> lines, CancellationToken ct)
        {
            breakpoints[PathUtil.Normalize(path)] = lines;
            var bps = new JsonArray();
            foreach (var b in lines)
            {
                var o = new JsonObject { ["line"] = b.Line };
                if (!string.IsNullOrWhiteSpace(b.Condition)) o["condition"] = b.Condition;
                bps.Add(o);
            }
            // the Run to Cursor line rides along last, so the UI's breakpoints keep their indexes
            if (runTo is { } rt && PathUtil.Equal(rt.Path, path) && lines.All(b => b.Line != rt.Line)) bps.Add(new JsonObject { ["line"] = rt.Line });
            var body = await RequestAsync("setBreakpoints", new JsonObject { ["source"] = new JsonObject { ["path"] = path, ["name"] = System.IO.Path.GetFileName(path) }, ["breakpoints"] = bps }, ct);
            return body["breakpoints"] is JsonArray arr
                ? arr.Take(lines.Count).Select(x => new VerifiedBreakpointDto((int?)x?["line"] ?? 0, (bool?)x?["verified"] ?? false, (string?)x?["message"])).ToList()
                : [];
        }

        private Task ResendAsync(string path, CancellationToken ct) => SetBreakpointsAsync(path, breakpoints.GetValueOrDefault(PathUtil.Normalize(path)) ?? [], ct);

        public async Task RunToAsync(string path, int line, CancellationToken ct)
        {
            if (State != "stopped") throw new InvalidOperationException("Run to Cursor works while paused");
            if (runTo is { } old && !PathUtil.Equal(old.Path, path))
            {
                runTo = null;
                await ResendAsync(old.Path, ct);
            }
            runTo = (path, line);
            await ResendAsync(path, ct);
            await StepAsync("continue", ct);
        }

        public async Task<EvaluateDto> SetVariableAsync(int reference, string name, string value, CancellationToken ct)
        {
            var body = await RequestAsync("setVariable", new JsonObject { ["variablesReference"] = reference, ["name"] = name, ["value"] = value }, ct);
            return new EvaluateDto((string?)body["value"] ?? value, (string?)body["type"], (int?)body["variablesReference"] ?? 0);
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
            var reason = (string?)body["reason"];
            var top = frames.FirstOrDefault();

            object? hit = null;
            var atRunTo = runTo is { } target && top?.Path is { } tp && PathUtil.Equal(tp, target.Path) && top.Line == target.Line;
            if (reason == "breakpoint" && !atRunTo && top?.Path is { } path && Find(path, top.Line) is { } bp)
            {
                hit = new { path, line = bp.Line };
                var n = hits.AddOrUpdate($"{PathUtil.Normalize(path)}:{bp.Line}", 1, (_, c) => c + 1);
                if (!HitMatches(bp.HitCondition, n))
                {
                    await ResumeQuietlyAsync(thread);
                    return;
                }
                if (!string.IsNullOrWhiteSpace(bp.LogMessage))
                    Publish("debug.output", new { category = "log", text = await InterpolateAsync(bp.LogMessage, top.Id) + "\n" });
                if (!bp.Suspend)
                {
                    await ResumeQuietlyAsync(thread);
                    return;
                }
            }

            // a stop that pauses ends a Run to Cursor (hits that go on, above, do not)
            if (runTo is { } rt)
            {
                runTo = null;
                await ResendAsync(rt.Path, CancellationToken.None);
                if (atRunTo && reason == "breakpoint") reason = "run to cursor";
            }

            object? exception = null;
            if (reason == "exception")
            {
                try
                {
                    var info = await RequestAsync("exceptionInfo", new JsonObject { ["threadId"] = thread }, CancellationToken.None);
                    exception = new { type = (string?)info["exceptionId"], message = (string?)info["description"] ?? (string?)info["details"]?["message"], breakMode = (string?)info["breakMode"] };
                }
                catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
                {
                    log.LogDebug(ex, "exceptionInfo failed");
                }
            }
            SetState("stopped", publish: false);
            Publish("debug.stopped", new { reason, description = (string?)body["description"] ?? (string?)body["text"], threadId = thread, frames, breakpoint = hit, exception });
        }

        private BreakpointDto? Find(string path, int line) =>
            breakpoints.TryGetValue(PathUtil.Normalize(path), out var list) ? list.FirstOrDefault(b => b.Line == line) : null;

        /// <summary>A hit count condition against the number of hits so far.</summary>
        internal static bool HitMatches(string? condition, int hits)
        {
            if (string.IsNullOrWhiteSpace(condition)) return true;
            var m = System.Text.RegularExpressions.Regex.Match(condition.Trim(), @"^(>=|>|==|=|%)?\s*(\d+)$");
            if (!m.Success) return true;
            var n = int.Parse(m.Groups[2].Value);
            return m.Groups[1].Value switch
            {
                ">=" => hits >= n,
                ">" => hits > n,
                "%" => n > 0 && hits % n == 0,
                _ => hits == n,
            };
        }

        /// <summary>"x = {x}, count = {list.Count}": each {expression} evaluated in the frame.</summary>
        private async Task<string> InterpolateAsync(string message, int frameId)
        {
            var sb = new StringBuilder();
            var last = 0;
            foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(message, @"\{([^{}]+)\}"))
            {
                sb.Append(message, last, m.Index - last);
                try
                {
                    sb.Append((await EvaluateAsync(m.Groups[1].Value, frameId, "watch", CancellationToken.None)).Result);
                }
                catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
                {
                    sb.Append('<').Append(ex.Message).Append('>');
                }
                last = m.Index + m.Length;
            }
            return sb.Append(message, last, message.Length - last).ToString();
        }

        /// <summary>A hit that does not pause (hit count not reached, a logpoint): go on without telling the UI it stopped.</summary>
        private async Task ResumeQuietlyAsync(int thread)
        {
            SetState("running", publish: false);
            try
            {
                await RequestAsync("continue", new JsonObject { ["threadId"] = thread }, CancellationToken.None);
            }
            catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
            {
                log.LogDebug(ex, "continue after a non-suspending hit failed");
            }
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
                    var bytes = Encoding.UTF8.GetBytes(new JsonObject { ["seq"] = 999_999, ["type"] = "request", ["command"] = "disconnect", ["arguments"] = new JsonObject { ["terminateDebuggee"] = !Attached } }.ToJsonString());
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
