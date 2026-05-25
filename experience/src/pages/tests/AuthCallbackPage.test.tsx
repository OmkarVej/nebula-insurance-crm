import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthCallbackPage } from '../AuthCallbackPage'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  signinRedirectCallback: vi.fn(),
  clearStaleState: vi.fn(),
  drainDeferredEvents: vi.fn(),
  clearSnapshotsForOtherUsers: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/features/auth/oidcUserManager', () => ({
  oidcUserManager: {
    signinRedirectCallback: mocks.signinRedirectCallback,
    clearStaleState: mocks.clearStaleState,
  },
}))

vi.mock('@/features/session-continuity/deferredTelemetryBuffer', () => ({
  drainDeferredEvents: mocks.drainDeferredEvents,
}))

vi.mock('@/features/session-continuity/sessionRestore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/features/session-continuity/sessionRestore')>()
  return {
    ...original,
    clearSnapshotsForOtherUsers: mocks.clearSnapshotsForOtherUsers,
  }
})

describe('AuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/auth/callback?code=test&state=abc')
    mocks.clearStaleState.mockResolvedValue(undefined)
    mocks.drainDeferredEvents.mockResolvedValue(undefined)
  })

  it('redirects broker users to the brokers route after a successful callback', async () => {
    mocks.signinRedirectCallback.mockResolvedValue({
      profile: {
        sub: '11111111-1111-1111-1111-111111111111',
        nebula_roles: ['BrokerUser'],
      },
    })

    render(<AuthCallbackPage />)

    expect(screen.getByText('Completing sign-in…')).toBeInTheDocument()

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/brokers', { replace: true })
    })
  })

  it('redirects non-broker users to the dashboard route after a successful callback', async () => {
    mocks.signinRedirectCallback.mockResolvedValue({
      profile: {
        sub: '11111111-1111-1111-1111-111111111111',
        nebula_roles: ['Admin'],
      },
    })

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true })
    })
  })

  it('uses the remembered landing route when the exact callback was already completed', async () => {
    sessionStorage.setItem(
      'nebula_oidc_callback_done',
      '/auth/callback?code=test&state=abc',
    )
    sessionStorage.setItem('nebula_oidc_callback_landing', '/brokers')

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/brokers', { replace: true })
    })
    expect(mocks.signinRedirectCallback).not.toHaveBeenCalled()
  })

  it('treats an in-flight strict-mode replay as a no-op', async () => {
    sessionStorage.setItem(
      'nebula_oidc_callback_inflight',
      '/auth/callback?code=test&state=abc',
    )

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.signinRedirectCallback).not.toHaveBeenCalled()
    })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('falls back to the remembered landing route when a replayed callback throws after prior success', async () => {
    sessionStorage.setItem(
      'nebula_oidc_callback_done',
      '/auth/callback?code=test&state=abc',
    )
    sessionStorage.setItem('nebula_oidc_callback_landing', '/brokers')
    mocks.signinRedirectCallback.mockRejectedValue(new Error('replayed callback'))

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/brokers', { replace: true })
    })
  })

  it('clears stale state and redirects to login when the callback fails without a remembered success', async () => {
    mocks.signinRedirectCallback.mockRejectedValue(new Error('invalid state'))

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.clearStaleState).toHaveBeenCalledTimes(1)
      expect(mocks.navigate).toHaveBeenCalledWith('/login?error=callback_failed', {
        replace: true,
      })
    })
  })

  it('navigates to a safe return_to from OIDC state after draining deferred telemetry', async () => {
    mocks.signinRedirectCallback.mockResolvedValue({
      state: { return_to: '/policies/pol-1?tab=activity' },
      profile: {
        sub: '11111111-1111-1111-1111-111111111111',
        nebula_roles: ['Admin'],
      },
    })

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.drainDeferredEvents).toHaveBeenCalledWith(
        '11111111-1111-1111-1111-111111111111',
      )
      expect(mocks.clearSnapshotsForOtherUsers).toHaveBeenCalledWith(
        '11111111-1111-1111-1111-111111111111',
      )
      expect(mocks.navigate).toHaveBeenCalledWith('/policies/pol-1?tab=activity', {
        replace: true,
      })
    })
  })

  it('preserves callback success when deferred telemetry drain fails', async () => {
    mocks.signinRedirectCallback.mockResolvedValue({
      state: { return_to: '/policies/pol-1?tab=activity' },
      profile: {
        sub: '11111111-1111-1111-1111-111111111111',
        nebula_roles: ['Admin'],
      },
    })
    mocks.drainDeferredEvents.mockRejectedValue(new Error('telemetry unavailable'))

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/policies/pol-1?tab=activity', {
        replace: true,
      })
    })
    expect(mocks.navigate).not.toHaveBeenCalledWith('/login?error=callback_failed', {
      replace: true,
    })
  })

  it('rejects unsafe return_to values and falls back to the role landing route', async () => {
    mocks.signinRedirectCallback.mockResolvedValue({
      state: { return_to: 'https://evil.example/phish' },
      profile: {
        sub: '11111111-1111-1111-1111-111111111111',
        nebula_roles: ['BrokerUser'],
      },
    })

    render(<AuthCallbackPage />)

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/brokers', { replace: true })
    })
  })
})
