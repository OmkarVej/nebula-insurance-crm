import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RenewalError,
  renewSessionForExpiredToken,
  resetRenewalStateForTests,
} from '../sessionRenewal'

const mocks = vi.hoisted(() => ({
  signinSilent: vi.fn(),
  buildSessionContinuityEvent: vi.fn((user, eventName, payload) => ({
    event_name: eventName,
    event_version: 1,
    timestamp: '2026-05-24T12:00:00.000Z',
    user_id: user.profile.sub,
    session_id: user.profile.sid,
    payload,
  })),
  emitSessionContinuityEvent: vi.fn(),
}))

vi.mock('@/features/auth/oidcUserManager', () => ({
  oidcUserManager: {
    signinSilent: mocks.signinSilent,
  },
}))

vi.mock('../sessionTelemetry', () => ({
  buildSessionContinuityEvent: mocks.buildSessionContinuityEvent,
  emitSessionContinuityEvent: mocks.emitSessionContinuityEvent,
}))

const renewedUser = {
  access_token: 'renewed-token',
  profile: {
    sub: '11111111-1111-1111-1111-111111111111',
    sid: 'session-1',
  },
}

describe('renewSessionForExpiredToken', () => {
  beforeEach(() => {
    resetRenewalStateForTests()
    mocks.signinSilent.mockReset()
    mocks.buildSessionContinuityEvent.mockClear()
    mocks.emitSessionContinuityEvent.mockClear()
  })

  it('coalesces concurrent renewal callers behind one silent sign-in', async () => {
    let resolveRenewal: (value: typeof renewedUser) => void = () => undefined
    mocks.signinSilent.mockReturnValue(
      new Promise((resolve) => {
        resolveRenewal = resolve
      }),
    )

    const first = renewSessionForExpiredToken()
    const second = renewSessionForExpiredToken()
    resolveRenewal(renewedUser)

    await expect(first).resolves.toMatchObject({
      accessToken: 'renewed-token',
      coalescedRequestCount: 2,
    })
    await expect(second).resolves.toMatchObject({
      accessToken: 'renewed-token',
      coalescedRequestCount: 2,
    })
    expect(mocks.signinSilent).toHaveBeenCalledTimes(1)
    expect(mocks.emitSessionContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'silent-renewal-success',
        payload: expect.objectContaining({ coalesced_request_count: 2 }),
      }),
    )
  })

  it('blocks immediate renewal loops after success', async () => {
    mocks.signinSilent.mockResolvedValue(renewedUser)

    await renewSessionForExpiredToken()

    expect(() => renewSessionForExpiredToken()).toThrow(RenewalError)
  })

  it('allows explicit user-initiated renewal to bypass the loop guard', async () => {
    mocks.signinSilent.mockResolvedValue(renewedUser)

    await renewSessionForExpiredToken()

    await expect(
      renewSessionForExpiredToken({ bypassLoopGuard: true }),
    ).resolves.toMatchObject({ accessToken: 'renewed-token' })
    expect(mocks.signinSilent).toHaveBeenCalledTimes(2)
  })

  it('maps invalid_grant renewal failures to refresh expiration', async () => {
    mocks.signinSilent.mockRejectedValue(new Error('invalid_grant'))

    await expect(renewSessionForExpiredToken()).rejects.toMatchObject({
      cause: 'refresh_expired',
    })
  })
})
