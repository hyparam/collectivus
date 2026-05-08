import http from 'node:http'
import { readPackageVersion } from '../cli/common.js'
import { createBearerAuth } from './auth.js'

/**
 * @import { Server, IncomingMessage, ServerResponse } from 'node:http'
 * @import { ServerConfig } from '../types.js'
 */

/**
 * Server-mode control-plane HTTP listener. Mounts the v0 identity endpoints
 * (`/v1/identity/bootstrap`, `/v1/identity/refresh`) plus a no-auth `/health`
 * probe. Future epics (B config vending, C log ingest) will mount additional
 * endpoints on this same listener — keep new routes inside `handleRequest`
 * rather than spawning another HTTP server.
 *
 * Identity endpoint bodies are placeholders in A.2 — they return 501 so
 * clients see "wired but not implemented" rather than 404. A.3 fills them in.
 */
export class ControlPlane {
  /** @param {ServerConfig} config */
  constructor(config) {
    /** @type {ServerConfig} */
    this.config = config
    const { host, port } = parseListen(config.control_plane_listen)
    /** @type {string} */
    this.host = host
    /** @type {number} */
    this.port = port
    /** @type {Server | undefined} */
    this.server = undefined
    /** @type {(req: IncomingMessage, res: ServerResponse) => boolean} */
    this.authorize = createBearerAuth(config.identity_issuer)
  }

  /**
   * Bind the control-plane listener. Rejects with the bind error (e.g.
   * EADDRINUSE) rather than emitting an unhandled `error` event, so the CLI
   * can fail fast instead of hanging on `await start()`.
   *
   * @returns {Promise<void>}
   */
  start() {
    const server = http.createServer((req, res) => this.handleRequest(req, res))
    this.server = server
    return new Promise((resolve, reject) => {
      /** @param {Error} err */
      function onError(err) {
        server.off('listening', onListening)
        reject(err)
      }
      function onListening() {
        server.off('error', onError)
        resolve(undefined)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, this.host)
    })
  }

  /**
   * Close the control-plane listener.
   *
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      const { server } = this
      if (!server) {
        resolve(undefined)
        return
      }
      server.close((err) => {
        if (err) reject(err)
        else {
          this.server = undefined
          resolve(undefined)
        }
      })
    })
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? ''

    if (path === '/health') {
      if (method !== 'GET') return writeError(res, 405, 'method not allowed')
      writeJson(res, 200, { status: 'ok', version: readPackageVersion() })
      return
    }

    if (path === '/v1/identity/bootstrap') {
      if (method !== 'POST') return writeError(res, 405, 'method not allowed')
      // No auth: the bootstrap token in the body IS the credential. A.3 implements.
      writeJson(res, 501, { error: 'not implemented', endpoint: 'bootstrap' })
      return
    }

    if (path === '/v1/identity/refresh') {
      if (method !== 'POST') return writeError(res, 405, 'method not allowed')
      if (!this.authorize(req, res)) return
      // A.3 implements.
      writeJson(res, 501, { error: 'not implemented', endpoint: 'refresh' })
      return
    }

    writeError(res, 404, 'not found')
  }
}

/**
 * Parse a `host:port` listen string. Bracketed IPv6 addresses are unwrapped.
 * Mirrors the validator in `src/config.js#assertHostPort` so the runtime check
 * never disagrees with the schema check.
 *
 * @param {string} value
 * @returns {{ host: string, port: number }}
 */
function parseListen(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid listen address: ${value}`)
  }
  let host = ''
  let portStr = ''
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(1, close)
    if (value[close + 1] !== ':') throw new Error(`invalid listen address: ${value}`)
    portStr = value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon <= 0) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(0, colon)
    portStr = value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in listen address: ${value}`)
  }
  return { host, port }
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
