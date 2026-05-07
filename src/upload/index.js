import { s3Connector } from './connectors/s3.js'
import { createScheduler } from './scheduler.js'
import { uploadPending } from './uploader.js'

/**
 * @import { ResolvedUploadOptions, Signal, StorageConnector, UploadOptions } from './upload.d.ts'
 */

const DEFAULT_TIME = '00:10'
const DEFAULT_PREFIX = 'collectivus'
const DEFAULT_CATCHUP_DAYS = 30
/** @type {ReadonlyArray<Signal>} */
const DEFAULT_SIGNALS = ['logs', 'traces', 'metrics']

/**
 * Wire together a connector, an uploader, and a scheduler. Returns
 * { start, stop }; both are idempotent and safe to await.
 *
 * @param {object} args
 * @param {string} args.outputDir
 * @param {UploadOptions} args.options
 * @param {StorageConnector} [args.connector] override (used by tests)
 * @param {NodeJS.ProcessEnv} [args.env] override (used by tests)
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void> }}
 */
export function createUploader(args) {
  const options = resolve(args.options)
  const env = args.env ?? process.env
  const connector = args.connector ?? defaultConnector(options, env)

  const scheduler = createScheduler({
    time: options.time,
    tick: async () => {
      const today = todayUtc(new Date())
      const results = await uploadPending(options, connector, args.outputDir, today)
      return { retry: results.some((r) => r.error !== undefined) }
    },
  })

  return scheduler
}

/**
 * @param {UploadOptions} options
 * @returns {ResolvedUploadOptions}
 */
function resolve(options) {
  if (!options.bucket) throw new Error('upload.bucket is required')
  return {
    bucket: options.bucket,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    time: options.time ?? DEFAULT_TIME,
    signals: options.signals ?? DEFAULT_SIGNALS,
    catchupDays: options.catchupDays ?? DEFAULT_CATCHUP_DAYS,
    region: options.region ?? '',
    endpoint: options.endpoint,
  }
}

/**
 * Build the default connector based on the resolved options. Today S3 is
 * the only real connector; future schemes (gs://, azblob://) slot in
 * here.
 *
 * @param {ResolvedUploadOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @returns {StorageConnector}
 */
function defaultConnector(options, env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for the S3 connector')
  }
  const region = options.region || env.AWS_REGION || 'us-east-1'
  return s3Connector({
    bucket: options.bucket,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN,
    endpoint: options.endpoint,
  })
}

/**
 * @param {Date} d
 * @returns {string}
 */
function todayUtc(d) {
  return d.toISOString().slice(0, 10)
}

export { uploadPending } from './uploader.js'
