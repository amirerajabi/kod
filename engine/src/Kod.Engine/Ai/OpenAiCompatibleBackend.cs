using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Kod.Engine.Ai;

/// <summary>
/// Any OpenAI-compatible chat completions API, streamed over server-sent events: OpenAI (ChatGPT), Zhipu GLM, Google
/// Gemini, DeepSeek, Mistral, xAI Grok, Alibaba Qwen, OpenRouter, Ollama and LM Studio, or your own endpoint.
/// </summary>
public sealed class OpenAiCompatibleBackend(IHttpClientFactory http) : IAiBackend
{
    private HttpClient Client(AiProviderConfig cfg, out Uri baseUri)
    {
        if (string.IsNullOrWhiteSpace(cfg.BaseUrl)) throw new AiException("This provider needs a base URL (Settings › AI)");
        baseUri = new Uri(cfg.BaseUrl.TrimEnd('/') + "/");
        var client = http.CreateClient("ai");
        var key = !string.IsNullOrWhiteSpace(cfg.ApiKey) ? cfg.ApiKey.Trim() : !string.IsNullOrWhiteSpace(cfg.KeyEnv) ? Environment.GetEnvironmentVariable(cfg.KeyEnv) : null;
        if (!string.IsNullOrEmpty(key)) client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return client;
    }

    public async Task<IReadOnlyList<string>> ListModelsAsync(AiProviderConfig cfg, CancellationToken ct)
    {
        var client = Client(cfg, out var baseUri);
        using var res = await client.GetAsync(new Uri(baseUri, "models"), ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw new AiException(ErrorText(res.StatusCode, body));
        var node = JsonNode.Parse(body);
        return (node?["data"] as JsonArray ?? node?["models"] as JsonArray ?? [])
            .Select(m => (string?)m?["id"] ?? (string?)m?["name"])
            .Where(id => !string.IsNullOrEmpty(id))
            .Select(id => id!.StartsWith("models/", StringComparison.Ordinal) ? id[7..] : id)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public async Task<AiTurnResult> StreamTurnAsync(AiProviderConfig cfg, string system, IReadOnlyList<AiMessage> history, IReadOnlyList<AiToolDef> tools,
        Action<string> onText, Action<string> onThinking, CancellationToken ct)
    {
        var client = Client(cfg, out var baseUri);
        var body = new JsonObject
        {
            ["model"] = cfg.Model,
            ["stream"] = true,
            ["messages"] = ToMessages(system, history),
        };
        if (tools.Count > 0)
        {
            body["tools"] = new JsonArray(tools.Select(t => (JsonNode)new JsonObject
            {
                ["type"] = "function",
                ["function"] = new JsonObject { ["name"] = t.Name, ["description"] = t.Description, ["parameters"] = JsonNode.Parse(t.Schema.GetRawText()) },
            }).ToArray());
        }
        // OpenAI's newer models take max_completion_tokens; compatible servers know max_tokens
        if (cfg.MaxTokens is { } max) body[IsOpenAi(baseUri) ? "max_completion_tokens" : "max_tokens"] = max;
        // usage in the last chunk (OpenAI and most compatible servers; others ignore it)
        if (IsOpenAi(baseUri)) body["stream_options"] = new JsonObject { ["include_usage"] = true };

        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri(baseUri, "chat/completions"))
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!res.IsSuccessStatusCode) throw new AiException(ErrorText(res.StatusCode, await res.Content.ReadAsStringAsync(ct)));

        var text = new StringBuilder();
        var calls = new SortedDictionary<int, (string Id, string Name, StringBuilder Args)>();
        var stop = "end_turn";
        AiUsage? usage = null;
        using var reader = new StreamReader(await res.Content.ReadAsStreamAsync(ct), Encoding.UTF8);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") break;
            JsonNode? chunk;
            try
            {
                chunk = JsonNode.Parse(data);
            }
            catch (JsonException)
            {
                continue;
            }
            if (chunk?["error"] is { } err) throw new AiException(err is JsonObject eo ? (string?)eo["message"] ?? eo.ToJsonString() : err.ToString());
            if (chunk?["usage"] is JsonObject u && u["prompt_tokens"] is not null)
                usage = new AiUsage((long?)u["prompt_tokens"] ?? 0, (long?)u["completion_tokens"] ?? 0, (long?)u["prompt_tokens_details"]?["cached_tokens"] ?? 0);
            if (chunk?["choices"] is not JsonArray choices || choices.Count == 0) continue;
            var choice = choices[0]!;
            var delta = choice["delta"];
            if (delta?["reasoning_content"] is JsonValue rc && rc.ToString() is { Length: > 0 } reasoning) onThinking(reasoning);
            if (delta?["content"] is JsonValue cv && cv.ToString() is { Length: > 0 } piece)
            {
                text.Append(piece);
                onText(piece);
            }
            if (delta?["tool_calls"] is JsonArray tcs)
            {
                foreach (var tc in tcs)
                {
                    var index = (int?)tc?["index"] ?? calls.Count;
                    if (!calls.TryGetValue(index, out var call)) call = calls[index] = ((string?)tc?["id"] ?? $"call_{Guid.NewGuid():N}", "", new StringBuilder());
                    if ((string?)tc?["function"]?["name"] is { Length: > 0 } name) calls[index] = call = (call.Id, call.Name + name, call.Args);
                    if ((string?)tc?["function"]?["arguments"] is { } args) call.Args.Append(args);
                }
            }
            if ((string?)choice["finish_reason"] is { } fr) stop = fr switch { "tool_calls" or "function_call" => "tool_use", "length" => "max_tokens", "content_filter" => "refusal", _ => "end_turn" };
        }

        var blocks = new List<AiBlock>();
        if (text.Length > 0) blocks.Add(new AiBlock { Kind = "text", Text = text.ToString() });
        foreach (var (_, c) in calls)
            blocks.Add(new AiBlock { Kind = "tool_use", Id = c.Id, Name = c.Name, InputJson = c.Args.Length == 0 ? "{}" : c.Args.ToString() });
        if (calls.Count > 0) stop = "tool_use";
        return new AiTurnResult(blocks, stop, usage);
    }

    private static bool IsOpenAi(Uri u) => u.Host.EndsWith("openai.com", StringComparison.OrdinalIgnoreCase);

    private static JsonArray ToMessages(string system, IReadOnlyList<AiMessage> history)
    {
        var list = new JsonArray { new JsonObject { ["role"] = "system", ["content"] = system } };
        foreach (var m in history)
        {
            if (m.Role == "assistant")
            {
                var text = string.Concat(m.Blocks.Where(b => b.Kind == "text").Select(b => b.Text));
                var calls = m.Blocks.Where(b => b.Kind == "tool_use").ToList();
                var msg = new JsonObject { ["role"] = "assistant", ["content"] = text.Length > 0 ? text : null };
                if (calls.Count > 0)
                {
                    msg["tool_calls"] = new JsonArray(calls.Select(c => (JsonNode)new JsonObject
                    {
                        ["id"] = c.Id,
                        ["type"] = "function",
                        ["function"] = new JsonObject { ["name"] = c.Name, ["arguments"] = string.IsNullOrWhiteSpace(c.InputJson) ? "{}" : c.InputJson },
                    }).ToArray());
                }
                list.Add(msg);
                continue;
            }
            // tool results first (they answer the previous assistant turn), then any user text
            foreach (var r in m.Blocks.Where(b => b.Kind == "tool_result"))
                list.Add(new JsonObject { ["role"] = "tool", ["tool_call_id"] = r.Id, ["content"] = r.Text ?? "" });
            var userText = string.Join("\n\n", m.Blocks.Where(b => b.Kind == "text").Select(b => b.Text));
            if (userText.Length > 0) list.Add(new JsonObject { ["role"] = "user", ["content"] = userText });
        }
        return list;
    }

    private static string ErrorText(System.Net.HttpStatusCode status, string body)
    {
        try
        {
            var node = JsonNode.Parse(body);
            var msg = (string?)node?["error"]?["message"] ?? (string?)node?["message"] ?? (string?)node?["error"];
            if (!string.IsNullOrWhiteSpace(msg)) return $"{(int)status}: {msg}";
        }
        catch (JsonException)
        {
        }
        catch (InvalidOperationException)
        {
        }
        return $"{(int)status} {status}: {(body.Length > 300 ? body[..300] : body)}";
    }
}
