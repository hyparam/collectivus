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
 * Flatten OTLP log export envelopes into one normalized row per log record.
 *
 * @param {unknown} data
 * @returns {NormalizedLogRow[]}
 */
function flattenOtlpLogs(data) {
  if (!data || typeof data !== 'object') return []
  const payload = /** @type {{ resourceLogs?: unknown[] }} */ (data)
  const resourceLogs = Array.isArray(payload.resourceLogs) ? payload.resourceLogs : []
  /** @type {NormalizedLogRow[]} */
  const rows = []

  for (const resourceLog of resourceLogs) {
    const resourceLogObj = /** @type {{ resource?: { attributes?: unknown }, scopeLogs?: unknown[] }} */ (
      resourceLog && typeof resourceLog === 'object' ? resourceLog : {}
    )
    const resourceAttrs = attrsToObject(resourceLogObj.resource?.attributes)
    const serviceName = stringValue(resourceAttrs['service.name']) || '_unknown'
    const scopeLogs = Array.isArray(resourceLogObj.scopeLogs) ? resourceLogObj.scopeLogs : []

    for (const scopeLog of scopeLogs) {
      const scopeLogObj = /** @type {{ scope?: { name?: unknown, version?: unknown, attributes?: unknown }, logRecords?: unknown[] }} */ (
        scopeLog && typeof scopeLog === 'object' ? scopeLog : {}
      )
      const scope = scopeLogObj.scope && typeof scopeLogObj.scope === 'object' ? scopeLogObj.scope : {}
      const logRecords = Array.isArray(scopeLogObj.logRecords) ? scopeLogObj.logRecords : []

      for (const logRecord of logRecords) {
        const logRecordObj = /** @type {{
         *   attributes?: unknown,
         *   timeUnixNano?: unknown,
         *   observedTimeUnixNano?: unknown,
         *   severityNumber?: unknown,
         *   severityText?: unknown,
         *   body?: unknown,
         *   traceId?: unknown,
         *   spanId?: unknown,
         *   flags?: unknown,
         *   droppedAttributesCount?: unknown
         * }} */ (logRecord && typeof logRecord === 'object' ? logRecord : {})
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
    if (!attr || typeof attr !== 'object') continue
    const pair = /** @type {{ key?: unknown, value?: unknown }} */ (attr)
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
  if (!value || typeof value !== 'object') return value ?? null
  const anyVal = /** @type {{
   *   stringValue?: unknown,
   *   boolValue?: unknown,
   *   intValue?: unknown,
   *   doubleValue?: unknown,
   *   bytesValue?: unknown,
   *   arrayValue?: { values?: unknown[] },
   *   kvlistValue?: { values?: unknown }
   * }} */ (value)
  if ('stringValue' in anyVal) return stringValue(anyVal.stringValue)
  if ('boolValue' in anyVal) return Boolean(anyVal.boolValue)
  if ('intValue' in anyVal) return numberLike(anyVal.intValue)
  if ('doubleValue' in anyVal) return numberValue(anyVal.doubleValue)
  if ('bytesValue' in anyVal) return stringValue(anyVal.bytesValue)
  if ('arrayValue' in anyVal) {
    const values = Array.isArray(anyVal.arrayValue?.values) ? anyVal.arrayValue.values : []
    return values.map(anyValue)
  }
  if ('kvlistValue' in anyVal) {
    return attrsToObject(anyVal.kvlistValue?.values)
  }
  return null
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
  const asBigInt = BigInt(value)
  const ms = Number(asBigInt / 1000000n)
  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toISOString()
}

/**
 * Map service names to safe directory names without hiding the original value.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizePathSegment(value) {
  return value.replace(/[\\/]/g, '_').trim() || '_unknown'
}
