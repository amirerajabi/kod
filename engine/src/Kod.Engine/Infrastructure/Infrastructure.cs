using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kod.Engine.Infrastructure;

public static class KodJson
{
    public static readonly JsonSerializerOptions Options = Configure(new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static JsonSerializerOptions Configure(JsonSerializerOptions o)
    {
        o.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        if (!o.Converters.OfType<JsonStringEnumConverter>().Any())
            o.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return o;
    }
}

/// <summary>Every request carries the token handed out in the KOD_READY line (header, or ?token= for the WebSocket).</summary>
public sealed class TokenAuthMiddleware(RequestDelegate next, EngineOptions options)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        if (HttpMethods.IsOptions(ctx.Request.Method) || ctx.Request.Path == "/api/health")
        {
            await next(ctx);
            return;
        }
        var header = ctx.Request.Headers.Authorization.ToString();
        var token = header.StartsWith("Bearer ", StringComparison.Ordinal) ? header[7..] : ctx.Request.Query["token"].ToString();
        if (!CryptoEquals(token, options.Token))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        await next(ctx);
    }

    private static bool CryptoEquals(string a, string b) =>
        System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(a), System.Text.Encoding.UTF8.GetBytes(b));
}

/// <summary>Turns exceptions into { error } JSON with a sensible status code.</summary>
public sealed class ErrorMiddleware(RequestDelegate next, ILogger<ErrorMiddleware> log)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        try
        {
            await next(ctx);
        }
        catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested)
        {
            // client went away
        }
        catch (Exception ex)
        {
            var status = ex switch
            {
                FileNotFoundException or DirectoryNotFoundException => 404,
                ArgumentException or InvalidOperationException or BadHttpRequestException => 400,
                UnauthorizedAccessException => 403,
                IOException => 409,
                _ => 500,
            };
            if (status == 500) log.LogError(ex, "Request {Path} failed", ctx.Request.Path);
            if (ctx.Response.HasStarted) return;
            ctx.Response.StatusCode = status;
            await ctx.Response.WriteAsJsonAsync(new { error = ex.Message }, KodJson.Options);
        }
    }
}

/// <summary>Exits when the desktop shell that spawned us is gone (crash, kill), so no engine is left behind.</summary>
public sealed class ParentWatchdog(EngineOptions options, IHostApplicationLifetime lifetime, ILogger<ParentWatchdog> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (options.ParentPid is not { } pid) return;
        try
        {
            using var parent = Process.GetProcessById(pid);
            await parent.WaitForExitAsync(ct);
        }
        catch (ArgumentException)
        {
            // already gone
        }
        catch (OperationCanceledException)
        {
            return;
        }
        log.LogInformation("Parent process {Pid} exited; stopping", pid);
        lifetime.StopApplication();
    }
}

public static class PathUtil
{
    public static readonly StringComparer Comparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    public static readonly StringComparison Comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>Folders the explorer, search and watcher skip.</summary>
    public static readonly HashSet<string> IgnoredDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "bin", "obj", ".git", ".vs", ".idea", "node_modules", ".vscode", "packages", "TestResults", ".kod",
    };

    public static string Normalize(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("A path is required");
        var full = Path.GetFullPath(path);
        return full.Length > 3 ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : full;
    }

    public static bool Equal(string? a, string? b) => a is not null && b is not null && string.Equals(a, b, Comparison);

    public static bool IsUnder(string path, string dir) =>
        path.StartsWith(dir.EndsWith(Path.DirectorySeparatorChar) ? dir : dir + Path.DirectorySeparatorChar, Comparison);

    /// <summary>True when any segment of the path below <paramref name="root"/> is an ignored folder.</summary>
    public static bool IsIgnored(string path, string root)
    {
        var rel = Path.GetRelativePath(root, path);
        foreach (var seg in rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            if (IgnoredDirs.Contains(seg)) return true;
        return false;
    }
}
