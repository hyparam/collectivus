/**
 * @import { NormalizerFn, SessionContext } from './types.d.ts'
 */

/**
 * Pluggable provider → normalizer registry. Bead 1 ships stubs for `claude`,
 * `codex`, and the unknown-provider passthrough so the rest of the source can
 * be exercised end-to-end; beads 2 and 4 swap the stubs for the real
 * normalizers via `register('claude', claudeNormalize)` etc.
 *
 * The dispatcher is intentionally small: lookup-by-provider, call the
 * registered fn (or fall through to passthrough), and never throw. A normalizer
 * raising on a single frame is logged and the next frame is processed — one
 * malformed payload must not stop the stream.
 */
export class NormalizerDispatcher {
  /**
   * @param {{ stderr?: { write: (s: string) => void } }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Map<string, NormalizerFn>} */
    this.registry = new Map()
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr
    /** @type {NormalizerFn} */
    this.passthrough = passthroughStub
    this.register('claude', claudeStub)
    this.register('codex', codexStub)
  }

  /**
   * Register or replace a normalizer for `provider`. The registered function
   * is invoked with the raw frame plus a per-session context object.
   *
   * @param {string} provider
   * @param {NormalizerFn} fn
   * @returns {void}
   */
  register(provider, fn) {
    this.registry.set(provider, fn)
  }

  /**
   * Resolve `provider` from the frame envelope and dispatch. The supervisor's
   * `format=raw` envelope wraps each provider frame in `{ provider, frame }`
   * (or similar); we look at common positions and fall through to passthrough
   * when the provider can't be determined. Any normalizer error is caught and
   * logged so a single bad frame never derails the worker loop.
   *
   * @param {unknown} envelope The full frame envelope as parsed from the SSE `data:` field.
   * @param {SessionContext} ctx
   * @returns {void}
   */
  dispatch(envelope, ctx) {
    const provider = resolveProvider(envelope) ?? 'unknown'
    const fn = this.registry.get(provider) ?? this.passthrough
    try {
      fn(envelope, ctx)
    } catch (err) {
      this.stderr.write(
        `[gascity] normalizer error provider=${provider} session=${ctx.sessionId} err=${formatError(err)}\n`
      )
    }
  }
}

/**
 * Pull the provider tag off a frame envelope. The supervisor's `format=raw`
 * stream nests the actual provider frame; we look at the most common
 * positions before giving up. Returns `undefined` so the caller can fall
 * through to passthrough.
 *
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
export function resolveProvider(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  if (typeof obj.provider === 'string') return obj.provider
  if (obj.response && typeof obj.response === 'object') {
    const resp = /** @type {Record<string, unknown>} */ (obj.response)
    if (typeof resp.provider === 'string') return resp.provider
  }
  if (obj.frame && typeof obj.frame === 'object') {
    const frame = /** @type {Record<string, unknown>} */ (obj.frame)
    if (typeof frame.provider === 'string') return frame.provider
  }
  return undefined
}

/**
 * Bead-2 stub: until `register('claude', ...)` is called, log the dispatch
 * but produce no output. The stub signature is the same as the real
 * normalizer so swapping it in later doesn't change call sites.
 *
 * @type {NormalizerFn}
 */
function claudeStub() {
  // Intentional no-op; real implementation lands in bead 2.
}

/**
 * Bead-4 stub. See `claudeStub`.
 *
 * @type {NormalizerFn}
 */
function codexStub() {
  // Intentional no-op; real implementation lands in bead 4.
}

/**
 * Default passthrough used when the provider is not registered. Bead 3 will
 * replace this with one that emits a single `raw_frame` row so unknown
 * providers still land in `gascity_messages`.
 *
 * @type {NormalizerFn}
 */
function passthroughStub() {
  // Intentional no-op; real passthrough lands with the parquet writer (bead 3).
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
