/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { IdentityIssuerConfig } from '../types.js'
 */

/**
 * Build a Bearer-token middleware for the server-mode control plane.
 *
 * v0 placeholder: rejects requests that lack an `Authorization: Bearer <token>`
 * header but does NOT verify the token. A.3 replaces the body of this function
 * with HMAC JWT verification — wiring stays identical so swapping is a single
 * file change.
 *
 * Returns a function that runs once per request. When the request is
 * authorized, it returns true and the caller proceeds. When denied, the
 * middleware writes a 401 JSON response itself and returns false; the caller
 * must NOT touch the response on a `false` return.
 *
 * @param {IdentityIssuerConfig} issuer
 *   Accepted now so callers don't need to change shape later — A.3 will read
 *   `secret` to verify HS256 signatures. Validated for presence here as a
 *   layered defense against a misconfigured caller (the schema validator
 *   already requires a 32-char minimum at config-load time).
 * @returns {(req: IncomingMessage, res: ServerResponse) => boolean}
 */
export function createBearerAuth(issuer) {
  if (typeof issuer?.secret !== 'string' || issuer.secret.length === 0) {
    throw new Error('createBearerAuth: identity_issuer.secret is required')
  }
  return function authorize(req, res) {
    const header = req.headers['authorization']
    if (typeof header !== 'string') {
      writeUnauthorized(res, 'missing Authorization header')
      return false
    }
    if (!/^bearer\s+/i.test(header)) {
      writeUnauthorized(res, 'expected "Authorization: Bearer <token>"')
      return false
    }
    const token = header.replace(/^bearer\s+/i, '').trim()
    if (token.length === 0) {
      writeUnauthorized(res, 'empty bearer token')
      return false
    }
    // Placeholder: A.3 verifies the JWT here. Until then any non-empty
    // bearer is provisionally accepted so route wiring is testable.
    return true
  }
}

/**
 * @param {ServerResponse} res
 * @param {string} reason
 */
function writeUnauthorized(res, reason) {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'unauthorized', reason }))
}
