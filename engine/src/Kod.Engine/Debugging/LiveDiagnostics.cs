using System.ComponentModel;
using System.Diagnostics;
using System.Diagnostics.Tracing;
using System.Runtime.InteropServices;
using Kod.Engine.Infrastructure;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;

namespace Kod.Engine.Debugging;

/// <summary>
/// Visual Studio's Diagnostic Tools for the program being debugged: once a second the runtime's counters (CPU, memory,
/// GC heap, collections, allocations, exceptions, thread pool, lock contention) as debug.diag events, and every
/// exception and garbage collection as debug.diag.event, read over EventPipe (no code in the program, no profiler).
/// Programs that are not .NET (or out of reach, in a container) still get CPU and memory from the OS.
/// </summary>
public sealed class LiveDiagnostics(EventHub hub, ILogger<LiveDiagnostics> log) : IDisposable
{
    private readonly object sync = new();
    private Run? run;

    public int? Pid => run?.Pid;

    public void Start(int pid)
    {
        Stop();
        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return;
        }
        var r = new Run(pid, process, hub, log);
        lock (sync) run = r;
        r.Start();
        log.LogInformation("Live diagnostics on process {Pid}", pid);
    }

    public void Stop()
    {
        Run? r;
        lock (sync)
        {
            r = run;
            run = null;
        }
        r?.Dispose();
    }

    public void Dispose() => Stop();

    private sealed class Run(int pid, Process process, EventHub hub, ILogger log) : IDisposable
    {
        private readonly CancellationTokenSource cts = new();
        private readonly Dictionary<string, double> counters = new(StringComparer.Ordinal);
        private EventPipeSession? session;
        private TimeSpan lastCpu;
        private long lastTick;
        private int exceptionsThisSecond;
        public int Pid { get; } = pid;

        public void Start()
        {
            lastCpu = Cpu();
            lastTick = Environment.TickCount64;
            _ = Task.Run(Listen);
            _ = Task.Run(Tick);
        }

        private TimeSpan Cpu()
        {
            try
            {
                process.Refresh();
                return process.TotalProcessorTime;
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException)
            {
                return lastCpu;
            }
        }

        /// <summary>EventPipe: the System.Runtime counters every second, exceptions and GCs as they happen.</summary>
        private void Listen()
        {
            try
            {
                var client = new DiagnosticsClient(Pid);
                var providers = new[]
                {
                    new EventPipeProvider("System.Runtime", EventLevel.Informational, 0, new Dictionary<string, string> { ["EventCounterIntervalSec"] = "1" }),
                    new EventPipeProvider("Microsoft-Windows-DotNETRuntime", EventLevel.Informational, (long)(ClrTraceEventParser.Keywords.Exception | ClrTraceEventParser.Keywords.GC)),
                };
                session = client.StartEventPipeSession(providers, requestRundown: false);
                using var source = new EventPipeEventSource(session.EventStream);
                source.Dynamic.All += e =>
                {
                    if (e.EventName != "EventCounters" || e.PayloadValue(0) is not IDictionary<string, object> outer) return;
                    // the counter's fields sit one level down: { Payload: { Name, Mean, Increment, CounterType … } }
                    var payload = outer.TryGetValue("Payload", out var inner) && inner is IDictionary<string, object> d ? d : outer;
                    var name = payload.TryGetValue("Name", out var n) ? n as string : null;
                    if (name is null) return;
                    // a rate counter reports its increment, a gauge its mean
                    var value = payload.TryGetValue("CounterType", out var ct) && ct as string == "Sum"
                        ? Convert.ToDouble(payload.TryGetValue("Increment", out var inc) ? inc : 0)
                        : Convert.ToDouble(payload.TryGetValue("Mean", out var mean) ? mean : 0);
                    lock (counters) counters[name] = value;
                };
                source.Clr.ExceptionStart += e =>
                {
                    if (Interlocked.Increment(ref exceptionsThisSecond) > 30) return;
                    // not "type": every event's own type field
                    hub.Publish("debug.diag.event", new { kind = "exception", time = DateTimeOffset.Now.ToUnixTimeMilliseconds(), exceptionType = e.ExceptionType, message = e.ExceptionMessage });
                };
                source.Clr.GCStart += e =>
                    hub.Publish("debug.diag.event", new { kind = "gc", time = DateTimeOffset.Now.ToUnixTimeMilliseconds(), generation = e.Depth, reason = e.Reason.ToString() });
                source.Process();
            }
            catch (Exception ex) when (!cts.IsCancellationRequested)
            {
                // not a .NET process, an old runtime, or diagnostics disabled: OS figures only
                log.LogDebug(ex, "EventPipe on {Pid} unavailable", Pid);
                hub.Publish("debug.diag.event", new { kind = "info", time = DateTimeOffset.Now.ToUnixTimeMilliseconds(), message = "Runtime counters are not available for this process (only CPU and memory)." });
            }
            catch
            {
                // stopped
            }
        }

        private async Task Tick()
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            try
            {
                while (await timer.WaitForNextTickAsync(cts.Token))
                {
                    if (process.HasExited) break;
                    var now = Environment.TickCount64;
                    var cpu = Cpu();
                    var cpuPercent = (cpu - lastCpu).TotalMilliseconds / Math.Max(1, now - lastTick) / Environment.ProcessorCount * 100;
                    lastCpu = cpu;
                    lastTick = now;
                    Dictionary<string, double> c;
                    lock (counters) c = new Dictionary<string, double>(counters);
                    Interlocked.Exchange(ref exceptionsThisSecond, 0);
                    hub.Publish("debug.diag", new
                    {
                        pid = Pid,
                        time = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
                        cpu = Math.Round(Math.Clamp(cpuPercent, 0, 100), 1),
                        workingSetMb = Math.Round(process.WorkingSet64 / 1048576.0, 1),
                        privateMb = Math.Round(process.PrivateMemorySize64 / 1048576.0, 1),
                        threads = SafeThreads(),
                        gcHeapMb = c.TryGetValue("gc-heap-size", out var heap) ? Math.Round(heap, 1) : (double?)null,
                        gen0 = c.GetValueOrDefault("gen-0-gc-count"),
                        gen1 = c.GetValueOrDefault("gen-1-gc-count"),
                        gen2 = c.GetValueOrDefault("gen-2-gc-count"),
                        timeInGc = c.TryGetValue("time-in-gc", out var gc) ? Math.Round(gc, 1) : (double?)null,
                        allocMbPerSec = c.TryGetValue("alloc-rate", out var alloc) ? Math.Round(alloc / 1048576.0, 2) : (double?)null,
                        exceptions = c.GetValueOrDefault("exception-count"),
                        threadPoolThreads = c.TryGetValue("threadpool-thread-count", out var tp) ? tp : (double?)null,
                        threadPoolQueue = c.TryGetValue("threadpool-queue-length", out var q) ? q : (double?)null,
                        lockContention = c.GetValueOrDefault("monitor-lock-contention-count"),
                        runtime = c.Count > 0,
                    });
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (InvalidOperationException)
            {
                // the process is gone
            }
        }

        private int SafeThreads()
        {
            try
            {
                return process.Threads.Count;
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
            {
                return 0;
            }
        }

        public void Dispose()
        {
            cts.Cancel();
            try
            {
                session?.Stop();
            }
            catch
            {
                // the program already exited
            }
            session?.Dispose();
            process.Dispose();
        }
    }

    // ------------------------------------------------------------------ finding the debuggee

    /// <summary>The newest child process of <paramref name="parent"/> (netcoredbg starts the program as its child).</summary>
    public static int? ChildOf(int parent)
    {
        try
        {
            if (OperatingSystem.IsWindows()) return WindowsChild(parent);
            if (OperatingSystem.IsLinux())
            {
                return Directory.EnumerateDirectories("/proc")
                    .Select(d => int.TryParse(Path.GetFileName(d), out var pid) ? pid : 0)
                    .Where(pid => pid > 0 && LinuxParent(pid) == parent)
                    .OrderByDescending(p => p)
                    .Cast<int?>()
                    .FirstOrDefault();
            }
            // macOS: pgrep -P
            using var p = Process.Start(new ProcessStartInfo("pgrep", ["-P", parent.ToString()]) { RedirectStandardOutput = true, UseShellExecute = false });
            var text = p!.StandardOutput.ReadToEnd();
            p.WaitForExit(2000);
            return text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(s => int.TryParse(s, out var x) ? x : 0).Where(x => x > 0).Cast<int?>().LastOrDefault();
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or Win32Exception or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static int LinuxParent(int pid)
    {
        try
        {
            var stat = File.ReadAllText($"/proc/{pid}/stat");
            // pid (comm) state ppid …: comm may hold spaces, so read after the last ')'
            var rest = stat[(stat.LastIndexOf(')') + 2)..].Split(' ');
            return int.Parse(rest[1]);
        }
        catch (Exception ex) when (ex is IOException or FormatException or IndexOutOfRangeException or UnauthorizedAccessException)
        {
            return -1;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static int? WindowsChild(int parent)
    {
        var snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
        if (snap == new IntPtr(-1)) return null;
        try
        {
            var e = new ProcessEntry32 { dwSize = (uint)Marshal.SizeOf<ProcessEntry32>() };
            int? found = null;
            for (var ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
            {
                // conhost.exe is the console host of every console child, not the program
                if (e.th32ParentProcessID == parent && !e.szExeFile.Equals("conhost.exe", StringComparison.OrdinalIgnoreCase)) found = (int)e.th32ProcessID;
            }
            return found;
        }
        finally
        {
            CloseHandle(snap);
        }
    }
}
