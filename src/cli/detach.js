import process from 'node:process'
import { detach as defaultDetach, defaultSettingsPath } from '../claude-code/settings.js'

/**
 * @import { DetachParseResult, DetachHooks } from '../types.js'
 */

const USAGE = `Usage:
  collectivus detach

Removes the collectivus marker and ANTHROPIC_BASE_URL from
~/.claude/settings.json. Safe no-op when no marker is present.

Options:
  --help, -h        Show this help`

/**
 * @param {string[]} argv
 * @returns {DetachParseResult}
 */
export function parseDetachArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    return { help: false, error: `unknown argument: ${arg}` }
  }
  return { help: false }
}

/**
 * Run `collectivus detach`.
 *
 * @param {string[]} argv
 * @param {DetachHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runDetach(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const detachFn = hooks.detach ?? defaultDetach
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()

  const parsed = parseDetachArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  /** @type {{ changed: boolean, removed?: string, warning?: string }} */
  let result
  try {
    result = await detachFn({ settingsPath })
  } catch (err) {
    stderr.write(`error: failed to detach Claude Code: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (!result.changed) {
    stdout.write(`No collectivus marker found in ${settingsPath}; nothing to do.\n`)
    return 0
  }
  stdout.write(`✓ Claude Code reverted (${settingsPath})\n`)
  if (result.removed !== undefined) {
    stdout.write(`  Removed ANTHROPIC_BASE_URL=${result.removed}\n`)
  }
  if (result.warning !== undefined) {
    stdout.write(`  warning: ${result.warning}\n`)
  }
  return 0
}
