using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Nebula.Api.Helpers;

namespace Nebula.Tests.Integration;

public class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public enum AuthMode
    {
        Success,
        NoResult,
        Expired,
        Invalid,
        Revoked,
    }

    public static AuthMode Mode { get; set; } = AuthMode.Success;
    public static string TestSubject { get; set; } = "test-user-001";
    public static string TestRole { get; set; } = "Admin";
    public static string TestDisplayName { get; set; } = "Test User";
    /// <summary>
    /// Optional extra nebula_roles claims (F0009). Null = emit only TestRole as nebula_roles.
    /// </summary>
    public static string[]? TestNebulaRoles { get; set; }
    /// <summary>
    /// Optional broker_tenant_id claim (F0009 BrokerUser scope). Null = not emitted.
    /// </summary>
    public static string? TestBrokerTenantId { get; set; }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (Mode == AuthMode.NoResult)
            return Task.FromResult(AuthenticateResult.NoResult());
        if (Mode == AuthMode.Expired)
            return Task.FromResult(AuthenticateResult.Fail(new SecurityTokenExpiredException("test token expired")));
        if (Mode == AuthMode.Invalid)
            return Task.FromResult(AuthenticateResult.Fail("test invalid token"));
        if (Mode == AuthMode.Revoked)
            return Task.FromResult(AuthenticateResult.Fail("test session revoked"));

        var claims = new List<Claim>
        {
            new("iss", "http://test.local/application/o/nebula/"),
            new("sub", TestSubject),
            new(ClaimTypes.NameIdentifier, TestSubject),
            new("name", TestDisplayName),
            new(ClaimTypes.Name, TestDisplayName),
            new("role", TestRole),
            new(ClaimTypes.Role, TestRole),
            new("regions", "West"),
        };

        // nebula_roles: used by HttpCurrentUserService.Roles and Casbin policy checks.
        var nebulaRoles = TestNebulaRoles ?? [TestRole];
        foreach (var r in nebulaRoles)
            claims.Add(new Claim("nebula_roles", r));

        if (TestBrokerTenantId is not null)
            claims.Add(new Claim("broker_tenant_id", TestBrokerTenantId));

        var identity = new ClaimsIdentity(claims, "Test");
        var principal = new ClaimsPrincipal(identity);
        var ticket = new AuthenticationTicket(principal, "Test");

        return Task.FromResult(AuthenticateResult.Success(ticket));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        Response.ContentType = "application/problem+json";
        Response.Headers.WWWAuthenticate = Mode switch
        {
            AuthMode.Expired =>
                "Bearer error=\"invalid_token\", error_description=\"The access token expired.\"",
            AuthMode.Revoked =>
                "Bearer error=\"invalid_token\", error_description=\"session-revoked\"",
            _ =>
                "Bearer error=\"invalid_token\", error_description=\"Authentication token is invalid.\"",
        };
        var traceId = System.Diagnostics.Activity.Current?.Id ?? Context.TraceIdentifier;
        var result = Mode switch
        {
            AuthMode.Expired => ProblemDetailsHelper.AuthTokenExpired(traceId),
            AuthMode.Revoked => ProblemDetailsHelper.AuthSessionRevoked(traceId),
            _ => ProblemDetailsHelper.AuthInvalidToken(traceId),
        };
        return result.ExecuteAsync(Context);
    }

    protected override Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        Response.Headers.Remove("WWW-Authenticate");
        Response.StatusCode = StatusCodes.Status403Forbidden;
        Response.ContentType = "application/problem+json";
        return ProblemDetailsHelper.AuthorizationForbidden(
            System.Diagnostics.Activity.Current?.Id ?? Context.TraceIdentifier)
            .ExecuteAsync(Context);
    }

    /// <summary>Resets all optional F0009 properties to default (call in test teardown).</summary>
    public static void ResetF0009Overrides()
    {
        Mode = AuthMode.Success;
        TestNebulaRoles = null;
        TestBrokerTenantId = null;
    }
}
