# Feature Assembly Plan - F0035: Session Continuity & Token Refresh

**Created:** 2026-05-24
**Author:** Architect Agent
**Status:** Draft

## Overview

F0035 replaces the current "any API 401 -> clear session and redirect to login" behavior with ADR-024's contract-level session-continuity design. The implementation spans backend authentication error semantics, a protected telemetry ingest endpoint, frontend auth-error classification, silent renewal with request coalescing, forced re-auth route/form restoration, the idle-warning modal, and feature-level test/deployability evidence.

This plan is the primary implementation spec for `agents/actions/feature.md`. ADR-024 and the F0035 stories remain authoritative for product and architecture intent; where this file adds implementation detail, it is constrained to those accepted artifacts.

## Build Order

| Step | Scope | Stories | Rationale |
|------|-------|---------|-----------|
| 1 | Backend auth-error and telemetry contracts | S0004, S0005 | Frontend dispatch depends on deterministic 401/403 semantics and a working event sink. |
| 2 | Frontend classifier, renewal coordinator, telemetry emitter | S0001, S0004, S0005 | Core session repair must exist before idle and restore flows consume it. |
| 3 | Forced re-auth route and form-state restore | S0003, S0005 | Renewal failure, hard-cap, and mutation paths converge here. |
| 4 | Idle-warning modal and app host integration | S0002, S0001, S0003, S0005 | The idle flow consumes renewal and forced re-auth primitives. |
| 5 | Feature test suites, runtime preflight, deployability evidence | S0001-S0005 | Required before G2/G3/G4.5 evidence can pass. |

## Existing Code (Must Be Modified)

| File | Current State | F0035 Change |
|------|---------------|--------------|
| `engine/src/Nebula.Api/Program.cs` | Configures JWT bearer auth, status-code ProblemDetails, endpoint mapping, Serilog request logging. No JWT challenge customization for ADR-024 classes. | **Expand** - add JWT bearer `Events.OnChallenge`/`OnForbidden` handlers, register session telemetry service, map telemetry endpoint, keep `UseAuthentication()` before `UseAuthorization()`. |
| `engine/src/Nebula.Api/Helpers/ProblemDetailsHelper.cs` | Central helper for domain validation, 403, 409, 412, and validation errors. Existing `Forbidden()` uses `code=forbidden` but no ADR-024 authz type URI. | **Expand** - add `AuthTokenExpired`, `AuthInvalidToken`, `AuthSessionRevoked`, `AuthorizationForbidden`, and telemetry validation ProblemDetails helpers. Existing broker-scope helper behavior remains unchanged. |
| `engine/src/Nebula.Api/Endpoints/AuthEndpoints.cs` | Anonymous `/auth/logout` endpoint clears refresh-token cookie and best-effort revokes authentik refresh token. | **Reuse** - no route change. Frontend sign-out/teardown must continue to call this endpoint and additionally clear F0035 local buffers. |
| `engine/src/Nebula.Api/appsettings.json` | Serilog default/override config writes compact JSON to console. | **Verify** - no config is required for additive category `Nebula.Session.Continuity`, but DevOps must capture evidence that the category appears in logs. |
| `engine/tests/Nebula.Tests/Integration/CustomWebApplicationFactory.cs` | Replaces auth with `TestAuthHandler` and uses Testcontainers PostgreSQL. | **Expand if needed** - expose a way for tests to simulate 401 challenge/forbidden responses without bypassing the standard pipeline. |
| `engine/tests/Nebula.Tests/Integration/TestAuthHandler.cs` | Always returns `AuthenticateResult.Success` with configurable claims. | **Expand** - add static mode for `Expired`, `Invalid`, `Revoked`, and `Forbidden` contract tests, or create a dedicated test endpoint/test handler if cleaner. |
| `experience/src/services/api.ts` | `resolveToken()` returns current OIDC access token or emits `session_expired`; `handleErrorIntercept()` maps all 401 to teardown and only special broker 403 to unauthorized page. | **Rewrite** - centralize ADR-024 classifier, renewal queue, read retry, mutation non-replay, forced re-auth dispatch, and telemetry side effects. |
| `experience/src/features/auth/authEvents.ts` | Event bus supports `session_expired` and `broker_scope_unresolvable`. | **Expand** - add typed events for forced re-auth, mutation retry notification, and optional session-continuity notices without losing broker-scope event behavior. |
| `experience/src/features/auth/useAuthEventHandler.ts` | Handles `session_expired` with teardown and broker-scope with unauthorized navigation. | **Expand** - consume new forced re-auth events, preserve `return_to`, snapshot dirty forms before redirect when requested, and route 403 authorization denial without renewal. |
| `experience/src/features/auth/useSessionTeardown.ts` | Clears session via `/auth/logout`, `removeUser()`, `clearStaleState()`, then redirects by reason. | **Expand** - clear current-user form snapshots and deferred telemetry entries on explicit sign-out; do not clear them on forced re-auth until callback/restore logic consumes them. |
| `experience/src/features/auth/oidcUserManager.ts` | OIDC singleton with `scope='openid profile email nebula_roles broker_tenant_id'`, `automaticSilentRenew=false`, sessionStorage user store. | **Expand** - include refresh-token scope required by authentik (`offline_access` unless the authentik app issues refresh tokens without it); keep manual `signinSilent()` use and `automaticSilentRenew=false`. |
| `experience/src/pages/AuthCallbackPage.tsx` | Completes OIDC callback and navigates to role-based landing route. StrictMode replay guard stores callback landing in sessionStorage. | **Rewrite** - consume validated `return_to`, drain deferred telemetry for current user, clear different-user snapshots before restore, then navigate to preserved route or role default. |
| `experience/src/App.tsx` | Mounts `useAuthEventHandler()` once under `BrowserRouter`; protected routes wrap pages individually. | **Expand** - mount a `SessionContinuityProvider` under `BrowserRouter` and above routes so idle timer, restore notifications, and dirty-form registry are globally available. |
| `experience/src/components/ui/Modal.tsx` | Generic dialog with close button, backdrop click close, role `dialog`. | **Do not reuse directly for idle modal unless adapted** - S0002 forbids dismiss-without-terminal-outcome and requires `role=alertdialog`; implement a dedicated idle modal to avoid weakening existing generic modal behavior. |
| `experience/src/pages/LoginPage.tsx` | Starts OIDC redirect on user click and displays reason/error messaging. | **Expand** - refine `reason=session_expired` copy to "continue where you left off"; preserve signed-out copy for `reason=signed_out`. |
| `experience/src/services/api.test.ts` | Covers old 401 pending promise and broker-scope 403 event. | **Rewrite/expand** - cover classifier matrix, one-renewal coalescing, GET retry, mutation non-replay, unknown 401 fallback, and 403 no-renewal behavior. |
| `experience/src/pages/tests/AuthCallbackPage.test.tsx` | Covers callback success, replay guard, and failure. | **Expand** - cover `return_to`, same-user deferred event drain, different-user snapshot isolation, and role-default fallback. |

## New Files

| File | Layer | Purpose |
|------|-------|---------|
| `engine/src/Nebula.Api/Endpoints/SessionTelemetryEndpoints.cs` | API | Minimal API group for `POST /internal/telemetry/session-continuity`. |
| `engine/src/Nebula.Api/Models/SessionContinuityTelemetryModels.cs` | API | Request envelope and event DTOs matching `session-continuity-event.schema.json`. |
| `engine/src/Nebula.Api/Services/SessionContinuityTelemetryService.cs` | API | Schema validation, PII guard, user-id match, and Serilog write category. |
| `engine/tests/Nebula.Tests/Integration/AuthProblemDetailsContractTests.cs` | Backend tests | Contract tests for 401 token-expired, invalid-token, session-revoked, 403 forbidden, and no `WWW-Authenticate` on 403. |
| `engine/tests/Nebula.Tests/Integration/SessionTelemetryEndpointTests.cs` | Backend tests | Valid batch 202, invalid schema 400, unauthenticated 401, user-id mismatch 403, PII rejection. |
| `experience/src/features/session-continuity/authErrorClassifier.ts` | Frontend | Maps `Response` + ProblemDetails to ADR-024 auth classes. |
| `experience/src/features/session-continuity/sessionRenewal.ts` | Frontend | Coalesced `oidcUserManager.signinSilent()` renewal primitive with 5s loop throttle. |
| `experience/src/features/session-continuity/sessionTelemetry.ts` | Frontend | Fire-and-forget telemetry emitter with 50-event memory buffer, 3 retries, and rate limit. |
| `experience/src/features/session-continuity/deferredTelemetryBuffer.ts` | Frontend | `localStorage` persist-before-emit and drain behavior for failure-class events. |
| `experience/src/features/session-continuity/sessionRestore.ts` | Frontend | `return_to`, sessionStorage snapshot keying, TTL, size cap, dirty-field restore helpers. |
| `experience/src/features/session-continuity/dirtyFormRegistry.tsx` | Frontend | React context used by forms/hooks to register dirty React Hook Form state for forced re-auth snapshotting. |
| `experience/src/features/session-continuity/useIdleWarning.ts` | Frontend | Monotonic idle timer, activity listeners, hard-cap/rolling-window checks. |
| `experience/src/features/session-continuity/IdleWarningModal.tsx` | Frontend | Dedicated accessible alert dialog for 25+5 minute idle flow. |
| `experience/src/features/session-continuity/SessionContinuityProvider.tsx` | Frontend | App-level host for idle modal, notifications, callbacks, and dirty-form registry. |
| `experience/src/features/session-continuity/index.ts` | Frontend | Public exports for provider/hooks. |
| `experience/src/features/session-continuity/tests/*.test.ts(x)` | Frontend tests | Unit/component coverage for classifier, renewal, telemetry, restore, idle modal. |

No files under `neuron/` are in scope. No database migration is expected.

---

## Step 1 - Backend Auth Error Semantics and Telemetry Endpoint (S0004, S0005)

### New Files

| File | Layer |
|------|-------|
| `engine/src/Nebula.Api/Endpoints/SessionTelemetryEndpoints.cs` | API |
| `engine/src/Nebula.Api/Models/SessionContinuityTelemetryModels.cs` | API |
| `engine/src/Nebula.Api/Services/SessionContinuityTelemetryService.cs` | API |
| `engine/tests/Nebula.Tests/Integration/AuthProblemDetailsContractTests.cs` | Test |
| `engine/tests/Nebula.Tests/Integration/SessionTelemetryEndpointTests.cs` | Test |

### Modified Files

| File | Change |
|------|--------|
| `engine/src/Nebula.Api/Program.cs` | Configure JWT challenge/forbidden semantics, DI register telemetry service, map endpoint. |
| `engine/src/Nebula.Api/Helpers/ProblemDetailsHelper.cs` | Add ADR-024 auth ProblemDetails helpers. |
| `engine/tests/Nebula.Tests/Integration/TestAuthHandler.cs` | Add failure simulation mode or separate test-only scheme support. |

### Entity / DTO / Code

```csharp
// engine/src/Nebula.Api/Models/SessionContinuityTelemetryModels.cs
namespace Nebula.Api.Models;

public sealed record SessionContinuityTelemetryRequest(
    IReadOnlyList<SessionContinuityEventDto> Events);

public sealed record SessionContinuityEventDto(
    string EventName,
    int EventVersion,
    DateTimeOffset Timestamp,
    Guid UserId,
    string SessionId,
    Dictionary<string, object?>? Payload);

public static class SessionContinuityEventNames
{
    public const string SilentRenewalSuccess = "silent-renewal-success";
    public const string SilentRenewalFail = "silent-renewal-fail";
    public const string ForcedRedirect = "forced-redirect";
    public const string IdleWarningShown = "idle-warning-shown";
    public const string IdleWarningAccepted = "idle-warning-accepted";
    public const string IdleWarningDismissed = "idle-warning-dismissed";
    public const string AuthClassifierFallback = "auth-classifier-fallback";
    public const string AuthClassifierConflict = "auth-classifier-conflict";
    public const string FormSnapshotSkipped = "form-snapshot-skipped";
}
```

```csharp
// engine/src/Nebula.Api/Services/SessionContinuityTelemetryService.cs
namespace Nebula.Api.Services;

public sealed class SessionContinuityTelemetryService
{
    public Task<(bool IsValid, IDictionary<string, string[]> Errors)> ValidateAsync(
        SessionContinuityTelemetryRequest request,
        Guid currentUserId,
        CancellationToken ct);

    public void WriteAcceptedEvents(
        SessionContinuityTelemetryRequest request,
        Guid currentUserId,
        string traceId);
}
```

```csharp
// engine/src/Nebula.Api/Endpoints/SessionTelemetryEndpoints.cs
namespace Nebula.Api.Endpoints;

public static class SessionTelemetryEndpoints
{
    public static RouteGroupBuilder MapSessionTelemetryEndpoints(this IEndpointRouteBuilder app);

    internal static Task<IResult> IngestAsync(
        SessionContinuityTelemetryRequest request,
        ICurrentUserService currentUser,
        SessionContinuityTelemetryService telemetry,
        HttpContext httpContext,
        CancellationToken ct);
}
```

```csharp
// engine/src/Nebula.Api/Helpers/ProblemDetailsHelper.cs
public static IResult AuthTokenExpired(string traceId);
public static IResult AuthInvalidToken(string traceId);
public static IResult AuthSessionRevoked(string traceId);
public static IResult AuthorizationForbidden(string traceId);
public static IResult TelemetryValidationError(IDictionary<string, string[]> errors);
```

### Logic Flow

```
JwtBearerEvents.OnChallenge(context) -> writes ADR-024 401 ProblemDetails
```

1. Call `context.HandleResponse()` to suppress the framework default challenge body.
2. Determine failure class:
   - `SecurityTokenExpiredException` or token validation error with expired lifetime -> `token-expired`.
   - authentik/user session revoked signal if available -> `session-revoked`.
   - all other token validation failures -> `invalid-token`.
3. Set HTTP status `401`.
4. Set `WWW-Authenticate: Bearer error="invalid_token", error_description="<bounded text>"`.
5. Write `application/problem+json` with one of:
   - `https://nebula.local/problems/auth/token-expired`
   - `https://nebula.local/problems/auth/invalid-token`
   - `https://nebula.local/problems/auth/session-revoked`
6. Include `code` and `traceId`. Do not include token claims, token contents, email, role list, issuer/audience values, or stack traces.

```
JwtBearerEvents.OnForbidden(context) -> writes ADR-024 403 ProblemDetails
```

1. Ensure no `WWW-Authenticate` header is set.
2. Set status `403`, content type `application/problem+json`.
3. Write ProblemDetails with `type=https://nebula.local/problems/authz/forbidden`, `code=forbidden`, and `traceId`.
4. Existing endpoint-level `ProblemDetailsHelper.Forbidden()`/`PolicyDenied()` should either use the same type URI or be reviewed to avoid conflicting 403 semantics.

```
POST /internal/telemetry/session-continuity -> returns 202/400/401/403
```

1. Require authenticated bearer session through `.RequireAuthorization()`.
2. Reject malformed request envelope: `events` absent, empty, or more than 10 -> 400 `validation_error`.
3. For each event:
   - Verify event name is in the closed ADR-024 set.
   - Verify `event_version >= 1`.
   - Verify `user_id == currentUser.UserId`; mismatch -> 403 `authz/forbidden` because one user must not spoof another user's telemetry.
   - Verify `session_id` is non-empty and <= 128 chars.
   - Verify payload keys are exactly allowed for the event type.
   - Reject forbidden PII key names: `email`, `name`, `ip`, `access_token`, `refresh_token`, `id_token`, `broker_tenant_id`, `roles`, `claims`, `form_values`, `query`.
4. On validation errors, return 400 ProblemDetails with `code=validation_error`.
5. On success, write each event via logger category `Nebula.Session.Continuity` with structured fields: `EventName`, `EventVersion`, `EventTimestamp`, `UserId`, `SessionId`, `TraceId`, and event payload fields.
6. Return `202 Accepted` with an empty body.

### Mutation Traceability

| Screen / Entry Point | User Action | Endpoint | Service Method | Entity / Carrier | Authorization | Concurrency | Validation Failure | Audit / Timeline | Test Expectation |
|----------------------|-------------|----------|----------------|------------------|---------------|-------------|--------------------|------------------|------------------|
| Frontend telemetry emitter | System emits session event | `POST /internal/telemetry/session-continuity` | `SessionContinuityTelemetryService.WriteAcceptedEvents` | Serilog event payload only; no domain entity | Bearer auth + `event.user_id == currentUser.UserId`; no `policy.csv` change | N/A - append-only logs | 400 `validation_error` for schema/PII/envelope failures; 403 for user mismatch | Serilog category `Nebula.Session.Continuity`; no `ActivityTimelineEvent` because this is diagnostic telemetry, not a domain mutation | Integration tests assert 202 valid, 400 invalid, 401 missing auth, 403 user mismatch, no PII in accepted log fields |

### Casbin Enforcement

- Resource: N/A for telemetry ingest; all authenticated roles may emit telemetry for their own session.
- Action: N/A; no `policy.csv` change.
- Hydrate attrs: `currentUser.UserId` from `ICurrentUserService`.
- Policy condition: user-id equality between bearer-derived user and event envelope.
- Enforcement pattern: `.RequireAuthorization()` plus explicit per-event `UserId` match. This keeps the endpoint protected without adding business-resource authorization that does not exist for diagnostic events.

### Timeline Event

- N/A - F0035 session-continuity telemetry writes to Serilog, not domain `ActivityTimelineEvent`.

### HTTP Responses

| Status | Body | Condition |
|--------|------|-----------|
| 202 Accepted | Empty | Batch accepted for log write |
| 400 | ProblemDetails (`validation_error`) | Envelope, event schema, PII boundary, or payload validation failure |
| 401 | ProblemDetails (`auth/token-expired`, `auth/invalid-token`, or `auth/session-revoked`) | Missing/invalid/expired bearer token |
| 403 | ProblemDetails (`authz/forbidden`) | Authenticated user attempts to submit another user's event |
| 429 | ProblemDetails (`rate_limited`) | Existing rate limiter rejects request |

---

## Step 2 - Frontend Classifier, Renewal Coordinator, and Telemetry Emitter (S0001, S0004, S0005)

### New Files

| File | Layer |
|------|-------|
| `experience/src/features/session-continuity/authErrorClassifier.ts` | Frontend |
| `experience/src/features/session-continuity/sessionRenewal.ts` | Frontend |
| `experience/src/features/session-continuity/sessionTelemetry.ts` | Frontend |
| `experience/src/features/session-continuity/deferredTelemetryBuffer.ts` | Frontend |
| `experience/src/features/session-continuity/tests/authErrorClassifier.test.ts` | Test |
| `experience/src/features/session-continuity/tests/sessionRenewal.test.ts` | Test |
| `experience/src/features/session-continuity/tests/sessionTelemetry.test.ts` | Test |

### Modified Files

| File | Change |
|------|--------|
| `experience/src/services/api.ts` | Replace legacy 401 teardown with classifier -> renewal/forced re-auth/403 behavior. |
| `experience/src/features/auth/authEvents.ts` | Add typed forced re-auth and mutation retry event payloads. |
| `experience/src/features/auth/oidcUserManager.ts` | Add refresh-token scope and keep manual silent renewal. |
| `experience/src/services/api.test.ts` | Replace old expectations with ADR-024 matrix. |

### Entity / DTO / Code

```ts
// experience/src/features/session-continuity/authErrorClassifier.ts
export type AuthProblemClass =
  | 'auth_token_expired'
  | 'auth_token_invalid'
  | 'auth_session_revoked'
  | 'authz_forbidden'
  | 'auth_unknown';

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  traceId?: string;
  [key: string]: unknown;
}

export interface AuthClassification {
  kind: AuthProblemClass;
  source: 'problem_details' | 'www_authenticate' | 'status' | 'fallback';
  conflict: boolean;
  endpointRoute: string;
}

export function classifyAuthResponse(
  response: Response,
  problem: ProblemDetails | null,
  endpointRoute: string,
): AuthClassification;
```

```ts
// experience/src/features/session-continuity/sessionRenewal.ts
export type RenewalFailureCause =
  | 'refresh_revoked'
  | 'refresh_expired'
  | 'idp_unreachable'
  | 'renewal_loop_detected';

export interface RenewalResult {
  accessToken: string;
  coalescedRequestCount: number;
  renewalDurationMs: number;
}

export class RenewalError extends Error {
  constructor(public cause: RenewalFailureCause, message?: string);
}

export function renewSessionForExpiredToken(): Promise<RenewalResult>;
export function resetRenewalStateForTests(): void;
```

Implementation contract:

- `renewSessionForExpiredToken()` uses a module-level `inFlightRenewal: Promise<RenewalResult> | null`.
- If `lastSuccessfulRenewalAt` is less than 5 seconds ago, throw `RenewalError('renewal_loop_detected')`.
- If no renewal is in flight, call `oidcUserManager.signinSilent({ silentRequestTimeoutInSeconds: 10 })`.
- `signinSilent()` uses refresh token when present in `oidc-client-ts`; it must not require an iframe for MVP.
- On success, return the new `user.access_token`; on failure map known OIDC/authentik errors to `refresh_revoked`, `refresh_expired`, or `idp_unreachable`.
- Count all callers waiting behind the same `inFlightRenewal` and emit exactly one `silent-renewal-success` event after success.

```ts
// experience/src/features/session-continuity/sessionTelemetry.ts
export type SessionContinuityEventName =
  | 'silent-renewal-success'
  | 'silent-renewal-fail'
  | 'forced-redirect'
  | 'idle-warning-shown'
  | 'idle-warning-accepted'
  | 'idle-warning-dismissed'
  | 'auth-classifier-fallback'
  | 'auth-classifier-conflict'
  | 'form-snapshot-skipped';

export interface SessionContinuityEvent {
  event_name: SessionContinuityEventName;
  event_version: 1;
  timestamp: string;
  user_id: string;
  session_id: string;
  payload?: Record<string, unknown>;
}

export function emitSessionContinuityEvent(event: SessionContinuityEvent): void;
export function flushSessionContinuityEvents(): Promise<void>;
```

```ts
// experience/src/features/session-continuity/deferredTelemetryBuffer.ts
export const DEFERRED_TELEMETRY_PREFIX = 'nebula.telemetry-defer.v1';

export function persistFailureClassEvent(event: SessionContinuityEvent): void;
export function removeDeferredEvent(userId: string, eventId: string): void;
export function drainDeferredEvents(userId: string): Promise<void>;
export function clearDeferredEventsForUser(userId: string): void;
```

### Logic Flow

```
requestApi(path, options, jsonContent) -> Response
```

1. Resolve token via existing OIDC/dev-token path.
2. Send request with bearer token and `credentials: include`.
3. If response is OK, return it.
4. Parse ProblemDetails if present. Classify with `classifyAuthResponse`.
5. Dispatch:
   - `auth_token_expired` + original method is `GET` or no method -> call `renewSessionForExpiredToken()`, retry original request exactly once with new token, return retry response if OK.
   - `auth_token_expired` + mutation method (`POST`, `PUT`, `PATCH`, `DELETE`) -> call renewal to repair session, do not replay the mutation, emit `mutation_retry_required`, throw/settle with a non-replay outcome that the caller can show as a non-blocking notification.
   - renewal failure -> persist and emit `silent-renewal-fail`, then emit forced re-auth event with cause and trigger Step 3 forced re-auth.
   - `auth_token_invalid` or `auth_session_revoked` -> trigger Step 3 forced re-auth. No silent renewal.
   - `authz_forbidden` -> throw `ApiError(403, problem)` except for existing `broker_scope_unresolvable`, which still emits `broker_scope_unresolvable`.
   - `auth_unknown` -> persist and emit `auth-classifier-fallback`, then forced re-auth.
6. If `WWW-Authenticate` and ProblemDetails disagree, ProblemDetails wins and `auth-classifier-conflict` is persisted/emitted.
7. Preserve existing never-resolving promise behavior only for navigation-in-flight paths. Do not use it for `403` permission errors that page code already handles.

### Mutation Traceability

| Screen / Entry Point | User Action | Endpoint | Service Method | Entity / Carrier | Authorization | Concurrency | Validation Failure | Audit / Timeline | Test Expectation |
|----------------------|-------------|----------|----------------|------------------|---------------|-------------|--------------------|------------------|------------------|
| Any protected page background read | User navigation or TanStack Query read | Original `GET` endpoint | Original endpoint service method | Original read DTO | Original endpoint authorization unchanged | Read retry once after renewal | Original endpoint ProblemDetails if retry fails | `silent-renewal-success` event, no domain timeline | Six concurrent expired GETs trigger exactly one `signinSilent()` and six single retries |
| Any protected form save | User clicks Save and original mutation receives `401-token-expired` | Original mutation endpoint, not auto-replayed by F0035 | Original service method only after user re-clicks | Underlying entity only after explicit user retry | Original endpoint authorization unchanged | Original endpoint rowVersion/If-Match applies on explicit retry | Non-blocking retry notification if renewal succeeds; forced re-auth restore if renewal fails | No `mutation-auto-replayed` event; original domain timeline appears only after explicit re-click | Test asserts mutation fetch called once before renewal and not called again automatically |

### Casbin Enforcement

- No frontend Casbin enforcement. Existing backend endpoint authorization remains authoritative.
- F0035 must not modify `planning-mds/security/policies/policy.csv` for renewal or telemetry.

### Timeline Event

- N/A for renewal and classifier behavior. F0035 emits session-continuity telemetry only.

### HTTP Responses

This step consumes existing backend responses rather than adding API responses. Tests must cover:

| Status | Body/Header | Frontend Condition |
|--------|-------------|--------------------|
| 401 | token-expired ProblemDetails + `WWW-Authenticate` | Silent renewal path |
| 401 | invalid-token/session-revoked ProblemDetails + `WWW-Authenticate` | Forced re-auth path |
| 401 | missing/malformed discriminator | Defensive forced re-auth + fallback event |
| 403 | authz/forbidden ProblemDetails, no `WWW-Authenticate` | No renewal, no redirect |

---

## Step 3 - Forced Re-Auth Route and Form State Restore (S0003, S0005)

### New Files

| File | Layer |
|------|-------|
| `experience/src/features/session-continuity/sessionRestore.ts` | Frontend |
| `experience/src/features/session-continuity/dirtyFormRegistry.tsx` | Frontend |
| `experience/src/features/session-continuity/tests/sessionRestore.test.ts` | Test |

### Modified Files

| File | Change |
|------|--------|
| `experience/src/features/auth/useAuthEventHandler.ts` | On forced re-auth event, snapshot dirty forms, persist forced-redirect event, navigate to login with encoded `return_to`. |
| `experience/src/pages/AuthCallbackPage.tsx` | After successful callback, consume safe `return_to`, drain deferred telemetry, clear different-user snapshots, navigate to route. |
| `experience/src/features/auth/useSessionTeardown.ts` | Clear current user's snapshots and deferred telemetry on explicit sign-out. |
| `experience/src/pages/LoginPage.tsx` | Refine `reason=session_expired` copy. |

### Entity / DTO / Code

```ts
// experience/src/features/session-continuity/sessionRestore.ts
export const SESSION_RESTORE_PREFIX = 'nebula.session-restore.v1';
export const SESSION_RESTORE_TTL_MS = 3_600_000;
export const SESSION_RESTORE_MAX_BYTES = 262_144;

export interface FormSnapshotRecord<TValues = unknown> {
  user_id: string;
  route: string;
  form_key: string;
  form_values: TValues;
  dirty_field_paths: string[];
  snapshot_timestamp: string;
}

export interface SnapshotResult {
  stored: boolean;
  skippedCause?: 'oversize' | 'classifier_uncertain' | 'storage_unavailable';
}

export function buildRestoreKey(userId: string, formKey: string): string;
export function sanitizeReturnTo(raw: string | null): string | null;
export function snapshotDirtyForm(record: FormSnapshotRecord): SnapshotResult;
export function consumeFormSnapshot<TValues>(userId: string, formKey: string): FormSnapshotRecord<TValues> | null;
export function clearSnapshotsForUser(userId: string): void;
export function clearSnapshotsForOtherUsers(currentUserId: string): void;
```

```tsx
// experience/src/features/session-continuity/dirtyFormRegistry.tsx
export interface DirtyFormRegistration<TValues = unknown> {
  formKey: string;
  route: string;
  isDirty: () => boolean;
  getValues: () => TValues;
  getDirtyFieldPaths: () => string[];
}

export interface DirtyFormRegistry {
  register<TValues>(registration: DirtyFormRegistration<TValues>): () => void;
  snapshotAllDirty(userId: string, route: string): SnapshotResult[];
}

export function DirtyFormRegistryProvider(props: { children: React.ReactNode }): JSX.Element;
export function useDirtyFormRegistry(): DirtyFormRegistry;
export function useSessionRestorableForm<TValues>(registration: DirtyFormRegistration<TValues>): void;
```

### Logic Flow

```
beginForcedReauth(cause, originalRequest) -> redirect
```

1. Resolve current OIDC user and internal `user_id`; if unavailable, navigate to `/login?reason=session_expired`.
2. Compute `return_to` from `window.location.pathname + window.location.search`, rejecting absolute URLs and auth routes.
3. If original request is a mutation or the registry has dirty forms on the route, call `snapshotAllDirty(user_id, route)`.
4. For each snapshot:
   - Serialize JSON and enforce 256 KB cap.
   - Store in `sessionStorage` at `nebula.session-restore.v1.<user_id>.<form_key>`.
   - On oversize/storage failure, emit `form-snapshot-skipped` without form contents.
5. Persist-before-emit `forced-redirect` if cause is failure-class.
6. Navigate to `/login?reason=session_expired&return_to=<encoded route>`.
7. Do not call `/auth/logout` during forced re-auth unless the path is explicit sign-out; preserving IdP state is necessary for return flow.

```
AuthCallbackPage successful callback -> route restore
```

1. Complete `oidcUserManager.signinRedirectCallback()`.
2. Resolve current internal user id from profile/session. If not available, fall back to role landing route.
3. Drain deferred events for that `user_id`.
4. Clear snapshots for other users before any restore.
5. Validate `return_to`: same-origin path only, not `/login`, not `/auth/callback`, no dangerous scheme, query string allowed only if same-origin route and existing app path.
6. Navigate to valid `return_to`, otherwise role default.
7. On route mount, form-level hooks call `consumeFormSnapshot(user_id, form_key)`, rehydrate values, mark dirty fields, delete consumed entry, and show inline "Click Save when ready" notification.

### Mutation Traceability

| Screen / Entry Point | User Action | Endpoint | Service Method | Entity / Carrier | Authorization | Concurrency | Validation Failure | Audit / Timeline | Test Expectation |
|----------------------|-------------|----------|----------------|------------------|---------------|-------------|--------------------|------------------|------------------|
| Any React Hook Form-managed protected form | Save returns 401 and forced re-auth begins | Original mutation endpoint is abandoned; no replay | Original service method not invoked again until explicit re-click | `sessionStorage` snapshot carrier; domain entity unchanged until re-click | Original endpoint authorization applies on explicit re-click | Original rowVersion/If-Match applies only on explicit re-click | Oversize -> route-only restore + `form-snapshot-skipped`; TTL expiry -> discard snapshot | `forced-redirect` event and optional `form-snapshot-skipped`; existing domain timeline only after explicit save | E2E/integration proves fields restore for same user, not for different user, and server mutation occurs only after explicit re-click |

### Casbin Enforcement

- Snapshotting is client-local and does not grant permissions. The eventual explicit mutation reuses the original endpoint authorization and current rowVersion handling.
- Cross-user snapshot isolation is enforced in frontend keying and callback cleanup.

### Timeline Event

- F0035 does not create domain timeline events for snapshot or restore.
- Underlying feature/domain timeline events must appear only when the user explicitly re-clicks Save/Submit after return.

### HTTP Responses

No new backend responses. The login callback route consumes `return_to`; original mutation endpoint responses remain owned by the underlying feature.

---

## Step 4 - Idle Warning Modal and App Host Integration (S0002)

### New Files

| File | Layer |
|------|-------|
| `experience/src/features/session-continuity/useIdleWarning.ts` | Frontend |
| `experience/src/features/session-continuity/IdleWarningModal.tsx` | Frontend |
| `experience/src/features/session-continuity/SessionContinuityProvider.tsx` | Frontend |
| `experience/src/features/session-continuity/tests/useIdleWarning.test.tsx` | Test |
| `experience/src/features/session-continuity/tests/IdleWarningModal.test.tsx` | Test |
| `experience/src/features/session-continuity/tests/IdleWarningModal.a11y.test.tsx` | Test |

### Modified Files

| File | Change |
|------|--------|
| `experience/src/App.tsx` | Wrap routes with `SessionContinuityProvider`. |
| `experience/src/features/auth/useSessionTeardown.ts` | Explicit sign-out path clears current-user buffers/snapshots. |

### Entity / DTO / Code

```ts
// experience/src/features/session-continuity/useIdleWarning.ts
export const IDLE_THRESHOLD_MS = 1_500_000;
export const GRACE_PERIOD_MS = 300_000;
export const ROLLING_ACTIVITY_WINDOW_MS = 14_400_000;
export const ABSOLUTE_SESSION_HARD_CAP_MS = 28_800_000;

export interface IdleWarningState {
  modalOpen: boolean;
  remainingMs: number;
  warningState: boolean;
}

export interface IdleWarningController extends IdleWarningState {
  staySignedIn(): Promise<void>;
  signOut(): Promise<void>;
}

export function useIdleWarning(): IdleWarningController;
```

```tsx
// experience/src/features/session-continuity/IdleWarningModal.tsx
export interface IdleWarningModalProps {
  open: boolean;
  remainingMs: number;
  onStaySignedIn: () => void;
  onSignOut: () => void;
}

export function IdleWarningModal(props: IdleWarningModalProps): JSX.Element | null;
```

```tsx
// experience/src/features/session-continuity/SessionContinuityProvider.tsx
export function SessionContinuityProvider(props: { children: React.ReactNode }): JSX.Element;
```

### Logic Flow

```
useIdleWarning() -> modal and forced re-auth transitions
```

1. Track `lastActivityAt` and `sessionStartedAt` using `performance.now()`.
2. Listen to `mousedown`, `keydown`, `touchstart`, route change, and form input. Do not record key contents.
3. At 25 minutes inactivity, open modal once, emit `idle-warning-shown`, set grace deadline.
4. Every second, derive displayed `M:SS` from the grace deadline. Below 30 seconds set red warning state without layout shift.
5. "Stay signed in":
   - Call `renewSessionForExpiredToken()`, even if token is not expired.
   - Emit `idle-warning-accepted` with `time_remaining_ms`.
   - Close modal, reset idle timer.
   - On renewal failure, close modal and begin forced re-auth with mapped cause.
6. "Sign out" or Escape:
   - Emit `idle-warning-dismissed` with `dismissal_action=user_signed_out`.
   - Call explicit teardown with `reason=signed_out`, clear snapshots/deferred events for current user, navigate `/login?reason=signed_out`.
7. Grace expiry:
   - Emit `idle-warning-dismissed` with `dismissal_action=grace_period_expired`.
   - Begin forced re-auth with `cause=idle_timeout`.
8. Rolling 4-hour cap and absolute 8-hour cap:
   - When exceeded, suppress idle modal and begin forced re-auth with `rolling_window_exceeded` or `hard_cap_reached`; hard cap wins.

### Mutation Traceability

| Screen / Entry Point | User Action | Endpoint | Service Method | Entity / Carrier | Authorization | Concurrency | Validation Failure | Audit / Timeline | Test Expectation |
|----------------------|-------------|----------|----------------|------------------|---------------|-------------|--------------------|------------------|------------------|
| Idle-warning modal | Click "Stay signed in" | authentik refresh via `oidcUserManager.signinSilent()`; no Nebula domain endpoint | `renewSessionForExpiredToken` | OIDC user/session state | Existing authentik session + bearer flow | Coalesced with any in-flight renewal | Renewal failure -> forced re-auth | `idle-warning-accepted` and optional `silent-renewal-success/fail` telemetry | Component test verifies modal closes, renewal called once, idle timer reset |
| Idle-warning modal | Click "Sign out" or Escape | `POST /auth/logout` fire-and-forget | `useSessionTeardown('signed_out')` | local session and refresh-token cookie | Endpoint allows anonymous by design | N/A | Logout network errors swallowed | `idle-warning-dismissed{user_signed_out}` telemetry; no domain timeline | Test verifies redirect `/login?reason=signed_out` and local buffers cleared |
| Idle-warning modal | No action for 5 minutes | No domain endpoint before redirect | `beginForcedReauth('idle_timeout')` | route/form snapshot carrier | Re-auth on next sign-in | N/A | Snapshot oversize/storage failure handled as Step 3 | `idle-warning-dismissed{grace_period_expired}` + `forced-redirect{idle_timeout}` | Fake-timer test verifies route preservation and forced redirect |

### Casbin Enforcement

- N/A in frontend. Backend authorization remains unchanged on subsequent protected calls.

### Timeline Event

- N/A - only session-continuity telemetry.

### HTTP Responses

- No new Nebula API responses.
- `/auth/logout` remains `204 No Content` and anonymous.

---

## Scope Breakdown

| Layer | Required Work | Owner | Status |
|------|----------------|-------|--------|
| Backend (`engine/`) | Auth challenge/forbidden ProblemDetails; telemetry ingest endpoint; Serilog category writes; integration tests | Backend Developer | Planned |
| Frontend (`experience/`) | Classifier, renewal coordinator, restore helpers, dirty-form registry, idle modal, telemetry emitter, callback integration, tests | Frontend Developer | Planned |
| AI (`neuron/`) | None | AI Engineer | Not in scope |
| Quality | Test plan, frontend unit/component/a11y/integration coverage, backend integration coverage, E2E/smoke route for forced re-auth | Quality Engineer | Planned |
| DevOps/Runtime | Authentik refresh-token issuance preflight, Docker health evidence, Serilog category verification, endpoint reachability verification | DevOps | Planned |

## Dependency Order

```
Step 0 (Architect):  this feature assembly plan and G0 validation
Step 1 (Backend):    auth-error semantics + telemetry endpoint
  ---- Backend checkpoint: 401/403 contract tests and telemetry endpoint tests pass ----
Step 2 (Frontend):   classifier + renewal + telemetry emitter
  ---- Frontend checkpoint: classifier matrix, coalescing, GET retry, mutation no-replay tests pass ----
Step 3 (Frontend):   forced re-auth return_to + form snapshot restore
  ---- Restore checkpoint: same-user restore, different-user discard, sign-out cleanup tests pass ----
Step 4 (Frontend):   idle modal + provider host integration
  ---- UX checkpoint: focus trap, alertdialog, countdown, responsive button stack, axe checks pass ----
Step 5 (QE/DevOps):  end-to-end smoke, runtime preflight, coverage and deployability reports
```

## Integration Checkpoints

### After Step 1 (Backend Contracts)

- [ ] `POST /internal/telemetry/session-continuity` is mapped and requires auth.
- [ ] Valid event batch returns 202 and writes `Nebula.Session.Continuity` structured log.
- [ ] Invalid event batch returns 400 `validation_error`.
- [ ] Event `user_id` mismatch returns 403 `authz/forbidden`.
- [ ] 401 responses include `WWW-Authenticate` and recognized auth ProblemDetails type.
- [ ] 403 responses do not include `WWW-Authenticate`.

### After Step 2 (Frontend Renewal Core)

- [ ] Six concurrent expired GETs produce exactly one `signinSilent()` call and six one-time retries.
- [ ] A mutation request is not auto-replayed after renewal.
- [ ] Unknown 401 produces `auth-classifier-fallback` and forced re-auth.
- [ ] Disagreeing header/body produces `auth-classifier-conflict`; ProblemDetails wins.
- [ ] 403 authorization denial does not renew and does not redirect.
- [ ] Failure-class telemetry persists before redirect/session clear.

### After Step 3 (Route/Form Restore)

- [ ] `/login?reason=session_expired&return_to=<encoded>` accepts only same-origin app routes.
- [ ] Same-user dirty form snapshot rehydrates values, marks dirty fields, deletes consumed snapshot.
- [ ] Different-user callback does not consume prior user's snapshot.
- [ ] Explicit sign-out clears current user's snapshots and deferred telemetry entries.
- [ ] Snapshot oversize drops form contents, preserves route, emits `form-snapshot-skipped`.

### After Step 4 (Idle Modal)

- [ ] Modal appears at 25 minutes inactivity and countdown starts at 5:00.
- [ ] "Stay signed in" renews, closes modal, resets idle timer, emits accepted telemetry.
- [ ] "Sign out" redirects to `/login?reason=signed_out`, not `session_expired`.
- [ ] Grace expiry triggers forced re-auth with `cause=idle_timeout`.
- [ ] Modal uses `role=alertdialog`, traps focus, and Escape follows sign-out behavior.
- [ ] Narrow viewport stacks buttons with at least 44px touch targets.

### Cross-Story Verification

- [ ] Full recoverable flow: protected GET -> 401 token-expired -> one renewal -> retry -> page remains on route -> `silent-renewal-success`.
- [ ] Full forced flow: mutation -> 401 auth failed or renewal failure -> snapshot -> login -> callback -> route restore -> explicit re-click required.
- [ ] Full idle flow: inactivity -> modal -> grace expiry -> forced re-auth -> route restore.
- [ ] No auto-replay of mutation is observable in network calls, telemetry, or domain timeline.
- [ ] Telemetry events contain no email, name, IP, raw tokens, broker tenant id, role list, claims, form contents, or query strings.

## Integration Checklist

- [ ] API contract compatibility validated against `planning-mds/api/nebula-api.yaml`.
- [ ] Frontend contract compatibility validated against `planning-mds/schemas/session-continuity-event.schema.json`.
- [ ] AI contract compatibility not applicable.
- [ ] Test cases mapped to all S0001-S0005 acceptance criteria.
- [ ] Developer-owned fast-test responsibilities identified by layer.
- [ ] Runtime evidence artifacts identified: backend test result, frontend unit/integration/a11y output, coverage, container preflight, deployability check.
- [ ] Framework vs solution boundary reviewed; no `agents/**` edits are part of this feature implementation.
- [ ] Mutation traceability tables completed for every save/update/emit path.
- [ ] Render-only tests are not used to close mutation stories.
- [ ] Run/deploy instructions updated in `GETTING-STARTED.md`.

## Risks and Blockers

| Item | Severity | Mitigation | Owner |
|------|----------|------------|-------|
| Authentik client may not issue refresh tokens without `offline_access` or app config | High | DevOps G1 preflight must verify refresh-token issuance in runtime; frontend scope must include the required refresh-token scope. | DevOps / Frontend |
| `oidc-client-ts.signinSilent()` error mapping may not expose exact revoked vs expired causes | Medium | Map available OIDC error codes conservatively; unknown refresh failure becomes `idp_unreachable` or forced re-auth; log cause server-side only if available. | Frontend / Security |
| Existing forms do not all register with the dirty-form registry | Medium | MVP must register at least forced-re-auth validation forms used in QE smoke; unregistered forms fall back to route-only preservation and produce explicit coverage gap. | Frontend / QE |
| 403 helper semantics may conflict with broker-scope special case | Medium | Preserve `broker_scope_unresolvable` code path; only normalize general authz forbidden responses to ADR-024 type. | Backend |
| LocalStorage deferred telemetry contains UserId/session_id for up to 7 days | Medium | Enforce schema PII boundary, per-user prefix, TTL purge, sign-out cleanup; Security Reviewer signoff required. | Frontend / Security |

## JSON Serialization Convention

- Backend C# DTOs use PascalCase source members serialized by ASP.NET Core default JSON policy to camelCase.
- Frontend event payloads must be snake_case exactly as defined by `session-continuity-event.schema.json` (`event_name`, `event_version`, `user_id`, `session_id`).
- Date/time values are ISO 8601 strings with timezone (`DateTimeOffset` backend, `new Date().toISOString()` frontend).
- Event payload objects use `additionalProperties=false` semantics. Unknown fields are rejected before emit in dev mode and at backend ingest always.
- Route fields are path-only unless explicitly `return_to`; never include full URL origin or query strings that can contain PII.

## DI Registration Changes

- `Program.cs`:
  - `builder.Services.AddScoped<SessionContinuityTelemetryService>();`
  - `app.MapSessionTelemetryEndpoints();` after existing endpoint maps or near auth endpoints.
  - `AddJwtBearer(options => options.Events = new JwtBearerEvents { OnChallenge = ..., OnForbidden = ... })`.
- No EF repository, DbContext, migration, or domain entity registration is required.

## Casbin Policy Sync

No `policy.csv` changes are planned. If implementation discovers a requirement to restrict telemetry ingest beyond authenticated self-event submission, halt and route back to Architect because that would change authorization semantics outside ADR-024.

## Required Validation Commands

Run inside the application runtime containers unless the feature evidence contract explicitly records a local equivalent:

```bash
dotnet test engine/tests/Nebula.Tests/Nebula.Tests.csproj --filter "FullyQualifiedName~AuthProblemDetailsContractTests|FullyQualifiedName~SessionTelemetryEndpointTests"
pnpm --dir experience test -- src/services/api.test.ts src/features/session-continuity/tests
pnpm --dir experience test:integration
pnpm --dir experience test:accessibility
pnpm --dir experience lint
pnpm --dir experience lint:theme
pnpm --dir experience build
```

QE must add an E2E or smoke validation path that exercises at least one recoverable GET renewal and one forced re-auth route restore. DevOps must capture `docker compose ps`, API health, authentik health, and refresh-token issuance evidence before G2 validation commands.
