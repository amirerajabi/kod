using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Kod.Engine.Debugging;

public sealed record AdapterDto(bool Installed, string? Path, string? Version, bool Downloadable);

/// <summary>
/// Finds netcoredbg (Samsung's MIT-licensed .NET debugger, which speaks the Debug Adapter Protocol): KOD_NETCOREDBG,
/// Kod's own copy under the local app data folder, or PATH. Installs the latest release from GitHub on request.
/// </summary>
public sealed class DebugAdapter(IHttpClientFactory http, ILogger<DebugAdapter> log)
{
    private static readonly string Exe = OperatingSystem.IsWindows() ? "netcoredbg.exe" : "netcoredbg";

    public static string InstallDir => System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kod", "netcoredbg");

    private static string? AssetName()
    {
        var arm = RuntimeInformation.OSArchitecture == Architecture.Arm64;
        if (OperatingSystem.IsWindows()) return "netcoredbg-win64.zip";
        // Samsung ships macOS as a .zip and only for Apple silicon (3.x releases)
        if (OperatingSystem.IsMacOS()) return arm ? "netcoredbg-osx-arm64.zip" : null;
        if (OperatingSystem.IsLinux()) return arm ? "netcoredbg-linux-arm64.tar.gz" : "netcoredbg-linux-amd64.tar.gz";
        return null;
    }

    public string? Locate()
    {
        var env = Environment.GetEnvironmentVariable("KOD_NETCOREDBG");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
        var own = Directory.Exists(InstallDir) ? Directory.EnumerateFiles(InstallDir, Exe, SearchOption.AllDirectories).FirstOrDefault() : null;
        if (own is not null) return own;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var p = System.IO.Path.Combine(dir, Exe);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    public AdapterDto Describe()
    {
        var path = Locate();
        string? version = null;
        var marker = System.IO.Path.Combine(InstallDir, "version.txt");
        if (path is not null && File.Exists(marker) && path.StartsWith(InstallDir, StringComparison.OrdinalIgnoreCase)) version = File.ReadAllText(marker).Trim();
        return new AdapterDto(path is not null, path, version, AssetName() is not null);
    }

    /// <summary>Downloads the latest netcoredbg release for this OS into the local app data folder.</summary>
    public async Task<AdapterDto> InstallAsync(CancellationToken ct)
    {
        var asset = AssetName() ?? throw new InvalidOperationException("netcoredbg has no build for this operating system");
        var client = http.CreateClient("nuget");
        using var rel = JsonDocument.Parse(await client.GetStringAsync("https://api.github.com/repos/Samsung/netcoredbg/releases/latest", ct));
        var tag = rel.RootElement.GetProperty("tag_name").GetString() ?? "latest";
        var url = rel.RootElement.GetProperty("assets").EnumerateArray()
            .Where(a => a.GetProperty("name").GetString() == asset)
            .Select(a => a.GetProperty("browser_download_url").GetString())
            .FirstOrDefault() ?? throw new InvalidOperationException($"The {tag} release has no {asset}");
        // only ever GitHub's own release hosts
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || u.Scheme != "https" || !(u.Host == "github.com" || u.Host.EndsWith(".githubusercontent.com", StringComparison.Ordinal)))
            throw new InvalidOperationException("Unexpected download location");

        log.LogInformation("Downloading netcoredbg {Tag} ({Asset})", tag, asset);
        var tmp = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"kod-netcoredbg-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tmp);
        try
        {
            var archive = System.IO.Path.Combine(tmp, asset);
            await using (var s = await client.GetStreamAsync(url, ct))
            await using (var f = File.Create(archive))
                await s.CopyToAsync(f, ct);
            var outDir = System.IO.Path.Combine(tmp, "out");
            Directory.CreateDirectory(outDir);
            if (asset.EndsWith(".zip", StringComparison.Ordinal)) ZipFile.ExtractToDirectory(archive, outDir);
            else
            {
                await using var fs = File.OpenRead(archive);
                await using var gz = new GZipStream(fs, CompressionMode.Decompress);
                await TarFile.ExtractToDirectoryAsync(gz, outDir, overwriteFiles: true, ct);
            }
            if (Directory.Exists(InstallDir)) Directory.Delete(InstallDir, recursive: true);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(InstallDir)!);
            Directory.Move(outDir, InstallDir);
            File.WriteAllText(System.IO.Path.Combine(InstallDir, "version.txt"), tag);
            var exe = Locate();
            if (exe is not null && !OperatingSystem.IsWindows())
                File.SetUnixFileMode(exe, File.GetUnixFileMode(exe) | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute);
        }
        finally
        {
            try
            {
                Directory.Delete(tmp, recursive: true);
            }
            catch (IOException)
            {
            }
        }
        return Describe();
    }
}
