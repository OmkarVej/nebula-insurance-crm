import { act, renderHook } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GRACE_PERIOD_MS,
  IDLE_THRESHOLD_MS,
  ROLLING_ACTIVITY_WINDOW_MS,
  useIdleWarning,
} from '../useIdleWarning'

const mocks = vi.hoisted(() => ({
  emitAuthEvent: vi.fn(),
  getUser: vi.fn(),
  removeUser: vi.fn(),
  clearStaleState: vi.fn(),
  renewSessionForExpiredToken: vi.fn(),
  buildSessionContinuityEvent: vi.fn((user, eventName, payload) => ({
    event_name: eventName,
    event_version: 1,
    timestamp: '2026-05-24T12:00:00.000Z',
    user_id: user.profile.sub,
    session_id: user.profile.sid,
    payload,
  })),
  clearDeferredEventsForUser: vi.fn(),
  emitSessionContinuityEvent: vi.fn(),
  persistFailureClassEvent: vi.fn(),
}))

vi.mock('@/features/auth/authEvents', () => ({
  emitAuthEvent: mocks.emitAuthEvent,
}))

vi.mock('@/features/auth/oidcUserManager', () => ({
  oidcUserManager: {
    getUser: mocks.getUser,
    removeUser: mocks.removeUser,
    clearStaleState: mocks.clearStaleState,
  },
}))

vi.mock('../sessionRenewal', () => ({
  renewSessionForExpiredToken: mocks.renewSessionForExpiredToken,
}))

vi.mock('../sessionTelemetry', () => ({
  buildSessionContinuityEvent: mocks.buildSessionContinuityEvent,
  emitSessionContinuityEvent: mocks.emitSessionContinuityEvent,
}))

vi.mock('../deferredTelemetryBuffer', () => ({
  clearDeferredEventsForUser: mocks.clearDeferredEventsForUser,
  persistFailureClassEvent: mocks.persistFailureClassEvent,
}))

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/policies/pol-1']}>{children}</MemoryRouter>
}

describe('useIdleWarning', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/policies/pol-1?tab=activity')
    window.localStorage.clear()
    window.sessionStorage.clear()
    mocks.getUser.mockResolvedValue({
      access_token: 'token',
      expired: false,
      profile: {
        sub: '11111111-1111-1111-1111-111111111111',
        sid: 'session-1',
      },
    })
    mocks.removeUser.mockResolvedValue(undefined)
    mocks.clearStaleState.mockResolvedValue(undefined)
    mocks.renewSessionForExpiredToken.mockResolvedValue({
      accessToken: 'renewed-token',
      coalescedRequestCount: 1,
      renewalDurationMs: 10,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens the idle modal at the inactivity threshold and emits shown telemetry', async () => {
    const { result } = renderHook(() => useIdleWarning(), { wrapper })

    await act(async () => {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS + 1_000)
      await Promise.resolve()
    })

    expect(result.current.modalOpen).toBe(true)
    expect(result.current.remainingMs).toBe(GRACE_PERIOD_MS)
    expect(mocks.emitSessionContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: 'idle-warning-shown' }),
    )
  })

  it('renews and closes the modal when the user stays signed in', async () => {
    const { result } = renderHook(() => useIdleWarning(), { wrapper })

    await act(async () => {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS + 1_000)
      await Promise.resolve()
    })

    await act(async () => {
      await result.current.staySignedIn()
    })

    expect(mocks.renewSessionForExpiredToken).toHaveBeenCalledWith({
      bypassLoopGuard: true,
    })
    expect(result.current.modalOpen).toBe(false)
    expect(mocks.emitSessionContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: 'idle-warning-accepted' }),
    )
  })

  it('forces reauth when the grace period expires', async () => {
    const { result } = renderHook(() => useIdleWarning(), { wrapper })

    await act(async () => {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS + 1_000)
      await Promise.resolve()
    })

    await act(async () => {
      vi.advanceTimersByTime(GRACE_PERIOD_MS + 1_000)
      await Promise.resolve()
    })

    expect(result.current.modalOpen).toBe(false)
    expect(mocks.persistFailureClassEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'forced-redirect',
        payload: expect.objectContaining({ cause: 'idle_timeout' }),
      }),
    )
    expect(mocks.emitAuthEvent).toHaveBeenCalledWith(
      'forced_reauth',
      expect.objectContaining({ cause: 'idle_timeout' }),
    )
  })

  it('resets the rolling activity window on route changes', async () => {
    const { result } = renderHook(
      () => ({
        controller: useIdleWarning(),
        navigate: useNavigate(),
      }),
      { wrapper },
    )
    const stepMs = IDLE_THRESHOLD_MS - 1_000
    let elapsedMs = 0
    let routeIndex = 1

    while (elapsedMs < ROLLING_ACTIVITY_WINDOW_MS + 2_000) {
      await act(async () => {
        vi.advanceTimersByTime(stepMs)
        await Promise.resolve()
      })
      elapsedMs += stepMs
      routeIndex += 1
      await act(async () => {
        result.current.navigate(`/policies/pol-${routeIndex}`)
        await Promise.resolve()
      })
    }

    expect(result.current.controller.modalOpen).toBe(false)
    expect(mocks.emitAuthEvent).not.toHaveBeenCalledWith(
      'forced_reauth',
      expect.objectContaining({ cause: 'rolling_window_exceeded' }),
    )
  })

  it('signs out explicitly from the idle modal path', async () => {
    const { result } = renderHook(() => useIdleWarning(), { wrapper })

    await act(async () => {
      await result.current.signOut()
    })

    expect(mocks.emitSessionContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'idle-warning-dismissed',
        payload: { dismissal_action: 'user_signed_out' },
      }),
    )
    expect(fetch).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
  })

  it('does not open the idle modal on public auth routes', async () => {
    window.history.replaceState({}, '', '/login?reason=session_expired')
    const { result } = renderHook(() => useIdleWarning(), { wrapper })

    await act(async () => {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS + GRACE_PERIOD_MS + 1_000)
      await Promise.resolve()
    })

    expect(result.current.modalOpen).toBe(false)
    expect(mocks.emitAuthEvent).not.toHaveBeenCalled()
  })
})
