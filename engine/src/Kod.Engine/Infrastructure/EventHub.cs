using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Kod.Engine.Infrastructure;

/// <summary>
/// One-way event stream to the UI over /ws: every message is a JSON object with a "type" field
/// (workspace.state, fs.changed, proc.started, proc.output, proc.exit, ...).
/// </summary>
public sealed class EventHub(ILogger<EventHub> log)
{
    private sealed class Client(WebSocket socket)
    {
        public WebSocket Socket { get; } = socket;
        public SemaphoreSlim SendLock { get; } = new(1, 1);
    }

    private readonly ConcurrentDictionary<Guid, Client> clients = new();

    /// <summary>Called for every new client so it can catch up (current workspace state, running processes).</summary>
    public event Func<Task>? ClientConnected;

    public async Task HandleAsync(HttpContext ctx)
    {
        if (!ctx.WebSockets.IsWebSocketRequest)
        {
            ctx.Response.StatusCode = 400;
            return;
        }
        using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
        var id = Guid.NewGuid();
        clients[id] = new Client(socket);
        try
        {
            if (ClientConnected is { } connected) await connected();
            var buffer = new byte[4096];
            while (socket.State == WebSocketState.Open)
            {
                var r = await socket.ReceiveAsync(buffer, ctx.RequestAborted);
                if (r.MessageType == WebSocketMessageType.Close) break;
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            // client went away
        }
        finally
        {
            clients.TryRemove(id, out _);
            if (socket.State == WebSocketState.Open)
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None).ConfigureAwait(false);
        }
    }

    public void Publish(string type, object payload)
    {
        var node = JsonSerializer.SerializeToNode(payload, KodJson.Options)!.AsObject();
        node["type"] = type;
        var bytes = Encoding.UTF8.GetBytes(node.ToJsonString());
        foreach (var (id, c) in clients) _ = SendAsync(id, c, bytes);
    }

    private async Task SendAsync(Guid id, Client c, byte[] bytes)
    {
        await c.SendLock.WaitAsync();
        try
        {
            if (c.Socket.State == WebSocketState.Open)
                await c.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (Exception ex)
        {
            log.LogDebug(ex, "Dropping WebSocket client");
            clients.TryRemove(id, out _);
        }
        finally
        {
            c.SendLock.Release();
        }
    }
}
