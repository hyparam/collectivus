/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { Writer } from 'hyparquet-writer/src/types.js'
 * @import { Lister, Resolver, WriterOptions } from 'icebird/src/types.js'
 * @import { StorageConnector } from '../upload.d.ts'
 */

/**
 * Build an icebird-compatible `Resolver` that routes every read / write /
 * delete through a collectivus `StorageConnector`. Used by the iceberg
 * uploader so icebird's metadata, manifest, and data-file traffic goes
 * through the same SigV4-signed connector the rest of the upload pipeline
 * uses (no second auth path, no second TLS stack).
 *
 * Lazily imports `hyparquet-writer`'s `ByteWriter` so the base install
 * stays zero-dep when iceberg mode is off.
 *
 * @param {object} args
 * @param {StorageConnector} args.connector
 * @param {string} args.bucket Bucket the connector is bound to. URLs that
 *   reference a different bucket throw.
 * @returns {Promise<Resolver>}
 */
export async function createConnectorResolver({ connector, bucket }) {
  const { ByteWriter } = await import('hyparquet-writer')

  /**
   * @param {string} url
   * @returns {string}
   */
  function urlToKey(url) {
    return parseS3UrlForBucket(url, bucket)
  }

  return {
    async reader(url) {
      const key = urlToKey(url)
      const get = connector.getObject
      if (!get) throw new Error('iceberg resolver: connector lacks getObject')
      const bytes = await get.call(connector, key)
      if (bytes === undefined) {
        const err = /** @type {Error & { statusCode?: number }} */ (
          new Error(`iceberg reader: object not found ${url}`)
        )
        err.statusCode = 404
        throw err
      }
      return asyncBufferFromBytes(bytes)
    },
    writer(url, options) {
      return connectorWriter({ connector, ByteWriter, key: urlToKey(url), options })
    },
    async deleter(url) {
      const del = connector.deleteObject
      if (!del) throw new Error('iceberg resolver: connector lacks deleteObject')
      await del.call(connector, urlToKey(url))
    },
  }
}

/**
 * Build an icebird-compatible `Lister` that routes metadata discovery
 * through the same connector as reads and writes. If a custom connector
 * does not support listing, fail fast so icebird's resolver-only metadata
 * probe can run without falling back to its unsigned default S3 lister.
 *
 * @param {object} args
 * @param {StorageConnector} args.connector
 * @param {string} args.bucket Bucket the connector is bound to. URLs that
 *   reference a different bucket throw.
 * @returns {Lister}
 */
export function createConnectorLister({ connector, bucket }) {
  return async function list(url) {
    const listObjects = connector.listObjects
    if (!listObjects) {
      throw new Error('iceberg lister: connector lacks listObjects')
    }
    const dir = parseS3UrlForBucket(url, bucket)
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const keys = await listObjects.call(connector, prefix)
    /** @type {Set<string>} */
    const names = new Set()
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      const name = key.slice(prefix.length)
      if (name === '' || name.includes('/')) continue
      names.add(name)
    }
    return [...names].sort()
  }
}

/**
 * Create an icebird-compatible Writer that buffers bytes via ByteWriter
 * and PUTs them through the connector when finish() is called. ifNoneMatch
 * is forwarded to the connector for atomic metadata commits.
 *
 * @param {object} args
 * @param {StorageConnector} args.connector
 * @param {new (initialSize?: number) => Writer} args.ByteWriter
 * @param {string} args.key
 * @param {WriterOptions | undefined} args.options
 * @returns {Writer}
 */
function connectorWriter({ connector, ByteWriter, key, options }) {
  /** @type {Writer} */
  const w = new ByteWriter()
  w.finish = async function() {
    const bytes = w.getBytes().slice()
    await connector.putObject(key, bytes, {
      contentType: 'application/octet-stream',
      ifNoneMatch: options?.ifNoneMatch,
    })
  }
  return w
}

/**
 * @param {Uint8Array} bytes
 * @returns {AsyncBuffer}
 */
function asyncBufferFromBytes(bytes) {
  return {
    byteLength: bytes.byteLength,
    slice(start, end) {
      const sliced = bytes.subarray(start, end)
      // Return a fresh ArrayBuffer copy — callers (parquet readers) can
      // reuse buffers and we do not want them to alias the connector's
      // returned bytes.
      const out = new ArrayBuffer(sliced.byteLength)
      new Uint8Array(out).set(sliced)
      return out
    },
  }
}

/**
 * Parse an S3 URL and return the key when the bucket matches the
 * connector's bound bucket. Accepts every form icebird can produce:
 *
 *   - `s3://<bucket>/<key>`
 *   - `s3a://<bucket>/<key>`
 *   - `https://<bucket>.s3.amazonaws.com/<key>` (virtual-hosted)
 *   - `https://<bucket>.s3.<region>.amazonaws.com/<key>` (regional virtual-hosted)
 *   - `https://<bucket>.s3-<region>.amazonaws.com/<key>` (legacy dash-separated)
 *   - `https://s3.amazonaws.com/<bucket>/<key>` (path-style)
 *
 * Throws when the URL targets a different bucket or is not recognized —
 * connector-bound resolvers must not silently route traffic to the wrong
 * place.
 *
 * @param {string} url
 * @param {string} expectedBucket
 * @returns {string}
 */
export function parseS3UrlForBucket(url, expectedBucket) {
  const parsed = parseS3Url(url)
  if (!parsed) {
    throw new Error(`iceberg resolver: unsupported URL ${url} (expected s3:// or https://...amazonaws.com)`)
  }
  if (parsed.bucket !== expectedBucket) {
    throw new Error(
      `iceberg resolver: URL bucket "${parsed.bucket}" does not match connector bucket "${expectedBucket}"`
    )
  }
  return parsed.key
}

/**
 * @param {string} url
 * @returns {{ bucket: string, key: string } | undefined}
 */
function parseS3Url(url) {
  const s3 = /^s3a?:\/\/([^/]+)\/(.+)$/.exec(url)
  if (s3) return { bucket: s3[1], key: s3[2] }
  const pathStyle = /^https?:\/\/s3\.amazonaws\.com\/([^/]+)\/(.+)$/.exec(url)
  if (pathStyle) return { bucket: pathStyle[1], key: pathStyle[2] }
  const virtualHosted = /^https?:\/\/([a-z0-9][a-z0-9.-]*)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com\/(.+)$/.exec(url)
  if (virtualHosted) return { bucket: virtualHosted[1], key: virtualHosted[2] }
}
