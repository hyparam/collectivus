import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { icebergRead, loadLatestFileCatalogMetadata } from 'icebird'
import { memoryConnector } from '../../src/upload/connectors/memory.js'
import { icebergUploadPending } from '../../src/upload/iceberg/index.js'
import { createConnectorLister, createConnectorResolver, parseS3UrlForBucket } from '../../src/upload/iceberg/resolver.js'
import {
  icebergSchemaForSignal,
  partitionSpecForSignal,
  rowsToIcebergRecords,
} from '../../src/upload/iceberg/schema.js'

/**
 * @import { ResolvedUploadOptions } from '../../src/upload/upload.d.ts'
 */

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-iceberg-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * Write rows under the unified `<outputDir>/<gateway_id>/<signal>/<date>.jsonl`
 * layout that both standalone and server modes drain. Fixtures pass a
 * legacy-style service name for `gatewayId` so the table-url assertions
 * stay legible.
 *
 * @param {string} gatewayId
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {string} date
 * @param {object[]} rows
 */
function writeJsonl(gatewayId, signal, date, rows) {
  const dir = path.join(outputDir, gatewayId, signal)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${date}.jsonl`)
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

const yesterday = '2026-05-06'
const today = '2026-05-07'

/** @returns {ResolvedUploadOptions} */
function options() {
  return {
    bucket: 'b',
    prefix: 'collectivus',
    time: '00:10',
    signals: ['logs', 'traces', 'metrics'],
    catchupDays: 7,
    region: 'us-east-1',
    iceberg: {},
  }
}

describe('icebergUploadPending', () => {
  it('creates a table and round-trips records via icebergRead', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      {
        serviceName: 'svc-a',
        timestamp: `${yesterday}T00:00:00Z`,
        severityNumber: 9,
        severityText: 'INFO',
        body: { message: 'hello', count: 1 },
        attributes: { 'http.status': 200 },
        resource: { 'service.name': 'svc-a' },
        scope: { name: 'app', version: '1.0', attributes: {} },
      },
      {
        serviceName: 'svc-a',
        timestamp: `${yesterday}T00:00:01Z`,
        severityNumber: 13,
        severityText: 'WARN',
        body: 'plain text',
        attributes: {},
        resource: { 'service.name': 'svc-a' },
        scope: { name: 'app', version: '1.0', attributes: {} },
      },
    ])

    const connector = memoryConnector()
    const results = await icebergUploadPending(options(), connector, outputDir, today)

    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(true)
    expect(results[0].rows).toBe(2)

    const tableUrl = 's3://b/collectivus/svc-a/logs'
    const resolver = await createConnectorResolver({ connector, bucket: 'b' })
    const lister = createConnectorLister({ connector, bucket: 'b' })
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    expect(metadata['format-version']).toBe(3)
    expect(metadata.snapshots).toHaveLength(1)

    const rows = await icebergRead({ tableUrl, metadata, resolver })
    expect(rows).toHaveLength(2)
    expect(rows[0].serviceName).toBe('svc-a')
    expect(rows[0].severityText).toBe('INFO')
    expect(rows[0].body).toEqual({ message: 'hello', count: 1 })
    expect(rows[1].body).toBe('plain text')
    expect(rows[0].date).toBeInstanceOf(Date)
    expect(/** @type {Date} */ (rows[0].date).toISOString().slice(0, 10)).toBe(yesterday)
  })

  it('reuses an existing table for a second day', async () => {
    writeJsonl('svc-a', 'logs', '2026-05-05', [
      { serviceName: 'svc-a', body: 'one', attributes: {}, resource: {}, scope: { attributes: {} } },
    ])
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'two', attributes: {}, resource: {}, scope: { attributes: {} } },
    ])

    const connector = memoryConnector()
    await icebergUploadPending(options(), connector, outputDir, today)

    const v1 = connector.store.get('collectivus/svc-a/logs/metadata/v1.metadata.json')
    expect(v1).toBeDefined()
    // After two appends to the same table the metadata file count should
    // grow but stay one table — `v3.metadata.json` exists (create + 2 commits).
    expect(connector.store.has('collectivus/svc-a/logs/metadata/v3.metadata.json')).toBe(true)

    const tableUrl = 's3://b/collectivus/svc-a/logs'
    const resolver = await createConnectorResolver({ connector, bucket: 'b' })
    const lister = createConnectorLister({ connector, bucket: 'b' })
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    expect(metadata.snapshots).toHaveLength(2)
    const rows = await icebergRead({ tableUrl, metadata, resolver })
    expect(rows.map((r) => r.body).sort()).toEqual(['one', 'two'])
  })

  it('is idempotent: re-running the tick produces no new snapshots', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'x', attributes: {}, resource: {}, scope: { attributes: {} } },
    ])

    const connector = memoryConnector()
    await icebergUploadPending(options(), connector, outputDir, today)
    const second = await icebergUploadPending(options(), connector, outputDir, today)
    expect(second.every((r) => r.uploaded === false)).toBe(true)

    const tableUrl = 's3://b/collectivus/svc-a/logs'
    const resolver = await createConnectorResolver({ connector, bucket: 'b' })
    const lister = createConnectorLister({ connector, bucket: 'b' })
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    expect(metadata.snapshots).toHaveLength(1)
  })
})

describe('memory connector If-None-Match', () => {
  it('throws 412 when the key already exists', async () => {
    const connector = memoryConnector()
    await connector.putObject('a', new Uint8Array([1]))
    await expect(
      connector.putObject('a', new Uint8Array([2]), { ifNoneMatch: '*' })
    ).rejects.toMatchObject({ statusCode: 412 })
  })
})

describe('iceberg schema', () => {
  it('maps every BasicType for logs', () => {
    const schema = icebergSchemaForSignal('logs')
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]))
    expect(byName.date).toMatchObject({ id: 1, required: true, type: 'date' })
    expect(byName.serviceName).toMatchObject({ id: 2, required: true, type: 'string' })
    expect(byName.timestamp.type).toBe('timestamptz')
    expect(byName.severityNumber.type).toBe('int')
    expect(byName.body.type).toBe('variant')
    expect(byName.attributes.type).toBe('variant')
  })

  it('partitionSpec uses identity transform on `date`', () => {
    const spec = partitionSpecForSignal()
    expect(spec).toEqual({
      'spec-id': 0,
      fields: [{ 'source-id': 1, 'field-id': 1000, name: 'date', transform: 'identity' }],
    })
  })

  it('coerces rows: ISO timestamp → Date, JSON body → variant pass-through, INT64 strings → bigint', () => {
    const records = rowsToIcebergRecords(
      'metrics',
      [
        {
          serviceName: 'svc',
          metricName: 'm',
          timestamp: '2026-05-06T00:00:00Z',
          value: 1.5,
          valueType: 'double',
          count: '12345678901234567',
          resource: {},
          scope: { attributes: {} },
          attributes: {},
        },
      ],
      yesterday
    )
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.serviceName).toBe('svc')
    expect(r.timestamp).toBeInstanceOf(Date)
    expect(r.value).toBe(1.5)
    expect(r.count).toBe(12345678901234567n)
    expect(r.date).toBeInstanceOf(Date)
  })

  it('throws on missing serviceName', () => {
    expect(() =>
      rowsToIcebergRecords('logs', [{ body: 'x', resource: {}, scope: { attributes: {} }, attributes: {} }], yesterday)
    ).toThrow(/serviceName/)
  })

  it('adds gateway_id as a required field when partitionDimensions includes it', () => {
    const schema = icebergSchemaForSignal('logs', ['gateway_id', 'signal'])
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]))
    expect(byName.date).toMatchObject({ id: 1, required: true, type: 'date' })
    expect(byName.serviceName).toMatchObject({ id: 2, required: true, type: 'string' })
    expect(byName.gateway_id).toMatchObject({ id: 3, required: true, type: 'string' })
    expect(byName.timestamp.type).toBe('timestamptz')
    expect(byName.body.type).toBe('variant')
  })

  it('omits gateway_id when partitionDimensions does not include it', () => {
    const schema = icebergSchemaForSignal('logs', ['service', 'signal'])
    const names = schema.fields.map((f) => f.name)
    expect(names).not.toContain('gateway_id')
  })

  it('extracts gateway_id from row._partition', () => {
    const records = rowsToIcebergRecords(
      'logs',
      [
        {
          serviceName: 'svc',
          body: 'x',
          resource: {},
          scope: { attributes: {} },
          attributes: {},
          _partition: { gateway_id: 'gw-1', signal: 'logs' },
        },
      ],
      yesterday,
      ['gateway_id', 'signal']
    )
    expect(records).toHaveLength(1)
    expect(records[0].gateway_id).toBe('gw-1')
    expect(records[0].serviceName).toBe('svc')
  })

  it('throws on missing gateway_id when partitionDimensions includes it', () => {
    expect(() =>
      rowsToIcebergRecords(
        'logs',
        [{ serviceName: 'svc', body: 'x', resource: {}, scope: { attributes: {} }, attributes: {} }],
        yesterday,
        ['gateway_id', 'signal']
      )
    ).toThrow(/gateway_id/)
  })
})

describe('parseS3UrlForBucket', () => {
  it('extracts the key when the bucket matches', () => {
    expect(parseS3UrlForBucket('s3://b/a/b/c.parquet', 'b')).toBe('a/b/c.parquet')
    expect(parseS3UrlForBucket('s3a://b/a/b/c.parquet', 'b')).toBe('a/b/c.parquet')
  })
  it('rejects URLs targeting a different bucket', () => {
    expect(() => parseS3UrlForBucket('s3://other/x', 'b')).toThrow(/does not match/)
  })
  it('rejects non-s3 URLs', () => {
    expect(() => parseS3UrlForBucket('https://example.com/x', 'b')).toThrow(/unsupported URL/)
  })
})
