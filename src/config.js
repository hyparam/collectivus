/**
 * @import { Signal, UploadOptions } from './upload/upload.d.ts'
 */

/**
 * Resolve collector options from CLI args and environment.
 *
 * Precedence: argv > env > Collector defaults. Keys are only set when an
 * explicit value is provided; unset keys fall through to the constructor.
 *
 * @param {string[]} argv CLI arguments (without node/script name).
 * @param {NodeJS.ProcessEnv} env Environment variables.
 * @returns {{ port?: number, outputDir?: string, upload?: UploadOptions }} Options for Collector.
 */
export function resolveOptions(argv, env) {
  /** @type {{ port?: number, outputDir?: string, upload?: UploadOptions }} */
  const options = {}
  /** @type {Partial<UploadOptions>} */
  const upload = {}

  if (env.COLLECTIVUS_PORT) {
    const port = parseInt(env.COLLECTIVUS_PORT, 10)
    if (!Number.isNaN(port)) options.port = port
  }
  if (env.COLLECTIVUS_OUTPUT_DIR) {
    options.outputDir = env.COLLECTIVUS_OUTPUT_DIR
  }

  if (env.COLLECTIVUS_UPLOAD_BUCKET) upload.bucket = env.COLLECTIVUS_UPLOAD_BUCKET
  if (env.COLLECTIVUS_UPLOAD_PREFIX) upload.prefix = env.COLLECTIVUS_UPLOAD_PREFIX
  if (env.COLLECTIVUS_UPLOAD_TIME) upload.time = env.COLLECTIVUS_UPLOAD_TIME
  if (env.COLLECTIVUS_UPLOAD_SIGNALS) upload.signals = parseSignals(env.COLLECTIVUS_UPLOAD_SIGNALS)
  if (env.COLLECTIVUS_UPLOAD_CATCHUP_DAYS) {
    const n = parseInt(env.COLLECTIVUS_UPLOAD_CATCHUP_DAYS, 10)
    if (!Number.isNaN(n)) upload.catchupDays = n
  }
  if (env.AWS_REGION) upload.region = env.AWS_REGION
  if (env.COLLECTIVUS_UPLOAD_ENDPOINT) upload.endpoint = env.COLLECTIVUS_UPLOAD_ENDPOINT

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    function next() { return argv[++i] }
    if (arg === '--port' && argv[i + 1] !== undefined) {
      const port = parseInt(next(), 10)
      if (!Number.isNaN(port)) options.port = port
    } else if (arg.startsWith('--port=')) {
      const port = parseInt(arg.slice('--port='.length), 10)
      if (!Number.isNaN(port)) options.port = port
    } else if (arg === '--output' && argv[i + 1] !== undefined) {
      options.outputDir = next()
    } else if (arg.startsWith('--output=')) {
      options.outputDir = arg.slice('--output='.length)
    } else if (arg === '--upload-bucket' && argv[i + 1] !== undefined) {
      upload.bucket = next()
    } else if (arg.startsWith('--upload-bucket=')) {
      upload.bucket = arg.slice('--upload-bucket='.length)
    } else if (arg === '--upload-prefix' && argv[i + 1] !== undefined) {
      upload.prefix = next()
    } else if (arg.startsWith('--upload-prefix=')) {
      upload.prefix = arg.slice('--upload-prefix='.length)
    } else if (arg === '--upload-time' && argv[i + 1] !== undefined) {
      upload.time = next()
    } else if (arg.startsWith('--upload-time=')) {
      upload.time = arg.slice('--upload-time='.length)
    } else if (arg === '--upload-signals' && argv[i + 1] !== undefined) {
      upload.signals = parseSignals(next())
    } else if (arg.startsWith('--upload-signals=')) {
      upload.signals = parseSignals(arg.slice('--upload-signals='.length))
    } else if (arg === '--upload-catchup-days' && argv[i + 1] !== undefined) {
      const n = parseInt(next(), 10)
      if (!Number.isNaN(n)) upload.catchupDays = n
    } else if (arg.startsWith('--upload-catchup-days=')) {
      const n = parseInt(arg.slice('--upload-catchup-days='.length), 10)
      if (!Number.isNaN(n)) upload.catchupDays = n
    } else if (arg === '--upload-region' && argv[i + 1] !== undefined) {
      upload.region = next()
    } else if (arg.startsWith('--upload-region=')) {
      upload.region = arg.slice('--upload-region='.length)
    } else if (arg === '--upload-endpoint' && argv[i + 1] !== undefined) {
      upload.endpoint = next()
    } else if (arg.startsWith('--upload-endpoint=')) {
      upload.endpoint = arg.slice('--upload-endpoint='.length)
    }
  }

  if (upload.bucket) {
    options.upload = /** @type {UploadOptions} */ (upload)
  }

  return options
}

/**
 * @param {string} value comma-separated signal list
 * @returns {ReadonlyArray<Signal>}
 */
function parseSignals(value) {
  /** @type {Signal[]} */
  const out = []
  for (const part of value.split(',')) {
    const trimmed = part.trim()
    if (trimmed === 'logs' || trimmed === 'traces' || trimmed === 'metrics') {
      out.push(trimmed)
    }
  }
  return out
}
