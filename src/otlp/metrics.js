/**
 * Decoders for OTLP metric messages — subset covering Gauge, Sum, and
 * NumberDataPoint. Histogram / ExponentialHistogram / Summary / Exemplar
 * land on `skipField` for now; extend when needed.
 */

import {
  readBytes,
  readDouble,
  readFixed32,
  readFixed64,
  readSFixed64,
  readTag,
  readVarint,
  skipField,
} from '../protobuf.js'
import {
  decodeInstrumentationScope,
  decodeKeyValue,
  decodeResource,
  decodeString,
  makeReader,
} from './common.js'

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeNumberDataPoint(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const attributes = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 2: out.startTimeUnixNano = readFixed64(r).toString(); break
    case 3: out.timeUnixNano = readFixed64(r).toString(); break
    case 4: out.asDouble = readDouble(r); break
    case 6: out.asInt = readSFixed64(r).toString(); break
    case 7: attributes.push(decodeKeyValue(readBytes(r))); break
    case 8: out.flags = readFixed32(r); break
    default: skipField(r, wireType)
    }
  }
  if (attributes.length) out.attributes = attributes
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeGauge(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const dataPoints = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      dataPoints.push(decodeNumberDataPoint(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { dataPoints }
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeSum(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const dataPoints = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: dataPoints.push(decodeNumberDataPoint(readBytes(r))); break
    case 2: out.aggregationTemporality = readVarint(r); break
    case 3: out.isMonotonic = readVarint(r) !== 0; break
    default: skipField(r, wireType)
    }
  }
  out.dataPoints = dataPoints
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeMetric(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.name = decodeString(readBytes(r)); break
    case 2: out.description = decodeString(readBytes(r)); break
    case 3: out.unit = decodeString(readBytes(r)); break
    case 5: out.gauge = decodeGauge(readBytes(r)); break
    case 7: out.sum = decodeSum(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeScopeMetrics(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const metrics = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.scope = decodeInstrumentationScope(readBytes(r)); break
    case 2: metrics.push(decodeMetric(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (metrics.length) out.metrics = metrics
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {object}
 */
function decodeResourceMetrics(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {object[]} */
  const scopeMetrics = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    switch (fieldNumber) {
    case 1: out.resource = decodeResource(readBytes(r)); break
    case 2: scopeMetrics.push(decodeScopeMetrics(readBytes(r))); break
    case 3: out.schemaUrl = decodeString(readBytes(r)); break
    default: skipField(r, wireType)
    }
  }
  if (scopeMetrics.length) out.scopeMetrics = scopeMetrics
  return out
}

/**
 * Decode an ExportMetricsServiceRequest (the top-level OTLP/HTTP metrics body).
 * Only Gauge and Sum metric types are decoded; Histogram / ExponentialHistogram
 * / Summary fields are skipped.
 *
 * @param {Uint8Array} bytes
 * @returns {{ resourceMetrics: object[] }}
 */
export function decodeExportMetricsServiceRequest(bytes) {
  const r = makeReader(bytes)
  const end = bytes.byteLength
  /** @type {object[]} */
  const resourceMetrics = []
  while (r.offset < end) {
    const { fieldNumber, wireType } = readTag(r)
    if (fieldNumber === 1) {
      resourceMetrics.push(decodeResourceMetrics(readBytes(r)))
    } else {
      skipField(r, wireType)
    }
  }
  return { resourceMetrics }
}
