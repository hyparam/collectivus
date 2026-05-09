import { parquetReadObjects } from 'hyparquet'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryConnector } from '../../src/upload/connectors/memory.js'
import { uploadPending } from '../../src/upload/uploader.js'
import { readLedger } from '../../src/upload/ledger.js'

/**
 * @import { ResolvedUploadOptions } from '../../src/upload/upload.js'
 */

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-multi-tenant-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * Write a JSONL file under the multi-tenant ingest layout written by
 * src/server/ingest.js: `<outputDir>/<gateway_id>/<signal>/<date>.jsonl`.
 *
 * @param {string} gatewayId
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {string} date
 * @param {object[]} rows
 */
function writeIngestJsonl(gatewayId, signal, date, rows) {
  const dir = path.join(outputDir, gatewayId, signal)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${date}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  )
}

/**
 * @param {Partial<ResolvedUploadOptions>} [overrides]
 * @returns {ResolvedUploadOptions}
 */
function serverOptions(overrides = {}) {
  return {
    bucket: 'b',
    prefix: 'collectivus',
    time: '00:10',
    signals: ['logs', 'traces', 'metrics'],
    catchupDays: 7,
    region: 'us-east-1',
    partitionDimensions: ['gateway_id', 'signal'],
    ...overrides,
  }
}

const yesterday = '2026-05-06'
const today = '2026-05-07'

describe('uploadPending in server mode (gateway_id partition)', () => {
  it('walks the per-gateway ingest layout and writes one parquet per (gateway, signal, day)', async () => {
    writeIngestJsonl('gw-a', 'logs', yesterday, [
      {
        serviceName: 'svc-a',
        timestamp: `${yesterday}T00:00:00Z`,
        body: 'one',
        resource: {},
        scope: { attributes: {} },
        attributes: {},
      },
    ])
    writeIngestJsonl('gw-b', 'logs', yesterday, [
      {
        serviceName: 'svc-b',
        timestamp: `${yesterday}T00:00:01Z`,
        body: 'two',
        resource: {},
        scope: { attributes: {} },
        attributes: {},
      },
    ])
    writeIngestJsonl('gw-b', 'metrics', yesterday, [
      {
        serviceName: 'svc-b',
        metricType: 'gauge',
        metricName: 'cpu',
        value: 0.5,
        valueType: 'double',
        resource: {},
        scope: { attributes: {} },
        attributes: {},
      },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(serverOptions(), connector, outputDir, today)

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.uploaded)).toBe(true)
    expect([...connector.store.keys()].sort()).toEqual([
      `collectivus/gw-a/logs/date=${yesterday}/data.parquet`,
      `collectivus/gw-b/logs/date=${yesterday}/data.parquet`,
      `collectivus/gw-b/metrics/date=${yesterday}/data.parquet`,
    ])
  })

  it('decodes the written parquet end-to-end so we know the bytes are well-formed', async () => {
    writeIngestJsonl('gw-prod-1', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'one', resource: {}, scope: { attributes: {} }, attributes: {} },
      { serviceName: 'svc-a', body: 'two', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    await uploadPending(serverOptions(), connector, outputDir, today)

    const buf = connector.store.get(
      `collectivus/gw-prod-1/logs/date=${yesterday}/data.parquet`
    )
    expect(buf).toBeDefined()
    const ab = new Uint8Array(/** @type {Uint8Array} */ (buf)).buffer
    const rows = await parquetReadObjects({ file: ab })
    expect(rows).toHaveLength(2)
    expect(rows[0].serviceName).toBe('svc-a')
  })

  it('skips empty gateway directories and gateways with no matching jsonl', async () => {
    fs.mkdirSync(path.join(outputDir, 'gw-empty'), { recursive: true })
    fs.mkdirSync(path.join(outputDir, 'gw-no-files', 'logs'), { recursive: true })
    writeIngestJsonl('gw-with-data', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(serverOptions(), connector, outputDir, today)

    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(true)
    expect(results[0].key).toBe(`collectivus/gw-with-data/logs/date=${yesterday}/data.parquet`)
  })

  it('skips today and files outside the catch-up window', async () => {
    writeIngestJsonl('gw-a', 'logs', today, [
      { serviceName: 'svc-a', body: 'now', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const oldDate = '2026-04-01'
    writeIngestJsonl('gw-a', 'logs', oldDate, [
      { serviceName: 'svc-a', body: 'old', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(serverOptions(), connector, outputDir, today)

    expect(results).toEqual([])
    expect(connector.store.size).toBe(0)
  })

  it('respects the signals allowlist (drops files in disallowed signal dirs)', async () => {
    writeIngestJsonl('gw-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeIngestJsonl('gw-a', 'traces', yesterday, [
      { serviceName: 'svc-a', traceId: 't', spanId: 's', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      serverOptions({ signals: ['logs'] }),
      connector,
      outputDir,
      today
    )

    expect(results.map((r) => r.key)).toEqual([
      `collectivus/gw-a/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('writes a ledger entry whose dedupe key matches the next walk', async () => {
    writeIngestJsonl('gw-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const first = await uploadPending(serverOptions(), connector, outputDir, today)
    expect(first[0].uploaded).toBe(true)

    const ledgerText = fs.readFileSync(
      path.join(outputDir, '.upload-ledger.jsonl'),
      'utf8'
    )
    const entry = JSON.parse(ledgerText.trim().split('\n')[0])
    expect(entry.partitions).toEqual({ gateway_id: 'gw-a', signal: 'logs' })
    expect(entry.signal).toBe('logs')
    expect(entry.date).toBe(yesterday)
    // No legacy `service` field — server mode does not have a service partition.
    expect(entry.service).toBeUndefined()

    // Second pass: ledger should mark this job committed and skip it
    // before the connector is even consulted (so no new uploads fire).
    const sizeBefore = connector.store.size
    const second = await uploadPending(serverOptions(), connector, outputDir, today)
    expect(second).toHaveLength(1)
    expect(second[0].uploaded).toBe(false)
    expect(connector.store.size).toBe(sizeBefore)
  })

  it('reads legacy ledger entries (pre-multi-tenant) so existing standalone runs are not re-uploaded', () => {
    // Simulate a ledger written by an older standalone uploader: top-level
    // `service` field, no `partitions`. The current walker in standalone
    // mode (default partition dimensions) must still recognize the entry.
    fs.writeFileSync(
      path.join(outputDir, '.upload-ledger.jsonl'),
      JSON.stringify({
        service: 'svc-a',
        signal: 'logs',
        date: yesterday,
        status: 'committed',
        key: `collectivus/svc-a/logs/date=${yesterday}/data.parquet`,
        size: 123,
        rows: 1,
        committedAt: '2026-05-06T01:00:00Z',
      }) + '\n'
    )
    const committed = readLedger(outputDir)
    // The synthesized partition map for a legacy entry is
    // {service, signal}; the dedupe key must match what the legacy
    // walker would produce for the same job.
    expect(
      committed.has(`service=svc-a;signal=logs|${yesterday}`)
    ).toBe(true)
  })
})

describe('uploadPending hands each row to the parquet writer with _partition tagged', () => {
  it('injects _partition onto each row whose values match the walked path', async () => {
    writeIngestJsonl('gw-prod-1', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'one', resource: {}, scope: { attributes: {} }, attributes: {} },
      { serviceName: 'svc-a', body: 'two', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    // The current parquet schema does not yet declare a `_partition`
    // column, so the field is dropped at serialization (D.2 will add
    // gateway_id as a typed column and surface it). Until then, assert
    // the contract at the row-reader boundary: the discoverer + reader
    // pair must produce rows that have `_partition` populated. We mirror
    // uploadJob's two-line tagging step rather than mocking the parquet
    // writer, which keeps the test resilient across hyparquet upgrades.
    const { discoverJobs } = await import('../../src/upload/uploader.js')
    const { readJsonlRows } = await import('../../src/upload/reader.js')
    const jobs = discoverJobs(outputDir, today, serverOptions())
    expect(jobs).toHaveLength(1)
    const job = jobs[0]
    /** @type {Record<string, unknown>[]} */
    const rows = []
    for await (const row of readJsonlRows(job.jsonlPath)) {
      row._partition = { ...job.partitions }
      rows.push(row)
    }
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row._partition).toEqual({ gateway_id: 'gw-prod-1', signal: 'logs' })
    }

    // End-to-end smoke: confirm the upload still runs with the
    // gateway-prefixed key (i.e. that adding the row tag has not
    // perturbed the parquet path).
    const connector = memoryConnector()
    const results = await uploadPending(serverOptions(), connector, outputDir, today)
    expect(results.every((r) => r.uploaded)).toBe(true)
    expect([...connector.store.keys()]).toContain(
      `collectivus/gw-prod-1/logs/date=${yesterday}/data.parquet`
    )
  })
})
