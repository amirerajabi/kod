using System.Diagnostics;
using System.Net;
using System.Text;
using Kod.Engine.Infrastructure;
using Kod.Engine.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Kod.Engine.Http;

public sealed record HttpHeaderDto(string Name, string Value);

public sealed record HttpSendRequest(string Method, string Url, IReadOnlyList<HttpHeaderDto>? Headers, string? Body, int TimeoutMs = 100_000);

public sealed record HttpResponseDto(
    int Status, string Reason, string Version, IReadOnlyList<HttpHeaderDto> Headers, string Body, bool Binary, bool Truncated,
    long Size, double Ms, string? ContentType, string FinalUrl);

public sealed record HttpEndpointDto(string Method, string Route, string? Path, int Line);

public sealed record HttpEndpointsDto(string? BaseUrl, IReadOnlyList<HttpEndpointDto> Endpoints);

/// <summary>
/// The HTTP Client of .http files (Rider's and Visual Studio's format): sends a request from the engine (the window
/// cannot: its CSP only reaches the engine), so it can call any server, including localhost with a dev certificate.
/// Also finds a project's endpoints (minimal APIs and controllers) to generate a .http file from.
/// </summary>
public sealed class HttpRequestService(WorkspaceService workspace)
{
    private const int MaxBody = 4 * 1024 * 1024;

    private static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = true,
        AutomaticDecompression = DecompressionMethods.All,
        UseCookies = false,
        // dev certificates (https://localhost:7xxx) are self-signed: trusted for loopback only
        SslOptions = { RemoteCertificateValidationCallback = (sender, _, _, errors) => errors == System.Net.Security.SslPolicyErrors.None || IsLoopback(sender) },
    })
    { Timeout = Timeout.InfiniteTimeSpan };

    private static bool IsLoopback(object sender) =>
        sender is System.Net.Security.SslStream { TargetHostName: var host } && (host is "localhost" or "127.0.0.1" or "::1" or "[::1]" || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase));

    private static readonly HashSet<string> ContentHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Content-Type", "Content-Length", "Content-Encoding", "Content-Language", "Content-Disposition", "Content-MD5", "Content-Range", "Expires", "Last-Modified", "Allow",
    };

    public async Task<HttpResponseDto> SendAsync(HttpSendRequest r, CancellationToken ct)
    {
        if (!Uri.TryCreate(r.Url.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw new ArgumentException($"Not an http(s) URL: {r.Url}");
        using var req = new HttpRequestMessage(new HttpMethod(r.Method.ToUpperInvariant()), uri);
        if (r.Body is { Length: > 0 }) req.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(r.Body));
        foreach (var h in r.Headers ?? [])
        {
            if (ContentHeaders.Contains(h.Name))
            {
                req.Content ??= new ByteArrayContent([]);
                if (h.Name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                req.Content.Headers.Remove(h.Name);
                req.Content.Headers.TryAddWithoutValidation(h.Name, h.Value);
            }
            else req.Headers.TryAddWithoutValidation(h.Name, h.Value);
        }
        if (!req.Headers.UserAgent.Any()) req.Headers.TryAddWithoutValidation("User-Agent", "Kod HTTP Client");

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(Math.Clamp(r.TimeoutMs, 1000, 600_000));
        var sw = Stopwatch.StartNew();
        HttpResponseMessage res;
        try
        {
            res = await Client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new InvalidOperationException($"No answer within {r.TimeoutMs / 1000} s");
        }
        catch (HttpRequestException ex)
        {
            throw new InvalidOperationException(ex.InnerException?.Message is { } inner ? $"{ex.Message} ({inner})" : ex.Message);
        }
        using (res)
        {
            await using var stream = await res.Content.ReadAsStreamAsync(cts.Token);
            using var ms = new MemoryStream();
            var buf = new byte[81920];
            long total = 0;
            int n;
            while ((n = await stream.ReadAsync(buf, cts.Token)) > 0)
            {
                total += n;
                if (ms.Length < MaxBody) ms.Write(buf, 0, (int)Math.Min(n, MaxBody - ms.Length));
            }
            sw.Stop();
            var bytes = ms.ToArray();
            var type = res.Content.Headers.ContentType?.MediaType;
            var binary = IsBinary(type, bytes);
            var encoding = Encoding.UTF8;
            try
            {
                if (res.Content.Headers.ContentType?.CharSet is { Length: > 0 } cs) encoding = Encoding.GetEncoding(cs.Trim('"'));
            }
            catch (ArgumentException)
            {
            }
            var headers = res.Headers.Concat(res.Content.Headers).SelectMany(h => h.Value.Select(v => new HttpHeaderDto(h.Key, v))).ToList();
            return new HttpResponseDto(
                (int)res.StatusCode, res.ReasonPhrase ?? res.StatusCode.ToString(), $"HTTP/{res.Version}", headers,
                binary ? Convert.ToBase64String(bytes) : encoding.GetString(bytes), binary, total > MaxBody, total, sw.Elapsed.TotalMilliseconds, type,
                res.RequestMessage?.RequestUri?.ToString() ?? uri.ToString());
        }
    }

    private static bool IsBinary(string? type, byte[] bytes)
    {
        if (type is not null && (type.StartsWith("text/", StringComparison.OrdinalIgnoreCase) || type.Contains("json", StringComparison.OrdinalIgnoreCase)
                                 || type.Contains("xml", StringComparison.OrdinalIgnoreCase) || type.Contains("javascript", StringComparison.OrdinalIgnoreCase)
                                 || type.Contains("x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase) || type.Contains("problem", StringComparison.OrdinalIgnoreCase)))
            return false;
        if (type is not null && (type.StartsWith("image/", StringComparison.OrdinalIgnoreCase) || type.StartsWith("audio/", StringComparison.OrdinalIgnoreCase)
                                 || type.StartsWith("video/", StringComparison.OrdinalIgnoreCase) || type.Contains("octet-stream", StringComparison.OrdinalIgnoreCase)
                                 || type.Contains("pdf", StringComparison.OrdinalIgnoreCase) || type.Contains("zip", StringComparison.OrdinalIgnoreCase)))
            return true;
        // unknown: a NUL byte in the first KB means binary
        return bytes.AsSpan(0, Math.Min(bytes.Length, 1024)).IndexOf((byte)0) >= 0;
    }

    // ------------------------------------------------------------------ endpoints of a project

    private static readonly Dictionary<string, string> MapMethods = new(StringComparer.Ordinal)
    {
        ["MapGet"] = "GET", ["MapPost"] = "POST", ["MapPut"] = "PUT", ["MapDelete"] = "DELETE", ["MapPatch"] = "PATCH",
    };

    private static readonly Dictionary<string, string> VerbAttributes = new(StringComparer.Ordinal)
    {
        ["HttpGet"] = "GET", ["HttpPost"] = "POST", ["HttpPut"] = "PUT", ["HttpDelete"] = "DELETE", ["HttpPatch"] = "PATCH", ["HttpHead"] = "HEAD", ["HttpOptions"] = "OPTIONS",
    };

    /// <summary>
    /// The project's endpoints, read from the syntax: Map{Get,Post,…}("route") (with MapGroup prefixes when the group
    /// is a local variable) and controller actions ([Route] on the class, [Http*("template")] on the action).
    /// The base URL is the first http(s) URL of the launch profile.
    /// </summary>
    public async Task<HttpEndpointsDto> EndpointsAsync(string projectPath, CancellationToken ct)
    {
        projectPath = PathUtil.Normalize(projectPath);
        var project = workspace.CurrentSolution.Projects.FirstOrDefault(p => PathUtil.Equal(p.FilePath, projectPath))
                      ?? throw new InvalidOperationException("The project is not loaded");
        var list = new List<HttpEndpointDto>();
        foreach (var doc in project.Documents)
        {
            if (doc.FilePath is null || doc.FilePath.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")) continue;
            if (await doc.GetSyntaxRootAsync(ct) is not { } root) continue;
            var groups = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var node in root.DescendantNodes())
            {
                // var api = app.MapGroup("/api");
                if (node is VariableDeclaratorSyntax { Initializer.Value: InvocationExpressionSyntax gi } v && Name(gi) == "MapGroup" && Route(gi) is { } prefix)
                    groups[v.Identifier.ValueText] = (gi.Expression is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax parent } && groups.TryGetValue(parent.Identifier.ValueText, out var pp) ? Join(pp, prefix) : prefix);
                else if (node is InvocationExpressionSyntax inv && Name(inv) is { } name && MapMethods.TryGetValue(name, out var method) && Route(inv) is { } route)
                {
                    var target = (inv.Expression as MemberAccessExpressionSyntax)?.Expression;
                    var full = target is IdentifierNameSyntax id && groups.TryGetValue(id.Identifier.ValueText, out var g) ? Join(g, route)
                        : target is InvocationExpressionSyntax gc && Name(gc) == "MapGroup" && Route(gc) is { } gp ? Join(gp, route) : route;
                    list.Add(new HttpEndpointDto(method, Normalize(full), doc.FilePath, Line(inv)));
                }
                else if (node is ClassDeclarationSyntax cls && (cls.Identifier.ValueText.EndsWith("Controller", StringComparison.Ordinal) || Attr(cls.AttributeLists, "ApiController") is not null))
                {
                    var classRoute = Attr(cls.AttributeLists, "Route") is { } ra ? Arg(ra) ?? "" : "";
                    var controller = cls.Identifier.ValueText.EndsWith("Controller", StringComparison.Ordinal) ? cls.Identifier.ValueText[..^10] : cls.Identifier.ValueText;
                    foreach (var m in cls.Members.OfType<MethodDeclarationSyntax>().Where(m => m.Modifiers.Any(SyntaxKind.PublicKeyword)))
                    {
                        foreach (var a in m.AttributeLists.SelectMany(l => l.Attributes))
                        {
                            if (!VerbAttributes.TryGetValue(AttrName(a), out var verb)) continue;
                            var template = Arg(a) ?? (Attr(m.AttributeLists, "Route") is { } mr ? Arg(mr) : null) ?? "";
                            var path = template.StartsWith('/') || template.StartsWith('~') ? template.TrimStart('~') : Join(classRoute, template);
                            path = path.Replace("[controller]", controller, StringComparison.OrdinalIgnoreCase).Replace("[action]", m.Identifier.ValueText, StringComparison.OrdinalIgnoreCase);
                            list.Add(new HttpEndpointDto(verb, Normalize(path), doc.FilePath, Line(m)));
                        }
                    }
                }
            }
        }
        return new HttpEndpointsDto(BaseUrl(projectPath), list.DistinctBy(e => (e.Method, e.Route)).OrderBy(e => e.Route, StringComparer.OrdinalIgnoreCase).ThenBy(e => e.Method).ToList());
    }

    private static string? Name(InvocationExpressionSyntax inv) => inv.Expression switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText,
        IdentifierNameSyntax i => i.Identifier.ValueText,
        _ => null,
    };

    private static string? Route(InvocationExpressionSyntax inv) =>
        inv.ArgumentList.Arguments.FirstOrDefault()?.Expression is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.StringLiteralExpression } lit ? lit.Token.ValueText : null;

    private static AttributeSyntax? Attr(SyntaxList<AttributeListSyntax> lists, string name) =>
        lists.SelectMany(l => l.Attributes).FirstOrDefault(a => AttrName(a) == name);

    private static string AttrName(AttributeSyntax a)
    {
        var n = a.Name switch { QualifiedNameSyntax q => q.Right.Identifier.ValueText, SimpleNameSyntax s => s.Identifier.ValueText, _ => a.Name.ToString() };
        return n.EndsWith("Attribute", StringComparison.Ordinal) ? n[..^9] : n;
    }

    private static string? Arg(AttributeSyntax a) =>
        a.ArgumentList?.Arguments.FirstOrDefault(x => x.NameEquals is null)?.Expression is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.StringLiteralExpression } lit ? lit.Token.ValueText : null;

    private static string Join(string a, string b) => a.TrimEnd('/') + "/" + b.TrimStart('/');

    /// <summary>"/api/items/{id:int}" → "/api/items/{id}" (constraints and defaults out; the user fills the value).</summary>
    private static string Normalize(string route)
    {
        var r = System.Text.RegularExpressions.Regex.Replace(route, @"\{(\*{0,2})(\w+)[^}]*\}", "{$2}");
        return "/" + r.Trim('/');
    }

    private static int Line(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    private static string? BaseUrl(string projectPath)
    {
        var settings = Path.Combine(Path.GetDirectoryName(projectPath)!, "Properties", "launchSettings.json");
        try
        {
            if (!File.Exists(settings)) return null;
            var json = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(settings), documentOptions: new System.Text.Json.JsonDocumentOptions { CommentHandling = System.Text.Json.JsonCommentHandling.Skip, AllowTrailingCommas = true });
            if (json?["profiles"] is not System.Text.Json.Nodes.JsonObject profiles) return null;
            foreach (var (_, p) in profiles)
            {
                if ((string?)p?["commandName"] != "Project" || (string?)p?["applicationUrl"] is not { } urls) continue;
                var all = urls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                // http first: no certificate questions
                return all.FirstOrDefault(u => u.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) ?? all.FirstOrDefault();
            }
        }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException)
        {
        }
        return null;
    }
}
