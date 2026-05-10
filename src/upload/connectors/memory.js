/**
 * @import { StorageConnector } from '../upload.d.ts'
 */

/**
 * In-memory StorageConnector for tests. Backed by a Map<string, Uint8Array>
 * exposed on `connector.store` so tests can introspect what was uploaded.
 *
 * @returns {StorageConnector & { store: Map<string, Uint8Array> }}
 */
export function memoryConnector() {
  /** @type {Map<string, Uint8Array>} */
  const store = new Map()

  return {
    scheme: 'memory',
    store,
    async putObject(key, body, putOpts) {
      if (putOpts?.ifNoneMatch === '*' && store.has(key)) {
        const err = /** @type {Error & { statusCode?: number }} */ (
          new Error(`memory PUT ${key}: object exists (If-None-Match: *)`)
        )
        err.statusCode = 412
        throw err
      }
      store.set(key, body)
    },
    async headObject(key) {
      const body = store.get(key)
      if (!body) return undefined
      return { size: body.byteLength }
    },
    async getObject(key) {
      return store.get(key)
    },
    async listObjects(prefix) {
      return [...store.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
    async deleteObject(key) {
      store.delete(key)
    },
  }
}
