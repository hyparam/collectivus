import process from 'node:process'
import { detach as defaultDetach, isAttached as defaultIsAttached, defaultSettingsPath } from '../claude-code/settings.js'
import { LAUNCH_AGENT_LABEL, defaultPrompt } from './common.js'
import { uninstallDaemon } from '../daemon/index.js'

const USAGE = `Usage:
  collectivus uninstall [--detach]

Options:
  --detach          Also revert Claude Code settings.json without prompting
  --help, -h        Show this help`

/**
 * @typedef {object} UninstallParseResult
 * @property {boolean} detach - True if --detach was given.
 * @property {boolean} help - True if --help/-h was given.
 * @property {string|null} error - Error message when parsing failed.
 */

/**
 * Parse the argument list of `collectivus uninstall`.
 *
 * @param {string[]} argv
 * @returns {UninstallParseResult}
 */
export function parseUninstallArgs(argv) {
  let detach = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { detach, help: true, error: null }
    if (arg === '--detach') { detach = true; continue }
    return { detach, help: false, error: `unknown argument: ${arg}` }
  }
  return { detach, help: false, error: null }
}

/**
 * @typedef {object} UninstallHooks
 * @property {{ write: (s: string) => void }} [stdout]
 * @property {{ write: (s: string) => void }} [stderr]
 * @property {string} [plistDir] - Forwarded to uninstallDaemon (`~/Library/LaunchAgents` override).
 * @property {string} [settingsPath] - Override for `~/.claude/settings.json`.
 * @property {boolean} [isTTY]
 * @property {(question: string) => Promise<string>} [prompt]
 * @property {typeof uninstallDaemon} [uninstallLaunchAgent]
 * @property {typeof defaultDetach} [detach]
 * @property {typeof defaultIsAttached} [isAttached]
 */

/**
 * Run `collectivus uninstall`.
 *
 * Removes the LaunchAgent. When `--detach` is given, also reverts Claude Code
 * settings unconditionally; otherwise prompts (TTY) or skips (non-TTY) the
 * detach step. Always reports the final state.
 *
 * @param {string[]} argv
 * @param {UninstallHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runUninstall(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const uninstallFn = hooks.uninstallLaunchAgent ?? uninstallDaemon
  const detachFn = hooks.detach ?? defaultDetach
  const isAttachedFn = hooks.isAttached ?? defaultIsAttached
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const promptFn = hooks.prompt ?? defaultPrompt
  const isTTY = hooks.isTTY ?? Boolean(process.stdin.isTTY)

  const parsed = parseUninstallArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  try {
    await uninstallFn({
      label: LAUNCH_AGENT_LABEL,
      ...hooks.plistDir !== undefined ? { plistDir: hooks.plistDir } : {},
    })
  } catch (err) {
    stderr.write(`error: failed to uninstall daemon: ${formatError(err)}\n`)
    return 1
  }
  stdout.write(`✓ Daemon removed (LaunchAgent: ${LAUNCH_AGENT_LABEL})\n`)

  /** @type {boolean} */
  let shouldDetach
  if (parsed.detach) {
    shouldDetach = true
  } else {
    /** @type {boolean} */
    let attached
    try {
      attached = await isAttachedFn({ settingsPath })
    } catch (err) {
      stderr.write(`error: failed to read ${settingsPath}: ${formatError(err)}\n`)
      return 1
    }
    if (!attached) {
      stdout.write('  Claude Code: not attached, nothing to revert\n')
      return 0
    }
    if (isTTY) {
      const answer = await promptFn('Also revert Claude Code configuration? [Y/n] ')
      shouldDetach = answer === '' || /^y(es)?$/i.test(answer)
    } else {
      stderr.write(
        'warning: not a TTY; leaving Claude Code attached. ' +
        'Run `collectivus detach` (or rerun with --detach) to revert.\n'
      )
      shouldDetach = false
    }
  }

  if (shouldDetach) {
    try {
      const result = await detachFn({ settingsPath })
      if (result.changed) {
        stdout.write(`✓ Claude Code reverted (${settingsPath})\n`)
        if (result.warning) stdout.write(`  warning: ${result.warning}\n`)
      } else {
        stdout.write('  Claude Code: no marker found, nothing to revert\n')
      }
    } catch (err) {
      stderr.write(`error: failed to revert Claude Code: ${formatError(err)}\n`)
      return 1
    }
  } else {
    stdout.write('  Claude Code revert: skipped\n')
  }

  return 0
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
