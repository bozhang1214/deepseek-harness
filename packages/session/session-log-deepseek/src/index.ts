/**
 * Incremental session-log contribution for official DeepSeek LLM API requests.
 * Accepted sequence watermarks live in the canonical log, so restart recovery
 * can conservatively resend uncertain tails without maintaining another store.
 * @module @deepseek-ai/dsh-session-log-deepseek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeq as SessionSeqType,
  SessionSeqCursor,
  SurfaceOp,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  DeepSeekSessionLogExtension,
  DeepSeekSessionLogWireEvent,
  DeepSeekSessionLogWireHeader,
  DeepSeekSessionLogWireSurfaceOp,
} from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-log-deepseek'
/** Services required to resolve sessions and contribute the provider request field. */
export const inject = ['deepseekLlmApiExtensions', 'sessions']

/**
 * Default ceiling on the summed serialized size of the `events` members one
 * request contributes.
 *
 * Without a ceiling the first upload of a long-lived Session carries its entire
 * backlog in one body. A Session whose log grows past the provider's request
 * limit is then rejected with HTTP 413, and because a rejected request records
 * no watermark, every later attempt resends the same oversized body: the
 * Session can never be uploaded again. Bounding each request to a prefix turns
 * that dead end into a backlog that drains over successive requests.
 */
export const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024

/** Session-log request contribution configuration. */
export interface Config {
  /** Contribute `dsh_session_log` to official DeepSeek requests. Defaults to `true`. */
  enabled?: boolean
  /**
   * Inclusive ceiling on the summed serialized size of one request's `events`
   * members, excluding the array's own punctuation. A larger pending suffix
   * drains over successive requests, one bounded prefix per accepted request.
   * @default DEFAULT_MAX_BATCH_BYTES
   */
  maxBatchBytes?: number
}

/** Validated Session-log request contribution configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxBatchBytes: z.number().step(1).min(1).default(DEFAULT_MAX_BATCH_BYTES),
})

interface AcceptanceFold {
  readonly scannedEvents: SessionLogOffsetType
  readonly throughSeq: SessionSeqCursor
}

const acceptanceFolds = new WeakMap<Session, AcceptanceFold>()

/** Translate logical Session metadata to raw external request fields. */
function wireHeader(session: Session): DeepSeekSessionLogWireHeader {
  const header = session.header
  return {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) },
    ...header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {},
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth },
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
  }
}

/** Translate compile-time sequence brands to raw numeric request fields. */
function wireEvent(event: SessionEvent): DeepSeekSessionLogWireEvent {
  const common = {
    seq: Number(event.seq),
    time: event.time,
    data: event.data as JsonValue,
    ...event.ignorable === undefined ? {} : { ignorable: event.ignorable },
  }
  switch (event.type) {
    case 'system/message':
    case 'user/message':
    case 'tool/result':
      return {
        ...common,
        type: event.type,
        surfaceOp: wireSurfaceOp(event.surfaceOp),
        ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs.map(Number) },
      }
    case 'assistant/message':
      return { ...common, type: event.type, surfaceOp: wireSurfaceOp(event.surfaceOp) }
    default: {
      // Restored unknown ignorable records are opaque, not current surface events.
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) {
        const opaque = event as { surfaceOp?: JsonValue; sourceEventSeqs?: JsonValue }
        return {
          ...common, type: event.type, ignorable: true,
          ...opaque.surfaceOp === undefined ? {} : { surfaceOp: opaque.surfaceOp },
          ...opaque.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opaque.sourceEventSeqs },
        }
      }
      return { ...common, type: event.type }
    }
  }
}

function wireSurfaceOp(op: SurfaceOp): DeepSeekSessionLogWireSurfaceOp {
  return op === 'append'
    ? op
    : { op: 'replace', startSeq: Number(op.startSeq), endSeq: Number(op.endSeq) }
}

/**
 * Oldest-first prefix of `events` whose serialized form stays within `maxBytes`.
 *
 * A prefix is what keeps the upload lossless: the watermark advances to the
 * batch's last sequence and the next request resumes at the one after it, so
 * nothing is skipped and every admitted sequence is eventually accepted.
 *
 * The first event is always admitted, even alone above the ceiling. Progress
 * outranks the ceiling here: refusing an oversized record would freeze the
 * watermark below it and strand every event behind it forever.
 * @param events - wired events of the pending suffix, oldest first.
 * @param maxBytes - inclusive serialized-byte ceiling for the returned prefix.
 * @returns the admitted prefix; empty only when `events` is empty.
 */
function takeBatch(
  events: readonly DeepSeekSessionLogWireEvent[],
  maxBytes: number,
): readonly DeepSeekSessionLogWireEvent[] {
  const batch: DeepSeekSessionLogWireEvent[] = []
  let bytes = 0
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (batch.length > 0 && bytes + size > maxBytes) break
    batch.push(event)
    bytes += size
  }
  return batch
}

/**
 * Highest confirmed sequence for this exact Session format generation.
 * @param session - canonical log whose matching acceptance events are folded.
 * @returns greatest accepted sequence, or `-1` before any accepted request.
 */
export function acceptedThrough(session: Session): SessionSeqCursor {
  const previous = acceptanceFolds.get(session)
  let throughSeq = previous?.throughSeq ?? -1
  const length = session.seq
  const start = previous?.scannedEvents ?? SessionLogOffset(0)
  for (let index = start; index < length; index++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`session-log-deepseek: missing event ${String(index)} below captured length ${String(length)}`)
    }
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    const acceptedFormatVersion = event.data.sessionFormatVersion ?? 0
    if (!Number.isSafeInteger(acceptedFormatVersion)
      || acceptedFormatVersion < 0
      || Object.is(acceptedFormatVersion, -0)) {
      throw new Error(`session-log-deepseek: malformed acceptance format version at seq ${event.seq}`)
    }
    if (acceptedFormatVersion !== session.header.version) continue
    let acceptedSeq: SessionSeqType
    try {
      acceptedSeq = SessionSeq(event.data.throughSeq)
    } catch {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (typeof event.data.sessionId !== 'string' || event.data.sessionId.length === 0
      || acceptedSeq >= event.seq) {
      throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`)
    }
    if (event.data.sessionId !== session.id) continue
    if (acceptedSeq > throughSeq) throughSeq = acceptedSeq
  }
  acceptanceFolds.set(session, { scannedEvents: length, throughSeq })
  return throughSeq
}

/**
 * Register the incremental `dsh_session_log` request contribution when enabled.
 * @param ctx - plugin context carrying Sessions and the DeepSeek request-extension registry.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled !== true) return
  ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
    prepare: (request) => {
      // TODO: Define an explicit wire result for direct or stale-session calls if they become a supported product path.
      if (request.sessionId === undefined) return undefined
      const session = ctx.sessions.get(brandString<SessionId>(request.sessionId))
      if (session === undefined) return undefined

      const afterSeq = acceptedThrough(session)
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const snapshot = session.snapshotEvents()
      const tailSeq = snapshot.at(-1)?.seq
      if (tailSeq === undefined) return undefined
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const suffix = session.snapshotEvents(SessionLogOffset(afterSeq + 1))
      const events = takeBatch(suffix.map(wireEvent), config.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES)
      // `throughSeq` must name the last sequence this request actually carries —
      // never the log tail — or the remainder between the batch and the tail
      // would be recorded as accepted without ever being uploaded. An empty
      // suffix keeps the watermarked tail, preserving the field's drained shape.
      const throughSeq = events.at(-1)?.seq ?? Number(tailSeq)
      const value: DeepSeekSessionLogExtension = {
        version: 1,
        sessionFormatVersion: session.header.version,
        session: wireHeader(session),
        afterSeq: Number(afterSeq),
        throughSeq,
        events,
      }
      return {
        value,
        accept: () => {
          session.append('session-log-deepseek/delivery-accepted', {
            sessionId: session.id,
            sessionFormatVersion: session.header.version,
            throughSeq: SessionSeq(throughSeq),
          })
          // TODO: Add an immediate lightweight checkpoint if duplicate replay after a 2xx crash window becomes unacceptable.
        },
      }
    },
  })
}
