import { rowsToColumns } from './schema.js'

/**
 * @import { Signal } from './upload.d.ts'
 */

/**
 * Convert normalized rows to a Parquet file. Lazy-loads hyparquet-writer
 * so the optional dep is only required when uploads are configured.
 *
 * @param {Signal} signal
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @returns {Promise<Uint8Array>}
 */
export async function rowsToParquet(signal, rows) {
  const { parquetWriteBuffer } = await import('hyparquet-writer')
  const columnData = rowsToColumns(signal, rows)
  const arrayBuffer = parquetWriteBuffer({ columnData })
  return new Uint8Array(arrayBuffer)
}
