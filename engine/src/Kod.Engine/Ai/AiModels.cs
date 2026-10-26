using System.Text.Json;

namespace Kod.Engine.Ai;

/// <summary>
/// Which AI to talk to. Kind "anthropic" goes through the Anthropic SDK; "openai" is any OpenAI-compatible chat
/// completions API (OpenAI, GLM / Zhipu, Gemini, DeepSeek, Mistral, Grok, Qwen, OpenRouter, Ollama, …).
/// An empty ApiKey falls back to the provider's environment variable.
/// </summary>
public sealed record AiProviderConfig(string Kind, string Model, string? BaseUrl = null, string? ApiKey = null, string? Effort = null, string? KeyEnv = null);

/// <summary>What the editor shows right now, sent with every message.</summary>
public sealed record AiContext(string? ActiveFile = null, string? Selection = null, int? SelectionStartLine = null, IReadOnlyList<string>? OpenFiles = null);

/// <summary>"agent": tools, edits and commands need approval; "auto": everything runs; "chat": no tools.</summary>
public sealed record AiChatRequest(string SessionId, AiProviderConfig Provider, string Message, AiContext? Context = null, string Mode = "agent");

public sealed record AiApproveRequest(string CallId, bool Allow, bool Always = false);

public sealed record AiModelsRequest(AiProviderConfig Provider);

/// <summary>One block of a provider-neutral conversation. Thinking blocks are kept (with their signature) so Claude gets them back unchanged.</summary>
public sealed class AiBlock
{
    public required string Kind { get; init; } // text | thinking | redacted_thinking | tool_use | tool_result
    public string? Text { get; set; }
    public string? Signature { get; set; }
    public string? Id { get; init; }
    public string? Name { get; init; }
    public string? InputJson { get; set; }
    public bool IsError { get; init; }
}

public sealed class AiMessage
{
    public required string Role { get; init; } // user | assistant
    public List<AiBlock> Blocks { get; init; } = [];
}

public sealed record AiToolDef(string Name, string Description, JsonElement Schema, bool Mutates);

public sealed record AiUsage(long InputTokens, long OutputTokens, long CacheReadTokens = 0);

public sealed record AiTurnResult(List<AiBlock> Blocks, string StopReason, AiUsage? Usage, string? Notice = null);

/// <summary>Streams one model turn (no tool execution).</summary>
public interface IAiBackend
{
    Task<AiTurnResult> StreamTurnAsync(AiProviderConfig cfg, string system, IReadOnlyList<AiMessage> history, IReadOnlyList<AiToolDef> tools,
        Action<string> onText, Action<string> onThinking, CancellationToken ct);

    Task<IReadOnlyList<string>> ListModelsAsync(AiProviderConfig cfg, CancellationToken ct);
}

public sealed class AiException(string message) : Exception(message);
