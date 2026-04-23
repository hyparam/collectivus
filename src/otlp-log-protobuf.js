const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH_DELIMITED = 2
const WIRE_FIXED32 = 5

export const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf'
export const EMPTY_EXPORT_RESPONSE = Buffer.alloc(0)

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
export function decodeExportLogsRequest(buffer) {
  return decodeEnvelope(buffer, 'resourceLogs', decodeResourceLogs)
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
export function decodeExportTraceServiceRequest(buffer) {
  return decodeEnvelope(buffer, 'resourceSpans', decodeResourceSpans)
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
export function decodeExportMetricsServiceRequest(buffer) {
  return decodeEnvelope(buffer, 'resourceMetrics', decodeResourceMetrics)
}

/**
 * @param {Buffer} buffer
 * @param {string} key
 * @param {(buffer: Buffer) => Record<string, unknown>} itemDecoder
 * @returns {Record<string, unknown>}
 */
function decodeEnvelope(buffer, key, itemDecoder) {
  const reader = new Reader(buffer)
  /** @type {unknown[]} */
  const items = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      items.push(itemDecoder(reader.readBytes()))
      continue
    }
    reader.skip(tag.wireType)
  }

  return { [key]: items }
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeResourceLogs(buffer) {
  return decodeResourceContainer(buffer, 'scopeLogs', decodeScopeLogs)
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeResourceSpans(buffer) {
  return decodeResourceContainer(buffer, 'scopeSpans', decodeScopeSpans)
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeResourceMetrics(buffer) {
  return decodeResourceContainer(buffer, 'scopeMetrics', decodeScopeMetrics)
}

/**
 * @param {Buffer} buffer
 * @param {string} collectionKey
 * @param {(buffer: Buffer) => Record<string, unknown>} itemDecoder
 * @returns {Record<string, unknown>}
 */
function decodeResourceContainer(buffer, collectionKey, itemDecoder) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const items = []
  /** @type {unknown[]} */
  const attributes = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.resource = decodeResource(reader.readBytes(), attributes)
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      items.push(itemDecoder(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.schemaUrl = reader.readString()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (items.length > 0) out[collectionKey] = items
  return out
}

/**
 * @param {Buffer} buffer
 * @param {unknown[]} attributes
 * @returns {Record<string, unknown>}
 */
function decodeResource(buffer, attributes) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.droppedAttributesCount = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeScopeLogs(buffer) {
  return decodeScopeContainer(buffer, 'logRecords', decodeLogRecord)
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeScopeSpans(buffer) {
  return decodeScopeContainer(buffer, 'spans', decodeSpan)
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeScopeMetrics(buffer) {
  return decodeScopeContainer(buffer, 'metrics', decodeMetric)
}

/**
 * @param {Buffer} buffer
 * @param {string} collectionKey
 * @param {(buffer: Buffer) => Record<string, unknown>} itemDecoder
 * @returns {Record<string, unknown>}
 */
function decodeScopeContainer(buffer, collectionKey, itemDecoder) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const items = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.scope = decodeInstrumentationScope(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      items.push(itemDecoder(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.schemaUrl = reader.readString()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (items.length > 0) out[collectionKey] = items
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeInstrumentationScope(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.name = reader.readString()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.version = reader.readString()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_VARINT) {
      out.droppedAttributesCount = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeLogRecord(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_FIXED64) {
      out.timeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.severityNumber = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.severityText = reader.readString()
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.body = decodeAnyValue(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_VARINT) {
      out.droppedAttributesCount = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 8 && tag.wireType === WIRE_FIXED32) {
      out.flags = reader.readFixed32()
      continue
    }
    if (tag.fieldNumber === 9 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.traceId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 10 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.spanId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 11 && tag.wireType === WIRE_FIXED64) {
      out.observedTimeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 12 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.eventName = reader.readString()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSpan(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []
  /** @type {unknown[]} */
  const events = []
  /** @type {unknown[]} */
  const links = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.traceId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.spanId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.traceState = reader.readString()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.parentSpanId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.name = reader.readString()
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_VARINT) {
      out.kind = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_FIXED64) {
      out.startTimeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 8 && tag.wireType === WIRE_FIXED64) {
      out.endTimeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 9 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 10 && tag.wireType === WIRE_VARINT) {
      out.droppedAttributesCount = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 11 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      events.push(decodeSpanEvent(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 12 && tag.wireType === WIRE_VARINT) {
      out.droppedEventsCount = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 13 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      links.push(decodeSpanLink(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 14 && tag.wireType === WIRE_VARINT) {
      out.droppedLinksCount = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 15 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.status = decodeSpanStatus(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 16 && tag.wireType === WIRE_FIXED32) {
      out.flags = reader.readFixed32()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  if (events.length > 0) out.events = events
  if (links.length > 0) out.links = links
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeMetric(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const metadata = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.name = reader.readString()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.description = reader.readString()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.unit = reader.readString()
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.gauge = decodeGauge(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.sum = decodeSum(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 9 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.histogram = decodeHistogram(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 10 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.exponentialHistogram = decodeExponentialHistogram(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 11 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.summary = decodeSummary(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 12 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      metadata.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    reader.skip(tag.wireType)
  }

  if (metadata.length > 0) out.metadata = metadata
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeGauge(buffer) {
  return decodeMetricPointsEnvelope(buffer, decodeNumberDataPoint)
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSum(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const dataPoints = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      dataPoints.push(decodeNumberDataPoint(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.aggregationTemporality = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_VARINT) {
      out.isMonotonic = reader.readVarintNumber() !== 0
      continue
    }
    reader.skip(tag.wireType)
  }

  if (dataPoints.length > 0) out.dataPoints = dataPoints
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeHistogram(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const dataPoints = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      dataPoints.push(decodeHistogramDataPoint(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.aggregationTemporality = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (dataPoints.length > 0) out.dataPoints = dataPoints
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeExponentialHistogram(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const dataPoints = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      dataPoints.push(decodeExponentialHistogramDataPoint(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.aggregationTemporality = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (dataPoints.length > 0) out.dataPoints = dataPoints
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSummary(buffer) {
  return decodeMetricPointsEnvelope(buffer, decodeSummaryDataPoint)
}

/**
 * @param {Buffer} buffer
 * @param {(buffer: Buffer) => Record<string, unknown>} pointDecoder
 * @returns {Record<string, unknown>}
 */
function decodeMetricPointsEnvelope(buffer, pointDecoder) {
  const reader = new Reader(buffer)
  /** @type {unknown[]} */
  const dataPoints = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      dataPoints.push(pointDecoder(reader.readBytes()))
      continue
    }
    reader.skip(tag.wireType)
  }

  return dataPoints.length > 0 ? { dataPoints } : {}
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeNumberDataPoint(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []
  /** @type {unknown[]} */
  const exemplars = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_FIXED64) {
      out.startTimeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_FIXED64) {
      out.timeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_FIXED64) {
      out.asDouble = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      exemplars.push(decodeExemplar(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_FIXED64) {
      out.asInt = BigInt.asIntN(64, reader.readFixed64BigInt()).toString()
      continue
    }
    if (tag.fieldNumber === 8 && tag.wireType === WIRE_VARINT) {
      out.flags = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  if (exemplars.length > 0) out.exemplars = exemplars
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeHistogramDataPoint(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []
  /** @type {unknown[]} */
  const exemplars = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 9 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_FIXED64) {
      out.startTimeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_FIXED64) {
      out.timeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_FIXED64) {
      out.count = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_FIXED64) {
      out.sum = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.bucketCounts = decodePackedFixed64Strings(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.explicitBounds = decodePackedDoubles(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 8 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      exemplars.push(decodeExemplar(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 10 && tag.wireType === WIRE_VARINT) {
      out.flags = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 11 && tag.wireType === WIRE_FIXED64) {
      out.min = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 12 && tag.wireType === WIRE_FIXED64) {
      out.max = reader.readDouble()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  if (exemplars.length > 0) out.exemplars = exemplars
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeExponentialHistogramDataPoint(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []
  /** @type {unknown[]} */
  const exemplars = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_FIXED64) {
      out.startTimeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_FIXED64) {
      out.timeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_FIXED64) {
      out.count = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_FIXED64) {
      out.sum = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_VARINT) {
      out.scale = reader.readZigZag32()
      continue
    }
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_FIXED64) {
      out.zeroCount = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 8 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.positive = decodeExponentialHistogramBuckets(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 9 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.negative = decodeExponentialHistogramBuckets(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 10 && tag.wireType === WIRE_VARINT) {
      out.flags = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 11 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      exemplars.push(decodeExemplar(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 12 && tag.wireType === WIRE_FIXED64) {
      out.min = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 13 && tag.wireType === WIRE_FIXED64) {
      out.max = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 14 && tag.wireType === WIRE_FIXED64) {
      out.zeroThreshold = reader.readDouble()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  if (exemplars.length > 0) out.exemplars = exemplars
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSummaryDataPoint(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []
  /** @type {unknown[]} */
  const quantileValues = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_FIXED64) {
      out.startTimeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_FIXED64) {
      out.timeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_FIXED64) {
      out.count = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_FIXED64) {
      out.sum = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      quantileValues.push(decodeSummaryValueAtQuantile(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 8 && tag.wireType === WIRE_VARINT) {
      out.flags = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  if (quantileValues.length > 0) out.quantileValues = quantileValues
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSpanEvent(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_FIXED64) {
      out.timeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.name = reader.readString()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_VARINT) {
      out.droppedAttributesCount = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSpanLink(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const attributes = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.traceId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.spanId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.traceState = reader.readString()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      attributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_VARINT) {
      out.droppedAttributesCount = reader.readVarintNumber()
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_FIXED32) {
      out.flags = reader.readFixed32()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (attributes.length > 0) out.attributes = attributes
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSpanStatus(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.message = reader.readString()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_VARINT) {
      out.code = reader.readVarintNumber()
      continue
    }
    reader.skip(tag.wireType)
  }

  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeExemplar(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {unknown[]} */
  const filteredAttributes = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      filteredAttributes.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_FIXED64) {
      out.timeUnixNano = reader.readFixed64String()
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_FIXED64) {
      out.asDouble = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.spanId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.traceId = reader.readBytes().toString('hex')
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_FIXED64) {
      out.asInt = BigInt.asIntN(64, reader.readFixed64BigInt()).toString()
      continue
    }
    reader.skip(tag.wireType)
  }

  if (filteredAttributes.length > 0) out.filteredAttributes = filteredAttributes
  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeExponentialHistogramBuckets(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.offset = reader.readZigZag32()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.bucketCounts = decodePackedVarintStrings(reader.readBytes())
      continue
    }
    reader.skip(tag.wireType)
  }

  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeSummaryValueAtQuantile(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_FIXED64) {
      out.quantile = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_FIXED64) {
      out.value = reader.readDouble()
      continue
    }
    reader.skip(tag.wireType)
  }

  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeKeyValue(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.key = reader.readString()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.value = decodeAnyValue(reader.readBytes())
      continue
    }
    reader.skip(tag.wireType)
  }

  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeAnyValue(buffer) {
  const reader = new Reader(buffer)
  /** @type {Record<string, unknown>} */
  const out = {}

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.stringValue = reader.readString()
      continue
    }
    if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.boolValue = reader.readVarintNumber() !== 0
      continue
    }
    if (tag.fieldNumber === 3 && tag.wireType === WIRE_VARINT) {
      out.intValue = BigInt.asIntN(64, reader.readVarintBigInt()).toString()
      continue
    }
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_FIXED64) {
      out.doubleValue = reader.readDouble()
      continue
    }
    if (tag.fieldNumber === 5 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.arrayValue = decodeArrayValue(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 6 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.kvlistValue = decodeKeyValueList(reader.readBytes())
      continue
    }
    if (tag.fieldNumber === 7 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      out.bytesValue = reader.readBytes().toString('base64')
      continue
    }
    reader.skip(tag.wireType)
  }

  return out
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeArrayValue(buffer) {
  const reader = new Reader(buffer)
  /** @type {unknown[]} */
  const values = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      values.push(decodeAnyValue(reader.readBytes()))
      continue
    }
    reader.skip(tag.wireType)
  }

  return { values }
}

/**
 * @param {Buffer} buffer
 * @returns {Record<string, unknown>}
 */
function decodeKeyValueList(buffer) {
  const reader = new Reader(buffer)
  /** @type {unknown[]} */
  const values = []

  while (!reader.eof()) {
    const tag = reader.readTag()
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LENGTH_DELIMITED) {
      values.push(decodeKeyValue(reader.readBytes()))
      continue
    }
    reader.skip(tag.wireType)
  }

  return { values }
}

/**
 * @param {Buffer} buffer
 * @returns {string[]}
 */
function decodePackedVarintStrings(buffer) {
  const reader = new Reader(buffer)
  /** @type {string[]} */
  const values = []

  while (!reader.eof()) {
    values.push(reader.readVarintBigInt().toString())
  }

  return values
}

/**
 * @param {Buffer} buffer
 * @returns {string[]}
 */
function decodePackedFixed64Strings(buffer) {
  const reader = new Reader(buffer)
  /** @type {string[]} */
  const values = []

  while (!reader.eof()) {
    values.push(reader.readFixed64String())
  }

  return values
}

/**
 * @param {Buffer} buffer
 * @returns {number[]}
 */
function decodePackedDoubles(buffer) {
  const reader = new Reader(buffer)
  /** @type {number[]} */
  const values = []

  while (!reader.eof()) {
    values.push(reader.readDouble())
  }

  return values
}

class Reader {
  /**
   * @param {Buffer} buffer
   */
  constructor(buffer) {
    this.buffer = buffer
    this.offset = 0
  }

  /**
   * @returns {boolean}
   */
  eof() {
    return this.offset >= this.buffer.length
  }

  /**
   * @returns {{ fieldNumber: number, wireType: number }}
   */
  readTag() {
    const tag = this.readVarintNumber()
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 }
  }

  /**
   * @returns {bigint}
   */
  readVarintBigInt() {
    let shift = 0n
    let result = 0n

    while (true) {
      if (this.eof()) throw new Error('Unexpected end of protobuf input')
      const byte = this.buffer[this.offset++]
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
      if (shift > 70n) throw new Error('Invalid protobuf varint')
    }
  }

  /**
   * @returns {number}
   */
  readVarintNumber() {
    const value = this.readVarintBigInt()
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Protobuf integer exceeds safe JS range')
    }
    return Number(value)
  }

  /**
   * @returns {number}
   */
  readZigZag32() {
    const value = this.readVarintNumber()
    return value >>> 1 ^ -(value & 1)
  }

  /**
   * @returns {Buffer}
   */
  readBytes() {
    const length = this.readVarintNumber()
    const end = this.offset + length
    if (end > this.buffer.length) throw new Error('Unexpected end of protobuf input')
    const bytes = this.buffer.subarray(this.offset, end)
    this.offset = end
    return bytes
  }

  /**
   * @returns {string}
   */
  readString() {
    return this.readBytes().toString('utf8')
  }

  /**
   * @returns {bigint}
   */
  readFixed64BigInt() {
    const end = this.offset + 8
    if (end > this.buffer.length) throw new Error('Unexpected end of protobuf input')
    let value = 0n
    for (let i = 0; i < 8; i += 1) {
      value |= BigInt(this.buffer[this.offset + i]) << BigInt(i * 8)
    }
    this.offset = end
    return value
  }

  /**
   * @returns {string}
   */
  readFixed64String() {
    return this.readFixed64BigInt().toString()
  }

  /**
   * @returns {number}
   */
  readFixed32() {
    const end = this.offset + 4
    if (end > this.buffer.length) throw new Error('Unexpected end of protobuf input')
    const value = this.buffer.readUInt32LE(this.offset)
    this.offset = end
    return value
  }

  /**
   * @returns {number}
   */
  readDouble() {
    const end = this.offset + 8
    if (end > this.buffer.length) throw new Error('Unexpected end of protobuf input')
    const value = this.buffer.readDoubleLE(this.offset)
    this.offset = end
    return value
  }

  /**
   * @param {number} wireType
   * @returns {void}
   */
  skip(wireType) {
    if (wireType === WIRE_VARINT) {
      this.readVarintBigInt()
      return
    }
    if (wireType === WIRE_FIXED64) {
      this.readFixed64BigInt()
      return
    }
    if (wireType === WIRE_LENGTH_DELIMITED) {
      this.readBytes()
      return
    }
    if (wireType === WIRE_FIXED32) {
      this.readFixed32()
      return
    }
    throw new Error(`Unsupported protobuf wire type: ${wireType}`)
  }
}
