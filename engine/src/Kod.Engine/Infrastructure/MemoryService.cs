using System.Diagnostics;
using System.Runtime;
using Kod.Engine.Workspace;

namespace Kod.Engine.Infrastructure;

/// <summary>A cache the memory service may empty (code action snapshots, completion lists, analyzer sets…).</summary>
public interface ITrimmable
{
    string CacheName { get; }
    int CacheCount { get; }
    /// <summary>Drops what can be recomputed; <paramref name="aggressive"/> drops everything.</summary>
    void Trim(bool aggressive);
}

public sealed record MemorySettingsDto(int SoftLimitMb, bool IdleTrim, bool Warnings);

public sealed record CacheStatDto(string Name, int Count);

public sealed record MemoryStatsDto(
    long WorkingSetMb, long PrivateMb, long ManagedHeapMb, long HeapSizeMb, long FragmentedMb, long CommittedMb,
    long MachineMb, int Gen0, int Gen1, int Gen2, double PauseMs, double PausePercent,
    int Projects, int UnloadedProjects, int Documents, int OpenDocuments,
    IReadOnlyList<CacheStatDto> Caches, MemorySettingsDto Settings, DateTimeOffset? LastTrim, long? LastFreedMb, string? LastTrimReason);

public sealed record TrimResultDto(long BeforeMb, long AfterMb, long FreedMb, double Ms);

/// <summary>
/// Keeps the engine small: reports its memory, empties caches and returns freed memory to the OS on request, when the
/// user has been idle for a while after the heap grew, and when the engine goes over the soft limit (then it also
/// drops Roslyn's compilations, which are rebuilt on demand, and warns the UI once in a while).
/// </summary>
public sealed class MemoryService(IServiceProvider services, WorkspaceService workspace, EventHub hub, ILogger<MemoryService> log) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan IdleAfter = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan WarnEvery = TimeSpan.FromMinutes(15);
    private const long Mb = 1024 * 1024;

    private readonly SemaphoreSlim trimGate = new(1, 1);
    private IReadOnlyList<ITrimmable>? trimmables;
    private MemorySettingsDto settings = new(DefaultLimitMb(), IdleTrim: true, Warnings: true);
    private long lastActivity = Environment.TickCount64;
    private long heapAfterTrim;
    private DateTimeOffset? lastTrim;
    private long? lastFreed;
    private string? lastReason;
    private DateTimeOffset lastWarning = DateTimeOffset.MinValue;

    /// <summary>A quarter of the machine's memory, between 1 and 4 GB.</summary>
    public static int DefaultLimitMb() =>
        (int)Math.Clamp(GC.GetGCMemoryInfo().TotalAvailableMemoryBytes / Mb / 4, 1024, 4096);

    private IReadOnlyList<ITrimmable> Trimmables => trimmables ??= services.GetServices<ITrimmable>().ToList();

    /// <summary>Called for every request: trimming waits until the user is idle.</summary>
    public void Touch() => Interlocked.Exchange(ref lastActivity, Environment.TickCount64);

    private TimeSpan Idle => TimeSpan.FromMilliseconds(Environment.TickCount64 - Interlocked.Read(ref lastActivity));

    public MemorySettingsDto Settings => settings;

    public MemorySettingsDto Configure(MemorySettingsDto s)
    {
        settings = s with { SoftLimitMb = s.SoftLimitMb <= 0 ? DefaultLimitMb() : Math.Clamp(s.SoftLimitMb, 256, 64 * 1024) };
        return settings;
    }

    public MemoryStatsDto Stats()
    {
        using var p = Process.GetCurrentProcess();
        var info = GC.GetGCMemoryInfo(GCKind.Any);
        var ws = workspace.Stats();
        return new MemoryStatsDto(
            p.WorkingSet64 / Mb, p.PrivateMemorySize64 / Mb, GC.GetTotalMemory(false) / Mb, info.HeapSizeBytes / Mb, info.FragmentedBytes / Mb,
            info.TotalCommittedBytes / Mb, info.TotalAvailableMemoryBytes / Mb,
            GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2), GC.GetTotalPauseDuration().TotalMilliseconds, info.PauseTimePercentage,
            ws.Projects, ws.Unloaded, ws.Documents, ws.Open,
            Trimmables.Select(t => new CacheStatDto(t.CacheName, t.CacheCount)).ToList(), settings, lastTrim, lastFreed, lastReason);
    }

    /// <summary>
    /// Empties the caches and compacts the heap, giving the freed memory back to the OS. <paramref name="deep"/> also
    /// drops Roslyn's compilations and syntax trees (rebuilt the next time they are needed).
    /// </summary>
    public async Task<TrimResultDto> TrimAsync(bool deep, string reason)
    {
        await trimGate.WaitAsync().ConfigureAwait(false);
        try
        {
            var sw = Stopwatch.StartNew();
            var before = PrivateMb();
            foreach (var t in Trimmables)
            {
                try
                {
                    t.Trim(deep);
                }
                catch (Exception ex)
                {
                    log.LogWarning(ex, "Trimming {Cache} failed", t.CacheName);
                }
            }
            if (deep) workspace.DropSemanticState();
            GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            heapAfterTrim = GC.GetGCMemoryInfo(GCKind.Any).HeapSizeBytes;
            var after = PrivateMb();
            lastTrim = DateTimeOffset.Now;
            lastFreed = Math.Max(0, before - after);
            lastReason = reason;
            log.LogInformation("Memory trimmed ({Reason}{Deep}): {Before} MB → {After} MB in {Ms} ms", reason, deep ? ", deep" : "", before, after, sw.ElapsedMilliseconds);
            return new TrimResultDto(before, after, lastFreed.Value, sw.Elapsed.TotalMilliseconds);
        }
        finally
        {
            trimGate.Release();
        }
    }

    private static long PrivateMb()
    {
        using var p = Process.GetCurrentProcess();
        return p.PrivateMemorySize64 / Mb;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Tick);
        while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                await CheckAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Memory check failed");
            }
        }
    }

    private async Task CheckAsync()
    {
        var s = settings;
        var idle = Idle;
        var used = PrivateMb();
        if (used > s.SoftLimitMb && idle > TimeSpan.FromSeconds(5))
        {
            await TrimAsync(deep: true, "over the memory limit").ConfigureAwait(false);
            used = PrivateMb();
            if (used > s.SoftLimitMb && s.Warnings && DateTimeOffset.Now - lastWarning > WarnEvery)
            {
                lastWarning = DateTimeOffset.Now;
                hub.Publish("memory.pressure", new { usedMb = used, limitMb = s.SoftLimitMb, projects = workspace.Stats().Projects });
            }
            return;
        }
        // the heap grew since the last trim and the user stepped away: give the memory back while nobody waits
        var heap = GC.GetGCMemoryInfo(GCKind.Any).HeapSizeBytes;
        if (s.IdleTrim && idle > IdleAfter && heap - heapAfterTrim > 96 * Mb)
            await TrimAsync(deep: false, "idle").ConfigureAwait(false);
    }
}
