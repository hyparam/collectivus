/**
 * Hand-rolled protobuf encoders for crafting test payloads. Mirrors the
 * subset of the wire format covered by src/protobuf.js readers.
 */

/**
 * @param {number} n
 * @returns {number[]}
 */
export function varint(n) {
  /** @type {number[]} */
  const out = []
  while (n > 0x7f) {
    out.push(n & 0x7f | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

/**
 * @param {number} field
 * @param {number} wireType
 * @returns {number[]}
 */
export function tag(field, wireType) {
  return varint(field << 3 | wireType)
}

/**
 * @param {number} field
 * @param {number[]} bytes
 * @returns {number[]}
 */
export function lenDelim(field, bytes) {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes]
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
export function varintField(field, value) {
  return [...tag(field, 0), ...varint(value)]
}

/**
 * @param {number} field
 * @param {bigint | number} value
 * @returns {number[]}
 */
export function fixed64Field(field, value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return [...tag(field, 1), ...buf]
}

/**
 * @param {number} field
 * @param {bigint | number} value
 * @returns {number[]}
 */
export function sfixed64Field(field, value) {
  const buf = Buffer.alloc(8)
  buf.writeBigInt64LE(BigInt(value))
  return [...tag(field, 1), ...buf]
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
export function fixed32Field(field, value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value)
  return [...tag(field, 5), ...buf]
}

/**
 * @param {number} field
 * @param {number} value
 * @returns {number[]}
 */
export function doubleField(field, value) {
  const buf = Buffer.alloc(8)
  buf.writeDoubleLE(value)
  return [...tag(field, 1), ...buf]
}

/**
 * @param {number} field
 * @param {string} s
 * @returns {number[]}
 */
export function stringField(field, s) {
  return lenDelim(field, [...Buffer.from(s, 'utf8')])
}

/**
 * @param {number} field
 * @param {number[]} bytes
 * @returns {number[]}
 */
export function bytesField(field, bytes) {
  return lenDelim(field, bytes)
}

/**
 * @param {number[]} arr
 * @returns {Uint8Array}
 */
export function u8(arr) {
  return new Uint8Array(arr)
}
