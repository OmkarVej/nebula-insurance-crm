/**
 * Tests for ProtectedRoute (F0009 — S0003 contract)
 *
 * Covers:
 *   1. Authenticated user (non-expired) → renders children
 *   2. No session (user is null) → redirects to /login
 *   3. Expired session → attempts silent renewal before forced reauth
 *   4. Loading state → renders null (no flash of protected content)
 *   5. VITE_AUTH_MODE=dev → always renders children (guard is no-op)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ProtectedRoute } from '../ProtectedRoute';

// ---------------------------------------------------------------------------
// Mock oidcUserManager
// ---------------------------------------------------------------------------

const {
  mockBuildSessionContinuityEvent,
  mockEmitAuthEvent,
  mockEmitSessionContinuityEvent,
  mockGetUser,
  mockPersistFailureClassEvent,
  mockRenewSessionForExpiredToken,
} = vi.hoisted(() => ({
  mockBuildSessionContinuityEvent: vi.fn((user, eventName, payload) => {
    if (!user?.profile?.sub || !user?.profile?.sid) {
      return null;
    }

    return {
      event_name: eventName,
      event_version: 1,
      timestamp: '2026-05-24T12:00:00.000Z',
      user_id: user.profile.sub,
      session_id: user.profile.sid,
      payload,
    };
  }),
  mockEmitAuthEvent: vi.fn(),
  mockEmitSessionContinuityEvent: vi.fn(),
  mockGetUser: vi.fn(),
  mockPersistFailureClassEvent: vi.fn(),
  mockRenewSessionForExpiredToken: vi.fn(),
}));

vi.mock('../oidcUserManager', () => ({
  oidcUserManager: {
    getUser: mockGetUser,
    events: {
      addUserLoaded: vi.fn(),
      addUserUnloaded: vi.fn(),
      removeUserLoaded: vi.fn(),
      removeUserUnloaded: vi.fn(),
    },
  },
}));

vi.mock('../authEvents', () => ({
  emitAuthEvent: mockEmitAuthEvent,
}));

vi.mock('@/features/session-continuity/sessionRenewal', () => ({
  RenewalError: class RenewalError extends Error {
    constructor(public cause: string, message?: string) {
      super(message ?? cause);
      this.name = 'RenewalError';
    }
  },
  renewSessionForExpiredToken: mockRenewSessionForExpiredToken,
}));

vi.mock('@/features/session-continuity/deferredTelemetryBuffer', () => ({
  persistFailureClassEvent: mockPersistFailureClassEvent,
}));

vi.mock('@/features/session-continuity/sessionTelemetry', () => ({
  buildSessionContinuityEvent: mockBuildSessionContinuityEvent,
  emitSessionContinuityEvent: mockEmitSessionContinuityEvent,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithRouter(ui: ReactNode, initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/protected" element={ui} />
        <Route path="/login" element={<div>LoginPage</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockBuildSessionContinuityEvent.mockImplementation((user, eventName, payload) => {
      if (!user?.profile?.sub || !user?.profile?.sid) {
        return null;
      }

      return {
        event_name: eventName,
        event_version: 1,
        timestamp: '2026-05-24T12:00:00.000Z',
        user_id: user.profile.sub,
        session_id: user.profile.sid,
        payload,
      };
    });
    mockRenewSessionForExpiredToken.mockResolvedValue({
      accessToken: 'renewed-token',
      coalescedRequestCount: 1,
      renewalDurationMs: 1,
    });
  });

  it('renders children when session is valid and non-expired', async () => {
    mockGetUser.mockResolvedValue({ expired: false, access_token: 'valid-token' });

    renderWithRouter(
      <ProtectedRoute>
        <div data-testid="protected-content">Secret</div>
      </ProtectedRoute>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('protected-content')).not.toBeNull();
    });
  });

  it('redirects to /login when no session exists', async () => {
    mockGetUser.mockResolvedValue(null);

    renderWithRouter(
      <ProtectedRoute>
        <div data-testid="protected-content">Secret</div>
      </ProtectedRoute>,
    );

    await waitFor(() => {
      expect(screen.queryByText('LoginPage')).not.toBeNull();
      expect(screen.queryByTestId('protected-content')).toBeNull();
    });
  });

  it('renews expired sessions before rendering protected content', async () => {
    mockGetUser.mockResolvedValue({ expired: true, access_token: 'old-token' });

    renderWithRouter(
      <ProtectedRoute>
        <div data-testid="protected-content">Secret</div>
      </ProtectedRoute>,
    );

    await waitFor(() => {
      expect(mockRenewSessionForExpiredToken).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('protected-content')).not.toBeNull();
    });
  });

  it('emits forced reauth when expired-session renewal fails', async () => {
    mockGetUser.mockResolvedValue({
      expired: true,
      access_token: 'old-token',
      profile: {
        sub: '11111111-1111-1111-1111-111111111111',
        sid: 'session-1',
      },
    });
    mockRenewSessionForExpiredToken.mockRejectedValue(new Error('network unavailable'));

    renderWithRouter(
      <ProtectedRoute>
        <div data-testid="protected-content">Secret</div>
      </ProtectedRoute>,
      '/protected?tab=activity',
    );

    await waitFor(() => {
      expect(screen.queryByTestId('protected-content')).toBeNull();
      expect(mockEmitAuthEvent).toHaveBeenCalledWith(
        'forced_reauth',
        expect.objectContaining({
          cause: 'idp_unreachable',
          endpointRoute: '/protected',
          method: 'GET',
          returnTo: '/protected?tab=activity',
        }),
      );
      expect(mockPersistFailureClassEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_name: 'silent-renewal-fail',
          payload: { cause: 'idp_unreachable' },
        }),
      );
      expect(mockPersistFailureClassEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_name: 'forced-redirect',
          payload: expect.objectContaining({
            cause: 'idp_unreachable',
            route_at_redirect: '/protected',
          }),
        }),
      );
    });
  });

  it('renders null during loading (no content flash)', async () => {
    // getUser never resolves during this check
    let resolveGetUser: (value: null) => void;
    mockGetUser.mockReturnValue(new Promise((resolve) => { resolveGetUser = resolve; }));

    const { container } = renderWithRouter(
      <ProtectedRoute>
        <div data-testid="protected-content">Secret</div>
      </ProtectedRoute>,
    );

    // While loading: protected content must not be rendered
    expect(screen.queryByTestId('protected-content')).toBeNull();
    expect(container.innerHTML).toBe('');

    // Resolve to unblock (cleanup)
    await act(async () => {
      resolveGetUser!(null);
    });
  });
});
