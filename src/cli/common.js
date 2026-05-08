import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @import { InstalledPlistFields } from '../types.js'
 */

export const LAUNCH_AGENT_LABEL = 'com.hyparam.collectivus'
export const DEFAULT_PLIST_DIR_SEGMENTS = ['Library', 'LaunchAgents']

/**
 * Human-readable description of the daemon artifact for the running platform.
 * Used in install/uninstall success messages so Linux output doesn't claim a
 * "LaunchAgent" was touched when in fact a systemd user unit was.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function daemonKindLabel(platform = process.platform) {
  if (platform === 'linux') return `systemd unit: ${LAUNCH_AGENT_LABEL}.service`
  return `LaunchAgent: ${LAUNCH_AGENT_LABEL}`
}

const here = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_PATH = path.join(here, '..', '..', 'package.json')

/**
 * Read the `version` field from package.json.
 *
 * Used to stamp the `_collectivus.version` marker so detach can compare against
 * the install that wrote it.
 *
 * @returns {string}
 */
export function readPackageVersion() {
  const raw = fs.readFileSync(PACKAGE_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json is missing a string `version` field')
  }
  return parsed.version
}

/**
 * Default directory for daemon log files: `~/.hyp/collectivus`.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string}
 */
export function defaultLogDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus')
}

/**
 * Default LaunchAgent plist path: `~/Library/LaunchAgents/com.hyparam.collectivus.plist`.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string}
 */
export function defaultPlistPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), ...DEFAULT_PLIST_DIR_SEGMENTS, `${LAUNCH_AGENT_LABEL}.plist`)
}

/**
 * Read an installed LaunchAgent plist and extract the fields that the
 * `status` command surfaces. Returns undefined when the plist file is missing.
 *
 * The plist is the one written by `buildPlist` in `src/daemon/macos.js`, so
 * the structure is predictable. Regex-based extraction is sufficient and
 * keeps us free of an XML parser dependency.
 *
 * @param {string} plistPath
 * @returns {InstalledPlistFields | undefined}
 */
export function readInstalledPlist(plistPath) {
  /** @type {string} */
  let xml
  try {
    xml = fs.readFileSync(plistPath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return undefined
    throw err
  }
  return parsePlistFields(xml)
}

/**
 * @param {string} xml
 * @returns {InstalledPlistFields}
 */
function parsePlistFields(xml) {
  /** @type {InstalledPlistFields} */
  const fields = {}
  const arrayMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)
  if (arrayMatch) {
    const items = [...arrayMatch[1].matchAll(/<string>([^<]*)<\/string>/g)].map(function(m) {
      return unescapeXml(m[1])
    })
    const idx = items.indexOf('--config')
    if (idx !== -1 && idx + 1 < items.length) fields.configPath = items[idx + 1]
  }
  const stdoutPath = extractStringForKey(xml, 'StandardOutPath')
  if (stdoutPath !== undefined) fields.stdoutPath = stdoutPath
  const stderrPath = extractStringForKey(xml, 'StandardErrorPath')
  if (stderrPath !== undefined) fields.stderrPath = stderrPath
  return fields
}

/**
 * @param {string} xml
 * @param {string} key
 * @returns {string | undefined}
 */
function extractStringForKey(xml, key) {
  const re = new RegExp(`<key>${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}<\\/key>\\s*<string>([^<]*)<\\/string>`)
  const m = re.exec(xml)
  return m ? unescapeXml(m[1]) : undefined
}

/**
 * @param {string} value
 * @returns {string}
 */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Extract the numeric port from a `host:port` listen address. Bracketed IPv6
 * forms (`[::1]:8787`) are unwrapped so we only have to look at the suffix.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseListenPort(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid listen value: ${String(value)}`)
  }
  /** @type {string} */
  let portStr
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1 || value[close + 1] !== ':') {
      throw new Error(`invalid listen value: ${value}`)
    }
    portStr = value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon <= 0) throw new Error(`invalid listen value: ${value}`)
    portStr = value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port in listen value: ${value}`)
  }
  return port
}

/**
 * Heuristic to detect whether a script path was resolved through `npx`.
 *
 * npx unpacks the package into `~/.npm/_npx/<hash>/...` so the binary path is
 * not stable across invocations and would silently break a LaunchAgent on the
 * next `npx` run. Match `_npx` as a path component to avoid false positives on
 * directory names that merely contain the substring.
 *
 * @param {unknown} p
 * @returns {boolean}
 */
export function isNpxBinPath(p) {
  if (typeof p !== 'string') return false
  return /[/\\]_npx[/\\]/.test(p)
}

/**
 * Read a single line from stdin, prompted with `question`. Lazily imports
 * readline so non-prompt code paths don't pay for it.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function defaultPrompt(question) {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(function(resolve) {
    rl.question(question, function(answer) {
      rl.close()
      resolve(answer.trim())
    })
  })
}
