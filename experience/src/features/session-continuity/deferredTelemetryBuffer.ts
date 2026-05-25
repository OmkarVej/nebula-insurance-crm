import {
  emitSessionContinuityEvent,
  flushSessionContinuityEvents,
  type SessionContinuityEvent,
} from './sessionTelemetry'

export const DEFERRED_TELEMETRY_PREFIX = 'nebula.telemetry-defer.v1'
export const DEFERRED_TELEMETRY_TTL_MS = 604_800_000
export const DEFERRED_TELEMETRY_MAX_EVENTS_PER_USER = 100

export function persistFailureClassEvent(
  event: SessionContinuityEvent,
): void {
  const storage = safeLocalStorage()
  if (!storage) {
    return
  }

  try {
    evictOldestIfNeeded(storage, event.user_id)
    storage.setItem(
      buildDeferredKey(event.user_id, createEventId()),
      JSON.stringify(event),
    )
  } catch {
    // Telemetry durability is best-effort and must never alter auth flow.
  }
}

export function removeDeferredEvent(userId: string, eventId: string): void {
  safeLocalStorage()?.removeItem(buildDeferredKey(userId, eventId))
}

export async function drainDeferredEvents(userId: string): Promise<void> {
  const storage = safeLocalStorage()
  if (!storage) {
    return
  }

  const entries = readEntriesForUser(storage, userId)
  for (const entry of entries) {
    emitSessionContinuityEvent(entry.event)
  }

  await flushSessionContinuityEvents()

  for (const entry of entries) {
    storage.removeItem(entry.key)
  }
}

export function clearDeferredEventsForUser(userId: string): void {
  const storage = safeLocalStorage()
  if (!storage) {
    return
  }

  for (const { key } of readEntriesForUser(storage, userId)) {
    storage.removeItem(key)
  }
}

function readEntriesForUser(storage: Storage, userId: string) {
  const prefix = `${DEFERRED_TELEMETRY_PREFIX}.${userId}.`
  const entries: Array<{ key: string; event: SessionContinuityEvent }> = []

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) {
      continue
    }

    const raw = storage.getItem(key)
    if (!raw) {
      continue
    }

    try {
      const event = JSON.parse(raw) as SessionContinuityEvent
      if (isExpired(event)) {
        storage.removeItem(key)
        continue
      }

      entries.push({ key, event })
    } catch {
      storage.removeItem(key)
    }
  }

  return entries
}

function evictOldestIfNeeded(storage: Storage, userId: string): void {
  const entries = readEntriesForUser(storage, userId)
  if (entries.length < DEFERRED_TELEMETRY_MAX_EVENTS_PER_USER) {
    return
  }

  const oldest = entries
    .map((entry) => ({
      ...entry,
      timestamp: Date.parse(entry.event.timestamp),
    }))
    .sort((left, right) => left.timestamp - right.timestamp)[0]

  if (oldest) {
    storage.removeItem(oldest.key)
    console.warn('Nebula.Session.Continuity.TelemetryDrop', {
      dropped_count: 1,
      event_name: oldest.event.event_name,
      timestamp: oldest.event.timestamp,
    })
  }
}

function buildDeferredKey(userId: string, eventId: string): string {
  return `${DEFERRED_TELEMETRY_PREFIX}.${userId}.${eventId}`
}

function isExpired(event: SessionContinuityEvent): boolean {
  const timestamp = Date.parse(event.timestamp)
  return !Number.isFinite(timestamp) || Date.now() - timestamp > DEFERRED_TELEMETRY_TTL_MS
}

function createEventId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
