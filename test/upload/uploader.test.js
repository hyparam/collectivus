import { parquetReadObjects } from 'hyparquet'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryConnector } from '../../src/upload/connectors/memory.js'
import { uploadPending } from '../../src/upload/uploader.js'

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-upload-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * @param {string} service
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {string} date
 * @param {object[]} rows
 * @returns {void}
 */
function writeJsonl(service, signal, date, rows) {
  const dir = path.join(outputDir, 'services', service)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${signal}-${date}.jsonl`)
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

const yesterday = '2026-05-06'
const today = '2026-05-07'

describe('uploadPending', () => {
  it('uploads one parquet per service-signal-day to the configured prefix', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', timestamp: `${yesterday}T00:00:00Z`, body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
      { serviceName: 'svc-a', timestamp: `${yesterday}T00:00:01Z`, body: 'bye', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeJsonl('svc-b', 'metrics', yesterday, [
      { serviceName: 'svc-b', metricType: 'gauge', metricName: 'cpu', value: 0.5, valueType: 'double', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.uploaded)).toBe(true)
    expect([...connector.store.keys()].sort()).toEqual([
      `collectivus/svc-a/logs/date=${yesterday}/data.parquet`,
      `collectivus/svc-b/metrics/date=${yesterday}/data.parquet`,
    ])

    const logsBuf = connector.store.get(`collectivus/svc-a/logs/date=${yesterday}/data.parquet`)
    const ab = new Uint8Array(logsBuf).buffer
    const logsRows = await parquetReadObjects({ file: ab })
    expect(logsRows).toHaveLength(2)
    expect(logsRows[0].serviceName).toBe('svc-a')
  })

  it('skips today and files outside the catch-up window', async () => {
    writeJsonl('svc-a', 'logs', today, [
      { serviceName: 'svc-a', body: 'now', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const oldDate = '2026-04-01'
    writeJsonl('svc-a', 'logs', oldDate, [
      { serviceName: 'svc-a', body: 'old', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    expect(results).toEqual([])
    expect(connector.store.size).toBe(0)
  })

  it('respects the signals allowlist', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeJsonl('svc-a', 'traces', yesterday, [
      { serviceName: 'svc-a', traceId: 't', spanId: 's', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    expect([...connector.store.keys()]).toEqual([
      `collectivus/svc-a/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('writes a ledger entry per uploaded file', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1' },
      connector,
      outputDir,
      today
    )

    const ledgerText = fs.readFileSync(path.join(outputDir, '.upload-ledger.jsonl'), 'utf8')
    const lines = ledgerText.trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry.service).toBe('svc-a')
    expect(entry.signal).toBe('logs')
    expect(entry.date).toBe(yesterday)
    expect(entry.status).toBe('committed')
    expect(entry.rows).toBe(1)
    expect(entry.size).toBeGreaterThan(0)
  })
})
