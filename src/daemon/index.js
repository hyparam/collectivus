import process from 'node:process'
import * as macos from './macos.js'

export class DaemonError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'DaemonError'
  }
}

/**
 * Install the platform-appropriate daemon to keep the collectivus process
 * running across reboots. Currently macOS-only; throws a clear error on
 * other platforms so the CLI can surface it.
 *
 * @param {import('./macos.js').InstallOptions} options
 * @returns {Promise<void>}
 */
export async function installDaemon(options) {
  if (process.platform !== 'darwin') {
    throw new DaemonError(`unsupported platform: ${process.platform} (only darwin is supported in v0)`)
  }
  await macos.installLaunchAgent(options)
}

/**
 * Inverse of `installDaemon`. Same platform restriction.
 *
 * @param {import('./macos.js').UninstallOptions} options
 * @returns {Promise<void>}
 */
export async function uninstallDaemon(options) {
  if (process.platform !== 'darwin') {
    throw new DaemonError(`unsupported platform: ${process.platform} (only darwin is supported in v0)`)
  }
  await macos.uninstallLaunchAgent(options)
}

export { macos }
