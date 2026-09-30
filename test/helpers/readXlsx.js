// test/helpers/readXlsx.js
//
// Just enough of an .xlsx reader to check what services/xlsx.js wrote: the
// zip taken apart by its central directory (every entry's CRC checked), and
// a worksheet's cells read back with their types and styles. Written
// independently of the writer, from the file format, so a mistake in one is
// not mirrored by the other.

'use strict';

const zlib = require('zlib');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** name -> Buffer, for every entry in the zip. Throws on anything malformed. */
function unzip(buffer) {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('no end-of-central-directory record');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);

  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory entry ${i}`);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    if (buffer.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const packed = buffer.subarray(dataAt, dataAt + packedSize);
    const data = method === 8 ? zlib.inflateRawSync(packed) : Buffer.from(packed);
    if (data.length !== size) throw new Error(`${name}: size ${data.length}, header says ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);

    files.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The cells of one worksheet as rows of { ref, type, style, value }:
 * type 'n' (number) or 's' (inline string); value a number or a string.
 */
function readSheet(files, index = 1) {
  const xml = files.get(`xl/worksheets/sheet${index}.xml`);
  if (!xml) throw new Error(`no sheet ${index}`);
  const rows = [];
  for (const [, rowXml] of xml.toString('utf8').matchAll(/<row [^>]*>(.*?)<\/row>/g)) {
    const cells = [];
    for (const [, attrs, inner] of rowXml.matchAll(/<c ([^>]*)>(.*?)<\/c>/g)) {
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)[1];
      const style = Number((/s="(\d+)"/.exec(attrs) || [])[1] || 0);
      if (/t="inlineStr"/.test(attrs)) {
        const text = /<t(?: [^>]*)?>(.*?)<\/t>/s.exec(inner)[1];
        cells.push({ ref, type: 's', style, value: unescapeXml(text) });
      } else {
        cells.push({ ref, type: 'n', style, value: Number(/<v>(.*?)<\/v>/.exec(inner)[1]) });
      }
    }
    rows.push(cells);
  }
  return rows;
}

/** Sheet names in order, from xl/workbook.xml. */
function sheetNames(files) {
  return [...files.get('xl/workbook.xml').toString('utf8').matchAll(/<sheet name="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
}

/** The cell values of a sheet keyed by header: [{ Header: value, ... }]. */
function sheetObjects(files, index = 1) {
  const [header, ...rows] = readSheet(files, index);
  const labels = new Map(header.map((cell) => [cell.ref.replace(/\d+$/, ''), cell.value]));
  return rows.map((cells) => Object.fromEntries(cells.map((cell) => [labels.get(cell.ref.replace(/\d+$/, '')), cell.value])));
}

module.exports = { unzip, readSheet, sheetNames, sheetObjects };
