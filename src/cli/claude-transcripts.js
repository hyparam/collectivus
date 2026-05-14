import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

/**
 * @typedef {object} ClaudeContext
 * @property {string | undefined} [cwd]
 * @property {string | undefined} [git_branch]
 * @property {string | undefined} [claude_version]
 */

/**
 * @typedef {ClaudeContext & { timestampMs?: number }} ClaudeContextEntry
 */

/**
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultClaudeProjectsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'projects')
}

/**
 * Build a lookup over Claude Code transcript metadata. The scanner only
 * retains session id, timestamp, cwd, git branch, and Claude version; prompt
 * text, message content, tool output, and snapshots are not kept.
 *
 * @param {{ projectsDir?: string, sessionIds?: Iterable<string> }} [opts]
 * @returns {Promise<(sessionId: string | undefined, timestamp: unknown) => ClaudeContext | undefined>}
 */
export async function loadClaudeContextLookup(opts = {}) {
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir()
  const sessionIds = opts.sessionIds ? new Set(opts.sessionIds) : undefined
  if (sessionIds && sessionIds.size === 0) return emptyLookup
  /** @type {Map<string, ClaudeContextEntry[]>} */
  const bySession = new Map()

  for (const filePath of walkJsonlFiles(projectsDir, sessionIds)) {
    await readTranscriptFile(filePath, bySession)
  }

  for (const entries of bySession.values()) {
    entries.sort((a, b) => (a.timestampMs ?? Number.POSITIVE_INFINITY) - (b.timestampMs ?? Number.POSITIVE_INFINITY))
    compactEntries(entries)
  }

  /**
   * @param {string | undefined} sessionId
   * @param {unknown} timestamp
   * @returns {ClaudeContext | undefined}
   */
  return function lookup(sessionId, timestamp) {
    if (!sessionId) return undefined
    const entries = bySession.get(sessionId)
    if (!entries || entries.length === 0) return undefined
    const entry = nearestEntry(entries, timestampMs(timestamp))
    return entry ? {
      cwd: entry.cwd,
      git_branch: entry.git_branch,
      claude_version: entry.claude_version,
    } : undefined
  }
}

/**
 * Extract Claude Code session ids from recorded proxy exchange rows without
 * retaining request content.
 *
 * @param {Iterable<Record<string, unknown>>} exchanges
 * @returns {Set<string>}
 */
export function sessionIdsFromExchanges(exchanges) {
  /** @type {Set<string>} */
  const out = new Set()
  for (const exchange of exchanges) {
    const reqBody = parseMaybeJson(readPath(exchange, ['request', 'body']))
    if (reqBody && typeof reqBody === 'object') {
      const sessionId = readMetadataSessionId(/** @type {Record<string, unknown>} */ (reqBody))
      if (sessionId) out.add(sessionId)
    }
    const headerSession = readHeader(exchange, 'x-claude-code-session-id')
    if (headerSession) out.add(headerSession)
  }
  return out
}

/**
 * @param {string} dir
 * @param {Set<string> | undefined} sessionIds
 * @returns {Generator<string>}
 */
function* walkJsonlFiles(dir, sessionIds) {
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(filePath, sessionIds)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (sessionIds && !sessionIds.has(entry.name.slice(0, -'.jsonl'.length))) continue
      yield filePath
    }
  }
}

/**
 * @param {string} filePath
 * @param {Map<string, ClaudeContextEntry[]>} bySession
 * @returns {Promise<void>}
 */
async function readTranscriptFile(filePath, bySession) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  stream.on('error', () => {})
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const entry = contextEntryFromRow(row)
      if (!entry) continue
      let entries = bySession.get(entry.sessionId)
      if (!entries) {
        entries = []
        bySession.set(entry.sessionId, entries)
      }
      entries.push(entry)
    }
  } catch {
    // A transcript file can be rotated or truncated while we scan it. Treat
    // that as a missing enrichment source rather than failing export/query.
  }
}

/**
 * @param {unknown} row
 * @returns {(ClaudeContextEntry & { sessionId: string }) | undefined}
 */
function contextEntryFromRow(row) {
  if (!row || typeof row !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (row)
  const sessionId = stringValue(obj.sessionId)
  if (!sessionId) return undefined
  const cwd = stringValue(obj.cwd)
  const git_branch = stringValue(obj.gitBranch) ?? stringValue(obj.git_branch)
  const claude_version = stringValue(obj.version) ?? stringValue(obj.claude_version)
  if (!cwd && !git_branch && !claude_version) return undefined
  return {
    sessionId,
    timestampMs: timestampMs(obj.timestamp),
    cwd,
    git_branch,
    claude_version,
  }
}

/**
 * @param {ClaudeContextEntry[]} entries
 * @returns {void}
 */
function compactEntries(entries) {
  let write = 0
  /** @type {ClaudeContextEntry | undefined} */
  let last
  for (const entry of entries) {
    if (last && sameContext(last, entry)) continue
    entries[write++] = entry
    last = entry
  }
  entries.length = write
}

/**
 * @param {ClaudeContextEntry} a
 * @param {ClaudeContextEntry} b
 * @returns {boolean}
 */
function sameContext(a, b) {
  return a.cwd === b.cwd &&
    a.git_branch === b.git_branch &&
    a.claude_version === b.claude_version
}

/**
 * @param {ClaudeContextEntry[]} entries
 * @param {number | undefined} targetMs
 * @returns {ClaudeContextEntry | undefined}
 */
function nearestEntry(entries, targetMs) {
  if (entries.length === 0) return undefined
  if (targetMs === undefined) return entries[entries.length - 1]

  let lo = 0
  let hi = entries.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const midMs = entries[mid].timestampMs ?? Number.POSITIVE_INFINITY
    if (midMs < targetMs) lo = mid + 1
    else hi = mid
  }

  const after = entries[lo]
  const before = lo > 0 ? entries[lo - 1] : undefined
  if (!before) return after
  if (!after) return before
  const beforeDistance = Math.abs((before.timestampMs ?? targetMs) - targetMs)
  const afterDistance = Math.abs((after.timestampMs ?? targetMs) - targetMs)
  return beforeDistance <= afterDistance ? before : after
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} reqBody
 * @returns {string | undefined}
 */
function readMetadataSessionId(reqBody) {
  const meta = readKey(reqBody, 'metadata')
  if (!meta || typeof meta !== 'object') return undefined
  const userId = /** @type {Record<string, unknown>} */ (meta).user_id
  const parsed = parseMaybeJson(userId)
  if (!parsed || typeof parsed !== 'object') return undefined
  return stringValue(/** @type {Record<string, unknown>} */ (parsed).session_id)
}

/**
 * @param {unknown} exchange
 * @param {string} name
 * @returns {string | undefined}
 */
function readHeader(exchange, name) {
  const headers = readPath(exchange, ['request', 'headers'])
  if (!headers || typeof headers !== 'object') return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/**
 * @param {unknown} obj
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(obj, keys) {
  /** @type {unknown} */
  let cur = obj
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = /** @type {Record<string, unknown>} */ (cur)[key]
  }
  return cur
}

/**
 * @param {unknown} obj
 * @param {string} key
 * @returns {unknown}
 */
function readKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined
  return /** @type {Record<string, unknown>} */ (obj)[key]
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function timestampMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

/**
 * @returns {undefined}
 */
function emptyLookup() {
  return undefined
}
