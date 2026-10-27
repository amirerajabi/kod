using Kod.Engine.Intel;

namespace Kod.Engine.Endpoints;

/// <summary>Generate (Alt+Insert) and the type / member refactorings of Refactor This.</summary>
public static class GenerateEndpoints
{
    public static RouteGroupBuilder MapGenerate(this RouteGroupBuilder api)
    {
        var intel = api.MapGroup("/intel");
        intel.MapPost("/generate/info", (DocRequest r, GenerateService s, CancellationToken ct) => s.InfoAsync(r, ct));
        intel.MapPost("/generate", (GenerateRequest r, GenerateService s, CancellationToken ct) => s.GenerateAsync(r, ct));

        intel.MapPost("/refactor/more", (DocRequest r, MemberRefactoringService s, CancellationToken ct) => s.AvailableAsync(r, ct));
        intel.MapPost("/refactor/moveType/info", (DocRequest r, MemberRefactoringService s, CancellationToken ct) => s.MoveTypeInfoAsync(r, ct));
        intel.MapPost("/refactor/moveType", (MoveTypeRequest r, MemberRefactoringService s, CancellationToken ct) => s.MoveTypeAsync(r, ct));
        intel.MapPost("/refactor/pullUp/info", (DocRequest r, MemberRefactoringService s, CancellationToken ct) => s.MoveMembersInfoAsync(r, up: true, ct));
        intel.MapPost("/refactor/pullUp", (PullUpRequest r, MemberRefactoringService s, CancellationToken ct) => s.PullUpAsync(r, ct));
        intel.MapPost("/refactor/pushDown/info", (DocRequest r, MemberRefactoringService s, CancellationToken ct) => s.MoveMembersInfoAsync(r, up: false, ct));
        intel.MapPost("/refactor/pushDown", (PushDownRequest r, MemberRefactoringService s, CancellationToken ct) => s.PushDownAsync(r, ct));
        intel.MapPost("/refactor/inline/info", (RangeRequest r, MemberRefactoringService s, CancellationToken ct) => s.InlineInfoAsync(r, ct));
        intel.MapPost("/refactor/inline/field", (InlineRequest r, MemberRefactoringService s, CancellationToken ct) => s.InlineFieldAsync(r, ct));
        intel.MapPost("/refactor/inline/calls", (InlineRequest r, MemberRefactoringService s, CancellationToken ct) => s.InlineCallsAsync(r, ct));
        intel.MapPost("/refactor/extractClass/info", (DocRequest r, MemberRefactoringService s, CancellationToken ct) => s.ExtractClassInfoAsync(r, ct));
        intel.MapPost("/refactor/extractClass", (ExtractClassRequest r, MemberRefactoringService s, CancellationToken ct) => s.ExtractClassAsync(r, ct));
        return api;
    }
}
