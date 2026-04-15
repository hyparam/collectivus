import { describe, expect, it } from 'vitest'
import {
  decodeAnyValue,
  decodeKeyValue,
  decodeResource,
} from '../src/otlp/common.js'
import { decodeExportLogsServiceRequest } from '../src/otlp/logs.js'
import { decodeExportMetricsServiceRequest } from '../src/otlp/metrics.js'
import { decodeExportTraceServiceRequest } from '../src/otlp/traces.js'
import {
  bytesField,
  doubleField,
  fixed32Field,
  fixed64Field,
  lenDelim,
  sfixed64Field,
  stringField,
  u8,
  varintField,
} from './helpers.js'

describe('decodeAnyValue', () => {
  it('decodes stringValue', () => {
    expect(decodeAnyValue(u8(stringField(1, 'hello')))).toEqual({ stringValue: 'hello' })
  })

  it('decodes boolValue, intValue, doubleValue', () => {
    expect(decodeAnyValue(u8(varintField(2, 1)))).toEqual({ boolValue: true })
    expect(decodeAnyValue(u8(varintField(3, 42)))).toEqual({ intValue: '42' })
    expect(decodeAnyValue(u8(doubleField(4, 1.5)))).toEqual({ doubleValue: 1.5 })
  })

  it('decodes bytesValue as base64', () => {
    expect(decodeAnyValue(u8(bytesField(7, [0xde, 0xad])))).toEqual({ bytesValue: '3q0=' })
  })

  it('decodes arrayValue', () => {
    const inner = stringField(1, 'a')
    expect(decodeAnyValue(u8(lenDelim(5, [...lenDelim(1, inner)])))).toEqual({
      arrayValue: { values: [{ stringValue: 'a' }] },
    })
  })
})

describe('decodeKeyValue', () => {
  it('decodes a simple string attribute', () => {
    const bytes = [...stringField(1, 'host.name'), ...lenDelim(2, stringField(1, 'alice'))]
    expect(decodeKeyValue(u8(bytes))).toEqual({
      key: 'host.name',
      value: { stringValue: 'alice' },
    })
  })
})

describe('decodeResource', () => {
  it('decodes attributes and droppedAttributesCount', () => {
    const attr = lenDelim(1, [
      ...stringField(1, 'service.name'),
      ...lenDelim(2, stringField(1, 'svc')),
    ])
    const bytes = [...attr, ...varintField(2, 3)]
    expect(decodeResource(u8(bytes))).toEqual({
      attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }],
      droppedAttributesCount: 3,
    })
  })
})

describe('decodeExportTraceServiceRequest', () => {
  it('decodes a single span', () => {
    const traceId = Array.from({ length: 16 }, (_, i) => i + 1)
    const spanId = Array.from({ length: 8 }, (_, i) => i + 1)
    const span = [
      ...bytesField(1, traceId),
      ...bytesField(2, spanId),
      ...stringField(5, 'GET /'),
      ...varintField(6, 2),
      ...fixed64Field(7, 1000n),
      ...fixed64Field(8, 2000n),
      ...lenDelim(15, varintField(3, 1)),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, span)))

    expect(decodeExportTraceServiceRequest(u8(req))).toEqual({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: '0102030405060708090a0b0c0d0e0f10',
            spanId: '0102030405060708',
            name: 'GET /',
            kind: 2,
            startTimeUnixNano: '1000',
            endTimeUnixNano: '2000',
            status: { code: 1 },
          }],
        }],
      }],
    })
  })
})

describe('decodeExportLogsServiceRequest', () => {
  it('decodes a single log record', () => {
    const traceId = new Array(16).fill(0xab)
    const spanId = new Array(8).fill(0xcd)
    const logRecord = [
      ...fixed64Field(1, 1234n),
      ...varintField(2, 9),
      ...stringField(3, 'INFO'),
      ...lenDelim(5, stringField(1, 'hello world')),
      ...fixed32Field(8, 7),
      ...bytesField(9, traceId),
      ...bytesField(10, spanId),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, logRecord)))

    expect(decodeExportLogsServiceRequest(u8(req))).toEqual({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: '1234',
            severityNumber: 9,
            severityText: 'INFO',
            body: { stringValue: 'hello world' },
            flags: 7,
            traceId: 'abababababababababababababababab',
            spanId: 'cdcdcdcdcdcdcdcd',
          }],
        }],
      }],
    })
  })
})

describe('decodeExportMetricsServiceRequest', () => {
  it('decodes a Gauge with a double datapoint', () => {
    const dp = [
      ...fixed64Field(2, 100n),
      ...fixed64Field(3, 200n),
      ...doubleField(4, 3.14),
    ]
    const metric = [
      ...stringField(1, 'cpu.usage'),
      ...stringField(3, '1'),
      ...lenDelim(5, lenDelim(1, dp)),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    expect(decodeExportMetricsServiceRequest(u8(req))).toEqual({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: 'cpu.usage',
            unit: '1',
            gauge: {
              dataPoints: [{
                startTimeUnixNano: '100',
                timeUnixNano: '200',
                asDouble: 3.14,
              }],
            },
          }],
        }],
      }],
    })
  })

  it('decodes a Sum with an int datapoint and isMonotonic flag', () => {
    const dp = [
      ...fixed64Field(3, 500n),
      ...sfixed64Field(6, 42n),
    ]
    const sum = [
      ...lenDelim(1, dp),
      ...varintField(2, 2),
      ...varintField(3, 1),
    ]
    const metric = [
      ...stringField(1, 'requests'),
      ...lenDelim(7, sum),
    ]
    const req = lenDelim(1, lenDelim(2, lenDelim(2, metric)))

    expect(decodeExportMetricsServiceRequest(u8(req))).toEqual({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: 'requests',
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [{
                timeUnixNano: '500',
                asInt: '42',
              }],
            },
          }],
        }],
      }],
    })
  })
})
