import { readCursor, writeCursor } from './cursor.js'
import { lifecycleCursorPath } from './paths.js'
import { SessionWorker } from './session_worker.js'
import { streamSse } from './sse_client.js'
import { compileFilter } from './template_filter.js'

/**
 * @import { GascityCityConfig } from './types.d.ts'
 * @import { NormalizerDispatcher } from './normalizer_dispatcher.js'
 * @import { ParquetWriter } from './parquet_writer.js'
 * @import { GascityRuntimeStateWriter } from './runtime_state.js'
 */

const SPAWN_EVENTS = new Set(['session.created', 'session.woke'])
const RETIRE_EVENTS = new Set(['session.draining', 'session.stopped'])

/**
 * One supervisor subscriber per configured city. Holds:
 *
 *   - a single SSE connection to `<api_url>/v0/city/<name>/events/stream`
 *   - a map of active SessionWorkers keyed by `provider_session_id`
 *   - the lifecycle cursor file (`Last-Event-ID` checkpoint for resume)
 *
 * Lifecycle events that name a session matched by include/exclude template
 * filters spawn a worker; retire events stop and forget it. Unknown event
 * types are logged at debug level only — we don't want a future supervisor
 * adding a `session.foo` event to crash existing daemons.
 */
export class SupervisorSubscriber {
  /**
   * @param {{
   *   city: GascityCityConfig,
   *   sinkRoot: string,
   *   dispatcher: NormalizerDispatcher,
   *   writer?: ParquetWriter,
   *   stateWriter?: GascityRuntimeStateWriter,
   *   stderr?: { write: (s: string) => void },
   *   debug?: boolean,
   *   fetchFn?: typeof fetch,
   *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
   * }} opts
   */
  constructor(opts) {
    /** @type {GascityCityConfig} */
    this.city = opts.city
    /** @type {string} */
    this.sinkRoot = opts.sinkRoot
    /** @type {NormalizerDispatcher} */
    this.dispatcher = opts.dispatcher
    /** @type {ParquetWriter | undefined} */
    this.writer = opts.writer
    /** @type {GascityRuntimeStateWriter | undefined} */
    this.stateWriter = opts.stateWriter
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr
    /** @type {boolean} */
    this.debug = opts.debug ?? false
    /** @type {typeof fetch | undefined} */
    this.fetchFn = opts.fetchFn
    /** @type {((ms: number, signal: AbortSignal) => Promise<void>) | undefined} */
    this.sleep = opts.sleep
    /** @type {AbortController} */
    this.controller = new AbortController()
    /** @type {Promise<void> | undefined} */
    this.runPromise = undefined
    /** @type {Map<string, SessionWorker>} */
    this.workers = new Map()
    /** @type {(template: string | undefined) => boolean} */
    this.templateMatches = compileFilter(this.city.include_templates, this.city.exclude_templates)
    /** @type {string} */
    this.apiUrl = this.city.api_url.replace(/\/+$/, '')
  }

  /**
   * Start the lifecycle SSE consumer. Idempotent — subsequent calls return
   * the in-flight promise.
   *
   * @returns {Promise<void>}
   */
  start() {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.run().catch((err) => {
      this.stderr.write(`[gascity] supervisor crashed city=${this.city.name} err=${formatError(err)}\n`)
    })
    return this.runPromise
  }

  /**
   * Stop the lifecycle SSE consumer, signal every active session worker to
   * drain, and wait for them to exit. After `stop` resolves the subscriber
   * holds no live sockets or pending IO.
   *
   * The active workers' `stop()` retires their session in the writer, which
   * keeps the daemon-shutdown semantics aligned with the bead-3 contract:
   * a clean stop flushes pending buffers and stamps `retired=true` on the
   * cursor. (A subsequent restart picks up state via the lifecycle SSE
   * resume + backfill of any non-retired sessions still on disk.)
   *
   * @param {{ removeFromState?: boolean }} [opts]
   *   `removeFromState=true` (used by hot-reload city removal) drops this
   *   city's entry from the runtime-state snapshot after retirement so
   *   `ctvs gascity list` doesn't continue to show a no-longer-attached
   *   city. Daemon shutdown leaves the entry in place — the snapshot file
   *   is overwritten / cleaned up by the next daemon start.
   * @returns {Promise<void>}
   */
  async stop(opts = {}) {
    this.controller.abort()
    /** @type {Promise<void>[]} */
    const stops = []
    /** @type {string[]} */
    const sessionsRetired = []
    for (const [sessionId, worker] of this.workers) {
      sessionsRetired.push(sessionId)
      stops.push(worker.stop())
    }
    this.workers.clear()
    if (this.runPromise) await this.runPromise
    await Promise.all(stops)
    if (this.stateWriter !== undefined) {
      for (const sessionId of sessionsRetired) {
        this.stateWriter.retireSession(this.city.name, sessionId)
      }
      if (opts.removeFromState === true) {
        this.stateWriter.removeCity(this.city.name)
      } else {
        this.stateWriter.setLifecycleConnected(this.city.name, false)
      }
      // Make sure the snapshot reflects the retired sessions before any
      // CLI reader picks up the next file mtime.
      try {
        await this.stateWriter.flush()
      } catch (err) {
        this.stderr.write(
          `[gascity] state_flush_failed city=${this.city.name} err=${formatError(err)}\n`
        )
      }
    }
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async run() {
    const cursorPath = lifecycleCursorPath(this.sinkRoot, this.city.name)
    const cursor = await readCursor(cursorPath, { onError: (m) => this.stderr.write(`${m}\n`) })
    const initialId = typeof cursor?.last_event_id === 'string' ? cursor.last_event_id : undefined
    const url = `${this.apiUrl}/v0/city/${encodeURIComponent(this.city.name)}/events/stream`
    if (this.debug) {
      this.stderr.write(`[gascity] supervisor_start city=${this.city.name} url=${url}\n`)
    }
    if (this.stateWriter !== undefined) {
      this.stateWriter.upsertCity({ name: this.city.name, api_url: this.apiUrl })
    }
    /** @type {Parameters<typeof streamSse>[0]} */
    const streamOpts = {
      url,
      signal: this.controller.signal,
      onEvent: async (ev) => this.handleLifecycleEvent(ev, cursorPath),
      onError: (msg) => {
        this.stderr.write(`${msg}\n`)
        if (this.stateWriter !== undefined) {
          this.stateWriter.setLifecycleConnected(this.city.name, false)
        }
      },
      onConnect: () => {
        if (this.debug) {
          this.stderr.write(`[gascity] supervisor_connected city=${this.city.name}\n`)
        }
        if (this.stateWriter !== undefined) {
          this.stateWriter.setLifecycleConnected(this.city.name, true)
        }
      },
      initialLastEventId: initialId,
    }
    if (this.fetchFn) streamOpts.fetchFn = this.fetchFn
    if (this.sleep) streamOpts.sleep = this.sleep
    await streamSse(streamOpts)
    if (this.stateWriter !== undefined) {
      this.stateWriter.setLifecycleConnected(this.city.name, false)
    }
    if (this.debug) {
      this.stderr.write(`[gascity] supervisor_stop city=${this.city.name}\n`)
    }
  }

  /**
   * @param {import('../types.js').SseEvent} ev
   * @param {string} cursorPath
   * @returns {Promise<void>}
   * @private
   */
  async handleLifecycleEvent(ev, cursorPath) {
    if (ev.event === 'ping' || ev.event === 'heartbeat') return
    if (this.debug) {
      this.stderr.write(
        `[gascity] lifecycle_event_received city=${this.city.name} event=${ev.event} id=${ev.id ?? '<none>'}\n`
      )
    }
    /** @type {unknown} */
    let payload = {}
    if (ev.data.length > 0) {
      try {
        payload = JSON.parse(ev.data)
      } catch (err) {
        this.stderr.write(
          `[gascity] lifecycle_parse_error city=${this.city.name} event=${ev.event} err=${formatError(err)}\n`
        )
        return
      }
    }
    if (ev.id !== undefined) {
      try {
        await writeCursor(cursorPath, { last_event_id: ev.id })
      } catch (err) {
        this.stderr.write(`[gascity] lifecycle_cursor_write_failed city=${this.city.name} err=${formatError(err)}\n`)
      }
    }
    const sessionId = pickString(payload, 'session_id') ?? pickString(payload, 'sessionId')
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (SPAWN_EVENTS.has(ev.event)) {
      const template = pickString(payload, 'template')
      if (!this.templateMatches(template)) {
        if (this.debug) {
          this.stderr.write(
            `[gascity] session_filtered city=${this.city.name} session=${sessionId} template=${template ?? '<none>'}\n`
          )
        }
        return
      }
      this.spawnWorker(sessionId, payload)
    } else if (RETIRE_EVENTS.has(ev.event)) {
      await this.retireWorker(sessionId)
    }
  }

  /**
   * @param {string} sessionId
   * @param {unknown} payload
   * @returns {void}
   * @private
   */
  spawnWorker(sessionId, payload) {
    if (this.workers.has(sessionId)) return
    const template = pickString(payload, 'template')
    const rig = pickString(payload, 'rig')
    const alias = pickString(payload, 'alias')
    /** @type {ConstructorParameters<typeof SessionWorker>[0]} */
    const workerOpts = {
      city: this.city.name,
      apiUrl: this.apiUrl,
      sessionId,
      sinkRoot: this.sinkRoot,
      dispatcher: this.dispatcher,
      stderr: this.stderr,
      debug: this.debug,
    }
    if (this.writer) workerOpts.writer = this.writer
    if (this.stateWriter) workerOpts.stateWriter = this.stateWriter
    if (template !== undefined) workerOpts.template = template
    if (rig !== undefined) workerOpts.rig = rig
    if (alias !== undefined) workerOpts.alias = alias
    if (this.fetchFn) workerOpts.fetchFn = this.fetchFn
    if (this.sleep) workerOpts.sleep = this.sleep
    const worker = new SessionWorker(workerOpts)
    this.workers.set(sessionId, worker)
    if (this.stateWriter !== undefined) {
      /** @type {Parameters<GascityRuntimeStateWriter['upsertSession']>[1]} */
      const info = { sessionId }
      if (template !== undefined) info.template = template
      if (rig !== undefined) info.rig = rig
      if (alias !== undefined) info.alias = alias
      this.stateWriter.upsertSession(this.city.name, info)
    }
    if (this.debug) {
      this.stderr.write(
        `[gascity] session_worker_spawned city=${this.city.name} session=${sessionId} template=${template ?? '<none>'}\n`
      )
    }
    worker.start()
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   * @private
   */
  async retireWorker(sessionId) {
    const worker = this.workers.get(sessionId)
    if (!worker) return
    this.workers.delete(sessionId)
    if (this.stateWriter !== undefined) {
      this.stateWriter.retireSession(this.city.name, sessionId)
    }
    if (this.debug) {
      this.stderr.write(`[gascity] session_worker_retired city=${this.city.name} session=${sessionId}\n`)
    }
    await worker.stop()
  }
}

/**
 * @param {unknown} obj
 * @param {string} key
 * @returns {string | undefined}
 */
function pickString(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined
  const value = /** @type {Record<string, unknown>} */ (obj)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
