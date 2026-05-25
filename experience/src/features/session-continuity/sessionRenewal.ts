import { oidcUserManager } from '@/features/auth/oidcUserManager'
import {
  buildSessionContinuityEvent,
  emitSessionContinuityEvent,
} from './sessionTelemetry'

export type RenewalFailureCause =
  | 'refresh_revoked'
  | 'refresh_expired'
  | 'idp_unreachable'
  | 'renewal_loop_detected'

export interface RenewalResult {
  accessToken: string
  coalescedRequestCount: number
  renewalDurationMs: number
}

export interface RenewalOptions {
  bypassLoopGuard?: boolean
}

export class RenewalError extends Error {
  constructor(
    public cause: RenewalFailureCause,
    message?: string,
  ) {
    super(message ?? cause)
    this.name = 'RenewalError'
  }
}

const RENEWAL_LOOP_WINDOW_MS = 5_000

let inFlightRenewal: Promise<RenewalResult> | null = null
let inFlightRequestCount = 0
let lastSuccessfulRenewalAt = 0

export function renewSessionForExpiredToken(options: RenewalOptions = {}): Promise<RenewalResult> {
  if (inFlightRenewal) {
    inFlightRequestCount += 1
    return inFlightRenewal
  }

  if (
    !options.bypassLoopGuard &&
    Date.now() - lastSuccessfulRenewalAt < RENEWAL_LOOP_WINDOW_MS
  ) {
    throw new RenewalError(
      'renewal_loop_detected',
      'Token renewal was attempted too soon after a successful renewal.',
    )
  }

  const startedAt = performance.now()
  inFlightRequestCount = 1
  inFlightRenewal = oidcUserManager
    .signinSilent({ silentRequestTimeoutInSeconds: 10 })
    .then((user) => {
      if (!user?.access_token) {
        throw new RenewalError(
          'refresh_expired',
          'Silent renewal did not return an access token.',
        )
      }

      const result: RenewalResult = {
        accessToken: user.access_token,
        coalescedRequestCount: inFlightRequestCount,
        renewalDurationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      }

      lastSuccessfulRenewalAt = Date.now()
      const event = buildSessionContinuityEvent(user, 'silent-renewal-success', {
        coalesced_request_count: result.coalescedRequestCount,
        renewal_duration_ms: result.renewalDurationMs,
      })
      if (event) {
        emitSessionContinuityEvent(event)
      }

      return result
    })
    .catch((error: unknown) => {
      throw mapRenewalError(error)
    })
    .finally(() => {
      inFlightRenewal = null
      inFlightRequestCount = 0
    })

  return inFlightRenewal
}

export function resetRenewalStateForTests(): void {
  inFlightRenewal = null
  inFlightRequestCount = 0
  lastSuccessfulRenewalAt = 0
}

function mapRenewalError(error: unknown): RenewalError {
  if (error instanceof RenewalError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (normalized.includes('revoked')) {
    return new RenewalError('refresh_revoked', message)
  }

  if (
    normalized.includes('invalid_grant') ||
    normalized.includes('login_required') ||
    normalized.includes('expired')
  ) {
    return new RenewalError('refresh_expired', message)
  }

  return new RenewalError('idp_unreachable', message)
}
