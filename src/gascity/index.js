import { backfillCity } from './backfill.js'
import { NormalizerDispatcher } from './normalizer_dispatcher.js'
import { registerProductionNormalizers } from './normalizers/index.js'
import { ParquetWriter } from './parquet_writer.js'
import { defaultGascityRoot } from './paths.js'
import { SupervisorSubscriber } from './supervisor_subscriber.js'

/**
 * @import { GascityCityConfig } from './types.d.ts'
 * @import { StartedListener } from '../types.js'
 */

/**
 * Stand the gascity source up. Returns a `StartedListener` that fits straight
 * into `runLifecycle`'s registry — `description` for the boot log, `stop` for
 * graceful shutdown that drains every active session worker and flushes the
 * writer.
 *
 * The factory takes the array of configured cities so the daemon can run
 * multiple supervisors concurrently. Each city gets its own
 * `SupervisorSubscriber`; they share the dispatcher and writer (provider
 * normalizers are a process-wide registry and the writer keeps per-session
 * buffers internally).
 *
 * On startup the factory triggers a one-shot backfill per configured city
 * for every non-retired cursor it finds on disk. Backfill failures are
 * logged but never thrown — they must not stop the live SSE tail from
 * coming up.
 *
 * Empty `cities` is a documented no-op: the listener starts cleanly so a
 * config that only enables the gascity section without attaching cities yet
 * still satisfies `factories.size > 0` if the operator has otherwise wired
 * other listeners.
 *
 * @param {{
 *   cities: GascityCityConfig[],
 *   sinkRoot?: string,
 *   stderr?: { write: (s: string) => void },
 *   debug?: boolean,
 *   fetchFn?: typeof fetch,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   flushRows?: number,
 *   flushIntervalMs?: number,
 *   dedupLimit?: number,
 *   skipBackfill?: boolean,
 * }} opts
 * @returns {Promise<StartedListener>}
 */
export async function startGascitySource(opts) {
  const stderr = opts.stderr ?? process.stderr
  const sinkRoot = opts.sinkRoot ?? defaultGascityRoot()
  const debug = opts.debug ?? isDebugEnabled()

  /** @type {ConstructorParameters<typeof ParquetWriter>[0]} */
  const writerOpts = { sinkRoot, stderr }
  if (opts.flushRows !== undefined) writerOpts.flushRows = opts.flushRows
  if (opts.flushIntervalMs !== undefined) writerOpts.flushIntervalMs = opts.flushIntervalMs
  if (opts.dedupLimit !== undefined) writerOpts.dedupLimit = opts.dedupLimit
  const writer = new ParquetWriter(writerOpts)

  const dispatcher = new NormalizerDispatcher({ stderr, writer })
  registerProductionNormalizers(dispatcher)

  /** @type {SupervisorSubscriber[]} */
  const subscribers = []
  for (const city of opts.cities) {
    /** @type {ConstructorParameters<typeof SupervisorSubscriber>[0]} */
    const subOpts = {
      city,
      sinkRoot,
      dispatcher,
      writer,
      stderr,
      debug,
    }
    if (opts.fetchFn) subOpts.fetchFn = opts.fetchFn
    if (opts.sleep) subOpts.sleep = opts.sleep
    const subscriber = new SupervisorSubscriber(subOpts)
    subscriber.start()
    subscribers.push(subscriber)
  }

  if (!opts.skipBackfill) {
    for (const city of opts.cities) {
      /** @type {Parameters<typeof backfillCity>[0]} */
      const backfillOpts = {
        city,
        sinkRoot,
        dispatcher,
        stderr,
        debug,
      }
      if (opts.fetchFn) backfillOpts.fetchFn = opts.fetchFn
      // Run each city's backfill in the background so live SSE tails come up
      // immediately. Failures only land on stderr — they don't reject the
      // factory promise.
      backfillCity(backfillOpts).catch((err) => {
        stderr.write(`[gascity] backfill_unhandled city=${city.name} err=${formatError(err)}\n`)
      })
    }
  }

  const description = opts.cities.length === 0
    ? 'Gascity source: no cities attached'
    : `Gascity source attached to ${opts.cities.length} ${opts.cities.length === 1 ? 'city' : 'cities'} (${opts.cities.map((c) => c.name).join(', ')}); sink ${sinkRoot}`
  return {
    description,
    stop: async () => {
      await Promise.all(subscribers.map((s) => s.stop()))
      await writer.stop()
    },
  }
}

/**
 * Whether `[gascity]` debug log lines should land on stderr. Off by default
 * to keep the daemon's log volume in line with the proxy/OTLP sources;
 * operators flip `COLLECTIVUS_DEBUG_GASCITY=1` when iterating on integration
 * with a new supervisor.
 *
 * @returns {boolean}
 */
function isDebugEnabled() {
  const value = process.env.COLLECTIVUS_DEBUG_GASCITY
  return typeof value === 'string' && value.length > 0 && value !== '0'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
