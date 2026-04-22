/**
 * Resolve collector options from CLI args and environment.
 *
 * Precedence: argv > env > Collector defaults. Keys are only set when an
 * explicit value is provided; unset keys fall through to the constructor.
 *
 * @param {string[]} argv CLI arguments (without node/script name).
 * @param {NodeJS.ProcessEnv} env Environment variables.
 * @returns {{ port?: number, outputDir?: string }} Options for Collector.
 */
export function resolveOptions(argv, env) {
  /** @type {{ port?: number, outputDir?: string }} */
  const options = {}

  if (env.COLLECTIVUS_PORT) {
    const port = parseInt(env.COLLECTIVUS_PORT, 10)
    if (!Number.isNaN(port)) options.port = port
  }
  if (env.COLLECTIVUS_OUTPUT_DIR) {
    options.outputDir = env.COLLECTIVUS_OUTPUT_DIR
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' && argv[i + 1]) {
      const port = parseInt(argv[i + 1], 10)
      if (!Number.isNaN(port)) options.port = port
      i++
    } else if (arg.startsWith('--port=')) {
      const port = parseInt(arg.slice('--port='.length), 10)
      if (!Number.isNaN(port)) options.port = port
    } else if (arg === '--output' && argv[i + 1]) {
      options.outputDir = argv[i + 1]
      i++
    } else if (arg.startsWith('--output=')) {
      options.outputDir = arg.slice('--output='.length)
    }
  }

  return options
}
