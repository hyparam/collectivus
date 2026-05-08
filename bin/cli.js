#!/usr/bin/env node

import process from 'node:process'

const SUBCOMMANDS = new Set(['install', 'uninstall', 'attach', 'detach', 'status'])

const argv = process.argv.slice(2)
const subcommand = argv[0]

const updateCheck = checkForUpdates()

main().then(
  async function(code) {
    await updateCheck
    process.exit(code)
  },
  async function(err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    await updateCheck
    process.exit(1)
  }
)

/**
 * Dispatch to a subcommand handler when the first argument matches one of the
 * installer commands; otherwise fall through to the long-running listener
 * lifecycle in `src/cli.js`.
 *
 * @returns {Promise<number>}
 */
async function main() {
  if (subcommand && SUBCOMMANDS.has(subcommand)) {
    const subArgs = argv.slice(1)
    const handler = await loadSubcommand(subcommand)
    return handler(subArgs)
  }
  const { run } = await import('../src/cli.js')
  return run(argv, process.env)
}

/**
 * @param {string} name
 * @returns {Promise<(args: string[]) => Promise<number>>}
 */
async function loadSubcommand(name) {
  switch (name) {
  case 'install': {
    const { runInstall } = await import('../src/cli/install.js')
    return runInstall
  }
  case 'uninstall': {
    const { runUninstall } = await import('../src/cli/uninstall.js')
    return runUninstall
  }
  case 'attach': {
    const { runAttach } = await import('../src/cli/attach.js')
    return runAttach
  }
  case 'detach': {
    const { runDetach } = await import('../src/cli/detach.js')
    return runDetach
  }
  case 'status': {
    const { runStatus } = await import('../src/cli/status.js')
    return runStatus
  }
  default:
    throw new Error(`unknown subcommand: ${name}`)
  }
}

/**
 * Background check against the npm registry for a newer published version.
 * Prints a notice to stderr when one is available; never throws or rejects.
 * Aborts after 1s so a slow registry doesn't delay process exit.
 *
 * @returns {Promise<void>}
 */
async function checkForUpdates() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  if (typeof timer.unref === 'function') timer.unref()

  try {
    const { readPackageVersion } = await import('../src/cli/common.js')
    const currentVersion = readPackageVersion()
    const response = await fetch('https://registry.npmjs.org/collectivus/latest', {
      signal: controller.signal,
    })
    if (!response.ok) return
    const { version } = await response.json()
    if (version && version !== currentVersion) {
      process.stderr.write(
        `\x1b[33mA newer version of collectivus is available: ${version} (current: ${currentVersion})\x1b[0m\n` +
        '\x1b[33mRun \'npm install -g collectivus\' to update\x1b[0m\n'
      )
    }
  } catch {
    // fail silently — update check is best-effort
  } finally {
    clearTimeout(timer)
  }
}
