import fs from 'node:fs'
import path from 'node:path'
import { createServer } from './server.js'

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
 * @returns {Array<Record<string, unknown>>}
 */
function flattenOtlpLogs(data) {
  if (!data || typeof data !== 'object') return []
  const resourceLogs = Array.isArray(data.resourceLogs) ? data.resourceLogs : []
  const rows = []

  for (const resourceLog of resourceLogs) {
    const resourceAttrs = attrsToObject(resourceLog?.resource?.attributes)
    const serviceName = stringValue(resourceAttrs['service.name']) || '_unknown'
    const scopeLogs = Array.isArray(resourceLog?.scopeLogs) ? resourceLog.scopeLogs : []

    for (const scopeLog of scopeLogs) {
      const scope = scopeLog?.scope && typeof scopeLog.scope === 'object' ? scopeLog.scope : {}
      const logRecords = Array.isArray(scopeLog?.logRecords) ? scopeLog.logRecords : []

      for (const logRecord of logRecords) {
        const attributes = attrsToObject(logRecord?.attributes)
        rows.push({
          serviceName,
          timestamp: otlpTimestampToIso(logRecord?.timeUnixNano),
          observedTimestamp: otlpTimestampToIso(logRecord?.observedTimeUnixNano),
          severityNumber: numberValue(logRecord?.severityNumber),
          severityText: stringValue(logRecord?.severityText),
          body: anyValue(logRecord?.body),
          traceId: stringValue(logRecord?.traceId),
          spanId: stringValue(logRecord?.spanId),
          flags: numberValue(logRecord?.flags),
          droppedAttributesCount: numberValue(logRecord?.droppedAttributesCount),
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
  const result = {}
  for (const attr of attrs) {
    if (!attr || typeof attr !== 'object') continue
    const key = stringValue(attr.key)
    if (!key) continue
    result[key] = anyValue(attr.value)
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
  if ('stringValue' in value) return stringValue(value.stringValue)
  if ('boolValue' in value) return Boolean(value.boolValue)
  if ('intValue' in value) return numberLike(value.intValue)
  if ('doubleValue' in value) return numberValue(value.doubleValue)
  if ('bytesValue' in value) return stringValue(value.bytesValue)
  if ('arrayValue' in value) {
    const values = Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : []
    return values.map(anyValue)
  }
  if ('kvlistValue' in value) {
    return attrsToObject(value.kvlistValue?.values)
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
