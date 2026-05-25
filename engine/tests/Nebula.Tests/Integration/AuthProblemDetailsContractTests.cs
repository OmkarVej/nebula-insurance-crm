using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Nebula.Domain.Entities;
using Nebula.Infrastructure.Persistence;
using Shouldly;

namespace Nebula.Tests.Integration;

[Collection(IntegrationTestCollection.Name)]
public class AuthProblemDetailsContractTests(CustomWebApplicationFactory factory)
    : IClassFixture<CustomWebApplicationFactory>, IDisposable
{
    private readonly HttpClient _client = factory.CreateClient();

    public void Dispose()
    {
        TestAuthHandler.TestSubject = "test-user-001";
        TestAuthHandler.TestRole = "Admin";
        TestAuthHandler.TestDisplayName = "Test User";
        TestAuthHandler.ResetF0009Overrides();
    }

    [Theory]
    [InlineData(TestAuthHandler.AuthMode.Expired, "https://nebula.local/problems/auth/token-expired", "token_expired", "expired")]
    [InlineData(TestAuthHandler.AuthMode.Invalid, "https://nebula.local/problems/auth/invalid-token", "invalid_token", "invalid")]
    [InlineData(TestAuthHandler.AuthMode.Revoked, "https://nebula.local/problems/auth/session-revoked", "session_revoked", "session-revoked")]
    public async Task ProtectedEndpoint_AuthChallenge_ReturnsAdr024ProblemDetails(
        TestAuthHandler.AuthMode mode,
        string expectedType,
        string expectedCode,
        string expectedAuthenticateDescription)
    {
        TestAuthHandler.Mode = mode;

        var response = await _client.PostAsJsonAsync(
            "/internal/telemetry/session-continuity",
            RequestBody(Guid.NewGuid()));

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        response.Headers.WwwAuthenticate.ShouldContain(header => header.Scheme == "Bearer");
        response.Headers.WwwAuthenticate.ToString().ShouldContain(expectedAuthenticateDescription);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("type").GetString().ShouldBe(expectedType);
        problem.GetProperty("code").GetString().ShouldBe(expectedCode);
        problem.GetProperty("traceId").GetString().ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task ProtectedEndpoint_Forbidden_ReturnsAdr024ProblemDetailsWithoutAuthenticateHeader()
    {
        await ArrangeCurrentUserAsync();

        var response = await _client.PostAsJsonAsync(
            "/internal/telemetry/session-continuity",
            RequestBody(Guid.NewGuid()));

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        response.Headers.WwwAuthenticate.ShouldBeEmpty();
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("type").GetString().ShouldBe("https://nebula.local/problems/authz/forbidden");
        problem.GetProperty("code").GetString().ShouldBe("forbidden");
        problem.GetProperty("traceId").GetString().ShouldNotBeNullOrWhiteSpace();
    }

    private async Task<Guid> ArrangeCurrentUserAsync()
    {
        var subject = $"auth-problem-{Guid.NewGuid():N}";
        var userId = Guid.NewGuid();
        TestAuthHandler.TestSubject = subject;
        TestAuthHandler.TestRole = "Admin";
        TestAuthHandler.TestNebulaRoles = ["Admin"];

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = DateTime.UtcNow;
        db.UserProfiles.Add(new UserProfile
        {
            Id = userId,
            IdpIssuer = "http://test.local/application/o/nebula/",
            IdpSubject = subject,
            Email = $"{subject}@example.test",
            DisplayName = "Auth Problem Test User",
            Department = "",
            RolesJson = "[\"Admin\"]",
            CreatedAt = now,
            UpdatedAt = now,
        });
        await db.SaveChangesAsync();
        return userId;
    }

    private static Dictionary<string, object?> RequestBody(Guid userId) =>
        new()
        {
            ["events"] = new[]
            {
                new Dictionary<string, object?>
                {
                    ["event_name"] = "forced-redirect",
                    ["event_version"] = 1,
                    ["timestamp"] = DateTimeOffset.UtcNow,
                    ["user_id"] = userId,
                    ["session_id"] = "auth-problem-test-session",
                    ["payload"] = new Dictionary<string, object?>
                    {
                        ["cause"] = "idle_timeout",
                        ["route_at_redirect"] = "/dashboard",
                    },
                },
            },
        };
}
