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
 * Standalone and server-mode parquet drains share the same partition
 * layout: `<outputDir>/<gateway_id>/<signal>/<UTC-date>.jsonl`. Standalone
 * resolves `gateway_id` from `config.gateway_id` or the OS username; server
 * mode tags it from the authenticated JWT subject on every ingest.
 *
 * @type {ReadonlyArray<string>}
 */
const DEFAULT_PARTITION_DIMENSIONS = ['gateway_id', 'signal']

/**
 * Wire together a connector, an uploader, and a scheduler. Returns
 * { start, stop }; both are idempotent and safe to await.
 *
 * Throws synchronously when the default S3 connector is selected and AWS
 * credentials are missing from the env, so callers (cli.js boot path, tests)
 * see the failure at construction time, not after the first daily tick.
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
  if (!args.connector && (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for the S3 connector')
  }
  const connector = args.connector ?? defaultConnector(options, env)

  const scheduler = createScheduler({
    time: options.time,
    tick: async () => {
      const today = todayUtc(new Date())
      const results = await uploadPending(options, connector, args.outputDir, today)
      return { retry: results.some((r) => r.retryable === true) }
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
  const partitionDimensions = options.partitionDimensions ?? DEFAULT_PARTITION_DIMENSIONS
  if (!partitionDimensions.includes('signal')) {
    throw new Error(`upload.partitionDimensions must include 'signal'; got ${JSON.stringify(partitionDimensions)}`)
  }
  return {
    bucket: options.bucket,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    time: options.time ?? DEFAULT_TIME,
    signals: options.signals ?? DEFAULT_SIGNALS,
    catchupDays: options.catchupDays ?? DEFAULT_CATCHUP_DAYS,
    region: options.region ?? '',
    endpoint: options.endpoint,
    partitionDimensions,
  }
}

/**
 * Build the default connector based on the resolved options. Today S3 is
 * the only real connector; future schemes (gs://, azblob://) slot in
 * here. Caller (createUploader) is responsible for verifying that
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are present in `env`.
 *
 * @param {ResolvedUploadOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @returns {StorageConnector}
 */
function defaultConnector(options, env) {
  const region = options.region || env.AWS_REGION || 'us-east-1'
  return s3Connector({
    bucket: options.bucket,
    region,
    accessKeyId: /** @type {string} */ (env.AWS_ACCESS_KEY_ID),
    secretAccessKey: /** @type {string} */ (env.AWS_SECRET_ACCESS_KEY),
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
