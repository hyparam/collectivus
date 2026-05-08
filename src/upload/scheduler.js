/**
 * Daily UTC timer. Calls `tick` once at startup (for catch-up), then
 * once per UTC day at the configured HH:MM. The timer chain (not
 * setInterval) prevents drift, and clamps to setTimeout's 32-bit ceiling.
 */

const MAX_TIMEOUT = 2147483647 // ~24.8 days; setTimeout caps at int32 ms

/**
 * @typedef {object} SchedulerDeps
 * @property {() => Date} [now] for tests
 * @property {(handler: () => void, ms: number) => NodeJS.Timeout | number} [setTimeoutFn]
 * @property {(handle: NodeJS.Timeout | number) => void} [clearTimeoutFn]
 */

/**
 * @param {object} options
 * @param {string} options.time "HH:MM" UTC
 * @param {() => Promise<void>} options.tick
 * @param {(err: unknown) => void} [options.onError] called when tick rejects
 * @param {SchedulerDeps} [deps]
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void> }}
 */
export function createScheduler(options, deps = {}) {
  const now = deps.now ?? (() => new Date())
  const setT = deps.setTimeoutFn ?? setTimeout
  const clearT = deps.clearTimeoutFn ?? clearTimeout
  const onError = options.onError ?? defaultOnError

  const [hh, mm] = parseTime(options.time)

  /** @type {NodeJS.Timeout | number | null} */
  let handle = null
  let stopped = false
  /** @type {Promise<void>} */
  let chain = Promise.resolve()

  function schedule() {
    if (stopped) return
    const next = nextFireAt(now(), hh, mm)
    let delay = next.getTime() - now().getTime()
    if (delay < 0) delay = 0
    const capped = Math.min(delay, MAX_TIMEOUT)
    handle = setT(() => {
      handle = null
      if (stopped) return
      // If we capped the delay, just re-schedule without firing the tick.
      if (capped < delay) {
        schedule()
        return
      }
      chain = chain.then(async () => {
        if (stopped) return
        try {
          await options.tick()
        } catch (err) {
          onError(err)
        }
      }).then(() => {
        schedule()
      })
    }, capped)
  }

  return {
    async start() {
      stopped = false
      // Run catch-up immediately, then schedule the next firing.
      chain = chain.then(async () => {
        try {
          await options.tick()
        } catch (err) {
          onError(err)
        }
      })
      await chain
      schedule()
    },
    async stop() {
      stopped = true
      if (handle !== null) {
        clearT(handle)
        handle = null
      }
      await chain
    },
  }
}

/**
 * Parse "HH:MM" into [hours, minutes]. Throws on malformed input.
 *
 * @param {string} time
 * @returns {[number, number]}
 */
export function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) throw new Error(`invalid upload-time "${time}", expected HH:MM`)
  const hh = parseInt(match[1], 10)
  const mm = parseInt(match[2], 10)
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`invalid upload-time "${time}", out of range`)
  }
  return [hh, mm]
}

/**
 * Compute the next UTC fire time strictly after `from`.
 *
 * @param {Date} from
 * @param {number} hh
 * @param {number} mm
 * @returns {Date}
 */
export function nextFireAt(from, hh, mm) {
  const next = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    hh, mm, 0, 0
  ))
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next
}

/**
 * @param {unknown} err
 * @returns {void}
 */
function defaultOnError(err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error(`[collectivus] upload tick failed: ${message}`)
}
