using Nebula.Api.Helpers;
using Nebula.Api.Models;
using Nebula.Api.Services;
using Nebula.Application.Common;

namespace Nebula.Api.Endpoints;

public static class SessionTelemetryEndpoints
{
    public static IEndpointRouteBuilder MapSessionTelemetryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/internal/telemetry")
            .WithTags("Session Telemetry")
            .RequireAuthorization()
            .RequireRateLimiting("authenticated");

        group.MapPost("/session-continuity", IngestAsync);

        return app;
    }

    internal static async Task<IResult> IngestAsync(
        SessionContinuityTelemetryRequest request,
        ICurrentUserService currentUser,
        SessionContinuityTelemetryService telemetry,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var validation = await telemetry.ValidateAsync(request, currentUser.UserId, ct);
        if (!validation.IsValid)
        {
            return validation.IsForbidden && !validation.HasNonForbiddenErrors
                ? ProblemDetailsHelper.AuthorizationForbidden(TraceId(httpContext))
                : ProblemDetailsHelper.TelemetryValidationError(validation.Errors);
        }

        telemetry.WriteAcceptedEvents(request, currentUser.UserId, TraceId(httpContext));
        return Results.Accepted();
    }

    private static string TraceId(HttpContext httpContext) =>
        System.Diagnostics.Activity.Current?.Id ?? httpContext.TraceIdentifier;
}
