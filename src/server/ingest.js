import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getClaims } from './auth.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { IngestSignal } from '../types.js'
 */

/**
 * Maximum NDJSON request body size accepted by the ingest endpoint.
 *
 * The gateway-side batcher (epic C.3) caps batches at 1 MB; we permit a
 * generous 16x headroom so older clients or experimental tooling don't
 * 413 on lightly-larger batches. C.2 introduces explicit backpressure
 * (queue-depth driven 429s) — this byte cap is just a hard upper bound
 * to prevent a single misbehaving client from monopolizing memory.
 */
const MAX_INGEST_BODY_BYTES = 16 * 1024 * 1024

/** Allowed signal kinds on `POST /v1/ingest/:signal`. */
const SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])

/**
 * Defense-in-depth pattern for `gateway_id` taken from `claims.sub` before
 * it's joined into a filesystem path. Operators register gateway IDs at
 * bootstrap time, so a leading character outside `[A-Za-z0-9]` would already
 * be a misconfiguration — but path traversal is too easy to get wrong, and
 * the cost of a strict pattern is zero.
 */
const GATEWAY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Default sink directory when `config.server.sink_dir` is absent.
 *
 * @returns {string}
 */
export function defaultSinkDir() {
  return path.join(os.homedir(), '.hyp', 'collectivus', 'server-data', 'ingested')
}

/**
 * Server-side NDJSON ingest endpoint. Persists each row into a per-gateway,
 * per-signal, per-day JSONL file:
 *
 *     <sink_dir>/<gateway_id>/<signal>/<YYYY-MM-DD>.jsonl
 *
 * Every persisted row gains an `_ingest: { gateway_id, received_at }` tag so
 * downstream consumers (parquet drain, multi-tenant readers) can attribute
 * the row without trusting any client-supplied fields. The gateway_id comes
 * from the JWT claim, never the request body — a JWT for gateway A cannot
 * be used to ship rows tagged as gateway B.
 */
export class Ingest {
  /**
   * @param {{ sinkDir: string, now?: () => number }} opts
   */
  constructor(opts) {
    if (typeof opts?.sinkDir !== 'string' || opts.sinkDir.length === 0) {
      throw new Error('Ingest: sinkDir is required')
    }
    /** @type {string} */
    this.sinkDir = opts.sinkDir
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /**
     * Per-file write chains. Concurrent batches that target the same
     * (gateway, signal, day) file are queued so we never interleave two
     * writes on the same descriptor — POSIX `O_APPEND` is only atomic for
     * writes ≤ PIPE_BUF, and a single batch can be multi-MB. Cross-process
     * concurrency is out of scope: a v0 server is a single process.
     *
     * @type {Map<string, Promise<void>>}
     */
    this.fileChains = new Map()
  }

  /**
   * Handle a `POST /v1/ingest/:signal` request. Caller (the control plane)
   * has already authenticated the request via `createBearerAuth` and stashed
   * the verified claims for `getClaims(req)`.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} signalParam - The path segment after `/v1/ingest/`.
   * @returns {Promise<void>}
   */
  async handleRequest(req, res, signalParam) {
    if (!SIGNALS.has(signalParam)) {
      writeError(res, 404, 'unknown signal')
      return
    }
    /** @type {IngestSignal} */
    const signal = /** @type {IngestSignal} */ (signalParam)

    const claims = getClaims(req)
    if (!claims) {
      // Defense in depth — the control plane only routes here after
      // `authorize()` returns true, so missing claims means a wiring bug.
      writeError(res, 500, 'auth claims missing after authorize')
      return
    }
    const gatewayId = claims.sub
    if (!GATEWAY_ID_PATTERN.test(gatewayId)) {
      // Bootstrap-time validation should have prevented this; treating it
      // as a 500 surfaces the misconfiguration rather than silently
      // accepting a path-traversal attempt as 400-bad-request.
      writeError(res, 500, 'invalid gateway_id in JWT')
      return
    }

    const ct = parseContentType(req.headers['content-type'])
    if (ct !== 'application/x-ndjson' && ct !== 'application/jsonl') {
      writeError(res, 415, 'expected application/x-ndjson or application/jsonl')
      return
    }

    const body = await readNdjsonBody(req, MAX_INGEST_BODY_BYTES)
    if (body.error) {
      writeError(res, body.status, body.error)
      return
    }

    const receivedAtMs = this.now()
    const receivedAt = new Date(receivedAtMs).toISOString()
    // YYYY-MM-DD slice of an ISO-8601 string is unambiguously UTC because
    // `Date.toISOString()` always emits the `Z` suffix.
    const day = receivedAt.slice(0, 10)

    const lines = body.value.split('\n')
    /** @type {string[]} */
    const tagged = []
    let rejectedAtLine = -1
    let rejectError = ''
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip blank lines (including the trailing newline produced by `split`
      // on a body that ends with `\n`). They're idiomatic in NDJSON and not
      // a parse error.
      if (line.length === 0) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch (err) {
        rejectedAtLine = i + 1
        rejectError = err instanceof Error ? err.message : String(err)
        break
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        rejectedAtLine = i + 1
        rejectError = 'row is not a JSON object'
        break
      }
      // Always overwrite any client-supplied `_ingest` field — clients must
      // not be able to forge attribution metadata.
      parsed._ingest = { gateway_id: gatewayId, received_at: receivedAt }
      tagged.push(JSON.stringify(parsed))
    }

    if (tagged.length > 0) {
      try {
        await this.appendBatch({ gatewayId, signal, day, lines: tagged })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        writeError(res, 500, `ingest write failed: ${msg}`)
        return
      }
    }

    if (rejectedAtLine !== -1) {
      writeJson(res, 400, {
        accepted: tagged.length,
        rejected_at_line: rejectedAtLine,
        error: rejectError,
      })
      return
    }

    writeJson(res, 202, { accepted: tagged.length })
  }

  /**
   * Append a batch of pre-validated lines to the on-disk file. Per-file
   * serialization keeps concurrent batches for the same target file from
   * interleaving at the syscall level.
   *
   * @param {{ gatewayId: string, signal: string, day: string, lines: string[] }} args
   * @returns {Promise<void>}
   */
  async appendBatch(args) {
    const { gatewayId, signal, day, lines } = args
    const dir = path.join(this.sinkDir, gatewayId, signal)
    const file = path.join(dir, `${day}.jsonl`)

    const previous = this.fileChains.get(file) ?? Promise.resolve()
    const next = previous.then(() => writeOnce(dir, file, lines))
    // Park a swallowed copy on the chain so the next caller can `then` off
    // it without inheriting our rejection. The original `next` still rejects
    // for our caller via the `await` below.
    this.fileChains.set(file, next.catch(() => {}))
    await next
  }
}

/**
 * Open the target file with `O_APPEND`, write the joined batch in a single
 * `write()`, fsync, then close. Per-batch fsync trades throughput for
 * crash-safety: rows acknowledged with 202 are durable.
 *
 * @param {string} dir
 * @param {string} file
 * @param {string[]} lines
 * @returns {Promise<void>}
 */
async function writeOnce(dir, file, lines) {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const handle = await fs.promises.open(file, 'a', 0o600)
  try {
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8')
    await handle.write(buf)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Read the full request body into a UTF-8 string up to `maxBytes`. Returns
 * a discriminated `{ value, error }` shape so callers map errors to status
 * codes without try/catch flow.
 *
 * Body-size enforcement is two-layered, mirroring the identity endpoint:
 * an explicit `Content-Length` over the limit short-circuits before reading,
 * and chunked uploads are bounded as bytes accumulate.
 *
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ value: string, status: 200, error?: undefined } | { value?: undefined, status: 400 | 413, error: string }>}
 */
function readNdjsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    const contentLength = parseContentLength(req.headers['content-length'])
    if (contentLength !== undefined && contentLength > maxBytes) {
      resolve({ status: 413, error: 'request body too large' })
      return
    }
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let overflowed = false
    let resolved = false
    /** @param {{ status: 200, value: string } | { status: 400 | 413, error: string }} v */
    function done(v) {
      if (resolved) return
      resolved = true
      resolve(v)
    }
    req.on('data', (chunk) => {
      if (overflowed) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (overflowed) {
        done({ status: 413, error: 'request body too large' })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        done({ status: 400, error: 'empty request body' })
        return
      }
      done({ status: 200, value: raw })
    })
    req.on('error', (err) => {
      done({ status: 400, error: `request error: ${err.message}` })
    })
  })
}

/**
 * @param {string | string[] | undefined} value
 * @returns {number | undefined}
 */
function parseContentLength(value) {
  if (typeof value !== 'string') return undefined
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 0 || String(n) !== value.trim()) return undefined
  return n
}

/**
 * Strip parameters and lowercase the media type from a `Content-Type`
 * header. Returns the empty string when the header is missing.
 *
 * @param {string | string[] | undefined} value
 * @returns {string}
 */
function parseContentType(value) {
  if (typeof value !== 'string') return ''
  const semi = value.indexOf(';')
  const head = semi === -1 ? value : value.slice(0, semi)
  return head.trim().toLowerCase()
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function writeError(res, status, message) {
  writeJson(res, status, { error: message })
}
