import { parquetReadObjects } from 'hyparquet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryConnector } from '../../src/upload/connectors/memory.js'
import { uploadPending } from '../../src/upload/uploader.js'

/**
 * @import { StorageConnector } from '../../src/upload/upload.js'
 */

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
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
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
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
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
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
      connector,
      outputDir,
      today
    )

    expect([...connector.store.keys()]).toEqual([
      `collectivus/svc-a/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('isolates per-job failures so one bad object does not abort the run', async () => {
    writeJsonl('svc-bad', 'logs', yesterday, [
      { serviceName: 'svc-bad', body: 'x', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeJsonl('svc-good', 'logs', yesterday, [
      { serviceName: 'svc-good', body: 'y', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const memory = memoryConnector()
    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      async putObject(key, body, contentType) {
        await memory.putObject(key, body, contentType)
      },
      headObject(key) {
        if (key.includes('svc-bad')) {
          const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 HEAD returned 503'))
          err.statusCode = 503
          return Promise.reject(err)
        }
        return memory.headObject(key)
      },
    }

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(results).toHaveLength(2)
    const bad = results.find((r) => r.job.service === 'svc-bad')
    const good = results.find((r) => r.job.service === 'svc-good')
    expect(bad?.uploaded).toBe(false)
    expect(bad?.error?.message).toMatch(/503/)
    expect(good?.uploaded).toBe(true)
    expect([...memory.store.keys()]).toEqual([
      `collectivus/svc-good/logs/date=${yesterday}/data.parquet`,
    ])
  })

  it('retries transient connector failures with backoff and succeeds', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const memory = memoryConnector()
    let putAttempts = 0
    /** @type {number[]} */
    const sleeps = []
    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      async putObject(key, body, contentType) {
        putAttempts++
        if (putAttempts < 3) {
          const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 PUT returned 503'))
          err.statusCode = 503
          throw err
        }
        await memory.putObject(key, body, contentType)
      },
      headObject(key) { return memory.headObject(key) },
    }

    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
      connector,
      outputDir,
      today,
      { sleep: async (ms) => { sleeps.push(ms) }, initialBackoffMs: 1000 }
    )

    expect(putAttempts).toBe(3)
    expect(sleeps).toEqual([1000, 4000])
    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(true)
    expect(memory.store.size).toBe(1)
  })

  it('does not retry on permanent (4xx) connector errors', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    let putAttempts = 0
    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      async putObject() {
        putAttempts++
        const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 PUT returned 403'))
        err.statusCode = 403
        throw err
      },
      async headObject() { return undefined },
    }

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(putAttempts).toBe(1)
    expect(results[0].uploaded).toBe(false)
    expect(results[0].error?.message).toMatch(/403/)
    expect(results[0].retryable).toBe(false)
  })

  it('flags exhausted transient connector retries as retryable', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    /** @type {StorageConnector} */
    const connector = {
      scheme: 'flaky',
      async putObject() {
        const err = /** @type {Error & { statusCode: number }} */ (new Error('s3 PUT returned 503'))
        err.statusCode = 503
        throw err
      },
      async headObject() { return undefined },
    }

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(results[0].uploaded).toBe(false)
    expect(results[0].retryable).toBe(true)
  })

  it('does not flag non-connector errors as retryable', async () => {
    // Make the "JSONL file" actually be a directory so readJsonlRows hits
    // EISDIR — a non-connector error with no statusCode. Pre-fix, the
    // outer catch ran isTransient on it and incorrectly flagged it
    // retryable, putting the scheduler into a fast-retry loop.
    const dir = path.join(outputDir, 'services', 'svc-bad')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(dir, `logs-${yesterday}.jsonl`))

    const connector = memoryConnector()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
      connector,
      outputDir,
      today,
      { sleep: async () => {} }
    )
    errSpy.mockRestore()

    expect(results).toHaveLength(1)
    expect(results[0].uploaded).toBe(false)
    expect(results[0].error).toBeDefined()
    expect(results[0].retryable).toBe(false)
  })

  it('writes a ledger entry per uploaded file', async () => {
    writeJsonl('svc-a', 'logs', yesterday, [
      { serviceName: 'svc-a', body: 'a', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])

    const connector = memoryConnector()
    await uploadPending(
      { bucket: 'b', prefix: 'collectivus', time: '00:10', signals: ['logs', 'traces', 'metrics'], catchupDays: 7, region: 'us-east-1', partitionDimensions: ['service', 'signal'] },
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
