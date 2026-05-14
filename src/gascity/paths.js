import os from 'node:os'
import path from 'node:path'

/**
 * Default sink root for gascity-source recordings. Matches the layout the
 * epic spec calls out: `~/.collectivus/sink/gascity_messages/`.
 *
 * @returns {string}
 */
export function defaultGascityRoot() {
  return path.join(os.homedir(), '.collectivus', 'sink', 'gascity_messages')
}

/**
 * Directory holding lifecycle and per-session cursors for one city.
 *
 * @param {string} root Sink root from `defaultGascityRoot` or an override.
 * @param {string} city Configured city name.
 * @returns {string}
 */
export function cursorsDir(root, city) {
  return path.join(root, '.cursors', city)
}

/**
 * Path to the lifecycle cursor JSON for a city. The file may not exist yet —
 * callers treat ENOENT as "no resume id".
 *
 * @param {string} root
 * @param {string} city
 * @returns {string}
 */
export function lifecycleCursorPath(root, city) {
  return path.join(cursorsDir(root, city), 'lifecycle.json')
}

/**
 * Path to a per-session cursor JSON.
 *
 * @param {string} root
 * @param {string} city
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionCursorPath(root, city, sessionId) {
  return path.join(cursorsDir(root, city), `${sessionId}.json`)
}
