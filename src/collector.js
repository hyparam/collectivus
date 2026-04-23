import fs from 'node:fs'
import path from 'node:path'
import { createServer } from './server.js'

/**
 * @typedef {{
 *   serviceName: string,
 *   timestamp?: string,
 *   observedTimestamp?: string,
 *   severityNumber?: number,
 *   severityText?: string,
 *   body: unknown,
 *   traceId?: string,
 *   spanId?: string,
 *   flags?: number,
 *   droppedAttributesCount?: number,
 *   resource: Record<string, unknown>,
 *   scope: {
 *     name?: string,
 *     version?: string,
 *     attributes: Record<string, unknown>,
 *   },
 *   attributes: Record<string, unknown>,
 * }} NormalizedLogRow
 */

const OTLP_NS_PER_MS = 1000000n
const MIN_DATE_MS = -8640000000000000n
const MAX_DATE_MS = 8640000000000000n

class Collector {
  /** @param {{ port?: number, outputDir?: string }} [options] */
  constructor(options = {}) {
    this.port = options.port ?? 4318
    this.outputDir = options.outputDir || './otel-data'
    /** @type {import('node:http').Server | null} */
    this.server = null
  }

  start() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true })
    }

    const server = createServer(this.handleData.bind(this))
    this.server = server

    return new Promise((resolve) => {
      server.listen(this.port, () => resolve(undefined))
    })
  }

  stop() {
    return new Promise((resolve, reject) => {
      const { server } = this
      if (!server) {
        resolve(undefined)
        return
      }

      server.close((err) => err ? reject(err) : resolve(undefined))
    })
  }

  /**
   * @param {string} signal
   * @param {unknown} data
   */
  handleData(signal, data) {
    writeSignalPayload(this.outputDir, signal, data)
    if (signal === 'logs') {
      writeNormalizedLogs(this.outputDir, data)
    }
  }
}

export { Collector }

/**
 * @returns {string}
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Write the raw OTLP payload for a signal.
 *
 * @param {string} outputDir
 * @param {string} signal
 * @param {unknown} data
 * @returns {void}
 */
function writeSignalPayload(outputDir, signal, data) {
  const signalDir = path.join(outputDir, signal)
  ensureDir(signalDir)
  const filePath = path.join(signalDir, `${todayUtc()}.jsonl`)
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n')
}

/**
 * Flatten OTLP logs into one JSON row per log record, partitioned by service.
 *
 * @param {string} outputDir
 * @param {unknown} data
 * @returns {void}
 */
function writeNormalizedLogs(outputDir, data) {
  const rows = flattenOtlpLogs(data)
  for (const row of rows) {
    const serviceName = sanitizePathSegment(row.serviceName || '_unknown')
    const serviceDir = path.join(outputDir, 'logs-by-service', serviceName)
    ensureDir(serviceDir)
    const filePath = path.join(serviceDir, `${todayUtc()}.jsonl`)
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n')
  }
}

/**
 * @param {string} dir
 * @returns {void}
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function objectRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return { ...value }
}

/**
 * Flatten OTLP log export envelopes into one normalized row per log record.
 *
 * @param {unknown} data
 * @returns {NormalizedLogRow[]}
 */
function flattenOtlpLogs(data) {
  const payload = objectRecord(data)
  const resourceLogs = Array.isArray(payload?.resourceLogs) ? payload.resourceLogs : []
  /** @type {NormalizedLogRow[]} */
  const rows = []

  for (const resourceLog of resourceLogs) {
    const resourceLogObj = objectRecord(resourceLog) ?? {}
    const resource = objectRecord(resourceLogObj.resource)
    const resourceAttrs = attrsToObject(resource?.attributes)
    const serviceName = stringValue(resourceAttrs['service.name']) || '_unknown'
    const scopeLogs = Array.isArray(resourceLogObj.scopeLogs) ? resourceLogObj.scopeLogs : []

    for (const scopeLog of scopeLogs) {
      const scopeLogObj = objectRecord(scopeLog) ?? {}
      const scope = objectRecord(scopeLogObj.scope) ?? {}
      const logRecords = Array.isArray(scopeLogObj.logRecords) ? scopeLogObj.logRecords : []

      for (const logRecord of logRecords) {
        const logRecordObj = objectRecord(logRecord) ?? {}
        const attributes = attrsToObject(logRecordObj.attributes)
        rows.push({
          serviceName,
          timestamp: otlpTimestampToIso(logRecordObj.timeUnixNano),
          observedTimestamp: otlpTimestampToIso(logRecordObj.observedTimeUnixNano),
          severityNumber: numberValue(logRecordObj.severityNumber),
          severityText: stringValue(logRecordObj.severityText),
          body: anyValue(logRecordObj.body),
          traceId: stringValue(logRecordObj.traceId),
          spanId: stringValue(logRecordObj.spanId),
          flags: numberValue(logRecordObj.flags),
          droppedAttributesCount: numberValue(logRecordObj.droppedAttributesCount),
          resource: resourceAttrs,
          scope: {
            name: stringValue(scope?.name),
            version: stringValue(scope?.version),
            attributes: attrsToObject(scope?.attributes),
          },
          attributes,
        })
      }
    }
  }

  return rows
}

/**
 * Convert OTLP KeyValue[] into a plain object.
 *
 * @param {unknown} attrs
 * @returns {Record<string, unknown>}
 */
function attrsToObject(attrs) {
  if (!Array.isArray(attrs)) return {}
  /** @type {Record<string, unknown>} */
  const result = {}
  for (const attr of attrs) {
    const pair = objectRecord(attr)
    if (!pair) continue
    const key = stringValue(pair.key)
    if (!key) continue
    result[key] = anyValue(pair.value)
  }
  return result
}

/**
 * Convert an OTLP AnyValue into a JS value.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function anyValue(value) {
  const anyVal = objectRecord(value)
  if (!anyVal) return value ?? null
  if ('stringValue' in anyVal) return anyStringValue(anyVal.stringValue)
  if ('boolValue' in anyVal) return Boolean(anyVal.boolValue)
  if ('intValue' in anyVal) return numberLike(anyVal.intValue)
  if ('doubleValue' in anyVal) return numberValue(anyVal.doubleValue)
  if ('bytesValue' in anyVal) return anyStringValue(anyVal.bytesValue)
  if ('arrayValue' in anyVal) {
    const arrayValue = objectRecord(anyVal.arrayValue)
    const values = Array.isArray(arrayValue?.values) ? arrayValue.values : []
    return values.map(anyValue)
  }
  if ('kvlistValue' in anyVal) {
    return attrsToObject(objectRecord(anyVal.kvlistValue)?.values)
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function anyStringValue(value) {
  return typeof value === 'string' ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number | string | undefined}
 */
function numberLike(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) return value
}

/**
 * Convert OTLP nanoseconds-since-epoch into ISO 8601.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function otlpTimestampToIso(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isInteger(value))) return undefined
  let asBigInt
  try {
    asBigInt = BigInt(value)
  } catch {
    return undefined
  }
  const ms = asBigInt / OTLP_NS_PER_MS
  if (ms < MIN_DATE_MS || ms > MAX_DATE_MS) return undefined
  return new Date(Number(ms)).toISOString()
}

/**
 * Map service names to safe directory names without hiding the original value.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizePathSegment(value) {
  const sanitized = value.replace(/[\\/]/g, '_').trim()
  if (!sanitized) return '_unknown'
  if (sanitized === '.') return '_dot'
  if (sanitized === '..') return '_dotdot'
  return sanitized
}
