using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;

namespace Kod.Engine.Ai;

/// <summary>
/// Claude through the official Anthropic SDK (beta Messages API, streamed): adaptive thinking with summarized
/// reasoning, effort, prompt caching, eager tool-input streaming and server-side refusal fallback.
/// </summary>
public sealed class AnthropicBackend : IAiBackend
{
    private const int MaxTokens = 64_000;

    private static IAnthropicClient Client(AiProviderConfig cfg)
    {
        var key = string.IsNullOrWhiteSpace(cfg.ApiKey) ? null : cfg.ApiKey.Trim();
        // no key: the SDK reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile; a saved key is
        // set explicitly, so the SDK skips the environment and sends only that key
        IAnthropicClient client = key is null ? new AnthropicClient() : new AnthropicClient { ApiKey = key };
        return string.IsNullOrWhiteSpace(cfg.BaseUrl) ? client : client.WithOptions(o => o with { BaseUrl = cfg.BaseUrl.TrimEnd('/') });
    }

    /// <summary>Claude 4.6 and later take adaptive thinking and effort; older models get neither.</summary>
    private static bool IsModern(string model) =>
        System.Text.RegularExpressions.Regex.IsMatch(model, @"claude-(fable|mythos|opus-5|sonnet-5|haiku-5|opus-4-[6-9]|sonnet-4-[6-9])");

    /// <summary>Models that take the server-side refusal fallback ("default" routing).</summary>
    private static bool TakesFallback(string model) =>
        System.Text.RegularExpressions.Regex.IsMatch(model, @"^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$");

    public async Task<IReadOnlyList<string>> ListModelsAsync(AiProviderConfig cfg, CancellationToken ct)
    {
        var page = await Client(cfg).Models.List(cancellationToken: ct);
        return page.Items.Select(m => m.ID).ToList();
    }

    public async Task<AiTurnResult> StreamTurnAsync(AiProviderConfig cfg, string system, IReadOnlyList<AiMessage> history, IReadOnlyList<AiToolDef> tools,
        Action<string> onText, Action<string> onThinking, CancellationToken ct)
    {
        var modern = IsModern(cfg.Model);
        var fallback = TakesFallback(cfg.Model);
        var p = new MessageCreateParams
        {
            Model = cfg.Model,
            MaxTokens = cfg.MaxTokens ?? MaxTokens,
            System = new List<BetaTextBlockParam> { new() { Text = system } },
            Messages = history.Select(ToParam).ToList(),
            // cache the tools, system prompt and the conversation so far
            CacheControl = new BetaCacheControlEphemeral(),
        };
        if (tools.Count > 0) p = p with { Tools = tools.Select(ToTool).ToList() };
        if (modern && !cfg.Fast)
        {
            p = p with
            {
                Thinking = new BetaThinkingConfigAdaptive { Display = Display.Summarized },
                OutputConfig = new BetaOutputConfig { Effort = cfg.Effort switch { "low" => Effort.Low, "medium" => Effort.Medium, "xhigh" => Effort.Xhigh, "max" => Effort.Max, _ => Effort.High } },
            };
        }
        if (fallback) p = p with { Betas = ["server-side-fallback-2026-07-01"], Fallbacks = new Default() };

        var blocks = new SortedDictionary<long, AiBlock>();
        var json = new Dictionary<long, StringBuilder>();
        string stop = "end_turn";
        long input = 0, output = 0, cacheRead = 0;
        string? notice = null;

        await foreach (var ev in Client(cfg).Beta.Messages.CreateStreaming(p, ct))
        {
            if (ev.TryPickStart(out var start))
            {
                input = start.Message.Usage.InputTokens;
                cacheRead = start.Message.Usage.CacheReadInputTokens ?? 0;
            }
            else if (ev.TryPickContentBlockStart(out var cbs))
            {
                var cb = cbs.ContentBlock;
                if (cb.TryPickBetaText(out var t)) blocks[cbs.Index] = new AiBlock { Kind = "text", Text = t.Text };
                else if (cb.TryPickBetaThinking(out var th)) blocks[cbs.Index] = new AiBlock { Kind = "thinking", Text = th.Thinking, Signature = th.Signature };
                else if (cb.TryPickBetaRedactedThinking(out var rt)) blocks[cbs.Index] = new AiBlock { Kind = "redacted_thinking", Signature = rt.Data };
                else if (cb.TryPickBetaToolUse(out var tu))
                {
                    blocks[cbs.Index] = new AiBlock { Kind = "tool_use", Id = tu.ID, Name = tu.Name, InputJson = "" };
                    json[cbs.Index] = new StringBuilder();
                }
                else if (cb.TryPickBetaFallback(out var fb))
                {
                    // a refusal switched models mid-turn: what came before the boundary is not echoed back, except text
                    foreach (var k in blocks.Where(b => b.Value.Kind != "text").Select(b => b.Key).ToList()) blocks.Remove(k);
                    notice = $"{fb.From.Model} declined; {fb.To.Model} continued";
                }
            }
            else if (ev.TryPickContentBlockDelta(out var d))
            {
                if (!blocks.TryGetValue(d.Index, out var b)) continue;
                if (d.Delta.TryPickText(out var td))
                {
                    b.Text += td.Text;
                    onText(td.Text);
                }
                else if (d.Delta.TryPickThinking(out var thd))
                {
                    b.Text += thd.Thinking;
                    onThinking(thd.Thinking);
                }
                else if (d.Delta.TryPickSignature(out var sd)) b.Signature = sd.Signature;
                else if (d.Delta.TryPickInputJson(out var ij) && json.TryGetValue(d.Index, out var sb)) sb.Append(ij.PartialJson);
            }
            else if (ev.TryPickDelta(out var md))
            {
                if (md.Delta.StopReason is { } sr) stop = sr.Raw();
                output = md.Usage.OutputTokens;
            }
        }

        foreach (var (i, sb) in json)
            if (blocks.TryGetValue(i, out var b)) b.InputJson = sb.Length == 0 ? "{}" : sb.ToString();
        return new AiTurnResult(blocks.Values.ToList(), stop, new AiUsage(input, output, cacheRead), notice);
    }

    private static BetaMessageParam ToParam(AiMessage m)
    {
        var content = new List<BetaContentBlockParam>();
        foreach (var b in m.Blocks)
        {
            switch (b.Kind)
            {
                case "text" when !string.IsNullOrEmpty(b.Text):
                    content.Add(new BetaTextBlockParam { Text = b.Text });
                    break;
                case "thinking":
                    content.Add(new BetaThinkingBlockParam { Thinking = b.Text ?? "", Signature = b.Signature ?? "" });
                    break;
                case "redacted_thinking":
                    content.Add(new BetaRedactedThinkingBlockParam { Data = b.Signature ?? "" });
                    break;
                case "tool_use":
                    content.Add(new BetaToolUseBlockParam { ID = b.Id!, Name = b.Name!, Input = ParseInput(b.InputJson) });
                    break;
                case "tool_result":
                    content.Add(new BetaToolResultBlockParam { ToolUseID = b.Id!, Content = b.Text ?? "", IsError = b.IsError });
                    break;
            }
        }
        if (content.Count == 0) content.Add(new BetaTextBlockParam { Text = "(empty)" });
        return m.Role == "assistant" ? new BetaAssistantMessageParam { Content = content } : new BetaUserMessageParam { Content = content };
    }

    private static Dictionary<string, JsonElement> ParseInput(string? json)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return [];
            return doc.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone());
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static BetaToolUnion ToTool(AiToolDef t)
    {
        var props = t.Schema.TryGetProperty("properties", out var pr) ? pr.EnumerateObject().ToDictionary(x => x.Name, x => x.Value.Clone()) : [];
        var required = t.Schema.TryGetProperty("required", out var rq) ? rq.EnumerateArray().Select(x => x.GetString()!).ToList() : [];
        return new BetaTool
        {
            Name = t.Name,
            Description = t.Description,
            InputSchema = new() { Properties = props, Required = required },
            // large inputs (file contents) stream as they are written; AiService validates them before running
            EagerInputStreaming = true,
        };
    }
}
