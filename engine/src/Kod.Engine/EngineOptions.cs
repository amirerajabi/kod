using System.Security.Cryptography;

namespace Kod.Engine;

/// <summary>Command line: --port N (0 = any free port), --token T, --parent-pid PID, --dev.</summary>
public sealed record EngineOptions(int Port, string Token, int? ParentPid, bool Dev)
{
    public static EngineOptions Parse(string[] args)
    {
        var port = 0;
        string? token = null;
        int? parent = null;
        var dev = false;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--port": port = int.Parse(Next(args, ref i)); break;
                case "--token": token = Next(args, ref i); break;
                case "--parent-pid": parent = int.Parse(Next(args, ref i)); break;
                case "--dev": dev = true; break;
                default: throw new ArgumentException($"Unknown argument '{args[i]}'");
            }
        }
        if (port is < 0 or > 65535) throw new ArgumentException("--port must be 0..65535");
        token ??= Environment.GetEnvironmentVariable("KOD_ENGINE_TOKEN") ?? Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
        return new EngineOptions(port, token, parent, dev);
    }

    private static string Next(string[] args, ref int i) =>
        ++i < args.Length ? args[i] : throw new ArgumentException($"{args[i - 1]} needs a value");

    /// <summary>The packaged UI lives on kod://app; with --dev the Vite server (any loopback origin) may call too.</summary>
    public bool IsOriginAllowed(string origin)
    {
        if (origin == "kod://app") return true;
        if (!Dev || !Uri.TryCreate(origin, UriKind.Absolute, out var u)) return false;
        return u.Host is "localhost" or "127.0.0.1" or "[::1]";
    }
}
