import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitAuthEvent } from '@/features/auth/authEvents'
import { useAuthEventHandler } from '@/features/auth/useAuthEventHandler'
import { api } from '@/services/api'
import { DirtyFormRegistryProvider } from '../dirtyFormRegistry'
import { resetRenewalStateForTests } from '../sessionRenewal'
import { buildRestoreKey } from '../sessionRestore'
import { useDirtyFormRegistry } from '../useDirtyFormRegistry'

const mocks = vi.hoisted(() => ({
  buildSessionContinuityEvent: vi.fn((user, eventName, payload) => {
    if (!user?.profile?.sub || !user?.profile?.sid) {
      return null
    }

    return {
      event_name: eventName,
      event_version: 1,
      timestamp: '2026-05-24T12:00:00.000Z',
      user_id: user.profile.sub,
      session_id: user.profile.sid,
      payload,
    }
  }),
  clearDeferredEventsForUser: vi.fn(),
  clearStaleState: vi.fn(),
  emitSessionContinuityEvent: vi.fn(),
  getUser: vi.fn(),
  persistFailureClassEvent: vi.fn(),
  removeUser: vi.fn(),
  signinSilent: vi.fn(),
}))

vi.mock('@/features/auth/oidcUserManager', () => ({
  oidcUserManager: {
    clearStaleState: mocks.clearStaleState,
    getUser: mocks.getUser,
    removeUser: mocks.removeUser,
    signinSilent: mocks.signinSilent,
  },
}))

vi.mock('@/features/session-continuity/deferredTelemetryBuffer', () => ({
  clearDeferredEventsForUser: mocks.clearDeferredEventsForUser,
  persistFailureClassEvent: mocks.persistFailureClassEvent,
}))

vi.mock('@/features/session-continuity/sessionTelemetry', () => ({
  buildSessionContinuityEvent: mocks.buildSessionContinuityEvent,
  emitSessionContinuityEvent: mocks.emitSessionContinuityEvent,
}))

const activeUser = {
  access_token: 'stale-token',
  expired: false,
  profile: {
    sub: '11111111-1111-1111-1111-111111111111',
    sid: 'session-1',
  },
}

const renewedUser = {
  access_token: 'renewed-token',
  expired: false,
  profile: {
    sub: '11111111-1111-1111-1111-111111111111',
    sid: 'session-1',
  },
}

describe('session continuity smoke path', () => {
  beforeEach(() => {
    resetRenewalStateForTests()
    vi.clearAllMocks()
    window.sessionStorage.clear()
    window.localStorage.clear()
    mocks.getUser.mockResolvedValue(activeUser)
    mocks.removeUser.mockResolvedValue(undefined)
    mocks.clearStaleState.mockResolvedValue(undefined)
    mocks.signinSilent.mockResolvedValue(renewedUser)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renews one recoverable GET and retries it with the fresh access token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Headers).get('Authorization')
      return authorization === 'Bearer stale-token'
        ? tokenExpiredResponse()
        : jsonResponse({ ok: true }, 200)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.get('/tasks/task-123')).resolves.toEqual({ ok: true })

    expect(mocks.signinSilent).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1][1]?.headers as Headers).get('Authorization')).toBe(
      'Bearer renewed-token',
    )
    expect(mocks.emitSessionContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: 'silent-renewal-success' }),
    )
  })

  it('captures dirty form state and restores the route on forced reauth', async () => {
    render(
      <MemoryRouter initialEntries={['/policies/pol-1?tab=activity']}>
        <DirtyFormRegistryProvider>
          <SessionContinuityHarness />
        </DirtyFormRegistryProvider>
      </MemoryRouter>,
    )

    await screen.findByText('Policy detail')

    act(() => {
      emitAuthEvent('forced_reauth', {
        cause: 'auth_token_invalid',
        endpointRoute: '/policies/pol-1',
        method: 'GET',
        returnTo: '/policies/pol-1?tab=activity',
      })
    })

    await waitFor(() => {
      expect(screen.getByLabelText('current-route')).toHaveTextContent(
        '/login?reason=session_expired&return_to=%2Fpolicies%2Fpol-1%3Ftab%3Dactivity',
      )
    })

    const snapshot = JSON.parse(
      window.sessionStorage.getItem(
        buildRestoreKey(activeUser.profile.sub, 'policy-detail'),
      ) ?? 'null',
    )
    expect(snapshot).toMatchObject({
      route: '/policies/pol-1?tab=activity',
      form_key: 'policy-detail',
      form_values: { namedInsured: 'Acme Specialty' },
      dirty_field_paths: ['namedInsured'],
    })
  })
})

function SessionContinuityHarness() {
  useAuthEventHandler()

  return (
    <>
      <LocationProbe />
      <Routes>
        <Route path="/policies/:policyId" element={<DirtyPolicyDetail />} />
        <Route path="/login" element={<div>Login</div>} />
      </Routes>
    </>
  )
}

function DirtyPolicyDetail() {
  const registry = useDirtyFormRegistry()

  useEffect(
    () => registry.register({
      formKey: 'policy-detail',
      route: '/policies/pol-1?tab=activity',
      isDirty: () => true,
      getValues: () => ({ namedInsured: 'Acme Specialty' }),
      getDirtyFieldPaths: () => ['namedInsured'],
    }),
    [registry],
  )

  return <div>Policy detail</div>
}

function LocationProbe() {
  const location = useLocation()
  return (
    <output aria-label="current-route">
      {location.pathname}
      {location.search}
    </output>
  )
}

function jsonResponse(
  body: unknown,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function tokenExpiredResponse(): Response {
  return jsonResponse(
    {
      type: 'https://nebula.local/problems/auth/token-expired',
      code: 'token_expired',
      title: 'Token expired',
    },
    401,
    { 'WWW-Authenticate': 'Bearer error="invalid_token", error_description="token expired"' },
  )
}
