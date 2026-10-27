using Kod.Engine.Workspace;

namespace Kod.Engine.Endpoints;

/// <summary>Project Properties and solution membership (ProjectFileService).</summary>
public static class ProjectEndpoints
{
    public static RouteGroupBuilder MapProjectFiles(this RouteGroupBuilder api)
    {
        var project = api.MapGroup("/project");
        project.MapGet("/properties", (string path, ProjectFileService s) => s.Read(path));
        project.MapPost("/properties", (SavePropertiesRequest r, ProjectFileService s) => s.Save(r));
        project.MapPost("/references/add", (ProjectReferenceRequest r, ProjectFileService s) => s.AddProjectReference(r));
        project.MapPost("/references/remove", (ProjectReferenceRequest r, ProjectFileService s) => s.RemoveProjectReference(r));
        project.MapPost("/packages/remove", (PackageRemoveRequest r, ProjectFileService s) => s.RemovePackage(r));
        api.MapPost("/solution/add", async (SolutionProjectRequest r, ProjectFileService s, CancellationToken ct) => { await s.SolutionAsync(r, add: true, ct); return Results.NoContent(); });
        api.MapPost("/solution/remove", async (SolutionProjectRequest r, ProjectFileService s, CancellationToken ct) => { await s.SolutionAsync(r, add: false, ct); return Results.NoContent(); });
        return api;
    }
}
