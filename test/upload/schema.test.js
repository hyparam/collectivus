import { parquetReadObjects } from 'hyparquet'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { describe, expect, it } from 'vitest'
import { columnsForSignal, rowsToColumns } from '../../src/upload/schema.js'

describe('columnsForSignal', () => {
  it('exposes a serviceName column for every signal', () => {
    for (const signal of /** @type {const} */ (['logs', 'traces', 'metrics'])) {
      const columns = columnsForSignal(signal)
      expect(columns[0]).toEqual({ name: 'serviceName', type: 'STRING', nullable: false })
    }
  })
})

describe('rowsToColumns logs', () => {
  it('coerces an OTLP-shaped log row through parquet roundtrip', async () => {
    const rows = [{
      serviceName: 'orders-api',
      timestamp: '2026-05-07T12:00:00.000Z',
      observedTimestamp: '2026-05-07T12:00:00.500Z',
      severityNumber: 9,
      severityText: 'INFO',
      body: { message: 'hello', count: 3 },
      traceId: 'abc',
      spanId: 'def',
      flags: 0,
      droppedAttributesCount: 0,
      resource: { 'service.name': 'orders-api', region: 'us-west-2' },
      scope: {
        name: 'instrumentation',
        version: '1.0',
        attributes: { foo: 'bar' },
      },
      attributes: { http: { status: 200 } },
    }]

    const columnData = rowsToColumns('logs', rows)
    const buffer = parquetWriteBuffer({ columnData })
    const read = await parquetReadObjects({ file: buffer })
    expect(read).toHaveLength(1)
    const out = read[0]
    expect(out.serviceName).toBe('orders-api')
    expect(out.severityNumber).toBe(9)
    expect(out.severityText).toBe('INFO')
    expect(out.scope_name).toBe('instrumentation')
    expect(out.scope_version).toBe('1.0')
    expect(out.scope_attributes).toEqual({ foo: 'bar' })
    expect(out.attributes).toEqual({ http: { status: 200 } })
    expect(out.body).toEqual({ message: 'hello', count: 3 })
  })

  it('writes nulls for missing optional columns', async () => {
    const rows = [{ serviceName: 'svc' }]
    const columnData = rowsToColumns('logs', rows)
    const buffer = parquetWriteBuffer({ columnData })
    const read = await parquetReadObjects({ file: buffer })
    expect(read[0].serviceName).toBe('svc')
    expect(read[0].severityText == null).toBe(true)
    expect(read[0].attributes == null).toBe(true)
  })

  it('throws if a non-nullable column is missing', () => {
    expect(() => rowsToColumns('logs', [{ timestamp: '2026-05-07T00:00:00Z' }]))
      .toThrow(/required column "serviceName"/)
  })
})

describe('rowsToColumns metrics', () => {
  it('handles all metric variants in a single union schema', async () => {
    const rows = [
      {
        serviceName: 'svc', metricType: 'gauge',
        metricName: 'cpu', value: 0.42, valueType: 'double',
        timestamp: '2026-05-07T00:00:00Z',
      },
      {
        serviceName: 'svc', metricType: 'sum',
        metricName: 'requests', value: 17, valueType: 'int',
        isMonotonic: true, aggregationTemporality: 2,
      },
      {
        serviceName: 'svc', metricType: 'histogram',
        metricName: 'latency', count: '1234567890123', sum: 42.5,
        bucketCounts: ['1', '2', '3'], explicitBounds: [0.1, 0.2],
        min: 0, max: 1,
      },
      {
        serviceName: 'svc', metricType: 'summary',
        metricName: 'sizes', count: 10, sum: 100,
        quantileValues: [{ quantile: 0.5, value: 9 }],
      },
    ]
    const columnData = rowsToColumns('metrics', rows)
    const buffer = parquetWriteBuffer({ columnData })
    const read = await parquetReadObjects({ file: buffer })
    expect(read).toHaveLength(4)
    expect(read[0].metricType).toBe('gauge')
    expect(read[0].value).toBe(0.42)
    expect(read[1].value == null).toBe(true)
    expect(read[1].valueInt).toBe(17n)
    expect(read[1].isMonotonic).toBe(true)
    expect(read[2].count).toBe(1234567890123n)
    expect(read[2].bucketCounts).toEqual(['1', '2', '3'])
    expect(read[3].quantileValues).toEqual([{ quantile: 0.5, value: 9 }])
  })

  it('preserves large integer datapoint values exactly', async () => {
    const rows = [{
      serviceName: 'svc',
      metricType: 'sum',
      metricName: 'requests',
      value: '9007199254740993',
      valueType: 'int',
    }]

    const columnData = rowsToColumns('metrics', rows)
    const buffer = parquetWriteBuffer({ columnData })
    const read = await parquetReadObjects({ file: buffer })

    expect(read[0].value == null).toBe(true)
    expect(read[0].valueInt).toBe(9007199254740993n)
  })
})

describe('rowsToColumns traces', () => {
  it('round-trips events and links as JSON', async () => {
    const rows = [{
      serviceName: 'svc',
      traceId: 't', spanId: 's',
      name: 'GET /', kind: 2,
      startTimestamp: '2026-05-07T12:00:00Z',
      endTimestamp: '2026-05-07T12:00:01Z',
      durationMs: 1000,
      events: [{ name: 'evt', timestamp: '2026-05-07T12:00:00.500Z', attributes: { k: 'v' } }],
      links: /** @type {object[]} */ ([]),
      status: { code: 1, message: 'ok' },
      attributes: { db: 'pg' },
      scope: { name: 's', attributes: {} },
    }]
    const columnData = rowsToColumns('traces', rows)
    const buffer = parquetWriteBuffer({ columnData })
    const read = await parquetReadObjects({ file: buffer })
    const out = read[0]
    expect(out.events).toEqual([{ name: 'evt', timestamp: '2026-05-07T12:00:00.500Z', attributes: { k: 'v' } }])
    expect(out.links).toEqual([])
    expect(out.status).toEqual({ code: 1, message: 'ok' })
  })
})
