using System.Net;
using System.Text.Json;
using Kod.Engine;
using Kod.Engine.Debugging;
using Kod.Engine.Endpoints;
using Kod.Engine.Infrastructure;
using Kod.Engine.Intel;
using Kod.Engine.Nuget;
using Kod.Engine.Processes;
using Kod.Engine.Workspace;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Json;

// Kod engine: ASP.NET Core minimal API on 127.0.0.1. stdout carries one line, "KOD_READY {port, token}", that the
// desktop shell waits for; logs go to stderr.

EngineOptions options;
try
{
    options = EngineOptions.Parse(args);
}
catch (Exception ex) when (ex is ArgumentException or FormatException or OverflowException)
{
    Console.Error.WriteLine($"Invalid arguments: {ex.Message}");
    return 2;
}

var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [], ContentRootPath = AppContext.BaseDirectory });
builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Logging.AddFilter("System.Net.Http", LogLevel.Warning);
builder.Logging.SetMinimumLevel(options.Dev ? LogLevel.Debug : LogLevel.Information);
// stdout belongs to the handshake: every log line goes to stderr
builder.Services.Configure<Microsoft.Extensions.Logging.Console.ConsoleLoggerOptions>(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
builder.WebHost.ConfigureKestrel(k =>
{
    k.Listen(IPAddress.Loopback, options.Port);
    k.Limits.MaxRequestBodySize = 64L * 1024 * 1024;
    k.AddServerHeader = false;
});

var services = builder.Services;
services.Configure<JsonOptions>(o => KodJson.Configure(o.SerializerOptions));
services.AddCors(c => c.AddDefaultPolicy(p => p
    .SetIsOriginAllowed(options.IsOriginAllowed)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .SetPreflightMaxAge(TimeSpan.FromHours(1))));
services.AddHttpClient("nuget", c =>
{
    c.Timeout = TimeSpan.FromSeconds(20);
    c.DefaultRequestHeaders.UserAgent.ParseAdd("Kod/0.3");
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AutomaticDecompression = System.Net.DecompressionMethods.All });
services.AddSingleton(options);
services.AddSingleton<EventHub>();
services.AddSingleton<WorkspaceService>();
services.AddSingleton<FileService>();
services.AddSingleton<MetadataViews>();
services.AddSingleton<IntelService>();
services.AddSingleton<CodeActionService>();
services.AddSingleton<ProcessService>();
services.AddSingleton<NugetService>();
services.AddSingleton<DebugAdapter>();
services.AddSingleton<DebugService>();
services.AddSingleton<Kod.Engine.Git.GitService>();
services.AddSingleton<Kod.Engine.Testing.TestService>();
services.AddHostedService<ParentWatchdog>();

var app = builder.Build();

app.UseMiddleware<ErrorMiddleware>();
app.UseCors();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
app.UseMiddleware<TokenAuthMiddleware>();

var hub = app.Services.GetRequiredService<EventHub>();
var workspace = app.Services.GetRequiredService<WorkspaceService>();
var processes = app.Services.GetRequiredService<ProcessService>();
hub.ClientConnected += () =>
{
    hub.Publish("workspace.state", workspace.GetState());
    return Task.CompletedTask;
};
app.Map("/ws", hub.HandleAsync);
app.MapGet("/api/health", () => Results.Ok(new { ok = true }));
app.MapGroup("/api").MapKod();

app.Lifetime.ApplicationStarted.Register(() =>
{
    var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()?.Addresses.FirstOrDefault();
    var port = address is not null && Uri.TryCreate(address, UriKind.Absolute, out var uri) ? uri.Port : options.Port;
    Console.Out.WriteLine($"KOD_READY {JsonSerializer.Serialize(new { port, token = options.Token })}");
    Console.Out.Flush();
    app.Logger.LogInformation("Kod engine ready on 127.0.0.1:{Port} (dev={Dev})", port, options.Dev);
});

// warm Roslyn up so the first completion is not the slow one
_ = Task.Run(() =>
{
    try
    {
        var doc = workspace.GetDocument(Path.Combine(Path.GetTempPath(), "kod-warmup.cs"), "class Warmup { void M() { System.Console.WriteLine(); } }");
        if (doc is not null) _ = Microsoft.CodeAnalysis.Completion.CompletionService.GetService(doc)?.GetCompletionsAsync(doc, 30).Result;
        workspace.CloseDocument(Path.Combine(Path.GetTempPath(), "kod-warmup.cs"));
    }
    catch
    {
        // warm-up is best effort
    }
});

app.Lifetime.ApplicationStopping.Register(() =>
{
    app.Services.GetRequiredService<DebugService>().Dispose();
    processes.Dispose();
    workspace.Dispose();
});

await app.RunAsync();
return 0;
